// RFC-028, "Testes obrigatórios" > Parser de `fast.json`: campo faltante, banda
// invertida, σ <= 0, `mode` desconhecido => recusa NOMEADA; hash estável.
//
// E a diferença que a D7 exige em relação a `portfolio/config.ts`: aqui não
// existe default. Arquivo ausente é erro, não configuração implícita.

import { describe, expect, it } from "vitest";

import {
  FAST_ARMS,
  FAST_CONFIG_FILE_ENV,
  FastConfigError,
  fastConfigHash,
  loadFastConfig,
  parseFastConfig,
  type FastConfig,
} from "../../../src/polymarket/paper/fastconfig.js";

/** A 0.1.0 congelada, exatamente como o arquivo commitado a declara. */
const FROZEN: unknown = {
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
};

/** Uma cópia mutável do congelado, para quebrar um campo por vez. */
function frozen(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(FROZEN)) as Record<string, unknown>;
}

function expectRejection(raw: unknown, reasonCode: string): void {
  try {
    parseFastConfig(raw);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(FastConfigError);
    expect((error as FastConfigError).reasonCode).toBe(reasonCode);
    // A recusa é NOMEADA: a mensagem diz qual campo, não só que algo falhou.
    expect((error as FastConfigError).message.length).toBeGreaterThan(0);
    return;
  }
  throw new Error(`expected ${reasonCode}, but the config parsed`);
}

describe("parser da 0.1.0", () => {
  it("aceita a versão congelada e devolve os parâmetros da D4-D6", () => {
    const config = parseFastConfig(FROZEN);
    expect(config.version).toBe("0.1.0");
    expect(config.signal.sigmaBpsPerMin).toBe("5");
    expect(config.costs.assumedTakerFeeRate).toBe("0.07");
    expect(config.ticket.shares).toBe("5");
    // D8: todos os braços em sombra na 0.1.0. Sair da sombra é versão nova.
    for (const arm of FAST_ARMS) {
      expect(config.arms[arm].mode).toBe("shadow");
    }
  });

  it("dinheiro e preço são texto decimal, nunca number", () => {
    const config = parseFastConfig(FROZEN);
    const decimals = [
      config.limits.dailyStopUsdPerArm,
      config.limits.dailyStopUsdSubAccount,
      config.limits.subAccountBankrollUsd,
      config.ticket.shares,
      config.arms.C.bandLow,
      config.arms.E.bandHigh,
      config.costs.assumedTakerFeeRate,
      config.preconditions.bookMaxSpread,
    ];
    for (const value of decimals) {
      expect(typeof value).toBe("string");
    }
  });

  it("recusa um número onde a config exige texto decimal", () => {
    const raw = frozen();
    (raw["costs"] as Record<string, unknown>)["assumedTakerFeeRate"] = 0.07;
    expectRejection(raw, "FAST_CONFIG_INVALID");
  });
});

describe("campo faltante", () => {
  it("recusa a ausência de um parâmetro escalar", () => {
    const raw = frozen();
    delete (raw["preconditions"] as Record<string, unknown>)["bookMaxAgeS"];
    expectRejection(raw, "FAST_CONFIG_MISSING");
  });

  it("recusa a ausência de um braço inteiro", () => {
    const raw = frozen();
    delete (raw["arms"] as Record<string, unknown>)["D"];
    expectRejection(raw, "FAST_CONFIG_MISSING");
  });

  it("recusa a ausência de uma seção inteira", () => {
    const raw = frozen();
    delete raw["criteria"];
    expectRejection(raw, "FAST_CONFIG_INVALID");
  });

  it("recusa uma chave desconhecida em vez de ignorá-la", () => {
    const raw = frozen();
    (raw["signal"] as Record<string, unknown>)["sigmaBpsPerHour"] = "3";
    expectRejection(raw, "FAST_CONFIG_UNKNOWN_KEY");
  });
});

describe("banda invertida", () => {
  it("recusa bandLow >= bandHigh no braço C", () => {
    const raw = frozen();
    const arm = (raw["arms"] as Record<string, unknown>)["C"] as Record<
      string,
      unknown
    >;
    arm["bandLow"] = "0.95";
    expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
  });

  it("recusa bandLow >= bandHigh no braço E", () => {
    const raw = frozen();
    const arm = (raw["arms"] as Record<string, unknown>)["E"] as Record<
      string,
      unknown
    >;
    arm["bandHigh"] = "0.80";
    expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
  });

  it("recusa askLow >= askHigh nos braços tardios", () => {
    for (const arm of ["A", "D"]) {
      const raw = frozen();
      const target = (raw["arms"] as Record<string, unknown>)[arm] as Record<
        string,
        unknown
      >;
      target["askLow"] = "0.90";
      target["askHigh"] = "0.60";
      expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
    }
  });

  it("recusa kMin > kMax", () => {
    const raw = frozen();
    const arm = (raw["arms"] as Record<string, unknown>)["E"] as Record<
      string,
      unknown
    >;
    arm["kMin"] = 11;
    expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
  });

  it("recusa um GTD que sobreviveria à própria janela de entrada", () => {
    // gtdUntilK >= kMin: a ordem repousaria além do instante em que o braço C
    // deixa de querer estar no livro.
    const raw = frozen();
    const arm = (raw["arms"] as Record<string, unknown>)["C"] as Record<
      string,
      unknown
    >;
    arm["gtdUntilK"] = 8;
    expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
  });
});

describe("sigma", () => {
  it("recusa σ = 0", () => {
    const raw = frozen();
    (raw["signal"] as Record<string, unknown>)["sigmaBpsPerMin"] = "0";
    expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
  });

  it("recusa σ negativo", () => {
    const raw = frozen();
    (raw["signal"] as Record<string, unknown>)["sigmaBpsPerMin"] = "-5";
    expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
  });
});

describe("mode", () => {
  it("recusa um mode desconhecido", () => {
    const raw = frozen();
    const arm = (raw["arms"] as Record<string, unknown>)["A"] as Record<
      string,
      unknown
    >;
    arm["mode"] = "live";
    expectRejection(raw, "FAST_CONFIG_INVALID");
  });

  it("recusa mode ausente", () => {
    const raw = frozen();
    const arm = (raw["arms"] as Record<string, unknown>)["C"] as Record<
      string,
      unknown
    >;
    delete arm["mode"];
    expectRejection(raw, "FAST_CONFIG_MISSING");
  });
});

describe("universo", () => {
  it("recusa uma regex que não compila", () => {
    const raw = frozen();
    (raw["universe"] as Record<string, unknown>)["questionPattern"] = "^(BTC";
    expectRejection(raw, "FAST_CONFIG_INVALID");
  });

  it("recusa uma regex sem âncora, que aceitaria a série de 15 min", () => {
    // A `SHORT_SERIES_PATTERN` do registry é leniente e casaria
    // "... 5:00PM-5:15PM ET"; a D4 exige a estrita. Sem âncora nas duas
    // pontas, a config estaria declarando a leniente.
    const raw = frozen();
    (raw["universe"] as Record<string, unknown>)["questionPattern"] =
      "Bitcoin Up or Down - ";
    expectRejection(raw, "FAST_CONFIG_INVALID");
  });

  it("a regex congelada casa a série horária e rejeita as outras", () => {
    const config = parseFastConfig(FROZEN);
    const pattern = new RegExp(config.universe.questionPattern);
    expect(pattern.test("Bitcoin Up or Down - September 8, 9PM ET")).toBe(true);
    expect(pattern.test("Bitcoin Up or Down - September 9, 12AM ET")).toBe(
      true,
    );
    // As duas séries que existem em produção e que a D4 exclui.
    expect(
      pattern.test("Bitcoin Up or Down - August 28, 5:00PM-5:15PM ET"),
    ).toBe(false);
    expect(
      pattern.test("Bitcoin Up or Down - August 26, 12:00PM-4:00PM ET"),
    ).toBe(false);
    expect(pattern.test("Ethereum Up or Down - September 8, 9PM ET")).toBe(
      false,
    );
  });
});

describe("coerência entre limites", () => {
  it("recusa stop de braço acima do stop da sub-carteira", () => {
    const raw = frozen();
    (raw["limits"] as Record<string, unknown>)["dailyStopUsdPerArm"] = "25";
    expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
  });

  it("recusa promover com menos evidência do que pausar exigiria", () => {
    const raw = frozen();
    (raw["criteria"] as Record<string, unknown>)["promoteMinN"] = 10;
    expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
  });

  it("recusa um ticket de promoção abaixo do ticket corrente", () => {
    const raw = frozen();
    (raw["criteria"] as Record<string, unknown>)["promoteTicketShares"] = "2";
    expectRejection(raw, "FAST_CONFIG_OUT_OF_RANGE");
  });
});

describe("hash", () => {
  it("é estável sob reordenação de chaves e reformatação", () => {
    // Reordena TODAS as chaves, em toda a profundidade: o hash canoniza, então
    // um arquivo reindentado ou com as seções em outra ordem tem o mesmo hash.
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(reverseKeys);
      }
      if (typeof value === "object" && value !== null) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort().reverse()) {
          out[key] = reverseKeys((value as Record<string, unknown>)[key]);
        }
        return out;
      }
      return value;
    };
    const config = parseFastConfig(FROZEN);
    const reordered = parseFastConfig(reverseKeys(FROZEN));
    expect(fastConfigHash(reordered)).toBe(fastConfigHash(config));
    expect(fastConfigHash(config)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("muda quando QUALQUER parâmetro muda", () => {
    const base = parseFastConfig(FROZEN);
    const baseHash = fastConfigHash(base);
    const mutations: ReadonlyArray<(raw: Record<string, unknown>) => void> = [
      (raw) => {
        (raw["signal"] as Record<string, unknown>)["sigmaBpsPerMin"] = "6";
      },
      (raw) => {
        (raw["costs"] as Record<string, unknown>)["assumedTakerFeeRate"] =
          "0.08";
      },
      (raw) => {
        (
          (raw["arms"] as Record<string, unknown>)["C"] as Record<
            string,
            unknown
          >
        )["bandLow"] = "0.71";
      },
      (raw) => {
        (
          (raw["arms"] as Record<string, unknown>)["D"] as Record<
            string,
            unknown
          >
        )["seed"] = 1;
      },
      (raw) => {
        (raw["limits"] as Record<string, unknown>)["maxOrdersPerDay"] = 48;
      },
      (raw) => {
        (raw["criteria"] as Record<string, unknown>)["endAfterDays"] = 60;
      },
      (raw) => {
        raw["version"] = "0.1.1";
      },
    ];
    for (const mutate of mutations) {
      const raw = frozen();
      mutate(raw);
      expect(fastConfigHash(parseFastConfig(raw))).not.toBe(baseHash);
    }
  });

  it("o hash da 0.1.0 é o do arquivo commitado", async () => {
    // Amarra o teste ao arquivo que vai a produção: se alguém editar
    // `config/fast.json` sem mintar versão nova, este teste reprova — que é a
    // condição de parada "fast.json alterado depois de congelado".
    const fromFile = await loadFastConfig({
      env: { [FAST_CONFIG_FILE_ENV]: "../../config/fast.json" },
    });
    expect(fastConfigHash(fromFile)).toBe(
      fastConfigHash(parseFastConfig(FROZEN)),
    );
    expect(fromFile.version).toBe("0.1.0");
  });
});

describe("carga fail-closed: nunca um default", () => {
  it("env var ausente é erro nomeado, não configuração implícita", async () => {
    await expect(loadFastConfig({ env: {} })).rejects.toMatchObject({
      name: "FastConfigError",
      reasonCode: "FAST_CONFIG_FILE_UNSET",
    });
  });

  it("env var vazia é erro nomeado", async () => {
    await expect(
      loadFastConfig({ env: { [FAST_CONFIG_FILE_ENV]: "" } }),
    ).rejects.toMatchObject({ reasonCode: "FAST_CONFIG_FILE_UNSET" });
  });

  it("arquivo ilegível é erro nomeado", async () => {
    await expect(
      loadFastConfig({
        env: { [FAST_CONFIG_FILE_ENV]: "/etc/ganso/nao-existe.json" },
      }),
    ).rejects.toMatchObject({ reasonCode: "FAST_CONFIG_FILE_UNREADABLE" });
  });

  it("JSON inválido é erro nomeado", async () => {
    await expect(
      loadFastConfig({
        env: { [FAST_CONFIG_FILE_ENV]: "/qualquer" },
        readTextFile: () => Promise.resolve("{"),
      }),
    ).rejects.toMatchObject({ reasonCode: "FAST_CONFIG_FILE_INVALID_JSON" });
  });

  it("um JSON válido mas com campo faltante ainda é recusa, não default", async () => {
    const raw = frozen();
    delete raw["ticket"];
    await expect(
      loadFastConfig({
        env: { [FAST_CONFIG_FILE_ENV]: "/qualquer" },
        readTextFile: () => Promise.resolve(JSON.stringify(raw)),
      }),
    ).rejects.toBeInstanceOf(FastConfigError);
  });
});

describe("tipo", () => {
  it("a config parseada é o tipo que a policy consome", () => {
    const config: FastConfig = parseFastConfig(FROZEN);
    expect(config.arms.E.reversalBuckets).toBe(3);
    expect(config.arms.C.gtdUntilK).toBe(4);
  });
});
