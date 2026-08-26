// RFC-013 dashboard tab. Read-only: nothing here places an order, and the two
// manual state controls (halt/resume) are deliberately absent from the UI as
// well as from the Nginx perimeter — leaving HALTED should take a deliberate
// operator action from inside, not a button on a page.
//
// The panel shows vetoed opportunities WITH their reason. Hiding them would let
// the page imply the universe is cleaner than it is; showing one without the
// reason is what the RFC forbids outright.

import { useCallback, useEffect, useRef, useState } from "react";

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

type Section =
  "oportunidades" | "exposicao" | "estado" | "gates" | "consulta" | "decisoes";

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

  const refresh = useCallback(async (): Promise<void> => {
    const [opportunities, exposures, state, gates, decisions] =
      await Promise.all([
        fetchOpportunities(accessToken),
        fetchExposures(accessToken),
        fetchPortfolioState(accessToken),
        fetchGates(accessToken),
        fetchDecisions(accessToken),
      ]);
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
    const result = await fetchGateMeasurements(accessToken, {
      ...(filters.gate === "" ? {} : { gate: filters.gate }),
      ...(filters.status === "" ? {} : { status: filters.status }),
      ...(filters.from === "" ? {} : { from: `${filters.from}T00:00:00Z` }),
      ...(filters.to === "" ? {} : { to: `${filters.to}T23:59:59Z` }),
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
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
          Estado do portfólio: <strong>{stateRow.state}</strong>
          {stateRow.reason === null ? "" : ` — ${stateRow.reason}`}. Banca{" "}
          {usd(stateRow.bankroll_usd)}, equity {usd(stateRow.equity_usd)},
          drawdown {pct(stateRow.drawdown)}.
        </p>
      )}

      <nav className="tabs" aria-label="Seções do portfólio">
        {(
          [
            ["oportunidades", "Oportunidades"],
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
        <table className="grid">
          <caption>
            Painel de oportunidade. Um mercado vetado aparece aqui com o motivo
            do veto — nunca escondido, e nunca como &quot;quase entrável&quot;.
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
              <th scope="col">Atualidade</th>
              <th scope="col">Situação</th>
            </tr>
          </thead>
          <tbody>
            {data.opportunities.map((opportunity) => (
              <tr key={opportunity.token_id}>
                <td>{opportunity.condition_id.slice(0, 12)}…</td>
                <td>{opportunity.panel.suggested_side ?? "—"}</td>
                <td>
                  {opportunity.panel.market_bid ?? "—"} /{" "}
                  {opportunity.panel.market_ask ?? "—"}
                </td>
                <td>
                  {opportunity.panel.q ?? "—"} [{opportunity.panel.q_lo ?? "—"},{" "}
                  {opportunity.panel.q_hi ?? "—"}]
                </td>
                <td>{opportunity.panel.edge_net ?? "—"}</td>
                <td>{opportunity.panel.max_size_shares ?? "—"}</td>
                <td>{opportunity.panel.binding_constraint ?? "—"}</td>
                <td>{opportunity.panel.resolution_action ?? "—"}</td>
                <td>{age(opportunity.panel.book_age_ms)}</td>
                <td>
                  {opportunity.vetoed
                    ? `VETADO: ${opportunity.veto_reason ?? "sem motivo"}`
                    : opportunity.entrable
                      ? "entrável"
                      : (opportunity.panel.entry_reason ?? "não entrável")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
                  <td>{transition.from_state ?? "—"}</td>
                  <td>{transition.to_state ?? "—"}</td>
                  <td>{transition.reason ?? "—"}</td>
                  <td>{transition.trigger_source ?? "—"}</td>
                  <td>{transition.at ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
            RFC-009: <strong>{data.gates?.rfc009Status ?? "BLOCKED"}</strong>.{" "}
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
                  <td>{gate.gate}</td>
                  <td>{gate.status ?? "—"}</td>
                  <td>{gate.reason_code ?? "—"}</td>
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
                  <td>{measurement.status ?? "—"}</td>
                  <td>{measurement.reason_code ?? "—"}</td>
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
        <table className="grid">
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
            {data.decisions.map((decision) => (
              <tr key={String(decision.decision_id ?? Math.random())}>
                <td>{decision.decision_id ?? "—"}</td>
                <td>{decision.decision_kind ?? "—"}</td>
                <td>{(decision.condition_id ?? "").slice(0, 12)}…</td>
                <td>{decision.market_side ?? "—"}</td>
                <td>{decision.edge_net ?? "—"}</td>
                <td>{decision.size_shares ?? "—"}</td>
                <td>{decision.binding_constraint ?? "—"}</td>
                <td>{decision.outcome ?? "—"}</td>
                <td>{decision.reason_code ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
