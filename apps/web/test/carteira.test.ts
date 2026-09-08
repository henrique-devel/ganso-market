// RFC-026 D8/D9 — a Carteira e os filtros de Decisões, no cliente.
//
// O que pode dar errado em silêncio aqui é sempre a mesma família de bugs:
// uma ausência virando zero. Uma marca envelhecida somada como 0,00 dá uma
// carteira no zero a zero; uma fila desconhecida impressa como 0 diz que a
// ordem está na frente quando ninguém mediu; um selo de "resolvido na venue"
// aceso por payload malformado manda liquidar o que não resolveu. Cada teste
// abaixo é um desses.

import { describe, expect, it, vi } from "vitest";

import {
  duracaoTexto,
  fetchPaperOrders,
  fetchPaperPositions,
  idadeTexto,
  quantidadeTexto,
  sinalTexto,
  usdTexto,
  type PaperPosition,
} from "../src/paper.js";
import {
  filtrarDecisoes,
  ladoDaPosicao,
  posicaoAberta,
  totalNaoRealizado,
} from "../src/Portfolio.tsx";
import { frasesAgora } from "../src/Mesa.tsx";
import type { Decision } from "../src/portfolio.js";
import type { ResolutionFetcher } from "../src/resolution.js";

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

function posicao(patch: Partial<PaperPosition> = {}): PaperPosition {
  return {
    token_id: "tok-1",
    condition_id: "0xabc",
    question: "Will ETH be above $4,000?",
    shares: "10.000000",
    cost_usd: "6.000000",
    realized_pnl_usd: "0.000000",
    fees_paid_usd: "0.070000",
    unrealized_pnl_usd: "1.250000",
    mark_value_usd: "7.250000",
    mark_stale: false,
    marked_at: "2026-09-08T12:00:00.000Z",
    opened_at: "2026-09-08T10:00:00.000Z",
    current_lockup_s: 7_200,
    end_ts: "2026-12-31T23:00:00.000Z",
    is_final: null,
    pending_settlement: false,
    ...patch,
  };
}

function decisao(patch: Partial<Decision> = {}): Decision {
  return {
    decision_id: 1,
    decision_kind: "ENTRY",
    condition_id: "0xabc",
    token_id: "tok-1",
    question: "Will ETH be above $4,000?",
    category: "crypto",
    decision_ts: "2026-09-08T12:00:00.000Z",
    market_side: "YES",
    edge_net: 0.03,
    size_shares: 10,
    binding_constraint: "KELLY_CAP",
    outcome: "ACCEPTED",
    reason_code: null,
    portfolio_state: "NORMAL",
    exec_price: "0.610000",
    paper_order_id: 7,
    ...patch,
  };
}

describe("usdTexto — dinheiro sem passar por float", () => {
  it("imprime o texto decimal do banco com duas casas", () => {
    expect(usdTexto("12.090000")).toBe("$12.09");
    expect(usdTexto("0.000000")).toBe("$0.00");
    expect(usdTexto("1234.500000")).toBe("$1234.50");
  });

  it("usa o menos tipográfico e não inventa perda de zero", () => {
    expect(usdTexto("-9.250000")).toBe("−$9.25");
    // Arredonda para zero: sem sinal, porque "−$0,00" anuncia uma perda que
    // não existe.
    expect(usdTexto("-0.001000")).toBe("$0.00");
  });

  it("arredonda na terceira casa, para cima, com exatidão", () => {
    expect(usdTexto("0.005000")).toBe("$0.01");
    expect(usdTexto("0.004999")).toBe("$0.00");
    // O caso que um float erraria: 1,005 em binário é 1,00499999...
    expect(usdTexto("1.005000")).toBe("$1.01");
    // E um valor além da precisão de um double continua exato.
    expect(usdTexto("9007199254740993.010000")).toBe("$9007199254740993.01");
  });

  it("devolve travessão para o que não dá para ler, nunca zero", () => {
    expect(usdTexto(null)).toBe("—");
    expect(usdTexto("")).toBe("—");
    expect(usdTexto("NaN")).toBe("—");
    expect(usdTexto("1e3")).toBe("—");
  });
});

describe("quantidadeTexto e sinalTexto", () => {
  it("tira os zeros à direita sem mudar a quantidade", () => {
    expect(quantidadeTexto("150.000000")).toBe("150");
    expect(quantidadeTexto("12.090000")).toBe("12.09");
    expect(quantidadeTexto("0.000000")).toBe("0");
    expect(quantidadeTexto(null)).toBe("—");
  });

  it("distingue os três sinais e a ausência", () => {
    expect(sinalTexto("12.090000")).toBe(1);
    expect(sinalTexto("-9.250000")).toBe(-1);
    expect(sinalTexto("0.000000")).toBe(0);
    expect(sinalTexto(null)).toBeNull();
  });
});

describe("idadeTexto", () => {
  const agora = Date.parse("2026-09-08T12:00:00.000Z");

  it("escreve a idade em unidade legível", () => {
    expect(idadeTexto("2026-09-08T11:59:48.000Z", agora)).toBe("há 12 s");
    expect(idadeTexto("2026-09-08T11:30:00.000Z", agora)).toBe("há 30 min");
    expect(idadeTexto("2026-09-08T02:00:00.000Z", agora)).toBe("há 10 h");
  });

  it("diz 'não medido' quando não há instante — nunca 'há 0 s'", () => {
    expect(idadeTexto(null, agora)).toBe("não medido");
    expect(idadeTexto("não é data", agora)).toBe("não medido");
  });
});

describe("lado e abertura de uma posição", () => {
  it("lê o lado do sinal das cotas, e zero não é um lado", () => {
    expect(ladoDaPosicao(posicao({ shares: "10.000000" }))).toBe("Comprado");
    expect(ladoDaPosicao(posicao({ shares: "-9.250000" }))).toBe("Vendido");
    expect(ladoDaPosicao(posicao({ shares: "0.000000" }))).toBe("Encerrada");
    expect(ladoDaPosicao(posicao({ shares: null }))).toBe("não medido");
  });

  it("conta como aberta a posição vendida, não só a comprada", () => {
    expect(posicaoAberta(posicao({ shares: "-9.250000" }))).toBe(true);
    expect(posicaoAberta(posicao({ shares: "0.000000" }))).toBe(false);
  });
});

describe("totalNaoRealizado — ausência nunca vira zero", () => {
  it("soma as posições medidas, em texto exato", () => {
    const total = totalNaoRealizado([
      posicao({ token_id: "a", unrealized_pnl_usd: "1.250000" }),
      posicao({ token_id: "b", unrealized_pnl_usd: "-0.750000" }),
    ]);
    expect(total.texto).toBe("$0.50");
    expect(total.envelhecidas).toBe(0);
  });

  it("mantém a marca envelhecida FORA da soma e diz quantas são", () => {
    const total = totalNaoRealizado([
      posicao({ token_id: "a", unrealized_pnl_usd: "1.250000" }),
      posicao({
        token_id: "b",
        unrealized_pnl_usd: null,
        mark_stale: true,
      }),
    ]);
    // O número medido continua sendo o medido, e a contagem aparece ao lado:
    // somar a segunda como 0,00 daria "$1.25" e esconderia que falta uma.
    expect(total.texto).toBe("$1.25 (1 marcas envelhecidas fora da soma)");
    expect(total.envelhecidas).toBe(1);
  });

  it("com nenhuma marca fresca escreve travessão e a contagem, nunca $0.00", () => {
    const total = totalNaoRealizado([
      posicao({ token_id: "a", unrealized_pnl_usd: null }),
      posicao({ token_id: "b", unrealized_pnl_usd: null }),
    ]);
    expect(total.texto).toBe("— (2 marcas envelhecidas)");
    expect(total.texto).not.toContain("0.00");
  });

  it("ignora posição encerrada, que não tem PnL não realizado a somar", () => {
    const total = totalNaoRealizado([
      posicao({ token_id: "a", unrealized_pnl_usd: "1.250000" }),
      posicao({
        token_id: "z",
        shares: "0.000000",
        unrealized_pnl_usd: null,
      }),
    ]);
    expect(total.texto).toBe("$1.25");
    expect(total.envelhecidas).toBe(0);
  });
});

describe("filtrarDecisoes — o fallback da D9, no cliente", () => {
  const log = [
    decisao({ decision_id: 1, outcome: "ACCEPTED" }),
    decisao({
      decision_id: 2,
      outcome: "REJECTED",
      reason_code: "EDGE_BELOW_MIN",
      question: "Will BTC be above $100,000?",
      condition_id: "0xdef",
    }),
    decisao({ decision_id: 3, outcome: "REJECTED" }),
  ];

  it("filtra por resultado", () => {
    expect(
      filtrarDecisoes(log, "ACCEPTED", "").map((d) => d.decision_id),
    ).toEqual([1]);
    expect(
      filtrarDecisoes(log, "REJECTED", "").map((d) => d.decision_id),
    ).toEqual([2, 3]);
    expect(filtrarDecisoes(log, "todas", "")).toHaveLength(3);
  });

  it("casa mercado por nome ou por hash, sem diferenciar maiúsculas", () => {
    expect(
      filtrarDecisoes(log, "todas", "btc").map((d) => d.decision_id),
    ).toEqual([2]);
    expect(
      filtrarDecisoes(log, "todas", "0xDEF").map((d) => d.decision_id),
    ).toEqual([2]);
    expect(filtrarDecisoes(log, "todas", "eth")).toHaveLength(2);
  });

  it("combina os dois filtros", () => {
    expect(
      filtrarDecisoes(log, "REJECTED", "eth").map((d) => d.decision_id),
    ).toEqual([3]);
  });

  it("não derruba a linha sem nome nem sem hash", () => {
    const anonima = [
      decisao({ decision_id: 9, question: null, condition_id: null }),
    ];
    expect(filtrarDecisoes(anonima, "todas", "")).toHaveLength(1);
    expect(filtrarDecisoes(anonima, "todas", "eth")).toHaveLength(0);
  });
});

describe("frasesAgora — a terceira frase da D7", () => {
  it("anuncia a posição resolvida na venue e não liquidada", () => {
    const frases = frasesAgora(
      null,
      [],
      [
        posicao({ token_id: "a", pending_settlement: true }),
        posicao({ token_id: "b", pending_settlement: false }),
      ],
    );
    const frase = frases.find((f) => f.chave === "nao-liquidada");
    expect(frase?.texto).toContain("1 posição(ões)");
    // Vermelho: a liquidação não sai sozinha.
    expect(frase?.tom).toBe("alerta");
  });

  it("cala quando nada está pendente", () => {
    const frases = frasesAgora(
      null,
      [],
      [posicao({ pending_settlement: false })],
    );
    expect(frases.find((f) => f.chave === "nao-liquidada")).toBeUndefined();
  });

  it("continua funcionando sem a lista de posições", () => {
    // A Mesa monta antes do primeiro fetch responder, e um `undefined` aqui
    // não pode derrubar o bloco inteiro.
    expect(frasesAgora(null, [])).toEqual([]);
  });

  it("nunca passa de três frases", () => {
    const overview = {
      kill_switch: { engaged: true, reason: "RECORDER_STALE" },
    } as unknown as Parameters<typeof frasesAgora>[0];
    const frases = frasesAgora(
      overview,
      [decisao({ outcome: "ACCEPTED", paper_order_id: null })],
      [posicao({ pending_settlement: true })],
    );
    expect(frases).toHaveLength(3);
  });
});

describe("fetchPaperPositions", () => {
  it("lê a resposta e preserva o texto decimal como texto", async () => {
    const fetcher = vi.fn<ResolutionFetcher>().mockResolvedValue(
      jsonResponse(200, {
        simulation: "SIMULAÇÃO — SEM EXECUÇÃO REAL",
        positions: [
          {
            token_id: "tok-1",
            condition_id: "0xabc",
            question: "Will ETH be above $4,000?",
            shares: "12.090000",
            unrealized_pnl_usd: "1.250000",
            is_final: true,
            pending_settlement: true,
          },
        ],
      }),
    );

    const resultado = await fetchPaperPositions("token", fetcher);
    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/polymarket/paper/positions");
    const linha = resultado.value[0];
    expect(linha?.shares).toBe("12.090000");
    expect(typeof linha?.unrealized_pnl_usd).toBe("string");
    expect(linha?.pending_settlement).toBe(true);
  });

  it("só acende o selo com um `true` explícito do servidor", async () => {
    const fetcher = vi.fn<ResolutionFetcher>().mockResolvedValue(
      jsonResponse(200, {
        positions: [
          { token_id: "a", pending_settlement: "true" },
          { token_id: "b", pending_settlement: 1 },
          { token_id: "c" },
        ],
      }),
    );

    const resultado = await fetchPaperPositions("token", fetcher);
    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    // Um payload malformado não pode virar "resolvido na venue": o selo manda
    // olhar uma liquidação que talvez não exista.
    expect(resultado.value.map((p) => p.pending_settlement)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("descarta a linha sem token_id em vez de derrubar a página", async () => {
    const fetcher = vi.fn<ResolutionFetcher>().mockResolvedValue(
      jsonResponse(200, {
        positions: [{ token_id: "a" }, { shares: "1.000000" }],
      }),
    );
    const resultado = await fetchPaperPositions("token", fetcher);
    expect(resultado.kind).toBe("ok");
    if (resultado.kind === "ok") {
      expect(resultado.value).toHaveLength(1);
    }
  });

  it("devolve unauthorized no 401, para a sessão poder renovar", async () => {
    const fetcher = vi
      .fn<ResolutionFetcher>()
      .mockResolvedValue(jsonResponse(401, {}));
    expect((await fetchPaperPositions("token", fetcher)).kind).toBe(
      "unauthorized",
    );
  });
});

describe("fetchPaperOrders", () => {
  it("preserva `queue_ahead` como texto e o ausente como null", async () => {
    const fetcher = vi.fn<ResolutionFetcher>().mockResolvedValue(
      jsonResponse(200, {
        orders: [
          { order_id: "o1", queue_ahead: "150.000000", status: "open" },
          { order_id: "o2", status: "filled" },
        ],
      }),
    );

    const resultado = await fetchPaperOrders("token", fetcher);
    expect(resultado.kind).toBe("ok");
    if (resultado.kind !== "ok") {
      return;
    }
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/polymarket/paper/orders");
    expect(resultado.value[0]?.queue_ahead).toBe("150.000000");
    // `null` é "não medido" e a tela escreve isso; virar 0 diria que a ordem
    // está na frente da fila.
    expect(resultado.value[1]?.queue_ahead).toBeNull();
  });
});

describe("duracaoTexto — decorrido, não o que falta", () => {
  it("escreve a duração na unidade certa", () => {
    expect(duracaoTexto(12)).toBe("12 s");
    expect(duracaoTexto(600)).toBe("10 min");
    expect(duracaoTexto(7_200)).toBe("2.0 h");
    expect(duracaoTexto(172_800)).toBe("2.0 d");
  });

  it("não chama de 'vencido' o capital preso há zero segundo", () => {
    // `horizonLabel` mede o que FALTA e devolve "vencido" para <= 0. Num
    // cartão de posição aberta esse rótulo manda agir pelo motivo errado.
    expect(duracaoTexto(0)).toBe("0 s");
    expect(duracaoTexto(null)).toBe("—");
  });
});
