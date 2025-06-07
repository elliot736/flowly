import { describe, it, expect } from "vitest";
import { getRetryDelay, getMaxAttempts, withRetry } from "./retry.js";

describe("getRetryDelay", () => {
  it("returns 0 for attempt 0", () => {
    expect(getRetryDelay({ maxAttempts: 3, backoff: "exponential" }, 0)).toBe(0);
  });

  it("calculates exponential backoff", () => {
    const policy = { maxAttempts: 5, backoff: "exponential" as const, initialDelayMs: 100, factor: 2 };
    expect(getRetryDelay(policy, 1)).toBe(200);   // 100 * 2^1
    expect(getRetryDelay(policy, 2)).toBe(400);   // 100 * 2^2
    expect(getRetryDelay(policy, 3)).toBe(800);   // 100 * 2^3
  });

  it("calculates fixed backoff", () => {
    const policy = { backoff: "fixed" as const, initialDelayMs: 500 };
    expect(getRetryDelay(policy, 1)).toBe(500);
    expect(getRetryDelay(policy, 2)).toBe(500);
    expect(getRetryDelay(policy, 3)).toBe(500);
  });

  it("calculates linear backoff", () => {
    const policy = { backoff: "linear" as const, initialDelayMs: 100 };
    expect(getRetryDelay(policy, 1)).toBe(200);   // 100 * 2
    expect(getRetryDelay(policy, 2)).toBe(300);   // 100 * 3
    expect(getRetryDelay(policy, 3)).toBe(400);   // 100 * 4
  });

  it("caps at maxDelayMs", () => {
    const policy = { backoff: "exponential" as const, initialDelayMs: 1000, maxDelayMs: 5000, factor: 10 };
    expect(getRetryDelay(policy, 3)).toBe(5000);
  });

  it("uses defaults for undefined policy", () => {
    expect(getRetryDelay(undefined, 1)).toBe(2000); // default: 1000 * 2^1
  });
});

describe("getMaxAttempts", () => {
  it("returns 1 for undefined policy", () => {
    expect(getMaxAttempts(undefined)).toBe(1);
  });

  it("returns configured value", () => {
    expect(getMaxAttempts({ maxAttempts: 5 })).toBe(5);
  });
});

describe("withRetry", () => {
  it("returns on first success", async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      return "ok";
    }, { maxAttempts: 3 });

    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on failure and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return "ok";
    }, { maxAttempts: 3, initialDelayMs: 1 });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws after all retries exhausted", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        throw new Error("always fails");
      }, { maxAttempts: 2, initialDelayMs: 1 }),
    ).rejects.toThrow("always fails");

    expect(calls).toBe(2);
  });

  it("respects abort signal", async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      withRetry(() => "ok", { maxAttempts: 3 }, ac.signal),
    ).rejects.toThrow("Aborted");
  });
});
