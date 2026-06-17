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
 * Default trigger: invoke Flow's `evaluateRun` for the deadline's run by
 * shelling out to the `flow evaluate <runId>` CLI.
 *
 * This is intentionally behind the `Trigger` interface so it is swappable for a
 * direct in-process call, an event-bus publish, or a producer ping later.
 *
 * TODO(emit-target): the design pins "emits *to* what?" as an open question
 * (direct evaluateRun call vs. producer notify vs. generic event bus). v0 picks
 * the CLI shell-out; revisit once the emit target is decided.
 */
export class FlowEvaluateTrigger implements Trigger {
  readonly #command: string;
  readonly #cwd?: string;

  constructor(options: { command?: string; cwd?: string } = {}) {
    this.#command = options.command ?? "flow";
    this.#cwd = options.cwd;
  }

  fire(deadline: ArmedDeadline): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.#command, ["evaluate", deadline.runId], {
        cwd: this.#cwd,
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", (code) => {
        // A non-zero exit is logged-but-tolerated philosophy: firing is a nudge,
        // and Flow re-derives. We still surface it so the daemon can log it.
        if (code === 0) resolve();
        else reject(new Error(`flow evaluate exited with code ${code}`));
      });
    });
  }
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
