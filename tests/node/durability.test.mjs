import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EphemerisScheduler,
  ManualClock,
  JsonFileStore,
  RecordingTrigger,
  deadlineKey,
} from "../../dist/index.js";

function bundle() {
  return {
    source: "flow-run:my-flow:run-abc",
    claims: [{ id: "claim-1", expiresAt: new Date(5000).toISOString() }],
  };
}

function tmpStorePath() {
  const dir = mkdtempSync(join(tmpdir(), "ephemeris-"));
  return { path: join(dir, "wakeups.json"), dir };
}

test("durability: JsonFileStore reload re-arms a pending deadline", async () => {
  const { path, dir } = tmpStorePath();
  try {
    // Daemon #1: arm a future deadline, then "crash" before it fires.
    {
      const clock = new ManualClock(0);
      const store1 = new JsonFileStore(path);
      const s1 = new EphemerisScheduler({
        clock,
        store: store1,
        trigger: new RecordingTrigger(),
      });
      await s1.start();
      s1.arm(bundle());
      assert.equal(s1.pendingCount(), 1, "armed and persisted");
      s1.stop(); // no fire yet
    }

    // Daemon #2: fresh process, fresh store reads the SAME file from disk.
    const clock = new ManualClock(0);
    const store2 = new JsonFileStore(path); // reloads from disk
    const trigger = new RecordingTrigger();
    const s2 = new EphemerisScheduler({ clock, store: store2, trigger });
    await s2.start();

    assert.equal(s2.pendingCount(), 1, "pending deadline survived restart");
    clock.advance(6000);
    assert.equal(trigger.fired.length, 1, "re-armed deadline fires after restart");
    s2.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durability: fired history survives restart — no double-fire on reload", async () => {
  const { path, dir } = tmpStorePath();
  try {
    const key = deadlineKey({
      bundleSource: "flow-run:my-flow:run-abc",
      claimId: "claim-1",
      fireAt: 5000,
    });

    // Daemon #1: arm AND fire, then crash.
    {
      const clock = new ManualClock(0);
      const store1 = new JsonFileStore(path);
      const trigger1 = new RecordingTrigger();
      const s1 = new EphemerisScheduler({
        clock,
        store: store1,
        trigger: trigger1,
      });
      await s1.start();
      s1.arm(bundle());
      clock.advance(6000);
      assert.equal(trigger1.fired.length, 1, "fired in daemon #1");
      assert.ok(store1.hasFired(key), "fired key persisted");
      s1.stop();
    }

    // Daemon #2: reload. The fired deadline must NOT fire again, even if the
    // same bundle is re-armed (e.g. the source re-delivers it).
    const clock = new ManualClock(0);
    const store2 = new JsonFileStore(path);
    const trigger2 = new RecordingTrigger();
    const s2 = new EphemerisScheduler({ clock, store: store2, trigger: trigger2 });
    await s2.start();

    assert.ok(store2.hasFired(key), "fired history reloaded from disk");
    assert.equal(s2.pendingCount(), 0, "no pending deadline after a fired reload");

    s2.arm(bundle()); // source re-delivers the same bundle
    clock.advance(10_000);
    assert.equal(
      trigger2.fired.length,
      0,
      "reload + re-arm of a fired deadline must not double-fire",
    );
    s2.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
