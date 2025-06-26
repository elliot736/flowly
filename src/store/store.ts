import type { RunStatus, StepStatus } from "../types/index.js";

// ── DB Row Types ─────────────────────────────────────────────────────

export interface WorkflowRun {
  id: string;
  workflowName: string;
  input: unknown;
  status: RunStatus;
  result: unknown | null;
  error: string | null;
  scheduledFor: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  timeoutAt: Date | null;
  attempt: number;
  maxAttempts: number;
  concurrencyKey: string | null;
  parentRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StepRecord {
  id: string;
  workflowRunId: string;
  stepName: string;
  sequence: number;
  status: StepStatus;
  result: unknown | null;
  error: string | null;
  attempts: number;
  hasCompensate: boolean;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface SleepTimer {
  id: string;
  workflowRunId: string;
  stepName: string;
  wakeAt: Date;
  completed: boolean;
}

export interface CronSchedule {
  id: string;
  workflowName: string;
  cronExpression: string;
  input: unknown;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date;
  createdAt: Date;
}

export interface WorkflowEvent {
  id: string;
  workflowRunId: string;
  event: string;
  data: unknown;
  createdAt: Date;
}

// ── Params ───────────────────────────────────────────────────────────

export interface CreateRunParams {
  workflowName: string;
  input: unknown;
  scheduledFor?: Date;
  timeoutAt?: Date;
  concurrencyKey?: string;
  maxAttempts?: number;
  parentRunId?: string;
}

export interface SaveStepParams {
  workflowRunId: string;
  stepName: string;
  sequence: number;
  status: StepStatus;
  result?: unknown;
  error?: string;
  hasCompensate: boolean;
}

export interface CreateSleepParams {
  workflowRunId: string;
  stepName: string;
  wakeAt: Date;
}

export interface CreateCronParams {
  workflowName: string;
  cronExpression: string;
  input: unknown;
  nextRunAt: Date;
}

export interface SaveEventParams {
  workflowRunId: string;
  event: string;
  data: unknown;
}

// ── Store Interface ──────────────────────────────────────────────────

export interface WorkflowStore {
  // Runs
  createRun(params: CreateRunParams): Promise<WorkflowRun | null>;
  claimNextRun(
    workerId: string,
    workflowNames: string[],
    leaseMs: number,
  ): Promise<WorkflowRun | null>;
  extendLease(
    runId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<boolean>;
  completeRun(runId: string, result: unknown): Promise<void>;
  failRun(runId: string, error: string): Promise<void>;
  updateRunStatus(runId: string, status: RunStatus): Promise<void>;
  updateRunScheduledFor(runId: string, scheduledFor: Date): Promise<void>;
  releaseRun(runId: string): Promise<void>;
  getRun(runId: string): Promise<WorkflowRun | null>;
  cancelRun(runId: string): Promise<void>;
  getChildRuns(parentRunId: string): Promise<WorkflowRun[]>;
  getRunsByStatus(status: RunStatus): Promise<WorkflowRun[]>;
  incrementAttemptAndReset(runId: string): Promise<void>;
  setDeadLetter(runId: string, error: string): Promise<void>;

  // Steps
  getCompletedSteps(runId: string): Promise<StepRecord[]>;
  saveStep(params: SaveStepParams): Promise<StepRecord>;
  updateStepStatus(
    runId: string,
    stepName: string,
    status: StepStatus,
  ): Promise<void>;

  // Sleep timers
  createSleepTimer(params: CreateSleepParams): Promise<void>;
  getSleepTimer(
    runId: string,
    stepName: string,
  ): Promise<SleepTimer | null>;

  // Cron
  createCronSchedule(params: CreateCronParams): Promise<CronSchedule>;
  getDueCronJobs(now?: Date): Promise<CronSchedule[]>;
  updateCronLastRun(
    id: string,
    lastRunAt: Date,
    nextRunAt: Date,
  ): Promise<void>;

  // Events
  saveEvent(params: SaveEventParams): Promise<WorkflowEvent>;
  getEvents(runId: string): Promise<WorkflowEvent[]>;
  getNewEvents(sinceId?: string): Promise<WorkflowEvent[]>;

  // Health
  ping(): Promise<boolean>;
}
