import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EphemerisScheduler,
  ManualClock,
  JsonFileStore,
  AppendLogStore,
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

// ── AppendLogStore (durability-at-scale) ────────────────────────────────────

function countLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "").length;
}

test("AppendLogStore: reload replays the log to identical state", async () => {
  const { path, dir } = tmpStorePath();
  try {
    // Daemon #1: arm several future deadlines across two bundles, then crash.
    {
      const clock = new ManualClock(0);
      const store1 = new AppendLogStore(path);
      const s1 = new EphemerisScheduler({
        clock,
        store: store1,
        trigger: new RecordingTrigger(),
      });
      await s1.start();
      s1.arm({
        source: "flow-run:f:run-1",
        claims: [
          { id: "c1", expiresAt: new Date(5000).toISOString() },
          { id: "c2", expiresAt: new Date(8000).toISOString() },
        ],
      });
      s1.arm({
        source: "flow-run:f:run-2",
        claims: [{ id: "c3", expiresAt: new Date(9000).toISOString() }],
      });
      assert.equal(s1.pendingCount(), 3, "three pending across two bundles");
      s1.stop();
    }

    // Daemon #2: reload from the log only — must reconstruct the EXACT pending set.
    const clock = new ManualClock(0);
    const store2 = new AppendLogStore(path);
    const trigger = new RecordingTrigger();
    const s2 = new EphemerisScheduler({ clock, store: store2, trigger });
    await s2.start();

    assert.equal(s2.pendingCount(), 3, "all three pending deadlines replayed");
    const pendingKeys = store2.pending().map(deadlineKey).sort();
    assert.deepEqual(
      pendingKeys,
      [
        deadlineKey({ bundleSource: "flow-run:f:run-1", claimId: "c1", fireAt: 5000 }),
        deadlineKey({ bundleSource: "flow-run:f:run-2", claimId: "c3", fireAt: 9000 }),
        deadlineKey({ bundleSource: "flow-run:f:run-1", claimId: "c2", fireAt: 8000 }),
      ].sort(),
      "replayed pending set is identical to what was armed",
    );

    // And it still fires each exactly once at its own deadline.
    clock.advance(9000);
    assert.equal(trigger.fired.length, 3, "all replayed deadlines fire once");
    s2.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AppendLogStore: fired history survives restart — no double-fire on reload", async () => {
  const { path, dir } = tmpStorePath();
  try {
    const key = deadlineKey({
      bundleSource: "flow-run:f:run-1",
      claimId: "c1",
      fireAt: 5000,
    });
    const armBundle = {
      source: "flow-run:f:run-1",
      claims: [{ id: "c1", expiresAt: new Date(5000).toISOString() }],
    };

    // Daemon #1: arm AND fire, then crash.
    {
      const clock = new ManualClock(0);
      const store1 = new AppendLogStore(path);
      const trigger1 = new RecordingTrigger();
      const s1 = new EphemerisScheduler({ clock, store: store1, trigger: trigger1 });
      await s1.start();
      s1.arm(armBundle);
      clock.advance(5000);
      assert.equal(trigger1.fired.length, 1, "fired in daemon #1");
      assert.ok(store1.hasFired(key), "fired key recorded in the log");
      s1.stop();
    }

    // Daemon #2: reload. The fired deadline must NOT fire again, even on re-arm.
    const clock = new ManualClock(0);
    const store2 = new AppendLogStore(path);
    const trigger2 = new RecordingTrigger();
    const s2 = new EphemerisScheduler({ clock, store: store2, trigger: trigger2 });
    await s2.start();

    assert.ok(store2.hasFired(key), "fired history replayed from the log");
    assert.equal(s2.pendingCount(), 0, "no pending after a fired reload");

    s2.arm(armBundle); // source re-delivers the same bundle
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

test("AppendLogStore: compaction preserves state and bounds the log", () => {
  const { path, dir } = tmpStorePath();
  try {
    // Compact eagerly so the test exercises it deterministically.
    const store = new AppendLogStore(path, { compactThreshold: 5 });

    // 20 arm mutations -> without compaction the log would be 20 lines.
    for (let i = 0; i < 20; i++) {
      store.addPending({
        bundleSource: "flow-run:f:run-1",
        runId: "run-1",
        claimId: `c${i}`,
        fireAt: 1000 + i,
      });
    }
    assert.equal(store.pending().length, 20, "all 20 deadlines pending");

    // The log is BOUNDED: compaction collapsed it well below the 20 raw mutations.
    const lines = countLines(path);
    assert.ok(
      lines <= 5,
      `log bounded by compaction (got ${lines} lines, threshold 5)`,
    );

    // State survives compaction: a fresh reload reconstructs all 20 deadlines.
    const reloaded = new AppendLogStore(path, { compactThreshold: 5 });
    assert.equal(
      reloaded.pending().length,
      20,
      "all 20 deadlines reconstructed from the compacted log",
    );
    const before = store.pending().map(deadlineKey).sort();
    const after = reloaded.pending().map(deadlineKey).sort();
    assert.deepEqual(after, before, "compacted state is identical to live state");

    // Removing all but one and firing one also survives compaction.
    for (let i = 1; i < 20; i++) {
      reloaded.removePending(
        deadlineKey({ bundleSource: "flow-run:f:run-1", claimId: `c${i}`, fireAt: 1000 + i }),
      );
    }
    reloaded.markFired(
      deadlineKey({ bundleSource: "flow-run:f:run-1", claimId: "c0", fireAt: 1000 }),
    );
    const final = new AppendLogStore(path, { compactThreshold: 5 });
    assert.equal(final.pending().length, 0, "all removed/fired -> nothing pending");
    assert.ok(
      final.hasFired(
        deadlineKey({ bundleSource: "flow-run:f:run-1", claimId: "c0", fireAt: 1000 }),
      ),
      "fired history preserved across compaction + reload",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AppendLogStore: a torn final log line (crash mid-append) is tolerated", () => {
  const { path, dir } = tmpStorePath();
  try {
    // Write two clean records, then a half-written (torn) final line.
    const rec = (deadline) => JSON.stringify({ op: "arm", deadline }) + "\n";
    writeFileSync(
      path,
      rec({ bundleSource: "flow-run:f:run-1", runId: "run-1", claimId: "c1", fireAt: 5000 }) +
        rec({ bundleSource: "flow-run:f:run-1", runId: "run-1", claimId: "c2", fireAt: 6000 }),
      "utf8",
    );
    // Append a partial line WITHOUT a trailing newline, as a crash would leave it.
    appendFileSync(path, '{"op":"arm","deadline":{"bundleSource":"flow-run:f', "utf8");

    const store = new AppendLogStore(path);
    assert.equal(
      store.pending().length,
      2,
      "the two intact records replay; the torn final line is skipped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AppendLogStore: appends one record per mutation (not a full rewrite)", () => {
  const { path, dir } = tmpStorePath();
  try {
    // Large threshold so no compaction interferes — we want to see raw appends.
    const store = new AppendLogStore(path, { compactThreshold: 10_000 });
    store.addPending({ bundleSource: "s", runId: "r", claimId: "c1", fireAt: 1 });
    assert.equal(countLines(path), 1, "one append after one arm");
    store.addPending({ bundleSource: "s", runId: "r", claimId: "c2", fireAt: 2 });
    assert.equal(countLines(path), 2, "two appends after two arms");
    store.markFired(deadlineKey({ bundleSource: "s", claimId: "c1", fireAt: 1 }));
    assert.equal(countLines(path), 3, "fire is one more appended record");
    assert.equal(store.logLength(), 3, "logLength tracks records since last snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
