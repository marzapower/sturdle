// Main exports for the Sturdle job engine.
export * from "./engine/index.js";
export * from "./database/index.js";

// Standalone contract types: payload, task event, function context/definition.
export * from "./types.js";

// Telemetry hook: the engine's only integration point for error tracking / observability.
export * from "./telemetry.js";

// Logging.
export { type Log, Logger, LogLevel, logLevelToName } from "./logger.js";

// Convenience exports for external adapter usage
export { Engine } from "./engine/engine.js";
export { EnhancedJob } from "./database/enhanced-job.js";
export { type JobDefinition, JobRegistry } from "./engine/registry.js";
export { getNextCronRun, parseCronExpression } from "./engine/utils.js";
export { JOB_SUSPENDED, JobSuspended } from "./engine/dispatcher.js";
export { type PayloadIssue, type PayloadValidation, validateJobPayload } from "./engine/payload.js";

export {
  type DatabaseAdapter,
  type Job,
  type JobFilter,
  type JobStats,
  type QueueInfo,
  type TaskStats,
} from "./database/types.js";

export { type EngineHealthStatus } from "./engine/engine.js";

export { DatabaseEngine } from "./engine/database-engine.js";

export { calculateExponentialBackoff } from "./engine/dispatcher.js";

export { InMemoryAdapter } from "./database/in-memory-adapter.js";

export {
  type ResolvedConcurrency,
  readPayloadPath,
  resolveConcurrency,
} from "./engine/concurrency.js";
