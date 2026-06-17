# Ephemeris

**External freshness scheduler / event-bridge for the Kontour suite.**
Status: v0 skeleton · Layer: time actor.

> *Ephemeris* (n.) — in surveying/GNSS, a table of time-indexed positions that
> has an age, goes stale, and must be refreshed. The name carries the
> freshness/expiry meaning for free.

Ephemeris is a long-lived daemon whose entire job is to **turn time into a
trigger**. It:

1. **Ingests** Flow's emitted run-output TrustBundles and reads each referenced
   claim's `expiresAt` / `ttlSeconds` (Hachure freshness fields — **no new
   schema**, it only reads them).
2. **Arms** a durable timer per claim deadline (data-derived instants, not cron).
3. **Fires** an idempotent trigger at the deadline — by default invokes Flow's
   `evaluateRun` for the bundle's run.

That is its whole job. It owns the clock and durable wake-ups; it owns no trust
or process authority.

## Why it exists

`docs/design/route-back-cascade-and-trust-recursion.md` Decision #1 resolved that
**neither Surface nor Flow has a scheduler.** Flow's only clock is the `now`
captured at an `evaluateRun` that some *external* actor triggers. A claim that
expires at 2am is only *observed* at the next externally-invoked evaluation.
That leaves a deliberate hole: something has to notice "claim X expires at T" and
produce the trigger at T — **without** putting a timer back into the two layers
that must not have one. Ephemeris is that external time actor, productized.

## The layer model

| Layer | Owns |
|-------|------|
| **Hachure** | the *shape* — the TrustBundle / claim schema (incl. `expiresAt`, `ttlSeconds`). |
| **Surface** | the *meaning* — derives `fresh` / `stale` from `expiresAt`. |
| **Flow** | the *reaction* — re-derives at the real `now` on `evaluateRun`; emits artifacts. |
| **Ephemeris** | the *time* — arms a wake-up off a deadline and nudges Flow when it passes. |

Ephemeris is the same edge-adapter shape as Flow's `HostedConsoleSink`: both
consume Flow's neutral emitted bundle and translate it outward, while Flow stays
ignorant of both. The difference is direction — the console sink is purely
outbound (Flow → console); Ephemeris closes a feedback loop (bundle → timer →
trigger back into Flow's `evaluateRun`).

## Invariants (non-negotiable, enforced in code)

- **It triggers, it never authors.** Ephemeris writes **nothing** to any
  TrustBundle or ledger. Firing is only a *nudge*: Flow re-derives at the real
  `now` and Surface decides for real. Over-firing is therefore harmless.
  *Enforced:* the `Trigger` contract returns `void` and has no authoring
  surface; the scheduler mutates only its own private `Store`. The
  `trigger writes nothing` test arms and fires a deeply-frozen bundle and asserts
  it is byte-for-byte unchanged.
- **Expiry is derived; invalidation is an event.** Ephemeris reacts to
  `expiresAt` (a field); it does **not** synthesize `stale` / `revoked` events.
  *Enforced:* a claim with no freshness field arms no deadline and never fires.
- **Owns no trust or process authority — only timers.** No copy of any
  authoritative state lives here; the only durable state is its own wake-up
  bookkeeping.

## v0 architecture (decided defaults)

- **Stack:** TypeScript, Node ESM (`>=22`), `node --test`. Mirrors Flow's
  tsconfig/scripts.
- **`EphemerisScheduler`** core — `arm(bundle)`, `cancel(bundleId)`, restart-safe
  `start()`, deterministic `tick()`.
- **Injectable `Clock`** — `SystemClock` (default) and `ManualClock` for tests.
  All timing flows through it; with `ManualClock` there are **no real
  wall-clock waits** — firing is driven by `clock.advance()`.
- **Pluggable `Trigger`** — default `FlowEvaluateTrigger` (shells `flow evaluate
  <runId>`), plus `NoopTrigger` and `RecordingTrigger` for tests/examples.
- **Pluggable `Store`** — default `JsonFileStore` (persists pending + fired sets
  to disk; reloads and re-arms on startup), plus `InMemoryStore` for tests.
- **Source adapters** — programmatic `arm(bundle)` API + `DirectoryWatcherSource`
  that watches a directory of emitted bundle JSON files.
- **Idempotency** — deadlines deduped by `(bundleId, claimId, expiresAt)`, fire
  at most once; fired keys persisted so reload / duplicate-arm / past-due never
  double-fire.

### Public API

```ts
import {
  EphemerisScheduler,           // core: arm / cancel / start / tick / stop
  Clock, SystemClock, ManualClock,
  Trigger, FlowEvaluateTrigger, NoopTrigger, RecordingTrigger,
  Store, InMemoryStore, JsonFileStore,
  DirectoryWatcherSource,
  TrustBundleReadModel, ClaimReadModel, ArmedDeadline, deadlineKey,
  deriveFireAt,
} from "@kontourai/ephemeris";
```

The read-model types (`TrustBundleReadModel`, `ClaimReadModel`) are a
deliberately minimal, shape-only contract — Ephemeris does not depend on the full
hachure/flow schema. (See the `TODO(schema)` note below.)

## Quick start

```bash
npm install
npm run build      # tsc
npm test           # build + node --test (9 tests, fully deterministic, no sleeps)
npm run example    # arm a claim that expires shortly, advance a ManualClock, fire once
```

Run the daemon:

```bash
ephemeris watch <bundleDir> [--store .ephemeris/wakeups.json] [--flow-cmd flow]
```

## Open / TODO (pinned-before-real questions from the design)

These are the design's open questions; v0 picks a default for each and leaves a
`TODO(...)` at the relevant code site.

- **`TODO(emit-target)`** — *emits to what?* v0 shells out to `flow evaluate
  <runId>` behind the `Trigger` interface. Still open: direct in-process
  `evaluateRun` call vs. producer notify vs. generic event bus. (`src/trigger.ts`)
- **`TODO(discovery)`** — *how it learns which bundles to watch.* v0 implements
  `DirectoryWatcherSource` + the programmatic `arm()` API. Still open: subscribe
  to emitted bundles vs. a registry vs. a stream. (`src/sources.ts`)
- **`TODO(backpressure)`** — idempotency is per-deadline only; a flappy claim
  that re-arms a *fresh* deadline each emit could still storm. No rate-limit /
  coalescing yet. (`src/cli.ts`)
- **`TODO(durability)`** — `JsonFileStore` rewrites the whole file per mutation
  (fine for a small single daemon). Swap for an append log / embedded KV as the
  watched-bundle count grows. (`src/store.ts`)
- **`TODO(schema)`** — align the local read-model with the published Hachure
  TrustBundle / claim schema. (`src/types.ts`)
- **Shared hosted-ingest seam** — the hosted-ingest contract that Flow's
  `HostedConsoleSink` also needs is the same surface Ephemeris consumes. It
  should be designed **once, for both**. Ephemeris co-owns this seam.

## Non-goals

- Not an orchestrator and not a trust authority. It schedules; it does not decide.
- Not a replacement for the producer / CI / person trigger paths — it is one more
  external trigger source, specialized for wall-clock expiry.

## License

Apache-2.0.
