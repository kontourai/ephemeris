import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
  /** True if the given dedup key has already fired. */
  hasFired(key: string): boolean;
  /** Persist an armed deadline. Idempotent on key. */
  addPending(deadline: ArmedDeadline): void;
  /** Remove a pending deadline by key (e.g. on cancel or after firing). */
  removePending(key: string): void;
  /** Remove all pending deadlines for a bundle (cancel). Returns removed keys. */
  removePendingForBundle(bundleId: string): string[];
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

  removePendingForBundle(bundleId: string): string[] {
    const removed: string[] = [];
    for (const [key, d] of this.#pending) {
      if (d.bundleId === bundleId) {
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
 * TODO(durability): v0 rewrites the whole file per mutation (fine for small
 * sets, single daemon). Swap for an append log / embedded KV when the watched
 * bundle count grows. See README "Open / TODO".
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

  removePendingForBundle(bundleId: string): string[] {
    const removed: string[] = [];
    for (const [key, d] of this.#pendingMap) {
      if (d.bundleId === bundleId) {
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
