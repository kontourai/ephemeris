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
import { deadlineKey } from "./types.js";

export interface EphemerisSchedulerOptions {
  /** Time source. Default `SystemClock`. Tests pass `ManualClock`. */
  clock?: Clock;
  /** Durable wake-up store. Default `InMemoryStore`. */
  store?: Store;
  /** What to do when a deadline fires. Default `FlowEvaluateTrigger`. */
  trigger?: Trigger;
  /** Optional sink for non-fatal trigger errors (firing is a nudge). */
  onError?: (err: unknown, deadline: ArmedDeadline) => void;
}

/**
 * EphemerisScheduler — the core. It turns time into triggers and nothing else.
 *
 * Invariants enforced here:
 *  - **Triggers, never authors.** It only calls `Trigger.fire`; it writes to its
 *    own `Store` (its private wake-up bookkeeping), never to any bundle/ledger.
 *  - **Derived expiry, not synthesized events.** It reads `expiresAt` /
 *    `ttlSeconds` off claims and arms instants; it invents no stale/revoked events.
 *  - **Idempotent.** Deadlines are deduped by `(bundleId, claimId, fireAt)` and
 *    fire at most once; fired keys are persisted so reload/duplicate-arm never
 *    double-fires.
 *  - **Restart-safe.** On `start()` it re-arms pending deadlines from the store,
 *    firing any already past-due (still at most once).
 *
 * With a `ManualClock`, firing is driven entirely by `clock.advance()` /
 * `tick()` — there are no real timers and no wall-clock waits.
 */
export class EphemerisScheduler {
  readonly #clock: Clock;
  readonly #store: Store;
  readonly #trigger: Trigger;
  readonly #onError: (err: unknown, d: ArmedDeadline) => void;

  /** Live timer handles for SystemClock mode, keyed by deadline key. */
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Unsubscribe handle when bound to a ManualClock. */
  #unsubscribeClock: (() => void) | undefined;
  /** Guards re-entrant ticks. */
  #ticking = false;

  constructor(options: EphemerisSchedulerOptions = {}) {
    this.#clock = options.clock ?? new SystemClock();
    this.#store = options.store ?? new InMemoryStore();
    this.#trigger = options.trigger ?? new FlowEvaluateTrigger();
    this.#onError =
      options.onError ??
      ((err, d) => {
        // Default: log. Firing is a nudge; a failed nudge is not fatal.
        console.error(`[ephemeris] trigger failed for ${deadlineKey(d)}:`, err);
      });

    if (this.#clock instanceof ManualClock) {
      this.#unsubscribeClock = this.#clock.onAdvance(() => {
        void this.tick();
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
   * freshness fields, derives the fire instant, dedups, persists, and schedules.
   * Returns the deadlines newly armed by this call (already-armed / already-fired
   * ones are skipped — making `arm` idempotent).
   */
  arm(bundle: TrustBundleReadModel): ArmedDeadline[] {
    const armed: ArmedDeadline[] = [];
    for (const claim of bundle.claims) {
      const fireAt = deriveFireAt(claim, this.#clock.now());
      if (fireAt === undefined) continue; // no freshness deadline on this claim
      const deadline: ArmedDeadline = {
        bundleId: bundle.id,
        runId: bundle.run.id,
        claimId: claim.id,
        fireAt,
      };
      const key = deadlineKey(deadline);
      if (this.#store.hasFired(key)) continue; // never re-arm a fired deadline
      const already = this.#timers.has(key);
      this.#store.addPending(deadline);
      this.#armTimer(deadline);
      if (!already) armed.push(deadline);
    }
    // With a ManualClock, immediately sweep past-due arms.
    void this.tick();
    return armed;
  }

  /** Cancel all pending deadlines for a bundle. Does not affect fired history. */
  cancel(bundleId: string): void {
    const removed = this.#store.removePendingForBundle(bundleId);
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
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#clock.now();
      const due = this.#store
        .pending()
        .filter((d) => d.fireAt <= now)
        .sort((a, b) => a.fireAt - b.fireAt);
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
        try {
          await this.#trigger.fire(d);
        } catch (err) {
          this.#onError(err, d);
        }
      }
    } finally {
      this.#ticking = false;
    }
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
   * Schedule a real `setTimeout` for SystemClock mode. For ManualClock mode this
   * is a no-op (firing is driven by `tick()` / `advance()`), so tests never wait
   * on the wall clock.
   */
  #armTimer(deadline: ArmedDeadline): void {
    if (this.#clock instanceof ManualClock) return;
    const key = deadlineKey(deadline);
    if (this.#timers.has(key)) return;
    const delay = Math.max(0, deadline.fireAt - this.#clock.now());
    const t = setTimeout(() => {
      void this.tick();
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
