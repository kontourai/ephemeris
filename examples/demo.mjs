/**
 * Runnable demo: arm a bundle whose claim expires shortly, advance a
 * ManualClock past the deadline, and watch the RecordingTrigger fire exactly
 * once — with NO real wall-clock wait.
 *
 *   npm run example
 *   # or, after `npm run build`:  node examples/demo.mjs
 */
import {
  EphemerisScheduler,
  ManualClock,
  InMemoryStore,
  RecordingTrigger,
  deadlineKey,
} from "../dist/index.js";

const clock = new ManualClock(0);
const store = new InMemoryStore();
const trigger = new RecordingTrigger();

const scheduler = new EphemerisScheduler({ clock, store, trigger });
await scheduler.start();

// A Flow run-output bundle (Hachure shape: identified by `source`, no `id`)
// whose single claim expires at t=5000ms. The runId Ephemeris fires against is
// derived from the `flow-run:<def>:<runId>` source.
const bundle = {
  source: "flow-run:my-flow:run-abc",
  claims: [{ id: "claim-1", expiresAt: new Date(5000).toISOString() }],
};

const armed = scheduler.arm(bundle);
console.log(`armed ${armed.length} deadline(s); pending=${scheduler.pendingCount()}`);
console.log(`fired so far: ${trigger.fired.length} (expected 0 — not yet due)`);

// Advance time PAST the deadline. Firing is driven entirely by the clock.
clock.advance(6000);
console.log(`after advance(6000): fired=${trigger.fired.length} (expected 1)`);

// Re-arm the SAME bundle and advance again — idempotent, must NOT double-fire.
scheduler.arm(bundle);
clock.advance(1000);
console.log(`after re-arm + advance: fired=${trigger.fired.length} (expected still 1)`);

const key = deadlineKey({
  bundleSource: "flow-run:my-flow:run-abc",
  claimId: "claim-1",
  fireAt: 5000,
});
console.log(`fires for deadline key "${key}": ${trigger.countFor(deadlineKey, key)}`);

if (trigger.fired.length !== 1) {
  console.error("FAIL: expected exactly one fire");
  process.exit(1);
}
console.log("OK: fired exactly once; the trigger authored nothing (it only recorded).");
scheduler.stop();
