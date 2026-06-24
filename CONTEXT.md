# Ephemeris Context

Ephemeris is the Kontour suite's external freshness scheduler / event-bridge. Its role is narrow: turn time into a trigger. It ingests Flow-emitted run-output TrustBundles, reads each claim's Hachure freshness fields (`expiresAt` / `ttlSeconds`), arms durable wake-ups for the derived deadlines, and nudges Flow at the deadline.

## Layer Model

- **Hachure** owns the shape: TrustBundle and claim schemas, including freshness fields.
- **Surface** owns the meaning: derives `fresh` / `stale` from `expiresAt`.
- **Flow** owns the reaction: re-derives at the real `now` on `evaluateRun` and emits artifacts.
- **Ephemeris** owns the time: arms wake-ups from deadlines and triggers Flow after they pass.

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

## Boundary

Ephemeris is an external time actor, not an orchestrator or trust authority. It may discover emitted bundles, persist its own wake-up state, and call Flow when deadlines pass. It must not create, edit, or reinterpret trust artifacts, and it must not move scheduling authority back into Surface or Flow.
