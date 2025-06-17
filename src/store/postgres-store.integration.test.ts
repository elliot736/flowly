import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { PostgresWorkflowStore } from "./postgres-store.js";
import { migrate } from "../migrate/migrator.js";

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

describe("PostgresWorkflowStore", () => {
  let pool: pg.Pool;
  let store: PostgresWorkflowStore;
  let stopContainer: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createPool();
    pool = ctx.pool;
    stopContainer = ctx.stop;
    await migrate(pool, "durable_workflow");
    store = new PostgresWorkflowStore(pool, "durable_workflow");
  });

  afterAll(async () => {
    await pool.end();
    await stopContainer();
  });

  describe("createRun + getRun", () => {
    it("creates and retrieves a workflow run", async () => {
      const run = await store.createRun({
        workflowName: "test-wf",
        input: { key: "value" },
      });

      expect(run.id).toBeTruthy();
      expect(run.status).toBe("pending");
      expect(run.workflowName).toBe("test-wf");
      expect(run.input).toEqual({ key: "value" });

      const fetched = await store.getRun(run.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(run.id);
    });

    it("returns null for non-existent run", async () => {
      const fetched = await store.getRun("00000000-0000-0000-0000-000000000000");
      expect(fetched).toBeNull();
    });
  });

  describe("claimNextRun", () => {
    it("claims a pending run with FOR UPDATE SKIP LOCKED", async () => {
      const run = await store.createRun({ workflowName: "claim-wf", input: {} });

      const claimed = await store.claimNextRun("worker-1", ["claim-wf"], 30_000);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(run.id);
      expect(claimed!.status).toBe("running");
      expect(claimed!.lockedBy).toBe("worker-1");
      expect(claimed!.lockedUntil).toBeInstanceOf(Date);
    });

    it("does not double-claim a locked run", async () => {
      await store.createRun({ workflowName: "lock-wf", input: {} });

      const first = await store.claimNextRun("worker-1", ["lock-wf"], 30_000);
      expect(first).not.toBeNull();

      const second = await store.claimNextRun("worker-2", ["lock-wf"], 30_000);
      expect(second).toBeNull();
    });

    it("claims a run with expired lease", async () => {
      const run = await store.createRun({ workflowName: "expire-wf", input: {} });

      // Claim with 1ms lease (will expire immediately)
      await store.claimNextRun("worker-1", ["expire-wf"], 1);
      // Wait for lease to expire
      await new Promise((r) => setTimeout(r, 10));

      const claimed = await store.claimNextRun("worker-2", ["expire-wf"], 30_000);
      expect(claimed).not.toBeNull();
      expect(claimed!.lockedBy).toBe("worker-2");
    });

    it("does not claim runs scheduled in the future", async () => {
      await store.createRun({
        workflowName: "future-wf",
        input: {},
        scheduledFor: new Date(Date.now() + 60_000),
      });

      const claimed = await store.claimNextRun("worker-1", ["future-wf"], 30_000);
      expect(claimed).toBeNull();
    });
  });

  describe("extendLease", () => {
    it("extends the lease for the correct worker", async () => {
      await store.createRun({ workflowName: "extend-wf", input: {} });
      const claimed = await store.claimNextRun("worker-1", ["extend-wf"], 30_000);

      const extended = await store.extendLease(claimed!.id, "worker-1", 60_000);
      expect(extended).toBe(true);
    });

    it("rejects lease extension for wrong worker", async () => {
      await store.createRun({ workflowName: "wrong-wf", input: {} });
      const claimed = await store.claimNextRun("worker-1", ["wrong-wf"], 30_000);

      const extended = await store.extendLease(claimed!.id, "worker-2", 60_000);
      expect(extended).toBe(false);
    });
  });

  describe("completeRun + failRun", () => {
    it("completes a run", async () => {
      const run = await store.createRun({ workflowName: "comp-wf", input: {} });
      await store.completeRun(run.id, { success: true });

      const fetched = await store.getRun(run.id);
      expect(fetched!.status).toBe("completed");
      expect(fetched!.result).toEqual({ success: true });
      expect(fetched!.lockedBy).toBeNull();
    });

    it("fails a run", async () => {
      const run = await store.createRun({ workflowName: "fail-wf", input: {} });
      await store.failRun(run.id, "something broke");

      const fetched = await store.getRun(run.id);
      expect(fetched!.status).toBe("failed");
      expect(fetched!.error).toBe("something broke");
    });
  });

  describe("steps", () => {
    it("saves and retrieves completed steps", async () => {
      const run = await store.createRun({ workflowName: "step-wf", input: {} });

      await store.saveStep({
        workflowRunId: run.id,
        stepName: "step-1",
        sequence: 1,
        status: "completed",
        result: { data: 42 },
        hasCompensate: true,
      });

      await store.saveStep({
        workflowRunId: run.id,
        stepName: "step-2",
        sequence: 2,
        status: "completed",
        result: "hello",
        hasCompensate: false,
      });

      const steps = await store.getCompletedSteps(run.id);
      expect(steps).toHaveLength(2);
      expect(steps[0].stepName).toBe("step-1");
      expect(steps[0].result).toEqual({ data: 42 });
      expect(steps[0].hasCompensate).toBe(true);
      expect(steps[1].stepName).toBe("step-2");
    });

    it("deduplicates steps via ON CONFLICT", async () => {
      const run = await store.createRun({ workflowName: "dedup-wf", input: {} });

      const first = await store.saveStep({
        workflowRunId: run.id,
        stepName: "unique-step",
        sequence: 1,
        status: "completed",
        result: "first",
        hasCompensate: false,
      });

      const second = await store.saveStep({
        workflowRunId: run.id,
        stepName: "unique-step",
        sequence: 1,
        status: "completed",
        result: "second",
        hasCompensate: false,
      });

      expect(second.id).toBe(first.id);
      expect(second.result).toBe("first"); // original value preserved
    });
  });

  describe("sleep timers", () => {
    it("creates and retrieves a sleep timer", async () => {
      const run = await store.createRun({ workflowName: "sleep-wf", input: {} });
      const wakeAt = new Date(Date.now() + 5000);

      await store.createSleepTimer({
        workflowRunId: run.id,
        stepName: "nap",
        wakeAt,
      });

      const timer = await store.getSleepTimer(run.id, "nap");
      expect(timer).not.toBeNull();
      expect(timer!.stepName).toBe("nap");
      expect(timer!.wakeAt.getTime()).toBeCloseTo(wakeAt.getTime(), -2);
    });

    it("returns null for missing timer", async () => {
      const timer = await store.getSleepTimer(
        "00000000-0000-0000-0000-000000000000",
        "missing",
      );
      expect(timer).toBeNull();
    });
  });

  describe("cron schedules", () => {
    it("creates and retrieves due cron jobs", async () => {
      const nextRunAt = new Date(Date.now() - 1000); // already due
      await store.createCronSchedule({
        workflowName: "cron-wf",
        cronExpression: "0 9 * * 1",
        input: { batch: true },
        nextRunAt,
      });

      const due = await store.getDueCronJobs();
      const match = due.find((j) => j.workflowName === "cron-wf");
      expect(match).toBeTruthy();
      expect(match!.input).toEqual({ batch: true });
    });

    it("updates last run and next run", async () => {
      const schedule = await store.createCronSchedule({
        workflowName: "update-cron-wf",
        cronExpression: "*/5 * * * *",
        input: {},
        nextRunAt: new Date(Date.now() - 1000),
      });

      const now = new Date();
      const next = new Date(Date.now() + 300_000);
      await store.updateCronLastRun(schedule.id, now, next);

      const due = await store.getDueCronJobs();
      const match = due.find((j) => j.id === schedule.id);
      expect(match).toBeUndefined(); // no longer due
    });
  });

  describe("releaseRun + updateRunScheduledFor", () => {
    it("releases a run back to pending", async () => {
      await store.createRun({ workflowName: "release-wf", input: {} });
      const claimed = await store.claimNextRun("worker-1", ["release-wf"], 30_000);

      await store.releaseRun(claimed!.id);
      const fetched = await store.getRun(claimed!.id);
      expect(fetched!.status).toBe("pending");
      expect(fetched!.lockedBy).toBeNull();
    });

    it("updates scheduledFor for sleep", async () => {
      const run = await store.createRun({ workflowName: "sched-wf", input: {} });
      const future = new Date(Date.now() + 60_000);

      await store.updateRunScheduledFor(run.id, future);
      const fetched = await store.getRun(run.id);
      expect(fetched!.scheduledFor.getTime()).toBeCloseTo(future.getTime(), -2);
    });
  });
});
