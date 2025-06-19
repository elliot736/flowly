/**
 * 02-retry-and-timeout.ts
 *
 * Demonstrates retry policies and step timeouts:
 * - A flaky step that fails twice before succeeding, using exponential backoff.
 * - A step with a timeout that succeeds within its deadline.
 *
 * Run: npx tsx examples/02-retry-and-timeout.ts
 */

import pino from "pino";
import {
  defineWorkflow,
  DurableEngine,
  MemoryWorkflowStore,
} from "../src/index.js";

let flakyCallCount = 0;

const retryWorkflow = defineWorkflow(
  "retry-demo",
  async (ctx) => {
    // Step 1: Flaky operation that fails twice, then succeeds
    const result = await ctx.step("flaky-api-call", {
      run: () => {
        flakyCallCount++;
        console.log(`  [step] flaky-api-call attempt #${flakyCallCount}`);
        if (flakyCallCount < 3) {
          throw new Error(`Temporary failure (attempt ${flakyCallCount})`);
        }
        return { data: "success on attempt 3" };
      },
      retry: {
        maxAttempts: 5,
        backoff: "exponential",
        initialDelayMs: 50,  // short delays for demo
        maxDelayMs: 500,
        factor: 2,
      },
    });

    console.log(`  [step] flaky-api-call returned:`, result);

    // Step 2: A step with a generous timeout (will succeed in time)
    const fast = await ctx.step("fast-operation", {
      run: async () => {
        console.log("  [step] fast-operation running (50ms work)...");
        await new Promise((r) => setTimeout(r, 50));
        return "completed quickly";
      },
      timeoutMs: 5_000, // 5 second timeout, plenty of room
    });

    console.log(`  [step] fast-operation returned: "${fast}"`);

    return { flakyResult: result, fastResult: fast };
  },
);

const engine = new DurableEngine({
  pool: {} as any,
  workflows: [retryWorkflow],
  worker: { pollIntervalMs: 100 },
  logger: pino({ level: "silent" }),
});

engine.setStore(new MemoryWorkflowStore());

async function main() {
  console.log("=== Retry & Timeout Example ===\n");

  await engine.start();
  console.log("Engine started.\n");

  const handle = await engine.trigger(retryWorkflow, { input: {} });
  console.log(`Triggered workflow run: ${handle.workflowRunId}\n`);

  // Poll until completed or failed
  const deadline = Date.now() + 15_000;
  let status = await engine.getStatus(handle.workflowRunId);

  while (
    status?.status !== "completed" &&
    status?.status !== "failed" &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 200));
    status = await engine.getStatus(handle.workflowRunId);
  }

  console.log(`\nFinal status: ${status?.status}`);
  if (status?.status === "completed") {
    console.log("Result:", status.result);
  } else if (status?.status === "failed") {
    console.log("Error:", status.error);
  }

  await engine.stop();
  console.log("\nEngine stopped.");
  process.exit(0);
}

main();
