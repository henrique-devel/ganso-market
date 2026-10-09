import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { JevQueue } from "../src/JevQueue.tsx";
import type { JevQueueSnapshot } from "@ganso-market/contracts/trading";
const queue: JevQueueSnapshot = {
  revision: "1",
  proposal_ids: ["a", "b"],
  proposals: [
    {
      proposal_id: "a",
      profile_id: "a",
      profile_version: "v2",
      fingerprint: "a".repeat(64),
      reason: "Comparar janela <script>alert(1)</script>",
      horizon_minutes: 1,
      rank: 2,
      cost_usd6: "42",
      origin: "real",
    },
    {
      proposal_id: "b",
      profile_id: "b",
      profile_version: "v2",
      fingerprint: "b".repeat(64),
      reason: "Coerência",
      horizon_minutes: 3,
      rank: 1,
      cost_usd6: null,
      origin: "mock",
    },
  ],
};
const render = (value: JevQueueSnapshot) =>
  renderToStaticMarkup(
    <JevQueue
      value={value}
      accessToken="fixture"
      onUnauthorized={() => {}}
      refresh={() => {}}
    />,
  );
describe("JE12 queue presentation", () => {
  it("shows priority, technical aptitude, exact billed cost and financial eligibility separately", () => {
    const html = render(queue);
    expect(html).toContain("2/3");
    expect(html).toContain("forte");
    expect(html).toContain("US$ 0,000042");
    expect(html).toContain("custo desconhecido");
    expect(html).toContain("simulação, sem admissão automática");
    expect(html).toContain("Elegibilidade financeira ainda não avaliada");
    expect(html.indexOf("horizonte 1")).toBeLessThan(
      html.indexOf("horizonte 3"),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Ativar live");
  });
  it("has explicit waiting state when no approved proposal exists", () => {
    expect(
      render({ revision: "0", proposal_ids: [], proposals: [] }),
    ).toContain("Nenhuma proposta apta esperando");
  });
});
