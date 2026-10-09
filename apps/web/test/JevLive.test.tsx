import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JevLive } from "../src/JevLive.tsx";
import type { JevLivePanel } from "@ganso-market/contracts/trading";
const value: JevLivePanel = {
  version: "jev.live-panel.v1",
  limits: {
    capital_usd6: "250000000",
    entry_risk_bps: 100,
    exposure_bps: 5000,
    daily_loss_bps: 200,
    drawdown_usd6: "12500000",
    leverage: 1,
    margin: "isolated",
  },
  identity_hash: null,
  pilot_sequence: "0",
  activated: false,
  can_activate: false,
  can_rearm: false,
  reasons: ["venue_not_verified", "profile_not_currently_eligible"],
  equity_usd6: null,
  high_water_usd6: null,
  global_blocked: false,
  promotion: null,
};
const render = (v = value) =>
  renderToStaticMarkup(
    <JevLive
      value={v}
      accessToken="fixture"
      onUnauthorized={() => {}}
      refresh={() => {}}
    />,
  );
describe("JE14 operator view", () => {
  it("shows capital, limits, unconfirmed equity and blocked gates before allowing an initial act", () => {
    const html = render();
    expect(html).toContain("US$250");
    expect(html).toContain("US$12,50");
    expect(html).toContain("1×");
    expect(html).toContain("Não confirmado");
    expect(html).toContain("Ensaio da venue ainda não validado");
    expect(html).toMatch(/button disabled=""/);
    expect(html).toContain("Confirmo o patrimônio real");
  });
  it("retains actual equity and HWM through a failed-profile drain without offering a new genesis or capital change", () => {
    const html = render({
      ...value,
      activated: true,
      equity_usd6: "257000000",
      high_water_usd6: "270000000",
      global_blocked: true,
      reasons: ["global_drawdown_blocked"],
      promotion: {
        sequence: "2",
        state: "draining",
        profile_id: "failed",
        profile_version: "v1",
        experiment_id: "immutable",
      },
    });
    expect(html).toContain("US$ 257");
    expect(html).toContain("US$ 270");
    expect(html).toContain("encerramento e reconciliação");
    expect(html).toContain("nova decisão do operador");
    expect(html).not.toContain("Ativar piloto live");
    expect(html).toContain("Rearmar bloqueio global");
    expect(html).toContain("preservando o pico de US$ 270");
    expect(html).toMatch(/button disabled=""/);
  });
});
