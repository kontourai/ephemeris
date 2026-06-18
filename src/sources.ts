import { readdirSync, readFileSync, watch } from "node:fs";
import { join, extname } from "node:path";
import type { ArmedDeadline, TrustBundleReadModel } from "./types.js";

/**
 * The slice of the scheduler a `Source` drives: arm a bundle's deadlines, cancel
 * a bundle's pending deadlines. Sources depend on this narrow surface (not the
 * whole `EphemerisScheduler`) so they stay decoupled and trivially testable —
 * `EphemerisScheduler` satisfies it structurally.
 *
 * A Source is *anything* that feeds bundles to `arm()` and signals removals via
 * `cancel()`. Discovery is therefore open-ended: `DirectoryWatcherSource`,
 * `RegistrySource`, and the programmatic `arm()` API are all just Sources, and
 * any mix of them can run against one scheduler at once.
 */
export interface SchedulerSink {
  arm(bundle: TrustBundleReadModel): ArmedDeadline[];
  cancel(bundleSource: string): void;
}

/**
 * Source adapter: watches a directory of emitted bundle JSON files and arms each
 * one. This is the "discovery" seam — the programmatic `scheduler.arm(bundle)`
 * API is the other.
 *
 * Discovery, v0.3: Ephemeris now ships TWO source shapes — this filesystem
 * `DirectoryWatcherSource` and the event-driven {@link RegistrySource} (an
 * in-process producer registry). Both feed the same `scheduler.arm()` /
 * `scheduler.cancel()` surface and compose freely (run any mix at once). What
 * remains deferred is only the SHARED hosted-ingest seam Ephemeris co-owns with
 * Flow's `HostedConsoleSink` — the cross-process transport — not in-process
 * discovery. See README "v0.3".
 */
export class DirectoryWatcherSource {
  readonly #dir: string;
  readonly #scheduler: SchedulerSink;
  readonly #seen = new Set<string>();
  #watcher: ReturnType<typeof watch> | undefined;

  /**
   * @param scheduler Any {@link SchedulerSink} (the `EphemerisScheduler`
   *   satisfies it structurally). Typed as the narrow sink — not the whole
   *   scheduler — so the watcher stays decoupled.
   */
  constructor(dir: string, scheduler: SchedulerSink) {
    this.#dir = dir;
    this.#scheduler = scheduler;
  }

  /** Arm every bundle file currently in the directory. */
  scanOnce(): void {
    for (const name of readdirSync(this.#dir)) {
      if (extname(name) !== ".json") continue;
      this.#ingest(join(this.#dir, name));
    }
  }

  /** Begin watching the directory for new/changed bundle files. */
  start(): void {
    this.scanOnce();
    this.#watcher = watch(this.#dir, (_event, filename) => {
      if (!filename || extname(filename) !== ".json") return;
      this.#ingest(join(this.#dir, filename));
    });
  }

  /** Stop watching. */
  stop(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  #ingest(path: string): void {
    let bundle: TrustBundleReadModel;
    try {
      const raw = readFileSync(path, "utf8");
      bundle = JSON.parse(raw) as TrustBundleReadModel;
    } catch {
      // Partial write / non-bundle file — ignore; the watcher will re-fire.
      return;
    }
    // A Hachure bundle is identified by `source` (it has no top-level `id`).
    if (
      !bundle ||
      typeof bundle.source !== "string" ||
      !Array.isArray(bundle.claims)
    ) {
      return;
    }
    // arm() is itself idempotent + flap-coalescing; #seen just avoids redundant
    // work on re-scan.
    this.#seen.add(bundle.source);
    this.#scheduler.arm(bundle);
  }
}

/**
 * Event-driven, in-process discovery source: a registry that producers push
 * bundles into, so the scheduler learns about them WITHOUT polling, a watched
 * directory, or any clock coupling.
 *
 * Why a registry over a poller: discovery here is in-process — a producer (Flow,
 * a test harness, another daemon thread) already HAS the emitted bundle in hand
 * and can hand it over directly. A registry models that "producer notify" path
 * exactly: `register(bundle)` arms immediately, `deregister(source)` cancels
 * immediately. There is no interval, so there is nothing to drive from a
 * `Clock`; tests are deterministic by construction (every call is synchronous).
 * A clock-driven `PollingSource` would only be needed for an EXTERNAL store that
 * can't push — that is the still-deferred hosted-ingest seam, not in-process
 * discovery.
 *
 * Composability: a `RegistrySource` is just another {@link SchedulerSink}
 * consumer. It can share one scheduler with a `DirectoryWatcherSource` and the
 * raw `arm()` API at the same time — `arm()`/`cancel()` are idempotent and
 * flap-coalescing, so overlapping sources never double-fire.
 *
 * Semantics:
 *  - `register(bundle)` — record the bundle by its Hachure `source` and arm it.
 *    Re-registering the SAME source updates it (re-arms; the scheduler coalesces
 *    a changed deadline and never double-fires an already-fired one).
 *  - `deregister(source)` — drop it from the registry and cancel its pending
 *    deadlines. (Fired history is the scheduler's; cancel never resurrects it.)
 *  - `registered()` — the live set, for visibility/debugging.
 *
 * Like every Source, this only nudges the scheduler; it authors nothing.
 */
export class RegistrySource {
  readonly #scheduler: SchedulerSink;
  /** Latest bundle registered per Hachure `source`. */
  readonly #bundles = new Map<string, TrustBundleReadModel>();

  /**
   * @param scheduler Any {@link SchedulerSink}; the `EphemerisScheduler`
   *   satisfies it structurally.
   */
  constructor(scheduler: SchedulerSink) {
    this.#scheduler = scheduler;
  }

  /**
   * Register (or update) a bundle and arm its deadlines immediately. Validates
   * the minimal Hachure shape (a `source` string + a `claims` array); a
   * malformed bundle is declined (returns `[]`, arms nothing), mirroring the
   * directory watcher's tolerance of junk input. Returns the deadlines newly
   * armed by this call (already-armed/fired/superseded ones are skipped).
   */
  register(bundle: TrustBundleReadModel): ArmedDeadline[] {
    if (
      !bundle ||
      typeof bundle.source !== "string" ||
      !Array.isArray(bundle.claims)
    ) {
      return [];
    }
    this.#bundles.set(bundle.source, bundle);
    return this.#scheduler.arm(bundle);
  }

  /**
   * Deregister a bundle by its `source`: drop it from the registry and cancel
   * its pending deadlines. Returns `true` if the source was registered. A
   * deadline already fired stays fired (cancel only clears pending wake-ups).
   */
  deregister(source: string): boolean {
    const had = this.#bundles.delete(source);
    this.#scheduler.cancel(source);
    return had;
  }

  /** True if a bundle is currently registered under `source`. */
  has(source: string): boolean {
    return this.#bundles.has(source);
  }

  /** Snapshot of the currently-registered bundle sources. */
  registered(): string[] {
    return [...this.#bundles.keys()];
  }
}
