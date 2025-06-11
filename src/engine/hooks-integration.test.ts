import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { executeWorkflow } from "../executor/executor.js";
import { testLogger } from "../test-helpers.js";
import { HookEmitter } from "../hooks.js";

const log = testLogger;

describe("hooks integration with executor", () => {
  it("emits workflow:started and workflow:completed hooks", async () => {
    const store = new MemoryWorkflowStore();
    const hooks = new HookEmitter();
    const received: string[] = [];

    hooks.on("workflow:started", () => received.push("started"));
    hooks.on("workflow:completed", () => received.push("completed"));

    const wf = defineWorkflow("hook-wf", async (ctx) => {
      return "result";
    });

    const run = await store.createRun({ workflowName: "hook-wf", input: {} });
    run!.status = "running";

    await executeWorkflow(wf, run!, store, log, undefined, hooks);

    expect(received).toEqual(["started", "completed"]);
  });

  it("emits step:started and step:completed hooks", async () => {
    const store = new MemoryWorkflowStore();
    const hooks = new HookEmitter();
    const stepEvents: string[] = [];

    hooks.on("step:started", (p) => stepEvents.push(`started:${p.stepName}`));
    hooks.on("step:completed", (p) => stepEvents.push(`completed:${p.stepName}`));

    const wf = defineWorkflow("hook-steps", async (ctx) => {
      await ctx.step("s1", { run: () => "a" });
      await ctx.step("s2", { run: () => "b" });
      return "ok";
    });

    const run = await store.createRun({ workflowName: "hook-steps", input: {} });
    run!.status = "running";

    await executeWorkflow(wf, run!, store, log, undefined, hooks);

    expect(stepEvents).toEqual([
      "started:s1",
      "completed:s1",
      "started:s2",
      "completed:s2",
    ]);
  });

  it("emits workflow:failed hook on failure", async () => {
    const store = new MemoryWorkflowStore();
    const hooks = new HookEmitter();
    let failedError: string | undefined;

    hooks.on("workflow:failed", (p) => { failedError = p.error; });

    const wf = defineWorkflow("hook-fail", async (ctx) => {
      await ctx.step("bad", { run: () => { throw new Error("oops"); } });
      return "never";
    });

    const run = await store.createRun({ workflowName: "hook-fail", input: {} });
    run!.status = "running";

    await executeWorkflow(wf, run!, store, log, undefined, hooks);

    expect(failedError).toBe("oops");
  });

  it("emits step:failed hook", async () => {
    const store = new MemoryWorkflowStore();
    const hooks = new HookEmitter();
    let failedStep: string | undefined;

    hooks.on("step:failed", (p) => { failedStep = p.stepName; });

    const wf = defineWorkflow("hook-step-fail", async (ctx) => {
      await ctx.step("bad-step", { run: () => { throw new Error("boom"); } });
      return "never";
    });

    const run = await store.createRun({ workflowName: "hook-step-fail", input: {} });
    run!.status = "running";

    await executeWorkflow(wf, run!, store, log, undefined, hooks);

    expect(failedStep).toBe("bad-step");
  });
});
