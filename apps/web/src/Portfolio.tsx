// RFC-013 dashboard tab. Read-only: nothing here places an order, and the two
// manual state controls (halt/resume) are deliberately absent from the UI as
// well as from the Nginx perimeter — leaving HALTED should take a deliberate
// operator action from inside, not a button on a page.
//
// One control DOES exist in the dashboard, and it is not here: the paper kill
// switch's rearm, on the Resolução tab, next to the state it acts on (owner
// decision, 2026-08-27). It is a different switch from these two — the RFC-011
// broker halt, not the RFC-013 portfolio state — and it is published as one
// exact path with a confirmation step. This tab's controls stay closed.
//
// The panel shows vetoed opportunities WITH their reason. Hiding them would let
// the page imply the universe is cleaner than it is; showing one without the
// reason is what the RFC forbids outright.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ACAO_RESOLUCAO,
  ESTADO_PORTFOLIO,
  GATILHO_TRANSICAO,
  GATE,
  LADO,
  LIMITADOR,
  MOTIVO_DECISAO,
  MOTIVO_GATE,
  RESULTADO_DECISAO,
  SITUACAO_GATE,
  STATUS_RFC009,
  TIPO_DECISAO,
  consequencia,
  rotulo,
} from "./dicionario";
import { Badge } from "./Overview.tsx";
import {
  fetchDecisions,
  fetchExposures,
  fetchGateMeasurements,
  fetchGates,
  fetchOpportunities,
  fetchPortfolioState,
  type Decision,
  type Exposure,
  type GateMeasurementPage,
  type GateSnapshot,
  type Opportunity,
  type PortfolioStateSnapshot,
} from "./portfolio";

const REFRESH_MS = 30_000;
// The other tabs already bounded their polls; this one did not, so a stalled
// API left requests pending and the next tick piled another one on top.
const REQUEST_TIMEOUT_MS = 5_000;
// Client-side paging over the 200/500-row lists the endpoints return whole.
const ROWS_PER_PAGE = 25;

type Section =
  | "oportunidades"
  | "rapidos"
  | "exposicao"
  | "estado"
  | "gates"
  | "consulta"
  | "decisoes";

const GATE_OPTIONS = ["G1", "G2", "G3", "G4", "G5", "G6"] as const;
const STATUS_OPTIONS = ["PASS", "FAIL", "INSUFFICIENT_DATA"] as const;
const PAGE_SIZE = 25;

interface MeasurementFilters {
  readonly gate: string;
  readonly status: string;
  readonly from: string;
  readonly to: string;
}

const NO_FILTERS: MeasurementFilters = {
  gate: "",
  status: "",
  from: "",
  to: "",
};

/**
 * A compact one-line summary of a measurement's metrics.
 *
 * Only scalars, and only the first few: the full object goes in the expandable
 * block below, so the table stays readable while nothing is hidden.
 */
function metricSummary(metrics: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (parts.length >= 4) {
      break;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.length === 0 ? "—" : parts.join(" · ");
}

interface Loaded {
  readonly opportunities: readonly Opportunity[];
  readonly exposures: readonly Exposure[];
  readonly state: PortfolioStateSnapshot | null;
  readonly gates: GateSnapshot | null;
  readonly decisions: readonly Decision[];
}

const EMPTY: Loaded = {
  opportunities: [],
  exposures: [],
  state: null,
  gates: null,
  decisions: [],
};

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function age(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  if (ms < 1_000) {
    return `${String(Math.round(ms))} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)} s`;
  }
  return `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * Time from now until an instant, or null when there is no instant at all.
 *
 * A market with no recorded end is NOT a market with a distant end: it is one
 * whose deadline we do not know, and the Rápidos tab keeps the two apart.
 */
function horizonMs(endTs: string | null, now: number): number | null {
  if (endTs === null) {
    return null;
  }
  const parsed = Date.parse(endTs);
  return Number.isNaN(parsed) ? null : parsed - now;
}

function horizonLabel(ms: number | null): string {
  if (ms === null) {
    return "sem instante";
  }
  if (ms <= 0) {
    return "vencido";
  }
  if (ms < 3_600_000) {
    return `${(ms / 60_000).toFixed(0)} min`;
  }
  if (ms < 86_400_000) {
    return `${(ms / 3_600_000).toFixed(1)} h`;
  }
  return `${(ms / 86_400_000).toFixed(1)} d`;
}

function numeric(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Cost of entering and leaving immediately, per share.
 *
 * Buying at the ask and selling at the bid loses the spread once; fees and
 * slippage are charged on each leg. So: spread + 2x(fee + slippage). The
 * components are rendered next to the total precisely because this is an
 * arithmetic the operator should be able to check rather than trust — and
 * because in production today fee and slippage are 0.000000, which makes the
 * round trip exactly the spread, and that is worth being able to see.
 */
export function roundTripCost(panel: {
  spread: string | null;
  fee: string | null;
  slippage: string | null;
}): number | null {
  const spread = numeric(panel.spread);
  if (spread === null) {
    return null;
  }
  const fee = numeric(panel.fee) ?? 0;
  const slippage = numeric(panel.slippage) ?? 0;
  return spread + 2 * (fee + slippage);
}

/**
 * Client-side paging over a list the endpoint returns whole.
 *
 * The endpoints cap at 200 (panel, exposures) and 500 (decisions) and have no
 * cursor; paging here does not reduce what crosses the wire, it stops the page
 * from laying out 500 rows on every 30-second tick. The gate-measurement
 * history is the one list with real keyset paging, and it keeps it.
 */
function usePage<T>(rows: readonly T[]): {
  readonly page: readonly T[];
  readonly index: number;
  readonly pages: number;
  readonly setIndex: (next: number) => void;
} {
  const [index, setIndex] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const clamped = Math.min(index, pages - 1);
  return {
    page: rows.slice(clamped * ROWS_PER_PAGE, (clamped + 1) * ROWS_PER_PAGE),
    index: clamped,
    pages,
    setIndex,
  };
}

function Pager({
  index,
  pages,
  total,
  onChange,
  label,
}: Readonly<{
  index: number;
  pages: number;
  total: number;
  onChange: (next: number) => void;
  label: string;
}>) {
  if (total === 0) {
    return null;
  }
  return (
    <nav className="pager" aria-label={label}>
      <button
        type="button"
        disabled={index === 0}
        onClick={() => {
          onChange(index - 1);
        }}
      >
        Anterior
      </button>
      <span>
        Página {String(index + 1)} de {String(pages)} · {String(total)} linhas
      </span>
      <button
        type="button"
        disabled={index >= pages - 1}
        onClick={() => {
          onChange(index + 1);
        }}
      >
        Próxima
      </button>
    </nav>
  );
}

/**
 * One opportunity, with the risk fields the client already parsed and the page
 * never showed.
 *
 * `invalidation_condition`, `scenarios.worst`, the limiter list and the three
 * data ages have been coming down the wire and being dropped on the floor since
 * RFC-013 shipped (RFC-015 §1). They go in the expandable block rather than the
 * row so the table still reads as a table.
 */
function OportunidadeLinha({
  opportunity,
}: Readonly<{ opportunity: Opportunity }>) {
  const panel = opportunity.panel;
  return (
    <>
      <tr>
        <td>
          <code title={opportunity.condition_id}>
            {opportunity.condition_id.slice(0, 12)}…
          </code>
        </td>
        <td title={panel.suggested_side ?? undefined}>
          {rotulo(panel.suggested_side, LADO)}
        </td>
        <td>
          {panel.market_bid ?? "—"} / {panel.market_ask ?? "—"}
        </td>
        <td>
          {panel.q ?? "—"} [{panel.q_lo ?? "—"}, {panel.q_hi ?? "—"}]
        </td>
        <td>{panel.edge_net ?? "—"}</td>
        <td>{panel.max_size_shares ?? "—"}</td>
        <td title={consequencia(panel.binding_constraint, LIMITADOR)}>
          {rotulo(panel.binding_constraint, LIMITADOR)}
        </td>
        <td>
          <Badge codigo={panel.resolution_action} dicionario={ACAO_RESOLUCAO} />
        </td>
        <td>{age(panel.book_age_ms)}</td>
        <td>
          {opportunity.vetoed ? (
            <span className="badge badge--alerta">
              Vetado: {opportunity.veto_reason ?? "sem motivo"}
            </span>
          ) : opportunity.entrable ? (
            <span className="badge badge--ok">entrável</span>
          ) : (
            <span className="badge badge--neutro">
              {panel.entry_reason ?? "não entrável"}
            </span>
          )}
        </td>
      </tr>
      <tr className="linha-detalhe">
        <td colSpan={10}>
          <details>
            <summary>risco, custos e atualidade</summary>
            <div className="detalhe-grid">
              <p>
                <span className="card-rot">Invalidação</span>
                <span className="card-val">
                  {panel.invalidation_condition ??
                    "nenhuma condição registrada"}
                </span>
              </p>
              <p>
                <span className="card-rot">Pior caso</span>
                <span className="card-val">{panel.worst_case ?? "—"}</span>
              </p>
              <p>
                <span className="card-rot">p(50/50)</span>
                <span className="card-val">{panel.p_5050 ?? "—"}</span>
              </p>
              <p>
                <span className="card-rot">Lockup esperado</span>
                <span className="card-val">
                  {panel.expected_lockup_s === null
                    ? "—"
                    : `${(panel.expected_lockup_s / 3600).toFixed(1)} h`}
                </span>
              </p>
              <p>
                <span className="card-rot">Custos</span>
                <span className="card-val">
                  fee {panel.fee ?? "—"} · slippage {panel.slippage ?? "—"} ·
                  capital {panel.capital ?? "—"} · colchão{" "}
                  {panel.resolution_buffer ?? "—"} · margem{" "}
                  {panel.safety_margin ?? "—"}
                </span>
              </p>
              <p>
                <span className="card-rot">Idade dos dados</span>
                <span className="card-val">
                  livro {age(panel.book_age_ms)} · estimativa{" "}
                  {age(panel.estimate_age_ms)} · resolução{" "}
                  {age(panel.resolution_age_ms)}
                </span>
              </p>
              <p>
                <span className="card-rot">Limitadores</span>
                <span className="card-val">
                  {panel.limiters.length === 0
                    ? "nenhum — a decisão parou antes do dimensionamento"
                    : panel.limiters
                        .map(
                          (limiter) =>
                            `${rotulo(limiter.constraint, LIMITADOR)}: ${limiter.max_shares ?? "—"}`,
                        )
                        .join(" · ")}
                </span>
              </p>
              <p>
                <span className="card-rot">Estimativa</span>
                <span className="card-val">
                  <Badge codigo={panel.estimate_source} /> · spread{" "}
                  {panel.spread ?? "—"} · microprice {panel.microprice ?? "—"}
                </span>
              </p>
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}

export function PortfolioPanel({
  accessToken,
  onUnauthorized,
}: Readonly<{ accessToken: string; onUnauthorized: () => void }>) {
  const [section, setSection] = useState<Section>("oportunidades");
  const [data, setData] = useState<Loaded>(EMPTY);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  // The query space keeps its own state: it is a deliberate query, not part of
  // the 30-second refresh, so paging through months of measurements is not
  // yanked back to page one by a timer.
  const [filters, setFilters] = useState<MeasurementFilters>(NO_FILTERS);
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const [measurements, setMeasurements] = useState<GateMeasurementPage | null>(
    null,
  );
  const [measurementsFailed, setMeasurementsFailed] = useState(false);

  const oportunidades = usePage(data.opportunities);
  const decisoes = usePage(data.decisions);

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const signal = controller.signal;
    const [opportunities, exposures, state, gates, decisions] =
      await Promise.all([
        fetchOpportunities(accessToken, fetch, signal),
        fetchExposures(accessToken, fetch, signal),
        fetchPortfolioState(accessToken, fetch, signal),
        fetchGates(accessToken, fetch, signal),
        fetchDecisions(accessToken, fetch, signal),
      ]);
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    const results = [opportunities, exposures, state, gates, decisions];
    if (results.some((result) => result.kind === "unauthorized")) {
      onUnauthorized();
      return;
    }
    setFailed(results.every((result) => result.kind === "error"));
    setData({
      opportunities:
        opportunities.kind === "ok" ? opportunities.value : EMPTY.opportunities,
      exposures: exposures.kind === "ok" ? exposures.value : EMPTY.exposures,
      state: state.kind === "ok" ? state.value : null,
      gates: gates.kind === "ok" ? gates.value : null,
      decisions: decisions.kind === "ok" ? decisions.value : EMPTY.decisions,
    });
  }, [accessToken, onUnauthorized]);

  const loadMeasurements = useCallback(async (): Promise<void> => {
    const cursor = cursors[cursors.length - 1];
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const result = await fetchGateMeasurements(
      accessToken,
      {
        ...(filters.gate === "" ? {} : { gate: filters.gate }),
        ...(filters.status === "" ? {} : { status: filters.status }),
        ...(filters.from === "" ? {} : { from: `${filters.from}T00:00:00Z` }),
        ...(filters.to === "" ? {} : { to: `${filters.to}T23:59:59Z` }),
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      },
      fetch,
      controller.signal,
    );
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    if (result.kind === "unauthorized") {
      onUnauthorized();
      return;
    }
    setMeasurementsFailed(result.kind === "error");
    setMeasurements(result.kind === "ok" ? result.value : null);
  }, [accessToken, cursors, filters, onUnauthorized]);

  useEffect(() => {
    if (section !== "consulta") {
      return;
    }
    void loadMeasurements();
  }, [section, loadMeasurements]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [refresh]);

  const stateRow = data.state?.state ?? null;

  return (
    <section className="panel" aria-label="Motor de portfólio">
      <p className="scope">
        <strong>SIMULAÇÃO — SEM EXECUÇÃO REAL.</strong> Nenhuma ordem real é
        criada. Não existe stop-loss: um livro binário pode saltar de preço alto
        para perto de zero sem negociar os níveis intermediários, então o
        dimensionamento assume perda total da posição.
      </p>

      {stateRow === null ? null : (
        <p className="scope" data-state={stateRow.state}>
          Estado do portfólio:{" "}
          <Badge codigo={stateRow.state} dicionario={ESTADO_PORTFOLIO} />
          {stateRow.reason === null ? "" : ` — ${stateRow.reason}`}. Banca{" "}
          {usd(stateRow.bankroll_usd)}, equity {usd(stateRow.equity_usd)},
          drawdown {pct(stateRow.drawdown)}. Os mesmos números estão na faixa
          acima, em todas as abas.
        </p>
      )}

      <nav className="tabs" aria-label="Seções do portfólio">
        {(
          [
            ["oportunidades", "Oportunidades"],
            ["rapidos", "Rápidos"],
            ["exposicao", "Exposição"],
            ["estado", "Estado"],
            ["gates", "Gates"],
            ["consulta", "Consulta"],
            ["decisoes", "Decisões"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={section === key ? "tab tab--active" : "tab"}
            onClick={() => {
              setSection(key);
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {failed ? (
        <p className="scope">
          Não foi possível carregar os dados do portfólio. O motor pode não
          estar ativo ainda.
        </p>
      ) : null}

      {section === "oportunidades" ? (
        <>
          <table className="grid grid--compacta">
            <caption>
              Painel de oportunidade. Um mercado vetado aparece aqui com o
              motivo do veto — nunca escondido, e nunca como &quot;quase
              entrável&quot;. Abra a linha para ver invalidação, cenários,
              limitadores e a idade de cada entrada.
            </caption>
            <thead>
              <tr>
                <th scope="col">Mercado</th>
                <th scope="col">Lado</th>
                <th scope="col">Bid/Ask</th>
                <th scope="col">q [q_lo, q_hi]</th>
                <th scope="col">Edge líq.</th>
                <th scope="col">Tamanho</th>
                <th scope="col">Limitador</th>
                <th scope="col">Risco resol.</th>
                <th scope="col">Livro</th>
                <th scope="col">Situação</th>
              </tr>
            </thead>
            <tbody>
              {oportunidades.page.map((opportunity) => (
                <OportunidadeLinha
                  key={opportunity.token_id}
                  opportunity={opportunity}
                />
              ))}
            </tbody>
          </table>
          <Pager
            index={oportunidades.index}
            pages={oportunidades.pages}
            total={data.opportunities.length}
            onChange={oportunidades.setIndex}
            label="Paginação das oportunidades"
          />
        </>
      ) : null}

      {section === "rapidos" ? (
        <RapidosSection opportunities={data.opportunities} />
      ) : null}

      {section === "exposicao" ? (
        <table className="grid">
          <caption>
            Exposição por dimensão. Todo valor assume{" "}
            <strong>perda total</strong> da posição, nunca marcação a mercado.
          </caption>
          <thead>
            <tr>
              <th scope="col">Dimensão</th>
              <th scope="col">Chave</th>
              <th scope="col">Pior caso</th>
              <th scope="col">Cap</th>
              <th scope="col">Uso</th>
              <th scope="col">Posições</th>
              <th scope="col">Custo de unwind</th>
            </tr>
          </thead>
          <tbody>
            {data.exposures.map((exposure) => (
              <tr key={`${exposure.dimension}:${exposure.dimension_key}`}>
                <td>{exposure.dimension}</td>
                <td>{exposure.dimension_key.slice(0, 24)}</td>
                <td>{usd(exposure.worst_case_usd)}</td>
                <td>{usd(exposure.cap_usd)}</td>
                <td>{pct(exposure.utilization)}</td>
                <td>{exposure.position_count ?? "—"}</td>
                <td>{usd(exposure.unwind_cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {section === "estado" ? (
        <>
          <table className="grid">
            <caption>Transições de estado (append-only).</caption>
            <thead>
              <tr>
                <th scope="col">De</th>
                <th scope="col">Para</th>
                <th scope="col">Motivo</th>
                <th scope="col">Gatilho</th>
                <th scope="col">Quando</th>
              </tr>
            </thead>
            <tbody>
              {(data.state?.transitions ?? []).map((transition, index) => (
                <tr key={`${transition.at ?? "?"}-${String(index)}`}>
                  <td>
                    <Badge
                      codigo={transition.from_state}
                      dicionario={ESTADO_PORTFOLIO}
                    />
                  </td>
                  <td>
                    <Badge
                      codigo={transition.to_state}
                      dicionario={ESTADO_PORTFOLIO}
                    />
                  </td>
                  <td>{transition.reason ?? "—"}</td>
                  <td title={transition.trigger_source ?? undefined}>
                    {rotulo(transition.trigger_source, GATILHO_TRANSICAO)}
                  </td>
                  <td>{transition.at ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data.state?.transitions ?? []).length === 0 ? (
            <p className="scope">
              Nenhuma transição registrada — o portfólio nunca saiu de{" "}
              <code>NORMAL</code>.
            </p>
          ) : null}
          <p className="scope">
            <code>HALTED</code> não sai sozinho: nem com drawdown recuperado,
            nem com janela expirada, nem com restart. Só com ação manual do
            proprietário, feita por dentro — o perímetro não publica o endpoint.
          </p>
        </>
      ) : null}

      {section === "gates" ? (
        <>
          <p className="scope">
            RFC-009:{" "}
            <Badge
              codigo={data.gates?.rfc009Status ?? "BLOCKED"}
              dicionario={STATUS_RFC009}
            />{" "}
            {data.gates?.calibratedExpectation ?? ""}
          </p>
          <table className="grid">
            <caption>
              Gates G1–G6. <code>INSUFFICIENT_DATA</code> não é o mesmo que{" "}
              <code>FAIL</code>: um é &quot;ainda não medimos o bastante&quot;,
              o outro é &quot;medimos e não funcionou&quot;.
            </caption>
            <thead>
              <tr>
                <th scope="col">Gate</th>
                <th scope="col">Situação</th>
                <th scope="col">Motivo</th>
                <th scope="col">Medido em</th>
              </tr>
            </thead>
            <tbody>
              {(data.gates?.gates ?? []).map((gate) => (
                <tr key={gate.gate}>
                  <th scope="row" title={consequencia(gate.gate, GATE)}>
                    {rotulo(gate.gate, GATE)}
                  </th>
                  <td>
                    <Badge codigo={gate.status} dicionario={SITUACAO_GATE} />
                  </td>
                  <td title={consequencia(gate.reason_code, MOTIVO_GATE)}>
                    {rotulo(gate.reason_code, MOTIVO_GATE)}
                  </td>
                  <td>{gate.measured_at ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {section === "consulta" ? (
        <>
          <p className="scope">
            Espaço de consulta do histórico de medições de gate. Substitui o
            relatório semanal: os mesmos números, consultados quando você
            quiser. A tabela <code>portfolio_gate_measurements</code> é imutável
            e nunca é podada — é a trilha de evidência de qualquer decisão
            futura sobre a RFC-009.
          </p>

          <form
            className="filters"
            aria-label="Filtros da consulta"
            onSubmit={(event) => {
              event.preventDefault();
              setCursors([]);
            }}
          >
            <label>
              Gate
              <select
                value={filters.gate}
                onChange={(event) => {
                  setCursors([]);
                  setFilters((current) => ({
                    ...current,
                    gate: event.target.value,
                  }));
                }}
              >
                <option value="">todos</option>
                {GATE_OPTIONS.map((gate) => (
                  <option key={gate} value={gate}>
                    {gate}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Situação
              <select
                value={filters.status}
                onChange={(event) => {
                  setCursors([]);
                  setFilters((current) => ({
                    ...current,
                    status: event.target.value,
                  }));
                }}
              >
                <option value="">todas</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              De
              <input
                type="date"
                value={filters.from}
                onChange={(event) => {
                  setCursors([]);
                  setFilters((current) => ({
                    ...current,
                    from: event.target.value,
                  }));
                }}
              />
            </label>
            <label>
              Até
              <input
                type="date"
                value={filters.to}
                onChange={(event) => {
                  setCursors([]);
                  setFilters((current) => ({
                    ...current,
                    to: event.target.value,
                  }));
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setCursors([]);
                setFilters(NO_FILTERS);
              }}
            >
              Limpar
            </button>
          </form>

          {measurementsFailed ? (
            <p className="scope">
              Não foi possível carregar o histórico de medições.
            </p>
          ) : null}

          <table className="grid">
            <caption>
              Medições de gate, da mais recente para a mais antiga.{" "}
              <code>INSUFFICIENT_DATA</code> não é <code>FAIL</code>: um é
              &quot;ainda não medimos o bastante&quot;, o outro é &quot;medimos
              e não funcionou&quot;.
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Gate</th>
                <th scope="col">Situação</th>
                <th scope="col">Motivo</th>
                <th scope="col">Números</th>
                <th scope="col">Janela</th>
                <th scope="col">Medido em</th>
                <th scope="col">Config</th>
              </tr>
            </thead>
            <tbody>
              {(measurements?.measurements ?? []).map((measurement) => (
                <tr
                  key={String(
                    measurement.measurement_id ??
                      `${measurement.gate}-${measurement.measured_at ?? "?"}`,
                  )}
                >
                  <td>{measurement.measurement_id ?? "—"}</td>
                  <td>{measurement.gate}</td>
                  <td>
                    <Badge
                      codigo={measurement.status}
                      dicionario={SITUACAO_GATE}
                    />
                  </td>
                  <td
                    title={consequencia(measurement.reason_code, MOTIVO_GATE)}
                  >
                    {rotulo(measurement.reason_code, MOTIVO_GATE)}
                  </td>
                  <td>
                    <details>
                      <summary>{metricSummary(measurement.metrics)}</summary>
                      <pre>{JSON.stringify(measurement.metrics, null, 2)}</pre>
                    </details>
                  </td>
                  <td>
                    {measurement.window_from ?? "—"} →{" "}
                    {measurement.window_to ?? "—"}
                  </td>
                  <td>{measurement.measured_at ?? "—"}</td>
                  <td>{measurement.config_version ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <nav className="pager" aria-label="Paginação das medições">
            <button
              type="button"
              disabled={cursors.length === 0}
              onClick={() => {
                setCursors((current) => current.slice(0, -1));
              }}
            >
              Página anterior
            </button>
            <span>
              Página {String(cursors.length + 1)} ·{" "}
              {String((measurements?.measurements ?? []).length)} medições
            </span>
            <button
              type="button"
              disabled={(measurements?.nextCursor ?? null) === null}
              onClick={() => {
                const next = measurements?.nextCursor ?? null;
                if (next !== null) {
                  setCursors((current) => [...current, next]);
                }
              }}
            >
              Próxima página
            </button>
          </nav>

          <p className="scope">{measurements?.calibratedExpectation ?? ""}</p>
        </>
      ) : null}

      {section === "decisoes" ? (
        <>
          <p className="scope">
            Ordenado por <code>decision_id</code>, que é a ordem de inserção e é
            total. Ordenar por <code>decision_ts</code> varria a tabela inteira
            (715 ms medidos contra o orçamento de 1 s da API) e empatava entre
            decisões do mesmo ciclo.
          </p>
          <table className="grid grid--compacta">
            <caption>
              Decision log. Toda decisão registra o limitador que a limitou e o
              hash da config vigente.
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Tipo</th>
                <th scope="col">Mercado</th>
                <th scope="col">Lado</th>
                <th scope="col">Edge líq.</th>
                <th scope="col">Tamanho</th>
                <th scope="col">Limitador</th>
                <th scope="col">Resultado</th>
                <th scope="col">Motivo</th>
              </tr>
            </thead>
            <tbody>
              {decisoes.page.map((decision, index) => (
                // decision_id is the primary key and is present on every row
                // the endpoint returns. The old fallback was Math.random(),
                // which gave every row a new key on every render and made React
                // rebuild the whole table 500 rows at a time; the index is a
                // stable fallback for the row that somehow has no id.
                <tr
                  key={
                    decision.decision_id === null
                      ? `sem-id-${String(index)}`
                      : String(decision.decision_id)
                  }
                >
                  <td>{decision.decision_id ?? "—"}</td>
                  <td title={decision.decision_kind ?? undefined}>
                    {rotulo(decision.decision_kind, TIPO_DECISAO)}
                  </td>
                  <td>
                    <code title={decision.condition_id ?? undefined}>
                      {(decision.condition_id ?? "").slice(0, 12)}…
                    </code>
                  </td>
                  <td title={decision.market_side ?? undefined}>
                    {rotulo(decision.market_side, LADO)}
                  </td>
                  <td>{decision.edge_net ?? "—"}</td>
                  <td>{decision.size_shares ?? "—"}</td>
                  <td
                    title={consequencia(decision.binding_constraint, LIMITADOR)}
                  >
                    {rotulo(decision.binding_constraint, LIMITADOR)}
                  </td>
                  <td>
                    <Badge
                      codigo={decision.outcome}
                      dicionario={RESULTADO_DECISAO}
                    />
                  </td>
                  <td
                    title={consequencia(decision.reason_code, MOTIVO_DECISAO)}
                  >
                    {rotulo(decision.reason_code, MOTIVO_DECISAO)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            index={decisoes.index}
            pages={decisoes.pages}
            total={data.decisions.length}
            onChange={decisoes.setIndex}
            label="Paginação do decision log"
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * "Rápidos": the panel ranked by how long the market has left to live.
 *
 * This tab exists because RFC-016 put the real end instant in reach (the
 * versioned rule chain, which the opportunities endpoint now reads — see
 * RFC-015 §8). Before that, the horizon a consumer could see was the date-only
 * end, which is midnight of the expiry day and therefore negative for most of
 * the day.
 *
 * The empty state is deliberately specific. A market universe with nothing
 * expiring soon is a NORMAL state of this system — 142 markets expired on
 * 2026-09-01 and the next batch was 11 hours out — and "nenhum mercado" with
 * no explanation reads as a broken tab.
 */
function RapidosSection({
  opportunities,
}: Readonly<{ opportunities: readonly Opportunity[] }>) {
  const [janelaHoras, setJanelaHoras] = useState(6);
  const agora = Date.now();

  const comHorizonte = opportunities
    .map((opportunity) => ({
      opportunity,
      ms: horizonMs(opportunity.end_ts, agora),
    }))
    .filter((linha) => linha.ms !== null && linha.ms > 0)
    .sort((left, right) => (left.ms ?? 0) - (right.ms ?? 0));
  const naJanela = comHorizonte.filter(
    (linha) => (linha.ms ?? 0) <= janelaHoras * 3_600_000,
  );
  const semInstante = opportunities.filter(
    (opportunity) => opportunity.end_ts === null,
  ).length;
  const pagina = usePage(naJanela);

  return (
    <>
      <p className="scope">
        Mercados ordenados pelo <strong>instante real de fim</strong> (RFC-016:
        a cadeia versionada da regra, não a data sem hora). O custo de
        ida-e-volta é <code>spread + 2 × (fee + slippage)</code> por cota — os
        componentes ficam ao lado para você conferir a conta em vez de confiar
        nela.
      </p>

      <form className="filters" aria-label="Janela do horizonte">
        <label>
          Janela
          <select
            value={String(janelaHoras)}
            onChange={(event) => {
              setJanelaHoras(Number(event.target.value));
              pagina.setIndex(0);
            }}
          >
            {[1, 6, 24, 168, 8760].map((horas) => (
              <option key={horas} value={String(horas)}>
                {horas === 1
                  ? "1 hora"
                  : horas < 168
                    ? `${String(horas)} horas`
                    : horas === 168
                      ? "7 dias"
                      : "tudo"}
              </option>
            ))}
          </select>
        </label>
      </form>

      {naJanela.length === 0 ? (
        <p className="scope">
          Nenhum mercado vence nas próximas{" "}
          {janelaHoras === 1 ? "1 hora" : `${String(janelaHoras)} horas`}.{" "}
          {comHorizonte.length === 0
            ? "Nenhum mercado do painel tem vencimento futuro registrado."
            : `O painel tem ${String(comHorizonte.length)} mercado(s) com vencimento futuro; o mais próximo é em ${horizonLabel(comHorizonte[0]?.ms ?? null)}.`}{" "}
          Isso é um estado normal: o universo vence em lotes, e entre um lote e
          o seguinte não há nada rápido.
        </p>
      ) : null}

      {semInstante === 0 ? null : (
        <p className="scope">
          {String(semInstante)} mercado(s) do painel não têm instante de fim
          registrado e ficam fora desta lista. Isso é diferente de &quot;vence
          longe&quot;.
        </p>
      )}

      <table className="grid grid--compacta">
        <caption>
          Do que vence primeiro para o que vence depois. Um mercado vetado
          continua aparecendo, com o motivo.
        </caption>
        <thead>
          <tr>
            <th scope="col">Mercado</th>
            <th scope="col">Falta</th>
            <th scope="col">Vence em</th>
            <th scope="col">Lado</th>
            <th scope="col">Bid/Ask</th>
            <th scope="col">Spread</th>
            <th scope="col">Ida-e-volta</th>
            <th scope="col">Edge líq.</th>
            <th scope="col">Situação</th>
          </tr>
        </thead>
        <tbody>
          {pagina.page.map(({ opportunity, ms }) => {
            const panel = opportunity.panel;
            const custo = roundTripCost(panel);
            return (
              <tr key={opportunity.token_id}>
                <td>
                  <code title={opportunity.condition_id}>
                    {opportunity.condition_id.slice(0, 12)}…
                  </code>
                </td>
                <td>{horizonLabel(ms)}</td>
                <td>
                  {(opportunity.end_ts ?? "").replace("T", " ").slice(0, 16)}
                </td>
                <td title={panel.suggested_side ?? undefined}>
                  {rotulo(panel.suggested_side, LADO)}
                </td>
                <td>
                  {panel.market_bid ?? "—"} / {panel.market_ask ?? "—"}
                </td>
                <td>{panel.spread ?? "—"}</td>
                <td
                  title={`spread ${panel.spread ?? "—"} + 2 × (fee ${panel.fee ?? "—"} + slippage ${panel.slippage ?? "—"})`}
                >
                  {custo === null ? "—" : custo.toFixed(6)}
                </td>
                <td>{panel.edge_net ?? "—"}</td>
                <td>
                  {opportunity.vetoed ? (
                    <span className="badge badge--alerta">
                      Vetado: {opportunity.veto_reason ?? "sem motivo"}
                    </span>
                  ) : opportunity.entrable ? (
                    <span className="badge badge--ok">entrável</span>
                  ) : (
                    <span className="badge badge--neutro">
                      {panel.entry_reason ?? "não entrável"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Pager
        index={pagina.index}
        pages={pagina.pages}
        total={naJanela.length}
        onChange={pagina.setIndex}
        label="Paginação dos mercados rápidos"
      />
    </>
  );
}
