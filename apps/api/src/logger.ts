import type { LogLevel } from "./config.js";

export interface LogSink {
  write(message: string): void;
}

export function createLoggerOptions(level: LogLevel, sink?: LogSink) {
  return {
    level,
    base: {
      service: "api",
      log_schema_version: 1,
    },
    messageKey: "message",
    timestamp: (): string => `,"timestamp":"${new Date().toISOString()}"`,
    redact: {
      paths: [
        "password",
        "postgres_password",
        "authorization",
        "token",
        "access_token",
        "refresh_token",
        "config.database.password",
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
      ],
      censor: "[REDACTED]",
    },
    ...(sink === undefined ? {} : { stream: sink }),
  };
}
