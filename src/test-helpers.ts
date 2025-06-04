import pino from "pino";

/** Silent logger for tests  logs nothing. */
export const testLogger = pino({ level: "silent" });
