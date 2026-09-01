// RFC-015: the PnL band and the "Visão geral" tab.
//
// The band is mounted ABOVE the tab strip, so it is on screen on every tab.
// That placement is the whole point of the RFC: the numbers it carries were
// already published and already parsed, and the panel rendered none of them.
//
// Read-only. Nothing here posts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ACAO_RESOLUCAO,
  ESTADO_PORTFOLIO,
  FONTE_EVENTO,
  GATE,
  MOTIVO_GATE,
  SITUACAO_GATE,
  STATUS_RFC009,
  consequencia,
  rotulo,
  tom,
} from "./dicionario";
import {
  fetchEvents,
  fetchOverview,
  fetchPerformance,
  type EventPage,
  type FeedEvent,
  type Overview,
  type Performance,
} from "./overview";

const OVERVIEW_REFRESH_MS = 15_000;
const EVENTS_REFRESH_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
/** Feed rows kept in memory. The cursor keeps paging; the screen does not. */
const FEED_CAP = 200;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  const signal = value < 0 ? "−" : "";
  return `${signal}$${Math.abs(value).toFixed(2)}`;
}

export function pct(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined
    ? "—"
    : `${(value * 100).toFixed(digits)}%`;
}

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? "B"}`;
}

export function idade(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return "—";
  }
  if (ms < 1_000) {
    return `${String(Math.round(ms))} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)} s`;
  }
  if (ms < 3_600_000) {
    return `${(ms / 60_000).toFixed(1)} min`;
  }
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function instante(iso: string | null): string {
  if (iso === null) {
    return "—";
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

// ---------------------------------------------------------------------------
// Badge: the label the operator reads, the code the operator can trust
// ---------------------------------------------------------------------------

export function Badge({
  codigo,
  dicionario,
  prefixo,
  compacto,
}: Readonly<{
  codigo: string | null;
  dicionario?: Readonly<Record<string, { rotulo: string }>>;
  prefixo?: string;
  /**
   * Drop the inline code where the column is too narrow to hold it.
   *
   * The code does not disappear: `consequencia` always ends with it, and that
   * is the `title`. The rule is that the operator can always recover the raw
   * code — not that it is always printed at full width.
   */
  compacto?: boolean;
}>) {
  if (codigo === null) {
    return <span className="badge badge--neutro">—</span>;
  }
  return (
    <span
      className={`badge badge--${tom(codigo, dicionario)}`}
      title={consequencia(codigo, dicionario)}
    >
      {prefixo === undefined ? "" : `${prefixo} `}
      {rotulo(codigo, dicionario)}
      {compacto === true ? null : <code>{codigo}</code>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The persistent PnL band
// ---------------------------------------------------------------------------

export function PnlBand({
  overview,
  performance,
  degraded,
}: Readonly<{
  overview: Overview | null;
  performance: Performance | null;
  degraded: boolean;
}>) {
  const portfolio = overview?.portfolio ?? null;
  const limite = overview?.drawdown_limit ?? 0.1;
  const drawdown = portfolio?.drawdown ?? null;
  const fracao =
    drawdown === null ? 0 : Math.max(0, Math.min(drawdown / limite, 1));

  return (
    <section className="pnl" aria-label="Resultado e estado da operação">
      <p className="pnl-banner">
        <strong>SIMULAÇÃO — SEM EXECUÇÃO REAL.</strong> Nenhuma ordem real é
        criada por nada nesta tela.
      </p>

      <div className="pnl-grid">
        <PnlCell
          titulo="PnL do dia"
          valor={usd(portfolio?.realized_pnl_day_usd)}
          sinal={portfolio?.realized_pnl_day_usd ?? null}
          nota="realizado"
        />
        <PnlCell
          titulo="PnL da semana"
          valor={usd(portfolio?.realized_pnl_week_usd)}
          sinal={portfolio?.realized_pnl_week_usd ?? null}
          nota="realizado"
        />
        <PnlCell
          titulo="Não realizado"
          valor={usd(performance?.base_unrealized_usd)}
          sinal={performance?.base_unrealized_usd ?? null}
          // `null` aqui não é zero e a diferença importa: o relatório devolve
          // null quando alguma posição aberta não tem marca executável, e
          // imprimir 0 nesse caso seria afirmar que não há risco em aberto.
          nota={
            performance === null
              ? "indisponível"
              : performance.base_unrealized_usd === null
                ? "posição sem marca executável"
                : "marca no bid executável"
          }
        />
        <PnlCell
          titulo="Fees pagos"
          valor={usd(performance?.fees_paid_usd)}
          sinal={null}
          nota="acumulado"
        />
        <PnlCell
          titulo="Equity"
          valor={usd(portfolio?.equity_usd)}
          sinal={null}
          nota={`banca ${usd(portfolio?.bankroll_usd)}`}
        />
        <div className="pnl-cell pnl-cell--wide">
          <span className="pnl-titulo">Drawdown</span>
          <span className="pnl-valor">{pct(drawdown)}</span>
          <div
            className="drawdown-bar"
            role="meter"
            aria-valuenow={drawdown ?? 0}
            aria-valuemin={0}
            aria-valuemax={limite}
            aria-label="Drawdown contra o limite"
            title={`Limite de ${pct(limite, 0)} — atingi-lo leva o portfólio a HALTED, que não sai sozinho.`}
          >
            <span
              className="drawdown-fill"
              data-near={fracao >= 0.8 ? "true" : "false"}
              style={{ width: `${String(fracao * 100)}%` }}
            />
          </div>
          <span className="pnl-nota">
            limite {pct(limite, 0)} · pico {usd(portfolio?.high_water_mark_usd)}
          </span>
        </div>
      </div>

      <div className="pnl-badges">
        <Badge
          codigo={portfolio?.state ?? null}
          dicionario={ESTADO_PORTFOLIO}
          prefixo="Portfólio:"
        />
        <KillSwitchBadge overview={overview} />
        <Badge
          codigo={overview?.rfc_009_status ?? null}
          dicionario={STATUS_RFC009}
          prefixo="RFC-009:"
        />
        {portfolio?.reason === null ||
        portfolio?.reason === undefined ? null : (
          <span className="badge badge--neutro">{portfolio.reason}</span>
        )}
        {degraded ? (
          <span className="badge badge--alerta" role="alert">
            Números podem estar velhos — a última atualização falhou
          </span>
        ) : null}
      </div>
    </section>
  );
}

function PnlCell({
  titulo,
  valor,
  sinal,
  nota,
}: Readonly<{
  titulo: string;
  valor: string;
  sinal: number | null;
  nota: string;
}>) {
  const direcao =
    sinal === null || sinal === 0 ? "zero" : sinal > 0 ? "up" : "down";
  return (
    <div className="pnl-cell">
      <span className="pnl-titulo">{titulo}</span>
      <span className="pnl-valor" data-direcao={direcao}>
        {valor}
      </span>
      <span className="pnl-nota">{nota}</span>
    </div>
  );
}

function KillSwitchBadge({
  overview,
}: Readonly<{ overview: Overview | null }>) {
  const kill = overview?.kill_switch ?? null;
  if (kill === null) {
    return <span className="badge badge--neutro">Kill switch: —</span>;
  }
  if (!kill.engaged) {
    return (
      <span
        className="badge badge--ok"
        title={
          kill.rearmed_at === null
            ? "Nunca engatado."
            : `Rearmado em ${instante(kill.rearmed_at)}.`
        }
      >
        Kill switch: desarmado
      </span>
    );
  }
  return (
    <span
      className="badge badge--alerta"
      role="alert"
      title={kill.reason ?? "Sem motivo registrado."}
    >
      Kill switch: ENGATADO — o broker não aceita ordem até o rearme
      {kill.frozen_count === null || kill.frozen_count === 0
        ? ""
        : ` · ${String(kill.frozen_count)} mercado(s) congelado(s)`}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The "Visão geral" tab
// ---------------------------------------------------------------------------

export function OverviewPanel({
  overview,
  events,
  feedDegraded,
}: Readonly<{
  overview: Overview | null;
  events: readonly FeedEvent[];
  feedDegraded: boolean;
}>) {
  if (overview === null) {
    return (
      <section className="panel" aria-label="Visão geral">
        <p className="scope">Carregando a visão geral…</p>
      </section>
    );
  }

  const gates = overview.gates;
  const passaram = gates.filter((gate) => gate.status === "PASS").length;

  return (
    <section className="panel" aria-label="Visão geral">
      <div className="cards">
        <Card
          titulo="Coleta"
          tomCard={overview.collection.open_gaps > 0 ? "atencao" : "ok"}
        >
          <Linha
            rot="Último livro"
            val={idade(overview.collection.last_book_delta_age_ms)}
            nota={instante(overview.collection.last_book_delta_at)}
          />
          <Linha
            rot="Lacunas abertas"
            val={String(overview.collection.open_gaps)}
            nota={`${String(overview.collection.gaps_24h)} abertas nas últimas 24 h`}
          />
          <Linha
            rot="Universo"
            val={`${String(overview.collection.universe_members)} mercados`}
            nota="membros no instante atual"
          />
        </Card>

        <Card
          titulo="Modelo e sombra"
          tomCard={overview.model.active_models > 0 ? "ok" : "neutro"}
        >
          <Linha
            rot="Estimativas (1 h)"
            val={String(overview.model.estimates_last_hour)}
            nota={instante(overview.model.last_estimate_at)}
          />
          <Linha
            rot="Modelos promovidos"
            val={String(overview.model.active_models)}
            nota={
              overview.model.active_models === 0
                ? "sem modelo ativo: as decisões usam o baseline do mercado"
                : "servindo os consumidores"
            }
          />
          <Linha
            rot="Modelos em sombra"
            val={String(overview.model.shadow_models)}
            nota="gravam para os gates, invisíveis aos consumidores"
          />
        </Card>

        <Card
          titulo="Resolução"
          tomCard={overview.resolution.open_violations > 0 ? "alerta" : "ok"}
        >
          <Linha
            rot="Mercados pontuados"
            val={String(overview.resolution.markets)}
          />
          <Linha
            rot="Bloqueados"
            val={String(overview.resolution.blocked)}
            nota={`${rotulo("VETO", ACAO_RESOLUCAO)} ou ${rotulo("CIRCUIT_BREAKER", ACAO_RESOLUCAO)}`}
          />
          <Linha
            rot="Com colchão"
            val={String(overview.resolution.buffered)}
            nota="EV descontado do risco de resolução"
          />
          <Linha
            rot="Violações / divergências"
            val={`${String(overview.resolution.open_violations)} / ${String(overview.resolution.open_divergences)}`}
            nota="abertas"
          />
        </Card>

        <Card
          titulo="Broker paper"
          tomCard={overview.kill_switch?.engaged === true ? "alerta" : "ok"}
        >
          <Linha
            rot="Ordens abertas"
            val={String(overview.paper.open_orders)}
          />
          <Linha rot="Posições" val={String(overview.paper.positions)} />
          <Linha
            rot="Execuções (24 h)"
            val={String(overview.paper.fills_24h)}
          />
          <Linha
            rot="Disjuntores abertos"
            val={String(overview.circuit_breakers.open)}
            nota={`${String(overview.circuit_breakers.opened_last_hour)} abriram na última hora`}
          />
        </Card>

        <Card
          titulo="Gates da RFC-009"
          tomCard={overview.rfc_009_status === "BLOCKED" ? "alerta" : "ok"}
        >
          <p className="card-linha">
            <span className="card-val">
              <Badge
                codigo={overview.rfc_009_status}
                dicionario={STATUS_RFC009}
                compacto
              />
            </span>
            <span className="card-nota">
              {String(passaram)} de {String(gates.length)} passaram
            </span>
          </p>
          <table className="grid grid--compacta">
            <tbody>
              {gates.map((gate) => (
                <tr key={gate.gate}>
                  <th scope="row" title={rotulo(gate.gate, GATE)}>
                    {gate.gate}
                  </th>
                  <td>
                    <Badge
                      codigo={gate.status}
                      dicionario={SITUACAO_GATE}
                      compacto
                    />
                  </td>
                  <td
                    className="celula-motivo"
                    title={consequencia(gate.reason_code, MOTIVO_GATE)}
                  >
                    {rotulo(gate.reason_code, MOTIVO_GATE)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card
          titulo="Dados e disco"
          tomCard={
            (overview.storage.budget_used_pct ?? 0) >= 90 ? "alerta" : "ok"
          }
        >
          <Linha
            rot="Retido (bytes vivos)"
            val={bytes(overview.storage.live_bytes)}
            nota={`${String(overview.storage.budget_used_pct ?? 0)}% de ${bytes(overview.storage.budget_bytes)}`}
          />
          <Linha
            rot="Em arquivo"
            val={bytes(overview.storage.physical_bytes)}
            nota="o que ocupa disco agora"
          />
          <Linha
            rot="Inchaço"
            val={bytes(overview.storage.bloat_bytes)}
            nota="páginas que um DELETE não devolve — remédio é VACUUM FULL, não poda"
          />
          <div className="drawdown-bar" aria-hidden="true">
            <span
              className="drawdown-fill"
              data-near={
                (overview.storage.budget_used_pct ?? 0) >= 80 ? "true" : "false"
              }
              style={{
                width: `${String(Math.min(overview.storage.budget_used_pct ?? 0, 100))}%`,
              }}
            />
          </div>
        </Card>
      </div>

      <h3 className="feed-titulo">O que aconteceu</h3>
      <p className="scope">
        Só o que mudou alguma coisa. Decisões entram quando são{" "}
        <code>ACCEPTED</code> — as recusas são 234.549 das 234.571 linhas do log
        e enterrariam o resto. O feed é keyset por fonte: não pula nem repete.
      </p>
      {feedDegraded ? (
        <p className="scope" role="alert">
          O feed não atualizou na última tentativa.
        </p>
      ) : null}
      {events.length === 0 ? (
        <p className="scope">Nada novo desde que esta aba abriu.</p>
      ) : (
        <ul className="feed">
          {events.map((event) => (
            <li
              key={`${event.source}:${String(event.event_id)}`}
              data-severidade={event.severity}
            >
              <span className="feed-quando">{instante(event.occurred_at)}</span>
              <span className="feed-fonte" title={event.kind}>
                {rotulo(event.source, FONTE_EVENTO)}
              </span>
              <span className="feed-resumo">{rotulo(event.summary)}</span>
              <details>
                <summary>detalhe</summary>
                <pre>{JSON.stringify(event.detail, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Card({
  titulo,
  tomCard,
  children,
}: Readonly<{
  titulo: string;
  tomCard: "ok" | "atencao" | "alerta" | "neutro";
  children: React.ReactNode;
}>) {
  return (
    <section className="card" data-tom={tomCard}>
      <h3>{titulo}</h3>
      {children}
    </section>
  );
}

function Linha({
  rot,
  val,
  nota,
}: Readonly<{ rot: string; val: string; nota?: string }>) {
  return (
    <p className="card-linha">
      <span className="card-rot">{rot}</span>
      <span className="card-val">{val}</span>
      {nota === undefined ? null : <span className="card-nota">{nota}</span>}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Data plumbing, shared by the band and the tab
// ---------------------------------------------------------------------------

export interface OverviewState {
  readonly overview: Overview | null;
  readonly performance: Performance | null;
  readonly events: readonly FeedEvent[];
  readonly degraded: boolean;
  readonly feedDegraded: boolean;
}

/**
 * Polls the aggregate (15 s) and the feed (5 s) on separate timers.
 *
 * They are separate because they answer different questions at different
 * costs: the aggregate is ~10 aggregates and a catalog read, the feed is eight
 * keyset lookups that return nothing most of the time. Putting the feed on the
 * aggregate's timer would make "what just happened" three times staler than it
 * needs to be; putting the aggregate on the feed's would triple its cost for
 * numbers that do not move that fast.
 */
export function useOverview(
  accessToken: string,
  onUnauthorized: () => void,
): OverviewState {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [events, setEvents] = useState<readonly FeedEvent[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [feedDegraded, setFeedDegraded] = useState(false);
  const mounted = useRef(true);
  const cursor = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const [aggregate, report] = await Promise.all([
      fetchOverview(accessToken, fetch, controller.signal),
      fetchPerformance(accessToken, fetch, controller.signal),
    ]);
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    if (aggregate.kind === "unauthorized" || report.kind === "unauthorized") {
      onUnauthorized();
      return;
    }
    setDegraded(aggregate.kind === "error");
    if (aggregate.kind === "ok") {
      setOverview(aggregate.value);
    }
    // A failed performance call leaves the previous numbers rather than
    // blanking them: "—" where a value was is read as "went to zero".
    if (report.kind === "ok") {
      setPerformance(report.value);
    }
  }, [accessToken, onUnauthorized]);

  const pollFeed = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const page: { kind: string } & Partial<{ value: EventPage }> =
      await fetchEvents(accessToken, cursor.current, fetch, controller.signal);
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    if (page.kind === "unauthorized") {
      onUnauthorized();
      return;
    }
    setFeedDegraded(page.kind === "error");
    const value = page.value;
    if (page.kind !== "ok" || value === undefined) {
      return;
    }
    cursor.current = value.nextCursor;
    if (value.events.length === 0) {
      return;
    }
    setEvents((current) => {
      // Dedupe by (source, id) even though the cursor should make repeats
      // impossible: a cursor that a deploy invalidates would otherwise show
      // the operator the same event twice and make them doubt the feed.
      const vistos = new Set(
        current.map((event) => `${event.source}:${String(event.event_id)}`),
      );
      const novos = value.events.filter(
        (event) => !vistos.has(`${event.source}:${String(event.event_id)}`),
      );
      return [...novos, ...current].slice(0, FEED_CAP);
    });
  }, [accessToken, onUnauthorized]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    void pollFeed();
    const aggregateTimer = window.setInterval(() => {
      void refresh();
    }, OVERVIEW_REFRESH_MS);
    const feedTimer = window.setInterval(() => {
      void pollFeed();
    }, EVENTS_REFRESH_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(aggregateTimer);
      window.clearInterval(feedTimer);
    };
  }, [refresh, pollFeed]);

  return useMemo(
    () => ({ overview, performance, events, degraded, feedDegraded }),
    [overview, performance, events, degraded, feedDegraded],
  );
}

// ---------------------------------------------------------------------------
// Footer: which build is on screen, and whether it is the deployed one
// ---------------------------------------------------------------------------

/** Injected by Vite at build time from deploy/release-sha. */
declare const __BUILD_SHA__: string;

export const BUILD_SHA: string =
  typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "unknown";

/**
 * The lesson of 2026-08-31, made visible.
 *
 * The rearm button "did not work" for an hour because the SPA in memory was an
 * old bundle. Logging in inside the app does NOT reload the page, and
 * index.html is served no-store — so one reload fixes it and nothing on screen
 * said so. Now the panel reports its own revision and compares it against the
 * one the API reports.
 */
export function precisaRecarregar(
  bundle: string,
  releaseSha: string | null,
): boolean {
  // Only when BOTH revisions are known and they differ. An unknown bundle is
  // a dev checkout (the release-sha placeholder is literal there) and an
  // unknown API sha is an older API; warning in either case would train the
  // operator to ignore the warning, which is worse than not having it.
  if (releaseSha === null || bundle === "unknown" || releaseSha === "unknown") {
    return false;
  }
  return releaseSha !== bundle;
}

export function BuildFooter({
  releaseSha,
}: Readonly<{ releaseSha: string | null }>) {
  const bundle = BUILD_SHA;
  const desatualizado = precisaRecarregar(bundle, releaseSha);
  return (
    <footer className="rodape">
      {desatualizado ? (
        <p className="rodape-aviso" role="alert">
          <strong>Recarregue a página.</strong> Este painel está rodando o build{" "}
          <code>{bundle.slice(0, 12)}</code> e a API está em{" "}
          <code>{(releaseSha ?? "").slice(0, 12)}</code>. Entrar de novo não
          recarrega o bundle; só um reload troca o código em memória.
        </p>
      ) : null}
      <p className="rodape-linha">
        painel{" "}
        <code>
          {bundle === "unknown" ? "desconhecido" : bundle.slice(0, 12)}
        </code>
        {" · "}
        API{" "}
        <code>
          {releaseSha === null ? "desconhecida" : releaseSha.slice(0, 12)}
        </code>
      </p>
    </footer>
  );
}
