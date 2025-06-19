import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import pg from "pg";
import { DurableEngine } from "./engine/engine.js";
import type { WorkflowDefinition } from "./types/workflow.js";

const DATABASE_URL = process.env.DATABASE_URL;
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR ?? "./workflows";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "1000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT ?? "5", 10);
const LEASE_MS = parseInt(process.env.LEASE_MS ?? "30000", 10);
const SCHEMA = process.env.SCHEMA ?? "durable_workflow";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

const log = pino({ name: "flowly", level: LOG_LEVEL });

if (!DATABASE_URL) {
  log.fatal("DATABASE_URL is required");
  process.exit(1);
}

async function loadWorkflows(dir: string): Promise<WorkflowDefinition[]> {
  const absDir = resolve(dir);
  let files: string[];
  try {
    files = await readdir(absDir);
  } catch (err) {
    log.fatal({ dir: absDir, err }, "failed to read workflows directory");
    process.exit(1);
  }

  const workflows: WorkflowDefinition[] = [];

  for (const file of files) {
    if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;

    const fileUrl = pathToFileURL(join(absDir, file)).href;
    try {
      const mod = await import(fileUrl);

      for (const exported of Object.values(mod)) {
        if (
          exported &&
          typeof exported === "object" &&
          "name" in exported &&
          "fn" in exported &&
          typeof (exported as WorkflowDefinition).fn === "function"
        ) {
          workflows.push(exported as WorkflowDefinition);
          log.info(
            { workflow: (exported as WorkflowDefinition).name, file },
            "loaded workflow",
          );
        }
      }
    } catch (err) {
      log.error({ file, err }, "failed to load workflow file");
    }
  }

  return workflows;
}

async function main(): Promise<void> {
  const workflows = await loadWorkflows(WORKFLOWS_DIR);

  if (workflows.length === 0) {
    log.fatal({ dir: resolve(WORKFLOWS_DIR) }, "no workflows found");
    process.exit(1);
  }

  log.info({ count: workflows.length }, "workflows loaded");

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  pool.on("error", (err) => {
    log.error({ err }, "postgres pool error");
  });

  const engine = new DurableEngine({
    pool,
    workflows,
    schema: SCHEMA,
    logger: log,
    worker: {
      pollIntervalMs: POLL_INTERVAL_MS,
      maxConcurrent: MAX_CONCURRENT,
      leaseMs: LEASE_MS,
    },
  });

  await engine.migrate();
  await engine.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "received shutdown signal");
    await engine.stop();
    await pool.end();
    log.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "failed to start");
  process.exit(1);
});
