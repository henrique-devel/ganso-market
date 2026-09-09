// RFC-028, "Testes obrigatórios" > Propriedades de `decideFastStrategyOrder` e
// Pré-condições.
//
// A prova de que `policy.ts` não é chamada é COMPORTAMENTAL, não textual: o
// módulo é mockado com um `decideOrderType` que lança, e a grade inteira de
// contextos roda em cima disso. Um grep pelo texto do arquivo passaria mesmo
// se a chamada existisse dentro de uma string, e reprovaria por causa do
// comentário que explica por que ela NÃO existe.

import { describe, expect, it, vi } from "vitest";

import { parseFastConfig } from "../../../src/polymarket/paper/fastconfig.js";
import type { FastConfig } from "../../../src/polymarket/paper/fastconfig.js";
import {
  FAST_POLICY_VERSION,
  FAST_STRATEGY_ID,
  controlOutcome,
  decideFastStrategyOrder,
  type FastContext,
  type FastDecision,
} from "../../../src/polymarket/paper/fastpolicy.js";

vi.mock("../../../src/polymarket/paper/policy.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../../src/polymarket/paper/policy.js")
    >();
  return {
    ...original,
    // `takerFeePerShare` é aritmética pura e segue real (D3 autoriza importá-la).
    decideOrderType: () => {
      throw new Error(
        "a estratégia fast não pode chamar decideOrderType (RFC-028 D3)",
      );
    },
  };
});

const CONFIG: FastConfig = parseFastConfig({
  version: "0.1.0",
  universe: {
    questionPattern:
      "^Bitcoin Up or Down - (January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{1,2}, [0-9]{1,2}(AM|PM) ET$",
    windowMinutes: 60,
  },
  signal: { sigmaBpsPerMin: "5", tieZoneBps: "10", tieZoneMaxK: 10 },
  preconditions: {
    bookMaxAgeS: 10,
    bookMaxSpread: "0.03",
    rtdsMaxSampleAgeS: 3,
    rtdsNoGapWindowMin: 15,
    warmupS: 300,
    minSecondsToEnd: 60,
  },
  costs: { assumedTakerFeeRate: "0.07" },
  ticket: { shares: "5", fakTtlS: 5 },
  arms: {
    C: {
      mode: "shadow",
      kMin: 8,
      kMax: 12,
      bandLow: "0.70",
      bandHigh: "0.92",
      minAbsZ: "1",
      gtdUntilK: 4,
      maxQueueTicketMultiple: "3",
    },
    E: {
      mode: "shadow",
      kMin: 4,
      kMax: 10,
      bandLow: "0.80",
      bandHigh: "0.95",
      minAbsZ: "1.5",
      reversalBuckets: 3,
    },
    A: {
      mode: "shadow",
      targetK: 10,
      toleranceS: 30,
      minMid: "0.60",
      askLow: "0.60",
      askHigh: "0.90",
    },
    D: {
      mode: "shadow",
      targetK: 10,
      toleranceS: 30,
      minMid: "0.60",
      askLow: "0.60",
      askHigh: "0.90",
      seed: 20260905,
    },
  },
  limits: {
    maxOrdersPerArmPerMarket: 1,
    maxOpenPositionsPerArm: 2,
    maxOrdersPerDay: 24,
    dailyStopUsdPerArm: "10",
    dailyStopUsdSubAccount: "20",
    subAccountBankrollUsd: "100",
  },
  criteria: {
    pauseMinN: 50,
    pauseHitRateGapPoints: "10",
    stopMinN: 100,
    dailyStopStrikes: 3,
    dailyStopStrikeWindowDays: 5,
    promoteMinN: 300,
    promoteTicketShares: "20",
    promoteMaxPValue: "0.05",
    promoteReplayMaxDeviationPct: "5",
    endAfterDays: 30,
    endAfterMarketsPerArm: 700,
  },
});

const NOW = Date.parse("2026-09-09T01:50:00.000Z");
const QUESTION = "Bitcoin Up or Down - September 8, 9PM ET";
/** 02:00Z é o fim da janela das 9PM ET; T-10 em 01:50Z. */
const END_TS = new Date("2026-09-09T02:00:00.000Z");

/**
 * S0/S_t que produzem z alto e positivo em k = 10.
 *
 * ln(78900/78000) = 0,011471; σ√k = 0,0005 x √10 = 0,0015811 => z = 7,25.
 * Bem acima de 1,5, então serve para C, E, A e D ao mesmo tempo.
 */
const S0 = "78000";
const ST_UP = "78900";
/** Movimento minúsculo: 5 bps, dentro da zona de empate de 10 bps. */
const ST_TIE = "78039";

function context(overrides: Partial<FastContext> = {}): FastContext {
  return {
    arm: "A",
    config: CONFIG,
    nowMs: NOW,
    market: {
      conditionId: "0xcondition",
      question: QUESTION,
      endTs: END_TS,
      tickSize: "0.01",
    },
    books: [
      {
        tokenId: "tok-yes",
        outcome: "affirmative",
        asOfMs: NOW - 2_000,
        bids: [
          { price: "0.84", size: "12" },
          { price: "0.83", size: "40" },
        ],
        asks: [
          { price: "0.86", size: "30" },
          { price: "0.87", size: "50" },
        ],
      },
      {
        tokenId: "tok-no",
        outcome: "complement",
        asOfMs: NOW - 2_000,
        bids: [
          { price: "0.14", size: "20" },
          { price: "0.13", size: "40" },
        ],
        asks: [
          { price: "0.16", size: "25" },
          { price: "0.17", size: "50" },
        ],
      },
    ],
    rtds: {
      twap30SampleAgeS: 1,
      missingBuckets: 0,
      s0: S0,
      st: ST_UP,
      previousZSigns: [1, 1, 1],
    },
    state: {
      killSwitchEngaged: false,
      openBreakerKinds: [],
      processUptimeS: 3_600,
      mainPortfolioHoldsToken: false,
      armPaused: false,
    },
    ...overrides,
  };
}

/** O contexto de C: T-10 está na janela T-12..T-8, e a fila cabe em 3x5. */
function contextC(overrides: Partial<FastContext> = {}): FastContext {
  return context({ arm: "C", ...overrides });
}

describe("versão e identidade", () => {
  it("tem versão própria e não é a 1.0.0 da policy global", async () => {
    const global = await import("../../../src/polymarket/paper/policy.js");
    expect(FAST_POLICY_VERSION).toBe("0.1.0");
    expect(global.POLICY_VERSION).toBe("1.0.0");
    expect(FAST_POLICY_VERSION).not.toBe(global.POLICY_VERSION);
    expect(FAST_STRATEGY_ID).toBe("fast_btc_updown");
  });
});

describe("propriedade: a policy global nunca é chamada (D3)", () => {
  it("a grade inteira decide sem tocar decideOrderType", () => {
    // O mock do topo faz `decideOrderType` lançar. Se qualquer braço a
    // chamasse, algum destes casos estouraria em vez de decidir.
    const arms = ["A", "C", "D", "E"] as const;
    const sts = [ST_UP, ST_TIE, "77100", "78000"];
    const nows = [
      Date.parse("2026-09-09T01:47:00.000Z"),
      Date.parse("2026-09-09T01:50:00.000Z"),
      Date.parse("2026-09-09T01:52:00.000Z"),
      Date.parse("2026-09-09T01:55:30.000Z"),
      Date.parse("2026-09-09T01:59:30.000Z"),
    ];
    let decisions = 0;
    for (const arm of arms) {
      for (const st of sts) {
        for (const nowMs of nows) {
          const result = decideFastStrategyOrder(
            context({
              arm,
              nowMs,
              books: context().books.map((book) => ({
                ...book,
                asOfMs: nowMs - 1_000,
              })),
              rtds: { ...context().rtds, st },
            }),
          );
          decisions += 1;
          expect(result.reason.startsWith("FAST_")).toBe(true);
          expect(result.arm).toBe(arm);
        }
      }
    }
    expect(decisions).toBe(80);
  });
});

describe("propriedade: toda saída tem limite, ttl e coerência de tipo", () => {
  it("percorre a grade e verifica as invariantes da D3 em cada ordem", () => {
    const arms = ["A", "C", "D", "E"] as const;
    const sts = [ST_UP, "77100", "78400", "77600"];
    const nows = [
      Date.parse("2026-09-09T01:47:30.000Z"),
      Date.parse("2026-09-09T01:49:45.000Z"),
      Date.parse("2026-09-09T01:50:00.000Z"),
      Date.parse("2026-09-09T01:50:20.000Z"),
      Date.parse("2026-09-09T01:52:00.000Z"),
      Date.parse("2026-09-09T01:54:00.000Z"),
    ];
    const bandas = [
      { bid: "0.84", ask: "0.86" },
      { bid: "0.70", ask: "0.72" },
      { bid: "0.90", ask: "0.92" },
      { bid: "0.58", ask: "0.60" },
      { bid: "0.94", ask: "0.96" },
    ];
    let ordens = 0;
    let recusas = 0;
    for (const arm of arms) {
      for (const st of sts) {
        for (const nowMs of nows) {
          for (const banda of bandas) {
            const yesBid = Number(banda.bid);
            const yesAsk = Number(banda.ask);
            const result = decideFastStrategyOrder(
              context({
                arm,
                nowMs,
                rtds: { ...context().rtds, st },
                books: [
                  {
                    tokenId: "tok-yes",
                    outcome: "affirmative",
                    asOfMs: nowMs - 1_000,
                    bids: [{ price: banda.bid, size: "12" }],
                    asks: [{ price: banda.ask, size: "30" }],
                  },
                  {
                    tokenId: "tok-no",
                    outcome: "complement",
                    asOfMs: nowMs - 1_000,
                    bids: [{ price: (1 - yesAsk).toFixed(2), size: "20" }],
                    asks: [{ price: (1 - yesBid).toFixed(2), size: "25" }],
                  },
                ],
              }),
            );
            expectInvariants(result, arm);
            if (result.verdict === "order") {
              ordens += 1;
            } else {
              recusas += 1;
            }
          }
        }
      }
    }
    // A grade tem de exercitar as DUAS saídas: uma grade que só recusa não
    // prova invariante nenhuma sobre ordens.
    expect(ordens).toBeGreaterThan(0);
    expect(recusas).toBeGreaterThan(0);
    expect(ordens + recusas).toBe(480);
  });
});

function expectInvariants(result: FastDecision, arm: string): void {
  expect(result.reason.startsWith("FAST_")).toBe(true);
  expect(result.arm).toBe(arm);
  // Em 0.1.0 todo braço está em sombra (D8).
  expect(result.mode).toBe("shadow");
  if (result.verdict === "skip") {
    expect(result.order).toBeUndefined();
    return;
  }
  // Veredito "order" implica plano, e plano implica contexto bem formado.
  expect(result.ok).toBe(true);
  const order = result.order;
  expect(order).toBeDefined();
  if (order === undefined) {
    return;
  }
  // Toda saída tem limite.
  expect(order.limitPrice.length).toBeGreaterThan(0);
  expect(Number(order.limitPrice)).toBeGreaterThan(0);
  expect(Number(order.limitPrice)).toBeLessThan(1);
  // `ttlS` obrigatório: nenhum braço é GTC.
  expect(order.ttlS).toBeGreaterThan(0);
  expect(Number.isInteger(order.ttlS)).toBe(true);
  expect(order.orderType === "GTD" || order.orderType === "FAK").toBe(true);
  // FAK <=> worstPrice. Sem `worstPrice` não há ordem marketable.
  if (order.orderType === "FAK") {
    expect(order.worstPrice).not.toBeNull();
    expect(order.postOnly).toBe(false);
  } else {
    expect(order.worstPrice).toBeNull();
    expect(order.postOnly).toBe(true);
  }
  // C nunca é taker.
  if (arm === "C") {
    expect(order.orderType).toBe("GTD");
    expect(order.postOnly).toBe(true);
    expect(order.worstPrice).toBeNull();
  }
  // E nunca é GTC — e, aqui, nunca é sequer repousante.
  if (arm === "E") {
    expect(order.orderType).toBe("FAK");
    expect(order.worstPrice).not.toBeNull();
  }
  // A fee assumida viaja com a ordem e é a da config, não a da venue.
  expect(order.assumedTakerFeeRate).toBe("0.07");
  expect(order.strategyId).toBe(FAST_STRATEGY_ID);
  expect(order.sizeShares).toBe("5");
  // Dinheiro e preço em texto decimal, nunca number.
  for (const value of [
    order.limitPrice,
    order.sizeShares,
    order.assumedTakerFeeRate,
    order.assumedFeePerShare,
  ]) {
    expect(typeof value).toBe("string");
  }
}

describe("pré-condições: cada uma falhando sozinha tem o seu reason code", () => {
  it("kill switch engatado recusa ANTES de qualquer decisão", () => {
    // Contexto perfeito em tudo o mais: a recusa só pode vir do kill switch.
    const result = decideFastStrategyOrder(
      context({
        state: { ...context().state, killSwitchEngaged: true },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      verdict: "skip",
      reason: "FAST_SKIPPED_KILL_SWITCH",
    });
    expect(result.order).toBeUndefined();
    // Recusou antes de olhar o sinal: nem z nem k foram computados.
    expect(result.asOf.z).toBeNull();
    expect(result.asOf.k).toBeNull();
  });

  it("disjuntor aberto de QUALQUER kind recusa", () => {
    const kinds = [
      "UMA_PROPOSED_OR_DISPUTED",
      "PRICE_JUMP_NO_CATALYST",
      "RULE_CLARIFICATION",
      "PARAM_CHANGE",
      "DATA_STALENESS",
    ];
    for (const kind of kinds) {
      const result = decideFastStrategyOrder(
        context({
          state: { ...context().state, openBreakerKinds: [kind] },
        }),
      );
      expect(result.reason).toBe("FAST_SKIPPED_BREAKER_OPEN");
      expect(result.verdict).toBe("skip");
    }
  });

  it("o kill switch vem antes do disjuntor, e os dois antes do warmup", () => {
    const result = decideFastStrategyOrder(
      context({
        state: {
          ...context().state,
          killSwitchEngaged: true,
          openBreakerKinds: ["PARAM_CHANGE"],
          processUptimeS: 1,
        },
      }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_KILL_SWITCH");
  });

  it("processo com uptime abaixo do warmup recusa", () => {
    const result = decideFastStrategyOrder(
      context({ state: { ...context().state, processUptimeS: 299 } }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_WARMUP");
  });

  it("braço pausado recusa", () => {
    const result = decideFastStrategyOrder(
      context({ state: { ...context().state, armPaused: true } }),
    );
    expect(result.reason).toBe("FAST_ARM_PAUSED");
  });

  it("question fora do universo estrito recusa", () => {
    for (const question of [
      "Bitcoin Up or Down - August 28, 5:00PM-5:15PM ET",
      "Bitcoin Up or Down - August 26, 12:00PM-4:00PM ET",
      "Ethereum Up or Down - September 8, 9PM ET",
    ]) {
      const result = decideFastStrategyOrder(
        context({ market: { ...context().market, question } }),
      );
      expect(result.reason).toBe("FAST_SKIPPED_NOT_IN_UNIVERSE");
    }
  });

  it("os últimos 60 s do mercado não operam", () => {
    const result = decideFastStrategyOrder(
      context({ nowMs: Date.parse("2026-09-09T01:59:30.000Z") }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_MARKET_ENDING");
  });

  it("amostra de twap30 velha recusa, e ausente também", () => {
    for (const age of [4, 30, null]) {
      const result = decideFastStrategyOrder(
        context({
          rtds: { ...context().rtds, twap30SampleAgeS: age },
        }),
      );
      expect(result.reason).toBe("FAST_SKIPPED_RTDS_STALE");
    }
  });

  it("balde faltante no RTDS recusa", () => {
    const result = decideFastStrategyOrder(
      context({ rtds: { ...context().rtds, missingBuckets: 1 } }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_RTDS_GAP");
  });

  it("S0 ausente recusa com o código próprio", () => {
    const result = decideFastStrategyOrder(
      context({ rtds: { ...context().rtds, s0: null } }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_NO_S0");
  });

  it("S_t ausente recusa com o código próprio", () => {
    const result = decideFastStrategyOrder(
      context({ rtds: { ...context().rtds, st: null } }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_NO_ST");
  });

  it("livro velho recusa", () => {
    const result = decideFastStrategyOrder(
      context({
        books: context().books.map((book) => ({
          ...book,
          asOfMs: NOW - 11_000,
        })),
      }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_BOOK_STALE");
  });

  it("sem livro nenhum recusa", () => {
    const result = decideFastStrategyOrder(context({ books: [] }));
    expect(result.reason).toBe("FAST_SKIPPED_NO_BOOK");
  });

  it("livro cruzado é livro nenhum", () => {
    const result = decideFastStrategyOrder(
      context({
        books: [
          {
            tokenId: "tok-yes",
            outcome: "affirmative",
            asOfMs: NOW - 1_000,
            bids: [{ price: "0.90", size: "10" }],
            asks: [{ price: "0.80", size: "10" }],
          },
        ],
      }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_NO_BOOK");
  });

  it("spread acima do teto recusa no braço", () => {
    const result = decideFastStrategyOrder(
      context({
        arm: "A",
        books: [
          {
            tokenId: "tok-yes",
            outcome: "affirmative",
            asOfMs: NOW - 1_000,
            bids: [{ price: "0.80", size: "10" }],
            asks: [{ price: "0.86", size: "10" }],
          },
        ],
      }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_SPREAD_WIDE");
  });

  it("zona de empate: movimento minúsculo faltando pouco, ninguém opera", () => {
    // A D4 escreve "a < 10 min": em k = 8 a zona morde, em k = 10 exato não —
    // o que o teste seguinte fixa pelo outro lado.
    const nowMs = Date.parse("2026-09-09T01:52:00.000Z");
    for (const arm of ["A", "C", "D", "E"] as const) {
      const result = decideFastStrategyOrder(
        context({
          arm,
          nowMs,
          books: context().books.map((book) => ({
            ...book,
            asOfMs: nowMs - 1_000,
          })),
          rtds: { ...context().rtds, st: ST_TIE },
        }),
      );
      expect(result.reason).toBe("FAST_SKIPPED_TIE_ZONE");
      // A zona de empate já viu o sinal: z e k ficam gravados.
      expect(result.asOf.z).not.toBeNull();
      expect(result.asOf.k).not.toBeNull();
    }
  });

  it("a zona de empate não morde em k = 10 exato nem longe do fim", () => {
    // "a < 10 min": em k = 10 exato a zona NÃO morde. O braço A, que quer
    // exatamente T-10, decide sobre o sinal em vez de ser vetado pelo empate.
    const emDez = decideFastStrategyOrder(
      context({ arm: "A", rtds: { ...context().rtds, st: ST_TIE } }),
    );
    expect(emDez.reason).not.toBe("FAST_SKIPPED_TIE_ZONE");
    // E, mais longe, k = 25 > tieZoneMaxK.
    const result = decideFastStrategyOrder(
      context({
        arm: "C",
        nowMs: Date.parse("2026-09-09T01:35:00.000Z"),
        books: context().books.map((book) => ({
          ...book,
          asOfMs: Date.parse("2026-09-09T01:35:00.000Z") - 1_000,
        })),
        rtds: { ...context().rtds, st: ST_TIE },
      }),
    );
    expect(result.reason).not.toBe("FAST_SKIPPED_TIE_ZONE");
  });
});

describe("braço C — maker, nunca taker", () => {
  it("faz o join post-only do melhor bid do favorito, GTD até T-4", () => {
    const result = decideFastStrategyOrder(contextC());
    expect(result.verdict).toBe("order");
    expect(result.reason).toBe("FAST_C_MAKER_JOIN");
    const order = result.order;
    expect(order).toBeDefined();
    if (order === undefined) {
      return;
    }
    expect(order.orderType).toBe("GTD");
    expect(order.postOnly).toBe(true);
    expect(order.worstPrice).toBeNull();
    // Join do melhor bid do favorito (0,84 no lado afirmativo).
    expect(order.limitPrice).toBe("0.840000");
    expect(order.tokenId).toBe("tok-yes");
    // T-10 até T-4 são 6 minutos.
    expect(order.ttlS).toBe(360);
    expect(order.assumedFeePerShare).toBe("0.000000");
  });

  it("recusa fora da janela T-12..T-8", () => {
    for (const nowMs of [
      Date.parse("2026-09-09T01:46:00.000Z"),
      Date.parse("2026-09-09T01:53:00.000Z"),
    ]) {
      const result = decideFastStrategyOrder(
        contextC({
          nowMs,
          books: context().books.map((book) => ({
            ...book,
            asOfMs: nowMs - 1_000,
          })),
        }),
      );
      expect(result.reason).toBe("FAST_SKIPPED_WINDOW");
    }
  });

  it("recusa favorito fora da banda [0,70; 0,92]", () => {
    const result = decideFastStrategyOrder(
      contextC({
        books: [
          {
            tokenId: "tok-yes",
            outcome: "affirmative",
            asOfMs: NOW - 1_000,
            bids: [{ price: "0.94", size: "10" }],
            asks: [{ price: "0.95", size: "10" }],
          },
        ],
      }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_BAND");
  });

  it("recusa |z| abaixo de 1", () => {
    // ln(78010/78000) = 1,28 bps; z = 0,81 em k = 10 — acima da zona de empate
    // de 10 bps? Não: por isso o teste usa k = 25, fora da zona.
    const nowMs = Date.parse("2026-09-09T01:48:30.000Z");
    const result = decideFastStrategyOrder(
      contextC({
        nowMs,
        books: context().books.map((book) => ({
          ...book,
          asOfMs: nowMs - 1_000,
        })),
        rtds: { ...context().rtds, st: "78035" },
      }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_Z_BELOW");
  });

  it("recusa fila visível acima de 3x o ticket", () => {
    const result = decideFastStrategyOrder(
      contextC({
        books: [
          {
            tokenId: "tok-yes",
            outcome: "affirmative",
            asOfMs: NOW - 1_000,
            // 16 cotas à frente contra um ticket de 5: 3x5 = 15.
            bids: [{ price: "0.84", size: "16" }],
            asks: [{ price: "0.86", size: "30" }],
          },
        ],
      }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_QUEUE_AHEAD");
  });

  it("aceita a fila exatamente no limite de 3x o ticket", () => {
    const result = decideFastStrategyOrder(
      contextC({
        books: [
          {
            tokenId: "tok-yes",
            outcome: "affirmative",
            asOfMs: NOW - 1_000,
            bids: [{ price: "0.84", size: "15" }],
            asks: [{ price: "0.86", size: "30" }],
          },
        ],
      }),
    );
    expect(result.verdict).toBe("order");
  });
});

describe("braço E — convergência, nunca GTC", () => {
  it("emite FAK com worstPrice = ask + 1 tick dentro de [0,80; 0,95)", () => {
    const nowMs = Date.parse("2026-09-09T01:54:00.000Z");
    const result = decideFastStrategyOrder(
      context({
        arm: "E",
        nowMs,
        books: [
          {
            tokenId: "tok-yes",
            outcome: "affirmative",
            asOfMs: nowMs - 1_000,
            bids: [{ price: "0.86", size: "12" }],
            asks: [{ price: "0.88", size: "30" }],
          },
        ],
      }),
    );
    expect(result.verdict).toBe("order");
    expect(result.reason).toBe("FAST_E_CONVERGENCE_FAK");
    const order = result.order;
    expect(order).toBeDefined();
    if (order === undefined) {
      return;
    }
    expect(order.orderType).toBe("FAK");
    expect(order.worstPrice).toBe("0.890000");
    expect(order.limitPrice).toBe("0.890000");
    expect(order.postOnly).toBe(false);
    expect(order.ttlS).toBe(5);
    // fee = 0,07 x 0,89 x 0,11 = 0,006853
    expect(order.assumedFeePerShare).toBe("0.006853");
  });

  it("o limite superior da banda é EXCLUSIVO", () => {
    const nowMs = Date.parse("2026-09-09T01:54:00.000Z");
    const result = decideFastStrategyOrder(
      context({
        arm: "E",
        nowMs,
        books: [
          {
            tokenId: "tok-yes",
            outcome: "affirmative",
            asOfMs: nowMs - 1_000,
            // ask + 1 tick = 0,95, que a D5 exclui.
            bids: [{ price: "0.93", size: "12" }],
            asks: [{ price: "0.94", size: "30" }],
          },
        ],
      }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_BAND");
  });

  it("recusa quando z trocou de sinal nos 3 baldes anteriores", () => {
    const nowMs = Date.parse("2026-09-09T01:54:00.000Z");
    const base = {
      arm: "E" as const,
      nowMs,
      books: [
        {
          tokenId: "tok-yes",
          outcome: "affirmative" as const,
          asOfMs: nowMs - 1_000,
          bids: [{ price: "0.86", size: "12" }],
          asks: [{ price: "0.88", size: "30" }],
        },
      ],
    };
    const reverted = decideFastStrategyOrder(
      context({
        ...base,
        rtds: { ...context().rtds, previousZSigns: [1, -1, 1] },
      }),
    );
    expect(reverted.reason).toBe("FAST_SKIPPED_Z_REVERSAL");
    // Fora dos 3 baldes, a mesma troca não veta.
    const older = decideFastStrategyOrder(
      context({
        ...base,
        rtds: { ...context().rtds, previousZSigns: [1, 1, 1, -1] },
      }),
    );
    expect(older.verdict).toBe("order");
  });

  it("recusa k fora de [4, 10]", () => {
    for (const nowMs of [
      Date.parse("2026-09-09T01:44:00.000Z"),
      Date.parse("2026-09-09T01:57:00.000Z"),
    ]) {
      const result = decideFastStrategyOrder(
        context({
          arm: "E",
          nowMs,
          books: context().books.map((book) => ({
            ...book,
            asOfMs: nowMs - 1_000,
          })),
        }),
      );
      expect(result.reason).toBe("FAST_SKIPPED_WINDOW");
    }
  });

  it("escolhe o lado que o movimento favorece", () => {
    const nowMs = Date.parse("2026-09-09T01:54:00.000Z");
    const books = [
      {
        tokenId: "tok-yes",
        outcome: "affirmative" as const,
        asOfMs: nowMs - 1_000,
        bids: [{ price: "0.86", size: "12" }],
        asks: [{ price: "0.88", size: "30" }],
      },
      {
        tokenId: "tok-no",
        outcome: "complement" as const,
        asOfMs: nowMs - 1_000,
        bids: [{ price: "0.86", size: "12" }],
        asks: [{ price: "0.88", size: "30" }],
      },
    ];
    const up = decideFastStrategyOrder(
      context({
        arm: "E",
        nowMs,
        books,
        rtds: { ...context().rtds, st: ST_UP },
      }),
    );
    expect(up.order?.tokenId).toBe("tok-yes");
    const down = decideFastStrategyOrder(
      context({
        arm: "E",
        nowMs,
        books,
        rtds: {
          ...context().rtds,
          st: "77100",
          previousZSigns: [-1, -1, -1],
        },
      }),
    );
    expect(down.order?.tokenId).toBe("tok-no");
  });
});

describe("braços A e D — favorito tardio e controle", () => {
  it("A compra o favorito em T-10 quando o ask está na banda", () => {
    const result = decideFastStrategyOrder(context({ arm: "A" }));
    expect(result.verdict).toBe("order");
    expect(result.reason).toBe("FAST_A_LATE_FAVOURITE");
    expect(result.order?.tokenId).toBe("tok-yes");
    expect(result.order?.worstPrice).toBe("0.860000");
  });

  it("A recusa fora de T-10 +/- 30 s", () => {
    for (const nowMs of [
      Date.parse("2026-09-09T01:49:20.000Z"),
      Date.parse("2026-09-09T01:50:40.000Z"),
    ]) {
      const result = decideFastStrategyOrder(
        context({
          arm: "A",
          nowMs,
          books: context().books.map((book) => ({
            ...book,
            asOfMs: nowMs - 1_000,
          })),
        }),
      );
      expect(result.reason).toBe("FAST_SKIPPED_WINDOW");
    }
  });

  it("A aceita dentro da tolerância de 30 s", () => {
    for (const nowMs of [
      Date.parse("2026-09-09T01:49:31.000Z"),
      Date.parse("2026-09-09T01:50:29.000Z"),
    ]) {
      const result = decideFastStrategyOrder(
        context({
          arm: "A",
          nowMs,
          books: context().books.map((book) => ({
            ...book,
            asOfMs: nowMs - 1_000,
          })),
        }),
      );
      expect(result.verdict).toBe("order");
    }
  });

  it("A recusa ask acima de 0,90 mesmo com o favorito bem acima de 0,60", () => {
    const result = decideFastStrategyOrder(
      context({
        arm: "A",
        books: [
          {
            tokenId: "tok-yes",
            outcome: "affirmative",
            asOfMs: NOW - 1_000,
            bids: [{ price: "0.91", size: "10" }],
            asks: [{ price: "0.93", size: "10" }],
          },
        ],
      }),
    );
    expect(result.reason).toBe("FAST_SKIPPED_BAND");
  });

  it("D sorteia o lado com semente fixa: o mesmo mercado, o mesmo lado", () => {
    const first = decideFastStrategyOrder(context({ arm: "D" }));
    const again = decideFastStrategyOrder(context({ arm: "D" }));
    expect(first.order?.tokenId).toBe(again.order?.tokenId);
    expect(first.reason).toBe(again.reason);
  });

  it("o sorteio de D não depende do sinal, e o de A depende do livro", () => {
    // Mesmo mercado, movimento oposto: D mantém o lado, porque sorteia.
    const up = decideFastStrategyOrder(context({ arm: "D" }));
    const down = decideFastStrategyOrder(
      context({
        arm: "D",
        rtds: { ...context().rtds, st: "77100", previousZSigns: [-1, -1, -1] },
      }),
    );
    expect(up.asOf.tokenId).toBe(down.asOf.tokenId);
  });

  it("o sorteio distribui os dois lados ao longo dos mercados", () => {
    // Um controle que sorteasse sempre o mesmo lado não seria controle.
    let afirmativos = 0;
    let complementos = 0;
    for (let index = 0; index < 200; index += 1) {
      const outcome = controlOutcome(20260905, `0xcondition-${String(index)}`);
      if (outcome === "affirmative") {
        afirmativos += 1;
      } else {
        complementos += 1;
      }
    }
    expect(afirmativos).toBeGreaterThan(60);
    expect(complementos).toBeGreaterThan(60);
    expect(afirmativos + complementos).toBe(200);
  });

  it("sementes diferentes sorteiam sequências diferentes", () => {
    const a = Array.from({ length: 40 }, (_unused, index) =>
      controlOutcome(1, `0x${String(index)}`),
    ).join("");
    const b = Array.from({ length: 40 }, (_unused, index) =>
      controlOutcome(2, `0x${String(index)}`),
    ).join("");
    expect(a).not.toBe(b);
  });
});

describe("insumos as-of gravados (D7)", () => {
  it("a decisão carrega bid/ask/spread/fila/S0/S_t/z/k e a fee assumida", () => {
    const result = decideFastStrategyOrder(contextC());
    expect(result.asOf).toMatchObject({
      tokenId: "tok-yes",
      outcome: "affirmative",
      bestBid: "0.840000",
      bestAsk: "0.860000",
      spread: "0.020000",
      queueAhead: "12.000000",
      s0: S0,
      st: ST_UP,
      k: 10,
      assumedTakerFeeRate: "0.07",
    });
    // z = ln(78900/78000) / (0,0005 x √10) = 7,255784
    expect(Number(result.asOf.z)).toBeCloseTo(7.255784, 5);
  });

  it("o replay reproduz braço, veredito, reason e z a partir dos insumos", () => {
    // "Replay: decidir de novo sobre os insumos as-of gravados reproduz
    // braço/veredito/reason/z" — aqui na versão pura, sem banco.
    for (const arm of ["A", "C", "D", "E"] as const) {
      const primeira = decideFastStrategyOrder(context({ arm }));
      const segunda = decideFastStrategyOrder(context({ arm }));
      expect(segunda.arm).toBe(primeira.arm);
      expect(segunda.verdict).toBe(primeira.verdict);
      expect(segunda.reason).toBe(primeira.reason);
      expect(segunda.asOf.z).toBe(primeira.asOf.z);
      expect(segunda.order?.limitPrice).toBe(primeira.order?.limitPrice);
    }
  });
});

describe("contexto malformado não é decisão gravável", () => {
  it("tick size degenerado no braço E é ok:false", () => {
    const nowMs = Date.parse("2026-09-09T01:54:00.000Z");
    const result = decideFastStrategyOrder(
      context({
        arm: "E",
        nowMs,
        market: { ...context().market, tickSize: "0" },
        books: context().books.map((book) => ({
          ...book,
          asOfMs: nowMs - 1_000,
        })),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("FAST_INVALID_TICK_SIZE");
    expect(result.order).toBeUndefined();
  });

  it("end_ts inválido é ok:false", () => {
    const result = decideFastStrategyOrder(
      context({
        market: { ...context().market, endTs: new Date(Number.NaN) },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("FAST_INVALID_END_TS");
  });
});
