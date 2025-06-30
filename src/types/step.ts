// ── Step Types ───────────────────────────────────────────────────────

export interface StepOptions<T> {
  /** The function to execute for this step. */
  run: () => T | Promise<T>;
  /** Compensation function called during saga rollback. Receives the step's result. */
  compensate?: (result: T) => void | Promise<void>;
  /** Retry policy for this step. */
  retry?: RetryPolicy;
  /** Timeout in milliseconds for this step. */
  timeoutMs?: number;
}

export interface RetryPolicy {
  /** Maximum number of attempts (including the first). Default: 1 (no retry). */
  maxAttempts?: number;
  /** Backoff strategy. Default: "exponential". */
  backoff?: "fixed" | "exponential" | "linear";
  /** Initial delay in milliseconds before the first retry. Default: 1000. */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds between retries. Default: 30000. */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff. Default: 2. */
  factor?: number;
}

export interface Duration {
  milliseconds?: number;
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
}

/** Resolve a Duration to total milliseconds. */
export function durationToMs(d: Duration): number {
  const ms =
    (d.milliseconds ?? 0) +
    (d.seconds ?? 0) * 1_000 +
    (d.minutes ?? 0) * 60_000 +
    (d.hours ?? 0) * 3_600_000 +
    (d.days ?? 0) * 86_400_000;
  return ms;
}
