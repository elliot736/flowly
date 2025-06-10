import { describe, it, expect } from "vitest";
import { HookEmitter } from "./hooks.js";

describe("HookEmitter", () => {
  it("emits events to listeners", async () => {
    const emitter = new HookEmitter();
    const received: any[] = [];

    emitter.on("workflow:started", (payload) => {
      received.push(payload);
    });

    await emitter.emit("workflow:started", { runId: "r1", workflowName: "wf1" });

    expect(received).toEqual([{ runId: "r1", workflowName: "wf1" }]);
  });

  it("handles multiple listeners", async () => {
    const emitter = new HookEmitter();
    let count = 0;

    emitter.on("step:completed", () => { count++; });
    emitter.on("step:completed", () => { count++; });

    await emitter.emit("step:completed", {
      runId: "r1",
      workflowName: "wf1",
      stepName: "s1",
      result: null,
    });

    expect(count).toBe(2);
  });

  it("does not throw when a listener throws", async () => {
    const emitter = new HookEmitter();
    const received: string[] = [];

    emitter.on("workflow:failed", () => {
      throw new Error("bad listener");
    });
    emitter.on("workflow:failed", (p) => {
      received.push(p.error);
    });

    await emitter.emit("workflow:failed", {
      runId: "r1",
      workflowName: "wf1",
      error: "oops",
    });

    expect(received).toEqual(["oops"]);
  });

  it("removes a listener with off", async () => {
    const emitter = new HookEmitter();
    let count = 0;
    const cb = () => { count++; };

    emitter.on("workflow:completed", cb);
    await emitter.emit("workflow:completed", {
      runId: "r1",
      workflowName: "wf1",
      result: null,
    });
    expect(count).toBe(1);

    emitter.off("workflow:completed", cb);
    await emitter.emit("workflow:completed", {
      runId: "r1",
      workflowName: "wf1",
      result: null,
    });
    expect(count).toBe(1);
  });

  it("removes all listeners", async () => {
    const emitter = new HookEmitter();
    let count = 0;

    emitter.on("workflow:started", () => { count++; });
    emitter.on("workflow:completed", () => { count++; });

    emitter.removeAll();

    await emitter.emit("workflow:started", { runId: "r1", workflowName: "wf1" });
    await emitter.emit("workflow:completed", { runId: "r1", workflowName: "wf1", result: null });

    expect(count).toBe(0);
  });
});
