/**
 * Ephemeris — external freshness scheduler / event-bridge for the Kontour suite.
 *
 * It turns time into a trigger. It triggers, it never authors. See README.
 */

// Core
export { EphemerisScheduler, deriveFireAt } from "./scheduler.js";
export type {
  EphemerisSchedulerOptions,
  CoalesceReason,
} from "./scheduler.js";

// Clock
export type { Clock } from "./clock.js";
export { SystemClock, ManualClock } from "./clock.js";

// Trigger
export type { Trigger, FlowRunner } from "./trigger.js";
export {
  FlowEvaluateTrigger,
  programmaticFlowRunner,
  cliFlowRunner,
  NoopTrigger,
  RecordingTrigger,
} from "./trigger.js";

// Store
export type { Store } from "./store.js";
export { InMemoryStore, JsonFileStore, AppendLogStore } from "./store.js";

// Sources
export { DirectoryWatcherSource, RegistrySource } from "./sources.js";
export type { SchedulerSink } from "./sources.js";

// Read-model types (aligned to the published Hachure schema)
export type {
  TrustBundleReadModel,
  ClaimReadModel,
  ArmedDeadline,
} from "./types.js";
export {
  deadlineKey,
  claimKey,
  runIdFromSource,
  HACHURE,
} from "./types.js";

// Hachure schema binding
export {
  claimSchema,
  trustBundleSchema,
  validateClaimFreshness,
} from "./hachure-schema.js";
export type {
  JsonSchema,
  JsonSchemaProperty,
  ValidationIssue,
} from "./hachure-schema.js";
