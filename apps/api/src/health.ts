import type { ExecutionMode } from "./config.js";

export type HealthStatus = "live" | "ready" | "not_ready";
export type CheckStatus = "ready" | "not_ready";
export type ReasonCode = string;

export interface ServiceCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly reason_codes: readonly ReasonCode[];
}

export interface ServiceHealth {
  readonly service: string;
  readonly status: HealthStatus;
  readonly checked_at: string;
  readonly execution_mode: ExecutionMode;
  readonly correlation_id: string;
  readonly reason_codes: readonly ReasonCode[];
  readonly checks: readonly ServiceCheck[];
}

export const POSTGRES_UNAVAILABLE = "POSTGRES_UNAVAILABLE";

export const serviceHealthSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "service",
    "status",
    "checked_at",
    "execution_mode",
    "correlation_id",
    "reason_codes",
    "checks",
  ],
  properties: {
    service: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["live", "ready", "not_ready"] },
    checked_at: { type: "string", format: "date-time", pattern: "Z$" },
    execution_mode: { type: "string", const: "paper" },
    correlation_id: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    },
    reason_codes: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: "^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$" },
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status", "reason_codes"],
        properties: {
          name: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["ready", "not_ready"] },
          reason_codes: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "string",
              pattern: "^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$",
            },
          },
        },
      },
    },
  },
} as const;
