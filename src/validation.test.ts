import { describe, it, expect } from "vitest";
import {
  validateSchemaName,
  validateStepName,
  validateWorkflowName,
  validateDuration,
  validatePositive,
} from "./validation.js";

describe("validateSchemaName", () => {
  it("accepts valid schema names", () => {
    expect(() => validateSchemaName("durable_workflow")).not.toThrow();
    expect(() => validateSchemaName("my_schema")).not.toThrow();
    expect(() => validateSchemaName("_private")).not.toThrow();
  });

  it("rejects SQL injection attempts", () => {
    expect(() => validateSchemaName('foo"; DROP TABLE users; --')).toThrow("Invalid schema name");
    expect(() => validateSchemaName("foo bar")).toThrow("Invalid schema name");
    expect(() => validateSchemaName("foo.bar")).toThrow("Invalid schema name");
    expect(() => validateSchemaName("")).toThrow("Invalid schema name");
  });

  it("rejects names over 63 chars", () => {
    expect(() => validateSchemaName("a".repeat(64))).toThrow("exceeds 63 characters");
  });
});

describe("validateStepName", () => {
  it("accepts valid step names", () => {
    expect(() => validateStepName("reserve-inventory")).not.toThrow();
    expect(() => validateStepName("step_1")).not.toThrow();
  });

  it("rejects empty step names", () => {
    expect(() => validateStepName("")).toThrow("non-empty");
    expect(() => validateStepName("   ")).toThrow("non-empty");
  });

  it("rejects overly long step names", () => {
    expect(() => validateStepName("x".repeat(256))).toThrow("exceeds 255");
  });
});

describe("validateWorkflowName", () => {
  it("accepts valid workflow names", () => {
    expect(() => validateWorkflowName("process-order")).not.toThrow();
  });

  it("rejects empty names", () => {
    expect(() => validateWorkflowName("")).toThrow("non-empty");
  });
});

describe("validateDuration", () => {
  it("accepts zero and positive", () => {
    expect(() => validateDuration(0)).not.toThrow();
    expect(() => validateDuration(1000)).not.toThrow();
  });

  it("rejects negative", () => {
    expect(() => validateDuration(-1)).toThrow("non-negative");
  });

  it("rejects Infinity", () => {
    expect(() => validateDuration(Infinity)).toThrow("finite");
  });
});

describe("validatePositive", () => {
  it("accepts positive numbers", () => {
    expect(() => validatePositive(1, "test")).not.toThrow();
    expect(() => validatePositive(0.5, "test")).not.toThrow();
  });

  it("rejects zero and negative", () => {
    expect(() => validatePositive(0, "test")).toThrow("positive");
    expect(() => validatePositive(-1, "test")).toThrow("positive");
  });
});
