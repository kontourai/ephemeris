# Getting started

Ephemeris is published to npm as `@kontourai/ephemeris`. It is an ES module
package for Node.js 22 or newer. It ships a library and one command,
`ephemeris`.

## Install

```bash
npm install @kontourai/ephemeris
```

The only runtime dependency is [`hachure`](https://www.npmjs.com/package/hachure),
which supplies the claim and trust-bundle schemas Ephemeris validates against.

`@kontourai/flow` (`>=1.4.0`) is an **optional** peer dependency. Install it
only if you want the default trigger to call Flow's `evaluateRun` in-process.
Ephemeris imports it lazily, the first time the default runner fires, so the
library loads without it. If Flow is only available as a `flow` executable on
`PATH`, use the CLI runner instead (see [Run the daemon](#run-the-daemon)).

## Arm and fire a deadline in code

The smallest useful program arms one claim and lets time pass. This mirrors
`examples/demo.mjs` in the repository. A `ManualClock` drives time, so nothing
waits on the wall clock, and a `RecordingTrigger` records fires instead of
calling Flow.

```js
import {
  EphemerisScheduler,
  ManualClock,
  InMemoryStore,
  RecordingTrigger,
} from "@kontourai/ephemeris";

const clock = new ManualClock(0);
const trigger = new RecordingTrigger();
const scheduler = new EphemerisScheduler({
  clock,
  store: new InMemoryStore(),
  trigger,
});
await scheduler.start();

// A Flow run-output bundle is identified by `source`, not by an id.
scheduler.arm({
  source: "flow-run:my-flow:run-abc",
  claims: [{ id: "claim-1", expiresAt: new Date(5000).toISOString() }],
});

clock.advance(6000);
console.log(trigger.fired.length); // 1, for runId "run-abc"

scheduler.arm(/* the same bundle again */ {
  source: "flow-run:my-flow:run-abc",
  claims: [{ id: "claim-1", expiresAt: new Date(5000).toISOString() }],
});
clock.advance(1000);
console.log(trigger.fired.length); // still 1: a fired deadline never re-fires

scheduler.stop();
```

From a clone of the repository, `npm run example` builds the package and runs
the same demo.

In production, omit `clock` (it defaults to `SystemClock`) and `trigger` (it
defaults to `FlowEvaluateTrigger`, which calls Flow), and pass a durable store
such as `JsonFileStore`. See the [reference](reference.md#ephemerisscheduler).

## Evaluate a recurring schedule

The recurring-schedule functions are pure: you pass the current time in, and
they return an answer. They never fire anything.

```js
import { validateSchedule, nextOccurrence, isOverdue } from "@kontourai/ephemeris";

const schedule = { kind: "cron", expr: "0 9 * * *", timezone: "America/Denver" };

validateSchedule(schedule); // null when well-formed, else an error string

const now = Date.now();
nextOccurrence(schedule, now); // next 09:00 Denver time, as epoch ms

isOverdue({ schedule, createdMs: now - 86_400_000 }, now); // true or false
```

Your code owns firing, persistence, and the job record. See
[Recurring-schedule core](concepts.md#recurring-schedule-core).

## Run the daemon

The `ephemeris watch` command watches a directory of emitted bundle JSON files,
arms every claim deadline it finds, and calls Flow when each one passes:

```bash
npx ephemeris watch ./bundles
```

By default it persists wake-ups to `.ephemeris/wakeups.json` and calls Flow's
`evaluateRun` programmatically. To shell out to `flow evaluate <runId>`
instead:

```bash
npx ephemeris watch ./bundles --flow-mode cli --cwd /path/to/flow/project
```

It runs until it receives `SIGINT` or `SIGTERM`. Every option is listed in the
[CLI reference](reference.md#ephemeris-watch).

## Troubleshooting

**A claim never fires.** Ephemeris arms a claim only if it carries a freshness
field. A claim with neither `expiresAt` nor `ttlSeconds` arms nothing. A claim
that fails validation also arms nothing, without an error: `id` must be a
non-empty string, `expiresAt` must be a parseable date-time string, and
`ttlSeconds` must be an integer of 0 or more. Use `validateClaimFreshness(claim)`
to see the issues for a claim.

**Flow is called with the wrong run id.** The run id comes from the bundle's
`runId` field if present. Otherwise it is the text after the last `:` of a
`flow-run:<definitionId>:<runId>` source. If the source does not start with
`flow-run:`, the whole `source` string is used. Set `runId` on the bundle when
your source label is non-standard.

**A deadline fires once and never again.** That is by design. Each deadline is
identified by bundle source, claim id, and fire instant, and fires at most
once, including across restarts with a durable store. A claim fires again only
when it is re-armed with a different deadline. Fired history is kept for 7 days
by default (`firedRetentionMs`); after that, re-arming a long-past deadline can
fire it again, which is harmless because a fire is only a nudge.

**Fires are being skipped.** With `minFireIntervalMs` (or `--min-fire-interval`)
above `0`, a fire for the same claim inside that window is dropped. Pass an
`onCoalesced` callback to the scheduler to observe each skipped fire and why.

**Trigger errors.** A failed Flow call does not stop the daemon. By default the
error is logged to stderr as `[ephemeris] trigger failed for ...`. Pass
`onError` to the scheduler to handle it yourself.

**`ephemeris watch` exits with `fatal: ... ENOENT`.** The bundle directory must
exist before the daemon starts.

**`nextOccurrence` throws for a cron schedule.** A malformed cron expression or
an unknown timezone throws. Call `validateSchedule` first and reject schedules
that return an error string.
