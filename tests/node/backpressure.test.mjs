import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EphemerisScheduler,
  ManualClock,
  InMemoryStore,
  RecordingTrigger,
} from "../../dist/index.js";

const SOURCE = "flow-run:my-flow:run-abc";

// A bundle whose single claim expires at `expiresAtMs`.
function bundleExpiringAt(expiresAtMs) {
  return {
    source: SOURCE,
    claims: [{ id: "claim-1", expiresAt: new Date(expiresAtMs).toISOString() }],
  };
}

test("coalescing: re-arming a claim collapses to ONE pending deadline", async () => {
  const clock = new ManualClock(0);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
  });
  await scheduler.start();

  // The same claim re-armed with successively later deadlines (a flappy claim
  // re-emitted many times). Each re-arm supersedes the previous pending one.
  scheduler.arm(bundleExpiringAt(5000));
  scheduler.arm(bundleExpiringAt(6000));
  scheduler.arm(bundleExpiringAt(7000));
  assert.equal(
    scheduler.pendingCount(),
    1,
    "only the newest deadline for the claim is pending — older ones collapsed",
  );

  // It fires once, at the NEWEST deadline (7000), not at the superseded ones.
  clock.advance(6999);
  assert.equal(trigger.fired.length, 0, "superseded earlier deadlines do not fire");
  clock.advance(1); // now=7000
  assert.equal(trigger.fired.length, 1, "fires once at the surviving deadline");
  assert.equal(trigger.fired[0].fireAt, 7000);
  scheduler.stop();
});

test("min-fire-interval: rapid fires for the same claim within the window collapse to one", async () => {
  const clock = new ManualClock(0);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
    minFireIntervalMs: 1000, // a claim may fire at most once per 1000ms
  });
  await scheduler.start();

  // Fire #1 at t=100.
  scheduler.arm(bundleExpiringAt(100));
  clock.advance(100); // now=100
  assert.equal(trigger.fired.length, 1, "first fire is allowed");

  // A second deadline for the SAME claim due at t=500 — inside the 1000ms window
  // after the first fire (100). It must be coalesced away.
  scheduler.arm(bundleExpiringAt(500));
  clock.advance(400); // now=500, but 500 - 100 = 400 < 1000
  assert.equal(
    trigger.fired.length,
    1,
    "a fire within the min interval is coalesced (no storm)",
  );
  scheduler.stop();
});

test("min-fire-interval: a fire AFTER the window is allowed", async () => {
  const clock = new ManualClock(0);
  const trigger = new RecordingTrigger();
  const coalesced = [];
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
    minFireIntervalMs: 1000,
    onCoalesced: (d, reason) => coalesced.push({ fireAt: d.fireAt, reason }),
  });
  await scheduler.start();

  // Fire #1 at t=100.
  scheduler.arm(bundleExpiringAt(100));
  clock.advance(100);
  assert.equal(trigger.fired.length, 1);

  // A deadline at t=600 (inside window) is coalesced...
  scheduler.arm(bundleExpiringAt(600));
  clock.advance(500); // now=600; 600-100=500 < 1000
  assert.equal(trigger.fired.length, 1, "inside-window fire coalesced");

  // ...but a deadline at t=1200 (outside the 1000ms window from the last ALLOWED
  // fire at 100) is allowed to fire.
  scheduler.arm(bundleExpiringAt(1200));
  clock.advance(600); // now=1200; 1200-100=1100 >= 1000
  assert.equal(trigger.fired.length, 2, "a fire after the window is allowed");
  assert.equal(trigger.fired[1].fireAt, 1200);

  assert.equal(coalesced.length, 1, "exactly one fire was reported coalesced");
  assert.equal(coalesced[0].reason, "min-interval");
  scheduler.stop();
});

test("backpressure does not affect distinct claims — they fire independently", async () => {
  const clock = new ManualClock(0);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
    minFireIntervalMs: 10_000, // generous window
  });
  await scheduler.start();

  // Two DIFFERENT claims, both due at t=100. The rate limit is per-claim, so
  // both fire even though they're within each other's window.
  scheduler.arm({
    source: SOURCE,
    claims: [
      { id: "claim-A", expiresAt: new Date(100).toISOString() },
      { id: "claim-B", expiresAt: new Date(100).toISOString() },
    ],
  });
  clock.advance(100);
  assert.equal(trigger.fired.length, 2, "distinct claims are not coalesced together");
  scheduler.stop();
});
