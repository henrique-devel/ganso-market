import { useCallback, useEffect, useRef, useState } from "react";

import { fetchDashboardStatus, type DashboardStatus } from "./health.js";

const REFRESH_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5_000;

export function App() {
  const [status, setStatus] = useState<DashboardStatus>({ kind: "loading" });
  const mounted = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const nextStatus = await fetchDashboardStatus(fetch, controller.signal);
    window.clearTimeout(timeout);
    if (mounted.current) {
      setStatus(nextStatus);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);

  return (
    <main className="shell">
      <header className="header">
        <p className="eyebrow">Fundação RFC-001</p>
        <h1>Ganso Market</h1>
        <p className="scope">
          Estado operacional real. Nesta fundação não existe execução de ordens;
          o único modo configurável é paper.
        </p>
      </header>
      <StatusPanel status={status} />
      <button className="refresh" type="button" onClick={() => void refresh()}>
        Verificar novamente
      </button>
    </main>
  );
}

export function StatusPanel({ status }: Readonly<{ status: DashboardStatus }>) {
  const content = statusContent(status);
  return (
    <section
      className="status-card"
      data-state={status.kind}
      aria-live="polite"
    >
      <span className="status-dot" aria-hidden="true" />
      <div>
        <h2>{content.title}</h2>
        <p>{content.description}</p>
        {content.detail === undefined ? null : <code>{content.detail}</code>}
      </div>
    </section>
  );
}

function statusContent(status: DashboardStatus): {
  title: string;
  description: string;
  detail?: string;
} {
  switch (status.kind) {
    case "loading":
      return {
        title: "Verificando",
        description: "Consultando liveness e readiness da API.",
      };
    case "ready":
      return {
        title: "Pronto",
        description: "A API está ativa e a dependência obrigatória respondeu.",
        detail: status.checkedAt,
      };
    case "not_ready":
      if (status.reasonCode === undefined && status.checkedAt === undefined) {
        return {
          title: "Não pronto",
          description:
            "A API respondeu, mas uma condição obrigatória não foi satisfeita.",
        };
      }
      return {
        title: "Não pronto",
        description:
          "A API respondeu, mas uma condição obrigatória não foi satisfeita.",
        detail: status.reasonCode ?? status.checkedAt ?? "",
      };
    case "unreachable":
      return {
        title: "Inalcançável",
        description: "Não foi possível validar os health checks da API.",
      };
  }
}
