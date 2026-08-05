/**
 * Recurring-schedule evaluation core — pure functions over data.
 *
 * Sibling to {@link EphemerisScheduler} (the deadline engine). Where the
 * deadline engine arms one-shot wake-ups from data-derived `expiresAt` /
 * `ttlSeconds` fields, this module answers a different question: *"given a
 * recurring schedule, when does it next fire — and how many fires were
 * missed?"* It is the building block Station, boo-TS, and flow-agents consume
 * to evaluate cron / interval / one-shot schedules.
 *
 * ## Pure by design
 *
 * Every function here is pure over its inputs. Time is ALWAYS an explicit
 * epoch-millisecond parameter (`fromMs`, `toMs`, `nowMs`); nothing in this
 * module reads the wall clock (`Date.now()` / `new Date()` with no argument) or
 * uses timers (`setTimeout` / `setInterval`). The {@link Clock} integration is
 * the caller's job — pass `clock.now()` in. This keeps the module deterministic
 * under test and side-effect-free, matching the Ephemeris invariant that
 * "deterministic timing belongs behind `Clock`".
 *
 * The DST-aware cron evaluator uses `Intl.DateTimeFormat` (with `timeZone`) to
 * map UTC instants to local wall-clock fields and back. `Intl` calls are pure
 * functions of their inputs — they do not read the host wall clock — so the
 * purity invariant holds.
 *
 * ## Triggers, never authors
 *
 * This module computes schedule math only. It does not fire anything, does not
 * persist anything, and does not call Flow. Durability (e.g. {@link RunRecord}
 * storage) is the consumer's responsibility, matching how Ephemeris keeps
 * {@link Store} separate from the scheduler.
 */

// ----------------------------------------------------------------------------
// Consts
// ----------------------------------------------------------------------------

/**
 * Cap on {@link missedCount} and {@link nextOccurrences} result sizes. A missed
 * count above 1000 is almost certainly a scheduling pathology (or a host that
 * was offline for years); callers should treat anything ≥ this as "many". The
 * cap also bounds the work in {@link missedCount} for pathologically small
 * `everyMs` intervals.
 */
const CAP = 1000;

/**
 * Wall-clock minutes scanned by the cron evaluator before giving up (~1 year).
 * A real cron expression with at least one match per year — the common case —
 * terminates in well under this; if it ever trips, the schedule has no fire
 * within a year and `nextOccurrence` returns `null`.
 */
const SEARCH_CAP = 366 * 24 * 60;

/**
 * Module-level cache of known IANA time zone names. `Intl.supportedValuesOf`
 * excludes `UTC` itself (it lists only the `Area/Locality` zones), so `UTC` is
 * added explicitly. The lookup set is computed once at module load.
 */
const KNOWN_TIMEZONES: ReadonlySet<string> = new Set<string>([
  "UTC",
  ...Intl.supportedValuesOf("timeZone"),
]);

// ----------------------------------------------------------------------------
// Schedule discriminated union
// ----------------------------------------------------------------------------

/**
 * A 5-field cron schedule: `minute hour day-of-month month day-of-week`.
 *
 * Field ranges and syntax follow the Vixie-cron convention:
 *  - `minute`        0–59
 *  - `hour`          0–23
 *  - `day-of-month`  1–31
 *  - `month`         1–12
 *  - `day-of-week`   0–7 (0 and 7 both mean Sunday)
 *
 * Each field accepts a list (`,`-separated) of: a single value, a range
 * (`a-b`), a step (an optional `/n` suffix on a value, range, or wildcard),
 * or the wildcard `*`.
 *
 * `timezone` is an optional IANA zone name (e.g. `"America/Denver"`). When
 * absent, the cron is evaluated in UTC. When present, the cron fires at the
 * given **local wall-clock** fields, which means the UTC offset shifts across
 * DST transitions while the local time stays constant — see the evaluator in
 * {@link nextOccurrence}.
 */
export interface CronSchedule {
  readonly kind: "cron";
  /** Five whitespace-separated cron fields. */
  readonly expr: string;
  /** Optional IANA timezone. Absent = UTC. */
  readonly timezone?: string;
}

/**
 * A one-shot schedule that fires once at a fixed epoch instant. After it fires
 * (i.e. once `lastRunMs >= timeMs`), {@link nextOccurrence} returns `null` and
 * the schedule is inert.
 *
 * `deleteAfterRun` is an advisory hint to the consumer that the job may be
 * removed after its single fire — Ephemeris itself never deletes anything; the
 * consumer owns the job record's lifecycle.
 */
export interface AtSchedule {
  readonly kind: "at";
  /** The epoch millisecond instant at which the one-shot fires. */
  readonly timeMs: number;
  /** Hint: the consumer may delete the job after it fires. */
  readonly deleteAfterRun?: boolean;
}

/**
 * A fixed-interval schedule that fires every `everyMs` milliseconds. The next
 * fire after `fromMs` is `fromMs + everyMs` — i.e. the schedule is anchored to
 * the job's own run history, not to the epoch, so drift across restarts is
 * impossible.
 */
export interface EverySchedule {
  readonly kind: "every";
  /** Fixed inter-fire interval in milliseconds. Must be strictly positive. */
  readonly everyMs: number;
}

/**
 * A recurring schedule. Discriminated by `kind`. See {@link CronSchedule},
 * {@link AtSchedule}, and {@link EverySchedule} for the per-kind contract.
 */
export type Schedule = CronSchedule | AtSchedule | EverySchedule;

// ----------------------------------------------------------------------------
// ScheduledJob (minimal evaluation input)
// ----------------------------------------------------------------------------

/**
 * The minimal input the schedule evaluator needs about a job. Ephemeris
 * computes; the *consumer* (Station / boo-TS / flow-agents) owns the full job
 * record — id, owner, payload, persistence, etc. This type intentionally carries
 * only what the pure functions below read.
 *
 *  - `schedule`     — when to fire.
 *  - `lastRunMs`    — epoch ms of the most recent successful fire, or `undefined`
 *                     if the job has never run. Used as the catch-up origin for
 *                     recurring schedules.
 *  - `createdMs`    — epoch ms the job was created. Used as the catch-up origin
 *                     when `lastRunMs` is absent (i.e. a never-run recurring job
 *                     becomes overdue once its first interval elapses).
 *  - `enabled`      — defaults to `true`; `false` makes the job inert
 *                     ({@link isOverdue} returns `false`).
 */
export interface ScheduledJob {
  readonly schedule: Schedule;
  readonly lastRunMs?: number;
  readonly createdMs: number;
  readonly enabled?: boolean;
}

// ----------------------------------------------------------------------------
// RunRecord (durable per-fire record; type only)
// ----------------------------------------------------------------------------

/**
 * Durable per-fire record. A type only — Ephemeris does not store these. The
 * consumer persists them as it sees fit (matching how {@link Store} is kept
 * separate from the deadline engine). The fields capture what a host needs to
 * reconstruct "this job fired at <real instant> for <scheduled instant>, was
 * catching up N missed occurrences, took D milliseconds, and <succeeded|failed>".
 */
export interface RunRecord {
  /** Epoch ms the fire actually happened. */
  readonly firedAtMs: number;
  /** Epoch ms the fire was scheduled for (may differ under catch-up). */
  readonly scheduledForMs: number;
  /** Occurrences skipped in `(lastFireMs, currentFireMs)` — see {@link missedCount}. */
  readonly missedCount: number;
  /** Wall-clock duration of the run in ms, if recorded. */
  readonly durationMs?: number;
  /** Outcome of the run, if recorded. */
  readonly success?: boolean;
  /** Opaque reference (URI, key, etc.) to any output artifact the run produced. */
  readonly outputRef?: string;
}

// ----------------------------------------------------------------------------
// Cron parsing
// ----------------------------------------------------------------------------

/**
 * A parsed cron field: the set of allowed values plus a flag marking whether
 * the field was literally `*` (the wildcard). The wildcard flag matters only
 * for the Vixie-cron day-matching rule (see {@link dayMatches}): when DOM and
 * DOW are both restricted, a day matches if EITHER matches; if one is the
 * wildcard, only the other matters. A step expression (e.g. `0-30/15`) is NOT a
 * wildcard for this rule — only literal `*` is.
 */
interface CronField {
  readonly allowed: ReadonlySet<number>;
  readonly wildcard: boolean;
}

/** Parsed 5-field cron expression. */
interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dom: CronField;
  readonly month: CronField;
  readonly dow: CronField;
}

/**
 * Parse a cron field token as a strict non-negative decimal integer. Rejects
 * anything `Number()` would coerce but Vixie cron does not accept (hex
 * `0x10`, scientific `1e1`, surrounding whitespace). A separate range/range-step
 * check enforces `min`/`max` and ordering on the result.
 */
function parseStrictInt(token: string, spec: string): number {
  if (!/^\d+$/.test(token)) {
    throw new Error(
      `cron value "${token}" in "${spec}" is not a decimal integer`,
    );
  }
  return Number(token);
}

/**
 * Parse one cron field into a {@link CronField}. Throws on malformed syntax or
 * out-of-range values. `min`/`max` are inclusive.
 */
function parseField(spec: string, min: number, max: number): CronField {
  const trimmed = spec.trim();
  if (trimmed === "*") {
    const all = new Set<number>();
    for (let v = min; v <= max; v++) all.add(v);
    return { allowed: all, wildcard: true };
  }
  const allowed = new Set<number>();
  for (const part of trimmed.split(",")) {
    if (part.length === 0) {
      throw new Error(`cron field "${spec}" has an empty list entry`);
    }
    // Split off an optional step.
    let stepText: string | null = null;
    let rangeText = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      stepText = part.slice(slash + 1);
      rangeText = part.slice(0, slash);
    }
    let lo: number;
    let hi: number;
    if (rangeText === "*") {
      lo = min;
      hi = max;
    } else if (rangeText.includes("-")) {
      const dash = rangeText.indexOf("-");
      const a = rangeText.slice(0, dash);
      const b = rangeText.slice(dash + 1);
      lo = parseStrictInt(a, spec);
      hi = parseStrictInt(b, spec);
    } else {
      lo = parseStrictInt(rangeText, spec);
      hi = lo;
    }
    const step = stepText === null ? 1 : parseStrictInt(stepText, spec);
    if (step <= 0) {
      throw new Error(`cron step "${stepText}" in "${spec}" must be a positive integer`);
    }
    if (lo < min || lo > max || hi < min || hi > max) {
      throw new Error(
        `cron value in "${spec}" out of range [${min}, ${max}]`,
      );
    }
    if (hi < lo) {
      throw new Error(`cron range "${rangeText}" in "${spec}" has hi < lo`);
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return { allowed, wildcard: false };
}

/**
 * Parse a 5-field cron expression string into a {@link ParsedCron}. Throws on
 * wrong field count, malformed fields, or out-of-range values.
 *
 * Day-of-week values 0 and 7 both mean Sunday; the parsed set normalizes 7 → 0
 * so the matcher only ever sees 0.
 */
function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have exactly 5 fields, got ${fields.length}: "${expr}"`,
    );
  }
  const [m, h, dom, mon, dow] = fields;
  const dowField = parseField(dow, 0, 7);
  // Normalize Sunday: if 7 is present, also include 0 (and drop 7 to keep the
  // set tidy for the matcher).
  if (dowField.allowed.has(7)) {
    const next = new Set(dowField.allowed);
    next.delete(7);
    next.add(0);
    return {
      minute: parseField(m, 0, 59),
      hour: parseField(h, 0, 23),
      dom: parseField(dom, 1, 31),
      month: parseField(mon, 1, 12),
      dow: { allowed: next, wildcard: dowField.wildcard },
    };
  }
  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dow: dowField,
  };
}

// ----------------------------------------------------------------------------
// Timezone wall-clock helpers (Intl-based; pure)
// ----------------------------------------------------------------------------

/** Module-level cache of Intl.DateTimeFormat formatters per timezone. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Get (or create and cache) a wall-clock formatter for `timeZone`. The
 * formatter yields 24-hour year/month/day/hour/minute parts in that zone.
 * Formatters are pure: same input instant → same output parts.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of a UTC instant `msUtc` as they appear in `timeZone`. */
interface WallParts {
  readonly year: number;
  /** Month index 0–11 (matches `Date`'s month convention). */
  readonly month0: number;
  /** Day of month 1–31. */
  readonly day: number;
  /** Hour 0–23. */
  readonly hour: number;
  /** Minute 0–59. */
  readonly minute: number;
  /** Day of week 0–6, where 0 = Sunday (derived from the wall date). */
  readonly weekday: number;
}

/**
 * Project a UTC epoch-millisecond instant into the wall-clock fields of
 * `timeZone` using `Intl.DateTimeFormat`. The weekday is derived from the
 * wall-clock year/month/day (a deterministic function of those, independent of
 * timezone).
 *
 * Pure: the only inputs are `msUtc` and `timeZone`; no wall-clock read.
 */
function wallParts(msUtc: number, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(msUtc));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    switch (p.type) {
      case "year":
        year = Number(p.value);
        break;
      case "month":
        month = Number(p.value);
        break;
      case "day":
        day = Number(p.value);
        break;
      case "hour":
        hour = Number(p.value);
        break;
      case "minute":
        minute = Number(p.value);
        break;
    }
  }
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month0: month - 1, day, hour, minute, weekday };
}

/**
 * Convert a target wall-clock `(year, month0, day, hour, minute)` in `timeZone`
 * to the unique UTC epoch-millisecond instant that projects back to those
 * fields.
 *
 * Method: fixed-point iteration on the timezone offset. The relationship is
 * `Date.UTC(wallParts(t, tz)) == t + offset(t)`, so we want
 * `t = T_target - offset(t)` where `T_target = Date.UTC(target fields)`.
 * Iterating `t_{n+1} = T_target - offset(t_n)` converges in 1–2 steps away from
 * DST transitions.
 *
 * **DST limitation (documented):** at the exact instants of a DST transition
 * the offset is discontinuous and the iteration may settle on either of two
 * adjacent instants. Two specific sub-cases:
 *   - **Spring-forward gap:** a wall-clock that does not exist (e.g. 02:30 on a
 *     "spring forward at 02:00 → 03:00" day) has no UTC instant; this function
 *     returns the nearest real instant, whose wall parts will NOT reproduce the
 *     target. Callers that need a true match must round-trip verify via
 *     `wallParts(result, timeZone)` and reject on mismatch — `nextCronOccurrence`
 *     does this so cron evaluation never fires at a non-matching local time.
 *   - **Fall-back fold:** a wall-clock that occurs twice (e.g. 01:30 on a
 *     "fall back at 03:00 → 02:00" day) maps to two UTC instants; this function
 *     returns one of them (the first to converge). Both project back to the same
 *     wall parts, so a round-trip check passes and the schedule fires exactly
 *     once per wall-clock occurrence.
 *
 * These edge cases affect only the two DST transition instants per year; the
 * common case (a cron firing daily or hourly at some local time) is exact, as
 * covered by the DST spring-forward test in `tests/node/schedule.test.mjs`.
 */
function wallToUtcMs(
  year: number,
  month0: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const targetUtc = Date.UTC(year, month0, day, hour, minute);
  let t = targetUtc;
  // Iterate the fixed-point; cap at 6 steps. In practice converges in ≤2 steps
  // away from a DST transition. We do not assert the wall parts equal the
  // target — see the documented DST limitation above.
  for (let i = 0; i < 6; i++) {
    const p = wallParts(t, timeZone);
    const offsetAtT =
      Date.UTC(p.year, p.month0, p.day, p.hour, p.minute) - t;
    const next = targetUtc - offsetAtT;
    if (next === t) return t;
    t = next;
  }
  return t;
}

// ----------------------------------------------------------------------------
// Cron matching
// ----------------------------------------------------------------------------

/**
 * Vixie-cron day-of-month / day-of-week match. Per the original cron spec:
 *  - If both fields are wildcards, any day matches.
 *  - If neither is a wildcard, a day matches when EITHER the DOM or the DOW
 *    matches (logical OR).
 *  - If exactly one is a wildcard, only the other field constrains the match.
 */
function dayMatches(
  cron: ParsedCron,
  dayOfMonth: number,
  weekday: number,
): boolean {
  const domStar = cron.dom.wildcard;
  const dowStar = cron.dow.wildcard;
  if (domStar && dowStar) return true;
  const domHit = cron.dom.allowed.has(dayOfMonth);
  const dowHit = cron.dow.allowed.has(weekday);
  if (!domStar && !dowStar) return domHit || dowHit;
  if (domStar) return dowHit;
  return domHit;
}

/**
 * The next UTC epoch-millisecond instant strictly after `fromMs` at which the
 * (parsed) cron schedule fires in `timeZone`. Returns `null` if no match is
 * found within {@link SEARCH_CAP} wall-clock minutes (~1 year).
 *
 * Algorithm: walk the wall-clock forward one field at a time, skipping at the
 * largest granularity that fails to match (month → day → hour → minute). The
 * walk is anchored to `timeZone`'s wall-clock, so the local fire time is
 * constant across DST — only the UTC offset shifts.
 */
function nextCronOccurrence(
  cron: ParsedCron,
  timeZone: string,
  fromMs: number,
): number | null {
  // Start from the wall-clock of (fromMs + 1ms), then walk forward. Using +1ms
  // means a fire at exactly `fromMs` is NOT returned (the contract is strict).
  const start = wallParts(fromMs + 1, timeZone);
  const wall = new Date(
    Date.UTC(start.year, start.month0, start.day, start.hour, start.minute, 0, 0),
  );
  for (let i = 0; i < SEARCH_CAP; i++) {
    const year = wall.getUTCFullYear();
    const month0 = wall.getUTCMonth();
    const day = wall.getUTCDate();
    const hour = wall.getUTCHours();
    const minute = wall.getUTCMinutes();
    const weekday = wall.getUTCDay();

    if (!cron.month.allowed.has(month0 + 1)) {
      // Advance to the first day of the next month at 00:00.
      wall.setUTCMonth(month0 + 1, 1);
      wall.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, day, weekday)) {
      // Advance to the next day at 00:00.
      wall.setUTCDate(day + 1);
      wall.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hour.allowed.has(hour)) {
      // Advance to the next hour at :00.
      wall.setUTCHours(hour + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minute.allowed.has(minute)) {
      // Advance by one minute (carries into the hour on overflow).
      wall.setUTCMinutes(minute + 1, 0, 0);
      continue;
    }

    // All fields match: convert this wall-clock instant back to UTC. Two
    // checks must pass before we accept it as a true fire:
    //   1. Strict-after contract (utc > fromMs): a same-minute match just after
    //      `fromMs` could otherwise let a stale instant slip through.
    //   2. Wall-parts round trip: in a spring-forward gap the target wall time
    //      does not exist, so wallToUtcMs returns the *nearest* real instant —
    //      whose wall parts differ from the target. Reject it so we never fire
    //      at a non-matching local time. Fold times (fall-back) project both
    //      instants to the same wall parts, so this check passes and the
    //      schedule still fires exactly once per wall-clock occurrence.
    const utc = wallToUtcMs(year, month0, day, hour, minute, timeZone);
    const rt = wallParts(utc, timeZone);
    if (
      utc > fromMs &&
      rt.year === year &&
      rt.month0 === month0 &&
      rt.day === day &&
      rt.hour === hour &&
      rt.minute === minute
    ) {
      return utc;
    }
    // Stale instant or non-existent gap time: advance one wall-clock minute and
    // re-search. The gap is bounded (one local hour per year per zone), so the
    // walk terminates and normal matching resumes once past it.
    wall.setUTCMinutes(minute + 1, 0, 0);
  }
  return null;
}

// ----------------------------------------------------------------------------
// validateSchedule
// ----------------------------------------------------------------------------

/**
 * Validate a {@link Schedule}. Returns an error string describing the first
 * problem found, or `null` if the schedule is well-formed.
 *
 * This is a *static* check — it does not guarantee the schedule will ever fire,
 * only that its fields are syntactically and range-valid. Specifically:
 *  - `cron`: must be exactly 5 fields, each parseable and in range; if
 *    `timezone` is given it must be a known IANA zone (or `UTC`).
 *  - `every`: `everyMs` must be a finite, strictly positive number.
 *  - `at`:   `timeMs` must be a finite number.
 */
export function validateSchedule(schedule: Schedule): string | null {
  switch (schedule.kind) {
    case "cron": {
      if (schedule.timezone !== undefined) {
        if (!KNOWN_TIMEZONES.has(schedule.timezone)) {
          return `unknown timezone "${schedule.timezone}"`;
        }
      }
      try {
        parseCron(schedule.expr);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      return null;
    }
    case "every": {
      if (
        !Number.isFinite(schedule.everyMs) ||
        schedule.everyMs <= 0
      ) {
        return `everyMs must be a finite positive number (got ${schedule.everyMs})`;
      }
      return null;
    }
    case "at": {
      if (!Number.isFinite(schedule.timeMs)) {
        return `timeMs must be a finite number (got ${schedule.timeMs})`;
      }
      return null;
    }
  }
}

// ----------------------------------------------------------------------------
// nextOccurrence
// ----------------------------------------------------------------------------

/**
 * The next UTC epoch-millisecond instant at which `schedule` fires, strictly
 * after `fromMs`. Returns `null` when no future fire exists (e.g. an `at`
 * schedule whose instant is at or before `fromMs`, or a cron with no match
 * within the ~1-year search horizon).
 *
 * Per-kind semantics:
 *  - `cron`: see {@link nextCronOccurrence}. DST-aware when `timezone` is set.
 *  - `at`:   returns `timeMs` iff `timeMs > fromMs`, else `null`.
 *  - `every`: returns `fromMs + everyMs` (the next interval anchored to the
 *    last fire — see {@link EverySchedule}).
 *
 * Pure: takes `fromMs` as a parameter; never reads the wall clock.
 */
export function nextOccurrence(
  schedule: Schedule,
  fromMs: number,
): number | null {
  switch (schedule.kind) {
    case "cron": {
      const cron = parseCron(schedule.expr);
      const tz = schedule.timezone ?? "UTC";
      return nextCronOccurrence(cron, tz, fromMs);
    }
    case "at": {
      return schedule.timeMs > fromMs ? schedule.timeMs : null;
    }
    case "every": {
      return fromMs + schedule.everyMs;
    }
  }
}

// ----------------------------------------------------------------------------
// isOverdue
// ----------------------------------------------------------------------------

/**
 * Whether `job` should fire at `nowMs`. A job is overdue when an occurrence
 * that should have fired (strictly) between the catch-up origin and `nowMs` has
 * not been recorded as run.
 *
 * The catch-up origin is:
 *  - for `at`: irrelevant — an `at` job is overdue iff it has not yet run and
 *    `timeMs <= nowMs` (matches the boo semantics where a one-shot whose time
 *    passed while the host was down fires on next boot).
 *  - for `cron` / `every`: `lastRunMs` if present, else `createdMs`. A
 *    never-run recurring job becomes overdue once its first interval elapses.
 *
 * `enabled: false` makes any job report not-overdue.
 *
 * Pure: takes `nowMs` as a parameter; never reads the wall clock.
 */
export function isOverdue(job: ScheduledJob, nowMs: number): boolean {
  if (job.enabled === false) return false;
  const s = job.schedule;
  if (s.kind === "at") {
    if (job.lastRunMs !== undefined) return false;
    return s.timeMs <= nowMs;
  }
  const origin = job.lastRunMs ?? job.createdMs;
  const next = nextOccurrence(s, origin);
  return next !== null && next <= nowMs;
}

// ----------------------------------------------------------------------------
// missedCount
// ----------------------------------------------------------------------------

/**
 * Count occurrences of `schedule` strictly inside the open interval
 * `(fromMs, toMs)` — i.e. fires that were *skipped* between the last run
 * (`fromMs`) and the current fire (`toMs`). The current fire itself is NOT
 * counted (on-time → 0); only the strictly-intervening ones are.
 *
 * The result is capped at {@link CAP} (1000). For `every`, the count is a
 * closed-form `ceil((toMs - fromMs) / everyMs) - 1` and then capped; for `cron`
 * it iterates {@link nextOccurrence} up to {@link CAP} times.
 *
 * Returns 0 when `toMs <= fromMs`.
 *
 * Pure: takes both endpoints as parameters; never reads the wall clock.
 */
export function missedCount(
  schedule: Schedule,
  fromMs: number,
  toMs: number,
): number {
  if (toMs <= fromMs) return 0;
  switch (schedule.kind) {
    case "every": {
      const raw =
        Math.ceil((toMs - fromMs) / schedule.everyMs) - 1;
      if (raw <= 0) return 0;
      return Math.min(CAP, raw);
    }
    case "at": {
      // Single occurrence at timeMs; counted iff strictly inside the window.
      return fromMs < schedule.timeMs && schedule.timeMs < toMs ? 1 : 0;
    }
    case "cron": {
      let count = 0;
      let t = fromMs;
      while (count < CAP) {
        const nxt = nextOccurrence(schedule, t);
        if (nxt === null || nxt >= toMs) break;
        count++;
        t = nxt;
      }
      return count;
    }
  }
}

// ----------------------------------------------------------------------------
// nextOccurrences (preview)
// ----------------------------------------------------------------------------

/**
 * The next `count` fire times of `schedule` strictly after `fromMs`, bounded by
 * {@link CAP}. For preview / UX use (e.g. showing the next N planned fires).
 * Stops early if the schedule has no further fires (e.g. a spent `at` job).
 *
 * Pure: takes `fromMs` as a parameter; never reads the wall clock.
 */
export function nextOccurrences(
  schedule: Schedule,
  count: number,
  fromMs: number,
): number[] {
  const n = Math.max(0, Math.min(CAP, Math.floor(count)));
  const out: number[] = [];
  let t = fromMs;
  for (let i = 0; i < n; i++) {
    const nxt = nextOccurrence(schedule, t);
    if (nxt === null) break;
    out.push(nxt);
    t = nxt;
  }
  return out;
}
