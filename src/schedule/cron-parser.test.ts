import { describe, it, expect } from "vitest";
import { parseCron, getNextCronDate } from "./cron-parser.js";

describe("parseCron", () => {
  it("parses a simple expression", () => {
    const fields = parseCron("0 9 * * 1");
    expect(fields.minutes).toEqual(new Set([0]));
    expect(fields.hours).toEqual(new Set([9]));
    expect(fields.daysOfMonth.size).toBe(31);
    expect(fields.months.size).toBe(12);
    expect(fields.daysOfWeek).toEqual(new Set([1]));
  });

  it("parses ranges", () => {
    const fields = parseCron("0-5 * * * *");
    expect(fields.minutes).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it("parses steps", () => {
    const fields = parseCron("*/15 * * * *");
    expect(fields.minutes).toEqual(new Set([0, 15, 30, 45]));
  });

  it("parses lists", () => {
    const fields = parseCron("1,15,30 * * * *");
    expect(fields.minutes).toEqual(new Set([1, 15, 30]));
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCron("* * *")).toThrow("expected 5 fields");
  });
});

describe("getNextCronDate", () => {
  it("finds the next occurrence", () => {
    // Every hour at :00
    const after = new Date("2026-01-01T10:30:00Z");
    const next = getNextCronDate("0 * * * *", after);
    expect(next.getUTCHours()).toBe(11);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("finds the next Monday at 9am", () => {
    // 2026-01-01 is a Thursday
    const after = new Date("2026-01-01T00:00:00Z");
    const next = getNextCronDate("0 9 * * 1", after);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });
});
