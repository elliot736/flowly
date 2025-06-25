import type { Pool, PoolClient } from "pg";
import type { WorkflowDefinition } from "../types/workflow.js";
import type { WorkflowStore } from "../store/store.js";
import type { Logger } from "../logger.js";
import type { HookEmitter } from "../hooks.js";
import { executeWorkflow } from "../executor/executor.js";

export interface WorkerOptions {
  store: WorkflowStore;
  workflows: Map<string, WorkflowDefinition>;
  pollIntervalMs: number;
  maxConcurrent: number;
  leaseMs: number;
  workerId: string;
  shutdownTimeoutMs: number;
  log: Logger;
  hooks?: HookEmitter;
  useNotify?: boolean;
  pool?: Pool;
}

export class Worker {
  private running = false;
  private inflight = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeatTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly inflightPromises = new Map<string, Promise<void>>();
  private readonly log: Logger;
  private readonly opts: WorkerOptions;
  private notifyClient: PoolClient | null = null;
  private notifyResolve: (() => void) | null = null;

  constructor(opts: WorkerOptions) {
    this.opts = opts;
    this.log = opts.log;
  }

  start(): void {
    this.running = true;
    this.log.info({ workerId: this.opts.workerId }, "worker started");

    if (this.opts.useNotify && this.opts.pool) {
      this.setupNotify().catch((err) => {
        this.log.warn(
          { err },
          "LISTEN/NOTIFY setup failed, falling back to polling",
        );
      });
    }

    this.poll();
  }

  async stop(): Promise<void> {
    this.log.info("worker stopping");
    this.running = false;

    // Stop polling
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wake up any waiting notify poll
    if (this.notifyResolve) {
      this.notifyResolve();
      this.notifyResolve = null;
    }

    // Release notify client
    if (this.notifyClient) {
      try {
        await this.notifyClient.query("UNLISTEN durable_workflow_new_run");
        this.notifyClient.release();
      } catch {
        // Ignore
      }
      this.notifyClient = null;
    }

    // Abort all in-flight workflows
    for (const [runId, ac] of this.abortControllers) {
      this.log.debug({ workflowRunId: runId }, "aborting in-flight workflow");
      ac.abort();
    }

    // Wait for in-flight to drain with timeout
    await this.waitForDrain(this.opts.shutdownTimeoutMs);

    // Clear all heartbeats
    for (const [runId, timer] of this.heartbeatTimers) {
      clearInterval(timer);
      this.heartbeatTimers.delete(runId);
    }
    this.abortControllers.clear();
    this.inflightPromises.clear();

    this.log.info("worker stopped");
  }

  /** Abort a specific in-flight workflow by runId (for cancellation). */
  abortRun(runId: string): boolean {
    const ac = this.abortControllers.get(runId);
    if (ac) {
      ac.abort();
      return true;
    }
    return false;
  }

  getInflight(): number {
    return this.inflight;
  }

  /** Trigger an immediate poll (used by LISTEN/NOTIFY). */
  triggerPoll(): void {
    if (!this.running) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.poll();
  }

  private async setupNotify(): Promise<void> {
    if (!this.opts.pool) return;
    try {
      this.notifyClient = await this.opts.pool.connect();
      await this.notifyClient.query("LISTEN durable_workflow_new_run");
      this.notifyClient.on("notification", () => {
        this.log.debug("received NOTIFY, triggering immediate poll");
        this.triggerPoll();
      });
      this.notifyClient.on("error", (err) => {
        this.log.warn({ err }, "LISTEN client error, falling back to polling");
        this.notifyClient = null;
      });
      this.log.info("LISTEN/NOTIFY active");
    } catch (err) {
      this.log.warn({ err }, "Failed to set up LISTEN/NOTIFY");
    }
  }

  private poll(): void {
    if (!this.running) return;

    this.tryClaimAndExecute()
      .catch((err) => {
        this.log.error({ err }, "error in poll cycle");
      })
      .finally(() => {
        if (this.running) {
          this.pollTimer = setTimeout(
            () => this.poll(),
            this.opts.pollIntervalMs,
          );
        }
      });
  }

  private async tryClaimAndExecute(): Promise<void> {
    if (!this.running) return;
    if (this.inflight >= this.opts.maxConcurrent) return;

    const workflowNames = [...this.opts.workflows.keys()];
    if (workflowNames.length === 0) return;

    const run = await this.opts.store.claimNextRun(
      this.opts.workerId,
      workflowNames,
      this.opts.leaseMs,
    );

    if (!run) return;

    // Check again after the async claim  stop() may have been called
    if (!this.running) {
      this.log.warn(
        { workflowRunId: run.id },
        "claimed run after stop, releasing",
      );
      await this.opts.store.releaseRun(run.id);
      return;
    }

    const definition = this.opts.workflows.get(run.workflowName);
    if (!definition) {
      this.log.error(
        { workflow: run.workflowName },
        "unknown workflow claimed",
      );
      await this.opts.store.failRun(
        run.id,
        `Unknown workflow: ${run.workflowName}`,
      );
      return;
    }

    this.log.info(
      { workflowRunId: run.id, workflow: run.workflowName },
      "claimed workflow run",
    );

    this.inflight++;
    const ac = new AbortController();
    this.abortControllers.set(run.id, ac);

    // Start heartbeat with error handling
    const heartbeatInterval = Math.floor(this.opts.leaseMs / 3);
    const heartbeat = setInterval(() => {
      this.opts.store
        .extendLease(run.id, this.opts.workerId, this.opts.leaseMs)
        .then((extended) => {
          if (!extended) {
            this.log.warn(
              { workflowRunId: run.id },
              "lease lost, aborting workflow",
            );
            ac.abort();
            clearInterval(heartbeat);
            this.heartbeatTimers.delete(run.id);
          }
        })
        .catch((err) => {
          this.log.error(
            { workflowRunId: run.id, err },
            "heartbeat failed, aborting workflow",
          );
          ac.abort();
          clearInterval(heartbeat);
          this.heartbeatTimers.delete(run.id);
        });
    }, heartbeatInterval);
    this.heartbeatTimers.set(run.id, heartbeat);

    // Execute and track the promise
    const promise = executeWorkflow(
      definition,
      run,
      this.opts.store,
      this.log,
      ac.signal,
      this.opts.hooks,
    )
      .then((result) => {
        this.log.info(
          { workflowRunId: run.id, outcome: result.outcome },
          "workflow execution finished",
        );
      })
      .catch((err) => {
        this.log.error(
          { workflowRunId: run.id, err },
          "unexpected error in workflow execution",
        );
        // Try to mark as failed  best effort
        this.opts.store
          .failRun(run.id, err instanceof Error ? err.message : String(err))
          .catch((failErr) => {
            this.log.error(
              { workflowRunId: run.id, err: failErr },
              "failed to persist workflow failure",
            );
          });
      })
      .finally(() => {
        this.inflight--;
        clearInterval(heartbeat);
        this.heartbeatTimers.delete(run.id);
        this.abortControllers.delete(run.id);
        this.inflightPromises.delete(run.id);
      });

    this.inflightPromises.set(run.id, promise);
  }

  private async waitForDrain(timeoutMs: number): Promise<void> {
    if (this.inflight === 0) return;

    this.log.info(
      { inflight: this.inflight, timeoutMs },
      "waiting for in-flight workflows to drain",
    );

    const allPromises = Promise.all(this.inflightPromises.values());
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );

    const result = await Promise.race([
      allPromises.then(() => "drained" as const),
      timeout,
    ]);

    if (result === "timeout") {
      this.log.warn(
        { inflight: this.inflight, timeoutMs },
        "shutdown timed out with in-flight workflows still running",
      );
    } else {
      this.log.info("all in-flight workflows drained");
    }
  }
}

