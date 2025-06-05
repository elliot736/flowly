import { describe, it, expect, beforeEach } from "vitest";
import { MemoryWorkflowStore } from "./memory-store.js";

describe("MemoryWorkflowStore", () => {
  let store: MemoryWorkflowStore;

  beforeEach(() => {
    store = new MemoryWorkflowStore();
  });

  describe("createRun", () => {
    it("creates a run with pending status", async () => {
      const run = await store.createRun({
        workflowName: "test-wf",
        input: { foo: "bar" },
      });
      expect(run.status).toBe("pending");
      expect(run.workflowName).toBe("test-wf");
      expect(run.input).toEqual({ foo: "bar" });
      expect(run.id).toBeTruthy();
    });

    it("respects scheduledFor", async () => {
      const future = new Date(Date.now() + 60_000);
      const run = await store.createRun({
        workflowName: "test-wf",
        input: {},
        scheduledFor: future,
      });
      expect(run.scheduledFor).toEqual(future);
    });
  });

  describe("claimNextRun", () => {
    it("claims a pending run", async () => {
      await store.createRun({ workflowName: "test-wf", input: {} });

      const claimed = await store.claimNextRun("worker-1", ["test-wf"], 30_000);
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe("running");
      expect(claimed!.lockedBy).toBe("worker-1");
    });

    it("returns null when no runs available", async () => {
      const claimed = await store.claimNextRun("worker-1", ["test-wf"], 30_000);
      expect(claimed).toBeNull();
    });

    it("skips runs scheduled in the future", async () => {
      await store.createRun({
        workflowName: "test-wf",
        input: {},
        scheduledFor: new Date(Date.now() + 60_000),
      });

      const claimed = await store.claimNextRun("worker-1", ["test-wf"], 30_000);
      expect(claimed).toBeNull();
    });

    it("skips locked runs", async () => {
      await store.createRun({ workflowName: "test-wf", input: {} });
      await store.claimNextRun("worker-1", ["test-wf"], 30_000);

      const claimed = await store.claimNextRun("worker-2", ["test-wf"], 30_000);
      expect(claimed).toBeNull();
    });

    it("claims runs with expired leases", async () => {
      const run = await store.createRun({ workflowName: "test-wf", input: {} });
      // Simulate expired lease
      run.lockedBy = "worker-1";
      run.lockedUntil = new Date(Date.now() - 1000);
      run.status = "running";

      const claimed = await store.claimNextRun("worker-2", ["test-wf"], 30_000);
      expect(claimed).not.toBeNull();
      expect(claimed!.lockedBy).toBe("worker-2");
    });

    it("only claims matching workflow names", async () => {
      await store.createRun({ workflowName: "other-wf", input: {} });

      const claimed = await store.claimNextRun("worker-1", ["test-wf"], 30_000);
      expect(claimed).toBeNull();
    });
  });

  describe("steps", () => {
    it("saves and retrieves completed steps", async () => {
      const run = await store.createRun({ workflowName: "test-wf", input: {} });

      await store.saveStep({
        workflowRunId: run.id,
        stepName: "step-1",
        sequence: 1,
        status: "completed",
        result: { ok: true },
        hasCompensate: false,
      });

      const steps = await store.getCompletedSteps(run.id);
      expect(steps).toHaveLength(1);
      expect(steps[0].stepName).toBe("step-1");
      expect(steps[0].result).toEqual({ ok: true });
    });

    it("deduplicates steps by name", async () => {
      const run = await store.createRun({ workflowName: "test-wf", input: {} });

      const first = await store.saveStep({
        workflowRunId: run.id,
        stepName: "step-1",
        sequence: 1,
        status: "completed",
        result: { first: true },
        hasCompensate: false,
      });

      const second = await store.saveStep({
        workflowRunId: run.id,
        stepName: "step-1",
        sequence: 1,
        status: "completed",
        result: { second: true },
        hasCompensate: false,
      });

      expect(second.id).toBe(first.id);
      expect(second.result).toEqual({ first: true });
    });
  });

  describe("sleep timers", () => {
    it("creates and retrieves a timer", async () => {
      const run = await store.createRun({ workflowName: "test-wf", input: {} });
      const wakeAt = new Date(Date.now() + 5000);

      await store.createSleepTimer({
        workflowRunId: run.id,
        stepName: "sleep-1",
        wakeAt,
      });

      const timer = await store.getSleepTimer(run.id, "sleep-1");
      expect(timer).not.toBeNull();
      expect(timer!.wakeAt).toEqual(wakeAt);
    });

    it("returns null for missing timer", async () => {
      const timer = await store.getSleepTimer("no-such-id", "sleep-1");
      expect(timer).toBeNull();
    });
  });

  describe("completeRun / failRun", () => {
    it("marks a run as completed", async () => {
      const run = await store.createRun({ workflowName: "test-wf", input: {} });
      await store.completeRun(run.id, { done: true });

      const updated = await store.getRun(run.id);
      expect(updated!.status).toBe("completed");
      expect(updated!.result).toEqual({ done: true });
    });

    it("marks a run as failed", async () => {
      const run = await store.createRun({ workflowName: "test-wf", input: {} });
      await store.failRun(run.id, "something broke");

      const updated = await store.getRun(run.id);
      expect(updated!.status).toBe("failed");
      expect(updated!.error).toBe("something broke");
    });
  });
});
