#!/usr/bin/env node
/**
 * Minimal Ephemeris daemon entry point.
 *
 * Usage:
 *   ephemeris watch <bundleDir> [--store <path>] [--store-mode json|appendlog]
 *                               [--compact-threshold <n>] [--min-fire-interval <ms>]
 *                               [--flow-mode programmatic|cli] [--flow-cmd <cmd>]
 *                               [--cwd <path>]
 *
 * Watches a directory of emitted Hachure run-output bundle JSON files, arms each
 * claim deadline (read from `expiresAt` / `ttlSeconds`), and fires Flow's
 * `evaluateRun` at the deadline. Durable across restarts via a JsonFileStore;
 * flap-resistant via per-claim coalescing + a min-fire-interval.
 *
 * Flow invocation defaults to a PROGRAMMATIC import of `@kontourai/flow`'s
 * `evaluateRun`; pass `--flow-mode cli` to shell out to the `flow evaluate`
 * binary instead (e.g. when Flow is only on PATH).
 */
import { EphemerisScheduler } from "./scheduler.js";
import { SystemClock } from "./clock.js";
import { JsonFileStore, AppendLogStore } from "./store.js";
import type { Store } from "./store.js";
import {
  FlowEvaluateTrigger,
  programmaticFlowRunner,
  cliFlowRunner,
} from "./trigger.js";
import { DirectoryWatcherSource } from "./sources.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const [, , command, bundleDir] = process.argv;
  if (command !== "watch" || !bundleDir) {
    console.error(
      "usage: ephemeris watch <bundleDir> [--store <path>] " +
        "[--store-mode json|appendlog] [--compact-threshold <n>] " +
        "[--min-fire-interval <ms>] [--flow-mode programmatic|cli] " +
        "[--flow-cmd <cmd>] [--cwd <path>]",
    );
    process.exit(2);
  }

  const storePath = arg("store", ".ephemeris/wakeups.json")!;
  const storeMode = arg("store-mode", "json")!;
  const compactThreshold = Number(arg("compact-threshold", "1000"));
  const minFireIntervalMs = Number(arg("min-fire-interval", "0"));
  const flowMode = arg("flow-mode", "programmatic")!;
  const flowCmd = arg("flow-cmd", "flow")!;
  const cwd = arg("cwd");

  const runner =
    flowMode === "cli"
      ? cliFlowRunner(cwd ? { command: flowCmd, cwd } : { command: flowCmd })
      : programmaticFlowRunner(cwd ? { cwd } : {});

  // Durability: `json` rewrites the whole file per mutation (simple default);
  // `appendlog` appends one record per mutation and compacts past a threshold —
  // for a larger watched-bundle count. Both survive restart identically.
  const store: Store =
    storeMode === "appendlog"
      ? new AppendLogStore(storePath, {
          compactThreshold: Number.isFinite(compactThreshold)
            ? compactThreshold
            : 1000,
        })
      : new JsonFileStore(storePath);

  const scheduler = new EphemerisScheduler({
    clock: new SystemClock(),
    store,
    trigger: new FlowEvaluateTrigger({ runner }),
    minFireIntervalMs: Number.isFinite(minFireIntervalMs) ? minFireIntervalMs : 0,
  });
  await scheduler.start();

  const source = new DirectoryWatcherSource(bundleDir, scheduler);
  source.start();

  console.error(
    `[ephemeris] watching ${bundleDir} (store=${storePath} [${storeMode}], ` +
      `flow=${flowMode}, minFireInterval=${minFireIntervalMs}ms, ` +
      `pending=${scheduler.pendingCount()})`,
  );

  const shutdown = () => {
    source.stop();
    scheduler.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[ephemeris] fatal:", err);
  process.exit(1);
});
