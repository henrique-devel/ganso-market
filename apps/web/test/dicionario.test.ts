// RFC-015 dictionary.
//
// What can be silently wrong here is not the translation — a wrong label is
// visible. It is the FALLBACK: a dictionary that answers "Desconhecido" for a
// code it has never seen hides exactly the codes someone needs to notice, and
// it hides them behind a word that looks like an answer.

import { describe, expect, it } from "vitest";

import {
  ACAO_RESOLUCAO,
  CATEGORIA,
  ESTADO_PORTFOLIO,
  MOTIVO_DECISAO,
  NATUREZA_BLOQUEIO,
  SITUACAO_GATE,
  consequencia,
  dataDoRelogio,
  naturezaDoBloqueio,
  progressoDoGate,
  rotulo,
  tom,
  verbete,
  type RelogioG2,
} from "../src/dicionario.js";

import gatesFixture from "./fixtures/gates-2026-09-09.json" with { type: "json" };

describe("verbete", () => {
  it("finds a code in its own dictionary", () => {
    expect(verbete("HALTED", ESTADO_PORTFOLIO)?.rotulo).toBe("Parado");
  });

  it("finds a code without being told which dictionary", () => {
    expect(verbete("INSUFFICIENT_DATA")?.rotulo).toBe("Sem dado bastante");
    expect(verbete("BOOK_STALE")?.rotulo).toBe("livro velho");
  });

  it("returns null for a code it does not know", () => {
    // Null, not an invented label: the caller renders the raw code, so a code
    // this dictionary has never seen shows up as itself instead of hiding
    // behind a word that reads like an answer.
    expect(verbete("CODIGO_QUE_NAO_EXISTE")).toBeNull();
    expect(verbete(null)).toBeNull();
    expect(verbete(undefined)).toBeNull();
    expect(verbete("")).toBeNull();
  });

  it("prefers the dictionary it is given over the global search", () => {
    // VETO is both a resolution action and a decision kind, and the two mean
    // different things on screen.
    expect(verbete("VETO", ACAO_RESOLUCAO)?.rotulo).toBe("Vetado");
    expect(verbete("VETO", SITUACAO_GATE)).toBeNull();
  });
});

describe("rotulo", () => {
  it("falls back to the code itself, never to a placeholder", () => {
    expect(rotulo("UM_CODIGO_NOVO")).toBe("UM_CODIGO_NOVO");
  });

  it("renders an absent code as a dash", () => {
    expect(rotulo(null)).toBe("—");
    expect(rotulo("")).toBe("—");
  });

  it("translates the whole portfolio state machine", () => {
    expect(rotulo("NORMAL", ESTADO_PORTFOLIO)).toBe("Normal");
    expect(rotulo("REDUCE_ONLY", ESTADO_PORTFOLIO)).toBe("Só reduzir");
    expect(rotulo("HALTED", ESTADO_PORTFOLIO)).toBe("Parado");
  });
});

describe("consequencia", () => {
  it("says what the operator does about it, and keeps the code", () => {
    const texto = consequencia("HALTED", ESTADO_PORTFOLIO) ?? "";
    expect(texto.toLowerCase()).toContain("não sai sozinho");
    expect(texto).toContain("HALTED");
  });

  it("separates INSUFFICIENT_DATA from FAIL in words, not only in colour", () => {
    expect(
      (consequencia("INSUFFICIENT_DATA", SITUACAO_GATE) ?? "").toLowerCase(),
    ).toContain("não é o mesmo que reprovar");
    expect(consequencia("FAIL", SITUACAO_GATE)).toContain("não funcionou");
  });

  it("falls back to the bare code when there is nothing to add", () => {
    expect(consequencia("CODIGO_NOVO")).toBe("CODIGO_NOVO");
    expect(consequencia(null)).toBeUndefined();
  });
});

describe("categorias", () => {
  it("names the three live categories", () => {
    expect(rotulo("crypto", CATEGORIA)).toBe("Cripto");
    expect(rotulo("macro", CATEGORIA)).toBe("Macro");
    expect(rotulo("weather", CATEGORIA)).toBe("Clima (legado)");
  });

  it("explains the historical bucket instead of printing 'unknown'", () => {
    // The 308 terminals in this bucket all settled before the metadata history
    // began (2026-08-25 01:42:43Z, measured). Projecting today's category onto
    // them would be look-ahead, so the bucket is permanent by design — and the
    // label has to say so, because "unknown" reads as "we lost the data".
    expect(rotulo("unknown", CATEGORIA)).toBe(
      "Sem categoria (anterior a 25/08)",
    );
    expect(rotulo("unknown", CATEGORIA)).not.toContain("unknown");
    expect(consequencia("unknown", CATEGORIA)).toContain("look-ahead");
  });
});

describe("tom", () => {
  it("gives an unknown code the neutral tone", () => {
    // Neutral, not a guess: colouring a code nobody has classified would be
    // the panel making a judgement no one made.
    expect(tom("CODIGO_NOVO")).toBe("neutro");
  });

  it("marks the states that need action", () => {
    expect(tom("HALTED", ESTADO_PORTFOLIO)).toBe("alerta");
    expect(tom("REDUCE_ONLY", ESTADO_PORTFOLIO)).toBe("atencao");
    expect(tom("NORMAL", ESTADO_PORTFOLIO)).toBe("ok");
  });
});

describe("cobertura dos códigos que produção realmente emite", () => {
  // Measured in production on 2026-09-01, with their frequencies. A code that
  // falls out of the dictionary still renders (as itself), so this test is not
  // guarding a crash — it is guarding the claim "o painel está em português".
  it("translates every reason code in the decision log", () => {
    for (const code of [
      "PORTFOLIO_CIRCUIT_BREAKER",
      "BOOK_STALE",
      "DATA_STALE",
      "PRICE_OUT_OF_BAND",
      "LOWER_BOUND_BELOW_COSTS",
      "EDGE_BELOW_MIN",
      "HOLD_NO_EXIT_SIGNAL",
    ]) {
      expect(verbete(code, MOTIVO_DECISAO), code).not.toBeNull();
    }
  });

  it("translates every gate status and every resolution action", () => {
    for (const code of ["PASS", "FAIL", "INSUFFICIENT_DATA"]) {
      expect(verbete(code, SITUACAO_GATE), code).not.toBeNull();
    }
    for (const code of ["NONE", "BUFFER", "VETO", "CIRCUIT_BREAKER"]) {
      expect(verbete(code, ACAO_RESOLUCAO), code).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// RFC-027 D5: a natureza do bloqueio, contra o metrics_json real dos seis gates
//
// O fixture é uma captura de produção (2026-09-09), não um exemplo escrito à
// mão: é a única forma de o teste provar que a regra funciona sobre a forma que
// os gates REALMENTE publicam — `shortfalls` aninhado no G2, `evidence_base` no
// G3, chaves soltas no G4, e um G6 que não tem par tem/precisa nenhum.
// ---------------------------------------------------------------------------

interface GateFixture {
  readonly gate: string;
  readonly status: string;
  readonly reason_code: string;
  readonly metrics: Readonly<Record<string, unknown>>;
}

const GATES = gatesFixture as readonly GateFixture[];

/** O relógio real: as duas categorias, o mesmo `clock_start`. */
const RELOGIO: readonly RelogioG2[] = [
  {
    category: "crypto",
    clock_start: "2026-08-28T20:38:47.23+00:00",
    regime_fingerprint: "76ff8aa1e8",
    last_reset_reason: "regime_fingerprint_changed",
  },
  {
    category: "macro",
    clock_start: "2026-08-28T20:38:47.23+00:00",
    regime_fingerprint: "566b6047e3",
    last_reset_reason: "regime_fingerprint_changed",
  },
];

function gate(id: string): GateFixture {
  const encontrado = GATES.find((linha) => linha.gate === id);
  if (encontrado === undefined) {
    throw new Error(`fixture sem ${id}`);
  }
  return encontrado;
}

function natureza(id: string, relogio = RELOGIO): string | null {
  const linha = gate(id);
  return naturezaDoBloqueio(id, linha.status, linha.metrics, relogio);
}

describe("naturezaDoBloqueio (RFC-027 D5)", () => {
  it("dá quatro naturezas diferentes aos seis gates iguais na tela", () => {
    // Os seis estão em INSUFFICIENT_DATA e a tela mostrava "Sem dado bastante"
    // nos seis. Estas são as razões reais.
    expect(GATES.every((linha) => linha.status === "INSUFFICIENT_DATA")).toBe(
      true,
    );
    expect(natureza("G1")).toBe("DEPENDE_DE_MODELO");
    expect(natureza("G4")).toBe("DEFEITO");
    expect(natureza("G5")).toBe("RELOGIO");
    expect(natureza("G6")).toBe("DECISAO_PROPRIETARIO");
    // As quatro etiquetas existem no dicionário e cada uma diz o que fazer.
    for (const chave of [
      "DEPENDE_DE_MODELO",
      "DEFEITO",
      "RELOGIO",
      "DECISAO_PROPRIETARIO",
    ]) {
      expect(verbete(chave, NATUREZA_BLOQUEIO)?.rotulo).toBeTruthy();
      expect(consequencia(chave, NATUREZA_BLOQUEIO)).toContain(chave);
    }
  });

  it("mostra o G2 como 'acumulando' porque a liquidação passou a fechar posições", () => {
    // A RFC previu "travado por defeito" para o G2, medido em 02/09 com
    // `closed_positions = 0`. Em 09/09 são 8 — e a MESMA função devolve outra
    // etiqueta, sem uma linha de código nova. É o aceite 3, que trata isso como
    // aceite e não como falha.
    expect(
      (gate("G2").metrics.shortfalls as { closed_positions: { have: number } })
        .closed_positions.have,
    ).toBe(8);
    expect(natureza("G2")).toBe("ACUMULANDO");
    // O G3 herda a base de evidência do G2 e acompanha.
    expect(natureza("G3")).toBe("ACUMULANDO");
  });

  it("volta a 'travado por defeito' se as posições fechadas voltarem a zero", () => {
    // A regra é dado-dirigida nas DUAS direções. Mesmo gate, mesmo código, só
    // o número muda.
    const zerado = {
      ...gate("G2").metrics,
      closed_positions: 0,
      shortfalls: {
        ...(gate("G2").metrics.shortfalls as Record<string, unknown>),
        closed_positions: { have: 0, need: 100 },
      },
    };
    expect(naturezaDoBloqueio("G2", "INSUFFICIENT_DATA", zerado, RELOGIO)).toBe(
      "DEFEITO",
    );
  });

  it("diz 'relógio não iniciado' com g2_clock vazio, e nunca uma data inventada", () => {
    expect(natureza("G5", [])).toBe("RELOGIO_NAO_INICIADO");
    expect(dataDoRelogio(gate("G5").metrics, [])).toBeNull();
    // Com relógio: 28/08 20:38:47Z + 60 dias.
    expect(dataDoRelogio(gate("G5").metrics, RELOGIO)).toBe(
      "2026-10-27T20:38:47.230Z",
    );
  });

  it("não etiqueta um gate que passou", () => {
    expect(naturezaDoBloqueio("G2", "PASS", gate("G2").metrics, RELOGIO)).toBe(
      null,
    );
  });

  it("devolve null em vez de adivinhar quando não reconhece as chaves", () => {
    // Um gate futuro, com um metrics_json que esta regra nunca viu. Nada de
    // "Desconhecido": a tela mostra a situação e o código crus, que é a regra
    // deste módulo.
    expect(naturezaDoBloqueio("G7", "INSUFFICIENT_DATA", {}, RELOGIO)).toBe(
      null,
    );
  });
});

describe("progressoDoGate (RFC-027 D5)", () => {
  it("lê os pares tem/precisa que o G2 publica aninhados", () => {
    const pares = progressoDoGate("G2", gate("G2").metrics);
    const porChave = new Map(pares.map((par) => [par.chave, par]));
    expect(porChave.get("closed_positions")).toEqual({
      chave: "closed_positions",
      tem: 8,
      precisa: 100,
    });
    expect(porChave.get("distinct_markets")).toEqual({
      chave: "distinct_markets",
      tem: 8,
      precisa: 30,
    });
    expect(porChave.get("days")?.precisa).toBe(60);
  });

  it("acha a base de evidência do G3 dentro de evidence_base", () => {
    const pares = progressoDoGate("G3", gate("G3").metrics);
    expect(pares.find((par) => par.chave === "closed_positions")).toMatchObject(
      { tem: 8, precisa: 100 },
    );
  });

  it("lê os dois pares soltos do G4 contra o mesmo denominador", () => {
    const pares = progressoDoGate("G4", gate("G4").metrics);
    expect(pares).toEqual([
      { chave: "fee_samples", tem: 0, precisa: 100 },
      { chave: "slippage_samples", tem: 0, precisa: 100 },
    ]);
  });

  it("lê o par do G1 e não inventa barra para o G6", () => {
    expect(progressoDoGate("G1", gate("G1").metrics)).toEqual([
      { chave: "model_resolved_markets", tem: 0, precisa: 100 },
    ]);
    // O G6 não tem nada que conte: uma barra ali seria uma proporção
    // inventada.
    expect(progressoDoGate("G6", gate("G6").metrics)).toEqual([]);
  });

  it("descarta um par cujo denominador não existe", () => {
    // `have` sem `need` desenharia uma barra sem fim. Fica de fora.
    expect(progressoDoGate("G4", { fee_samples: 5 })).toEqual([]);
  });
});
