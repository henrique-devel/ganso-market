import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import type { JevPanelAccount } from "@ganso-market/contracts/trading";
import { JevAccountCard } from "../src/JevPanel.js";
export function liveAccount(): JevPanelAccount {
  return {
    account_id: "live:account",
    mode: "live",
    profile_id: "h3",
    profile_version: "v2",
    manifest_hash: "a".repeat(64),
    horizon_minutes: 3,
    admitted: true,
    entries_paused: true,
    control_available: true,
    evaluation: null,
    risk: null,
    metrics: {
      as_of: "2026-10-10T03:00:00.000Z",
      source: "hyperliquid_live_reconciled",
      source_as_of: "2026-10-10T02:59:59.950Z",
      quality: "fresh",
      capital_usd6: "250000000",
      risk_equity_usd6: "255550000",
      trading_balance_usd6: "253550000",
      high_water_usd6: "255550000",
      trading: {
        realized_usd6: "3500000",
        open_usd6: "2000000",
        fees_usd6: "150000",
        funding_usd6: "200000",
        pnl_usd6: "5550000",
        funding_complete: true,
      },
      attributed_jev_usd6: "50000",
      strategy_after_jev_usd6: "5500000",
      conservative_result_usd6: "3500000",
      positions: [{ position_id: "BTC", quantity_btc_raw: "10000" }],
    },
    live_state: {
      version: "jev.live-account-panel.v1",
      source_as_of: "2026-10-10T02:59:59.950Z",
      position_btc_raw: "10000",
      orders: [
        {
          order_id: "stop-101",
          side: "sell",
          quantity_btc_raw: "10000",
          limit_price_usd6: "62000000000",
          reduce_only: true,
          position_stop: true,
        },
      ],
      orders_truncated: false,
      receipts: [
        {
          operation_id: "maker-1",
          kind: "entry",
          state: "cancelled",
          observed_at: "2026-10-10T02:59:59.950Z",
          order_id: "maker-100",
          filled_btc_raw: "10000",
          planned_btc_raw: "20000",
          profile_id: "h1",
          profile_version: "v1",
          experiment_id: "exp-old",
        },
      ],
      protection: {
        state: "confirmed",
        observed_at: "2026-10-10T02:59:59.950Z",
        quantity_btc_raw: "10000",
        stop_price_usd6: "62000000000",
        maximum_exit_at: "2026-10-10T09:00:00.000Z",
      },
      funding: [
        {
          key: "funding-one",
          occurred_at: "2026-10-10T02:00:00.000Z",
          amount_usd6: "200000",
        },
      ],
      runtime: {
        observed_at: "2026-10-10T03:00:00.000Z",
        current: true,
        connected: true,
        entries_ready: false,
        reasons: [],
      },
      history: [
        {
          experiment_id: "exp-old",
          profile_id: "h1",
          profile_version: "v1",
          start_at: "2026-10-09T20:00:00.000Z",
          end_at: "2026-10-10T02:00:00.000Z",
          realized_usd6: "3500000",
          fees_usd6: "150000",
          funding_usd6: "200000",
          attributed_jev_usd6: "50000",
          realized_after_jev_usd6: "3500000",
        },
      ],
      history_next_cursor: null,
    },
    fills: [
      {
        execution_id: "real-fill-one",
        order_id: "maker-100",
        position_id: "BTC",
        side: "buy",
        occurred_at: "2026-10-10T02:59:59.000Z",
        kind: "maker",
        quantity_btc_raw: "10000",
        price_usd_raw: "64000000000",
        fee_usd_raw: "10000",
      },
    ],
  };
}
describe("JE17 real financial and execution presentation", () => {
  it("shows independent expected totals, native protection and prior profile binding without paper labels", () => {
    const html = renderToStaticMarkup(
      <JevAccountCard account={liveAccount()} />,
    );
    for (const text of [
      "REAL · DADOS CONFIRMADOS",
      "US$ 5,5",
      "US$ 3,5",
      "US$ 255,55",
      "Proteção nativa confirmada",
      "stop-101",
      "Cancelamento confirmado",
      "maker-100",
      "Últimos fills reais",
      "h1 · v1",
      "Histórico por perfil",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("simulada em paper/stress");
    expect(html).not.toContain("REAL · MÉTRICAS INDISPONÍVEIS");
  });
  it.each(["stale", "cost_unknown", "missing"])(
    "keeps %s unavailable and avoids false protected/zero state",
    (state) => {
      const a = liveAccount();
      a.metrics!.strategy_after_jev_usd6 = null;
      a.metrics!.conservative_result_usd6 = null;
      if (state === "cost_unknown") {
        a.metrics!.attributed_jev_usd6 = null;
        a.metrics!.reasons = ["LIVE_JEV_COST_UNKNOWN"];
      } else {
        a.metrics!.quality = "stale";
        a.metrics!.risk_equity_usd6 = null;
        a.metrics!.trading_balance_usd6 = null;
        a.metrics!.trading.realized_usd6 = null;
        a.metrics!.trading.fees_usd6 = null;
        a.metrics!.trading.funding_usd6 = null;
        a.live_state!.protection.state = "unavailable";
        a.live_state!.position_btc_raw = null;
        a.metrics!.reasons = ["LIVE_SOURCE_STALE"];
      }
      if (state === "missing") {
        a.metrics = null;
        a.live_state = undefined as never;
      }
      const html = renderToStaticMarkup(<JevAccountCard account={a} />);
      expect(html).toContain("Indisponível");
      expect(html).not.toContain("<svg");
      expect(html).not.toContain("REAL · DADOS CONFIRMADOS");
      if (state === "cost_unknown") {
        expect(html).toContain("Custo JEV ainda não confirmado");
        expect(html).toContain("US$ 255,55");
      } else {
        expect(html).not.toContain("Proteção nativa confirmada");
        expect(html).toContain("Equity de risco<strong>Indisponível</strong>");
      }
    },
  );
  it.each(["protected", "reducing", "reconciled_flat", "unavailable"] as const)(
    "retains authenticated intervention status %s",
    (status) => {
      const a = liveAccount();
      a.intervention = {
        action: "emergency",
        recorded_at: "2026-10-10T03:00:00.000Z",
        status,
      };
      expect(renderToStaticMarkup(<JevAccountCard account={a} />)).toContain(
        "Intervenção emergency registrada",
      );
    },
  );
});
