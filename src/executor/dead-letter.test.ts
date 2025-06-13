import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { executeWorkflow } from "./executor.js";
import { DurableEngine } from "../engine/engine.js";
import { testLogger } from "../test-helpers.js";

const log = testLogger;

describe("dead letter queue", () => {
  it("retries a failed workflow when attempt < maxAttempts", async () => {
    const store = new MemoryWorkflowStore();
    const wf = defineWorkflow("retry-wf", async (ctx) => {
      await ctx.step("fail", { run: () => { throw new Error("oops"); } });
      return "never";
    });

    const run = await store.createRun({
      workflowName: "retry-wf",
      input: {},
      maxAttempts: 3,
    });
    run!.status = "running";

    const result = await executeWorkflow(wf, run!, store, log);
    expect(result.outcome).toBe("retrying");

    // Verify run was reset
    const updated = await store.getRun(run!.id);
    expect(updated!.status).toBe("pending");
    expect(updated!.attempt).toBe(2);
  });

  it("moves to dead_letter when attempt >= maxAttempts", async () => {
    const store = new MemoryWorkflowStore();
    const wf = defineWorkflow("dlq-wf", async (ctx) => {
      await ctx.step("fail", { run: () => { throw new Error("oops"); } });
      return "never";
    });

    const run = await store.createRun({
      workflowName: "dlq-wf",
      input: {},
      maxAttempts: 2,
    });
    run!.status = "running";
    run!.attempt = 2; // Simulate already on second attempt

    const result = await executeWorkflow(wf, run!, store, log);
    expect(result.outcome).toBe("dead_letter");

    const updated = await store.getRun(run!.id);
    expect(updated!.status).toBe("dead_letter");
  });

  it("engine.getDeadLetterRuns returns dead-lettered runs", async () => {
    const pool = {} as any;
    const wf = defineWorkflow("dlq-check", async () => "ok");
    const engine = new DurableEngine({
      pool,
      workflows: [wf],
      logger: testLogger,
    });
    const store = new MemoryWorkflowStore();
    engine.setStore(store);

    const run = await store.createRun({
      workflowName: "dlq-check",
      input: {},
    });
    await store.setDeadLetter(run!.id, "final error");

    const dlRuns = await engine.getDeadLetterRuns();
    expect(dlRuns).toHaveLength(1);
    expect(dlRuns[0].id).toBe(run!.id);
  });

  it("engine.retryDeadLetter resets a dead-lettered run", async () => {
    const pool = {} as any;
    const wf = defineWorkflow("dlq-retry", async () => "ok");
    const engine = new DurableEngine({
      pool,
      workflows: [wf],
      logger: testLogger,
    });
    const store = new MemoryWorkflowStore();
    engine.setStore(store);

    const run = await store.createRun({
      workflowName: "dlq-retry",
      input: {},
    });
    await store.setDeadLetter(run!.id, "err");

    await engine.retryDeadLetter(run!.id);

    const updated = await store.getRun(run!.id);
    expect(updated!.status).toBe("pending");
    expect(updated!.attempt).toBe(2);
  });

  it("engine.retryDeadLetter throws for non-dead_letter runs", async () => {
    const pool = {} as any;
    const wf = defineWorkflow("dlq-reject", async () => "ok");
    const engine = new DurableEngine({
      pool,
      workflows: [wf],
      logger: testLogger,
    });
    const store = new MemoryWorkflowStore();
    engine.setStore(store);

    const run = await store.createRun({
      workflowName: "dlq-reject",
      input: {},
    });

    await expect(engine.retryDeadLetter(run!.id)).rejects.toThrow("not in dead_letter status");
  });
});
