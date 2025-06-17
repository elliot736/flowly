import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { DurableEngine } from "./engine.js";
import { defineWorkflow } from "../types/workflow.js";

async function createPool(): Promise<{ pool: pg.Pool; stop: () => Promise<void> }> {
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    return { pool, stop: async () => {} };
  }

  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:16").start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  return { pool, stop: () => container.stop() };
}

describe("DurableEngine (integration)", () => {
  let pool: pg.Pool;
  let stopContainer: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createPool();
    pool = ctx.pool;
    stopContainer = ctx.stop;
  });

  afterAll(async () => {
    await pool.end();
    await stopContainer();
  });

  it("end-to-end: migrate, trigger, execute, complete", async () => {
    const steps: string[] = [];

    const wf = defineWorkflow("e2e-wf", async (ctx, input: { name: string }) => {
      const greeting = await ctx.step("greet", {
        run: () => {
          steps.push("greet");
          return `Hello, ${input.name}!`;
        },
      });
      const upper = await ctx.step("uppercase", {
        run: () => {
          steps.push("uppercase");
          return greeting.toUpperCase();
        },
      });
      return { greeting, upper };
    });

    const engine = new DurableEngine({
      pool,
      workflows: [wf],
      worker: { pollIntervalMs: 100, maxConcurrent: 1, leaseMs: 10_000 },
    });

    await engine.migrate();
    await engine.start();

    const handle = await engine.trigger(wf, { input: { name: "Omar" } });

    // Poll until completed
    let status = await engine.getStatus(handle.workflowRunId);
    const deadline = Date.now() + 10_000;
    while (status?.status !== "completed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      status = await engine.getStatus(handle.workflowRunId);
    }

    await engine.stop();

    expect(status?.status).toBe("completed");
    if (status?.status === "completed") {
      expect(status.result).toEqual({
        greeting: "Hello, Omar!",
        upper: "HELLO, OMAR!",
      });
    }
    expect(steps).toEqual(["greet", "uppercase"]);
  });

  it("end-to-end: compensation on failure", async () => {
    const compensated: string[] = [];

    const wf = defineWorkflow("e2e-saga", async (ctx) => {
      await ctx.step("step-a", {
        run: () => "a",
        compensate: () => { compensated.push("a"); },
      });
      await ctx.step("step-b", {
        run: () => "b",
        compensate: () => { compensated.push("b"); },
      });
      await ctx.step("step-c", {
        run: () => { throw new Error("boom"); },
      });
      return "never";
    });

    const engine = new DurableEngine({
      pool,
      workflows: [wf],
      worker: { pollIntervalMs: 100, maxConcurrent: 1, leaseMs: 10_000 },
    });

    await engine.migrate();
    await engine.start();

    const handle = await engine.trigger(wf, { input: {} });

    let status = await engine.getStatus(handle.workflowRunId);
    const deadline = Date.now() + 10_000;
    while (
      status?.status !== "compensated" &&
      status?.status !== "failed" &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 100));
      status = await engine.getStatus(handle.workflowRunId);
    }

    await engine.stop();

    expect(status?.status).toBe("compensated");
    expect(compensated).toEqual(["b", "a"]);
  });

  it("end-to-end: resume after sleep", async () => {
    const steps: string[] = [];

    const wf = defineWorkflow("e2e-sleep", async (ctx) => {
      await ctx.step("before", {
        run: () => { steps.push("before"); return "ok"; },
      });
      // Sleep for 500ms (short for testing)
      await ctx.sleep("nap", { milliseconds: 500 });
      await ctx.step("after", {
        run: () => { steps.push("after"); return "done"; },
      });
      return "finished";
    });

    const engine = new DurableEngine({
      pool,
      workflows: [wf],
      worker: { pollIntervalMs: 100, maxConcurrent: 1, leaseMs: 10_000 },
    });

    await engine.migrate();
    await engine.start();

    const handle = await engine.trigger(wf, { input: {} });

    let status = await engine.getStatus(handle.workflowRunId);
    const deadline = Date.now() + 15_000;
    while (status?.status !== "completed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      status = await engine.getStatus(handle.workflowRunId);
    }

    await engine.stop();

    expect(status?.status).toBe("completed");
    expect(steps).toEqual(["before", "after"]);
  });
});
