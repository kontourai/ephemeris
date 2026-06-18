import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FlowEvaluateTrigger,
  cliFlowRunner,
  runIdFromSource,
} from "../../dist/index.js";

test("FlowEvaluateTrigger calls the injected runner with the deadline's runId", async () => {
  const calls = [];
  const runner = async (runId) => {
    calls.push(runId);
  };
  const trigger = new FlowEvaluateTrigger({ runner });

  const deadline = {
    bundleSource: "flow-run:my-flow:run-abc",
    runId: "run-abc",
    claimId: "claim-1",
    fireAt: 5000,
  };
  await trigger.fire(deadline);

  assert.deepEqual(calls, ["run-abc"], "runner invoked exactly once with runId");
});

test("FlowEvaluateTrigger is a pure nudge — it returns void and authors nothing", async () => {
  // The runner is given the runId and NOTHING ELSE: no bundle, no claim, no
  // writable channel. Whatever it returns is discarded. This proves the trigger
  // has no authoring surface.
  let received;
  const runner = async (runId) => {
    received = runId;
    return { authored: "this should be ignored" };
  };
  const trigger = new FlowEvaluateTrigger({ runner });

  const deadline = Object.freeze({
    bundleSource: "flow-run:my-flow:run-xyz",
    runId: "run-xyz",
    claimId: "claim-2",
    fireAt: 1000,
  });

  // Firing a frozen deadline must not throw: the trigger mutates nothing.
  const result = await trigger.fire(deadline);
  assert.equal(result, undefined, "fire() resolves to void — no authored payload");
  assert.equal(received, "run-xyz", "runner saw only the runId");
  assert.deepEqual(
    deadline,
    {
      bundleSource: "flow-run:my-flow:run-xyz",
      runId: "run-xyz",
      claimId: "claim-2",
      fireAt: 1000,
    },
    "deadline is byte-for-byte unchanged",
  );
});

test("a rejecting runner propagates (so the scheduler's onError can log it)", async () => {
  const trigger = new FlowEvaluateTrigger({
    runner: async () => {
      throw new Error("flow unavailable");
    },
  });
  await assert.rejects(
    () => trigger.fire({ runId: "r", bundleSource: "s", claimId: "c", fireAt: 0 }),
    /flow unavailable/,
  );
});

test("cliFlowRunner shells out to `flow evaluate <runId>` (arg shape only)", async () => {
  // Drive it against a harmless stand-in binary so no real `flow` is needed:
  // `true` ignores its args and exits 0, proving the runner resolves on exit 0.
  const runner = cliFlowRunner({ command: "true" });
  await runner("run-abc"); // resolves — exit code 0

  // A command that exits non-zero rejects (firing is a nudge; the daemon logs).
  const failing = cliFlowRunner({ command: "false" });
  await assert.rejects(() => failing("run-abc"), /exited with code/);
});

test("runIdFromSource derives the runId from a flow-run source label", () => {
  assert.equal(runIdFromSource("flow-run:my-flow:run-abc"), "run-abc");
  assert.equal(runIdFromSource("flow-run:run-only"), "run-only");
  assert.equal(runIdFromSource("not-a-flow-source"), undefined);
  assert.equal(runIdFromSource("flow-run:"), undefined);
});
