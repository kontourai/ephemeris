import { readdirSync, readFileSync, watch } from "node:fs";
import { join, extname } from "node:path";
import type { EphemerisScheduler } from "./scheduler.js";
import type { TrustBundleReadModel } from "./types.js";

/**
 * Source adapter: watches a directory of emitted bundle JSON files and arms each
 * one. This is the "discovery" seam — the programmatic `scheduler.arm(bundle)`
 * API is the other.
 *
 * TODO(discovery): the design pins discovery as an open question (subscribe to
 * emitted bundles vs. registry vs. watch stream/directory). v0 implements the
 * directory-watch variant; it is one source among several future adapters and
 * shares the hosted-ingest seam with Flow's HostedConsoleSink. See README.
 */
export class DirectoryWatcherSource {
  readonly #dir: string;
  readonly #scheduler: EphemerisScheduler;
  readonly #seen = new Set<string>();
  #watcher: ReturnType<typeof watch> | undefined;

  constructor(dir: string, scheduler: EphemerisScheduler) {
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
    if (!bundle || typeof bundle.id !== "string" || !Array.isArray(bundle.claims)) {
      return;
    }
    // arm() is itself idempotent; #seen just avoids redundant work on re-scan.
    this.#seen.add(bundle.id);
    this.#scheduler.arm(bundle);
  }
}
