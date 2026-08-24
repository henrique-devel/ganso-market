import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchDivergences,
  fetchGraphViolations,
  fetchMarketDetail,
  fetchMeasurementReports,
  fetchPipeline,
  fetchResolutionRisk,
  fetchSanityVetoes,
  type BacktestReport,
  type DivergenceDirection,
  type DivergenceSets,
  type GraphViolation,
  type MarketDetail,
  type MeasurementReport,
  type PipelineSnapshot,
  type ResolutionAction,
  type ResolutionGetResult,
  type ResolutionMarket,
  type VetoSets,
  type ViolationSets,
} from "./resolution.js";

const REFRESH_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5_000;

const ACTION_ORDER: readonly ResolutionAction[] = [
  "VETO",
  "CIRCUIT_BREAKER",
  "BUFFER",
  "NONE",
];

// ---------------------------------------------------------------------------
// Container: polls the list endpoints, fetches detail lazily, reports 401s.

export function ResolutionPanel({
  accessToken,
  onUnauthorized,
}: Readonly<{
  accessToken: string;
  onUnauthorized: () => void;
}>) {
  const [markets, setMarkets] = useState<readonly ResolutionMarket[] | null>(
    null,
  );
  const [divergences, setDivergences] = useState<DivergenceSets | null>(null);
  const [violations, setViolations] = useState<ViolationSets | null>(null);
  const [vetoes, setVetoes] = useState<VetoSets | null>(null);
  const [pipeline, setPipeline] = useState<PipelineSnapshot | null>(null);
  const [report, setReport] = useState<MeasurementReport | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const mounted = useRef(true);
  const detailRequest = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const [risk, diverg, viol, veto, pipe, reports] = await Promise.all([
      fetchResolutionRisk(accessToken, fetch, controller.signal),
      fetchDivergences(accessToken, fetch, controller.signal),
      fetchGraphViolations(accessToken, fetch, controller.signal),
      fetchSanityVetoes(accessToken, fetch, controller.signal),
      fetchPipeline(accessToken, fetch, controller.signal),
      fetchMeasurementReports(accessToken, fetch, controller.signal),
    ]);
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    const flags = { unauthorized: false, failed: false };
    applyResult(risk, (value) => setMarkets(value.markets), flags);
    applyResult(diverg, setDivergences, flags);
    applyResult(viol, setViolations, flags);
    applyResult(veto, setVetoes, flags);
    applyResult(pipe, setPipeline, flags);
    applyResult(
      reports,
      (value) => setReport(latestReport(value.reports)),
      flags,
    );
    setDegraded(flags.failed);
    if (flags.unauthorized) {
      onUnauthorized();
    }
  }, [accessToken, onUnauthorized]);

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

  const handleSelect = useCallback(
    (conditionId: string | null): void => {
      const requestId = ++detailRequest.current;
      setSelected(conditionId);
      setDetail(null);
      setDetailLoading(conditionId !== null);
      if (conditionId === null) {
        return;
      }
      void (async () => {
        const controller = new AbortController();
        const timeout = window.setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
        );
        const result = await fetchMarketDetail(
          conditionId,
          accessToken,
          fetch,
          controller.signal,
        );
        window.clearTimeout(timeout);
        if (!mounted.current || detailRequest.current !== requestId) {
          return;
        }
        setDetailLoading(false);
        if (result.kind === "ok") {
          setDetail(result.value);
        } else if (result.kind === "unauthorized") {
          onUnauthorized();
        }
      })();
    },
    [accessToken, onUnauthorized],
  );

  return (
    <ResolutionView
      markets={markets}
      divergences={divergences}
      violations={violations}
      vetoes={vetoes}
      pipeline={pipeline}
      report={report}
      degraded={degraded}
      now={Date.now()}
      selected={selected}
      detail={detail}
      detailLoading={detailLoading}
      onSelectMarket={handleSelect}
    />
  );
}

function applyResult<T>(
  result: ResolutionGetResult<T>,
  apply: (value: T) => void,
  flags: { unauthorized: boolean; failed: boolean },
): void {
  if (result.kind === "ok") {
    apply(result.value);
  } else if (result.kind === "unauthorized") {
    flags.unauthorized = true;
  } else {
    flags.failed = true;
  }
}

function latestReport(
  reports: readonly MeasurementReport[],
): MeasurementReport | null {
  let latest: MeasurementReport | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const candidate of reports) {
    const time =
      candidate.generated_at === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(candidate.generated_at);
    const effective = Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
    if (latest === null || effective >= latestTime) {
      latest = candidate;
      latestTime = effective;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Pure presentational view (renderToStaticMarkup-testable, no effects).

export interface ResolutionViewProps {
  readonly markets: readonly ResolutionMarket[] | null;
  readonly divergences: DivergenceSets | null;
  readonly violations: ViolationSets | null;
  readonly vetoes: VetoSets | null;
  readonly pipeline: PipelineSnapshot | null;
  readonly report: MeasurementReport | null;
  readonly degraded: boolean;
  readonly now: number;
  readonly selected: string | null;
  readonly detail: MarketDetail | null;
  readonly detailLoading: boolean;
  readonly onSelectMarket: (conditionId: string | null) => void;
}

export function ResolutionView({
  markets,
  divergences,
  violations,
  vetoes,
  pipeline,
  report,
  degraded,
  now,
  selected,
  detail,
  detailLoading,
  onSelectMarket,
}: ResolutionViewProps) {
  const selectedMarket =
    selected === null
      ? null
      : (markets?.find((market) => market.condition_id === selected) ?? null);
  return (
    <div className="resolution">
      <p className="sim-banner">SIMULAÇÃO — SEM EXECUÇÃO REAL</p>
      {degraded ? (
        <p className="stale-note" role="status">
          Falha ao atualizar parte dos dados; exibindo a última leitura válida.
        </p>
      ) : null}
      <SummaryCards
        markets={markets}
        divergences={divergences}
        pipeline={pipeline}
      />
      <ScoreTable
        markets={markets}
        selected={selected}
        now={now}
        onSelectMarket={onSelectMarket}
      />
      {selected === null ? null : (
        <MarketDetailPanel
          market={selectedMarket}
          detail={detail}
          loading={detailLoading}
          now={now}
          onClose={() => {
            onSelectMarket(null);
          }}
        />
      )}
      <DisputesSection markets={markets} now={now} />
      <ViolationsSection violations={violations} now={now} />
      <VetoesSection vetoes={vetoes} markets={markets} now={now} />
      <DivergencesSection
        divergences={divergences}
        markets={markets}
        now={now}
      />
      <PipelineSection pipeline={pipeline} markets={markets} now={now} />
      <ReportSection report={report} now={now} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary cards.

function SummaryCards({
  markets,
  divergences,
  pipeline,
}: Readonly<{
  markets: readonly ResolutionMarket[] | null;
  divergences: DivergenceSets | null;
  pipeline: PipelineSnapshot | null;
}>) {
  const counts = actionCounts(markets);
  const disputes =
    markets === null
      ? null
      : markets.filter((market) => market.dispute_active).length;
  const activeDivergences =
    divergences?.active.length ?? pipeline?.divergences_active ?? null;
  const killSwitch = pipeline?.kill_switch ?? null;
  const killEngaged = killSwitch?.engaged === true;
  return (
    <section className="cards" aria-label="Resumo">
      <article className="card">
        <h3>Mercados com score</h3>
        <p className="card-value">{markets === null ? "…" : markets.length}</p>
      </article>
      <article className="card card--actions">
        <h3>Ações efetivas</h3>
        <p className="card-badges">
          {ACTION_ORDER.map((action) => (
            <span key={action} className="badge-count">
              <span className={actionClass(action)}>{actionLabel(action)}</span>
              <span>{counts === null ? "…" : counts[action]}</span>
            </span>
          ))}
        </p>
      </article>
      <article className="card">
        <h3>Disputas ativas</h3>
        <p className="card-value">{disputes ?? "…"}</p>
      </article>
      <article className="card">
        <h3>Divergências ativas</h3>
        <p className="card-value">{activeDivergences ?? "…"}</p>
      </article>
      <article className="card">
        <h3>Kill switch</h3>
        <p className="card-value">
          <span
            className={killEngaged ? "badge badge--veto" : "badge badge--none"}
          >
            {pipeline === null ? "…" : killEngaged ? "Engajado" : "Armado"}
          </span>
        </p>
        {killEngaged && killSwitch !== null ? (
          <p className="card-note" title={killSwitch.reason ?? undefined}>
            {killSwitch.reason ?? "Sem motivo registrado."}
          </p>
        ) : null}
      </article>
    </section>
  );
}

function actionCounts(
  markets: readonly ResolutionMarket[] | null,
): Record<ResolutionAction, number> | null {
  if (markets === null) {
    return null;
  }
  const counts: Record<ResolutionAction, number> = {
    NONE: 0,
    BUFFER: 0,
    VETO: 0,
    CIRCUIT_BREAKER: 0,
  };
  for (const market of markets) {
    const action = market.effective_action ?? market.action;
    if (action !== null) {
      counts[action] += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Score table.

function ScoreTable({
  markets,
  selected,
  now,
  onSelectMarket,
}: Readonly<{
  markets: readonly ResolutionMarket[] | null;
  selected: string | null;
  now: number;
  onSelectMarket: (conditionId: string | null) => void;
}>) {
  return (
    <section className="section">
      <h2>Scores de resolução</h2>
      <p className="section-note">
        Clique em um mercado para ver a decomposição do score, a timeline UMA e
        as clarificações de regra.
      </p>
      {markets === null ? (
        <p className="empty">Carregando…</p>
      ) : markets.length === 0 ? (
        <p className="empty">Nenhum mercado com score ainda.</p>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Mercado</th>
                <th>Categoria</th>
                <th>R</th>
                <th>Ação efetiva</th>
                <th>Prior</th>
                <th>Flags duras</th>
                <th>Calculado</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((market) => (
                <tr
                  key={market.condition_id}
                  className={
                    selected === market.condition_id
                      ? "row-click row-selected"
                      : "row-click"
                  }
                  onClick={() => {
                    onSelectMarket(
                      selected === market.condition_id
                        ? null
                        : market.condition_id,
                    );
                  }}
                >
                  <td title={market.question}>
                    {truncate(market.question, 70)}
                    {market.suspect_jump ? (
                      <span
                        className="badge badge--buffer badge-inline"
                        title="Salto de preço suspeito detectado"
                      >
                        salto
                      </span>
                    ) : null}
                  </td>
                  <td>{market.category ?? "—"}</td>
                  <td>
                    <ScoreBar score={market.score} />
                  </td>
                  <td>
                    <EffectiveActionBadge market={market} />
                  </td>
                  <td>{priorLabel(market.prior_kind)}</td>
                  <td title={market.hard_flags.join(", ")}>
                    {flagsSummary(market.hard_flags)}
                  </td>
                  <td>{relativeTime(market.computed_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ScoreBar({ score }: Readonly<{ score: number | null }>) {
  if (score === null) {
    return <span className="muted">—</span>;
  }
  const pct = Math.max(0, Math.min(1, score)) * 100;
  return (
    <span className="score-cell">
      <span className="score-num">{fmtBr(score, 3)}</span>
      <span className="bar" aria-hidden="true">
        <span className="bar-fill" style={{ width: `${pct.toFixed(1)}%` }} />
      </span>
    </span>
  );
}

function EffectiveActionBadge({
  market,
}: Readonly<{ market: ResolutionMarket }>) {
  const effective = market.effective_action ?? market.action;
  const differs =
    market.effective_action !== null &&
    market.action !== null &&
    market.effective_action !== market.action;
  return (
    <span
      className={actionClass(effective)}
      title={
        differs ? `Ação própria: ${actionLabel(market.action)}` : undefined
      }
    >
      {actionLabel(effective)}
      {differs ? " (grupo)" : ""}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Market detail.

function MarketDetailPanel({
  market,
  detail,
  loading,
  now,
  onClose,
}: Readonly<{
  market: ResolutionMarket | null;
  detail: MarketDetail | null;
  loading: boolean;
  now: number;
  onClose: () => void;
}>) {
  return (
    <section className="section detail-card">
      <header className="detail-head">
        <h2>Detalhe do mercado</h2>
        <button type="button" className="detail-close" onClick={onClose}>
          Fechar
        </button>
      </header>
      {market === null ? null : (
        <p className="detail-question" title={market.question}>
          {market.question}
        </p>
      )}
      {loading ? (
        <p className="empty">Carregando detalhe…</p>
      ) : detail === null ? (
        <p className="empty">
          Não foi possível carregar o detalhe deste mercado.
        </p>
      ) : (
        <DetailBody market={market} detail={detail} now={now} />
      )}
    </section>
  );
}

function DetailBody({
  market,
  detail,
  now,
}: Readonly<{
  market: ResolutionMarket | null;
  detail: MarketDetail;
  now: number;
}>) {
  const justification = detail.justification ?? market?.justification ?? null;
  const flags =
    detail.hard_flags.length > 0
      ? detail.hard_flags
      : (market?.hard_flags ?? []);
  return (
    <>
      <dl className="detail-stats">
        <div>
          <dt>Buffer de resolução</dt>
          <dd>{fmtOrDash(market?.resolution_buffer ?? null, 4)}</dd>
        </div>
        <div>
          <dt>P(50/50)</dt>
          <dd>{pctBr(market?.p_5050 ?? null, 1)}</dd>
        </div>
        <div>
          <dt>Lockup esperado</dt>
          <dd>{formatDuration(market?.expected_lockup_s ?? null)}</dd>
        </div>
        <div>
          <dt>Lockup P95</dt>
          <dd>{formatDuration(market?.p95_lockup_s ?? null)}</dd>
        </div>
        <div>
          <dt>Prior em uso</dt>
          <dd>{priorLabel(detail.prior_kind ?? market?.prior_kind ?? null)}</dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>{detail.state ?? "—"}</dd>
        </div>
        <div>
          <dt>Score calculado</dt>
          <dd>{relativeTime(detail.computed_at, now)}</dd>
        </div>
      </dl>
      {flags.length > 0 ? (
        <p className="detail-flags">
          {flags.map((flag) => (
            <span key={flag} className="badge badge--breaker badge-inline">
              {flag}
            </span>
          ))}
        </p>
      ) : null}
      {justification === null ? null : (
        <p className="justification">{justification}</p>
      )}
      <h3>Decomposição do score</h3>
      <FeatureTable detail={detail} />
      <h3>Timeline UMA</h3>
      <UmaTimeline detail={detail} now={now} />
      <h3>Clarificações de regra</h3>
      <Clarifications detail={detail} now={now} />
    </>
  );
}

function FeatureTable({ detail }: Readonly<{ detail: MarketDetail }>) {
  if (detail.features.length === 0) {
    return <p className="empty">Nenhuma feature registrada para este score.</p>;
  }
  const features = [...detail.features].sort(
    (a, b) => Math.abs(b.contribution ?? 0) - Math.abs(a.contribution ?? 0),
  );
  const maxContribution = features.reduce(
    (max, feature) => Math.max(max, Math.abs(feature.contribution ?? 0)),
    0,
  );
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Feature</th>
            <th>Valor</th>
            <th>Peso</th>
            <th>Contribuição</th>
          </tr>
        </thead>
        <tbody>
          {features.map((feature) => {
            const contribution = feature.contribution ?? 0;
            const width =
              maxContribution === 0
                ? 0
                : (Math.abs(contribution) / maxContribution) * 100;
            return (
              <tr key={feature.name}>
                <td title={feature.note ?? undefined}>{feature.name}</td>
                <td>{fmtOrDash(feature.value, 3)}</td>
                <td>{fmtOrDash(feature.weight, 2)}</td>
                <td>
                  <span className="score-cell">
                    <span className="score-num">
                      {fmtOrDash(feature.contribution, 3)}
                    </span>
                    <span className="bar" aria-hidden="true">
                      <span
                        className={
                          contribution < 0
                            ? "bar-fill bar-fill--neg"
                            : "bar-fill"
                        }
                        style={{ width: `${width.toFixed(1)}%` }}
                      />
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UmaTimeline({
  detail,
  now,
}: Readonly<{ detail: MarketDetail; now: number }>) {
  if (detail.uma_timeline.length === 0) {
    return <p className="empty">Nenhum evento UMA registrado.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Request</th>
            <th>Estado</th>
            <th>Resultado</th>
            <th>Payouts</th>
            <th>Bond</th>
            <th>Fonte</th>
            <th>Quando</th>
          </tr>
        </thead>
        <tbody>
          {detail.uma_timeline.map((entry, index) => (
            <tr key={`${entry.request_index ?? "x"}-${index}`}>
              <td>{entry.request_index ?? "—"}</td>
              <td>{entry.state ?? "—"}</td>
              <td>{entry.result ?? "—"}</td>
              <td title={entry.payouts ?? undefined}>
                {entry.payouts === null ? "—" : truncate(entry.payouts, 24)}
              </td>
              <td>{fmtOrDash(entry.bond, 0)}</td>
              <td>{entry.source ?? "—"}</td>
              <td>{relativeTime(entry.occurred_at, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Clarifications({
  detail,
  now,
}: Readonly<{ detail: MarketDetail; now: number }>) {
  if (detail.clarifications.length === 0) {
    return <p className="empty">Nenhuma clarificação de regra registrada.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Versão</th>
            <th>Classificação</th>
            <th>Campos alterados</th>
            <th>Vigente desde</th>
          </tr>
        </thead>
        <tbody>
          {detail.clarifications.map((clarification, index) => (
            <tr key={`${clarification.rule_version ?? "v"}-${index}`}>
              <td>{clarification.rule_version ?? "—"}</td>
              <td>{classificationLabel(clarification.classification)}</td>
              <td>
                {clarification.changed_fields.length === 0
                  ? "—"
                  : clarification.changed_fields.join(", ")}
              </td>
              <td>{relativeTime(clarification.valid_from, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active disputes.

function DisputesSection({
  markets,
  now,
}: Readonly<{ markets: readonly ResolutionMarket[] | null; now: number }>) {
  const disputed = markets?.filter((market) => market.dispute_active) ?? null;
  return (
    <section className="section">
      <h2>Disputas ativas</h2>
      {disputed === null ? (
        <p className="empty">Carregando…</p>
      ) : disputed.length === 0 ? (
        <p className="empty">Nenhuma disputa ativa no momento.</p>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Mercado</th>
                <th>Categoria</th>
                <th>Ação efetiva</th>
                <th>Score atualizado</th>
              </tr>
            </thead>
            <tbody>
              {disputed.map((market) => (
                <tr key={market.condition_id}>
                  <td title={market.question}>
                    {truncate(market.question, 70)}
                  </td>
                  <td>{market.category ?? "—"}</td>
                  <td>
                    <EffectiveActionBadge market={market} />
                  </td>
                  <td>{relativeTime(market.computed_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Graph violations.

function ViolationsSection({
  violations,
  now,
}: Readonly<{ violations: ViolationSets | null; now: number }>) {
  return (
    <section className="section">
      <h2>Violações do grafo</h2>
      <h3>Ativas</h3>
      {violations === null ? (
        <p className="empty">Carregando…</p>
      ) : violations.active.length === 0 ? (
        <p className="empty">
          Nenhuma violação ativa — o grafo está coerente com os custos.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Aresta</th>
                <th>Magnitude líquida</th>
                <th>bps</th>
                <th>Tam. executável</th>
                <th>Notional</th>
                <th>Desde</th>
                <th>Suprimida</th>
              </tr>
            </thead>
            <tbody>
              {violations.active.map((violation, index) => (
                <ActiveViolationRow
                  key={`${violation.edge_key}-${index}`}
                  violation={violation}
                  now={now}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Recentes (encerradas)</h3>
      {violations === null ? (
        <p className="empty">Carregando…</p>
      ) : violations.recent.length === 0 ? (
        <p className="empty">Nenhuma violação recente.</p>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Aresta</th>
                <th>Magnitude líquida</th>
                <th>bps</th>
                <th>Encerrada</th>
                <th>Meia-vida</th>
              </tr>
            </thead>
            <tbody>
              {violations.recent.map((violation, index) => (
                <tr key={`${violation.edge_key}-${index}`}>
                  <td>{violation.kind ?? "—"}</td>
                  <td title={violation.edge_key}>
                    {shortId(violation.edge_key)}
                  </td>
                  <td>{fmtOrDash(violation.magnitude_net, 4)}</td>
                  <td>{fmtOrDash(violation.magnitude_bps, 1)}</td>
                  <td>{relativeTime(violation.ended_at, now)}</td>
                  <td>{formatDuration(violation.half_life_s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ActiveViolationRow({
  violation,
  now,
}: Readonly<{ violation: GraphViolation; now: number }>) {
  return (
    <tr>
      <td>{violation.kind ?? "—"}</td>
      <td title={violation.edge_key}>{shortId(violation.edge_key)}</td>
      <td>{fmtOrDash(violation.magnitude_net, 4)}</td>
      <td>{fmtOrDash(violation.magnitude_bps, 1)}</td>
      <td>{fmtOrDash(violation.executable_size, 2)}</td>
      <td>{usdOrDash(violation.executable_notional_usd)}</td>
      <td>{relativeTime(violation.started_at, now)}</td>
      <td>{violation.suppressed ? "Sim" : "Não"}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Sanity vetoes.

function VetoesSection({
  vetoes,
  markets,
  now,
}: Readonly<{
  vetoes: VetoSets | null;
  markets: readonly ResolutionMarket[] | null;
  now: number;
}>) {
  return (
    <section className="section">
      <h2>Vetos de sanidade</h2>
      {vetoes === null ? (
        <p className="empty">Carregando…</p>
      ) : vetoes.active.length === 0 ? (
        <p className="empty">Nenhum veto de sanidade ativo.</p>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Mercado</th>
                <th>q do modelo</th>
                <th>Preço do vizinho</th>
                <th>Tipo de aresta</th>
                <th>Magnitude</th>
                <th>Status</th>
                <th>Desde</th>
              </tr>
            </thead>
            <tbody>
              {vetoes.active.map((veto, index) => (
                <tr key={`${veto.condition_id}-${index}`}>
                  <td>{marketLabel(markets, veto.condition_id)}</td>
                  <td>{fmtOrDash(veto.q, 3)}</td>
                  <td>{fmtOrDash(veto.neighbor_price, 3)}</td>
                  <td>{veto.kind ?? "—"}</td>
                  <td>{fmtOrDash(veto.magnitude, 4)}</td>
                  <td>{estimateStatusLabel(veto.estimate_status)}</td>
                  <td>{relativeTime(veto.started_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Layer divergences.

function DivergencesSection({
  divergences,
  markets,
  now,
}: Readonly<{
  divergences: DivergenceSets | null;
  markets: readonly ResolutionMarket[] | null;
  now: number;
}>) {
  return (
    <section className="section">
      <h2>Divergências entre camadas</h2>
      <p className="section-note">
        Divergência entre RFC-011 e RFC-012 é informação para calibração, não um
        erro: as duas camadas decidem com regras diferentes.
      </p>
      {divergences === null ? (
        <p className="empty">Carregando…</p>
      ) : divergences.active.length === 0 ? (
        <p className="empty">Nenhuma divergência ativa entre as camadas.</p>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Mercado</th>
                <th>Direção</th>
                <th>Ação RFC-012</th>
                <th>RFC-011 congelou</th>
                <th>Posição em carteira</th>
                <th>Desde</th>
              </tr>
            </thead>
            <tbody>
              {divergences.active.map((divergence, index) => (
                <tr key={`${divergence.condition_id}-${index}`}>
                  <td>{marketLabel(markets, divergence.condition_id)}</td>
                  <td>{directionLabel(divergence.direction)}</td>
                  <td>
                    <span className={actionClass(divergence.rfc012_action)}>
                      {actionLabel(divergence.rfc012_action)}
                    </span>
                  </td>
                  <td>{divergence.rfc011_frozen ? "Sim" : "Não"}</td>
                  <td>{divergence.position_held ? "Sim" : "Não"}</td>
                  <td>{relativeTime(divergence.started_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {divergences !== null && divergences.recent.length > 0 ? (
        <p className="section-note">
          {divergences.recent.length === 1
            ? "1 divergência recente encerrada."
            : `${divergences.recent.length} divergências recentes encerradas.`}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Paper pipeline.

function PipelineSection({
  pipeline,
  markets,
  now,
}: Readonly<{
  pipeline: PipelineSnapshot | null;
  markets: readonly ResolutionMarket[] | null;
  now: number;
}>) {
  return (
    <section className="section">
      <h2>Pipeline paper</h2>
      {pipeline === null ? (
        <p className="empty">Carregando…</p>
      ) : (
        <>
          <p className="section-note">
            Verificado {relativeTime(pipeline.checked_at, now)}.
          </p>
          <KillSwitchLine pipeline={pipeline} now={now} />
          <h3>Ordens abertas</h3>
          {pipeline.open_orders.length === 0 ? (
            <p className="empty">Nenhuma ordem aberta.</p>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Ordem</th>
                    <th>Lado</th>
                    <th>Tipo</th>
                    <th>Preço</th>
                    <th>Tamanho</th>
                    <th>Executado</th>
                    <th>Status</th>
                    <th>Fonte</th>
                    <th>Criada</th>
                  </tr>
                </thead>
                <tbody>
                  {pipeline.open_orders.map((order) => (
                    <tr key={order.order_id}>
                      <td title={order.order_id}>{shortId(order.order_id)}</td>
                      <td>{sideLabel(order.side)}</td>
                      <td>{order.order_type ?? "—"}</td>
                      <td>{fmtOrDash(order.limit_price, 3)}</td>
                      <td>{fmtOrDash(order.size, 2)}</td>
                      <td>{fmtOrDash(order.filled_size, 2)}</td>
                      <td>{order.status ?? "—"}</td>
                      <td>{order.source ?? "—"}</td>
                      <td>{relativeTime(order.created_at, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Posições</h3>
          {pipeline.positions.length === 0 ? (
            <p className="empty">Nenhuma posição em carteira.</p>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Mercado</th>
                    <th>Shares</th>
                    <th>Custo</th>
                    <th>Valor de mercado</th>
                    <th>PnL não realizado</th>
                    <th>PnL realizado</th>
                    <th>Atualizada</th>
                  </tr>
                </thead>
                <tbody>
                  {pipeline.positions.map((position) => (
                    <tr key={position.token_id}>
                      <td title={position.token_id}>
                        {marketLabel(markets, position.condition_id)}
                      </td>
                      <td>{fmtOrDash(position.shares, 2)}</td>
                      <td>{usdOrDash(position.cost_usd)}</td>
                      <td>
                        {usdOrDash(position.mark_value_usd)}
                        {position.mark_stale ? (
                          <span className="muted"> (mark obsoleto)</span>
                        ) : null}
                      </td>
                      <td>
                        {position.mark_value_usd === null ||
                        position.cost_usd === null
                          ? "—"
                          : usdOrDash(
                              position.mark_value_usd - position.cost_usd,
                            )}
                      </td>
                      <td>{usdOrDash(position.realized_pnl_usd)}</td>
                      <td>{relativeTime(position.updated_at, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function KillSwitchLine({
  pipeline,
  now,
}: Readonly<{ pipeline: PipelineSnapshot; now: number }>) {
  const killSwitch = pipeline.kill_switch;
  if (killSwitch === null || !killSwitch.engaged) {
    return (
      <p className="section-note">
        Kill switch <strong>armado</strong> — nenhum evento de engajamento
        ativo.
        {killSwitch !== null && killSwitch.rearmed_at !== null
          ? ` Rearmado ${relativeTime(killSwitch.rearmed_at, now)}.`
          : ""}
      </p>
    );
  }
  return (
    <>
      <p className="kill-switch-alert" role="alert">
        Kill switch <strong>ENGAJADO</strong>{" "}
        {relativeTime(killSwitch.engaged_at, now)} — motivo:{" "}
        {killSwitch.reason ?? "não registrado"}.
      </p>
      {killSwitch.frozen_markets.length > 0 ? (
        <p
          className="section-note"
          title={killSwitch.frozen_markets.join(", ")}
        >
          Mercados congelados: {killSwitch.frozen_markets.length} (
          {killSwitch.frozen_markets
            .slice(0, 3)
            .map((id) => shortId(id))
            .join(", ")}
          {killSwitch.frozen_markets.length > 3 ? ", …" : ""})
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Measurement report.

function ReportSection({
  report,
  now,
}: Readonly<{ report: MeasurementReport | null; now: number }>) {
  return (
    <section className="section">
      <h2>Relatório de medição</h2>
      {report === null ? (
        <p className="empty">Nenhum relatório de medição gerado ainda.</p>
      ) : (
        <>
          <p className="section-note">
            Gerado {relativeTime(report.generated_at, now)}
            {report.score_version === null
              ? ""
              : ` — score ${report.score_version}`}
            .
          </p>
          <h3>Por categoria</h3>
          {report.categories.length === 0 ? (
            <p className="empty">Nenhuma categoria medida ainda.</p>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Categoria</th>
                    <th>Resolvidos</th>
                    <th>Disputados</th>
                    <th>Taxa de disputa</th>
                    <th>Prior em uso</th>
                    <th>Lockup mediano</th>
                    <th>Lockup P95</th>
                  </tr>
                </thead>
                <tbody>
                  {report.categories.map((category) => (
                    <tr key={category.category}>
                      <td>{category.category}</td>
                      <td>{category.resolved ?? "—"}</td>
                      <td>{category.disputed ?? "—"}</td>
                      <td>
                        {pctWithCi(
                          category.dispute_rate,
                          category.dispute_rate_ci,
                        )}
                      </td>
                      <td>{priorLabel(category.prior_in_use)}</td>
                      <td>{formatDuration(category.lockup_median_s)}</td>
                      <td>{formatDuration(category.lockup_p95_s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Backtest do veto</h3>
          <BacktestSummary backtest={report.backtest} />
        </>
      )}
    </section>
  );
}

function BacktestSummary({
  backtest,
}: Readonly<{ backtest: BacktestReport | null }>) {
  if (backtest === null) {
    return <p className="empty">Nenhum backtest disponível neste relatório.</p>;
  }
  const smallSample =
    (backtest.disputed !== null && backtest.disputed < 30) ||
    (backtest.n_resolved !== null && backtest.n_resolved < 30);
  return (
    <>
      <p className="section-note">
        Backtest sobre {backtest.n_resolved ?? "—"} mercados resolvidos (
        {backtest.n_scored ?? "—"} com score,{" "}
        {backtest.n_skipped_no_proposal ?? "—"} sem proposta).
      </p>
      <dl className="detail-stats">
        <div>
          <dt>Cobertura do veto</dt>
          <dd>
            {pctWithCi(backtest.coverage, backtest.coverage_ci)}
            <span className="muted">
              {" "}
              — {backtest.vetoed_disputed ?? "—"} de {backtest.disputed ?? "—"}{" "}
              disputas vetadas
            </span>
          </dd>
        </div>
        <div>
          <dt>Falso-positivo</dt>
          <dd>
            {pctWithCi(
              backtest.false_positive_rate,
              backtest.false_positive_ci,
            )}
            <span className="muted">
              {" "}
              — {backtest.vetoed_clean ?? "—"} de {backtest.clean ?? "—"}{" "}
              mercados limpos vetados
            </span>
          </dd>
        </div>
      </dl>
      {smallSample ? (
        <p className="stale-note">
          Amostra pequena (n &lt; 30): os intervalos são largos — leia como
          indicativo, não como conclusão.
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure).

function actionLabel(action: ResolutionAction | null): string {
  return action ?? "—";
}

function actionClass(action: ResolutionAction | null): string {
  switch (action) {
    case "VETO":
      return "badge badge--veto";
    case "CIRCUIT_BREAKER":
      return "badge badge--breaker";
    case "BUFFER":
      return "badge badge--buffer";
    case "NONE":
      return "badge badge--none";
    default:
      return "badge badge--unknown";
  }
}

function directionLabel(direction: DivergenceDirection | null): string {
  switch (direction) {
    case "rfc012_only":
      return "só RFC-012";
    case "rfc011_only":
      return "só RFC-011";
    default:
      return "—";
  }
}

function priorLabel(priorKind: string | null): string {
  switch (priorKind) {
    case "external":
      return "externo";
    case "measured":
      return "medido";
    case null:
      return "—";
    default:
      return priorKind;
  }
}

function classificationLabel(classification: string | null): string {
  switch (classification) {
    case "material":
      return "material";
    case "cosmetic":
      return "cosmética";
    case null:
      return "—";
    default:
      return classification;
  }
}

function estimateStatusLabel(status: string | null): string {
  switch (status) {
    case "shadow":
      return "shadow";
    case "active":
      return "ativo";
    case null:
      return "—";
    default:
      return status;
  }
}

function sideLabel(side: string | null): string {
  switch (side) {
    case "BUY":
      return "Compra";
    case "SELL":
      return "Venda";
    case null:
      return "—";
    default:
      return side;
  }
}

function marketLabel(
  markets: readonly ResolutionMarket[] | null,
  conditionId: string | null,
): string {
  if (conditionId === null) {
    return "—";
  }
  const market = markets?.find(
    (candidate) => candidate.condition_id === conditionId,
  );
  if (market !== undefined && market.question !== "") {
    return truncate(market.question, 44);
  }
  return shortId(conditionId);
}

function flagsSummary(flags: readonly string[]): string {
  if (flags.length === 0) {
    return "—";
  }
  if (flags.length <= 2) {
    return flags.join(", ");
  }
  return `${flags.slice(0, 2).join(", ")} +${flags.length - 2}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 10)}…`;
}

function fmtBr(value: number, decimals: number): string {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function fmtOrDash(value: number | null, decimals: number): string {
  return value === null ? "—" : fmtBr(value, decimals);
}

function usdOrDash(value: number | null): string {
  return value === null ? "—" : `US$ ${fmtBr(value, 2)}`;
}

function pctBr(value: number | null, decimals: number): string {
  return value === null ? "—" : `${fmtBr(value * 100, decimals)}%`;
}

function pctWithCi(
  value: number | null,
  ci: { readonly low: number; readonly high: number } | null,
): string {
  const base = pctBr(value, 1);
  if (ci === null) {
    return base;
  }
  return `${base} [${pctBr(ci.low, 1)}–${pctBr(ci.high, 1)}]`;
}

function relativeTime(iso: string | null, now: number): string {
  if (iso === null) {
    return "—";
  }
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return "—";
  }
  const diff = now - timestamp;
  if (diff < 45_000) {
    return "agora";
  }
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) {
    return `há ${minutes} min`;
  }
  const hours = Math.round(diff / 3_600_000);
  if (hours < 36) {
    return `há ${hours} h`;
  }
  return `há ${Math.round(diff / 86_400_000)} d`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "—";
  }
  if (seconds < 90) {
    return `${Math.round(seconds)} s`;
  }
  if (seconds < 5_400) {
    return `${Math.round(seconds / 60)} min`;
  }
  if (seconds < 129_600) {
    return `${fmtBr(seconds / 3_600, 1)} h`;
  }
  return `${fmtBr(seconds / 86_400, 1)} d`;
}
