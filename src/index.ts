// ── flowly ─────────────────────────────────────────────────
// Durable workflow engine for TypeScript, backed by Postgres.

export { defineWorkflow } from "./types/index.js";
export type {
  WorkflowDefinition,
  WorkflowFn,
  WorkflowContext,
  StepOptions,
  RetryPolicy,
  Duration,
  WorkflowRunStatus,
  RunStatus,
  EngineConfig,
  WorkerConfig,
} from "./types/index.js";

export { DurableEngine } from "./engine/index.js";
export type {
  TriggerOptions,
  WorkflowHandle,
  HealthCheckResult,
} from "./engine/index.js";

export type { WorkflowStore, WorkflowEvent } from "./store/index.js";
export { MemoryWorkflowStore } from "./store/index.js";

export { HookEmitter } from "./hooks.js";
export type { HookEvents, HookEventName } from "./hooks.js";

export {
  ValidationError,
  WorkflowCorruptionError,
  StepTimeoutError,
  LeaseExpiredError,
} from "./errors.js";
