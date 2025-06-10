import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { WorkflowDefinition } from "../types/workflow.js";
import type { EngineConfig, WorkerConfig } from "../types/config.js";
import type { WorkflowRunStatus } from "../types/status.js";
import type { WorkflowStore, WorkflowRun, WorkflowEvent } from "../store/store.js";
import type { Logger } from "../logger.js";
import { createLogger } from "../logger.js";
import { Worker } from "../worker/worker.js";
import { CronManager } from "../schedule/cron-manager.js";
import { getNextCronDate } from "../schedule/cron-parser.js";
import { migrate } from "../migrate/migrator.js";
import {
  validateSchemaName,
  validateWorkflowName,
  validatePositive,
} from "../validation.js";
import { ValidationError } from "../errors.js";
import { HookEmitter } from "../hooks.js";
import type { HookEvents, HookEventName } from "../hooks.js";

export interface TriggerOptions<TInput> {
  input: TInput;
  scheduledFor?: Date;
  timeoutMs?: number;
  concurrencyKey?: string;
  maxAttempts?: number;
}

export interface WorkflowHandle {
  workflowRunId: string;
}

export interface HealthCheckResult {
  healthy: boolean;
  inflight: number;
  dbConnected: boolean;
  uptime: number;
}

type WorkflowEventCallback = (data: { runId: string; event: string; data: unknown }) => void | Promise<void>;

export class DurableEngine {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly workflows: Map<string, WorkflowDefinition>;
  private readonly workerConfig: Required<WorkerConfig> & { shutdownTimeoutMs: number };
  private readonly log: Logger;
  private store: WorkflowStore | null = null;
  private worker: Worker | null = null;
  private cronManager: CronManager | null = null;
  private readonly hooks = new HookEmitter();
  private readonly startedAt = Date.now();
  private lastEventId: string | undefined;
  private eventPollTimer: ReturnType<typeof setTimeout> | null = null;

  // Workflow event subscribers (ctx.emit)
  private readonly eventListeners = new Map<string, WorkflowEventCallback[]>();
  private readonly anyEventListeners: WorkflowEventCallback[] = [];

  constructor(private readonly config: EngineConfig) {
    this.pool = config.pool;
    this.schema = config.schema ?? "durable_workflow";
    this.log = config.logger
      ? config.logger.child({ component: "engine" })
      : createLogger("engine");

    // Validate schema name
    validateSchemaName(this.schema);

    // Validate workflows
    if (!config.workflows || config.workflows.length === 0) {
      throw new ValidationError("At least one workflow must be provided");
    }

    this.workflows = new Map();
    for (const wf of config.workflows) {
      validateWorkflowName(wf.name);
      if (this.workflows.has(wf.name)) {
        throw new ValidationError(`Duplicate workflow name: "${wf.name}"`);
      }
      this.workflows.set(wf.name, wf);
    }

    const wc = config.worker ?? {};

    if (wc.pollIntervalMs !== undefined) validatePositive(wc.pollIntervalMs, "pollIntervalMs");
    if (wc.maxConcurrent !== undefined) validatePositive(wc.maxConcurrent, "maxConcurrent");
    if (wc.leaseMs !== undefined) validatePositive(wc.leaseMs, "leaseMs");

    this.workerConfig = {
      pollIntervalMs: wc.pollIntervalMs ?? 1000,
      maxConcurrent: wc.maxConcurrent ?? 5,
      leaseMs: wc.leaseMs ?? 30_000,
      workerId: wc.workerId ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
      shutdownTimeoutMs: wc.shutdownTimeoutMs ?? 30_000,
      useNotify: wc.useNotify ?? false,
    };
  }

  /** Run database migrations. Creates schema and tables if they don't exist. */
  async migrate(): Promise<void> {
    this.log.info({ schema: this.schema }, "running migrations");
    await migrate(this.pool, this.schema);
    this.log.info("migrations complete");
  }

  /** Set a custom store (for testing with MemoryWorkflowStore). */
  setStore(store: WorkflowStore): void {
    this.store = store;
  }

  private getStore(): WorkflowStore {
    if (!this.store) {
      throw new Error(
        "Store not initialized. Call engine.migrate() first, or engine.setStore() for testing.",
      );
    }
    return this.store;
  }

  /** Start the worker and cron manager. */
  async start(): Promise<void> {
    if (!this.store) {
      const { PostgresWorkflowStore } = await import(
        "../store/postgres-store.js"
      );
      this.store = new PostgresWorkflowStore(this.pool, this.schema);
    }

    this.worker = new Worker({
      store: this.store,
      workflows: this.workflows,
      ...this.workerConfig,
      log: this.log.child({ component: "worker" }),
      hooks: this.hooks,
      pool: this.workerConfig.useNotify ? this.pool : undefined,
    });

    this.cronManager = new CronManager({
      store: this.store,
      pollIntervalMs: this.workerConfig.pollIntervalMs * 5,
      log: this.log.child({ component: "cron" }),
    });

    this.worker.start();
    this.cronManager.start();

    // Start event polling for workflow events
    this.startEventPolling();

    this.log.info({ workerId: this.workerConfig.workerId }, "engine started");
  }

  /** Graceful shutdown. */
  async stop(): Promise<void> {
    this.log.info("engine stopping");
    this.cronManager?.stop();
    if (this.eventPollTimer) {
      clearTimeout(this.eventPollTimer);
      this.eventPollTimer = null;
    }
    await this.worker?.stop();
    this.log.info("engine stopped");
  }

  /** Trigger a workflow execution. */
  async trigger<TInput>(
    definition: WorkflowDefinition<TInput, any>,
    opts: TriggerOptions<TInput>,
  ): Promise<WorkflowHandle | null> {
    validateWorkflowName(definition.name);
    if (opts.timeoutMs !== undefined) validatePositive(opts.timeoutMs, "timeoutMs");

    const store = this.getStore();
    const run = await store.createRun({
      workflowName: definition.name,
      input: opts.input,
      scheduledFor: opts.scheduledFor,
      timeoutAt: opts.timeoutMs
        ? new Date(Date.now() + opts.timeoutMs)
        : undefined,
      concurrencyKey: opts.concurrencyKey,
      maxAttempts: opts.maxAttempts,
    });

    if (!run) {
      this.log.info(
        { workflow: definition.name, concurrencyKey: opts.concurrencyKey },
        "workflow trigger rejected (concurrency key conflict)",
      );
      return null;
    }

    this.log.info(
      { workflowRunId: run.id, workflow: definition.name },
      "workflow triggered",
    );

    return { workflowRunId: run.id };
  }

  /** Schedule a recurring workflow using a cron expression. */
  async schedule<TInput>(
    definition: WorkflowDefinition<TInput, any>,
    opts: { cron: string; input: TInput },
  ): Promise<void> {
    validateWorkflowName(definition.name);

    const store = this.getStore();
    const nextRunAt = getNextCronDate(opts.cron, new Date());
    await store.createCronSchedule({
      workflowName: definition.name,
      cronExpression: opts.cron,
      input: opts.input,
      nextRunAt,
    });

    this.log.info(
      { workflow: definition.name, cron: opts.cron, nextRunAt },
      "workflow scheduled",
    );
  }

  /** Get the current status of a workflow run. */
  async getStatus(runId: string): Promise<WorkflowRunStatus | null> {
    const store = this.getStore();
    const run = await store.getRun(runId);
    if (!run) return null;
    return toStatus(run);
  }

  /** Cancel a workflow run. Aborts in-flight execution and runs compensation. */
  async cancel(runId: string): Promise<void> {
    const store = this.getStore();
    const run = await store.getRun(runId);
    if (!run) return;

    // Abort in-flight execution if the worker has it
    if (this.worker) {
      this.worker.abortRun(runId);
    }

    // Cancel child workflows
    const children = await store.getChildRuns(runId);
    for (const child of children) {
      if (child.status === "pending" || child.status === "running") {
        await this.cancel(child.id);
      }
    }

    await store.cancelRun(runId);
    this.log.info({ workflowRunId: runId }, "workflow cancelled");
  }

  /** Health check: returns engine health information. */
  async healthCheck(): Promise<HealthCheckResult> {
    const store = this.getStore();
    let dbConnected = false;
    try {
      dbConnected = await store.ping();
    } catch {
      dbConnected = false;
    }

    const inflight = this.worker?.getInflight() ?? 0;

    return {
      healthy: dbConnected,
      inflight,
      dbConnected,
      uptime: Date.now() - this.startedAt,
    };
  }

  /** Subscribe to observability hooks (workflow:started, step:completed, etc.) */
  hook<K extends HookEventName>(event: K, callback: (payload: HookEvents[K]) => void | Promise<void>): void {
    this.hooks.on(event, callback);
  }

  /** Remove an observability hook. */
  unhook<K extends HookEventName>(event: K, callback: (payload: HookEvents[K]) => void | Promise<void>): void {
    this.hooks.off(event, callback);
  }

  /** Subscribe to workflow events emitted via ctx.emit(). */
  on(eventName: string, callback: WorkflowEventCallback): void {
    const cbs = this.eventListeners.get(eventName) ?? [];
    cbs.push(callback);
    this.eventListeners.set(eventName, cbs);
  }

  /** Subscribe to all workflow events emitted via ctx.emit(). */
  onAny(callback: WorkflowEventCallback): void {
    this.anyEventListeners.push(callback);
  }

  /** Get events for a specific workflow run. */
  async getEvents(runId: string): Promise<WorkflowEvent[]> {
    const store = this.getStore();
    return store.getEvents(runId);
  }

  /** Get all runs in dead_letter status. */
  async getDeadLetterRuns(): Promise<WorkflowRun[]> {
    const store = this.getStore();
    return store.getRunsByStatus("dead_letter");
  }

  /** Retry a dead-lettered run by resetting it to pending and incrementing the attempt. */
  async retryDeadLetter(runId: string): Promise<void> {
    const store = this.getStore();
    const run = await store.getRun(runId);
    if (!run || run.status !== "dead_letter") {
      throw new Error(`Run ${runId} is not in dead_letter status`);
    }
    await store.incrementAttemptAndReset(runId);
    this.log.info({ workflowRunId: runId }, "dead letter run retried");
  }

  // ── Internal: event polling ──────────────────────────────────────

  private startEventPolling(): void {
    const hasListeners = this.eventListeners.size > 0 || this.anyEventListeners.length > 0;
    // Always start polling; listeners may be added later
    this.pollEvents();
  }

  private pollEvents(): void {
    if (!this.store) return;

    this.dispatchNewEvents()
      .catch((err) => {
        this.log.error({ err }, "error polling workflow events");
      })
      .finally(() => {
        if (this.store && this.worker) {
          this.eventPollTimer = setTimeout(
            () => this.pollEvents(),
            this.workerConfig.pollIntervalMs,
          );
        }
      });
  }

  private async dispatchNewEvents(): Promise<void> {
    if (this.eventListeners.size === 0 && this.anyEventListeners.length === 0) return;

    const store = this.getStore();
    const events = await store.getNewEvents(this.lastEventId);
    if (events.length === 0) return;

    this.lastEventId = events[events.length - 1].id;

    for (const evt of events) {
      const payload = { runId: evt.workflowRunId, event: evt.event, data: evt.data };

      // Dispatch to specific listeners
      const cbs = this.eventListeners.get(evt.event);
      if (cbs) {
        for (const cb of cbs) {
          try {
            await cb(payload);
          } catch {
            // Swallow
          }
        }
      }

      // Dispatch to any listeners
      for (const cb of this.anyEventListeners) {
        try {
          await cb(payload);
        } catch {
          // Swallow
        }
      }
    }
  }
}

function toStatus(run: WorkflowRun): WorkflowRunStatus {
  switch (run.status) {
    case "pending":
      return { status: "pending", scheduledFor: run.scheduledFor };
    case "running":
      return { status: "running", startedAt: run.startedAt!, currentStep: null };
    case "completed":
      return {
        status: "completed",
        startedAt: run.startedAt!,
        completedAt: run.completedAt!,
        result: run.result,
      };
    case "failed":
      return {
        status: "failed",
        startedAt: run.startedAt!,
        failedAt: run.completedAt!,
        error: run.error!,
      };
    case "compensating":
      return {
        status: "compensating",
        startedAt: run.startedAt!,
        failedStep: "",
      };
    case "compensated":
      return {
        status: "compensated",
        startedAt: run.startedAt!,
        compensatedAt: run.completedAt!,
      };
    case "cancelled":
      return {
        status: "cancelled",
        startedAt: run.startedAt,
        cancelledAt: run.completedAt!,
      };
    case "dead_letter":
      return {
        status: "dead_letter",
        startedAt: run.startedAt!,
        failedAt: run.completedAt!,
        error: run.error!,
        attempt: run.attempt,
      };
  }
}
