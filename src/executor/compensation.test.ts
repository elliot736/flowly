import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { runCompensation } from "./compensation.js";
import type { CompensationEntry } from "./context.js";
import { testLogger } from "../test-helpers.js";

const log = testLogger;

describe("runCompensation", () => {
  it("runs compensations in reverse sequence order", async () => {
    const store = new MemoryWorkflowStore();
    const run = await store.createRun({ workflowName: "test", input: {} });

    await store.saveStep({
      workflowRunId: run.id, stepName: "a", sequence: 1,
      status: "completed", result: null, hasCompensate: true,
    });
    await store.saveStep({
      workflowRunId: run.id, stepName: "b", sequence: 2,
      status: "completed", result: null, hasCompensate: true,
    });
    await store.saveStep({
      workflowRunId: run.id, stepName: "c", sequence: 3,
      status: "completed", result: null, hasCompensate: true,
    });

    const order: string[] = [];
    const entries: CompensationEntry[] = [
      { stepName: "a", sequence: 1, compensate: async () => { order.push("a"); } },
      { stepName: "b", sequence: 2, compensate: async () => { order.push("b"); } },
      { stepName: "c", sequence: 3, compensate: async () => { order.push("c"); } },
    ];

    const result = await runCompensation(entries, store, run.id, log);
    expect(order).toEqual(["c", "b", "a"]);
    expect(result).toBe(true);
  });

  it("continues compensating even if one fails", async () => {
    const store = new MemoryWorkflowStore();
    const run = await store.createRun({ workflowName: "test", input: {} });

    await store.saveStep({
      workflowRunId: run.id, stepName: "a", sequence: 1,
      status: "completed", result: null, hasCompensate: true,
    });
    await store.saveStep({
      workflowRunId: run.id, stepName: "b", sequence: 2,
      status: "completed", result: null, hasCompensate: true,
    });

    const order: string[] = [];
    const entries: CompensationEntry[] = [
      { stepName: "a", sequence: 1, compensate: async () => { order.push("a"); } },
      { stepName: "b", sequence: 2, compensate: async () => { throw new Error("comp fail"); } },
    ];

    const result = await runCompensation(entries, store, run.id, log);
    expect(order).toEqual(["a"]);
    expect(result).toBe(false);
  });
});
