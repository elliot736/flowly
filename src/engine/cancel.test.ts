import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { DurableEngine } from "./engine.js";
import { testLogger } from "../test-helpers.js";

describe("engine.cancel", () => {
  it("sets run status to cancelled", async () => {
    const pool = {} as any;
    const wf = defineWorkflow("cancel-wf", async () => "ok");
    const engine = new DurableEngine({
      pool,
      workflows: [wf],
      logger: testLogger,
    });
    const store = new MemoryWorkflowStore();
    engine.setStore(store);

    const handle = await engine.trigger(wf, { input: {} });
    expect(handle).not.toBeNull();

    await engine.cancel(handle!.workflowRunId);

    const status = await engine.getStatus(handle!.workflowRunId);
    expect(status).not.toBeNull();
    expect(status!.status).toBe("cancelled");
  });

  it("cancels child workflows when parent is cancelled", async () => {
    const pool = {} as any;
    const childWf = defineWorkflow("child-wf", async () => "child-result");
    const parentWf = defineWorkflow("parent-wf", async () => "parent-result");
    const engine = new DurableEngine({
      pool,
      workflows: [parentWf, childWf],
      logger: testLogger,
    });
    const store = new MemoryWorkflowStore();
    engine.setStore(store);

    const parentHandle = await engine.trigger(parentWf, { input: {} });
    // Create a child run manually
    const childRun = await store.createRun({
      workflowName: "child-wf",
      input: {},
      parentRunId: parentHandle!.workflowRunId,
    });

    await engine.cancel(parentHandle!.workflowRunId);

    const parentStatus = await engine.getStatus(parentHandle!.workflowRunId);
    expect(parentStatus!.status).toBe("cancelled");

    const childStatus = await engine.getStatus(childRun!.id);
    expect(childStatus!.status).toBe("cancelled");
  });
});
