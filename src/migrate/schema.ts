import { validateSchemaName } from "../validation.js";

export function getMigrationSQL(schema: string): string {
  validateSchemaName(schema);
  // Use quoted identifiers for safety
  const s = `"${schema}"`;

  return `
CREATE SCHEMA IF NOT EXISTS ${s};

CREATE TABLE IF NOT EXISTS ${s}."workflow_runs" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name   TEXT NOT NULL,
  input           JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','completed','failed','compensating','compensated','cancelled','dead_letter')),
  result          JSONB,
  error           TEXT,
  scheduled_for   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  locked_by       TEXT,
  locked_until    TIMESTAMPTZ,
  timeout_at      TIMESTAMPTZ,
  attempt         INTEGER NOT NULL DEFAULT 1,
  max_attempts    INTEGER NOT NULL DEFAULT 1,
  concurrency_key TEXT,
  parent_run_id   UUID REFERENCES ${s}."workflow_runs"(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runs_poll
  ON ${s}."workflow_runs" (status, scheduled_for)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_runs_parent
  ON ${s}."workflow_runs" (parent_run_id)
  WHERE parent_run_id IS NOT NULL;

-- Partial unique index for concurrency keys: only one active run per key
CREATE UNIQUE INDEX IF NOT EXISTS uq_concurrency_key_active
  ON ${s}."workflow_runs" (concurrency_key)
  WHERE concurrency_key IS NOT NULL
    AND status NOT IN ('completed','failed','compensated','cancelled','dead_letter');

CREATE TABLE IF NOT EXISTS ${s}."workflow_steps" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES ${s}."workflow_runs"(id),
  step_name       TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','completed','failed','compensated')),
  result          JSONB,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  has_compensate  BOOLEAN NOT NULL DEFAULT false,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  UNIQUE (workflow_run_id, step_name)
);

CREATE TABLE IF NOT EXISTS ${s}."sleep_timers" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES ${s}."workflow_runs"(id),
  step_name       TEXT NOT NULL,
  wake_at         TIMESTAMPTZ NOT NULL,
  completed       BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (workflow_run_id, step_name)
);

CREATE INDEX IF NOT EXISTS idx_timers_wake
  ON ${s}."sleep_timers" (wake_at)
  WHERE NOT completed;

CREATE TABLE IF NOT EXISTS ${s}."cron_schedules" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name   TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  input           JSONB NOT NULL DEFAULT '{}',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_name, cron_expression)
);

CREATE TABLE IF NOT EXISTS ${s}."workflow_events" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES ${s}."workflow_runs"(id),
  event           TEXT NOT NULL,
  data            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_run
  ON ${s}."workflow_events" (workflow_run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_events_event
  ON ${s}."workflow_events" (event, created_at);
`;
}
