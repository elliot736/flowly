import type { WorkflowStore } from "../store/store.js";
import type { WorkflowDefinition } from "../types/workflow.js";
import type { WorkerConfig } from "../types/config.js";
import { executeWorkflow } from "../executor/executor.js";
import { HookEmitter } from "../hooks.js";
import { createLogger } from "../logger.js";
import type { Logger } from "pino";

export interface WorkerOptions {
  store: WorkflowStore;
  workflows: Map<string, WorkflowDefinition<any, any>>;
  hooks: HookEmitter;
  config?: Partial<WorkerConfig>;
  logger?: Logger;
}

export class Worker {
  private store: WorkflowStore;
  private workflows: Map<string, WorkflowDefinition<any, any>>;
  private hooks: HookEmitter;
  private running = false;
  private inflight = 0;
  private pollInterval: number;
  private maxConcurrent: number;
  private leaseMs: number;
  private logger: Logger;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WorkerOptions) {
    this.store = opts.store;
    this.workflows = opts.workflows;
    this.hooks = opts.hooks;
    this.pollInterval = opts.config?.pollIntervalMs ?? 1000;
    this.maxConcurrent = opts.config?.maxConcurrent ?? 5;
    this.leaseMs = opts.config?.leaseMs ?? 30_000;
    this.logger = opts.logger
      ? createLogger("worker", opts.logger)
      : createLogger("worker");
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info("worker started");
    this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.logger.info("worker stopped");
  }

  getInflight(): number {
    return this.inflight;
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      while (this.inflight < this.maxConcurrent) {
        const run = await this.store.claimNextRun(this.leaseMs);
        if (!run) break;
        this.inflight++;
        this.execute(run.id).finally(() => this.inflight--);
      }
    } catch (err) {
      this.logger.error({ err }, "poll error");
    }
    this.pollTimer = setTimeout(() => this.poll(), this.pollInterval);
  }

  private async execute(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;
    const definition = this.workflows.get(run.workflowName);
    if (!definition) {
      await this.store.failRun(runId, `unknown workflow: ${run.workflowName}`);
      return;
    }
    const abortController = new AbortController();
    await executeWorkflow({
      run,
      definition,
      store: this.store,
      hooks: this.hooks,
      logger: this.logger,
      signal: abortController.signal,
    });
  }
}
