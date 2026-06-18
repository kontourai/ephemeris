import { spawn } from "node:child_process";
import type { ArmedDeadline } from "./types.js";

/**
 * A trigger is the "nudge" Ephemeris produces when a deadline fires.
 *
 * HARD INVARIANT — *it triggers, it never authors.* A Trigger MUST NOT write to
 * any TrustBundle or ledger. Firing only nudges Flow to re-derive at the real
 * `now`; Surface decides for real. Over-firing must therefore be harmless.
 */
export interface Trigger {
  /** Produce the nudge for a fired deadline. */
  fire(deadline: ArmedDeadline): Promise<void>;
}

/**
 * The injectable unit of work a `FlowEvaluateTrigger` performs: re-evaluate a
 * run. Abstracting it means tests inject a recording fake (no real Flow install)
 * and production injects either the programmatic `evaluateRun` import or a CLI
 * shell-out — without the trigger logic caring which.
 *
 * It returns `void`: a runner reports success/failure by resolving/rejecting,
 * and Ephemeris consumes NOTHING it returns. That is the "nudge, never author"
 * contract expressed in the type — there is no channel by which a runner could
 * hand authored state back into the scheduler.
 */
export type FlowRunner = (runId: string) => Promise<void>;

/**
 * Default trigger: invoke Flow's `evaluateRun` for the deadline's run.
 *
 * The actual invocation is an injectable {@link FlowRunner}. By default it
 * **imports `@kontourai/flow` programmatically** and calls its exported
 * `evaluateRun(runId)` (confirmed exported from `@kontourai/flow@^1.4.0`). This
 * is preferred over a subprocess: it is in-process, typed, and avoids a `flow`
 * binary on PATH. A CLI fallback ({@link cliFlowRunner}) is provided for
 * deployments where Flow is only available as the `flow` executable.
 *
 * The runner is a *nudge*: it asks Flow to re-derive at the real `now`. The
 * trigger writes NOTHING to any bundle/ledger; Flow re-derives and Surface
 * decides. Over-firing is harmless.
 */
export class FlowEvaluateTrigger implements Trigger {
  readonly #runner: FlowRunner;

  /**
   * @param options.runner Inject a custom runner (tests pass a fake; production
   *   may pass {@link cliFlowRunner}). Defaults to the programmatic
   *   `evaluateRun` import via {@link programmaticFlowRunner}.
   */
  constructor(options: { runner?: FlowRunner } = {}) {
    this.#runner = options.runner ?? programmaticFlowRunner();
  }

  async fire(deadline: ArmedDeadline): Promise<void> {
    await this.#runner(deadline.runId);
  }
}

/**
 * A {@link FlowRunner} that lazily imports `@kontourai/flow` and calls its
 * exported `evaluateRun(runId, options?)`. The import is deferred to first use
 * so that merely constructing a `FlowEvaluateTrigger` (e.g. in a test that
 * injects its own runner) never requires `@kontourai/flow` to be installed.
 *
 * `@kontourai/flow` is an OPTIONAL peer here: Ephemeris depends on its emitted
 * bundle shape (via `hachure`), not on importing Flow itself. So it is loaded
 * dynamically and only when this default runner actually fires.
 *
 * @param options.cwd Working directory passed through to `evaluateRun` (Flow
 *   resolves runs relative to a project root).
 */
export function programmaticFlowRunner(options: { cwd?: string } = {}): FlowRunner {
  return async (runId: string): Promise<void> => {
    // Dynamic import keeps `@kontourai/flow` off the hard dependency path.
    const flow = (await import("@kontourai/flow")) as {
      evaluateRun: (runId: string, opts?: { cwd?: string }) => Promise<unknown>;
    };
    if (typeof flow.evaluateRun !== "function") {
      throw new Error(
        "Ephemeris: @kontourai/flow does not export evaluateRun; " +
          "use cliFlowRunner instead or pin a compatible flow version",
      );
    }
    // We discard the result entirely — firing is a nudge, not an authoring call.
    await flow.evaluateRun(runId, options.cwd ? { cwd: options.cwd } : undefined);
  };
}

/**
 * A {@link FlowRunner} that shells out to the `flow evaluate <runId>` CLI
 * (confirmed subcommand of `@kontourai/flow@^1.4.0`'s `flow` binary). Use this
 * when Flow is deployed only as an executable on PATH rather than importable.
 *
 * A non-zero exit rejects so the daemon can log it; firing is still a nudge, so
 * the scheduler tolerates the rejection (via its `onError` sink).
 */
export function cliFlowRunner(options: { command?: string; cwd?: string } = {}): FlowRunner {
  const command = options.command ?? "flow";
  return (runId: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(command, ["evaluate", runId], {
        cwd: options.cwd,
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`flow evaluate exited with code ${code}`));
      });
    });
}

/** No-op trigger for examples/tests where firing should do nothing observable. */
export class NoopTrigger implements Trigger {
  async fire(_deadline: ArmedDeadline): Promise<void> {
    // intentionally empty — proves a trigger authors nothing
  }
}

/**
 * Trigger that records every fire for assertions. Used by tests and the demo to
 * prove "fires exactly once per deadline" and "writes nothing but a record in
 * its own memory."
 */
export class RecordingTrigger implements Trigger {
  readonly fired: ArmedDeadline[] = [];

  async fire(deadline: ArmedDeadline): Promise<void> {
    this.fired.push(deadline);
  }

  /** Count of fires for a given dedup key, for idempotency assertions. */
  countFor(key: (d: ArmedDeadline) => string, value: string): number {
    return this.fired.filter((d) => key(d) === value).length;
  }
}
