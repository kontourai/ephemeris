#!/usr/bin/env node
/**
 * Minimal Ephemeris daemon entry point.
 *
 * Usage:
 *   ephemeris watch <bundleDir> [--store <path>] [--flow-cmd <cmd>]
 *
 * Watches a directory of emitted bundle JSON files, arms each claim deadline,
 * and fires Flow's `evaluate <runId>` at the deadline. Durable across restarts
 * via a JsonFileStore.
 *
 * TODO(backpressure): no dedup/rate-limit beyond per-deadline idempotency yet.
 * A flappy claim that re-arms a fresh deadline each emit could still storm. See
 * README "Open / TODO".
 */
import { EphemerisScheduler } from "./scheduler.js";
import { SystemClock } from "./clock.js";
import { JsonFileStore } from "./store.js";
import { FlowEvaluateTrigger } from "./trigger.js";
import { DirectoryWatcherSource } from "./sources.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const [, , command, bundleDir] = process.argv;
  if (command !== "watch" || !bundleDir) {
    console.error(
      "usage: ephemeris watch <bundleDir> [--store <path>] [--flow-cmd <cmd>]",
    );
    process.exit(2);
  }

  const storePath = arg("store", ".ephemeris/wakeups.json")!;
  const flowCmd = arg("flow-cmd", "flow")!;

  const scheduler = new EphemerisScheduler({
    clock: new SystemClock(),
    store: new JsonFileStore(storePath),
    trigger: new FlowEvaluateTrigger({ command: flowCmd }),
  });
  await scheduler.start();

  const source = new DirectoryWatcherSource(bundleDir, scheduler);
  source.start();

  console.error(
    `[ephemeris] watching ${bundleDir} (store=${storePath}, pending=${scheduler.pendingCount()})`,
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
