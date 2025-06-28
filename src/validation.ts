import { ValidationError } from "./errors.js";

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateSchemaName(schema: string): void {
  if (!IDENTIFIER_RE.test(schema)) {
    throw new ValidationError(
      `Invalid schema name "${schema}": must match [a-zA-Z_][a-zA-Z0-9_]*`,
    );
  }
  if (schema.length > 63) {
    throw new ValidationError(
      `Schema name "${schema}" exceeds 63 characters (Postgres identifier limit)`,
    );
  }
}

export function validateStepName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new ValidationError("Step name must be a non-empty string");
  }
  if (name.length > 255) {
    throw new ValidationError(
      `Step name "${name.slice(0, 30)}..." exceeds 255 characters`,
    );
  }
}

export function validateWorkflowName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new ValidationError("Workflow name must be a non-empty string");
  }
  if (name.length > 255) {
    throw new ValidationError(
      `Workflow name "${name.slice(0, 30)}..." exceeds 255 characters`,
    );
  }
}

export function validateDuration(ms: number): void {
  if (ms < 0) {
    throw new ValidationError(`Duration must be non-negative, got ${ms}ms`);
  }
  if (!Number.isFinite(ms)) {
    throw new ValidationError(`Duration must be finite, got ${ms}`);
  }
}

export function validatePositive(value: number, name: string): void {
  if (value <= 0 || !Number.isFinite(value)) {
    throw new ValidationError(`${name} must be a positive number, got ${value}`);
  }
}

