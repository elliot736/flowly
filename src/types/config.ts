import type { Pool } from "pg";
import type { Logger } from "pino";
import type { WorkflowDefinition } from "./workflow.js";

// ── Engine Configuration ─────────────────────────────────────────────

export interface EngineConfig {
  /** A pg.Pool instance. The library does not create its own connections. */
  pool: Pool;
  /** Workflow definitions to register. */
  workflows: WorkflowDefinition<any, any>[];
  /** Postgres schema name for all tables. Default: "durable_workflow". */
  schema?: string;
  /** Worker configuration. */
  worker?: WorkerConfig;
  /** Pino logger instance. Default: built-in logger. */
  logger?: Logger;
}

export interface WorkerConfig {
  /** How often to poll for new work, in milliseconds. Default: 1000. */
  pollIntervalMs?: number;
  /** Maximum concurrent workflow executions. Default: 5. */
  maxConcurrent?: number;
  /** Lease duration in milliseconds. Default: 30000. */
  leaseMs?: number;
  /** Unique worker identifier. Default: auto-generated from hostname + pid. */
  workerId?: string;
  /** Maximum time to wait for in-flight workflows during shutdown, in milliseconds. Default: 30000. */
  shutdownTimeoutMs?: number;
  /** Use Postgres LISTEN/NOTIFY to be notified of new runs immediately instead of waiting for the poll interval. Default: false. */
  useNotify?: boolean;
}

