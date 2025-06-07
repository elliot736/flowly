import type { CompensationEntry } from "./context.js";
import type { WorkflowStore } from "../store/store.js";
import type { Logger } from "../logger.js";

/** Run compensation for all completed steps in reverse order. Returns true if all compensations succeeded. */
export async function runCompensation(
  entries: CompensationEntry[],
  store: WorkflowStore,
  workflowRunId: string,
  log: Logger,
): Promise<boolean> {
  // Sort by sequence descending (reverse order)
  const sorted = [...entries].sort((a, b) => b.sequence - a.sequence);
  let allSucceeded = true;

  for (const entry of sorted) {
    try {
      log.info({ step: entry.stepName }, "compensating step");
      await entry.compensate();
      await store.updateStepStatus(
        workflowRunId,
        entry.stepName,
        "compensated",
      );
      log.info({ step: entry.stepName }, "step compensated");
    } catch (err) {
      allSucceeded = false;
      log.error(
        { step: entry.stepName, err },
        "compensation failed for step",
      );
      await store.updateStepStatus(
        workflowRunId,
        entry.stepName,
        "failed",
      );
    }
  }

  return allSucceeded;
}
