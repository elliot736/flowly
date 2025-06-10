import type { WorkflowStore, WorkflowRun } from "../store/store.js";
import type { WorkflowDefinition } from "../types/workflow.js";
import type { WorkflowRunStatus } from "../types/status.js";
import type { EngineConfig } from "../types/config.js";
import { HookEmitter, HookEvents } from "../hooks.js";
import { Worker } from "../worker/worker.js";
import { executeWorkflow } from "../executor/executor.js";
import { createLogger } from "../logger.js";
import type { Logger } from "pino";

export class DurableEngine {
  private store: WorkflowStore;
  private worker: Worker | null = null;
  private workflows = new Map<string, WorkflowDefinition<any, any>>();
  private hooks = new HookEmitter();
  private logger: Logger;

  constructor(private config: EngineConfig) {
    this.store = config.store;
    this.logger = config.logger
      ? createLogger("engine", config.logger)
      : createLogger("engine");
  }

  register(definition: WorkflowDefinition<any, any>): void {
    this.workflows.set(definition.name, definition);
  }

  async trigger<TInput>(
    definition: WorkflowDefinition<TInput, any>,
    input: TInput,
    opts?: { scheduledFor?: Date; concurrencyKey?: string; maxAttempts?: number; timeoutMs?: number },
  ): Promise<string> {
    this.register(definition);
    const id = await this.store.createRun({
      workflowName: definition.name,
      input,
      scheduledFor: opts?.scheduledFor,
      concurrencyKey: opts?.concurrencyKey,
      maxAttempts: opts?.maxAttempts,
      timeoutMs: opts?.timeoutMs,
    });
    this.logger.info({ workflowRunId: id, workflow: definition.name }, "triggered workflow");
    return id;
  }

  async getStatus(runId: string): Promise<WorkflowRunStatus | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    return this.mapRunToStatus(run);
  }

  private mapRunToStatus(run: WorkflowRun): WorkflowRunStatus {
    switch (run.status) {
      case "pending":
        return { status: "pending", scheduledFor: run.scheduledFor ?? undefined };
      case "running":
        return { status: "running", startedAt: run.updatedAt };
      case "completed":
        return { status: "completed", result: run.output };
      case "failed":
        return { status: "failed", error: run.error ?? "unknown error" };
      case "compensating":
        return { status: "compensating" };
      case "compensated":
        return { status: "compensated" };
      case "cancelled":
        return { status: "cancelled" };
      case "dead_letter":
        return { status: "dead_letter", attempt: run.attempt };
      default:
        return { status: "failed", error: "unknown status" };
    }
  }

  async start(): Promise<void> {
    this.logger.info("starting engine");
  }

  async stop(): Promise<void> {
    this.logger.info("stopping engine");
  }

  hook<K extends keyof HookEvents>(event: K, fn: HookEvents[K]): () => void {
    return this.hooks.on(event, fn);
  }
}
