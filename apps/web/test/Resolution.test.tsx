import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResolutionView } from "../src/Resolution.tsx";
import type {
  MarketDetail,
  MeasurementReport,
  PipelineSnapshot,
  ResolutionMarket,
} from "../src/resolution.js";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");

const vetoedMarket: ResolutionMarket = {
  condition_id: "0xcond1",
  question:
    "O mercado de teste sobre resolução vai disputar antes do prazo final?",
  category: "politics",
  neg_risk: false,
  score: 0.87,
  score_version: "v3",
  action: "BUFFER",
  effective_action: "VETO",
  resolution_buffer: 0.02,
  p_5050: 0.31,
  expected_lockup_s: 7200,
  p95_lockup_s: 172800,
  dispute_active: true,
  suspect_jump: false,
  hard_flags: ["EARLY_EXPIRATION"],
  event_ids: ["evt-1"],
  group_worst_score: 0.91,
  justification: "Score alto por disputa ativa e prior medido.",
  prior_kind: "measured",
  computed_at: "2026-08-24T11:57:00.000Z",
};

const pipelineFixture: PipelineSnapshot = {
  kill_switch: {
    engaged: true,
    reason: "DIVERGENCE_SPIKE",
    engaged_at: "2026-08-24T09:00:00.000Z",
    rearmed_at: null,
    frozen_markets: ["0xcond1"],
  },
  open_orders: [
    {
      order_id: "ord-1",
      token_id: "tok-1",
      condition_id: "0xcond1",
      side: "BUY",
      order_type: "GTC",
      limit_price: 0.41,
      size: 100,
      filled_size: 25,
      status: "open",
      source: "rfc012",
      created_at: "2026-08-24T11:00:00.000Z",
    },
  ],
  positions: [
    {
      token_id: "tok-1",
      condition_id: "0xcond1",
      shares: 100,
      cost_usd: 41,
      realized_pnl_usd: 0,
      mark_value_usd: 45.5,
      mark_stale: false,
      updated_at: "2026-08-24T11:58:00.000Z",
    },
  ],
  divergences_active: 1,
  checked_at: "2026-08-24T11:59:30.000Z",
};

const reportFixture: MeasurementReport = {
  report_id: "rep-1",
  generated_at: "2026-08-23T00:00:00.000Z",
  categories: [
    {
      category: "politics",
      resolved: 120,
      disputed: 2,
      dispute_rate: 0.006,
      dispute_rate_ci: { low: 0.001, high: 0.021 },
      p5050: 0.01,
      prior_in_use: "measured",
      results: { YES: 70, NO: 50 },
      lockup_median_s: 7200,
      lockup_p95_s: 172800,
    },
  ],
  backtest: {
    n_resolved: 25,
    n_scored: 24,
    n_skipped_no_proposal: 1,
    disputed: 4,
    vetoed_disputed: 3,
    coverage: 0.75,
    coverage_ci: { low: 0.194, high: 0.994 },
    clean: 21,
    vetoed_clean: 1,
    false_positive_rate: 0.048,
    false_positive_ci: { low: 0.001, high: 0.238 },
  },
  score_version: "v3",
};

const detailFixture: MarketDetail = {
  state: "SCORED",
  features: [
    {
      name: "dispute_rate",
      value: 0.02,
      weight: 0.4,
      contribution: 0.008,
      note: "prior medido",
    },
    {
      name: "clarification_recency",
      value: 1,
      weight: 0.2,
      contribution: -0.05,
      note: null,
    },
  ],
  hard_flags: ["EARLY_EXPIRATION"],
  justification: "Score alto por disputa ativa e prior medido.",
  prior_kind: "measured",
  computed_at: "2026-08-24T11:57:00.000Z",
  uma_timeline: [
    {
      request_index: 0,
      state: "Disputed",
      result: null,
      payouts: null,
      bond: 750,
      source: "chain",
      occurred_at: "2026-08-24T08:00:00.000Z",
    },
  ],
  clarifications: [
    {
      rule_version: "2",
      classification: "material",
      changed_fields: ["description"],
      valid_from: "2026-08-20T00:00:00.000Z",
    },
  ],
};

function renderView(
  overrides: Partial<Parameters<typeof ResolutionView>[0]>,
): string {
  return renderToStaticMarkup(
    <ResolutionView
      markets={null}
      divergences={null}
      violations={null}
      vetoes={null}
      pipeline={null}
      report={null}
      degraded={false}
      now={NOW}
      selected={null}
      detail={null}
      detailLoading={false}
      onSelectMarket={() => undefined}
      {...overrides}
    />,
  );
}

describe("ResolutionView", () => {
  it("renders markets, violations, divergences, kill switch and the banner", () => {
    const html = renderView({
      markets: [vetoedMarket],
      divergences: {
        active: [
          {
            condition_id: "0xcond1",
            direction: "rfc012_only",
            rfc012_action: "VETO",
            rfc011_frozen: false,
            position_held: true,
            started_at: "2026-08-24T10:00:00.000Z",
            last_seen_at: "2026-08-24T11:59:00.000Z",
            ended_at: null,
          },
        ],
        recent: [],
      },
      violations: {
        active: [
          {
            edge_key: "edge-abcdef0123456789",
            kind: "complement",
            started_at: "2026-08-24T11:30:00.000Z",
            last_seen_at: "2026-08-24T11:59:00.000Z",
            ended_at: null,
            snapshots_count: 12,
            magnitude_net: 0.0125,
            magnitude_bps: 42,
            executable_size: 350,
            executable_notional_usd: 180.75,
            tolerance: 0.004,
            suppressed: false,
            signal_emitted: true,
            half_life_s: null,
          },
        ],
        recent: [],
      },
      vetoes: {
        active: [
          {
            condition_id: "0xcond1",
            token_id: "tok-1",
            model_id: "m1",
            estimate_status: "shadow",
            q: 0.42,
            edge_key: "edge-abcdef0123456789",
            kind: "complement",
            neighbor_price: 0.55,
            tolerance: 0.05,
            magnitude: 0.13,
            started_at: "2026-08-24T11:45:00.000Z",
            ended_at: null,
          },
        ],
        recent: [],
      },
      pipeline: pipelineFixture,
      report: reportFixture,
    });

    expect(html).toContain("SIMULAÇÃO — SEM EXECUÇÃO REAL");
    expect(html).toContain("VETO");
    expect(html).toContain("(grupo)");
    expect(html).toContain(
      "O mercado de teste sobre resolução vai disputar antes do prazo final?",
    );
    expect(html).toContain("0,0125");
    expect(html).toContain("só RFC-012");
    expect(html).toContain("ENGAJADO");
    expect(html).toContain("DIVERGENCE_SPIKE");
    expect(html).toContain("há 3 min");
    expect(html).toContain("0,6% [0,1%–2,1%]");
    expect(html).toContain("Amostra pequena (n &lt; 30)");
    expect(html).toContain("EARLY_EXPIRATION");
  });

  it("renders explicit empty states when everything is quiet", () => {
    const html = renderView({
      markets: [],
      divergences: { active: [], recent: [] },
      violations: { active: [], recent: [] },
      vetoes: { active: [], recent: [] },
      pipeline: {
        kill_switch: null,
        open_orders: [],
        positions: [],
        divergences_active: 0,
        checked_at: "2026-08-24T11:59:30.000Z",
      },
      report: null,
    });

    expect(html).toContain("SIMULAÇÃO — SEM EXECUÇÃO REAL");
    expect(html).toContain("Nenhum mercado com score ainda.");
    expect(html).toContain(
      "Nenhuma violação ativa — o grafo está coerente com os custos.",
    );
    expect(html).toContain("Nenhum veto de sanidade ativo.");
    expect(html).toContain("Nenhuma divergência ativa entre as camadas.");
    expect(html).toContain("Nenhuma disputa ativa no momento.");
    expect(html).toContain("Nenhuma ordem aberta.");
    expect(html).toContain("Nenhuma posição em carteira.");
    expect(html).toContain("Nenhum relatório de medição gerado ainda.");
    expect(html).toContain("armado");
  });

  it("renders the lazy market detail with feature decomposition", () => {
    const html = renderView({
      markets: [vetoedMarket],
      selected: "0xcond1",
      detail: detailFixture,
    });

    expect(html).toContain("Detalhe do mercado");
    expect(html).toContain("dispute_rate");
    expect(html).toContain("clarification_recency");
    expect(html).toContain("Score alto por disputa ativa e prior medido.");
    expect(html).toContain("Disputed");
    expect(html).toContain("material");
    expect(html).toContain("bar-fill--neg");
    expect(html).toContain("medido");
  });

  it("shows a degraded-data note and a loading detail state", () => {
    const html = renderView({
      degraded: true,
      selected: "0xmissing",
      detailLoading: true,
    });

    expect(html).toContain(
      "Falha ao atualizar parte dos dados; exibindo a última leitura válida.",
    );
    expect(html).toContain("Carregando detalhe…");
  });
});

// ---------------------------------------------------------------------------
// Kill switch card: the only control this dashboard offers.

describe("kill switch card", () => {
  it("offers the rearm only when the switch is engaged AND the state is known", () => {
    const engaged = renderView({
      pipeline: pipelineFixture,
      onRearm: () => Promise.resolve(null),
    });
    expect(engaged).toContain("Rearmar");
    expect(engaged).toContain("Engajado");
  });

  it("shows no button while the pipeline read has not landed", () => {
    // Nothing to rearm FROM: a button here would be a blind control, and the
    // badge is a placeholder rather than a claim that the broker is running.
    const unknown = renderView({
      pipeline: null,
      onRearm: () => Promise.resolve(null),
    });
    expect(unknown).not.toContain("Rearmar");
    expect(unknown).not.toContain("Armado");
  });

  it("shows no button when the switch is already armed", () => {
    const armed = renderView({
      pipeline: {
        ...pipelineFixture,
        kill_switch: {
          engaged: false,
          reason: null,
          engaged_at: "2026-08-24T09:00:00.000Z",
          rearmed_at: "2026-08-24T11:00:00.000Z",
          frozen_markets: [],
        },
      },
      onRearm: () => Promise.resolve(null),
    });
    expect(armed).toContain("Armado");
    expect(armed).not.toContain("Rearmar</button>");
    expect(armed).toContain("Rearmado");
  });

  it("shows no button when no action was supplied", () => {
    // A static render, or any caller that does not wire the API, gets a
    // read-only card rather than a button that cannot work.
    const readOnly = renderView({ pipeline: pipelineFixture });
    expect(readOnly).toContain("Engajado");
    expect(readOnly).not.toContain("<button");
  });

  it("keeps the reason on screen next to the control", () => {
    // The operator decides against the evidence, not from memory.
    const engaged = renderView({
      pipeline: pipelineFixture,
      onRearm: () => Promise.resolve(null),
    });
    expect(engaged).toContain(pipelineFixture.kill_switch?.reason ?? "");
  });
});
