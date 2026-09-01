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
  SITUACAO_GATE,
  consequencia,
  rotulo,
  tom,
  verbete,
} from "../src/dicionario.js";

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
