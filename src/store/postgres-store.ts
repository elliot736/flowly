import type { Pool, PoolClient } from "pg";
import type { RunStatus, StepStatus } from "../types/index.js";
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
import { validateSchemaName } from "../validation.js";

export class PostgresWorkflowStore implements WorkflowStore {
  private readonly qualifiedPrefix: string;

  constructor(
    private readonly pool: Pool,
    private readonly schema: string = "durable_workflow",
  ) {
    validateSchemaName(schema);
    this.qualifiedPrefix = `"${schema}"`;
  }

  private t(table: string): string {
    return `${this.qualifiedPrefix}."${table}"`;
  }

  async createRun(params: CreateRunParams): Promise<WorkflowRun | null> {
    const hasConcurrencyKey = params.concurrencyKey != null;

    const { rows } = await this.pool.query(
      `INSERT INTO ${this.t("workflow_runs")} (workflow_name, input, scheduled_for, timeout_at, concurrency_key, max_attempts, parent_run_id)
       VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6, $7)
       ${hasConcurrencyKey ? "ON CONFLICT ON CONSTRAINT uq_concurrency_key_active DO NOTHING" : ""}
       RETURNING *`,
      [
        params.workflowName,
        JSON.stringify(params.input),
        params.scheduledFor ?? null,
        params.timeoutAt ?? null,
        params.concurrencyKey ?? null,
        params.maxAttempts ?? 1,
        params.parentRunId ?? null,
      ],
    );
    if (rows.length === 0) return null;
    return this.mapRun(rows[0]);
  }

  async claimNextRun(
    workerId: string,
    workflowNames: string[],
    leaseMs: number,
  ): Promise<WorkflowRun | null> {
    // First, mark timed-out runs as failed
    await this.pool.query(
      `UPDATE ${this.t("workflow_runs")}
       SET status = 'failed',
           error = 'Workflow timed out',
           completed_at = now(),
           locked_by = NULL,
           locked_until = NULL,
           updated_at = now()
       WHERE status IN ('pending', 'running')
         AND timeout_at IS NOT NULL
         AND timeout_at < now()
         AND workflow_name = ANY($1)`,
      [workflowNames],
    );

    const { rows } = await this.pool.query(
      `UPDATE ${this.t("workflow_runs")}
       SET locked_by = $1,
           locked_until = now() + ($2 || ' milliseconds')::interval,
           status = 'running',
           started_at = COALESCE(started_at, now()),
           updated_at = now()
       WHERE id = (
         SELECT id FROM ${this.t("workflow_runs")}
         WHERE status IN ('pending', 'running')
           AND scheduled_for <= now()
           AND workflow_name = ANY($3)
           AND (locked_by IS NULL OR locked_until < now())
           AND (timeout_at IS NULL OR timeout_at >= now())
         ORDER BY scheduled_for ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [workerId, String(leaseMs), workflowNames],
    );
    return rows.length > 0 ? this.mapRun(rows[0]) : null;
  }

  async extendLease(
    runId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.t("workflow_runs")}
       SET locked_until = now() + ($1 || ' milliseconds')::interval,
           updated_at = now()
       WHERE id = $2 AND locked_by = $3`,
      [String(leaseMs), runId, workerId],
    );
    return (rowCount ?? 0) > 0;
  }

  async completeRun(runId: string, result: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("workflow_runs")}
       SET status = 'completed',
           result = $1,
           completed_at = now(),
           locked_by = NULL,
           locked_until = NULL,
           updated_at = now()
       WHERE id = $2`,
      [JSON.stringify(result), runId],
    );
  }

  async failRun(runId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("workflow_runs")}
       SET status = 'failed',
           error = $1,
           completed_at = now(),
           locked_by = NULL,
           locked_until = NULL,
           updated_at = now()
       WHERE id = $2`,
      [error, runId],
    );
  }

  async updateRunStatus(runId: string, status: RunStatus): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("workflow_runs")} SET status = $1, updated_at = now() WHERE id = $2`,
      [status, runId],
    );
  }

  async updateRunScheduledFor(
    runId: string,
    scheduledFor: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("workflow_runs")} SET scheduled_for = $1, updated_at = now() WHERE id = $2`,
      [scheduledFor, runId],
    );
  }

  async releaseRun(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("workflow_runs")}
       SET status = 'pending',
           locked_by = NULL,
           locked_until = NULL,
           updated_at = now()
       WHERE id = $1`,
      [runId],
    );
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t("workflow_runs")} WHERE id = $1`,
      [runId],
    );
    return rows.length > 0 ? this.mapRun(rows[0]) : null;
  }

  async cancelRun(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("workflow_runs")}
       SET status = 'cancelled',
           completed_at = now(),
           locked_by = NULL,
           locked_until = NULL,
           updated_at = now()
       WHERE id = $1`,
      [runId],
    );
  }

  async getChildRuns(parentRunId: string): Promise<WorkflowRun[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t("workflow_runs")} WHERE parent_run_id = $1`,
      [parentRunId],
    );
    return rows.map(this.mapRun);
  }

  async getRunsByStatus(status: RunStatus): Promise<WorkflowRun[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t("workflow_runs")} WHERE status = $1 ORDER BY created_at ASC`,
      [status],
    );
    return rows.map(this.mapRun);
  }

  async incrementAttemptAndReset(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("workflow_runs")}
       SET attempt = attempt + 1,
           status = 'pending',
           error = NULL,
           completed_at = NULL,
           locked_by = NULL,
           locked_until = NULL,
           updated_at = now()
       WHERE id = $1`,
      [runId],
    );
  }

  async setDeadLetter(runId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("workflow_runs")}
       SET status = 'dead_letter',
           error = $1,
           completed_at = now(),
           locked_by = NULL,
           locked_until = NULL,
           updated_at = now()
       WHERE id = $2`,
      [error, runId],
    );
  }

  async getCompletedSteps(runId: string): Promise<StepRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t("workflow_steps")}
       WHERE workflow_run_id = $1 AND status = 'completed'
       ORDER BY sequence ASC`,
      [runId],
    );
    return rows.map(this.mapStep);
  }

  async saveStep(params: SaveStepParams): Promise<StepRecord> {
    // Use a single transaction for atomicity
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `INSERT INTO ${this.t("workflow_steps")}
           (workflow_run_id, step_name, sequence, status, result, error, attempts, has_compensate, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, now(), CASE WHEN $4 = 'completed' THEN now() ELSE NULL END)
         ON CONFLICT (workflow_run_id, step_name) DO NOTHING
         RETURNING *`,
        [
          params.workflowRunId,
          params.stepName,
          params.sequence,
          params.status,
          params.result !== undefined ? JSON.stringify(params.result) : null,
          params.error ?? null,
          params.hasCompensate,
        ],
      );

      let record: StepRecord;
      if (rows.length === 0) {
        // ON CONFLICT triggered  fetch existing within same transaction
        const { rows: existing } = await client.query(
          `SELECT * FROM ${this.t("workflow_steps")}
           WHERE workflow_run_id = $1 AND step_name = $2`,
          [params.workflowRunId, params.stepName],
        );
        record = this.mapStep(existing[0]);
      } else {
        record = this.mapStep(rows[0]);
      }

      await client.query("COMMIT");
      return record;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async updateStepStatus(
    runId: string,
    stepName: string,
    status: StepStatus,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("workflow_steps")} SET status = $1 WHERE workflow_run_id = $2 AND step_name = $3`,
      [status, runId, stepName],
    );
  }

  async createSleepTimer(params: CreateSleepParams): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("sleep_timers")} (workflow_run_id, step_name, wake_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (workflow_run_id, step_name) DO NOTHING`,
      [params.workflowRunId, params.stepName, params.wakeAt],
    );
  }

  async getSleepTimer(
    runId: string,
    stepName: string,
  ): Promise<SleepTimer | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t("sleep_timers")} WHERE workflow_run_id = $1 AND step_name = $2`,
      [runId, stepName],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      workflowRunId: r.workflow_run_id,
      stepName: r.step_name,
      wakeAt: r.wake_at,
      completed: r.completed,
    };
  }

  async createCronSchedule(params: CreateCronParams): Promise<CronSchedule> {
    const { rows } = await this.pool.query(
      `INSERT INTO ${this.t("cron_schedules")} (workflow_name, cron_expression, input, next_run_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        params.workflowName,
        params.cronExpression,
        JSON.stringify(params.input),
        params.nextRunAt,
      ],
    );
    return this.mapCron(rows[0]);
  }

  async getDueCronJobs(now?: Date): Promise<CronSchedule[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t("cron_schedules")}
       WHERE enabled = true AND next_run_at <= $1`,
      [now ?? new Date()],
    );
    return rows.map(this.mapCron);
  }

  async updateCronLastRun(
    id: string,
    lastRunAt: Date,
    nextRunAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.t("cron_schedules")}
       SET last_run_at = $1, next_run_at = $2
       WHERE id = $3`,
      [lastRunAt, nextRunAt, id],
    );
  }

  async saveEvent(params: SaveEventParams): Promise<WorkflowEvent> {
    const { rows } = await this.pool.query(
      `INSERT INTO ${this.t("workflow_events")} (workflow_run_id, event, data)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [params.workflowRunId, params.event, JSON.stringify(params.data)],
    );
    return this.mapEvent(rows[0]);
  }

  async getEvents(runId: string): Promise<WorkflowEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t("workflow_events")} WHERE workflow_run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );
    return rows.map(this.mapEvent);
  }

  async getNewEvents(sinceId?: string): Promise<WorkflowEvent[]> {
    if (!sinceId) {
      const { rows } = await this.pool.query(
        `SELECT * FROM ${this.t("workflow_events")} ORDER BY created_at ASC`,
      );
      return rows.map(this.mapEvent);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t("workflow_events")}
       WHERE created_at > (SELECT created_at FROM ${this.t("workflow_events")} WHERE id = $1)
       ORDER BY created_at ASC`,
      [sinceId],
    );
    return rows.map(this.mapEvent);
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  /** Send a NOTIFY for new run creation. Called after createRun if LISTEN/NOTIFY is enabled. */
  async notifyNewRun(): Promise<void> {
    await this.pool.query("NOTIFY durable_workflow_new_run");
  }

  // ── Row Mappers ────────────────────────────────────────────────────

  private mapRun(r: Record<string, any>): WorkflowRun {
    return {
      id: r.id,
      workflowName: r.workflow_name,
      input: r.input,
      status: r.status,
      result: r.result,
      error: r.error,
      scheduledFor: r.scheduled_for,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      lockedBy: r.locked_by,
      lockedUntil: r.locked_until,
      timeoutAt: r.timeout_at,
      attempt: r.attempt,
      maxAttempts: r.max_attempts ?? 1,
      concurrencyKey: r.concurrency_key ?? null,
      parentRunId: r.parent_run_id ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private mapStep(r: Record<string, any>): StepRecord {
    return {
      id: r.id,
      workflowRunId: r.workflow_run_id,
      stepName: r.step_name,
      sequence: r.sequence,
      status: r.status,
      result: r.result,
      error: r.error,
      attempts: r.attempts,
      hasCompensate: r.has_compensate,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    };
  }

  private mapCron(r: Record<string, any>): CronSchedule {
    return {
      id: r.id,
      workflowName: r.workflow_name,
      cronExpression: r.cron_expression,
      input: r.input,
      enabled: r.enabled,
      lastRunAt: r.last_run_at,
      nextRunAt: r.next_run_at,
      createdAt: r.created_at,
    };
  }

  private mapEvent(r: Record<string, any>): WorkflowEvent {
    return {
      id: r.id,
      workflowRunId: r.workflow_run_id,
      event: r.event,
      data: r.data,
      createdAt: r.created_at,
    };
  }
}
