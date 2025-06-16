import type { Pool, PoolClient } from "pg";
import type {
  WorkflowStore,
  WorkflowRun,
  StepRecord,
  SleepTimer,
  CronSchedule,
  WorkflowEvent,
  CreateRunParams,
  SaveStepParams,
  CreateSleepParams,
  CreateCronParams,
  SaveEventParams,
} from "./store.js";

export class PostgresWorkflowStore implements WorkflowStore {
  constructor(
    private pool: Pool,
    private schema = "public",
  ) {}

  private table(name: string): string {
    return `"${this.schema}"."${name}"`;
  }

  async createRun(params: CreateRunParams): Promise<string> {
    const { rows } = await this.pool.query(
      `INSERT INTO ${this.table("workflow_runs")}
       (workflow_name, input, status, scheduled_for, parent_run_id, concurrency_key, max_attempts, timeout_at)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        params.workflowName,
        JSON.stringify(params.input),
        params.scheduledFor ?? null,
        params.parentRunId ?? null,
        params.concurrencyKey ?? null,
        params.maxAttempts ?? 3,
        params.timeoutMs ? new Date(Date.now() + params.timeoutMs) : null,
      ],
    );
    return rows[0].id;
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.table("workflow_runs")} WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return this.mapRun(rows[0]);
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  private mapRun(row: any): WorkflowRun {
    return {
      id: row.id,
      workflowName: row.workflow_name,
      input: row.input,
      status: row.status,
      output: row.output ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      scheduledFor: row.scheduled_for,
      lockedBy: row.locked_by,
      lockedUntil: row.locked_until,
      parentRunId: row.parent_run_id,
      concurrencyKey: row.concurrency_key,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      timeoutAt: row.timeout_at,
    };
  }
}
