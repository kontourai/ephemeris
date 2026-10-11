# Reference

The public surface of `@kontourai/ephemeris`: the `ephemeris` command and every
export of the package entry point (`src/index.ts`). For how the pieces fit
together, see [Concepts](concepts.md).

## ephemeris watch

```text
ephemeris watch <bundleDir> [--store <path>] [--store-mode json|appendlog]
                            [--compact-threshold <n>] [--min-fire-interval <ms>]
                            [--flow-mode programmatic|cli] [--flow-cmd <cmd>]
                            [--cwd <path>]
```

Watches `<bundleDir>` for bundle `.json` files with a `DirectoryWatcherSource`,
arms each claim deadline on an `EphemerisScheduler` running on the system
clock, and fires a `FlowEvaluateTrigger` at each deadline. `watch` is the only
command.

| Option | Default | Meaning |
| --- | --- | --- |
| `--store <path>` | `.ephemeris/wakeups.json` | Path of the durable store file. |
| `--store-mode <mode>` | `json` | `appendlog` uses `AppendLogStore`. Any other value uses `JsonFileStore`. |
| `--compact-threshold <n>` | `1000` | Records appended before `AppendLogStore` compacts. Used only with `--store-mode appendlog`. |
| `--min-fire-interval <ms>` | `0` | Minimum milliseconds between fires for the same claim. `0` disables rate limiting. |
| `--flow-mode <mode>` | `programmatic` | `cli` runs `<flow-cmd> evaluate <runId>`. Any other value imports `@kontourai/flow` and calls `evaluateRun`. |
| `--flow-cmd <cmd>` | `flow` | Executable used with `--flow-mode cli`. |
| `--cwd <path>` | none | Working directory passed to Flow: the `cwd` option of `evaluateRun`, or the child process's directory in `cli` mode. |

On start it prints one line to stderr with the directory, store, Flow mode,
interval, and pending count. It stops on `SIGINT` or `SIGTERM` and exits `0`.

Exit codes: `2` when the command is not `watch` or `<bundleDir>` is missing
(the usage line is printed), and `1` on a fatal startup error, such as a
missing bundle directory.

## EphemerisScheduler

```ts
new EphemerisScheduler(options?: EphemerisSchedulerOptions)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `clock` | `new SystemClock()` | Time source. With a `ManualClock`, no real timers are used and each `advance()` or `set()` fires due deadlines synchronously. |
| `store` | `new InMemoryStore()` | Pending and fired bookkeeping. |
| `trigger` | `new FlowEvaluateTrigger()` | Called for each deadline that fires. |
| `onError` | logs to stderr | `(err, deadline) => void`, called when a trigger throws or rejects. |
| `minFireIntervalMs` | `0` | Minimum interval between fires for the same `(bundleSource, claimId)`. Negative values are treated as `0`. |
| `onCoalesced` | no-op | `(deadline, reason) => void`, called when a due fire is dropped. `reason` is a `CoalesceReason`. |
| `firedRetentionMs` | 7 days | Fired keys whose `fireAt` is older than now minus this are pruned on each sweep. Pass `Infinity` to keep them forever. |

| Method | Returns | Behaviour |
| --- | --- | --- |
| `start()` | `Promise<void>` | Re-arms every pending deadline in the store, then fires any that are due. Call once on boot. |
| `arm(bundle)` | `ArmedDeadline[]` | Arms each valid claim with a freshness deadline, skipping deadlines already pending or fired and superseding a claim's older pending deadline. Fires any newly armed deadline that is already due. Returns only the deadlines armed by this call. |
| `cancel(bundleSource)` | `void` | Removes the bundle's pending deadlines. Fired history is untouched. |
| `tick()` | `Promise<void>` | Fires every pending deadline with `fireAt <= now`, each at most once, then awaits the trigger promises. Safe to call repeatedly. |
| `pendingCount()` | `number` | Number of armed, unfired deadlines. |
| `stop()` | `void` | Clears all timers and detaches from a `ManualClock`. |

`CoalesceReason` is `"min-interval" | "superseded"`. The scheduler currently
reports only `"min-interval"` to `onCoalesced`; superseding a pending deadline
is not reported.

With `SystemClock`, timers are `unref()`ed, so they do not by themselves keep a
Node process alive. Delays longer than about 24.8 days are split into chained
timers.

### deriveFireAt

```ts
deriveFireAt(claim: ClaimReadModel, now: number): number | undefined
```

Returns `Date.parse(claim.expiresAt)` when `expiresAt` is set (and throws if it
does not parse), else `now + ttlSeconds * 1000` when `ttlSeconds` is set, else
`undefined`. `arm` validates claims first, so it never reaches the throw.

## Clocks

`Clock` is `{ now(): number }`, in epoch milliseconds.

- `SystemClock`: `now()` returns `Date.now()`.
- `ManualClock(start = 0)`: time moves only when you call `advance(ms)` or
  `set(ms)`. `advance` throws on a negative `ms`, and `set` throws if time would
  move backwards. `onAdvance(listener)` registers a callback run after each
  move and returns an unsubscribe function.

## Triggers and Flow runners

`Trigger` is `{ fire(deadline: ArmedDeadline): Promise<void> }`.
`FlowRunner` is `(runId: string) => Promise<void>`.

| Export | Behaviour |
| --- | --- |
| `new FlowEvaluateTrigger({ runner? })` | Calls `runner(deadline.runId)`. The default runner is `programmaticFlowRunner()`. |
| `programmaticFlowRunner({ cwd? })` | On first call, imports `@kontourai/flow` and calls `evaluateRun(runId, { cwd })`. Throws if the module does not export `evaluateRun`. The result is discarded. |
| `cliFlowRunner({ command?, cwd? })` | Spawns `<command> evaluate <runId>` (default command `flow`) with output ignored. Rejects on a spawn error or a non-zero exit. |
| `new NoopTrigger()` | Does nothing. |
| `new RecordingTrigger()` | Appends each deadline to its `fired` array. `countFor(keyFn, value)` counts fires whose `keyFn(deadline)` equals `value`. |

## Stores

Every store implements `Store`: `pending()`, `has(key)`, `hasFired(key)`,
`addPending(deadline)`, `removePending(key)`, `removePendingForBundle(source)`,
`markFired(key)`, and `prune(beforeFireAt)`. Keys are `deadlineKey` values.
`addPending` ignores a deadline that has already fired.

| Export | Behaviour |
| --- | --- |
| `new InMemoryStore()` | In memory only. |
| `new JsonFileStore(path)` | Loads `path` on construction. Rewrites the whole file on every change by writing `<path>.tmp` and renaming it over `path`, creating parent directories. An unparseable file loads as empty state. |
| `new AppendLogStore(path, { compactThreshold? })` | Appends one JSON line (`arm`, `fire`, or `remove`) per change and replays the log on load, skipping lines that do not parse. After `compactThreshold` records (default 1000, minimum 1) it rewrites the file as one `snapshot` line. Also has `compact()` and `logLength()`. Pruning is applied in memory and written at the next compaction. |

## Sources

`SchedulerSink` is `{ arm(bundle): ArmedDeadline[]; cancel(bundleSource): void }`.
`EphemerisScheduler` satisfies it.

| Export | Behaviour |
| --- | --- |
| `new DirectoryWatcherSource(dir, sink)` | `scanOnce()` arms every `*.json` file in `dir`. `start()` scans, then watches `dir` with `fs.watch` and arms each changed `.json` file. `stop()` closes the watcher. Files that do not parse or lack `source` and `claims` are skipped. It never calls `cancel`. |
| `new RegistrySource(sink)` | `register(bundle)` stores the bundle by `source` and returns `sink.arm(bundle)`, or `[]` for a bundle without a `source` string and `claims` array. `deregister(source)` removes it, calls `sink.cancel(source)`, and returns whether it was registered. `has(source)` and `registered()` inspect the registry. |

## Read-model types and helpers

| Export | Kind | Meaning |
| --- | --- | --- |
| `TrustBundleReadModel` | type | `{ source: string; runId?: string; claims: ClaimReadModel[] }` |
| `ClaimReadModel` | type | `{ id: string; expiresAt?: string; ttlSeconds?: number }` |
| `ArmedDeadline` | type | `{ bundleSource: string; runId: string; claimId: string; fireAt: number }` |
| `deadlineKey(d)` | function | Deadline identity from `bundleSource`, `claimId`, and `fireAt`. |
| `claimKey(d)` | function | Per-claim key from `bundleSource` and `claimId`, used for coalescing. |
| `runIdFromSource(source)` | function | The text after the last `:` of a `flow-run:` source, else `undefined`. |
| `HACHURE` | constant | `runOutputSourcePrefix` (`"flow-run:"`) and lazy `schema.claim` / `schema.trustBundle` getters. |

## Hachure schema binding

| Export | Behaviour |
| --- | --- |
| `getClaimSchema()` | The `claim` schema published by the `hachure` package, read on first call and cached. |
| `getTrustBundleSchema()` | The `trust-bundle` schema, likewise. |
| `validateClaimFreshness(claim)` | Returns `ValidationIssue[]` (`{ field, message }`), empty when valid. Checks only that `claim` is an object, `id` is a non-empty string, `expiresAt` (if present) is a string `Date.parse` accepts, and `ttlSeconds` (if present) is an integer of 0 or more. |

`JsonSchema`, `JsonSchemaProperty`, and `ValidationIssue` are exported as types.

## Schedule functions

All of these are pure: every instant is an epoch-millisecond argument.

| Function | Returns |
| --- | --- |
| `validateSchedule(schedule)` | `null` if well-formed, else a message for the first problem. Checks that a `cron` has exactly 5 parseable, in-range fields and, if set, a known IANA `timezone` (or `UTC`); that `everyMs` is finite and above 0; and that `timeMs` is finite. It does not check that a cron ever fires. |
| `nextOccurrence(schedule, fromMs)` | The next fire strictly after `fromMs`, or `null`. `cron`: the next matching minute in its timezone, or `null` if none within about one year; throws on a malformed expression. `at`: `timeMs` if it is after `fromMs`, else `null`. `every`: `fromMs + everyMs`. |
| `isOverdue(job, nowMs)` | Whether `job` should fire now. `false` when `enabled` is `false`. `at`: never run and `timeMs <= nowMs`. `cron` and `every`: the next occurrence after `lastRunMs ?? createdMs` is at or before `nowMs`. |
| `missedCount(schedule, fromMs, toMs)` | Occurrences strictly between `fromMs` and `toMs`, so an on-time fire counts `0`. Returns `0` when `toMs <= fromMs`, and is capped at 1000. |
| `nextOccurrences(schedule, count, fromMs)` | Up to `count` (capped at 1000) successive fire times after `fromMs`, stopping early when the schedule has no further fires. |

### Schedule types

| Type | Shape |
| --- | --- |
| `CronSchedule` | `{ kind: "cron"; expr: string; timezone?: string }` |
| `AtSchedule` | `{ kind: "at"; timeMs: number; deleteAfterRun?: boolean }` |
| `EverySchedule` | `{ kind: "every"; everyMs: number }` |
| `Schedule` | `CronSchedule \| AtSchedule \| EverySchedule` |
| `ScheduledJob` | `{ schedule: Schedule; lastRunMs?: number; createdMs: number; enabled?: boolean }` |
| `RunRecord` | `{ firedAtMs: number; scheduledForMs: number; missedCount: number; durationMs?: number; success?: boolean; outputRef?: string }` |

Cron fields follow Vixie cron: minute 0-59, hour 0-23, day-of-month 1-31,
month 1-12, and day-of-week 0-7, where 0 and 7 are both Sunday. Each field is a
comma-separated list of values, ranges (`a-b`), stepped ranges (`a-b/n` or
`*/n`), or `*`. Values must be plain decimal integers; month and weekday names
are not accepted.
