import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ArmedDeadline } from "./types.js";
import { deadlineKey } from "./types.js";

/**
 * Durable persistence for the scheduler's two sets:
 *  - `pending`: armed deadlines not yet fired (must survive restart so deadlines
 *    are not lost).
 *  - `fired`:   keys of deadlines already fired (must survive restart so a
 *    reload or duplicate arm does NOT double-fire).
 *
 * The Store is the durability + idempotency substrate. Implementations must be
 * synchronous-consistent for v0 (small data, single daemon).
 */
export interface Store {
  /** All currently-armed (not-yet-fired) deadlines. */
  pending(): ArmedDeadline[];
  /** True if the given dedup key is currently pending (armed, not yet fired). */
  has(key: string): boolean;
  /** True if the given dedup key has already fired. */
  hasFired(key: string): boolean;
  /** Persist an armed deadline. Idempotent on key. */
  addPending(deadline: ArmedDeadline): void;
  /** Remove a pending deadline by key (e.g. on cancel, supersede, or firing). */
  removePending(key: string): void;
  /** Remove all pending deadlines for a bundle (cancel). Returns removed keys. */
  removePendingForBundle(bundleSource: string): string[];
  /** Mark a key as fired (and drop it from pending). Idempotent. */
  markFired(key: string): void;
}

/** In-memory store for tests and ephemeral use. */
export class InMemoryStore implements Store {
  readonly #pending = new Map<string, ArmedDeadline>();
  readonly #fired = new Set<string>();

  pending(): ArmedDeadline[] {
    return [...this.#pending.values()];
  }

  has(key: string): boolean {
    return this.#pending.has(key);
  }

  hasFired(key: string): boolean {
    return this.#fired.has(key);
  }

  addPending(deadline: ArmedDeadline): void {
    const key = deadlineKey(deadline);
    if (this.#fired.has(key)) return; // never re-arm an already-fired deadline
    this.#pending.set(key, deadline);
  }

  removePending(key: string): void {
    this.#pending.delete(key);
  }

  removePendingForBundle(bundleSource: string): string[] {
    const removed: string[] = [];
    for (const [key, d] of this.#pending) {
      if (d.bundleSource === bundleSource) {
        this.#pending.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  markFired(key: string): void {
    this.#pending.delete(key);
    this.#fired.add(key);
  }
}

interface PersistShape {
  version: 1;
  pending: ArmedDeadline[];
  fired: string[];
}

/**
 * Durable JSON-file store. Persists `pending` + `fired` to disk on every
 * mutation, and reloads them on construction so deadlines and fired-history
 * survive a restart.
 *
 * This is the SIMPLE default: every mutation rewrites the whole file. That is
 * fine for a small single daemon — the write cost is O(state) per mutation. When
 * the watched-bundle count grows so that per-mutation full rewrites hurt, use
 * {@link AppendLogStore} instead, which appends one record per mutation and only
 * rewrites at compaction. (Durability-at-scale, the `TODO(durability)` of v0.2,
 * is closed by `AppendLogStore`; this store stays as the no-config default.)
 */
export class JsonFileStore implements Store {
  readonly #path: string;
  readonly #pendingMap = new Map<string, ArmedDeadline>();
  readonly #fired = new Set<string>();

  constructor(path: string) {
    this.#path = path;
    this.#load();
  }

  pending(): ArmedDeadline[] {
    return [...this.#pendingMap.values()];
  }

  has(key: string): boolean {
    return this.#pendingMap.has(key);
  }

  hasFired(key: string): boolean {
    return this.#fired.has(key);
  }

  addPending(deadline: ArmedDeadline): void {
    const key = deadlineKey(deadline);
    if (this.#fired.has(key)) return; // never re-arm an already-fired deadline
    this.#pendingMap.set(key, deadline);
    this.#flush();
  }

  removePending(key: string): void {
    if (this.#pendingMap.delete(key)) this.#flush();
  }

  removePendingForBundle(bundleSource: string): string[] {
    const removed: string[] = [];
    for (const [key, d] of this.#pendingMap) {
      if (d.bundleSource === bundleSource) {
        this.#pendingMap.delete(key);
        removed.push(key);
      }
    }
    if (removed.length > 0) this.#flush();
    return removed;
  }

  markFired(key: string): void {
    this.#pendingMap.delete(key);
    this.#fired.add(key);
    this.#flush();
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    const raw = readFileSync(this.#path, "utf8").trim();
    if (raw === "") return;
    const data = JSON.parse(raw) as PersistShape;
    for (const key of data.fired ?? []) this.#fired.add(key);
    for (const d of data.pending ?? []) {
      const key = deadlineKey(d);
      if (!this.#fired.has(key)) this.#pendingMap.set(key, d);
    }
  }

  #flush(): void {
    const data: PersistShape = {
      version: 1,
      pending: [...this.#pendingMap.values()],
      fired: [...this.#fired],
    };
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(data, null, 2), "utf8");
  }
}

/**
 * One line of an {@link AppendLogStore}'s log. A line-delimited JSON record; the
 * `op` discriminates. State is reconstructed by replaying these in order.
 */
type LogRecord =
  /** Full state. Written as the FIRST line of a freshly-compacted log; on
   *  replay it RESETS state, so only records after the last snapshot matter. */
  | { readonly op: "snapshot"; readonly pending: readonly ArmedDeadline[]; readonly fired: readonly string[] }
  /** A deadline was armed (added to pending). */
  | { readonly op: "arm"; readonly deadline: ArmedDeadline }
  /** A deadline fired: dropped from pending, recorded in fired forever. */
  | { readonly op: "fire"; readonly key: string }
  /** A pending deadline was removed without firing (cancel / supersede). */
  | { readonly op: "remove"; readonly key: string };

/**
 * Durability-at-scale store: an APPEND LOG. Instead of rewriting the whole file
 * per mutation (as {@link JsonFileStore} does), it appends ONE small record per
 * mutation (arm / fire / remove) and reconstructs state by replaying the log on
 * load. When the log grows past a threshold it COMPACTS: it rewrites the file as
 * a single fresh snapshot and starts appending again, which bounds the log size.
 *
 * This closes v0.2's `TODO(durability)`: per-mutation cost is O(1) append (not
 * O(state) rewrite), so the watched-bundle count can grow without each mutation
 * rewriting the world, while compaction keeps the file from growing unbounded.
 *
 * Crash-safety: the log is the source of truth. A reload replays it to the exact
 * same state, so:
 *  - pending deadlines survive a restart (replayed and re-armed), and
 *  - fired history survives (every `fire` record replays), so a reload or a
 *    re-armed bundle never double-fires.
 * A torn final line (a crash mid-append) is tolerated: replay skips any
 * unparseable line, losing at most the last in-flight mutation — which the
 * scheduler re-derives on the next arm anyway (over-firing/re-arming is harmless).
 *
 * The on-disk format and the {@link Store} contract are otherwise identical to
 * `JsonFileStore`, so it is a drop-in: pass it as `store` to the scheduler.
 */
export class AppendLogStore implements Store {
  readonly #path: string;
  readonly #pendingMap = new Map<string, ArmedDeadline>();
  readonly #fired = new Set<string>();
  /** Records appended since the last snapshot. Drives compaction. */
  #recordsSinceCompaction = 0;
  /** Compact once this many records have been appended since the last snapshot. */
  readonly #compactThreshold: number;

  /**
   * @param path Log file path.
   * @param options.compactThreshold Append this many records since the last
   *   snapshot before compacting (rewrite a snapshot + truncate). Default 1000.
   *   A smaller value compacts more eagerly (smaller log, more rewrites).
   */
  constructor(path: string, options: { compactThreshold?: number } = {}) {
    this.#path = path;
    this.#compactThreshold = Math.max(1, options.compactThreshold ?? 1000);
    this.#load();
  }

  pending(): ArmedDeadline[] {
    return [...this.#pendingMap.values()];
  }

  has(key: string): boolean {
    return this.#pendingMap.has(key);
  }

  hasFired(key: string): boolean {
    return this.#fired.has(key);
  }

  addPending(deadline: ArmedDeadline): void {
    const key = deadlineKey(deadline);
    if (this.#fired.has(key)) return; // never re-arm an already-fired deadline
    if (this.#pendingMap.has(key)) return; // already pending — no new record
    this.#pendingMap.set(key, deadline);
    this.#append({ op: "arm", deadline });
  }

  removePending(key: string): void {
    if (this.#pendingMap.delete(key)) this.#append({ op: "remove", key });
  }

  removePendingForBundle(bundleSource: string): string[] {
    const removed: string[] = [];
    for (const [key, d] of this.#pendingMap) {
      if (d.bundleSource === bundleSource) {
        this.#pendingMap.delete(key);
        removed.push(key);
      }
    }
    for (const key of removed) this.#append({ op: "remove", key });
    return removed;
  }

  markFired(key: string): void {
    const wasPending = this.#pendingMap.delete(key);
    const wasFired = this.#fired.has(key);
    this.#fired.add(key);
    // Append a fire record unless this is a pure no-op (already fired AND not
    // pending) — that keeps a flood of duplicate mark-fired calls from bloating
    // the log without changing state.
    if (wasPending || !wasFired) this.#append({ op: "fire", key });
  }

  /** Current number of records in the log since the last snapshot (for tests). */
  logLength(): number {
    return this.#recordsSinceCompaction;
  }

  /** Force a compaction now (rewrite a fresh snapshot + truncate). */
  compact(): void {
    this.#writeSnapshot();
  }

  #append(record: LogRecord): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    appendFileSync(this.#path, JSON.stringify(record) + "\n", "utf8");
    this.#recordsSinceCompaction += 1;
    if (this.#recordsSinceCompaction >= this.#compactThreshold) {
      this.#writeSnapshot();
    }
  }

  /**
   * Rewrite the log as a single snapshot line capturing current state, then
   * reset the since-compaction counter. This is the ONE place that rewrites the
   * whole file; everything else appends. Bounds the log and preserves state.
   */
  #writeSnapshot(): void {
    const snapshot: LogRecord = {
      op: "snapshot",
      pending: [...this.#pendingMap.values()],
      fired: [...this.#fired],
    };
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(snapshot) + "\n", "utf8");
    this.#recordsSinceCompaction = 0;
  }

  /**
   * Replay the log to reconstruct state. A `snapshot` line RESETS state (so only
   * the suffix after the last snapshot is replayed against it). A torn/partial
   * final line (crash mid-append) is skipped rather than fatal.
   */
  #load(): void {
    if (!existsSync(this.#path)) return;
    const raw = readFileSync(this.#path, "utf8");
    if (raw.trim() === "") return;
    const lines = raw.split("\n");
    for (const line of lines) {
      if (line.trim() === "") continue;
      let record: LogRecord;
      try {
        record = JSON.parse(line) as LogRecord;
      } catch {
        // Torn final line from a crash mid-append: skip it. The lost mutation is
        // re-derived on the next arm (over-firing/re-arming is harmless).
        continue;
      }
      this.#apply(record);
    }
    // `#apply` keeps `#recordsSinceCompaction` accurate during replay: a
    // `snapshot` resets it to 0 and every subsequent applied record increments
    // it, so after replay it already holds "records appended since the last
    // snapshot" — the next mutation compacts on schedule.
  }

  /** Apply one replayed record to in-memory state, mirroring the live mutators. */
  #apply(record: LogRecord): void {
    switch (record.op) {
      case "snapshot": {
        this.#pendingMap.clear();
        this.#fired.clear();
        for (const key of record.fired) this.#fired.add(key);
        for (const d of record.pending) {
          const key = deadlineKey(d);
          if (!this.#fired.has(key)) this.#pendingMap.set(key, d);
        }
        // A snapshot is the new baseline: records appended after it are what
        // count toward the next compaction.
        this.#recordsSinceCompaction = 0;
        return; // do NOT count the snapshot line itself toward compaction
      }
      case "arm": {
        const key = deadlineKey(record.deadline);
        if (!this.#fired.has(key)) this.#pendingMap.set(key, record.deadline);
        break;
      }
      case "fire": {
        this.#pendingMap.delete(record.key);
        this.#fired.add(record.key);
        break;
      }
      case "remove": {
        this.#pendingMap.delete(record.key);
        break;
      }
    }
    this.#recordsSinceCompaction += 1;
  }
}
