// ── Workflow Run Status ───────────────────────────────────────────────

export type WorkflowRunStatus =
  | { status: "pending"; scheduledFor: Date }
  | { status: "running"; startedAt: Date; currentStep: string | null }
  | { status: "completed"; startedAt: Date; completedAt: Date; result: unknown }
  | { status: "failed"; startedAt: Date; failedAt: Date; error: string }
  | { status: "compensating"; startedAt: Date; failedStep: string }
  | { status: "compensated"; startedAt: Date; compensatedAt: Date }
  | { status: "cancelled"; startedAt: Date | null; cancelledAt: Date }
  | { status: "dead_letter"; startedAt: Date; failedAt: Date; error: string; attempt: number };

// ── DB Row Status Enums ──────────────────────────────────────────────

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "compensating"
  | "compensated"
  | "cancelled"
  | "dead_letter";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "compensated";
