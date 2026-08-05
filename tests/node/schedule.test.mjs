import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  validateSchedule,
  nextOccurrence,
  isOverdue,
  missedCount,
  nextOccurrences,
} from "../../dist/index.js";

// Epoch-ms helper: utc(Y, M, D, h, m, s) — M is 1-based (human), matches the
// readable form used in cron specs. Compare results against Date.UTC exactly.
const utc = (y, mo, d, h = 0, mi = 0, s = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, s);

// ---------------------------------------------------------------------------
// every
// ---------------------------------------------------------------------------

test("every: nextOccurrence from lastRunMs returns lastRunMs + everyMs", () => {
  const lastRun = utc(2026, 1, 1, 9, 0, 0);
  const next = nextOccurrence({ kind: "every", everyMs: 30000 }, lastRun);
  assert.equal(next, lastRun + 30000);
});

test("every: isOverdue true iff lastRunMs + everyMs <= nowMs", () => {
  const lastRun = utc(2026, 1, 1, 9, 0, 0);
  const job = {
    schedule: { kind: "every", everyMs: 30000 },
    lastRunMs: lastRun,
    createdMs: lastRun,
  };
  // 1 ms before the next fire: not overdue.
  assert.equal(isOverdue(job, lastRun + 29999), false);
  // Exactly at the next fire: overdue.
  assert.equal(isOverdue(job, lastRun + 30000), true);
  // After: overdue.
  assert.equal(isOverdue(job, lastRun + 30001), true);
});

test("every: never-run job becomes overdue once its first interval elapses", () => {
  const created = utc(2026, 1, 1, 0, 0, 0);
  const job = {
    schedule: { kind: "every", everyMs: 60000 },
    createdMs: created,
  };
  assert.equal(isOverdue(job, created + 59999), false);
  assert.equal(isOverdue(job, created + 60000), true);
});

test("every: enabled=false reports not overdue regardless of time", () => {
  const lastRun = utc(2026, 1, 1, 9, 0, 0);
  const job = {
    schedule: { kind: "every", everyMs: 30000 },
    lastRunMs: lastRun,
    createdMs: lastRun,
    enabled: false,
  };
  assert.equal(isOverdue(job, lastRun + 10_000_000), false);
});

// ---------------------------------------------------------------------------
// missedCount (every, on-time, cap)
// ---------------------------------------------------------------------------

test("missedCount: on-time run (consecutive occurrences) reports 0", () => {
  const sched = { kind: "every", everyMs: 30000 };
  const last = utc(2026, 1, 1, 9, 0, 0);
  const curr = last + 30000; // consecutive
  assert.equal(missedCount(sched, last, curr), 0);
});

test("missedCount: caps at 1000 for an absurd interval", () => {
  const sched = { kind: "every", everyMs: 1 };
  // 100 million ms window with 1ms interval — far above the cap.
  assert.equal(missedCount(sched, 0, 100_000_000), 1000);
});

test("missedCount: cron caps at 1000 over a large window", () => {
  // Every-minute cron over a ~3.8-year window — far above the cap. Iterates
  // nextOccurrence up to CAP times and stops there.
  const sched = { kind: "cron", expr: "* * * * *" };
  const from = utc(2020, 1, 1, 0, 0, 0);
  const to = from + 2_000_000 * 60_000;
  assert.equal(missedCount(sched, from, to), 1000);
});

test("missedCount: counts strictly-intervening occurrences for every", () => {
  const sched = { kind: "every", everyMs: 30000 };
  const last = utc(2026, 1, 1, 9, 0, 0);
  // Three intervals later: occurrences at +30000 and +60000 are strictly inside,
  // the one at +90000 is the current fire (excluded).
  const curr = last + 90000;
  assert.equal(missedCount(sched, last, curr), 2);
});

// ---------------------------------------------------------------------------
// Catch-up: cron daily, last run 3 days ago, now today
// ---------------------------------------------------------------------------

test("catch-up: daily cron 3 days overdue is overdue with the right intervening count", () => {
  const sched = { kind: "cron", expr: "0 9 * * *" };
  const lastRun = utc(2026, 1, 1, 9, 0, 0); // 3 days ago
  const now = utc(2026, 1, 4, 9, 0, 0); // today
  const job = { schedule: sched, lastRunMs: lastRun, createdMs: lastRun };

  assert.equal(isOverdue(job, now), true);

  // Intervening occurrences strictly inside (lastRun, now): Jan 2 09:00, Jan 3 09:00.
  // The fire at `now` (Jan 4 09:00) is the current fire and excluded.
  assert.equal(missedCount(sched, lastRun, now), 2);
});

// ---------------------------------------------------------------------------
// One-shot `at`
// ---------------------------------------------------------------------------

test("at: nextOccurrence returns timeMs before fire, null once reached", () => {
  const timeMs = utc(2026, 6, 1, 12, 0, 0);
  const sched = { kind: "at", timeMs };
  // Before: returns the one-shot instant.
  assert.equal(nextOccurrence(sched, timeMs - 1000), timeMs);
  // At or after: nothing left to fire.
  assert.equal(nextOccurrence(sched, timeMs), null);
  assert.equal(nextOccurrence(sched, timeMs + 1), null);
});

test("at: isOverdue true iff never run and timeMs <= now", () => {
  const timeMs = utc(2026, 6, 1, 12, 0, 0);
  const job = {
    schedule: { kind: "at", timeMs },
    createdMs: timeMs - 10_000,
  };
  // Before timeMs: not overdue.
  assert.equal(isOverdue(job, timeMs - 1), false);
  // At/after timeMs, never run: overdue (matches "fires on next boot").
  assert.equal(isOverdue(job, timeMs), true);
  assert.equal(isOverdue(job, timeMs + 99999), true);

  // Once run: not overdue ever again.
  const ran = { ...job, lastRunMs: timeMs };
  assert.equal(isOverdue(ran, timeMs + 99999), false);
  assert.equal(nextOccurrence(ran.schedule, ran.lastRunMs), null);
});

// ---------------------------------------------------------------------------
// Cron: UTC
// ---------------------------------------------------------------------------

test("cron UTC: nextOccurrence of 0 9 * * * from a known epoch is the next 09:00 UTC", () => {
  const sched = { kind: "cron", expr: "0 9 * * *" };
  // From 08:59:59Z, the next 09:00 is the same day.
  assert.equal(
    nextOccurrence(sched, utc(2026, 1, 1, 8, 59, 59)),
    utc(2026, 1, 1, 9, 0, 0),
  );
  // From exactly 09:00:00Z, strictly-after is the NEXT day's 09:00.
  assert.equal(
    nextOccurrence(sched, utc(2026, 1, 1, 9, 0, 0)),
    utc(2026, 1, 2, 9, 0, 0),
  );
  // From 10:00Z, also next day.
  assert.equal(
    nextOccurrence(sched, utc(2026, 1, 1, 10, 0, 0)),
    utc(2026, 1, 2, 9, 0, 0),
  );
});

// ---------------------------------------------------------------------------
// Cron: DST-aware (the load-bearing test)
// ---------------------------------------------------------------------------

test("cron DST: 0 9 * * * America/Denver keeps local 9am across the 2026-03-08 spring-forward", () => {
  const sched = {
    kind: "cron",
    expr: "0 9 * * *",
    timezone: "America/Denver",
  };
  // US Mountain spring-forward in 2026 happens at 02:00 local on Sun Mar 8:
  // MST (UTC-7) -> MDT (UTC-6).

  // BEFORE the transition: ask on Mar 7 00:00 UTC.
  //   Next 9am Denver = Mar 7 09:00 MDT? No — Mar 7 is still MST (UTC-7),
  //   so 9am Denver = 16:00 UTC.
  const before = nextOccurrence(sched, utc(2026, 3, 7, 0, 0, 0));
  assert.equal(before, utc(2026, 3, 7, 16, 0, 0));

  // AFTER the transition: ask on Mar 10 00:00 UTC (transition is now in the past).
  //   Next 9am Denver = Mar 10 09:00 MDT (UTC-6) = 15:00 UTC.
  const after = nextOccurrence(sched, utc(2026, 3, 10, 0, 0, 0));
  assert.equal(after, utc(2026, 3, 10, 15, 0, 0));

  // The load-bearing assertion: both UTC instants project to 09:00 Denver
  // wall-clock, even though their UTC hours differ by exactly the DST offset.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  assert.equal(fmt.format(new Date(before)), "09:00", "Denver wall-clock before DST");
  assert.equal(fmt.format(new Date(after)), "09:00", "Denver wall-clock after DST");
  assert.equal(new Date(before).getUTCHours(), 16);
  assert.equal(new Date(after).getUTCHours(), 15);
});

test("cron DST: a multi-day walk from before through after the boundary stays at 9am Denver", () => {
  // Start Mar 6 00:00 UTC, walk six daily fires. Each must be 09:00 Denver
  // wall-clock; the UTC hour shifts from 16 to 15 once we cross Mar 8.
  const sched = {
    kind: "cron",
    expr: "0 9 * * *",
    timezone: "America/Denver",
  };
  const fires = nextOccurrences(sched, 6, utc(2026, 3, 6, 0, 0, 0));
  assert.equal(fires.length, 6);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hourCycle: "h23",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const project = (ms) => {
    const p = fmt.formatToParts(new Date(ms));
    const get = (t) => p.find((x) => x.type === t)?.value;
    return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
  };
  const projected = fires.map(project);
  // Every fire is 09:00 Denver, on consecutive days Mar 6..Mar 11.
  assert.deepEqual(
    projected,
    [
      "03/06 09:00",
      "03/07 09:00",
      "03/08 09:00",
      "03/09 09:00",
      "03/10 09:00",
      "03/11 09:00",
    ],
  );
  // UTC hours: 16 for MST days (Mar 6, 7), 15 for MDT days (Mar 8 onward).
  const utcHours = fires.map((ms) => new Date(ms).getUTCHours());
  assert.deepEqual(utcHours, [16, 16, 15, 15, 15, 15]);
});

test("cron DST: spring-forward gap does not fire at a non-matching local time", () => {
  // Denver springs forward Mar 8 2026 at 02:00 -> 03:00, so 02:30 does not
  // exist that day. A naive wall->UTC conversion returns the nearest instant
  // (01:30); the evaluator must reject it and skip to the next real 02:30.
  const sched = {
    kind: "cron",
    expr: "30 2 * * *",
    timezone: "America/Denver",
  };
  const next = nextOccurrence(sched, utc(2026, 3, 7, 12, 0, 0));
  // The next real 02:30 Denver is Mar 9 02:30 MDT (UTC-6) = 08:30 UTC.
  // (Mar 8 02:30 is the gap; the bug returned Mar 8 01:30 = 08:30 UTC Mar 8.)
  assert.equal(next, utc(2026, 3, 9, 8, 30, 0));
  // It must project back to 02:30 Denver wall-clock — the whole point.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hourCycle: "h23",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(next));
  const g = (t) => parts.find((p) => p.type === t)?.value;
  assert.equal(
    `${g("month")}/${g("day")} ${g("hour")}:${g("minute")}`,
    "03/09 02:30",
  );
});

test("cron DST: fall-back fold fires once per wall-clock occurrence (no double-fire)", () => {
  // Denver falls back Nov 1 2026 at 02:00 -> 01:00, so 01:30 occurs twice
  // (01:30 MDT then 01:30 MST). The schedule must fire exactly once for that
  // wall-clock minute, not twice.
  const sched = {
    kind: "cron",
    expr: "30 1 * * *",
    timezone: "America/Denver",
  };
  const fires = nextOccurrences(sched, 3, utc(2026, 10, 31, 12, 0, 0));
  assert.equal(fires.length, 3);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hourCycle: "h23",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const project = (ms) => {
    const p = fmt.formatToParts(new Date(ms));
    const g = (t) => p.find((x) => x.type === t)?.value;
    return `${g("month")}/${g("day")} ${g("hour")}:${g("minute")}`;
  };
  // Three consecutive days at 01:30 wall-clock; Nov 1 appears exactly once.
  assert.deepEqual(project(fires[0]), "11/01 01:30");
  assert.deepEqual(project(fires[1]), "11/02 01:30");
  assert.deepEqual(project(fires[2]), "11/03 01:30");
});

test("cron OR: DOM-restricted + DOW-restricted fires when only one side matches", () => {
  // 0 9 15 * 1 = 09:00 on day-of-month 15 OR Monday. With both fields
  // restricted, Vixie OR-semantics fire a day where EITHER matches.
  const sched = { kind: "cron", expr: "0 9 15 * 1" };
  // Jan 5 2026 is a Monday (weekday 1) but not the 15th -> fires via DOW.
  // Jan 15 2026 is a Thursday (weekday 4) -> fires via DOM.
  const fires = nextOccurrences(sched, 4, utc(2026, 1, 1, 0, 0, 0));
  assert.deepEqual(fires, [
    utc(2026, 1, 5, 9, 0, 0), // Mon (DOW hit, DOM miss)
    utc(2026, 1, 12, 9, 0, 0), // Mon (DOW hit, DOM miss)
    utc(2026, 1, 15, 9, 0, 0), // Thu (DOM hit, DOW miss)
    utc(2026, 1, 19, 9, 0, 0), // Mon (DOW hit, DOM miss)
  ]);
});

test("cron tz: 45-minute-offset zone (Asia/Kathmandu UTC+5:45) resolves correctly", () => {
  const sched = { kind: "cron", expr: "0 9 * * *", timezone: "Asia/Kathmandu" };
  // From 2026-01-01 00:00 UTC, the next 09:00 Kathmandu = 03:15 UTC same day.
  assert.equal(nextOccurrence(sched, utc(2026, 1, 1, 0, 0, 0)), utc(2026, 1, 1, 3, 15, 0));
});

// ---------------------------------------------------------------------------
// validateSchedule
// ---------------------------------------------------------------------------

test("validateSchedule: rejects malformed cron and invalid fields", () => {
  // 4-field cron (must be 5).
  assert.ok(validateSchedule({ kind: "cron", expr: "0 9 * *" }));
  // Out-of-range minute.
  assert.ok(validateSchedule({ kind: "cron", expr: "61 * * * *" }));
  // Out-of-range hour.
  assert.ok(validateSchedule({ kind: "cron", expr: "* 24 * * *" }));
  // Out-of-range month.
  assert.ok(validateSchedule({ kind: "cron", expr: "* * * 13 *" }));
  // Empty list entry (a trailing comma).
  assert.ok(validateSchedule({ kind: "cron", expr: "0 9 * * ," }));
  // Non-integer value.
  assert.ok(validateSchedule({ kind: "cron", expr: "abc 9 * * *" }));
  // Zero step.
  assert.ok(validateSchedule({ kind: "cron", expr: "*/0 9 * * *" }));
  // Non-decimal integers that Number() would coerce (hex, scientific) — Vixie
  // cron accepts only decimal digits.
  assert.ok(validateSchedule({ kind: "cron", expr: "0x10 9 * * *" }));
  assert.ok(validateSchedule({ kind: "cron", expr: "1e1 9 * * *" }));
});

test("validateSchedule: rejects unknown timezone", () => {
  assert.ok(
    validateSchedule({
      kind: "cron",
      expr: "0 9 * * *",
      timezone: "Mars/Olympus",
    }),
  );
});

test("validateSchedule: rejects non-positive everyMs", () => {
  assert.ok(validateSchedule({ kind: "every", everyMs: 0 }));
  assert.ok(validateSchedule({ kind: "every", everyMs: -5 }));
  assert.ok(validateSchedule({ kind: "every", everyMs: NaN }));
  assert.ok(validateSchedule({ kind: "every", everyMs: Infinity }));
});

test("validateSchedule: accepts well-formed schedules", () => {
  assert.equal(validateSchedule({ kind: "cron", expr: "0 9 * * *" }), null);
  assert.equal(
    validateSchedule({
      kind: "cron",
      expr: "*/5 9 * * 0",
      timezone: "America/Denver",
    }),
    null,
  );
  assert.equal(
    validateSchedule({ kind: "cron", expr: "0 9 * * *", timezone: "UTC" }),
    null,
  );
  assert.equal(validateSchedule({ kind: "every", everyMs: 1000 }), null);
  assert.equal(validateSchedule({ kind: "at", timeMs: 12345 }), null);
});

// ---------------------------------------------------------------------------
// nextOccurrences preview
// ---------------------------------------------------------------------------

test("nextOccurrences: previews the next N fire times", () => {
  const sched = { kind: "every", everyMs: 1000 };
  assert.deepEqual(nextOccurrences(sched, 3, 0), [1000, 2000, 3000]);
});

test("nextOccurrences: stops early when the schedule is spent", () => {
  const sched = { kind: "at", timeMs: 5000 };
  assert.deepEqual(nextOccurrences(sched, 5, 0), [5000]);
  assert.deepEqual(nextOccurrences(sched, 5, 5000), []);
});

test("nextOccurrences: previews a UTC daily cron", () => {
  const sched = { kind: "cron", expr: "0 0 * * *" };
  const out = nextOccurrences(sched, 3, utc(2026, 1, 1, 12, 0, 0));
  assert.deepEqual(out, [
    utc(2026, 1, 2, 0, 0, 0),
    utc(2026, 1, 3, 0, 0, 0),
    utc(2026, 1, 4, 0, 0, 0),
  ]);
});

// ---------------------------------------------------------------------------
// Purity: prove src/schedule.ts has no wall-clock / timer access
// ---------------------------------------------------------------------------

test("purity: src/schedule.ts is free of Date.now() and timers", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcPath = join(here, "..", "..", "src", "schedule.ts");
  const raw = readFileSync(srcPath, "utf8");
  // Strip comments so documentation text may mention `Date.now()` / timers
  // without triggering the runtime-purity check. What matters is that the
  // executable code never reaches for the wall clock or the timer API.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, ""); // line comments

  // No wall-clock read.
  assert.ok(
    !stripped.includes("Date.now("),
    "schedule.ts must not call Date.now()",
  );
  // No timers.
  assert.ok(
    !stripped.includes("setTimeout"),
    "schedule.ts must not use setTimeout",
  );
  assert.ok(
    !stripped.includes("setInterval"),
    "schedule.ts must not use setInterval",
  );
  assert.ok(
    !stripped.includes("setImmediate"),
    "schedule.ts must not use setImmediate",
  );
  // `new Date()` with no argument reads the wall clock and is therefore banned;
  // `new Date(ms)` is a pure conversion and is allowed.
  assert.ok(
    !/\bnew\s+Date\s*\(\s*\)/.test(stripped),
    "schedule.ts must not construct new Date() without an explicit epoch argument",
  );
});
