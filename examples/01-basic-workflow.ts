/**
 * 01-basic-workflow.ts
 *
 * The simplest possible durable workflow: two steps that run in sequence.
 * Demonstrates defineWorkflow, DurableEngine setup with MemoryWorkflowStore,
 * triggering a run, and polling for completion.
 *
 * Run: npx tsx examples/01-basic-workflow.ts
 */

import pino from "pino";
import {
  defineWorkflow,
  DurableEngine,
  MemoryWorkflowStore,
} from "../src/index.js";

// 1. Define a workflow with two steps
const greetWorkflow = defineWorkflow(
  "greet",
  async (ctx, input: { name: string }) => {
    const greeting = await ctx.step("create-greeting", {
      run: () => {
        console.log('  [step] Creating greeting...');
        return `Hello, ${input.name}!`;
      },
    });

    const shout = await ctx.step("shout-greeting", {
      run: () => {
        console.log('  [step] Shouting greeting...');
        return greeting.toUpperCase();
      },
    });

    return { greeting, shout };
  },
);

// 2. Create the engine with a silent logger (suppress library logs)
const engine = new DurableEngine({
  pool: {} as any, // not used with MemoryWorkflowStore
  workflows: [greetWorkflow],
  worker: { pollIntervalMs: 100 },
  logger: pino({ level: "silent" }),
});

// 3. Wire up MemoryWorkflowStore (no Postgres needed)
engine.setStore(new MemoryWorkflowStore());

async function main() {
  console.log("=== Basic Workflow Example ===\n");

  // 4. Start the engine (begins polling for work)
  await engine.start();
  console.log("Engine started.\n");

  // 5. Trigger the workflow
  const handle = await engine.trigger(greetWorkflow, {
    input: { name: "World" },
  });
  console.log(`Triggered workflow run: ${handle.workflowRunId}\n`);

  // 6. Poll until the workflow completes
  const deadline = Date.now() + 10_000;
  let status = await engine.getStatus(handle.workflowRunId);

  while (status?.status !== "completed" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    status = await engine.getStatus(handle.workflowRunId);
  }

  // 7. Print the result
  console.log(`\nFinal status: ${status?.status}`);
  if (status?.status === "completed") {
    console.log("Result:", status.result);
  }

  await engine.stop();
  console.log("\nEngine stopped.");
  process.exit(0);
}

main();
