// RFC-028 D7: a aritmética do backtest, verificada em processo.
//
// Em processo e não pelo `dist/`: `make verify` roda `test` ANTES de `build`,
// então um teste que executasse o CLI compilado passaria localmente e
// reprovaria no CI numa árvore limpa.
//
// O que estes testes defendem, em ordem de importância: a AUSÊNCIA de
// look-ahead (`S_t` vem do balde anterior, a cotação do balde em ou antes), o
// σ realizado medido só entre baldes adjacentes, e o modelo de execução do
// braço maker, que só é preenchido quando o preço vem até ele.

import { describe, expect, it } from "vitest";

import { parseFastConfig } from "../../../src/polymarket/paper/fastconfig.js";
import type { FastConfig } from "../../../src/polymarket/paper/fastconfig.js";
import {
  BANDS,
  quoteAtOrBefore,
  realizedSigma,
  reversalStats,
  runBacktest,
  s0Of,
  stAtOrBefore,
  zAt,
  type BacktestFeedPoint,
  type BacktestMarket,
  type BacktestQuote,
} from "../../../src/polymarket/paper/fastbacktest.js";

const CONFIG: FastConfig = parseFastConfig(
  JSON.parse(
    JSON.stringify({
      version: "0.1.0",
      universe: {
        questionPattern: "^Bitcoin Up or Down - .*$",
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
    }),
  ) as unknown,
);

const OPEN = new Date("2026-09-09T01:00:00.000Z");
const END = new Date("2026-09-09T02:00:00.000Z");

/** Uma série de minuto contínua entre dois instantes, com preço constante. */
function feed(
  from: Date,
  minutes: number,
  price: (index: number) => number,
): readonly BacktestFeedPoint[] {
  return Array.from({ length: minutes }, (_unused, index) => ({
    bucketStart: new Date(from.getTime() + index * 60_000),
    open: price(index).toFixed(6),
    close: price(index + 1).toFixed(6),
  }));
}

function quotes(
  from: Date,
  minutes: number,
  bid: (index: number) => number,
  ask: (index: number) => number,
): readonly BacktestQuote[] {
  return Array.from({ length: minutes }, (_unused, index) => ({
    bucketStart: new Date(from.getTime() + index * 60_000),
    bestBid: bid(index).toFixed(4),
    bestAsk: ask(index).toFixed(4),
  }));
}

function market(overrides: Partial<BacktestMarket> = {}): BacktestMarket {
  return {
    conditionId: "0xmarket",
    question: "Bitcoin Up or Down - September 8, 9PM ET",
    openTs: OPEN,
    endTs: END,
    tickSize: "0.01",
    affirmativeTokenId: "tok-yes",
    complementTokenId: "tok-no",
    affirmativeWon: true,
    affirmativeQuotes: quotes(
      OPEN,
      60,
      () => 0.84,
      () => 0.86,
    ),
    complementQuotes: quotes(
      OPEN,
      60,
      () => 0.14,
      () => 0.16,
    ),
    // Preço subindo 10 unidades por minuto a partir de 78 000.
    twap30: feed(
      new Date(OPEN.getTime() - 5 * 60_000),
      70,
      (i) => 78_000 + i * 10,
    ),
    twap60: feed(
      new Date(OPEN.getTime() - 5 * 60_000),
      70,
      (i) => 78_000 + i * 10,
    ),
    ...overrides,
  };
}

describe("S0 é o open do twap60 no balde da ABERTURA", () => {
  it("lê o balde da abertura, não o primeiro balde disponível", () => {
    // A série começa 5 min antes da abertura: o primeiro balde vale 78 000 e o
    // da abertura vale 78 050. S0 tem de ser o segundo.
    expect(s0Of(market())).toBe(78_050);
  });

  it("sem o balde da abertura, S0 é nulo — nunca um vizinho", () => {
    const withoutOpen = market({
      twap60: feed(
        new Date(OPEN.getTime() + 5 * 60_000),
        50,
        (i) => 78_000 + i,
      ),
    });
    expect(s0Of(withoutOpen)).toBeNull();
  });
});

describe("S_t não lê o futuro", () => {
  it("usa o balde ESTRITAMENTE anterior ao instante da decisão", () => {
    const decisionMs = END.getTime() - 10 * 60_000; // 01:50Z
    const result = stAtOrBefore(market(), decisionMs);
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    // O balde de 01:50 existe, mas fecharia depois de decidir: o usado é o de
    // 01:49, cujo close é o preço do minuto 01:50 na construção da série.
    expect(result.bucketMs).toBe(Date.parse("2026-09-09T01:49:00.000Z"));
    expect(result.bucketMs).toBeLessThan(decisionMs);
  });

  it("o balde do próprio instante da decisão nunca é escolhido", () => {
    // Série com um único balde, exatamente no instante da decisão.
    const decisionMs = Date.parse("2026-09-09T01:50:00.000Z");
    const only = market({
      twap30: [
        {
          bucketStart: new Date(decisionMs),
          open: "78000",
          close: "99999",
        },
      ],
    });
    expect(stAtOrBefore(only, decisionMs)).toBeNull();
  });
});

describe("a cotação as-of não lê o futuro nem aceita qualquer idade", () => {
  it("escolhe o balde mais recente em ou antes da decisão", () => {
    const decisionMs = Date.parse("2026-09-09T01:50:00.000Z");
    const chosen = quoteAtOrBefore(
      quotes(
        OPEN,
        60,
        (i) => 0.5 + i / 1_000,
        (i) => 0.52 + i / 1_000,
      ),
      decisionMs,
    );
    expect(chosen?.bucketStart.toISOString()).toBe("2026-09-09T01:50:00.000Z");
  });

  it("recusa uma cotação mais velha que a tolerância", () => {
    const decisionMs = Date.parse("2026-09-09T01:50:00.000Z");
    const stale = [
      {
        bucketStart: new Date("2026-09-09T01:45:00.000Z"),
        bestBid: "0.84",
        bestAsk: "0.86",
      },
    ];
    expect(quoteAtOrBefore(stale, decisionMs)).toBeNull();
  });

  it("recusa um livro cruzado", () => {
    const decisionMs = Date.parse("2026-09-09T01:50:00.000Z");
    const crossed = [
      {
        bucketStart: new Date("2026-09-09T01:50:00.000Z"),
        bestBid: "0.90",
        bestAsk: "0.80",
      },
    ];
    expect(quoteAtOrBefore(crossed, decisionMs)).toBeNull();
  });
});

describe("z", () => {
  it("é ln(S_t/S0) sobre σ√k", () => {
    const z = zAt(Math.log(78_900 / 78_000), 5, 10);
    expect(z).not.toBeNull();
    expect(z ?? 0).toBeCloseTo(7.255784, 5);
  });

  it("σ maior encolhe |z|: o filtro fica menos seletivo", () => {
    const tight = zAt(Math.log(78_900 / 78_000), 5, 10) ?? 0;
    const loose = zAt(Math.log(78_900 / 78_000), 20, 10) ?? 0;
    expect(Math.abs(loose)).toBeLessThan(Math.abs(tight));
    expect(loose).toBeCloseTo(tight / 4, 6);
  });

  it("σ <= 0 ou k <= 0 é nulo, nunca infinito", () => {
    expect(zAt(0.01, 0, 10)).toBeNull();
    expect(zAt(0.01, 5, 0)).toBeNull();
  });
});

describe("σ realizado", () => {
  it("mede só entre baldes ADJACENTES", () => {
    // Dois trechos contínuos com um vão de 30 min entre eles. O retorno sobre
    // o vão é enorme e tem de ficar fora: incluí-lo infla σ na direção que
    // faria o filtro z parecer mais seletivo do que é.
    const first = feed(
      new Date("2026-09-09T01:00:00.000Z"),
      10,
      (i) => 78_000 + i,
    );
    const second = feed(
      new Date("2026-09-09T01:40:00.000Z"),
      10,
      (i) => 90_000 + i,
    );
    const withGap = realizedSigma("twap30", [...first, ...second]);
    const contiguous = realizedSigma("twap30", first);
    // 9 + 9 retornos adjacentes; o do vão não entra.
    expect(withGap.samples).toBe(18);
    expect(contiguous.samples).toBe(9);
    // Nenhum retorno de +15 % apareceu: σ segue na casa de poucos bps.
    expect(withGap.bpsPerMin).toBeLessThan(5);
  });

  it("uma série constante tem σ zero", () => {
    const flat = feed(OPEN, 30, () => 78_000);
    expect(realizedSigma("twap60", flat).bpsPerMin).toBe(0);
  });

  it("devolve zero, não NaN, com menos de dois retornos", () => {
    expect(realizedSigma("twap30", []).bpsPerMin).toBe(0);
    expect(
      realizedSigma(
        "twap30",
        feed(OPEN, 1, () => 1),
      ).samples,
    ).toBe(0);
  });

  it("mede o σ que a série realmente tem", () => {
    // Retornos alternando +10 e -10 bps: o desvio padrão fica em ~10 bps/min.
    const alternating: BacktestFeedPoint[] = [];
    let price = 78_000;
    for (let index = 0; index < 41; index += 1) {
      const next = price * (index % 2 === 0 ? 1.001 : 0.999);
      alternating.push({
        bucketStart: new Date(OPEN.getTime() + index * 60_000),
        open: price.toFixed(6),
        close: next.toFixed(6),
      });
      price = next;
    }
    const sigma = realizedSigma("twap30", alternating);
    expect(sigma.bpsPerMin).toBeGreaterThan(9);
    expect(sigma.bpsPerMin).toBeLessThan(11);
  });
});

describe("grade e execução", () => {
  it("cada mercado contribui no máximo uma observação por célula", () => {
    const report = runBacktest([market(), market({ conditionId: "0xoutro" })], {
      config: CONFIG,
      arms: ["A"],
      ks: [10],
    });
    for (const cell of report.cells) {
      expect(cell.n).toBeLessThanOrEqual(2);
    }
    const ids = report.observations
      .filter((o) => o.arm === "A" && o.k === 10)
      .map((o) => o.conditionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("o taker paga o ask e a fee assumida; o PnL é payout − entrada − fee", () => {
    const report = runBacktest([market()], {
      config: CONFIG,
      arms: ["A"],
      ks: [10],
    });
    const observation = report.observations.find((o) => o.arm === "A");
    expect(observation).toBeDefined();
    if (observation === undefined) {
      return;
    }
    // Favorito é o afirmativo (mid 0,85 contra 0,15); ask 0,86; venceu.
    expect(observation.entryPrice).toBeCloseTo(0.86, 6);
    expect(observation.feePerShare).toBeCloseTo(0.07 * 0.86 * 0.14, 9);
    expect(observation.payout).toBe(1);
    expect(observation.pnlPerShare).toBeCloseTo(
      1 - 0.86 - 0.07 * 0.86 * 0.14,
      9,
    );
  });

  it("o braço E paga um tick acima do ask", () => {
    const report = runBacktest([market()], {
      config: CONFIG,
      arms: ["E"],
      ks: [10],
    });
    const observation = report.observations.find((o) => o.arm === "E");
    expect(observation?.entryPrice).toBeCloseTo(0.87, 6);
  });

  it("o maker NÃO é preenchido quando o preço nunca vem até ele", () => {
    // Bid constante em 0,84 e ask sempre em 0,86: nada cruza para 0,84.
    const report = runBacktest([market()], {
      config: CONFIG,
      arms: ["C"],
      ks: [10],
    });
    const observation = report.observations.find((o) => o.arm === "C");
    expect(observation).toBeDefined();
    expect(observation?.filled).toBe(false);
    // E uma ordem não preenchida não é um trade de PnL zero: sai do IC.
    expect(report.cells.filter((cell) => cell.arm === "C")).toHaveLength(0);
  });

  it("o maker é preenchido quando o ask desce até o limite — e é aí que perde", () => {
    // O ask cai para 0,80 no minuto seguinte: a compra em 0,84 é preenchida
    // justamente porque o mercado virou contra ela. É a seleção adversa, e o
    // backtest tem de mostrá-la em vez de assumir preenchimento gratuito.
    const falling = market({
      affirmativeQuotes: quotes(
        OPEN,
        60,
        (i) => (i <= 50 ? 0.84 : 0.78),
        (i) => (i <= 50 ? 0.86 : 0.8),
      ),
      affirmativeWon: false,
    });
    const report = runBacktest([falling], {
      config: CONFIG,
      arms: ["C"],
      ks: [10],
    });
    const observation = report.observations.find((o) => o.arm === "C");
    expect(observation?.filled).toBe(true);
    expect(observation?.entryPrice).toBeCloseTo(0.84, 6);
    // Perdeu o mercado: PnL = 0 − 0,84 − 0 (maker não paga fee).
    expect(observation?.feePerShare).toBe(0);
    expect(observation?.pnlPerShare).toBeCloseTo(-0.84, 6);
  });

  it("o IC95 é reproduzível: a mesma entrada dá o mesmo intervalo", () => {
    const markets = Array.from({ length: 30 }, (_unused, index) =>
      market({
        conditionId: `0x${String(index)}`,
        affirmativeWon: index % 2 === 0,
      }),
    );
    const first = runBacktest(markets, {
      config: CONFIG,
      arms: ["A"],
      ks: [10],
    });
    const second = runBacktest(markets, {
      config: CONFIG,
      arms: ["A"],
      ks: [10],
    });
    expect(second.cells).toEqual(first.cells);
    const cell = first.cells[0];
    expect(cell).toBeDefined();
    if (cell === undefined) {
      return;
    }
    expect(cell.n).toBe(30);
    expect(cell.ciLow).toBeLessThan(cell.meanPnlPerShare);
    expect(cell.ciHigh).toBeGreaterThan(cell.meanPnlPerShare);
  });

  it("o filtro |z| da config descarta o instante e diz por quê", () => {
    // Preço praticamente parado: |z| fica abaixo do 1,5 do braço E.
    const flat = market({
      twap30: feed(new Date(OPEN.getTime() - 5 * 60_000), 70, () => 78_000),
      twap60: feed(new Date(OPEN.getTime() - 5 * 60_000), 70, () => 78_000),
    });
    const report = runBacktest([flat], {
      config: CONFIG,
      arms: ["E"],
      ks: [10],
    });
    expect(report.observations).toHaveLength(0);
    expect(report.skipped["Z_BELOW"]).toBe(1);
  });

  it("sem S0 o mercado inteiro sai, e a contagem diz isso", () => {
    const noS0 = market({ twap60: [] });
    const report = runBacktest([noS0], {
      config: CONFIG,
      arms: ["A"],
      ks: [10],
    });
    expect(report.marketsWithS0).toBe(0);
    expect(report.skipped["NO_S0"]).toBe(1);
    expect(report.cells).toHaveLength(0);
  });

  it("um instante antes da abertura da janela não é medido", () => {
    const report = runBacktest([market()], {
      config: CONFIG,
      arms: ["A"],
      ks: [61],
    });
    expect(report.skipped["BEFORE_OPEN"]).toBe(1);
  });

  it("o braço D sorteia o lado sem olhar o sinal", () => {
    // Dois mercados idênticos exceto o condition_id: o sorteio pode escolher
    // lados diferentes, e nenhum dos dois depende do movimento do preço.
    const lados = new Set<boolean>();
    for (let index = 0; index < 40; index += 1) {
      const report = runBacktest(
        [market({ conditionId: `0xd-${String(index)}` })],
        {
          config: CONFIG,
          arms: ["D"],
          ks: [10],
        },
      );
      const observation = report.observations.find((o) => o.arm === "D");
      if (observation !== undefined) {
        lados.add(observation.entryPrice > 0.5);
      }
    }
    expect(lados.size).toBe(2);
  });
});

describe("a grade de bandas cobre os dois lados", () => {
  it("nenhuma entrada plausível cai fora de todas as bandas", () => {
    // O braço D compra o azarão em metade dos mercados (~0,16 nos horários
    // medidos). Uma grade que começasse em 0,50 apagaria essas observações
    // como "fora de banda" e o CONTROLE perderia metade da amostra em
    // silêncio. Este teste é o que reprova essa grade.
    for (const price of [
      0.02, 0.05, 0.16, 0.3, 0.45, 0.5, 0.75, 0.86, 0.93, 0.99,
    ]) {
      const covering = BANDS.filter(
        (band) => price >= band.low && price < band.high,
      );
      expect(covering).toHaveLength(1);
    }
  });

  it("as bandas não se sobrepõem e são contíguas", () => {
    for (let index = 1; index < BANDS.length; index += 1) {
      expect(BANDS[index]?.low).toBe(BANDS[index - 1]?.high);
    }
  });

  it("o braço D rende observação nos DOIS lados do mercado", () => {
    const lados = new Set<boolean>();
    for (let index = 0; index < 40; index += 1) {
      const report = runBacktest(
        [market({ conditionId: `0xlado-${String(index)}` })],
        { config: CONFIG, arms: ["D"], ks: [10] },
      );
      const observation = report.observations.find((o) => o.arm === "D");
      if (observation !== undefined) {
        lados.add(observation.entryPrice > 0.5);
      }
    }
    expect(lados.size).toBe(2);
  });
});

describe("reversão de z", () => {
  it("uma série monotônica não reverte", () => {
    const stats = reversalStats([market()], [10], 5);
    expect(stats[0]?.instants).toBe(1);
    expect(stats[0]?.reversals).toBe(0);
    expect(stats[0]?.rate).toBe(0);
  });

  it("uma série que cruza S0 reverte", () => {
    // O preço sobe acima de S0 e volta a cair abaixo dele nos minutos que
    // antecedem a decisão: o sinal de z troca.
    // O índice 5 é o balde da abertura, logo S0 = 78 000. A decisão em k = 10
    // lê o balde 01:49 (índice 54); a troca de sinal tem de cair DENTRO dos
    // três baldes que a reversão olha, e não dez minutos antes deles.
    const crossing = market({
      twap30: feed(new Date(OPEN.getTime() - 5 * 60_000), 70, (i) =>
        i < 55 ? 78_200 : 77_800,
      ),
    });
    const stats = reversalStats([crossing], [10], 5);
    expect(stats[0]?.instants).toBe(1);
    expect(stats[0]?.reversals).toBe(1);
    expect(stats[0]?.rate).toBe(1);
  });

  it("sem instante mensurável a taxa é zero, não NaN", () => {
    const stats = reversalStats([market({ twap60: [] })], [10], 5);
    expect(stats[0]?.instants).toBe(0);
    expect(stats[0]?.rate).toBe(0);
  });
});
