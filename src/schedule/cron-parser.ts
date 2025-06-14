// Minimal 5-field cron expression parser.
// Fields: minute hour day-of-month month day-of-week
// Supports: numbers, *, ranges (1-5), steps (star/5), lists (1,3,5)

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    let start: number;
    let end: number;

    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      start = a;
      end = b;
    } else {
      start = parseInt(range, 10);
      end = start;
    }

    if (isNaN(start) || isNaN(end) || start < min || end > max) {
      throw new Error(`Invalid cron field: ${field} (range ${min}-${max})`);
    }

    for (let i = start; i <= end; i += step) {
      values.add(i);
    }
  }

  return values;
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6),
  };
}

/** Get the next occurrence of a cron expression after a given date. */
export function getNextCronDate(expression: string, after: Date): Date {
  const fields = parseCron(expression);
  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  // Search forward up to 2 years
  const limit = new Date(after);
  limit.setFullYear(limit.getFullYear() + 2);

  while (next < limit) {
    if (
      fields.months.has(next.getMonth() + 1) &&
      fields.daysOfMonth.has(next.getDate()) &&
      fields.daysOfWeek.has(next.getDay()) &&
      fields.hours.has(next.getHours()) &&
      fields.minutes.has(next.getMinutes())
    ) {
      return next;
    }

    next.setMinutes(next.getMinutes() + 1);
  }

  throw new Error(`No next date found for cron "${expression}" within 2 years`);
}
