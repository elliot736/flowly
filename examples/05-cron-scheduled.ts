/**
 * 05-cron-scheduled.ts
 *
 * Demonstrates cron-scheduled workflows. A simple health-check workflow
 * is scheduled to run every minute using a cron expression. The example
 * waits for the cron manager to create a run, then stops.
 *
 * Run: npx tsx examples/05-cron-scheduled.ts
 */

import pino from "pino";
import {
  defineWorkflow,
  DurableEngine,
  MemoryWorkflowStore,
} from "../src/index.js";

let runCount = 0;

const healthCheckWorkflow = defineWorkflow(
  "health-check",
  async (ctx) => {
    runCount++;
    const result = await ctx.step("check-services", {
      run: () => {
        const ts = new Date().toISOString();
        console.log(`  [step] Health check #${runCount} at ${ts}`);
        return {
          database: "healthy",
          cache: "healthy",
          api: "healthy",
          checkedAt: ts,
        };
      },
    });

    return result;
  },
);

const store = new MemoryWorkflowStore();

const engine = new DurableEngine({
  pool: {} as any,
  workflows: [healthCheckWorkflow],
  worker: { pollIntervalMs: 200 },
  logger: pino({ level: "silent" }),
});

engine.setStore(store);

async function main() {
  console.log("=== Cron Scheduled Workflow Example ===\n");

  await engine.start();
  console.log("Engine started.\n");

  // Schedule the workflow to run every minute
  await engine.schedule(healthCheckWorkflow, {
    cron: "* * * * *", // every minute
    input: {},
  });
  console.log('Scheduled "health-check" with cron: "* * * * *" (every minute)');
  console.log("Waiting for the cron manager to create a run...\n");

  // Wait for at least one cron-triggered run to complete
  const deadline = Date.now() + 90_000; // wait up to 90 seconds
  let found = false;
  let lastNextRun = "";

  while (!found && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));

    // Check all runs in the store for completed ones
    for (const run of store.runs.values()) {
      if (run.workflowName === "health-check" && run.status === "completed") {
        found = true;
        console.log(`Cron-triggered run completed: ${run.id}`);
        console.log("Result:", run.result);
        break;
      }
    }

    if (!found) {
      // Show cron schedule state only when it changes
      for (const schedule of store.cronSchedules.values()) {
        const next = schedule.nextRunAt.toISOString();
        if (next !== lastNextRun) {
          const last = schedule.lastRunAt?.toISOString() ?? "never";
          console.log(`  [cron] Next run at: ${next} | Last run: ${last}`);
          lastNextRun = next;
        }
      }
    }
  }

  if (!found) {
    console.log("Timed out waiting for cron run. The cron expression may");
    console.log("not have been due yet within the wait period.");
  }

  console.log(`\nTotal health check runs: ${runCount}`);

  await engine.stop();
  console.log("Engine stopped.");
  process.exit(0);
}

main();
