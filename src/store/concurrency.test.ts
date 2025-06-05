import { describe, it, expect } from "vitest";
import { MemoryWorkflowStore } from "./memory-store.js";

describe("concurrency keys", () => {
  it("allows creating a run with a concurrency key", async () => {
    const store = new MemoryWorkflowStore();
    const run = await store.createRun({
      workflowName: "wf",
      input: {},
      concurrencyKey: "user:123",
    });
    expect(run).not.toBeNull();
    expect(run!.concurrencyKey).toBe("user:123");
  });

  it("rejects a second run with the same concurrency key while active", async () => {
    const store = new MemoryWorkflowStore();
    const run1 = await store.createRun({
      workflowName: "wf",
      input: {},
      concurrencyKey: "user:123",
    });
    expect(run1).not.toBeNull();

    const run2 = await store.createRun({
      workflowName: "wf",
      input: {},
      concurrencyKey: "user:123",
    });
    expect(run2).toBeNull();
  });

  it("allows a new run after the first completes", async () => {
    const store = new MemoryWorkflowStore();
    const run1 = await store.createRun({
      workflowName: "wf",
      input: {},
      concurrencyKey: "user:123",
    });
    expect(run1).not.toBeNull();

    await store.completeRun(run1!.id, { ok: true });

    const run2 = await store.createRun({
      workflowName: "wf",
      input: {},
      concurrencyKey: "user:123",
    });
    expect(run2).not.toBeNull();
    expect(run2!.id).not.toBe(run1!.id);
  });

  it("allows a new run after the first fails", async () => {
    const store = new MemoryWorkflowStore();
    const run1 = await store.createRun({
      workflowName: "wf",
      input: {},
      concurrencyKey: "user:123",
    });

    await store.failRun(run1!.id, "error");

    const run2 = await store.createRun({
      workflowName: "wf",
      input: {},
      concurrencyKey: "user:123",
    });
    expect(run2).not.toBeNull();
  });

  it("allows different concurrency keys", async () => {
    const store = new MemoryWorkflowStore();
    const run1 = await store.createRun({
      workflowName: "wf",
      input: {},
      concurrencyKey: "user:123",
    });
    const run2 = await store.createRun({
      workflowName: "wf",
      input: {},
      concurrencyKey: "user:456",
    });
    expect(run1).not.toBeNull();
    expect(run2).not.toBeNull();
  });
});
