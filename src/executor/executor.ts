import type { WorkflowDefinition } from "../types/workflow.js";
import type { WorkflowStore, WorkflowRun } from "../store/store.js";
import type { Logger } from "../logger.js";
import type { HookEmitter } from "../hooks.js";
import { WorkflowContextImpl, SleepInterrupt } from "./context.js";
import { runCompensation } from "./compensation.js";

export interface ExecutionResult {
  outcome:
    | "completed"
    | "sleeping"
    | "failed"
    | "compensated"
    | "retrying"
    | "dead_letter";
  result?: unknown;
  error?: string;
  sleepUntil?: Date;
}

/** Execute a single workflow run. */
export async function executeWorkflow(
  definition: WorkflowDefinition,
  run: WorkflowRun,
  store: WorkflowStore,
  log: Logger,
  signal?: AbortSignal,
  hooks?: HookEmitter,
): Promise<ExecutionResult> {
  const wfLog = log.child({
    workflowRunId: run.id,
    workflow: run.workflowName,
  });

  // Check for timeout
  if (run.timeoutAt && run.timeoutAt < new Date()) {
    wfLog.warn("workflow timed out before execution");
    await store.failRun(run.id, "Workflow timed out");
    await hooks?.emit("workflow:failed", {
      runId: run.id,
      workflowName: run.workflowName,
      error: "Workflow timed out",
    });
    return { outcome: "failed", error: "Workflow timed out" };
  }

  wfLog.info("executing workflow");
  await hooks?.emit("workflow:started", {
    runId: run.id,
    workflowName: run.workflowName,
  });

  // Load previously completed steps for replay
  const completedSteps = await store.getCompletedSteps(run.id);
  if (completedSteps.length > 0) {
    wfLog.info(
      { replayedSteps: completedSteps.length },
      "replaying completed steps",
    );
  }

  const ctx = new WorkflowContextImpl(
    run.id,
    run.attempt,
    completedSteps,
    store,
    wfLog,
    signal,
    hooks,
    run.workflowName,
  );

  try {
    const result = await definition.fn(ctx, run.input);
    await store.completeRun(run.id, result);
    wfLog.info("workflow completed");
    await hooks?.emit("workflow:completed", {
      runId: run.id,
      workflowName: run.workflowName,
      result,
    });
    return { outcome: "completed", result };
  } catch (err) {
    // Sleep interrupt  not a failure
    if (err instanceof SleepInterrupt) {
      wfLog.info(
        { wakeAt: err.wakeAt, step: err.stepName },
        "workflow sleeping",
      );
      await store.updateRunScheduledFor(run.id, err.wakeAt);
      await store.releaseRun(run.id);
      return { outcome: "sleeping", sleepUntil: err.wakeAt };
    }

    const errorMsg = err instanceof Error ? err.message : String(err);

    // Real failure  run compensation
    const compensations = ctx.compensations;
    if (compensations.length > 0) {
      wfLog.warn({ err }, "workflow failed, running compensation");
      await store.updateRunStatus(run.id, "compensating");
      const allCompensated = await runCompensation(
        compensations,
        store,
        run.id,
        wfLog,
      );

      if (allCompensated) {
        await store.updateRunStatus(run.id, "compensated");
        wfLog.info("workflow compensated");
        await hooks?.emit("workflow:compensated", {
          runId: run.id,
          workflowName: run.workflowName,
        });
        return { outcome: "compensated", error: errorMsg };
      } else {
        // Some compensations failed  mark as failed, not compensated
        wfLog.error(
          "compensation partially failed, marking workflow as failed",
        );
        const fullError = `${errorMsg} (compensation partially failed)`;
        await handleFailure(run, store, wfLog, fullError, hooks);
        return await handleFailureResult(run, store, fullError);
      }
    }

    // No compensations  just fail (with DLQ logic)
    wfLog.error({ err }, "workflow failed");
    await hooks?.emit("workflow:failed", {
      runId: run.id,
      workflowName: run.workflowName,
      error: errorMsg,
    });
    return await handleFailure(run, store, wfLog, errorMsg, hooks);
  }
}

async function handleFailure(
  run: WorkflowRun,
  store: WorkflowStore,
  log: Logger,
  errorMsg: string,
  hooks?: HookEmitter,
): Promise<ExecutionResult> {
  // Dead letter queue logic: if attempt < maxAttempts, retry
  if (run.maxAttempts > 1 && run.attempt < run.maxAttempts) {
    log.info(
      { attempt: run.attempt, maxAttempts: run.maxAttempts },
      "retrying workflow (incrementing attempt)",
    );
    await store.incrementAttemptAndReset(run.id);
    return { outcome: "retrying", error: errorMsg };
  }

  if (run.maxAttempts > 1 && run.attempt >= run.maxAttempts) {
    log.warn(
      { attempt: run.attempt, maxAttempts: run.maxAttempts },
      "max attempts reached, moving to dead letter",
    );
    await store.setDeadLetter(run.id, errorMsg);
    await hooks?.emit("workflow:failed", {
      runId: run.id,
      workflowName: run.workflowName,
      error: errorMsg,
    });
    return { outcome: "dead_letter", error: errorMsg };
  }

  await store.failRun(run.id, errorMsg);
  await hooks?.emit("workflow:failed", {
    runId: run.id,
    workflowName: run.workflowName,
    error: errorMsg,
  });
  return { outcome: "failed", error: errorMsg };
}

async function handleFailureResult(
  run: WorkflowRun,
  store: WorkflowStore,
  errorMsg: string,
): Promise<ExecutionResult> {
  // For compensation partial failure, just fail directly
  await store.failRun(run.id, errorMsg);
  return { outcome: "failed", error: errorMsg };
}
