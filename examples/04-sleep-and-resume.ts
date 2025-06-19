/**
 * 04-sleep-and-resume.ts
 *
 * Demonstrates durable sleep: a workflow runs a step, sleeps for 1 second,
 * then runs another step. The sleep is durable  it would survive process
 * restarts in production (backed by the store).
 *
 * Run: npx tsx examples/04-sleep-and-resume.ts
 */

import pino from "pino";
import {
  defineWorkflow,
  DurableEngine,
  MemoryWorkflowStore,
} from "../src/index.js";

const sleepWorkflow = defineWorkflow("sleep-demo", async (ctx) => {
  const before = await ctx.step("before-sleep", {
    run: () => {
      const ts = new Date().toISOString();
      console.log(`  [step] before-sleep completed at ${ts}`);
      return { timestamp: ts };
    },
  });

  console.log("  [workflow] Sleeping for 1 second...");
  await ctx.sleep("nap", { milliseconds: 1_000 });
  console.log("  [workflow] Woke up from sleep!");

  const after = await ctx.step("after-sleep", {
    run: () => {
      const ts = new Date().toISOString();
      console.log(`  [step] after-sleep completed at ${ts}`);
      return { timestamp: ts };
    },
  });

  return { before: before.timestamp, after: after.timestamp };
});

const engine = new DurableEngine({
  pool: {} as any,
  workflows: [sleepWorkflow],
  worker: { pollIntervalMs: 200 },
  logger: pino({ level: "silent" }),
});

engine.setStore(new MemoryWorkflowStore());

async function main() {
  console.log("=== Sleep & Resume Example ===\n");

  await engine.start();
  console.log("Engine started.\n");

  const handle = await engine.trigger(sleepWorkflow, { input: {} });
  console.log(`Triggered workflow run: ${handle.workflowRunId}\n`);

  // Poll and show status transitions
  const deadline = Date.now() + 15_000;
  let status = await engine.getStatus(handle.workflowRunId);
  let lastPrinted = "";

  while (status?.status !== "completed" && Date.now() < deadline) {
    if (status?.status !== lastPrinted) {
      console.log(`  [poll] Status: ${status?.status}`);
      lastPrinted = status?.status ?? "";
    }
    await new Promise((r) => setTimeout(r, 200));
    status = await engine.getStatus(handle.workflowRunId);
  }

  console.log(`\nFinal status: ${status?.status}`);
  if (status?.status === "completed") {
    const result = status.result as { before: string; after: string };
    console.log(`  Started at:  ${result.before}`);
    console.log(`  Resumed at:  ${result.after}`);

    const diff =
      new Date(result.after).getTime() - new Date(result.before).getTime();
    console.log(`  Sleep duration: ~${diff}ms`);
  }

  await engine.stop();
  console.log("\nEngine stopped.");
  process.exit(0);
}

main();
