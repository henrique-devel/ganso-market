export type DashboardStatus =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; checkedAt: string }>
  | Readonly<{ kind: "not_ready"; checkedAt?: string; reasonCode?: string }>
  | Readonly<{ kind: "unreachable" }>;

const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface ServiceHealthDocument {
  readonly service: string;
  readonly status: "live" | "ready" | "not_ready";
  readonly checked_at: string;
  readonly execution_mode: "paper";
  readonly correlation_id: string;
  readonly reason_codes: readonly string[];
  readonly checks: readonly unknown[];
}

interface HealthResponse {
  readonly ok: boolean;
  readonly body: ServiceHealthDocument | undefined;
}

export type HealthFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

export async function fetchDashboardStatus(
  fetcher: HealthFetcher = fetch,
  signal?: AbortSignal,
): Promise<Exclude<DashboardStatus, { kind: "loading" }>> {
  try {
    const [live, ready] = await Promise.all([
      requestHealth(fetcher, "/api/health/live", signal),
      requestHealth(fetcher, "/api/health/ready", signal),
    ]);
    return mapHealthResponses(live, ready);
  } catch {
    return { kind: "unreachable" };
  }
}

export function mapHealthResponses(
  live: HealthResponse,
  ready: HealthResponse,
): Exclude<DashboardStatus, { kind: "loading" }> {
  if (!live.ok || live.body?.status !== "live") {
    return live.body === undefined
      ? { kind: "unreachable" }
      : notReadyFrom(live.body, "HEALTH_LIVENESS_FAILED");
  }

  if (ready.ok && ready.body?.status === "ready") {
    return { kind: "ready", checkedAt: ready.body.checked_at };
  }

  if (ready.body !== undefined) {
    return notReadyFrom(ready.body, "HEALTH_READINESS_FAILED");
  }
  return { kind: "unreachable" };
}

async function requestHealth(
  fetcher: HealthFetcher,
  url: string,
  signal: AbortSignal | undefined,
): Promise<HealthResponse> {
  const response = await fetcher(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: response.ok, body: undefined };
  }
  return {
    ok: response.ok,
    body: isServiceHealthDocument(body) ? body : undefined,
  };
}

function notReadyFrom(
  health: ServiceHealthDocument,
  fallbackReason: string,
): Extract<DashboardStatus, { kind: "not_ready" }> {
  const reasonCode = health.reason_codes[0] ?? fallbackReason;
  return {
    kind: "not_ready",
    checkedAt: health.checked_at,
    reasonCode,
  };
}

function isServiceHealthDocument(
  value: unknown,
): value is ServiceHealthDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const health = value as Record<string, unknown>;
  return (
    health.service === "api" &&
    (health.status === "live" ||
      health.status === "ready" ||
      health.status === "not_ready") &&
    typeof health.checked_at === "string" &&
    health.checked_at.endsWith("Z") &&
    health.execution_mode === "paper" &&
    typeof health.correlation_id === "string" &&
    CORRELATION_ID.test(health.correlation_id) &&
    Array.isArray(health.reason_codes) &&
    health.reason_codes.every((code) => typeof code === "string") &&
    Array.isArray(health.checks)
  );
}
