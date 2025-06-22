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

```plantuml
@startuml class-diagram
skinparam classAttributeIconSize 0
skinparam linetype ortho
hide empty members

title Flowly / Durable Workflow Engine — Class Diagram

' ──────────────────────────────────────────────
'  Type Definitions
' ──────────────────────────────────────────────

interface WorkflowContext {
  +workflowRunId: string
  +attempt: number
  --
  +step<T>(name, opts): Promise<T>
  +sleep(name, duration): Promise<void>
  +sleepUntil(name, until): Promise<void>
  +sideEffect<T>(name, fn): Promise<T>
  +emit(event, data?): Promise<void>
  +workflow<I,O>(def, input): Promise<O>
}

class WorkflowDefinition<TInput, TOutput> <<interface>> {
  +name: string
  +fn: WorkflowFn<TInput, TOutput>
}

class StepOptions<T> <<interface>> {
  +run: () => T | Promise<T>
  +compensate?: (result: T) => void | Promise<void>
  +retry?: RetryPolicy
  +timeoutMs?: number
}

class RetryPolicy <<interface>> {
  +maxAttempts?: number
  +backoff?: "fixed" | "exponential" | "linear"
  +initialDelayMs?: number
  +maxDelayMs?: number
  +factor?: number
}

class Duration <<interface>> {
  +milliseconds?: number
  +seconds?: number
  +minutes?: number
  +hours?: number
  +days?: number
}

class EngineConfig <<interface>> {
  +pool: Pool
  +workflows: WorkflowDefinition[]
  +schema?: string
  +worker?: WorkerConfig
  +logger?: Logger
}

class WorkerConfig <<interface>> {
  +pollIntervalMs?: number
  +maxConcurrent?: number
  +leaseMs?: number
  +workerId?: string
  +shutdownTimeoutMs?: number
  +useNotify?: boolean
}

enum RunStatus {
  pending
  running
  completed
  failed
  compensating
  compensated
  cancelled
  dead_letter
}

enum StepStatus {
  pending
  running
  completed
  failed
  compensated
}

' ──────────────────────────────────────────────
'  Engine
' ──────────────────────────────────────────────

class DurableEngine {
  -pool: Pool
  -schema: string
  -workflows: Map<string, WorkflowDefinition>
  -workerConfig: Required<WorkerConfig>
  -store: WorkflowStore | null
  -worker: Worker | null
  -cronManager: CronManager | null
  -hooks: HookEmitter
  -eventListeners: Map<string, Callback[]>
  -anyEventListeners: Callback[]
  --
  +constructor(config: EngineConfig)
  +migrate(): Promise<void>
  +setStore(store: WorkflowStore): void
  +start(): Promise<void>
  +stop(): Promise<void>
  +trigger<I>(def, opts): Promise<WorkflowHandle | null>
  +schedule<I>(def, opts): Promise<void>
  +getStatus(runId): Promise<WorkflowRunStatus | null>
  +cancel(runId): Promise<void>
  +healthCheck(): Promise<HealthCheckResult>
  +hook(event, callback): void
  +unhook(event, callback): void
  +on(eventName, callback): void
  +onAny(callback): void
  +getEvents(runId): Promise<WorkflowEvent[]>
  +getDeadLetterRuns(): Promise<WorkflowRun[]>
  +retryDeadLetter(runId): Promise<void>
}

class TriggerOptions<TInput> <<interface>> {
  +input: TInput
  +scheduledFor?: Date
  +timeoutMs?: number
  +concurrencyKey?: string
  +maxAttempts?: number
}

class WorkflowHandle <<interface>> {
  +workflowRunId: string
}

class HealthCheckResult <<interface>> {
  +healthy: boolean
  +inflight: number
  +dbConnected: boolean
  +uptime: number
}

' ──────────────────────────────────────────────
'  Worker
' ──────────────────────────────────────────────

class Worker {
  -running: boolean
  -inflight: number
  -pollTimer: Timeout | null
  -heartbeatTimers: Map<string, Interval>
  -abortControllers: Map<string, AbortController>
  -inflightPromises: Map<string, Promise<void>>
  -notifyClient: PoolClient | null
  --
  +constructor(opts: WorkerOptions)
  +start(): void
  +stop(): Promise<void>
  +abortRun(runId): boolean
  +getInflight(): number
  +triggerPoll(): void
  -setupNotify(): Promise<void>
  -poll(): void
  -tryClaimAndExecute(): Promise<void>
  -waitForDrain(timeoutMs): Promise<void>
}

' ──────────────────────────────────────────────
'  Executor
' ──────────────────────────────────────────────

class WorkflowContextImpl implements WorkflowContext {
  +workflowRunId: string
  +attempt: number
  -sequence: number
  -completedSteps: Map<string, StepRecord>
  +compensations: CompensationEntry[]
  --
  +step<T>(name, opts): Promise<T>
  +sideEffect<T>(name, fn): Promise<T>
  +emit(event, data?): Promise<void>
  +workflow<I,O>(def, input): Promise<O>
  +sleep(name, duration): Promise<void>
  +sleepUntil(name, until): Promise<void>
  -executeWithTimeout<T>(stepName, fn, timeoutMs?): Promise<T>
}

class SleepInterrupt {
  +stepName: string
  +wakeAt: Date
}

class CompensationEntry <<interface>> {
  +stepName: string
  +sequence: number
  +compensate: () => Promise<void>
}

class ExecutionResult <<interface>> {
  +outcome: "completed" | "sleeping" | "failed" | "compensated" | "retrying" | "dead_letter"
  +result?: unknown
  +error?: string
  +sleepUntil?: Date
}

' ──────────────────────────────────────────────
'  Store
' ──────────────────────────────────────────────

interface WorkflowStore {
  +createRun(params): Promise<WorkflowRun | null>
  +claimNextRun(workerId, names, leaseMs): Promise<WorkflowRun | null>
  +extendLease(runId, workerId, leaseMs): Promise<boolean>
  +completeRun(runId, result): Promise<void>
  +failRun(runId, error): Promise<void>
  +updateRunStatus(runId, status): Promise<void>
  +updateRunScheduledFor(runId, date): Promise<void>
  +releaseRun(runId): Promise<void>
  +getRun(runId): Promise<WorkflowRun | null>
  +cancelRun(runId): Promise<void>
  +getChildRuns(parentRunId): Promise<WorkflowRun[]>
  +getRunsByStatus(status): Promise<WorkflowRun[]>
  +incrementAttemptAndReset(runId): Promise<void>
  +setDeadLetter(runId, error): Promise<void>
  +getCompletedSteps(runId): Promise<StepRecord[]>
  +saveStep(params): Promise<StepRecord>
  +updateStepStatus(runId, stepName, status): Promise<void>
  +createSleepTimer(params): Promise<void>
  +getSleepTimer(runId, stepName): Promise<SleepTimer | null>
  +createCronSchedule(params): Promise<CronSchedule>
  +getDueCronJobs(now?): Promise<CronSchedule[]>
  +updateCronLastRun(id, lastRunAt, nextRunAt): Promise<void>
  +saveEvent(params): Promise<WorkflowEvent>
  +getEvents(runId): Promise<WorkflowEvent[]>
  +getNewEvents(sinceId?): Promise<WorkflowEvent[]>
  +ping(): Promise<boolean>
}

class PostgresWorkflowStore implements WorkflowStore {
  -pool: Pool
  -schema: string
  --
  Uses FOR UPDATE SKIP LOCKED
}

class MemoryWorkflowStore implements WorkflowStore {
  -runs: Map<string, WorkflowRun>
  -steps: Map<string, StepRecord[]>
  -sleepTimers: Map<string, SleepTimer[]>
  -cronSchedules: Map<string, CronSchedule>
  -events: WorkflowEvent[]
}

' ──────────────────────────────────────────────
'  Data Models
' ──────────────────────────────────────────────

class WorkflowRun <<entity>> {
  +id: string
  +workflowName: string
  +input: unknown
  +status: RunStatus
  +result: unknown | null
  +error: string | null
  +scheduledFor: Date
  +startedAt: Date | null
  +completedAt: Date | null
  +lockedBy: string | null
  +lockedUntil: Date | null
  +timeoutAt: Date | null
  +attempt: number
  +maxAttempts: number
  +concurrencyKey: string | null
  +parentRunId: string | null
  +createdAt: Date
  +updatedAt: Date
}

class StepRecord <<entity>> {
  +id: string
  +workflowRunId: string
  +stepName: string
  +sequence: number
  +status: StepStatus
  +result: unknown | null
  +error: string | null
  +attempts: number
  +hasCompensate: boolean
  +startedAt: Date | null
  +completedAt: Date | null
}

class SleepTimer <<entity>> {
  +id: string
  +workflowRunId: string
  +stepName: string
  +wakeAt: Date
  +completed: boolean
}

class CronSchedule <<entity>> {
  +id: string
  +workflowName: string
  +cronExpression: string
  +input: unknown
  +enabled: boolean
  +lastRunAt: Date | null
  +nextRunAt: Date
  +createdAt: Date
}

class WorkflowEvent <<entity>> {
  +id: string
  +workflowRunId: string
  +event: string
  +data: unknown
  +createdAt: Date
}

' ──────────────────────────────────────────────
'  Hooks
' ──────────────────────────────────────────────

class HookEmitter {
  -listeners: Map<string, Callback[]>
  --
  +on<K>(event, callback): void
  +off<K>(event, callback): void
  +emit<K>(event, payload): Promise<void>
  +removeAll(): void
}

class HookEvents <<interface>> {
  +"workflow:started": {runId, workflowName}
  +"workflow:completed": {runId, workflowName, result}
  +"workflow:failed": {runId, workflowName, error}
  +"workflow:compensated": {runId, workflowName}
  +"step:started": {runId, workflowName, stepName}
  +"step:completed": {runId, workflowName, stepName, result}
  +"step:failed": {runId, workflowName, stepName, error}
}

' ──────────────────────────────────────────────
'  Schedule
' ──────────────────────────────────────────────

class CronManager {
  -running: boolean
  -timer: Timeout | null
  --
  +constructor(opts: CronManagerOptions)
  +start(): void
  +stop(): void
  -poll(): void
  -processDueJobs(): Promise<void>
}

' ──────────────────────────────────────────────
'  Errors
' ──────────────────────────────────────────────

class ValidationError extends Error
class WorkflowCorruptionError extends Error
class StepTimeoutError extends Error {
  +stepName: string
  +timeoutMs: number
}
class LeaseExpiredError extends Error {
  +runId: string
}

' ──────────────────────────────────────────────
'  Relationships
' ──────────────────────────────────────────────

DurableEngine *-- "1" HookEmitter : hooks
DurableEngine *-- "0..1" Worker : worker
DurableEngine *-- "0..1" CronManager : cronManager
DurableEngine o-- "0..1" WorkflowStore : store
DurableEngine --> "*" WorkflowDefinition : workflows

Worker --> WorkflowStore : store
Worker --> HookEmitter : hooks
Worker ..> WorkflowContextImpl : creates via executeWorkflow()

WorkflowContextImpl --> WorkflowStore : store
WorkflowContextImpl --> HookEmitter : hooks
WorkflowContextImpl --> "*" CompensationEntry : compensations
WorkflowContextImpl ..> SleepInterrupt : throws

CronManager --> WorkflowStore : store

StepOptions --> RetryPolicy : retry

WorkflowRun --> RunStatus : status
StepRecord --> StepStatus : status
WorkflowRun "1" *-- "*" StepRecord : steps
WorkflowRun "1" *-- "*" SleepTimer : timers
WorkflowRun "1" *-- "*" WorkflowEvent : events
WorkflowRun "0..1" o-- "0..*" WorkflowRun : parentRunId (children)

HookEmitter ..> HookEvents : event types

@enduml
```

### Component Diagram

```plantuml
@startuml component-diagram
skinparam linetype ortho

title Flowly / Durable Workflow Engine — Component Diagram

' ──────────────────────────────────────────────
'  External actors
' ──────────────────────────────────────────────

actor "Application Code" as app

' ──────────────────────────────────────────────
'  Engine boundary
' ──────────────────────────────────────────────

package "Durable Workflow Engine" {

  component "DurableEngine" as engine {
    portin "trigger()" as trg
    portin "schedule()" as sch
    portin "cancel()" as cnl
    portin "getStatus()" as gs
    portin "hook() / on()" as hk
    portin "migrate()" as mig
    portin "start() / stop()" as ss
    portin "healthCheck()" as hc
    portin "retryDeadLetter()" as rdl
  }

  ' ── Worker ───────────────────────────────
  component "Worker" as worker {
    component "Poll Loop" as poll
    component "Heartbeat" as heartbeat
    component "LISTEN/NOTIFY" as notify
  }

  ' ── Executor ─────────────────────────────
  package "Executor" as executor {
    component "executeWorkflow()" as execWf
    component "WorkflowContextImpl" as ctx
    component "Compensation\n(LIFO rollback)" as comp
    component "Retry\n(exponential / linear / fixed)" as retry
  }

  ' ── Scheduling ───────────────────────────
  component "CronManager" as cron {
    component "Cron Poll Loop" as cronPoll
    component "parseCron()\ngetNextCronDate()" as cronParser
  }

  ' ── Hooks / Events ──────────────────────
  component "HookEmitter" as hooks
  note right of hooks
    Events:
    workflow:started
    workflow:completed
    workflow:failed
    workflow:compensated
    step:started
    step:completed
    step:failed
  end note

  ' ── Store Layer ──────────────────────────
  interface "WorkflowStore" as storeIf

  component "PostgresWorkflowStore" as pgStore
  component "MemoryWorkflowStore" as memStore

  ' ── Migration ────────────────────────────
  component "Migrator" as migrator
}

' ──────────────────────────────────────────────
'  External infrastructure
' ──────────────────────────────────────────────

database "PostgreSQL" as pg {
  collections "runs" as tRuns
  collections "steps" as tSteps
  collections "sleep_timers" as tSleep
  collections "cron_schedules" as tCron
  collections "workflow_events" as tEvents
}

' ──────────────────────────────────────────────
'  App -> Engine
' ──────────────────────────────────────────────

app --> trg : trigger workflow
app --> sch : schedule cron
app --> cnl : cancel run
app --> gs  : query status
app --> hk  : subscribe hooks/events
app --> mig : run migrations
app --> ss  : start / stop
app --> hc  : health check
app --> rdl : retry dead letter

' ──────────────────────────────────────────────
'  Engine internal wiring
' ──────────────────────────────────────────────

engine --> worker   : creates & manages
engine --> cron     : creates & manages
engine --> hooks    : owns
engine --> storeIf  : delegates persistence

' Worker -> Executor
worker --> execWf        : claims run, calls
poll --> storeIf         : claimNextRun()\n(FOR UPDATE SKIP LOCKED)
heartbeat --> storeIf    : extendLease()
notify ..> poll          : wakes on PG NOTIFY

' Executor internals
execWf --> ctx           : creates WorkflowContextImpl
ctx --> storeIf          : saveStep() / getSleepTimer()\ncreateRun() (child wf)
ctx --> retry            : withRetry() per step
ctx --> comp             : on failure, LIFO compensate
ctx --> hooks            : emit step/workflow events
execWf --> storeIf       : completeRun() / failRun()\nsetDeadLetter()

' Cron
cronPoll --> storeIf     : getDueCronJobs()
cronPoll --> cronParser  : getNextCronDate()
cronPoll --> storeIf     : createRun() for due job

' Store implementations
pgStore ..|> storeIf
memStore ..|> storeIf

' Postgres store -> DB
pgStore --> pg : SQL queries

' Migrator
migrator --> pg : CREATE TABLE IF NOT EXISTS

' ──────────────────────────────────────────────
'  Data flow legend
' ──────────────────────────────────────────────

legend bottom right
  |= Symbol |= Meaning |
  | ──>     | Direct call / dependency |
  | ..>     | Async / event-driven     |
  | ..\|>   | Implements interface     |
endlegend

@enduml
```

## License

MIT
