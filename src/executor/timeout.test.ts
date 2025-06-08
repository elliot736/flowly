import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { executeWorkflow } from "./executor.js";
import { testLogger } from "../test-helpers.js";

const log = testLogger;

describe("workflow timeout enforcement", () => {
  it("fails a workflow that has already timed out", async () => {
    const store = new MemoryWorkflowStore();
    const wf = defineWorkflow("timeout-wf", async (ctx) => {
      await ctx.step("step-1", { run: () => "ok" });
      return "done";
    });

    const run = await store.createRun({
      workflowName: "timeout-wf",
      input: {},
      timeoutAt: new Date(Date.now() - 1000), // already timed out
    });
    run!.status = "running";

    const result = await executeWorkflow(wf, run!, store, log);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("Workflow timed out");
  });

  it("does not time out a workflow with future timeout", async () => {
    const store = new MemoryWorkflowStore();
    const wf = defineWorkflow("no-timeout-wf", async (ctx) => {
      return "ok";
    });

    const run = await store.createRun({
      workflowName: "no-timeout-wf",
      input: {},
      timeoutAt: new Date(Date.now() + 60_000),
    });
    run!.status = "running";

    const result = await executeWorkflow(wf, run!, store, log);
    expect(result.outcome).toBe("completed");
  });

  it("skips timed-out runs during claim", async () => {
    const store = new MemoryWorkflowStore();
    await store.createRun({
      workflowName: "timeout-wf",
      input: {},
      timeoutAt: new Date(Date.now() - 1000),
    });

    const claimed = await store.claimNextRun("worker-1", ["timeout-wf"], 30_000);
    expect(claimed).toBeNull();

    // Verify it was marked as failed
    const runs = await store.getRunsByStatus("failed");
    expect(runs).toHaveLength(1);
    expect(runs[0].error).toBe("Workflow timed out");
  });
});
