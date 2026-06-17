/**
 * Injectable clock. ALL timing in Ephemeris flows through this interface so the
 * scheduler is deterministic under test — `ManualClock` drives time forward with
 * `advance()` and there are never any real wall-clock waits.
 */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

/** Default production clock backed by `Date.now()`. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Deterministic test clock. Time only moves when `advance()` (or `set()`) is
 * called. Callbacks registered via `onAdvance` are invoked synchronously after
 * each move, which is how the scheduler learns "time passed, re-check
 * deadlines" without timers.
 */
export class ManualClock implements Clock {
  #current: number;
  readonly #listeners = new Set<(now: number) => void>();

  constructor(start = 0) {
    this.#current = start;
  }

  now(): number {
    return this.#current;
  }

  /** Move time forward by `ms` and notify listeners. */
  advance(ms: number): void {
    if (ms < 0) throw new Error("ManualClock.advance: ms must be >= 0");
    this.#current += ms;
    this.#emit();
  }

  /** Set absolute time (must not go backwards) and notify listeners. */
  set(ms: number): void {
    if (ms < this.#current) {
      throw new Error("ManualClock.set: time must not move backwards");
    }
    this.#current = ms;
    this.#emit();
  }

  /** Register a listener invoked after each time move. Returns an unsubscribe fn. */
  onAdvance(listener: (now: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#current);
  }
}
