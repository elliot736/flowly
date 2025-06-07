import type { RetryPolicy } from "../types/index.js";
import type { Logger } from "../logger.js";

const DEFAULTS: Required<RetryPolicy> = {
  maxAttempts: 1,
  backoff: "exponential",
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  factor: 2,
};

/** Calculate the delay before a given retry attempt (0-indexed). */
export function getRetryDelay(policy: RetryPolicy | undefined, attempt: number): number {
  const p = { ...DEFAULTS, ...policy };
  if (attempt <= 0) return 0;

  let delay: number;
  switch (p.backoff) {
    case "fixed":
      delay = p.initialDelayMs;
      break;
    case "linear":
      delay = p.initialDelayMs * (attempt + 1);
      break;
    case "exponential":
      delay = p.initialDelayMs * Math.pow(p.factor, attempt);
      break;
  }
  return Math.min(delay, p.maxDelayMs);
}

/** Get the maximum number of attempts from a policy. */
export function getMaxAttempts(policy: RetryPolicy | undefined): number {
  return policy?.maxAttempts ?? DEFAULTS.maxAttempts;
}

/** Execute a function with retry logic. Returns the result or throws the last error. */
export async function withRetry<T>(
  fn: () => T | Promise<T>,
  policy: RetryPolicy | undefined,
  signal?: AbortSignal,
  log?: Logger,
): Promise<T> {
  const maxAttempts = getMaxAttempts(policy);
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");

    if (attempt > 0) {
      const delay = getRetryDelay(policy, attempt - 1);
      log?.warn({ attempt: attempt + 1, maxAttempts, delayMs: delay, err: lastError }, "retrying step");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        }, { once: true });
      });
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}
