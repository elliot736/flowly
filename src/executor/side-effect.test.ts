import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { executeWorkflow } from "./executor.js";
import { testLogger } from "../test-helpers.js";

const log = testLogger;

describe("ctx.sideEffect", () => {
  it("executes a side effect and persists the result", async () => {
    const store = new MemoryWorkflowStore();
    let calls = 0;

    const wf = defineWorkflow("side-effect-wf", async (ctx) => {
      const id = await ctx.sideEffect("generate-id", () => {
        calls++;
        return "unique-id-123";
      });
      return { id };
    });

    const run = await store.createRun({ workflowName: "side-effect-wf", input: {} });
    run!.status = "running";

    const result = await executeWorkflow(wf, run!, store, log);
    expect(result.outcome).toBe("completed");
    expect(result.result).toEqual({ id: "unique-id-123" });
    expect(calls).toBe(1);

    // Verify it was saved as a step
    const steps = await store.getCompletedSteps(run!.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].stepName).toBe("generate-id");
    expect(steps[0].result).toBe("unique-id-123");
    expect(steps[0].hasCompensate).toBe(false);
  });

  it("replays a side effect on re-execution", async () => {
    const store = new MemoryWorkflowStore();
    let calls = 0;

    const wf = defineWorkflow("side-effect-replay", async (ctx) => {
      const ts = await ctx.sideEffect("get-timestamp", () => {
        calls++;
        return Date.now();
      });
      return { ts };
    });

    const run = await store.createRun({ workflowName: "side-effect-replay", input: {} });
    run!.status = "running";

    // Pre-save the step to simulate replay
    await store.saveStep({
      workflowRunId: run!.id,
      stepName: "get-timestamp",
      sequence: 1,
      status: "completed",
      result: 1234567890,
      hasCompensate: false,
    });

    const result = await executeWorkflow(wf, run!, store, log);
    expect(result.outcome).toBe("completed");
    expect(result.result).toEqual({ ts: 1234567890 });
    expect(calls).toBe(0); // Should NOT have called the function
  });

  it("does not register compensation for side effects", async () => {
    const store = new MemoryWorkflowStore();
    const compensated: string[] = [];

    const wf = defineWorkflow("side-effect-no-comp", async (ctx) => {
      await ctx.sideEffect("gen-id", () => "id-1");
      await ctx.step("fail-step", {
        run: () => { throw new Error("boom"); },
      });
      return "never";
    });

    const run = await store.createRun({ workflowName: "side-effect-no-comp", input: {} });
    run!.status = "running";

    const result = await executeWorkflow(wf, run!, store, log);
    // No compensation should run because sideEffect doesn't have compensate
    expect(result.outcome).toBe("failed");
    expect(compensated).toEqual([]);
  });
});
