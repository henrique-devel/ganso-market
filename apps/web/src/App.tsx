import { useCallback, useEffect, useRef, useState } from "react";

import {
  getSession,
  login,
  logout,
  readCsrfCookie,
  refreshSession,
  type AuthenticatedSession,
} from "./auth.js";
import { fetchDashboardStatus, type DashboardStatus } from "./health.js";
// The explicit .tsx extension keeps module resolution unambiguous on
// case-insensitive filesystems, where "./Resolution.js" (and Vite's
// extension substitution) would match src/resolution.ts instead.
import { ResolutionPanel } from "./Resolution.tsx";

const REFRESH_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5_000;

type AuthState =
  | { readonly kind: "checking" }
  | { readonly kind: "anonymous"; readonly error: string | null }
  | { readonly kind: "authenticated"; readonly session: AuthenticatedSession };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const refreshed = await refreshSession(readCsrfCookie());
      if (!mounted.current) {
        return;
      }
      if (refreshed.kind === "ok") {
        const session = await getSession(refreshed.accessToken);
        if (mounted.current && session !== null) {
          setAuth({
            kind: "authenticated",
            session: { accessToken: refreshed.accessToken, ...session },
          });
          return;
        }
      }
      if (mounted.current) {
        setAuth({ kind: "anonymous", error: null });
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleLogin = useCallback(
    async (username: string, password: string): Promise<void> => {
      setPending(true);
      const outcome = await login(username, password);
      if (!mounted.current) {
        return;
      }
      setPending(false);
      if (outcome.kind === "ok") {
        setAuth({ kind: "authenticated", session: outcome.session });
        return;
      }
      const error =
        outcome.kind === "invalid"
          ? "Usuário ou senha inválidos."
          : outcome.kind === "locked"
            ? "Muitas tentativas. Tente novamente mais tarde."
            : "Falha ao contatar o servidor.";
      setAuth({ kind: "anonymous", error });
    },
    [],
  );

  const handleLogout = useCallback(async (): Promise<void> => {
    if (auth.kind !== "authenticated") {
      return;
    }
    await logout(auth.session.accessToken, readCsrfCookie());
    if (mounted.current) {
      setAuth({ kind: "anonymous", error: null });
    }
  }, [auth]);

  const handleUnauthorized = useCallback(async (): Promise<void> => {
    const refreshed = await refreshSession(readCsrfCookie());
    if (!mounted.current) {
      return;
    }
    if (refreshed.kind === "ok") {
      setAuth((previous) =>
        previous.kind === "authenticated"
          ? {
              kind: "authenticated",
              session: {
                ...previous.session,
                accessToken: refreshed.accessToken,
                expiresAt: refreshed.expiresAt,
              },
            }
          : previous,
      );
      return;
    }
    setAuth({ kind: "anonymous", error: null });
  }, []);

  if (auth.kind === "checking") {
    return (
      <main className="shell">
        <p className="scope">Verificando sessão…</p>
      </main>
    );
  }

  if (auth.kind === "anonymous") {
    return (
      <LoginPanel onSubmit={handleLogin} pending={pending} error={auth.error} />
    );
  }

  return (
    <Dashboard
      session={auth.session}
      onLogout={handleLogout}
      onUnauthorized={handleUnauthorized}
    />
  );
}

export function LoginPanel({
  onSubmit,
  pending,
  error,
}: Readonly<{
  onSubmit: (username: string, password: string) => void;
  pending: boolean;
  error: string | null;
}>) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <main className="shell">
      <header className="header">
        <p className="eyebrow">Acesso restrito</p>
        <h1>Ganso Market</h1>
        <p className="scope">
          Acesso HTTP restrito por firewall. Um único operador.
        </p>
      </header>
      <form
        className="login"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(username, password);
        }}
      >
        <label htmlFor="username">Usuário</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
        />
        <label htmlFor="password">Senha</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        {error === null ? null : (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}

function Dashboard({
  session,
  onLogout,
  onUnauthorized,
}: Readonly<{
  session: AuthenticatedSession;
  onLogout: () => void;
  onUnauthorized: () => void;
}>) {
  const [status, setStatus] = useState<DashboardStatus>({ kind: "loading" });
  const [tab, setTab] = useState<"status" | "resolucao">("status");
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
    <main className="shell shell--wide">
      <header className="header">
        <p className="eyebrow">Fundação RFC-001</p>
        <h1>Ganso Market</h1>
        <p className="scope">
          Estado operacional real. Nesta fundação não existe execução de ordens;
          o único modo configurável é paper.
        </p>
        <p className="session">
          Sessão de <strong>{session.username}</strong>.{" "}
          <button className="logout" type="button" onClick={onLogout}>
            Sair
          </button>
        </p>
      </header>
      <nav className="tabs" aria-label="Seções do painel">
        <button
          type="button"
          className={tab === "status" ? "tab tab--active" : "tab"}
          onClick={() => {
            setTab("status");
          }}
        >
          Status
        </button>
        <button
          type="button"
          className={tab === "resolucao" ? "tab tab--active" : "tab"}
          onClick={() => {
            setTab("resolucao");
          }}
        >
          Resolução
        </button>
      </nav>
      {tab === "status" ? (
        <>
          <StatusPanel status={status} />
          <button
            className="refresh"
            type="button"
            onClick={() => void refresh()}
          >
            Verificar novamente
          </button>
        </>
      ) : (
        <ResolutionPanel
          accessToken={session.accessToken}
          onUnauthorized={onUnauthorized}
        />
      )}
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
