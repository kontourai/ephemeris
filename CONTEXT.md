# Ephemeris Context

Ephemeris is the Kontour suite's external time actor. Its role is to turn time into a trigger — across two schedule axes. The **deadline engine** ingests Flow-emitted run-output TrustBundles, reads each claim's Hachure freshness fields (`expiresAt` / `ttlSeconds`), arms durable wake-ups for the derived deadlines, and nudges Flow at the deadline. The **recurring-schedule core** is a pure evaluation engine (`cron` / one-shot `at` / fixed `every`, timezone- and DST-aware, with catch-up) that consumers like Station build on instead of growing their own clock.

## Layer Model

- **Hachure** owns the shape: TrustBundle and claim schemas, including freshness fields.
- **Surface** owns the meaning: derives `fresh` / `stale` from `expiresAt`.
- **Flow** owns the reaction: re-derives at the real `now` on `evaluateRun` and emits artifacts.
- **Ephemeris** owns the time, on two axes: arms wake-ups from data-derived deadlines and triggers Flow after they pass; and evaluates recurring wall-clock schedules as a pure core (it computes *when*, never fires — the consumer owns firing).

## Invariants

- **It triggers, it never authors.** Ephemeris writes nothing to TrustBundles or ledgers. A fire is only a nudge; Flow re-derives and Surface decides for real.
- **Expiry is derived; invalidation is an event.** Ephemeris reacts to `expiresAt`; it does not synthesize `stale`, `revoked`, or other trust state.
- **Owns no trust or process authority.** Its durable state is private wake-up bookkeeping, not authoritative product state.
- **Deterministic timing belongs behind `Clock`.** Tests use `ManualClock`; avoid real sleeps or real wall-clock waits in deterministic paths.

## Vocabulary

- **TrustBundle:** Flow-emitted bundle that Ephemeris consumes as a read model. Hachure forbids a bundle-level `id`; Ephemeris keys bundles on `source`.
- **Claim:** Freshness-bearing item inside a TrustBundle. Claims with no freshness field arm no deadline.
- **Deadline / `fireAt`:** Data-derived instant from `expiresAt` or `ttlSeconds`; not a cron schedule.
- **Source:** Adapter that feeds bundles to `arm()` and removals to `cancel()`. Current sources include `DirectoryWatcherSource`, `RegistrySource`, and the raw programmatic `arm()` API.
- **Store:** Ephemeris-owned durability for pending and fired wake-ups. `JsonFileStore` is the simple default, `AppendLogStore` is append-per-mutation with replay and compaction, and `InMemoryStore` is for tests.
- **Trigger:** Nudge path that fires at a deadline. The default `FlowEvaluateTrigger` calls Flow's `evaluateRun(runId)` through an injectable `FlowRunner`; trigger contracts return `void`.
- **Coalescing:** Per-claim collapse of redundant pending deadlines so a flappy claim cannot storm.
- **Rate limiting:** `minFireIntervalMs` limits fires for the same claim; under-firing inside the window is safe because Flow re-derives at the next allowed fire.
- **Schedule:** A recurring plan — `cron` (Vixie 5-field + optional IANA timezone, DST-aware), one-shot `at` (a fixed epoch instant), or fixed `every` (an interval anchored to the job's own run history). Discriminated by `kind`.
- **ScheduledJob:** The minimal input the schedule evaluator reads — `schedule`, `lastRunMs`, `createdMs`, `enabled`. Ephemeris computes; the consumer owns the full job record (id, owner, payload, persistence).
- **RunRecord:** Durable per-fire record (`firedAtMs`, `scheduledForMs`, `missedCount`, `durationMs`, `success`, `outputRef`). A type only — Ephemeris does not store these; the consumer persists them. Intended receipt substrate for station#1889.

## Boundary

Ephemeris is an external time actor, not an orchestrator or trust authority. It may discover emitted bundles, persist its own wake-up state, and call Flow when deadlines pass. It must not create, edit, or reinterpret trust artifacts, and it must not move scheduling authority back into Surface or Flow.

The recurring-schedule core is pure and narrower still: it evaluates *when* a schedule fires (`nextOccurrence` / `isOverdue` / `missedCount`) and returns the answer. It does not fire, does not persist, and owns no job lifecycle — the consumer does all of that. `nowMs` is always an argument, never read from the wall clock, so the core is deterministic without a `Clock` shim.
