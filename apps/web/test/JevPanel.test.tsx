import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import type { JevPanelAccount } from "@ganso-market/contracts/trading";
import { JevAccountCard, JevPanelView } from "../src/JevPanel.tsx";
export const account = (): JevPanelAccount => ({
  account_id: "paper:h1",
  mode: "paper",
  profile_id: "h1",
  profile_version: "v1",
  manifest_hash: "a".repeat(64),
  horizon_minutes: 1,
  admitted: false,
  entries_paused: true,
  risk: null,
  evaluation: null,
  metrics: {
    as_of: "2026-10-08T00:00:00.000Z",
    capital_usd6: "250000000",
    risk_equity_usd6: "249000000",
    trading: {
      realized_usd6: "2000000",
      open_usd6: "-1000000",
      fees_usd6: "500000",
      funding_usd6: "-500000",
      pnl_usd6: "0",
      funding_complete: true,
    },
    attributed_jev_usd6: "1000000",
    strategy_after_jev_usd6: "-1000000",
    conservative_result_usd6: "-1000000",
    quality: "fresh",
    positions: [{ position_id: "partial", quantity_btc_raw: "-40000" }],
  },
});
describe("JE11 financial presentation", () => {
  it("uses the same signed components in table/chart and independent result cards", () => {
    const a = account();
    a.fills = [
      {
        execution_id: "fill-confirmed",
        order_id: "maker-order",
        position_id: "partial",
        side: "sell",
        kind: "maker",
        occurred_at: "2026-10-08T00:00:00Z",
        quantity_btc_raw: "40000",
        price_usd_raw: "65000000000",
        fee_usd_raw: "13000",
      },
    ];
    const html = renderToStaticMarkup(<JevAccountCard account={a} />);
    expect(html).toContain("US$ −1,00");
    expect(html).toContain("Componentes do resultado");
    expect(html).toContain("Short");
    expect(html).toContain("−0,0004");
    expect(html).toContain("SALDO FICTÍCIO");
    expect(html).toContain("maker-order");
    expect(html).toContain("Últimos fills observados");
    expect(html).toContain("maker · Venda");
  });
  it("keeps unknown cost and stale data unavailable and hides a profit chart", () => {
    const a = account();
    a.metrics = {
      ...a.metrics!,
      attributed_jev_usd6: null,
      strategy_after_jev_usd6: null,
      conservative_result_usd6: null,
      quality: "stale",
    };
    const html = renderToStaticMarkup(<JevAccountCard account={a} />);
    expect(html).toContain("Indisponível");
    expect(html).toContain("stale");
    expect(html).not.toContain("<svg");
  });
  it("shows an empty experiment and never exposes a live activation button", () => {
    const html = renderToStaticMarkup(
      <JevPanelView
        value={{
          schema_version: "jev.panel.v1",
          as_of: "now",
          accounts: [],
          live_activation_available: false,
          alternative_banks_summable: false,
        }}
      />,
    );
    expect(html).toContain("Nenhum perfil JEV");
    expect(html).toContain("Live indisponível");
    expect(html).not.toContain("Ativar");
  });
});
