import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EphemerisScheduler,
  ManualClock,
  InMemoryStore,
  RecordingTrigger,
  NoopTrigger,
  deadlineKey,
} from "../../dist/index.js";

// A Flow run-output bundle as Hachure shapes it: identified by `source`
// (no top-level `id`), runId derived from the `flow-run:<def>:<runId>` source.
function bundle(overrides = {}) {
  return {
    source: "flow-run:my-flow:run-abc",
    claims: [{ id: "claim-1", expiresAt: new Date(5000).toISOString() }],
    ...overrides,
  };
}

test("arm -> fires at deadline via ManualClock (no real wait)", async () => {
  const clock = new ManualClock(0);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
  });
  await scheduler.start();

  scheduler.arm(bundle());
  assert.equal(trigger.fired.length, 0, "must not fire before the deadline");

  clock.advance(4999);
  assert.equal(trigger.fired.length, 0, "must not fire one ms early");

  clock.advance(1); // now at 5000 == fireAt
  assert.equal(trigger.fired.length, 1, "fires exactly at the deadline");
  assert.equal(trigger.fired[0].runId, "run-abc");
  assert.equal(trigger.fired[0].claimId, "claim-1");
  scheduler.stop();
});

test("ttlSeconds fallback derives a deadline relative to now", async () => {
  const clock = new ManualClock(1000);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
  });
  await scheduler.start();

  scheduler.arm(
    bundle({ claims: [{ id: "c-ttl", ttlSeconds: 2 }] }),
  );
  clock.advance(1999);
  assert.equal(trigger.fired.length, 0);
  clock.advance(1); // now=3000 == 1000 + 2000
  assert.equal(trigger.fired.length, 1);
  scheduler.stop();
});

test("claims without freshness fields are ignored (no synthesized events)", async () => {
  const clock = new ManualClock(0);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
  });
  await scheduler.start();

  const armed = scheduler.arm(
    bundle({ claims: [{ id: "no-expiry" }] }),
  );
  assert.equal(armed.length, 0, "no deadline armed for a claim with no expiry");
  clock.advance(1_000_000);
  assert.equal(trigger.fired.length, 0, "Ephemeris invents no deadline");
  scheduler.stop();
});

test("idempotency: re-arm same bundle does not double-fire", async () => {
  const clock = new ManualClock(0);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
  });
  await scheduler.start();

  scheduler.arm(bundle());
  scheduler.arm(bundle()); // duplicate arm before firing
  clock.advance(6000);
  assert.equal(trigger.fired.length, 1, "duplicate arm collapses to one fire");

  scheduler.arm(bundle()); // re-arm AFTER firing
  clock.advance(1000);
  assert.equal(trigger.fired.length, 1, "re-arm after fire must not re-fire");

  const key = deadlineKey({
    bundleSource: "flow-run:my-flow:run-abc",
    claimId: "claim-1",
    fireAt: 5000,
  });
  assert.equal(trigger.countFor(deadlineKey, key), 1);
  scheduler.stop();
});

test("idempotency: past-due deadline fires once on arm", async () => {
  const clock = new ManualClock(10_000); // already past the 5000 deadline
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
  });
  await scheduler.start();

  scheduler.arm(bundle());
  assert.equal(trigger.fired.length, 1, "past-due deadline fires immediately");
  scheduler.arm(bundle());
  clock.advance(1);
  assert.equal(trigger.fired.length, 1, "still only once");
  scheduler.stop();
});

test("cancel(bundleSource) removes pending deadlines so they never fire", async () => {
  const clock = new ManualClock(0);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
  });
  await scheduler.start();

  scheduler.arm(bundle());
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.cancel("flow-run:my-flow:run-abc");
  assert.equal(scheduler.pendingCount(), 0);
  clock.advance(10_000);
  assert.equal(trigger.fired.length, 0, "cancelled deadline never fires");
  scheduler.stop();
});

test("trigger writes nothing — firing is only a nudge", async () => {
  // The NoopTrigger proves the scheduler depends on no return value and the
  // Trigger contract has no authoring surface: fire() returns void and the
  // scheduler mutates only its own store, never a bundle.
  const clock = new ManualClock(0);
  const noop = new NoopTrigger();
  const frozenBundle = Object.freeze(bundle());
  Object.freeze(frozenBundle.claims);
  Object.freeze(frozenBundle.claims[0]);

  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger: noop,
  });
  await scheduler.start();

  // Arming + firing a deeply-frozen bundle must not throw: nothing mutates it.
  scheduler.arm(frozenBundle);
  clock.advance(6000);

  // Bundle is byte-for-byte unchanged: Ephemeris authored nothing into it.
  assert.deepEqual(frozenBundle, {
    source: "flow-run:my-flow:run-abc",
    claims: [{ id: "claim-1", expiresAt: new Date(5000).toISOString() }],
  });
  scheduler.stop();
});
