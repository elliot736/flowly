import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "../store/memory-store.js";
import { defineWorkflow } from "../types/workflow.js";
import { DurableEngine } from "./engine.js";
import { testLogger } from "../test-helpers.js";

describe("engine.healthCheck", () => {
  it("returns health status", async () => {
    const pool = {} as any; // Dummy pool, won't be used with setStore
    const wf = defineWorkflow("health-wf", async () => "ok");
    const engine = new DurableEngine({
      pool,
      workflows: [wf],
      logger: testLogger,
    });
    const store = new MemoryWorkflowStore();
    engine.setStore(store);

    const health = await engine.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.dbConnected).toBe(true);
    expect(health.inflight).toBe(0);
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });
});
