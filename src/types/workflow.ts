import type { StepOptions, Duration } from "./step.js";

// ── Core Workflow Types ──────────────────────────────────────────────

/** A workflow definition  the return value of defineWorkflow(). */
export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly fn: WorkflowFn<TInput, TOutput>;
}

/** The function the user writes. */
export type WorkflowFn<TInput, TOutput> = (
  ctx: WorkflowContext,
  input: TInput,
) => Promise<TOutput>;

/** Context object passed to every workflow function. */
export interface WorkflowContext {
  /** Run a named step. On replay, returns the saved result without re-executing. */
  step<T>(name: string, opts: StepOptions<T>): Promise<T>;

  /** Pause execution for a duration. Durable  survives process restarts. */
  sleep(name: string, duration: Duration): Promise<void>;

  /** Pause execution until a specific timestamp. Durable  survives process restarts. */
  sleepUntil(name: string, until: Date): Promise<void>;

  /** Run a deterministic side effect. On replay, returns the saved result without re-executing. No compensation. */
  sideEffect<T>(name: string, fn: () => T | Promise<T>): Promise<T>;

  /** Emit an event from this workflow. External code can subscribe via engine.on(). */
  emit(event: string, data?: unknown): Promise<void>;

  /** Start a child workflow and wait for its result. */
  workflow<TChildInput, TChildOutput>(
    definition: WorkflowDefinition<TChildInput, TChildOutput>,
    input: TChildInput,
  ): Promise<TChildOutput>;

  /** The unique ID of this workflow run. */
  readonly workflowRunId: string;

  /** The current attempt number (starts at 1). */
  readonly attempt: number;
}

// ── Factory ──────────────────────────────────────────────────────────

/** Define a workflow. Returns a definition object to register with the engine. */
export function defineWorkflow<TInput, TOutput>(
  name: string,
  fn: WorkflowFn<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  return { name, fn };
}

