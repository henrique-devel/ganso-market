// RFC-013 dashboard sections. Read-only: nothing here places an order, and the
// two manual state controls (halt/resume) are deliberately absent from the UI
// as well as from the Nginx perimeter — leaving HALTED should take a deliberate
// operator action from inside, not a button on a page.
//
// RFC-026 D5 turned this one tab into the body of three screens. The panel now
// takes the list of sections to render, and App.tsx composes them: Carteira
// (tela 2) = exposição + estado, Decisões (tela 3) = decisões + consulta,
// Sistema (tela 6) = gates. "Oportunidades" and "Rápidos" left for the Mesa
// (tela 1, `Mesa.tsx`), which is where the opportunity panel lives now — the
// horizon helpers and the round-trip cost stay exported here because that is
// where they were measured and tested.
//
// Only the sections asked for are fetched. A screen that shows exposure does
// not spend a request on the decision log it is not going to render, and the
// 20 req/min the RFC budgets stay for the screens that need them.
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
  CATEGORIA,
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
  fetchPortfolioState,
  type Decision,
  type Exposure,
  type GateMeasurementPage,
  type GateSnapshot,
  type PortfolioStateSnapshot,
} from "./portfolio";

const REFRESH_MS = 30_000;
// The other tabs already bounded their polls; this one did not, so a stalled
// API left requests pending and the next tick piled another one on top.
const REQUEST_TIMEOUT_MS = 5_000;
// Client-side paging over the 200/500-row lists the endpoints return whole.
const ROWS_PER_PAGE = 25;

export type Section =
  "exposicao" | "estado" | "gates" | "consulta" | "decisoes";

const TODAS_AS_SECOES: readonly Section[] = [
  "exposicao",
  "estado",
  "gates",
  "consulta",
  "decisoes",
];

const ROTULO_DA_SECAO: Readonly<Record<Section, string>> = {
  exposicao: "Exposição",
  estado: "Estado",
  gates: "Gates",
  consulta: "Consulta",
  decisoes: "Decisões",
};

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
  readonly exposures: readonly Exposure[];
  readonly state: PortfolioStateSnapshot | null;
  readonly gates: GateSnapshot | null;
  readonly decisions: readonly Decision[];
}

const EMPTY: Loaded = {
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

/**
 * Time from now until an instant, or null when there is no instant at all.
 *
 * A market with no recorded end is NOT a market with a distant end: it is one
 * whose deadline we do not know, and the Rápidos tab keeps the two apart.
 */
export function horizonMs(endTs: string | null, now: number): number | null {
  if (endTs === null) {
    return null;
  }
  const parsed = Date.parse(endTs);
  return Number.isNaN(parsed) ? null : parsed - now;
}

export function horizonLabel(ms: number | null): string {
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

export function PortfolioPanel({
  accessToken,
  onUnauthorized,
  sections = TODAS_AS_SECOES,
  rotulo: rotuloDaTela,
}: Readonly<{
  accessToken: string;
  onUnauthorized: () => void;
  /** Quais seções esta tela mostra — e, por consequência, o que ela busca. */
  sections?: readonly Section[];
  rotulo?: string;
}>) {
  const primeira: Section = sections[0] ?? "exposicao";
  const [section, setSection] = useState<Section>(primeira);
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

  const decisoes = usePage(data.decisions);

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const signal = controller.signal;
    // Só o que a tela mostra. `estado` também carrega a exposição porque o
    // cabeçalho do estado mostra a banca contra os caps; o resto é um por um.
    const quer = (secao: Section): boolean => sections.includes(secao);
    const [exposures, state, gates, decisions] = await Promise.all([
      quer("exposicao") ? fetchExposures(accessToken, fetch, signal) : null,
      quer("estado") ? fetchPortfolioState(accessToken, fetch, signal) : null,
      quer("gates") ? fetchGates(accessToken, fetch, signal) : null,
      quer("decisoes") ? fetchDecisions(accessToken, fetch, signal) : null,
    ]);
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    const results = [exposures, state, gates, decisions].filter(
      (result) => result !== null,
    );
    if (results.some((result) => result.kind === "unauthorized")) {
      onUnauthorized();
      return;
    }
    setFailed(
      results.length > 0 && results.every((result) => result.kind === "error"),
    );
    setData((atual) => ({
      exposures: exposures?.kind === "ok" ? exposures.value : atual.exposures,
      state: state?.kind === "ok" ? state.value : atual.state,
      gates: gates?.kind === "ok" ? gates.value : atual.gates,
      decisions: decisions?.kind === "ok" ? decisions.value : atual.decisions,
    }));
  }, [accessToken, onUnauthorized, sections]);

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
    <section
      className="panel"
      aria-label={rotuloDaTela ?? "Motor de portfólio"}
    >
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

      {sections.length < 2 ? null : (
        <nav className="tabs" aria-label="Seções desta tela">
          {sections.map((key) => (
            <button
              key={key}
              type="button"
              className={section === key ? "tab tab--active" : "tab"}
              onClick={() => {
                setSection(key);
              }}
            >
              {ROTULO_DA_SECAO[key]}
            </button>
          ))}
        </nav>
      )}

      {failed ? (
        <p className="scope">
          Não foi possível carregar os dados do portfólio. O motor pode não
          estar ativo ainda.
        </p>
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
            — não há índice só nele — e empatava entre decisões do mesmo ciclo.
            A medição que motivou a troca está na RFC-015 §3, com data.
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
                <th scope="col">Ordem paper</th>
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
                  <td
                    className={
                      decision.question === null ? "sem-nome" : undefined
                    }
                    title={`${decision.condition_id ?? "sem condition_id"}${
                      decision.category === null
                        ? ""
                        : ` · ${rotulo(decision.category, CATEGORIA)}`
                    }`}
                  >
                    {decision.question ?? "sem nome"}
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
                  {/* Um aceite sem ordem é o caso que a D7 põe no bloco de
                      ação da Mesa; aqui ele fica explícito linha por linha.
                      Uma recusa não tem ordem por construção, e a célula fica
                      vazia em vez de dizer "sem ordem" e soar como defeito. */}
                  <td>
                    {decision.outcome === "ACCEPTED" ? (
                      decision.paper_order_id === null ? (
                        <span className="badge badge--atencao">sem ordem</span>
                      ) : (
                        String(decision.paper_order_id)
                      )
                    ) : (
                      ""
                    )}
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
