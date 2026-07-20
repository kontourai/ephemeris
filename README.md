# Ephemeris

> **Status: FROZEN (2026-07-02)** — development on this repo is paused. The
> freshness-trigger capability documented below is being folded into
> [Kontour Flow](https://github.com/kontourai/flow) as a Flow module; see
> [kontourai/flow#99](https://github.com/kontourai/flow/issues/99) for the
> fold-in tracking issue. This package is not published to npm. Do not build
> new dependencies on this repo.

**External freshness scheduler / event-bridge for the Kontour suite.**
Status: v0.3 · Layer: time actor.

> *Ephemeris* (n.) — in surveying/GNSS, a table of time-indexed positions that
> has an age, goes stale, and must be refreshed. The name carries the
> freshness/expiry meaning for free.

Ephemeris is a long-lived daemon whose entire job is to **turn time into a
trigger**. It:

1. **Ingests** Flow's emitted run-output TrustBundles and reads each referenced
   claim's `expiresAt` / `ttlSeconds` (Hachure freshness fields — **no new
   schema**, it only reads them, validated against the published `hachure`
   package's claim schema).
2. **Arms** a durable timer per claim deadline (data-derived instants, not cron),
   coalesced per claim so a flappy claim can't storm.
3. **Fires** an idempotent, rate-limited trigger at the deadline — by default a
   **programmatic** call to Flow's exported `evaluateRun(runId)`.

That is its whole job. It owns the clock and durable wake-ups; it owns no trust
or process authority.

## Why it exists

In kontourai/flow's `docs/design/route-back-cascade-and-trust-recursion.md`, Decision #1 resolved that
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

## What changed in v0.2

v0.2 turns three v0 scaffolds into real behavior, within a bounded increment:

1. **Read-model aligned to the published Hachure schema** (`hachure@^0.5.1`).
   The freshness fields Ephemeris reads now use Hachure's exact names/types and
   are validated against the package's published `claim` schema at ingest.
   Two schema realities are now honored in code:
   - The Hachure `trust-bundle` schema has **no bundle-level `id`** — it forbids
     one. A bundle is identified by its **`source`** string. So the read-model
     keys on `source`, not a synthetic `bundle.id`.
   - There is no `run` object on the bundle. Flow stamps the run-output bundle's
     `source` as `flow-run:<definitionId>:<runId>`; Ephemeris derives the runId
     it fires against from that (`runIdFromSource`), or the caller supplies one.
2. **`FlowEvaluateTrigger` is real.** It invokes Flow's `evaluateRun` for the
   bundle's run. The invocation is an injectable `FlowRunner`; the default
   (`programmaticFlowRunner`) does a **programmatic dynamic import** of
   `@kontourai/flow` and calls its exported `evaluateRun(runId)` — confirmed
   exported by `@kontourai/flow@^1.4.0`. A `cliFlowRunner` (shells `flow
   evaluate <runId>`, the confirmed subcommand) is provided for PATH-only
   deployments. The trigger writes **nothing** to any bundle/ledger — it is only
   a nudge; whatever the runner returns is discarded.
3. **Backpressure / coalescing.** Per-`(bundleSource, claimId)` coalescing
   collapses redundant *pending* deadlines (a re-armed claim's newest deadline
   supersedes its older pending one), and a configurable `minFireIntervalMs`
   rate-limits *fires* for the same claim. A flappy claim therefore can't storm
   the trigger. Coalescing is harmless by design: under-firing within the window
   is safe because Flow re-derives at the real `now` on the next allowed fire.

## What changed in v0.3

v0.3 closes the two deferred TODOs from v0.2 — *richer discovery* and
*durability-at-scale* — in a bounded, well-tested increment. No invariant moved:
Ephemeris still triggers and never authors, derives expiry, owns no authority,
and stays deterministic under `ManualClock` (no real sleeps, no real timers in
tests).

1. **Discovery beyond directory-watch — `RegistrySource`.** Ephemeris now ships
   a second, **event-driven** source alongside `DirectoryWatcherSource`: an
   in-process producer registry. A producer that already has an emitted bundle in
   hand calls `register(bundle)` (arms immediately) / `deregister(source)`
   (cancels immediately); the scheduler learns about it with **no polling and no
   clock coupling**.
   - *Why a registry over a poller:* discovery here is in-process — the producer
     can push directly, so a registry models the "producer notify" path exactly.
     There is no interval, so there is nothing to drive from a `Clock`; tests are
     deterministic by construction (every call is synchronous). A clock-driven
     `PollingSource` would only be needed for an EXTERNAL store that can't push —
     that is the still-deferred shared hosted-ingest seam, not in-process
     discovery.
   - *Composable:* a `Source` is anything that feeds bundles to `arm()` and
     signals removals to `cancel()`. Both sources (plus the raw `arm()` API) now
     target a narrow `SchedulerSink` and can run against **one scheduler at
     once**; `arm()`/`cancel()` are idempotent + flap-coalescing, so overlapping
     sources never double-fire. (`src/sources.ts`)
2. **Durability-at-scale — `AppendLogStore`.** The v0.2 `JsonFileStore` rewrites
   the whole file per mutation (O(state) each time) — fine for a small daemon.
   `AppendLogStore` instead appends **one record per mutation** (arm / fire /
   remove → O(1)), reconstructs state by **replaying the log on load**, and
   **compacts** when the log grows past a threshold (rewrite a single snapshot
   line + truncate, bounding the file). It is a drop-in behind the same `Store`
   interface.
   - *Proven (tests):* (a) reload **replays to identical state**; (b) **fired
     history survives restart** so a reload / re-armed bundle never double-fires;
     (c) **compaction preserves state and bounds the log**. A torn final line (a
     crash mid-append) is tolerated — replay skips it, losing at most the last
     in-flight mutation, which the scheduler re-derives on the next arm.
   - `JsonFileStore` stays the simple **no-config default**; `InMemoryStore`
     stays the test store. (`src/store.ts`)

## v0.2 architecture (decided defaults)

- **Stack:** TypeScript, Node ESM (`>=22`), `node --test`. Mirrors Flow's
  tsconfig/scripts.
- **`EphemerisScheduler`** core — `arm(bundle)`, `cancel(bundleSource)`,
  restart-safe `start()`, deterministic `tick()`, plus `minFireIntervalMs` /
  `onCoalesced` for backpressure.
- **Injectable `Clock`** — `SystemClock` (default) and `ManualClock` for tests.
  All timing flows through it; with `ManualClock` there are **no real
  wall-clock waits** — firing is driven *synchronously* by `clock.advance()`.
- **Pluggable `Trigger`** — default `FlowEvaluateTrigger` over an injectable
  `FlowRunner` (`programmaticFlowRunner` by default; `cliFlowRunner` available),
  plus `NoopTrigger` and `RecordingTrigger` for tests/examples.
- **Pluggable `Store`** — default `JsonFileStore` (persists pending + fired sets
  to disk; reloads and re-arms on startup), plus `InMemoryStore` for tests and
  `AppendLogStore` for durability-at-scale (append-per-mutation + compaction; see
  "What changed in v0.3").
- **Source adapters** — programmatic `arm(bundle)` API + two pluggable sources:
  `DirectoryWatcherSource` (watches a directory of emitted bundle JSON files,
  keyed on `source`) and `RegistrySource` (event-driven in-process producer
  registry). Both target the narrow `SchedulerSink` and compose against one
  scheduler.
- **Idempotency** — deadlines deduped by `(bundleSource, claimId, fireAt)`, fire
  at most once; fired keys persisted so reload / duplicate-arm / past-due never
  double-fire.
- **Hachure binding** — `src/hachure-schema.ts` loads the published `claim` /
  `trust-bundle` schemas straight from the `hachure` package and exposes a
  dependency-free `validateClaimFreshness` for the slice Ephemeris reads. (No
  full JSON-Schema engine is pulled in: Ephemeris reads a tiny, well-known slice,
  and a test asserts its constraints still match the published schema.)

### Public API

```ts
import {
  EphemerisScheduler,           // core: arm / cancel / start / tick / stop
  Clock, SystemClock, ManualClock,
  Trigger, FlowEvaluateTrigger,       // default trigger over a FlowRunner
  FlowRunner, programmaticFlowRunner, cliFlowRunner,
  NoopTrigger, RecordingTrigger,
  Store, InMemoryStore, JsonFileStore, AppendLogStore,
  DirectoryWatcherSource, RegistrySource, SchedulerSink,
  TrustBundleReadModel, ClaimReadModel, ArmedDeadline,
  deadlineKey, claimKey, runIdFromSource, HACHURE,
  validateClaimFreshness, getClaimSchema, getTrustBundleSchema,
  deriveFireAt,
} from "@kontourai/ephemeris";
```

The read-model types (`TrustBundleReadModel`, `ClaimReadModel`) are a
deliberately minimal slice — Ephemeris carries only the freshness-bearing fields
— but those fields now match Hachure's published `claim` / `trust-bundle` schema
names and types exactly, and are validated against them at ingest.

## Quick start

```bash
npm install
npm run build      # tsc
npm test           # build + node --test (fully deterministic, no sleeps)
npm run example    # arm a claim that expires shortly, advance a ManualClock, fire once
```

Run the daemon:

```bash
ephemeris watch <bundleDir> \
  [--store .ephemeris/wakeups.json] \
  [--store-mode json|appendlog] [--compact-threshold <n>] \
  [--min-fire-interval <ms>] \
  [--flow-mode programmatic|cli] [--flow-cmd flow] [--cwd <path>]
```

The store defaults to `json` (`JsonFileStore`, full rewrite per mutation —
simple). Pass `--store-mode appendlog` for `AppendLogStore` (append-per-mutation
+ compaction) when the watched-bundle count grows; `--compact-threshold` tunes
how many records accumulate before it rewrites a snapshot and truncates.

Flow invocation defaults to a **programmatic** import of `@kontourai/flow`'s
`evaluateRun`; pass `--flow-mode cli` to shell out to the `flow evaluate` binary
instead (e.g. when Flow is only available on PATH).

## Resolved in v0.3

These v0.2 open-questions are now closed in code (no `TODO(...)` marker left):

- **`discovery` → resolved.** Ephemeris ships two pluggable sources —
  `DirectoryWatcherSource` (filesystem) and `RegistrySource` (event-driven
  in-process producer registry) — plus the raw `arm()` API, all composing against
  one `SchedulerSink`. What remains deferred is only the shared *hosted-ingest*
  transport (below), not in-process discovery. (`src/sources.ts`)
- **`durability` → resolved.** `AppendLogStore` appends one record per mutation,
  replays on load, and compacts past a threshold (snapshot + truncate) to bound
  the log. `JsonFileStore` stays the simple default. (`src/store.ts`)

## Resolved in v0.2

These design open-questions are now decided in code (no `TODO(...)` marker left):

- **`emit-target` → resolved.** Ephemeris invokes Flow's exported
  `evaluateRun(runId)` programmatically by default, behind the injectable
  `FlowRunner`/`Trigger` seam (CLI shell-out available as `cliFlowRunner`). It
  remains swappable for a producer notify / event-bus adapter. (`src/trigger.ts`)
- **`backpressure` → resolved.** Per-claim coalescing of pending deadlines +
  `minFireIntervalMs` rate-limiting of fires. (`src/scheduler.ts`)
- **`schema` → resolved.** Read-model aligned to and validated against the
  published `hachure@^0.5.1` `claim` / `trust-bundle` schemas; keyed on `source`
  (Hachure forbids a bundle `id`). (`src/types.ts`, `src/hachure-schema.ts`)

## Still open / deferred (clearly out of v0.3 scope)

- **Shared hosted-ingest seam** — the only genuinely-deferred discovery item.
  The cross-process hosted-ingest contract that Flow's `HostedConsoleSink` also
  needs is the same surface Ephemeris consumes; it should be designed **once, for
  both**, so it is deferred until that joint design lands. (When it does, the
  natural adapter is a clock-driven `PollingSource` over the external store, or a
  push subscription — both slot into the existing `SchedulerSink` seam.)
  Ephemeris co-owns it.

## Non-goals

- Not an orchestrator and not a trust authority. It schedules; it does not decide.
- Not a replacement for the producer / CI / person trigger paths — it is one more
  external trigger source, specialized for wall-clock expiry.

## License

Apache-2.0.
