import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExperimentResults,
  ExperimentSystemView,
  type ExperimentReport,
  type ExperimentSystem,
} from "../src/Experiments.tsx";
const metric: ExperimentReport["baseline"] = {
  dataset_id: "btc-replay:" + "a".repeat(64),
  scope: {
    account_id: "baseline",
    window: {
      start: "2026-09-26T04:15:00.000Z",
      end: "2026-09-27T02:40:27.489Z",
    },
  },
  versions: {
    code_sha: "a".repeat(40),
    strategy: "baseline.v1",
    manifest_hash: "b".repeat(64),
    contracts: { ledger: "trading.v1" },
  },
  capital_usd_raw: "1000000000",
  transfers_usd_raw: "0",
  trading: {
    equity_usd_raw: "1000000000",
    net_pnl_usd_raw: "0",
    realized_net_usd_raw: "0",
    fees_usd_raw: "0",
    funding_usd_raw: "0",
    net_return_ppm: "0",
  },
  drawdown: { max_usd_raw: "0", max_ppm: "0" },
  equity_curve: {
    status: "ledger_observations_only",
    points: [{ at: "2026-09-26T04:15:00.000Z", equity_usd_raw: "1000000000" }],
  },
  operational_costs: {
    ai_usd_raw: null,
    infrastructure_usd_raw: null,
    captured_real_ai_usd_raw: "0",
    captured_unknown_ai_calls: 0,
  },
  after_operational_costs: { net_pnl_usd_raw: null },
  decisions: {
    count: 1,
    by_state: { data_unavailable: 1 },
    by_reason: { risk_pause: 1 },
    market_bar_clusters: ["2026-09-27T02:30:00.000Z"],
    filter_vetoes: { real: 0, mock: 0 },
  },
  turnover: { gross_notional_usd_raw: "0" },
  input_audit: "resolve_retained_inputs_to_verify_payload_hash_and_source_time",
  late_funding_event_ids: [],
};
const report: ExperimentReport = {
  status: "challenger_absent",
  baseline: metric,
  challenger: null,
  delta: null,
};
const system: ExperimentSystem = {
  as_of: "2026-09-27T03:30:14.000Z",
  capacity: {
    hold: true,
    raw_bytes: "2147899519",
    total_bytes: "3756529963",
    physical_bytes: "2051276800",
    raw_quota_bytes: "10737418240",
    total_quota_bytes: "12884901888",
  },
  worker_limits: {
    raw_bytes: "4294967296",
    total_bytes: "6442450944",
    physical_bytes: "4294967296",
  },
  feed: {
    status: "stale",
    last_capture_at: "2026-09-26T22:07:29.000Z",
    continuity: "unproven",
  },
  container_restarts: null,
  container_status: "unavailable",
  host_disk: null,
  recovery: [
    {
      account_id: "manual",
      generation: "2",
      status: "ready",
      reason: null,
      lease_alive: false,
      checkpoint_at: null,
    },
  ],
  next_cursor: null,
};
describe("experiment operator information", () => {
  it("distinguishes legitimate no-trade zero from unknown costs and inconclusive short window", () => {
    const html = renderToStaticMarkup(<ExperimentResults report={report} />);
    for (const text of [
      "Resultado inconclusivo",
      "Sem trades neste corte",
      "custo permanece desconhecido",
      "Auditoria dos inputs externos pendente",
      "Dados indisponíveis",
      "risk_pause",
      "Contribuição causal: inconclusiva",
      "não comprova maturidade de 7 ou 30 dias",
      "1 ponto(s)",
    ])
      expect(html).toContain(text);
    expect(html.match(/<circle/g)).toHaveLength(1);
    expect(html).not.toContain("<polyline");
  });
  it("never draws zero-valued substitutes for missing historical equity", () => {
    const m = {
      ...metric,
      equity_curve: {
        status: "missing_equity_history",
        points: [{ at: metric.scope.window.end, equity_usd_raw: null }],
      },
      drawdown: { max_usd_raw: null, max_ppm: null },
      trading: { ...metric.trading, equity_usd_raw: null },
    };
    const html = renderToStaticMarkup(
      <ExperimentResults report={{ ...report, baseline: m }} />,
    );
    expect(html).toContain("Curva indisponível");
    expect(html).not.toContain("<svg");
    expect(html).toContain("drawdown indisponível");
  });
  it("explains incompatible windows/version changes and never emits deltas for unvalidated comparisons", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        report={{
          ...report,
          status: "not_comparable",
          reason: "BTC_METRICS_COMPARISON_WINDOW_OR_CONTRACT",
          challenger: {
            ...metric,
            versions: { ...metric.versions, code_sha: "c".repeat(40) },
          },
        }}
      />,
    );
    expect(html).toContain("Selecione cortes compatíveis");
    expect(html).toContain("Versões diferentes: code_sha");
    expect(html).not.toContain("Desafiante menos base");
  });
  it("separates stopped/stale feed, unknown container restarts, expired lease and storage ceilings", () => {
    const html = renderToStaticMarkup(<ExperimentSystemView value={system} />);
    for (const text of [
      "Coleta desatualizada",
      "Estado do container e contagem de reinícios: não disponíveis",
      "lease expirado",
      "HOLD: ativo",
      "Disco livre do host: não disponível",
      "7/30 dias não avaliada",
    ])
      expect(html).toContain(text);
  });
});
