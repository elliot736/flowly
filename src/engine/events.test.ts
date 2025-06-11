import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { DurableEngine } from "./engine.js";
import { testLogger } from "../test-helpers.js";

describe("engine workflow events (ctx.emit + engine.on)", () => {
  it("engine.getEvents returns events for a run", async () => {
    const pool = {} as any;
    const wf = defineWorkflow("events-wf", async () => "ok");
    const engine = new DurableEngine({
      pool,
      workflows: [wf],
      logger: testLogger,
    });
    const store = new MemoryWorkflowStore();
    engine.setStore(store);

    const handle = await engine.trigger(wf, { input: {} });

    // Save some events
    await store.saveEvent({
      workflowRunId: handle!.workflowRunId,
      event: "order.created",
      data: { id: 1 },
    });
    await store.saveEvent({
      workflowRunId: handle!.workflowRunId,
      event: "order.paid",
      data: { amount: 42 },
    });

    const events = await engine.getEvents(handle!.workflowRunId);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("order.created");
    expect(events[1].event).toBe("order.paid");
  });

  it("getNewEvents returns events since a given id", async () => {
    const store = new MemoryWorkflowStore();
    const e1 = await store.saveEvent({
      workflowRunId: "run1",
      event: "evt1",
      data: null,
    });
    const e2 = await store.saveEvent({
      workflowRunId: "run1",
      event: "evt2",
      data: null,
    });
    const e3 = await store.saveEvent({
      workflowRunId: "run1",
      event: "evt3",
      data: null,
    });

    const newEvents = await store.getNewEvents(e1.id);
    expect(newEvents).toHaveLength(2);
    expect(newEvents[0].event).toBe("evt2");
    expect(newEvents[1].event).toBe("evt3");
  });
});
