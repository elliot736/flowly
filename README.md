# flowly

Durable workflow engine for TypeScript, backed by Postgres. Zero infrastructure just `npm install` and pass a `pg.Pool`.

Define workflows as plain async functions. Each step is persisted to Postgres. If the process crashes, the workflow resumes from the last completed step.

## Features

- **Workflows as functions** no DSL, no YAML, no framework to learn
- **Step persistence** completed steps are saved and replayed on resume
- **Retries** configurable per step (exponential, linear, fixed backoff)
- **Compensation (sagas)** automatic rollback of completed steps on failure
- **Durable sleep** `ctx.sleep()` survives process restarts
- **Cron scheduling** recurring workflows via cron expressions
- **Concurrent workers** multiple workers with lease-based locking and `FOR UPDATE SKIP LOCKED`
- **Zero infrastructure** just Postgres, no separate server or message broker

## Install

```bash
npm install flowly pg
```

## Quick Start

```ts
import { defineWorkflow, DurableEngine } from "flowly";
import pg from "pg";

// Define a workflow
const orderWorkflow = defineWorkflow(
  "process-order",
  async (ctx, input: { orderId: string; amount: number }) => {
    // Each step is persisted. On resume, completed steps return saved results.
    const reserved = await ctx.step("reserve-inventory", {
      run: () => inventoryService.reserve(input.orderId),
      compensate: (result) => inventoryService.release(result.reservationId),
      retry: { maxAttempts: 3, backoff: "exponential", initialDelayMs: 500 },
    });

    // Durable sleep  process can restart, timer survives
    await ctx.sleep("cooling-period", { seconds: 30 });

    const charged = await ctx.step("charge-payment", {
      run: () => paymentService.charge(input.amount),
      compensate: (result) => paymentService.refund(result.chargeId),
    });

    await ctx.step("send-confirmation", {
      run: () => emailService.send(input.orderId, charged.receiptUrl),
    });

    return { orderId: input.orderId, receiptUrl: charged.receiptUrl };
  },
);

// Boot the engine
const engine = new DurableEngine({
  pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  workflows: [orderWorkflow],
});

await engine.migrate(); // creates tables
await engine.start(); // starts polling

// Trigger a workflow
const handle = await engine.trigger(orderWorkflow, {
  input: { orderId: "ord_123", amount: 9900 },
});

// Check status
const status = await engine.getStatus(handle.workflowRunId);

// Graceful shutdown
await engine.stop();
```

## API

### `defineWorkflow(name, fn)`

Creates a workflow definition. The function receives a `WorkflowContext` and the input.

### `WorkflowContext`

| Method                       | Description                                                |
| ---------------------------- | ---------------------------------------------------------- |
| `ctx.step(name, opts)`       | Execute a named step. On replay, returns the saved result. |
| `ctx.sleep(name, duration)`  | Pause for a duration. Durable survives restarts.           |
| `ctx.sleepUntil(name, date)` | Pause until a specific timestamp.                          |
| `ctx.workflowRunId`          | The unique ID of this workflow run.                        |
| `ctx.attempt`                | Current attempt number (starts at 1).                      |

### `StepOptions`

```ts
{
  run: () => T | Promise<T>;                    // The function to execute
  compensate?: (result: T) => void | Promise<void>;  // Rollback on failure
  retry?: {
    maxAttempts?: number;       // default: 1
    backoff?: "fixed" | "exponential" | "linear";
    initialDelayMs?: number;    // default: 1000
    maxDelayMs?: number;        // default: 30000
    factor?: number;            // default: 2
  };
  timeoutMs?: number;           // per-step timeout
}
```

### `DurableEngine`

```ts
const engine = new DurableEngine({
  pool: pg.Pool,                  // your Postgres pool
  workflows: WorkflowDefinition[],
  schema?: string,                // default: "durable_workflow"
  worker?: {
    pollIntervalMs?: number,      // default: 1000
    maxConcurrent?: number,       // default: 5
    leaseMs?: number,             // default: 30000
    workerId?: string,            // default: auto-generated
  },
});
```

| Method                            | Description                                         |
| --------------------------------- | --------------------------------------------------- |
| `engine.migrate()`                | Create schema and tables (idempotent).              |
| `engine.start()`                  | Start the worker and cron manager.                  |
| `engine.stop()`                   | Graceful shutdown waits for in-flight workflows.    |
| `engine.trigger(workflow, opts)`  | Start a workflow. Returns `{ workflowRunId }`.      |
| `engine.schedule(workflow, opts)` | Set up a recurring workflow with a cron expression. |
| `engine.getStatus(runId)`         | Get the current status of a workflow run.           |

### Scheduling

```ts
// Delayed execution
await engine.trigger(orderWorkflow, {
  input: { orderId: "ord_456", amount: 4900 },
  scheduledFor: new Date("2026-04-01T00:00:00Z"),
});

// Recurring via cron
await engine.schedule(orderWorkflow, {
  cron: "0 9 * * 1", // every Monday at 9am
  input: { orderId: "weekly-batch", amount: 0 },
});
```

## How It Works

### Step Persistence & Replay

When a workflow runs, each `ctx.step()` call saves its result to Postgres. If the process crashes and the workflow is re-executed, completed steps return their saved results without re-running.

### Compensation (Sagas)

If a step fails after retries are exhausted, previously completed steps are compensated in reverse order:

```
step-1 ✓ → step-2 ✓ → step-3 ✗
                              ↓
                    compensate step-2
                    compensate step-1
```

### Durable Sleep

`ctx.sleep()` persists a timer to Postgres, then releases the workflow. The worker picks it up again after the timer expires. Sleep survives process restarts.

### Concurrency

Multiple workers can run simultaneously. Work is distributed via `FOR UPDATE SKIP LOCKED` no advisory locks, no contention. Each worker holds a lease that it extends with heartbeats.

### Crash Recovery

If a worker crashes mid-step:

1. The step result was never saved (incomplete)
2. The lease expires after 30 seconds
3. Another worker picks up the workflow
4. Completed steps are replayed, the incomplete step re-executes

Steps should be idempotent or use external idempotency keys.

## Database Schema

Four tables in a configurable schema (default `durable_workflow`):

- `workflow_runs` workflow state, input, result, locking
- `workflow_steps` per-step results and status
- `sleep_timers` durable sleep state
- `cron_schedules` recurring workflow configuration

## Testing

```bash
# Unit tests (no Postgres required)
npm test

# Integration tests (requires Docker)
npm run test:integration
```

The library exports `MemoryWorkflowStore` for testing workflows without Postgres:

```ts
import { MemoryWorkflowStore } from "flowly";

const store = new MemoryWorkflowStore();
engine.setStore(store);
```

## Architecture

### Class Diagram

![Class Diagram](docs/class-diagram.png)

### Component Diagram

![Component Diagram](docs/component-diagram.png)

### Sequence Diagram

![Sequence Diagram](docs/sequence-diagram.png)

## License

MIT
