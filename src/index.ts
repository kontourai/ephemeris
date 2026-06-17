/**
 * Ephemeris — external freshness scheduler / event-bridge for the Kontour suite.
 *
 * It turns time into a trigger. It triggers, it never authors. See README.
 */

// Core
export { EphemerisScheduler, deriveFireAt } from "./scheduler.js";
export type { EphemerisSchedulerOptions } from "./scheduler.js";

// Clock
export type { Clock } from "./clock.js";
export { SystemClock, ManualClock } from "./clock.js";

// Trigger
export type { Trigger } from "./trigger.js";
export {
  FlowEvaluateTrigger,
  NoopTrigger,
  RecordingTrigger,
} from "./trigger.js";

// Store
export type { Store } from "./store.js";
export { InMemoryStore, JsonFileStore } from "./store.js";

// Sources
export { DirectoryWatcherSource } from "./sources.js";

// Read-model types
export type {
  TrustBundleReadModel,
  ClaimReadModel,
  ArmedDeadline,
} from "./types.js";
export { deadlineKey } from "./types.js";
