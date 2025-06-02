export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class WorkflowCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCorruptionError";
  }
}

export class StepTimeoutError extends Error {
  constructor(stepName: string, timeoutMs: number) {
    super(`Step "${stepName}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}

export class LeaseExpiredError extends Error {
  constructor(runId: string) {
    super(`Lease expired for workflow run ${runId}`);
    this.name = "LeaseExpiredError";
  }
}
