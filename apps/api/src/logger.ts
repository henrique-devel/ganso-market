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
        "csrf_token",
        "config.database.password",
        "body.password",
        "req.body.password",
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-csrf-token']",
        "res.headers['set-cookie']",
      ],
      censor: "[REDACTED]",
    },
    ...(sink === undefined ? {} : { stream: sink }),
  };
}
