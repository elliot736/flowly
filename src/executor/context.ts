import type { WorkflowContext } from "../types/workflow.js";
import type { WorkflowDefinition } from "../types/workflow.js";
import type { StepOptions, Duration } from "../types/step.js";
import { durationToMs } from "../types/step.js";
import type { WorkflowStore, StepRecord } from "../store/store.js";
import type { Logger } from "../logger.js";
import type { HookEmitter } from "../hooks.js";
import { validateStepName, validateDuration } from "../validation.js";
import { StepTimeoutError } from "../errors.js";
import { withRetry } from "./retry.js";

// ── Sentinel for sleep interrupts ────────────────────────────────────

export class SleepInterrupt {
  constructor(
    public readonly stepName: string,
    public readonly wakeAt: Date,
  ) {}
}

// ── Compensation registry ────────────────────────────────────────────

export interface CompensationEntry {
  stepName: string;
  sequence: number;
  compensate: () => Promise<void>;
}

// ── Context Implementation ───────────────────────────────────────────

export class WorkflowContextImpl implements WorkflowContext {
  readonly workflowRunId: string;
  readonly attempt: number;

  private sequence = 0;
  private readonly completedSteps: Map<string, StepRecord>;
  readonly compensations: CompensationEntry[] = [];

  constructor(
    workflowRunId: string,
    attempt: number,
    completedSteps: StepRecord[],
    private readonly store: WorkflowStore,
    private readonly log: Logger,
    private readonly signal?: AbortSignal,
    private readonly hooks?: HookEmitter,
    private readonly workflowName?: string,
  ) {
    this.workflowRunId = workflowRunId;
    this.attempt = attempt;
    this.completedSteps = new Map(completedSteps.map((s) => [s.stepName, s]));
  }

  async step<T>(name: string, opts: StepOptions<T>): Promise<T> {
    validateStepName(name);
    if (this.signal?.aborted) throw new Error("Aborted");

    this.sequence++;
    const seq = this.sequence;

    // Check for a completed step (replay)
    const existing = this.completedSteps.get(name);
    if (existing) {
      this.log.debug({ step: name, sequence: seq }, "replaying completed step");
      // Re-register compensation even during replay
      if (opts.compensate) {
        const result = existing.result as T;
        this.compensations.push({
          stepName: name,
          sequence: seq,
          compensate: async () => { await opts.compensate!(result); },
        });
      }
      return existing.result as T;
    }

    this.log.info({ step: name, sequence: seq }, "executing step");
    await this.hooks?.emit("step:started", {
      runId: this.workflowRunId,
      workflowName: this.workflowName ?? "",
      stepName: name,
    });

    // Execute the step with retry
    let result: T;
    try {
      result = await this.executeWithTimeout(
        name,
        () => withRetry(opts.run, opts.retry, this.signal, this.log.child({ step: name })),
        opts.timeoutMs,
      );
    } catch (err) {
      this.log.error({ step: name, err }, "step failed");
      // Save failed step
      await this.store.saveStep({
        workflowRunId: this.workflowRunId,
        stepName: name,
        sequence: seq,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        hasCompensate: !!opts.compensate,
      });
      await this.hooks?.emit("step:failed", {
        runId: this.workflowRunId,
        workflowName: this.workflowName ?? "",
        stepName: name,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Persist the result
    await this.store.saveStep({
      workflowRunId: this.workflowRunId,
      stepName: name,
      sequence: seq,
      status: "completed",
      result,
      hasCompensate: !!opts.compensate,
    });

    this.log.info({ step: name, sequence: seq }, "step completed");
    await this.hooks?.emit("step:completed", {
      runId: this.workflowRunId,
      workflowName: this.workflowName ?? "",
      stepName: name,
      result,
    });

    // Register compensation
    if (opts.compensate) {
      this.compensations.push({
        stepName: name,
        sequence: seq,
        compensate: async () => { await opts.compensate!(result); },
      });
    }

    return result;
  }

  async sideEffect<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    validateStepName(name);
    if (this.signal?.aborted) throw new Error("Aborted");

    this.sequence++;
    const seq = this.sequence;

    // Check for a completed step (replay)
    const existing = this.completedSteps.get(name);
    if (existing) {
      this.log.debug({ step: name, sequence: seq }, "replaying side effect");
      return existing.result as T;
    }

    this.log.info({ step: name, sequence: seq }, "executing side effect");

    let result: T;
    try {
      result = await fn();
    } catch (err) {
      this.log.error({ step: name, err }, "side effect failed");
      await this.store.saveStep({
        workflowRunId: this.workflowRunId,
        stepName: name,
        sequence: seq,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        hasCompensate: false,
      });
      throw err;
    }

    await this.store.saveStep({
      workflowRunId: this.workflowRunId,
      stepName: name,
      sequence: seq,
      status: "completed",
      result,
      hasCompensate: false,
    });

    this.log.info({ step: name, sequence: seq }, "side effect completed");
    return result;
  }

  async emit(event: string, data?: unknown): Promise<void> {
    if (this.signal?.aborted) throw new Error("Aborted");
    await this.store.saveEvent({
      workflowRunId: this.workflowRunId,
      event,
      data: data ?? null,
    });
    this.log.info({ event }, "event emitted");
  }

  async workflow<TChildInput, TChildOutput>(
    definition: WorkflowDefinition<TChildInput, TChildOutput>,
    input: TChildInput,
  ): Promise<TChildOutput> {
    if (this.signal?.aborted) throw new Error("Aborted");

    this.sequence++;
    const seq = this.sequence;
    const stepName = `child:${definition.name}:${seq}`;

    // Check for a completed step (replay)
    const existing = this.completedSteps.get(stepName);
    if (existing) {
      this.log.debug({ step: stepName, sequence: seq }, "replaying child workflow result");
      return existing.result as TChildOutput;
    }

    this.log.info({ step: stepName, workflow: definition.name }, "starting child workflow");

    // Create child run
    const childRun = await this.store.createRun({
      workflowName: definition.name,
      input,
      parentRunId: this.workflowRunId,
    });

    if (!childRun) {
      throw new Error(`Failed to create child workflow run for ${definition.name}`);
    }

    // Poll until child completes
    const pollIntervalMs = 100;
    const maxWaitMs = 30 * 60 * 1000; // 30 minutes
    const startTime = Date.now();

    while (true) {
      if (this.signal?.aborted) throw new Error("Aborted");
      if (Date.now() - startTime > maxWaitMs) {
        throw new Error(`Child workflow ${definition.name} timed out after ${maxWaitMs}ms`);
      }

      const run = await this.store.getRun(childRun.id);
      if (!run) throw new Error(`Child workflow run ${childRun.id} not found`);

      if (run.status === "completed") {
        // Save the result as a step so it replays
        await this.store.saveStep({
          workflowRunId: this.workflowRunId,
          stepName,
          sequence: seq,
          status: "completed",
          result: run.result,
          hasCompensate: false,
        });
        return run.result as TChildOutput;
      }

      if (run.status === "failed" || run.status === "cancelled" || run.status === "dead_letter") {
        throw new Error(`Child workflow ${definition.name} ${run.status}: ${run.error ?? "unknown error"}`);
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        if (this.signal) {
          this.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
          }, { once: true });
        }
      });
    }
  }

  async sleep(name: string, duration: Duration): Promise<void> {
    const ms = durationToMs(duration);
    validateDuration(ms);
    const wakeAt = new Date(Date.now() + ms);
    return this.sleepUntil(name, wakeAt);
  }

  async sleepUntil(name: string, until: Date): Promise<void> {
    validateStepName(name);
    if (this.signal?.aborted) throw new Error("Aborted");

    this.sequence++;

    // Check if the timer already exists and has passed
    const existing = await this.store.getSleepTimer(
      this.workflowRunId,
      name,
    );

    if (existing) {
      if (existing.wakeAt <= new Date()) {
        this.log.debug({ step: name }, "sleep timer expired, continuing");
        return;
      }
      this.log.debug({ step: name, wakeAt: existing.wakeAt }, "sleep timer still active");
      throw new SleepInterrupt(name, existing.wakeAt);
    }

    this.log.info({ step: name, wakeAt: until }, "creating sleep timer");

    // Create timer and interrupt
    await this.store.createSleepTimer({
      workflowRunId: this.workflowRunId,
      stepName: name,
      wakeAt: until,
    });

    throw new SleepInterrupt(name, until);
  }

  private async executeWithTimeout<T>(
    stepName: string,
    fn: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    if (!timeoutMs) return fn();

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new StepTimeoutError(stepName, timeoutMs));
        }
      }, timeoutMs);

      fn().then(
        (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } },
        (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } },
      );
    });
  }
}
