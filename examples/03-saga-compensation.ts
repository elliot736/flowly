/**
 * 03-saga-compensation.ts
 *
 * Demonstrates the saga pattern with compensation. An order processing
 * workflow has three steps:
 *   1. Reserve inventory
 *   2. Charge payment
 *   3. Ship order (fails!)
 *
 * When step 3 fails, compensation runs in reverse order:
 *   - Refund payment (compensates step 2)
 *   - Release inventory (compensates step 1)
 *
 * Run: npx tsx examples/03-saga-compensation.ts
 */

import pino from "pino";
import {
  defineWorkflow,
  DurableEngine,
  MemoryWorkflowStore,
} from "../src/index.js";

const compensationLog: string[] = [];

const orderWorkflow = defineWorkflow(
  "process-order",
  async (ctx, input: { orderId: string; item: string; amount: number }) => {
    // Step 1: Reserve inventory
    const reservation = await ctx.step("reserve-inventory", {
      run: () => {
        console.log(`  [step] Reserving inventory for "${input.item}"...`);
        return { reservationId: "RES-001", item: input.item };
      },
      compensate: (result) => {
        console.log(
          `  [compensate] Releasing inventory reservation ${result.reservationId}`,
        );
        compensationLog.push(`Released reservation ${result.reservationId}`);
      },
    });

    // Step 2: Charge payment
    const payment = await ctx.step("charge-payment", {
      run: () => {
        console.log(
          `  [step] Charging $${input.amount} for order ${input.orderId}...`,
        );
        return { transactionId: "TXN-42", amount: input.amount };
      },
      compensate: (result) => {
        console.log(
          `  [compensate] Refunding $${result.amount} (txn: ${result.transactionId})`,
        );
        compensationLog.push(
          `Refunded $${result.amount} (${result.transactionId})`,
        );
      },
    });

    // Step 3: Ship order  this will FAIL
    await ctx.step("ship-order", {
      run: () => {
        console.log("  [step] Attempting to ship order...");
        throw new Error("Shipping service unavailable!");
      },
    });

    return { reservation, payment };
  },
);

const engine = new DurableEngine({
  pool: {} as any,
  workflows: [orderWorkflow],
  worker: { pollIntervalMs: 100 },
  logger: pino({ level: "silent" }),
});

engine.setStore(new MemoryWorkflowStore());

async function main() {
  console.log("=== Saga Compensation Example ===\n");

  await engine.start();
  console.log("Engine started.\n");

  const handle = await engine.trigger(orderWorkflow, {
    input: { orderId: "ORD-123", item: "Widget", amount: 49.99 },
  });
  console.log(`Triggered workflow run: ${handle.workflowRunId}\n`);

  // Poll until compensated or failed
  const deadline = Date.now() + 10_000;
  let status = await engine.getStatus(handle.workflowRunId);

  while (
    status?.status !== "compensated" &&
    status?.status !== "failed" &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 100));
    status = await engine.getStatus(handle.workflowRunId);
  }

  console.log(`\nFinal status: ${status?.status}`);
  console.log("\nCompensation log (should be in reverse order):");
  for (const entry of compensationLog) {
    console.log(`  - ${entry}`);
  }

  await engine.stop();
  console.log("\nEngine stopped.");
  process.exit(0);
}

main();
