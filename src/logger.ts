import pino from "pino";

export type Logger = pino.Logger;

const defaultLogger = pino({ name: "flowly" });

export function createLogger(name: string, parent?: Logger): Logger {
  return (parent ?? defaultLogger).child({ component: name });
}

export { defaultLogger };
