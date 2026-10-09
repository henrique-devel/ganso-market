import { JevPanel } from "./JevPanel.tsx";
import { ExperimentSystem } from "./Experiments.tsx";
import { BtcWorkspace } from "./BtcOperations.tsx";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getSession,
  login,
  logout,
  readCsrfCookie,
  createSessionRenewal,
  type AuthenticatedSession,
} from "./auth.js";
import { fetchDashboardStatus, type DashboardStatus } from "./health.js";
import { BuildFooter } from "./BuildFooter.tsx";

const REFRESH_INTERVAL_MS = 15_000;

type AuthState =
  | { readonly kind: "checking" }
  | { readonly kind: "anonymous"; readonly error: string | null }
  | { readonly kind: "authenticated"; readonly session: AuthenticatedSession };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const renewal = useRef(createSessionRenewal()).current;

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const refreshed = await renewal.renew(null, readCsrfCookie());
      if (!mounted.current) {
        return;
      }
      if (refreshed.kind === "superseded") return;
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
  }, [renewal]);

  const handleLogin = useCallback(
    async (username: string, password: string): Promise<void> => {
      setPending(true);
      const outcome = await login(username, password);
      if (!mounted.current) {
        return;
      }
      setPending(false);
      if (outcome.kind === "ok") {
        renewal.replace(outcome.session.accessToken);
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
    [renewal],
  );

  const handleLogout = useCallback(async (): Promise<void> => {
    if (auth.kind !== "authenticated") {
      return;
    }
    renewal.replace(null);
    await logout(auth.session.accessToken, readCsrfCookie());
    if (mounted.current) {
      setAuth({ kind: "anonymous", error: null });
    }
  }, [auth, renewal]);

  const handleUnauthorized = useCallback(async (): Promise<void> => {
    if (auth.kind !== "authenticated") return;
    const rejectedToken = auth.session.accessToken;
    const refreshed = await renewal.renew(rejectedToken, readCsrfCookie());
    if (refreshed.kind === "superseded") return;
    if (!mounted.current) {
      return;
    }
    if (refreshed.kind === "ok") {
      setAuth((previous) =>
        previous.kind === "authenticated" &&
        previous.session.accessToken === rejectedToken
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
    setAuth((previous) =>
      previous.kind === "authenticated" &&
      previous.session.accessToken === rejectedToken
        ? { kind: "anonymous", error: null }
        : previous,
    );
  }, [auth, renewal]);

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

export const BTC_TELAS = [
  "Mesa",
  "Operações",
  "Experimentos",
  "Sistema",
] as const;
function Dashboard({
  session,
  onLogout,
  onUnauthorized,
}: Readonly<{
  session: AuthenticatedSession;
  onLogout: () => void;
  onUnauthorized: () => void;
}>) {
  const [tab, setTab] = useState<(typeof BTC_TELAS)[number]>("Mesa");
  const [status, setStatus] = useState<DashboardStatus>({ kind: "loading" });
  useEffect(() => {
    if (tab !== "Sistema") return;
    let alive = true;
    const refresh = async () => {
      const value = await fetchDashboardStatus(
        fetch,
        AbortSignal.timeout(5000),
      );
      if (alive) setStatus(value);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tab]);
  return (
    <main className="shell shell--wide">
      <header className="header">
        <p className="btc-badge">SIMULAÇÃO · BTC</p>
        <h1>Ganso Market</h1>
        <p>Dados reais Hyperliquid · saldo fictício · cenários independentes</p>
        <p>
          Sessão de <strong>{session.username}</strong>.{" "}
          <button type="button" className="logout" onClick={onLogout}>
            Sair
          </button>
        </p>
      </header>
      <nav className="tabs" aria-label="Navegação principal">
        {BTC_TELAS.map((t) => (
          <button
            type="button"
            key={t}
            className={tab === t ? "tab tab--active" : "tab"}
            aria-current={tab === t ? "page" : undefined}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === "Mesa" && (
        <JevPanel
          accessToken={session.accessToken}
          onUnauthorized={onUnauthorized}
        />
      )}
      <BtcWorkspace
        accessToken={session.accessToken}
        onUnauthorized={onUnauthorized}
        tab={tab}
      />
      {tab === "Sistema" && (
        <section className="btc-desk">
          <h2>Sistema</h2>
          <StatusPanel status={status} />
          <ExperimentSystem
            accessToken={session.accessToken}
            onUnauthorized={onUnauthorized}
          />
          <p>
            A saúde da API não certifica frescor do mercado, warmup ou prontidão
            para enviar ordens. Consulte a conta na Mesa.
          </p>
        </section>
      )}
      <BuildFooter releaseSha={null} />
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
