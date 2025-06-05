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

export class MemoryWorkflowStore implements WorkflowStore {
  private runs = new Map<string, WorkflowRun>();
  private steps = new Map<string, StepRecord[]>();
  private sleepTimers = new Map<string, SleepTimer>();
  private cronSchedules = new Map<string, CronSchedule>();
  private events: WorkflowEvent[] = [];

  async createRun(params: CreateRunParams): Promise<string> {
    const id = crypto.randomUUID();
    this.runs.set(id, {
      id,
      workflowName: params.workflowName,
      input: params.input,
      status: params.scheduledFor ? "pending" : "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
      scheduledFor: params.scheduledFor ?? null,
      lockedBy: null,
      lockedUntil: null,
      parentRunId: params.parentRunId ?? null,
      concurrencyKey: params.concurrencyKey ?? null,
      attempt: 1,
      maxAttempts: params.maxAttempts ?? 3,
      timeoutAt: null,
    });
    return id;
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    return this.runs.get(id) ?? null;
  }

  async ping(): Promise<void> {}
}
