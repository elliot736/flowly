import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { executeWorkflow } from "./executor.js";
import { testLogger } from "../test-helpers.js";

const log = testLogger;

describe("executeWorkflow", () => {
  it("executes a simple workflow", async () => {
    const store = new MemoryWorkflowStore();
    const wf = defineWorkflow("simple", async (ctx, input: { x: number }) => {
      const doubled = await ctx.step("double", { run: () => input.x * 2 });
      return { result: doubled };
    });

    const run = await store.createRun({ workflowName: "simple", input: { x: 5 } });
    run.status = "running";

    const result = await executeWorkflow(wf, run, store, log);
    expect(result.outcome).toBe("completed");
    expect(result.result).toEqual({ result: 10 });

    const updated = await store.getRun(run.id);
    expect(updated!.status).toBe("completed");
  });

  it("replays completed steps", async () => {
    const store = new MemoryWorkflowStore();
    let stepACalls = 0;
    let stepBCalls = 0;

    const wf = defineWorkflow("replay", async (ctx) => {
      const a = await ctx.step("step-a", {
        run: () => { stepACalls++; return "a-result"; },
      });
      const b = await ctx.step("step-b", {
        run: () => { stepBCalls++; return "b-result"; },
      });
      return { a, b };
    });

    const run = await store.createRun({ workflowName: "replay", input: {} });
    run.status = "running";

    await store.saveStep({
      workflowRunId: run.id,
      stepName: "step-a",
      sequence: 1,
      status: "completed",
      result: "a-result",
      hasCompensate: false,
    });

    const result = await executeWorkflow(wf, run, store, log);
    expect(result.outcome).toBe("completed");
    expect(result.result).toEqual({ a: "a-result", b: "b-result" });
    expect(stepACalls).toBe(0);
    expect(stepBCalls).toBe(1);
  });

  it("handles sleep interrupts", async () => {
    const store = new MemoryWorkflowStore();
    const wf = defineWorkflow("sleepy", async (ctx) => {
      await ctx.step("before-sleep", { run: () => "done" });
      await ctx.sleep("nap", { seconds: 60 });
      await ctx.step("after-sleep", { run: () => "awake" });
      return "finished";
    });

    const run = await store.createRun({ workflowName: "sleepy", input: {} });
    run.status = "running";

    const result = await executeWorkflow(wf, run, store, log);
    expect(result.outcome).toBe("sleeping");
    expect(result.sleepUntil).toBeInstanceOf(Date);

    const updated = await store.getRun(run.id);
    expect(updated!.status).toBe("pending");
  });

  it("runs compensation on failure", async () => {
    const store = new MemoryWorkflowStore();
    const compensated: string[] = [];

    const wf = defineWorkflow("saga", async (ctx) => {
      await ctx.step("step-1", {
        run: () => "result-1",
        compensate: () => { compensated.push("step-1"); },
      });
      await ctx.step("step-2", {
        run: () => "result-2",
        compensate: () => { compensated.push("step-2"); },
      });
      await ctx.step("step-3", {
        run: () => { throw new Error("boom"); },
      });
      return "never";
    });

    const run = await store.createRun({ workflowName: "saga", input: {} });
    run.status = "running";

    const result = await executeWorkflow(wf, run, store, log);
    expect(result.outcome).toBe("compensated");
    expect(result.error).toBe("boom");
    expect(compensated).toEqual(["step-2", "step-1"]);
  });

  it("fails without compensation when no compensate functions", async () => {
    const store = new MemoryWorkflowStore();
    const wf = defineWorkflow("no-comp", async (ctx) => {
      await ctx.step("fail", {
        run: () => { throw new Error("oops"); },
      });
      return "never";
    });

    const run = await store.createRun({ workflowName: "no-comp", input: {} });
    run.status = "running";

    const result = await executeWorkflow(wf, run, store, log);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("oops");
  });

  it("retries steps before failing", async () => {
    const store = new MemoryWorkflowStore();
    let calls = 0;

    const wf = defineWorkflow("retry-wf", async (ctx) => {
      const val = await ctx.step("flaky", {
        run: () => {
          calls++;
          if (calls < 3) throw new Error("not yet");
          return "success";
        },
        retry: { maxAttempts: 3, backoff: "fixed", initialDelayMs: 1 },
      });
      return val;
    });

    const run = await store.createRun({ workflowName: "retry-wf", input: {} });
    run.status = "running";

    const result = await executeWorkflow(wf, run, store, log);
    expect(result.outcome).toBe("completed");
    expect(result.result).toBe("success");
    expect(calls).toBe(3);
  });

  it("re-registers compensation during replay and uses it on later failure", async () => {
    const store = new MemoryWorkflowStore();
    const compensated: string[] = [];

    const wf = defineWorkflow("replay-comp", async (ctx) => {
      await ctx.step("step-1", {
        run: () => "r1",
        compensate: (r) => { compensated.push(`step-1:${r}`); },
      });
      await ctx.step("step-2", {
        run: () => { throw new Error("fail"); },
      });
      return "never";
    });

    const run = await store.createRun({ workflowName: "replay-comp", input: {} });
    run.status = "running";

    await store.saveStep({
      workflowRunId: run.id,
      stepName: "step-1",
      sequence: 1,
      status: "completed",
      result: "r1",
      hasCompensate: true,
    });

    const result = await executeWorkflow(wf, run, store, log);
    expect(result.outcome).toBe("compensated");
    expect(compensated).toEqual(["step-1:r1"]);
  });

  it("marks workflow as failed when compensation partially fails", async () => {
    const store = new MemoryWorkflowStore();

    const wf = defineWorkflow("partial-comp", async (ctx) => {
      await ctx.step("step-1", {
        run: () => "r1",
        compensate: () => { throw new Error("comp failed"); },
      });
      await ctx.step("step-2", {
        run: () => { throw new Error("boom"); },
      });
      return "never";
    });

    const run = await store.createRun({ workflowName: "partial-comp", input: {} });
    run.status = "running";

    const result = await executeWorkflow(wf, run, store, log);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("compensation partially failed");
  });
});
