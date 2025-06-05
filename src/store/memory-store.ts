import { randomUUID } from "node:crypto";
import type { RunStatus, StepStatus } from "../types/index.js";
import type {
  WorkflowStore,
  WorkflowRun,
  StepRecord,
  SleepTimer,
  CronSchedule,
  WorkflowEvent,
  CreateRunParams,
  SaveStepParams,
  CreateSleepParams,
  CreateCronParams,
  SaveEventParams,
} from "./store.js";

/** In-memory WorkflowStore for testing. Not for production use. */
export class MemoryWorkflowStore implements WorkflowStore {
  readonly runs = new Map<string, WorkflowRun>();
  readonly steps = new Map<string, StepRecord[]>();
  readonly sleepTimers = new Map<string, SleepTimer>();
  readonly cronSchedules = new Map<string, CronSchedule>();
  readonly events: WorkflowEvent[] = [];

  async createRun(params: CreateRunParams): Promise<WorkflowRun | null> {
    // Concurrency key check
    if (params.concurrencyKey) {
      const activeStatuses: RunStatus[] = ["pending", "running", "compensating"];
      for (const run of this.runs.values()) {
        if (
          run.concurrencyKey === params.concurrencyKey &&
          activeStatuses.includes(run.status)
        ) {
          return null;
        }
      }
    }

    const now = new Date();
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowName: params.workflowName,
      input: params.input,
      status: "pending",
      result: null,
      error: null,
      scheduledFor: params.scheduledFor ?? now,
      startedAt: null,
      completedAt: null,
      lockedBy: null,
      lockedUntil: null,
      timeoutAt: params.timeoutAt ?? null,
      attempt: 1,
      maxAttempts: params.maxAttempts ?? 1,
      concurrencyKey: params.concurrencyKey ?? null,
      parentRunId: params.parentRunId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    this.steps.set(run.id, []);
    return run;
  }

  async claimNextRun(
    workerId: string,
    workflowNames: string[],
    leaseMs: number,
  ): Promise<WorkflowRun | null> {
    const now = new Date();
    for (const run of this.runs.values()) {
      if (!workflowNames.includes(run.workflowName)) continue;
      if (run.status !== "pending" && run.status !== "running") continue;
      if (run.scheduledFor > now) continue;
      if (run.lockedBy && run.lockedUntil && run.lockedUntil > now) continue;
      // Skip timed-out runs
      if (run.timeoutAt && run.timeoutAt < now) {
        run.status = "failed";
        run.error = "Workflow timed out";
        run.completedAt = now;
        run.lockedBy = null;
        run.lockedUntil = null;
        run.updatedAt = now;
        continue;
      }

      run.lockedBy = workerId;
      run.lockedUntil = new Date(now.getTime() + leaseMs);
      run.status = "running";
      run.startedAt = run.startedAt ?? now;
      run.updatedAt = now;
      return run;
    }
    return null;
  }

  async extendLease(
    runId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.lockedBy !== workerId) return false;
    run.lockedUntil = new Date(Date.now() + leaseMs);
    run.updatedAt = new Date();
    return true;
  }

  async completeRun(runId: string, result: unknown): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = "completed";
    run.result = result;
    run.completedAt = new Date();
    run.lockedBy = null;
    run.lockedUntil = null;
    run.updatedAt = new Date();
  }

  async failRun(runId: string, error: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = "failed";
    run.error = error;
    run.completedAt = new Date();
    run.lockedBy = null;
    run.lockedUntil = null;
    run.updatedAt = new Date();
  }

  async updateRunStatus(runId: string, status: RunStatus): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = status;
    run.updatedAt = new Date();
  }

  async updateRunScheduledFor(
    runId: string,
    scheduledFor: Date,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.scheduledFor = scheduledFor;
    run.updatedAt = new Date();
  }

  async releaseRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = "pending";
    run.lockedBy = null;
    run.lockedUntil = null;
    run.updatedAt = new Date();
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = "cancelled";
    run.completedAt = new Date();
    run.lockedBy = null;
    run.lockedUntil = null;
    run.updatedAt = new Date();
  }

  async getChildRuns(parentRunId: string): Promise<WorkflowRun[]> {
    const children: WorkflowRun[] = [];
    for (const run of this.runs.values()) {
      if (run.parentRunId === parentRunId) {
        children.push(run);
      }
    }
    return children;
  }

  async getRunsByStatus(status: RunStatus): Promise<WorkflowRun[]> {
    const result: WorkflowRun[] = [];
    for (const run of this.runs.values()) {
      if (run.status === status) {
        result.push(run);
      }
    }
    return result;
  }

  async incrementAttemptAndReset(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.attempt += 1;
    run.status = "pending";
    run.error = null;
    run.completedAt = null;
    run.lockedBy = null;
    run.lockedUntil = null;
    run.updatedAt = new Date();
  }

  async setDeadLetter(runId: string, error: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = "dead_letter";
    run.error = error;
    run.completedAt = new Date();
    run.lockedBy = null;
    run.lockedUntil = null;
    run.updatedAt = new Date();
  }

  async getCompletedSteps(runId: string): Promise<StepRecord[]> {
    const steps = this.steps.get(runId) ?? [];
    return steps
      .filter((s) => s.status === "completed")
      .sort((a, b) => a.sequence - b.sequence);
  }

  async saveStep(params: SaveStepParams): Promise<StepRecord> {
    const steps = this.steps.get(params.workflowRunId) ?? [];
    const existing = steps.find((s) => s.stepName === params.stepName);
    if (existing) return existing;

    const record: StepRecord = {
      id: randomUUID(),
      workflowRunId: params.workflowRunId,
      stepName: params.stepName,
      sequence: params.sequence,
      status: params.status,
      result: params.result ?? null,
      error: params.error ?? null,
      attempts: 1,
      hasCompensate: params.hasCompensate,
      startedAt: new Date(),
      completedAt: params.status === "completed" ? new Date() : null,
    };
    steps.push(record);
    this.steps.set(params.workflowRunId, steps);
    return record;
  }

  async updateStepStatus(
    runId: string,
    stepName: string,
    status: StepStatus,
  ): Promise<void> {
    const steps = this.steps.get(runId) ?? [];
    const step = steps.find((s) => s.stepName === stepName);
    if (step) step.status = status;
  }

  async createSleepTimer(params: CreateSleepParams): Promise<void> {
    const key = `${params.workflowRunId}:${params.stepName}`;
    this.sleepTimers.set(key, {
      id: randomUUID(),
      workflowRunId: params.workflowRunId,
      stepName: params.stepName,
      wakeAt: params.wakeAt,
      completed: false,
    });
  }

  async getSleepTimer(
    runId: string,
    stepName: string,
  ): Promise<SleepTimer | null> {
    const key = `${runId}:${stepName}`;
    return this.sleepTimers.get(key) ?? null;
  }

  async createCronSchedule(params: CreateCronParams): Promise<CronSchedule> {
    const schedule: CronSchedule = {
      id: randomUUID(),
      workflowName: params.workflowName,
      cronExpression: params.cronExpression,
      input: params.input,
      enabled: true,
      lastRunAt: null,
      nextRunAt: params.nextRunAt,
      createdAt: new Date(),
    };
    this.cronSchedules.set(schedule.id, schedule);
    return schedule;
  }

  async getDueCronJobs(now?: Date): Promise<CronSchedule[]> {
    const t = now ?? new Date();
    return [...this.cronSchedules.values()].filter(
      (s) => s.enabled && s.nextRunAt <= t,
    );
  }

  async updateCronLastRun(
    id: string,
    lastRunAt: Date,
    nextRunAt: Date,
  ): Promise<void> {
    const schedule = this.cronSchedules.get(id);
    if (!schedule) return;
    schedule.lastRunAt = lastRunAt;
    schedule.nextRunAt = nextRunAt;
  }

  async saveEvent(params: SaveEventParams): Promise<WorkflowEvent> {
    const event: WorkflowEvent = {
      id: randomUUID(),
      workflowRunId: params.workflowRunId,
      event: params.event,
      data: params.data,
      createdAt: new Date(),
    };
    this.events.push(event);
    return event;
  }

  async getEvents(runId: string): Promise<WorkflowEvent[]> {
    return this.events.filter((e) => e.workflowRunId === runId);
  }

  async getNewEvents(sinceId?: string): Promise<WorkflowEvent[]> {
    if (!sinceId) return [...this.events];
    const idx = this.events.findIndex((e) => e.id === sinceId);
    if (idx === -1) return [...this.events];
    return this.events.slice(idx + 1);
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

