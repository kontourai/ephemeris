import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EphemerisScheduler,
  ManualClock,
  InMemoryStore,
  RecordingTrigger,
  RegistrySource,
} from "../../dist/index.js";

// A Flow run-output bundle (Hachure shape: identified by `source`, no `id`).
function bundle(source, expiresAtMs) {
  return {
    source,
    claims: [{ id: "claim-1", expiresAt: new Date(expiresAtMs).toISOString() }],
  };
}

function freshScheduler() {
  const clock = new ManualClock(0);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
  });
  return { clock, trigger, scheduler };
}

test("RegistrySource: register ingests a bundle and arms its deadlines", async () => {
  const { clock, trigger, scheduler } = freshScheduler();
  await scheduler.start();
  const registry = new RegistrySource(scheduler);

  const armed = registry.register(bundle("flow-run:f:run-1", 5000));
  assert.equal(armed.length, 1, "registering a bundle arms its claim deadline");
  assert.ok(registry.has("flow-run:f:run-1"), "source is now registered");
  assert.deepEqual(registry.registered(), ["flow-run:f:run-1"]);

  assert.equal(trigger.fired.length, 0, "not fired before the deadline");
  clock.advance(5000); // now=5000 == fireAt
  assert.equal(trigger.fired.length, 1, "fires at the registered deadline");
  assert.equal(trigger.fired[0].runId, "run-1");
  scheduler.stop();
});

test("RegistrySource: re-registering the SAME source updates its deadline (coalesced, no double-fire)", async () => {
  const { clock, trigger, scheduler } = freshScheduler();
  await scheduler.start();
  const registry = new RegistrySource(scheduler);

  // A flappy producer re-registers the same source with a later deadline.
  registry.register(bundle("flow-run:f:run-1", 5000));
  registry.register(bundle("flow-run:f:run-1", 7000));
  assert.equal(
    scheduler.pendingCount(),
    1,
    "update supersedes the old pending deadline — one pending wake-up per claim",
  );

  clock.advance(6999);
  assert.equal(trigger.fired.length, 0, "superseded earlier deadline does not fire");
  clock.advance(1); // now=7000
  assert.equal(trigger.fired.length, 1, "fires once at the updated deadline");
  assert.equal(trigger.fired[0].fireAt, 7000);
  scheduler.stop();
});

test("RegistrySource: deregister cancels pending deadlines so they never fire", async () => {
  const { clock, trigger, scheduler } = freshScheduler();
  await scheduler.start();
  const registry = new RegistrySource(scheduler);

  registry.register(bundle("flow-run:f:run-1", 5000));
  assert.equal(scheduler.pendingCount(), 1);

  const had = registry.deregister("flow-run:f:run-1");
  assert.equal(had, true, "deregister reports the source was registered");
  assert.equal(registry.has("flow-run:f:run-1"), false, "no longer registered");
  assert.equal(scheduler.pendingCount(), 0, "its pending deadline was cancelled");

  clock.advance(10_000);
  assert.equal(trigger.fired.length, 0, "deregistered deadline never fires");

  // Deregistering an unknown source is a harmless no-op.
  assert.equal(registry.deregister("flow-run:f:nope"), false);
  scheduler.stop();
});

test("RegistrySource: deregister does NOT resurrect a deadline that already fired", async () => {
  const { clock, trigger, scheduler } = freshScheduler();
  await scheduler.start();
  const registry = new RegistrySource(scheduler);

  registry.register(bundle("flow-run:f:run-1", 5000));
  clock.advance(5000);
  assert.equal(trigger.fired.length, 1, "fired");

  // Deregister after firing, then re-register the same bundle — must NOT re-fire
  // (fired history is idempotent in the scheduler's store).
  registry.deregister("flow-run:f:run-1");
  registry.register(bundle("flow-run:f:run-1", 5000));
  clock.advance(5000);
  assert.equal(trigger.fired.length, 1, "an already-fired deadline never re-fires");
  scheduler.stop();
});

test("RegistrySource: malformed bundles are declined (arms nothing, not registered)", async () => {
  const { scheduler } = freshScheduler();
  await scheduler.start();
  const registry = new RegistrySource(scheduler);

  assert.deepEqual(registry.register({ claims: [] }), [], "no source -> declined");
  assert.deepEqual(
    registry.register({ source: "flow-run:f:run-1" }),
    [],
    "no claims array -> declined",
  );
  assert.equal(registry.registered().length, 0, "nothing registered");
  assert.equal(scheduler.pendingCount(), 0, "nothing armed");
  scheduler.stop();
});

test("RegistrySource composes with the directory watcher (same scheduler, distinct sources fire independently)", async () => {
  // Two sources, one scheduler. The registry arms run-1; a raw arm() (standing
  // in for any other source, e.g. the directory watcher) arms run-2. Both fire.
  const { clock, trigger, scheduler } = freshScheduler();
  await scheduler.start();
  const registry = new RegistrySource(scheduler);

  registry.register(bundle("flow-run:f:run-1", 5000));
  scheduler.arm(bundle("flow-run:f:run-2", 5000)); // a different source/bundle

  assert.equal(scheduler.pendingCount(), 2, "both sources' deadlines coexist");
  clock.advance(5000);
  assert.equal(trigger.fired.length, 2, "both distinct bundles fire independently");
  scheduler.stop();
});
