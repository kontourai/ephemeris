import type { Clock } from "./clock.js";
import { SystemClock, ManualClock } from "./clock.js";
import type { Store } from "./store.js";
import { InMemoryStore } from "./store.js";
import type { Trigger } from "./trigger.js";
import { FlowEvaluateTrigger } from "./trigger.js";
import type {
  ArmedDeadline,
  ClaimReadModel,
  TrustBundleReadModel,
} from "./types.js";
import { claimKey, deadlineKey, runIdFromSource } from "./types.js";
import { validateClaimFreshness } from "./hachure-schema.js";

export interface EphemerisSchedulerOptions {
  /** Time source. Default `SystemClock`. Tests pass `ManualClock`. */
  clock?: Clock;
  /** Durable wake-up store. Default `InMemoryStore`. */
  store?: Store;
  /** What to do when a deadline fires. Default `FlowEvaluateTrigger`. */
  trigger?: Trigger;
  /** Optional sink for non-fatal trigger errors (firing is a nudge). */
  onError?: (err: unknown, deadline: ArmedDeadline) => void;
  /**
   * Backpressure: minimum interval (ms) between fires for the same
   * `(bundleSource, claimId)` claim. A fire inside this window after the last
   * fire is coalesced (skipped). Default `0` — no rate limit. See README.
   */
  minFireIntervalMs?: number;
  /**
   * Called when a fire is suppressed by coalescing (backpressure). Optional —
   * useful for metrics/visibility. Default: no-op.
   */
  onCoalesced?: (deadline: ArmedDeadline, reason: CoalesceReason) => void;
}

/** Why a fire was coalesced away (for observability). */
export type CoalesceReason =
  | "min-interval" // fired too soon after the same claim's last fire
  | "superseded"; // a newer deadline for the same claim is already pending

/**
 * `setTimeout`'s maximum delay (2^31-1 ms, ~24.8 days). Node clamps any larger
 * delay down to 1ms (with a `TimeoutOverflowWarning`), so Ephemeris caps the
 * delay and chains a fresh timer for the remainder — see `#scheduleTimer`.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * EphemerisScheduler — the core. It turns time into triggers and nothing else.
 *
 * Invariants enforced here:
 *  - **Triggers, never authors.** It only calls `Trigger.fire`; it writes to its
 *    own `Store` (its private wake-up bookkeeping), never to any bundle/ledger.
 *  - **Derived expiry, not synthesized events.** It reads `expiresAt` /
 *    `ttlSeconds` off claims and arms instants; it invents no stale/revoked events.
 *  - **Idempotent.** Deadlines are deduped by `(bundleSource, claimId, fireAt)`
 *    and fire at most once; fired keys are persisted so reload/duplicate-arm never
 *    double-fires.
 *  - **Restart-safe.** On `start()` it re-arms pending deadlines from the store,
 *    firing any already past-due (still at most once).
 *  - **Backpressure.** Per-`(bundleSource, claimId)` coalescing collapses redundant
 *    pending deadlines and rate-limits fires to `minFireIntervalMs`, so a flappy
 *    claim cannot storm triggers. Over-firing stays harmless; under-firing within
 *    the window is safe because Flow re-derives at the real `now` regardless.
 *
 * With a `ManualClock`, firing is driven entirely by `clock.advance()` /
 * `tick()` — there are no real timers and no wall-clock waits.
 */
export class EphemerisScheduler {
  readonly #clock: Clock;
  readonly #store: Store;
  readonly #trigger: Trigger;
  readonly #onError: (err: unknown, d: ArmedDeadline) => void;
  readonly #minFireIntervalMs: number;
  readonly #onCoalesced: (d: ArmedDeadline, reason: CoalesceReason) => void;

  /** Live timer handles for SystemClock mode, keyed by deadline key. */
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last fire instant (epoch ms) per claim key, for rate-limit coalescing. */
  readonly #lastFiredAt = new Map<string, number>();
  /** Unsubscribe handle when bound to a ManualClock. */
  #unsubscribeClock: (() => void) | undefined;
  /** Guards re-entrant ticks. */
  #ticking = false;
  /** Set when a tick is requested while one is already running. */
  #tickAgain = false;

  constructor(options: EphemerisSchedulerOptions = {}) {
    this.#clock = options.clock ?? new SystemClock();
    this.#store = options.store ?? new InMemoryStore();
    this.#trigger = options.trigger ?? new FlowEvaluateTrigger();
    this.#minFireIntervalMs = Math.max(0, options.minFireIntervalMs ?? 0);
    this.#onCoalesced = options.onCoalesced ?? (() => {});
    this.#onError =
      options.onError ??
      ((err, d) => {
        // Default: log. Firing is a nudge; a failed nudge is not fatal.
        console.error(`[ephemeris] trigger failed for ${deadlineKey(d)}:`, err);
      });

    if (this.#clock instanceof ManualClock) {
      this.#unsubscribeClock = this.#clock.onAdvance(() => {
        // Drive a SYNCHRONOUS sweep so that by the time `advance()`/`set()`
        // returns, every due deadline has fired. Async trigger promises (if
        // any) settle on their own; their errors are routed to `onError`.
        this.#sweep();
      });
    }
  }

  /**
   * Start the scheduler: reload persisted pending deadlines and (re-)arm them.
   * Restart-safe — call this once on daemon boot. Returns once the initial
   * past-due sweep has been dispatched.
   */
  async start(): Promise<void> {
    for (const d of this.#store.pending()) {
      this.#armTimer(d);
    }
    await this.tick();
  }

  /**
   * Arm all deadlines referenced by a bundle's claims. Reads each claim's
   * freshness fields, validates them against the Hachure claim schema, derives
   * the fire instant, dedups, coalesces, persists, and schedules. Returns the
   * deadlines newly armed by this call (already-armed / already-fired /
   * superseded ones are skipped — making `arm` idempotent and flap-resistant).
   */
  arm(bundle: TrustBundleReadModel): ArmedDeadline[] {
    const runId =
      bundle.runId ?? runIdFromSource(bundle.source) ?? bundle.source;
    const armed: ArmedDeadline[] = [];
    for (const claim of bundle.claims) {
      // Validate the freshness slice against the published Hachure claim schema.
      // An unparseable/invalid claim arms nothing (it cannot produce a deadline);
      // Ephemeris never throws on a bad input here — it just declines to arm.
      const issues = validateClaimFreshness(claim);
      if (issues.length > 0) continue;

      const fireAt = deriveFireAt(claim, this.#clock.now());
      if (fireAt === undefined) continue; // no freshness deadline on this claim
      const deadline: ArmedDeadline = {
        bundleSource: bundle.source,
        runId,
        claimId: claim.id,
        fireAt,
      };
      const key = deadlineKey(deadline);
      if (this.#store.hasFired(key)) continue; // never re-arm a fired deadline

      // If this exact deadline is already pending, it is a pure duplicate arm —
      // skip it (idempotent), arming nothing new.
      if (this.#store.has(key)) continue;

      // Coalescing: collapse redundant pending deadlines for the same claim.
      // A re-arm that produces a DIFFERENT deadline (later or earlier fireAt)
      // for a claim that already has a pending one supersedes the old pending
      // deadline, rather than stacking a second wake-up for the same claim.
      const ck = claimKey(deadline);
      this.#supersedePendingForClaim(ck, key);

      this.#store.addPending(deadline);
      this.#armTimer(deadline);
      armed.push(deadline);
    }
    // Immediately (and synchronously) sweep any already-past-due arms.
    this.#sweep();
    return armed;
  }

  /** Cancel all pending deadlines for a bundle. Does not affect fired history. */
  cancel(bundleSource: string): void {
    const removed = this.#store.removePendingForBundle(bundleSource);
    for (const key of removed) {
      const t = this.#timers.get(key);
      if (t) {
        clearTimeout(t);
        this.#timers.delete(key);
      }
    }
  }

  /**
   * Evaluate the clock and fire every pending deadline whose `fireAt <= now`,
   * each at most once. Safe to call repeatedly. This is the deterministic entry
   * point tests drive (directly or via `ManualClock.advance`).
   *
   * Backpressure: a due deadline whose claim fired within `minFireIntervalMs` is
   * coalesced (marked fired without dispatching) so a flappy claim cannot storm
   * the trigger.
   */
  async tick(): Promise<void> {
    // The SWEEP — selecting due deadlines, marking them fired, and CALLING each
    // trigger — runs fully synchronously (see `#sweep`). `#ticking` guards only
    // that synchronous critical section, so it is never held across an `await`.
    // That is what makes ManualClock-driven firing deterministic: by the time
    // `clock.advance()`/`set()` returns, every due deadline has been marked
    // fired and every trigger's synchronous body has run. We then await the
    // dispatched trigger promises (for async triggers) OUTSIDE the guard.
    const dispatched = this.#sweep();
    await Promise.all(dispatched);
  }

  /**
   * One synchronous pass: fire every pending deadline due at the current clock
   * instant. Returns the in-flight trigger promises (empty for sync triggers).
   * Re-entrancy is guarded by `#ticking`, but because this method does no
   * `await`, a re-entrant call (e.g. a trigger that synchronously re-arms) is
   * coalesced into a single follow-up sweep via `#tickAgain` rather than dropped.
   */
  #sweep(): Array<Promise<void>> {
    if (this.#ticking) {
      this.#tickAgain = true;
      return [];
    }
    this.#ticking = true;
    const all: Array<Promise<void>> = [];
    try {
      do {
        this.#tickAgain = false;
        all.push(...this.#sweepOnce());
      } while (this.#tickAgain);
    } finally {
      this.#ticking = false;
    }
    return all;
  }

  /** A single synchronous sweep of the pending set at the current instant. */
  #sweepOnce(): Array<Promise<void>> {
    const now = this.#clock.now();
    const due = this.#store
      .pending()
      .filter((d) => d.fireAt <= now)
      .sort((a, b) => a.fireAt - b.fireAt);

    // Dispatch each due deadline's trigger SYNCHRONOUSLY (call `fire`, collect
    // its promise). Bookkeeping (mark-fired, rate-limit) and the synchronous
    // body of each trigger all run inside this synchronous pass — so a
    // sync-bodied trigger records every fire before control returns to the
    // caller of `clock.advance()`/`tick()`.
    const dispatched: Array<Promise<void>> = [];
    for (const d of due) {
      const key = deadlineKey(d);
      if (this.#store.hasFired(key)) continue; // idempotency guard

      // Mark fired BEFORE dispatch so a re-entrant tick can't double-fire.
      this.#store.markFired(key);
      const t = this.#timers.get(key);
      if (t) {
        clearTimeout(t);
        this.#timers.delete(key);
      }

      // Backpressure: rate-limit fires per claim. If this claim fired within
      // the min interval, coalesce this fire away (it is harmless to skip —
      // Flow re-derives at the real `now` on the next allowed fire anyway).
      const ck = claimKey(d);
      if (this.#minFireIntervalMs > 0) {
        const last = this.#lastFiredAt.get(ck);
        if (last !== undefined && now - last < this.#minFireIntervalMs) {
          this.#onCoalesced(d, "min-interval");
          continue;
        }
      }
      this.#lastFiredAt.set(ck, now);

      // Call fire() NOW (synchronously runs the trigger's body), and attach
      // error handling to the returned promise. A failed nudge is non-fatal —
      // firing is only a nudge.
      const captured = d;
      try {
        const p = this.#trigger.fire(captured);
        dispatched.push(p.catch((err: unknown) => this.#onError(err, captured)));
      } catch (err) {
        // A synchronously-throwing trigger is handled inline.
        this.#onError(err, captured);
      }
    }
    return dispatched;
  }

  /** Number of pending (armed, not yet fired) deadlines. */
  pendingCount(): number {
    return this.#store.pending().length;
  }

  /** Stop all live timers and detach from the clock. */
  stop(): void {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    this.#unsubscribeClock?.();
    this.#unsubscribeClock = undefined;
  }

  /**
   * Drop any pending deadline for the same `(bundleSource, claimId)` that is NOT
   * the deadline we're about to arm. This is the "collapse redundant pending
   * deadlines" half of backpressure: one claim never holds more than one pending
   * wake-up — a re-armed claim's newest deadline replaces its older pending one.
   */
  #supersedePendingForClaim(claimKeyValue: string, keepKey: string): void {
    for (const d of this.#store.pending()) {
      if (claimKey(d) !== claimKeyValue) continue;
      const k = deadlineKey(d);
      if (k === keepKey) continue;
      this.#store.removePending(k);
      const t = this.#timers.get(k);
      if (t) {
        clearTimeout(t);
        this.#timers.delete(k);
      }
    }
  }

  /**
   * Schedule a real `setTimeout` for SystemClock mode. For ManualClock mode this
   * is a no-op (firing is driven by `tick()` / `advance()`), so tests never wait
   * on the wall clock.
   */
  #armTimer(deadline: ArmedDeadline): void {
    if (this.#clock instanceof ManualClock) return;
    const key = deadlineKey(deadline);
    if (this.#timers.has(key)) return;
    this.#scheduleTimer(key, deadline);
  }

  /**
   * Arm (or re-arm) a real timer for `deadline`. A delay above
   * `MAX_TIMER_DELAY_MS` would be clamped to 1ms by Node and fire almost
   * immediately; that early tick finds nothing due and — because the key stays in
   * `#timers` — the deadline would never re-arm and so never fire on its own
   * timer. Cap the delay and, when a capped timer fires before the real instant,
   * chain a fresh timer for the remainder.
   */
  #scheduleTimer(key: string, deadline: ArmedDeadline): void {
    const remaining = deadline.fireAt - this.#clock.now();
    const delay = Math.min(Math.max(0, remaining), MAX_TIMER_DELAY_MS);
    const t = setTimeout(() => {
      this.#timers.delete(key);
      if (this.#clock.now() < deadline.fireAt) {
        this.#scheduleTimer(key, deadline); // capped timer fired early — re-arm
      } else {
        void this.tick();
      }
    }, delay);
    // Don't keep the process alive solely for a pending timer in library use.
    if (typeof t.unref === "function") t.unref();
    this.#timers.set(key, t);
  }
}

/**
 * Derive the fire instant (epoch ms) for a claim. `expiresAt` is authoritative;
 * `ttlSeconds` is used only as a fallback, measured from `now`. Returns
 * `undefined` when the claim carries no freshness deadline at all.
 */
export function deriveFireAt(
  claim: ClaimReadModel,
  now: number,
): number | undefined {
  if (claim.expiresAt !== undefined) {
    const t = Date.parse(claim.expiresAt);
    if (Number.isNaN(t)) {
      throw new Error(
        `Ephemeris: claim ${claim.id} has unparseable expiresAt "${claim.expiresAt}"`,
      );
    }
    return t;
  }
  if (claim.ttlSeconds !== undefined) {
    return now + claim.ttlSeconds * 1000;
  }
  return undefined;
}
