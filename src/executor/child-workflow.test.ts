import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { executeWorkflow } from "./executor.js";
import { testLogger } from "../test-helpers.js";

const log = testLogger;

describe("ctx.workflow (child workflows)", () => {
  it("creates a child run and waits for it to complete", async () => {
    const store = new MemoryWorkflowStore();

    const childWf = defineWorkflow("child", async (_ctx, input: { x: number }) => {
      return input.x * 2;
    });

    const parentWf = defineWorkflow("parent", async (ctx) => {
      const result = await ctx.workflow(childWf, { x: 5 });
      return { childResult: result };
    });

    const parentRun = await store.createRun({ workflowName: "parent", input: {} });
    parentRun!.status = "running";

    // The child workflow will be created but not executed by the executor
    // since it relies on a separate worker. We need to simulate:
    // 1. Start executing parent, which creates a child run
    // 2. The child stays pending, so the parent will poll...

    // For this test, we simulate the child being completed before the parent polls
    // by executing both concurrently

    const parentPromise = executeWorkflow(parentWf, parentRun!, store, log);

    // Give the parent a moment to create the child run
    await new Promise((r) => setTimeout(r, 50));

    // Find the child run
    const childRuns = await store.getChildRuns(parentRun!.id);
    if (childRuns.length > 0) {
      const childRun = childRuns[0];
      // Execute the child
      childRun.status = "running";
      await executeWorkflow(childWf, childRun, store, log);
    }

    const result = await parentPromise;
    expect(result.outcome).toBe("completed");
    expect(result.result).toEqual({ childResult: 10 });
  });

  it("replays child workflow result on re-execution", async () => {
    const store = new MemoryWorkflowStore();
    let childCalls = 0;

    const childWf = defineWorkflow("child-replay", async () => {
      childCalls++;
      return "child-result";
    });

    const parentWf = defineWorkflow("parent-replay", async (ctx) => {
      const result = await ctx.workflow(childWf, {});
      return { childResult: result };
    });

    const parentRun = await store.createRun({ workflowName: "parent-replay", input: {} });
    parentRun!.status = "running";

    // Pre-save the child workflow step result to simulate replay
    await store.saveStep({
      workflowRunId: parentRun!.id,
      stepName: "child:child-replay:1",
      sequence: 1,
      status: "completed",
      result: "child-result",
      hasCompensate: false,
    });

    const result = await executeWorkflow(parentWf, parentRun!, store, log);
    expect(result.outcome).toBe("completed");
    expect(result.result).toEqual({ childResult: "child-result" });
    expect(childCalls).toBe(0);
  });

  it("fails parent when child workflow fails", async () => {
    const store = new MemoryWorkflowStore();

    const childWf = defineWorkflow("child-fail", async () => {
      throw new Error("child error");
    });

    const parentWf = defineWorkflow("parent-fail", async (ctx) => {
      const result = await ctx.workflow(childWf, {});
      return result;
    });

    const parentRun = await store.createRun({ workflowName: "parent-fail", input: {} });
    parentRun!.status = "running";

    const parentPromise = executeWorkflow(parentWf, parentRun!, store, log);

    // Wait for child to be created
    await new Promise((r) => setTimeout(r, 50));

    const childRuns = await store.getChildRuns(parentRun!.id);
    if (childRuns.length > 0) {
      const childRun = childRuns[0];
      childRun.status = "running";
      await executeWorkflow(childWf, childRun, store, log);
    }

    const result = await parentPromise;
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("child-fail failed");
  });

  it("sets parent_run_id on child run", async () => {
    const store = new MemoryWorkflowStore();

    const childWf = defineWorkflow("child-parent-id", async () => "ok");

    // Just directly create a child run to test the parentRunId field
    const parentRun = await store.createRun({ workflowName: "parent", input: {} });
    const childRun = await store.createRun({
      workflowName: "child-parent-id",
      input: {},
      parentRunId: parentRun!.id,
    });

    expect(childRun!.parentRunId).toBe(parentRun!.id);

    const children = await store.getChildRuns(parentRun!.id);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(childRun!.id);
  });
});
