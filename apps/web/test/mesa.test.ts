// RFC-026 PR 1: o que a Mesa lê do fio.
//
// As duas fixtures são `panel_json` REAIS, copiados de produção em 2026-09-08
// (`portfolio_panel_snapshots`, os snapshots mais recentes). Fixture sintética
// aqui não serviria: o defeito que este PR corrige é justamente o parser ter
// descartado dez níveis de livro que existiam no payload, e só um payload de
// verdade prova que eles chegam.
//
// A terceira caso da folga — positiva — é o único construído à mão, e por um
// motivo medido: em produção não existe painel com folga positiva. A última
// `ENTRY ACCEPTED` é de 2026-09-06 (HANDOFF), então o caso positivo tem de ser
// montado a partir de um real, e está marcado como tal.

import { describe, expect, it, vi } from "vitest";

import {
  fetchDecisions,
  fetchLimits,
  fetchOpportunities,
  folgaParaAceitar,
  type LimitsConfig,
} from "../src/portfolio.js";
import type { ResolutionFetcher } from "../src/resolution.js";

import painelDezNiveis from "./fixtures/painel-10-niveis.json" with { type: "json" };
import painelEdgeNegativo from "./fixtures/painel-edge-negativo.json" with { type: "json" };

function jsonResponse(
  status: number,
  body: unknown,
): Pick<Response, "ok" | "status" | "json"> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const CONFIG: LimitsConfig = {
  config_version: "1.2.0",
  edgeLiqMin: "0.02",
  safetyMarginMin: "0.01",
  bookMaxAgeMs: 30000,
  estimateMaxAgeMs: 300000,
};

function opportunityRow(panel: unknown): Record<string, unknown> {
  return {
    snapshot_id: 1,
    condition_id: "0xabc123def456",
    token_id: "t1",
    computed_at: "2026-09-08T17:00:00.000Z",
    panel_json: panel,
    decision_id: 7,
    entrable: false,
    vetoed: false,
    veto_reason: null,
    config_version: "1.2.0",
    question: "Bitcoin acima de US$ 200 mil em 2026?",
    category: "crypto",
    end_ts: "2026-09-09T00:00:00.000Z",
  };
}

describe("o painel que a Mesa consome", () => {
  it("entrega os dez níveis de cada lado do livro, de um panel_json real", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        opportunities: [opportunityRow(painelDezNiveis)],
      }),
    );

    const resultado = await fetchOpportunities(
      "t",
      fetcher as ResolutionFetcher,
    );

    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    const panel = resultado.value[0]?.panel;
    expect(panel?.book_bids).toHaveLength(10);
    expect(panel?.book_asks).toHaveLength(10);
    // Preço e tamanho seguem texto decimal, na ordem em que o motor gravou.
    expect(panel?.book_bids[0]).toEqual({ price: "0.056", size: "495" });
    expect(panel?.book_asks[0]).toEqual({ price: "0.059", size: "110" });
    // O spread, que era a única coisa que o parser lia, continua vindo.
    expect(panel?.spread).toBe("0.003000");
  });

  it("traz o nome e a categoria do mercado, e não só o hash", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        opportunities: [opportunityRow(painelDezNiveis)],
      }),
    );

    const resultado = await fetchOpportunities(
      "t",
      fetcher as ResolutionFetcher,
    );

    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    expect(resultado.value[0]?.question).toBe(
      "Bitcoin acima de US$ 200 mil em 2026?",
    );
    expect(resultado.value[0]?.category).toBe("crypto");
  });

  it("um mercado sem linha no registro fica com question nula, não com string vazia", async () => {
    const semNome = {
      ...opportunityRow(painelDezNiveis),
      question: null,
      category: null,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { opportunities: [semNome] }));

    const resultado = await fetchOpportunities(
      "t",
      fetcher as ResolutionFetcher,
    );

    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    expect(resultado.value[0]?.question).toBeNull();
    expect(resultado.value[0]?.category).toBeNull();
  });

  it("trunca em dez níveis um livro que venha maior", async () => {
    const grande = {
      ...(painelDezNiveis as Record<string, unknown>),
      book: {
        spread: "0.001",
        bids: Array.from({ length: 25 }, (_, indice) => ({
          price: `0.0${String(indice + 10)}`,
          size: "1",
        })),
        asks: [],
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { opportunities: [opportunityRow(grande)] }),
      );

    const resultado = await fetchOpportunities(
      "t",
      fetcher as ResolutionFetcher,
    );

    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    expect(resultado.value[0]?.panel.book_bids).toHaveLength(10);
    expect(resultado.value[0]?.panel.book_asks).toHaveLength(0);
  });
});

describe("o log de decisões que a Mesa consome", () => {
  const linha = {
    decision_id: 890828,
    decision_kind: "ENTRY",
    condition_id: "0xabc123def456",
    token_id: "t1",
    question: "Bitcoin acima de US$ 200 mil em 2026?",
    category: "crypto",
    decision_ts: "2026-09-08T17:53:49.325Z",
    market_side: "NO",
    order_side: "BUY",
    exec_price: "0.059000",
    edge_net: "-0.016912",
    size_shares: null,
    binding_constraint: null,
    outcome: "ACCEPTED",
    reason_code: null,
    portfolio_state: "NORMAL",
    config_version: "1.2.0",
    config_hash: "a".repeat(64),
    paper_order_id: null,
  };

  it("diz que um aceite não virou ordem paper", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { decisions: [linha] }));

    const resultado = await fetchDecisions("t", fetcher as ResolutionFetcher);

    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    const decisao = resultado.value[0];
    expect(decisao?.outcome).toBe("ACCEPTED");
    expect(decisao?.paper_order_id).toBeNull();
    expect(decisao?.question).toBe("Bitcoin acima de US$ 200 mil em 2026?");
    // O preço marca o nível no livro L2.
    expect(decisao?.exec_price).toBe("0.059000");
  });

  it("lê o número da ordem quando ela existe", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        decisions: [{ ...linha, paper_order_id: 4211 }],
      }),
    );

    const resultado = await fetchDecisions("t", fetcher as ResolutionFetcher);

    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    expect(resultado.value[0]?.paper_order_id).toBe(4211);
  });
});

describe("o bloco config de /portfolio/limits", () => {
  it("lê as cinco chaves e mantém os limiares em texto decimal", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        caps: [],
        binding_constraints_24h: [],
        config: {
          config_version: "1.2.0",
          edgeLiqMin: "0.02",
          safetyMarginMin: "0.01",
          bookMaxAgeMs: 30000,
          estimateMaxAgeMs: 300000,
        },
      }),
    );

    const resultado = await fetchLimits("t", fetcher as ResolutionFetcher);

    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    expect(resultado.value.config).toEqual(CONFIG);
    // Texto, não número: é assim que o cliente compara com edge.net sem
    // passar por float.
    expect(typeof resultado.value.config?.edgeLiqMin).toBe("string");
  });

  it("config ausente é null, e não um objeto com zeros", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        caps: [],
        binding_constraints_24h: [],
        config: null,
      }),
    );

    const resultado = await fetchLimits("t", fetcher as ResolutionFetcher);

    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    expect(resultado.value.config).toBeNull();
  });
});

describe("folgaParaAceitar", () => {
  const panelDe = (
    fixture: unknown,
  ): { edge_net: string | null; safety_margin: string | null } => {
    const registro = fixture as {
      edge: { net: string | null };
      costs: { safety_margin: string | null };
    };
    return {
      edge_net: registro.edge.net,
      safety_margin: registro.costs.safety_margin,
    };
  };

  it("negativa: diz quanto falta, com o piso da config valendo mais que a margem", () => {
    // Painel real: edge líquido −0,016912 e margem 0,010000. O piso é
    // max(0,010000, 0,02) = 0,02, então faltam 0,036912 — e note que usar só a
    // margem daria 0,026912, um número mais bonito e errado.
    const folga = folgaParaAceitar(panelDe(painelEdgeNegativo), CONFIG);

    expect(folga.piso).toBeCloseTo(0.02, 10);
    expect(folga.valor).toBeCloseTo(-0.036912, 10);
    expect(folga.faltando).toEqual([]);
  });

  it("positiva quando o edge passa do piso (caso construído: produção não tem nenhum)", () => {
    const folga = folgaParaAceitar(
      { edge_net: "0.031000", safety_margin: "0.010000" },
      CONFIG,
    );

    expect(folga.valor).toBeCloseTo(0.011, 10);
    expect(folga.piso).toBeCloseTo(0.02, 10);
  });

  it("a margem manda quando é maior que o piso da config", () => {
    const folga = folgaParaAceitar(
      { edge_net: "0.050000", safety_margin: "0.040000" },
      CONFIG,
    );

    expect(folga.piso).toBeCloseTo(0.04, 10);
    expect(folga.valor).toBeCloseTo(0.01, 10);
  });

  it("não medida quando o painel real não tem edge nem margem", () => {
    // O outro painel real: o motor parou em "estimativa fora do TTL", então
    // edge e margem chegam nulos. Zero aqui seria dizer "não falta nada".
    const folga = folgaParaAceitar(panelDe(painelDezNiveis), CONFIG);

    expect(folga.valor).toBeNull();
    expect(folga.piso).toBeNull();
    expect(folga.faltando).toContain("edge líquido");
    expect(folga.faltando).toContain("margem de segurança");
  });

  it("não medida sem o bloco config — nunca com 0,02 fixo no cliente", () => {
    const folga = folgaParaAceitar(
      { edge_net: "0.031000", safety_margin: "0.010000" },
      null,
    );

    expect(folga.valor).toBeNull();
    expect(folga.faltando).toEqual(["piso de edge da config"]);
  });

  it("não medida com metade do piso conhecida, porque a metade que falta pode ser a maior", () => {
    const folga = folgaParaAceitar(
      { edge_net: "0.031000", safety_margin: null },
      CONFIG,
    );

    expect(folga.valor).toBeNull();
    expect(folga.faltando).toEqual(["margem de segurança"]);
  });
});
