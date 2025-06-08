import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { executeWorkflow } from "./executor.js";
import { testLogger } from "../test-helpers.js";

const log = testLogger;

describe("ctx.emit", () => {
  it("stores events emitted by the workflow", async () => {
    const store = new MemoryWorkflowStore();

    const wf = defineWorkflow("emit-wf", async (ctx) => {
      await ctx.emit("order.created", { orderId: "o1" });
      await ctx.emit("order.paid", { amount: 42 });
      return "done";
    });

    const run = await store.createRun({ workflowName: "emit-wf", input: {} });
    run!.status = "running";

    await executeWorkflow(wf, run!, store, log);

    const events = await store.getEvents(run!.id);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("order.created");
    expect(events[0].data).toEqual({ orderId: "o1" });
    expect(events[1].event).toBe("order.paid");
    expect(events[1].data).toEqual({ amount: 42 });
  });

  it("emits events without data", async () => {
    const store = new MemoryWorkflowStore();

    const wf = defineWorkflow("emit-no-data", async (ctx) => {
      await ctx.emit("heartbeat");
      return "ok";
    });

    const run = await store.createRun({ workflowName: "emit-no-data", input: {} });
    run!.status = "running";

    await executeWorkflow(wf, run!, store, log);

    const events = await store.getEvents(run!.id);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("heartbeat");
    expect(events[0].data).toBeNull();
  });
});
