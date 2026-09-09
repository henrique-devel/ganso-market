// RFC-015 clients for /overview, /events and /paper/performance.
//
// What can be silently wrong: a validator that turns a missing number into 0
// (the panel would claim a position is flat when it is unmarked), a cursor that
// is not sent (the feed would replay forever), and a parser that throws on one
// malformed row (one bad field would blank the whole page).

import { describe, expect, it, vi } from "vitest";

import {
  SEMAFORO_AMBAR_MS,
  SEMAFORO_VERDE_MS,
  fetchDataQuality,
  fetchEvents,
  fetchOverview,
  fetchPerformance,
  semaforo,
} from "../src/overview.js";
import {
  CHAVE_DETALHE,
  chavesDesconhecidas,
  traduzDetalhe,
} from "../src/dicionario.js";
// Explicit .tsx: on a case-insensitive filesystem "../src/Overview.js" would
// resolve to src/overview.ts, the client module next to it (same reason
// App.tsx spells its imports out).
import { precisaRecarregar } from "../src/Overview.tsx";
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

const OVERVIEW = {
  simulation: "SIMULAÇÃO — SEM EXECUÇÃO REAL",
  generated_at: "2026-09-01T17:00:00.000Z",
  release_sha: "5bb1caaa55aa2f044ded76618874aef0695f51d3",
  portfolio: {
    state: "NORMAL",
    reason: null,
    bankroll_usd: "1000.000000",
    high_water_mark_usd: "1001.465800",
    equity_usd: "998.791000",
    drawdown: "0.002670",
    realized_pnl_day_usd: "0.000000",
    realized_pnl_week_usd: "0.000000",
    manual_halt: false,
  },
  circuit_breakers: { open: 41, opened_last_hour: 88, most_recent_at: null },
  kill_switch: {
    engaged: false,
    reason: null,
    engaged_at: "2026-08-31T23:53:09Z",
    rearmed_at: "2026-09-01T01:46:56Z",
    frozen_count: 1,
  },
  rfc_009_status: "BLOCKED",
  gates: [
    {
      gate: "G1",
      status: "INSUFFICIENT_DATA",
      reason_code: "G1_CALIBRATION_NOT_MET",
      measured_at: "2026-09-01T16:27:18Z",
    },
  ],
  collection: {
    last_book_delta_at: "2026-09-01T16:59:52Z",
    last_book_delta_age_ms: 7278,
    open_gaps: 0,
    gaps_24h: 0,
    universe_members: 64,
  },
  model: {
    estimates_last_hour: 1233,
    last_estimate_at: "2026-09-01T16:59:39Z",
    active_models: 0,
    shadow_models: 2,
  },
  resolution: {
    markets: 750,
    blocked: 3,
    buffered: 12,
    open_violations: 0,
    open_divergences: 0,
  },
  paper: { open_orders: 0, positions: 2, fills_24h: 0 },
  storage: {
    budget_bytes: 118111600640,
    live_bytes: 42000000000,
    physical_bytes: 60000000000,
    bloat_bytes: 18000000000,
    budget_used_pct: 35.56,
  },
  limits: { drawdown_limit: 0.1 },
};

describe("fetchOverview", () => {
  it("parses the aggregate, converting numeric strings", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, OVERVIEW)),
    ) as unknown as ResolutionFetcher;
    const result = await fetchOverview("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.portfolio?.equity_usd).toBe(998.791);
    expect(result.value.portfolio?.drawdown).toBe(0.00267);
    expect(result.value.circuit_breakers.open).toBe(41);
    expect(result.value.kill_switch?.engaged).toBe(false);
    expect(result.value.gates).toHaveLength(1);
    expect(result.value.storage.budget_used_pct).toBe(35.56);
    expect(result.value.drawdown_limit).toBe(0.1);
    expect(result.value.release_sha).toBe(OVERVIEW.release_sha);
  });

  it("survives a body with the portfolio row missing", async () => {
    // The engine has not booted yet: no state row. The rest of the panel must
    // still render rather than the page going blank.
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { ...OVERVIEW, portfolio: null })),
    ) as unknown as ResolutionFetcher;
    const result = await fetchOverview("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.portfolio).toBeNull();
    expect(result.value.resolution.markets).toBe(750);
  });

  it("degrades every malformed section instead of throwing", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          portfolio: "not an object",
          gates: [{ status: "PASS" }, "junk", { gate: "G4" }],
          circuit_breakers: null,
          storage: [],
          limits: { drawdown_limit: "não é número" },
        }),
      ),
    ) as unknown as ResolutionFetcher;
    const result = await fetchOverview("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.portfolio).toBeNull();
    // The gate without a name is dropped; the one with a name survives.
    expect(result.value.gates.map((gate) => gate.gate)).toEqual(["G4"]);
    expect(result.value.circuit_breakers.open).toBe(0);
    expect(result.value.storage.live_bytes).toBe(0);
    // A malformed limit falls back to the RFC-013 threshold rather than to 0,
    // which would draw the drawdown bar as instantly full.
    expect(result.value.drawdown_limit).toBe(0.1);
  });

  it("reports a 401 as unauthorized so the session can refresh", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(401, {})),
    ) as unknown as ResolutionFetcher;
    expect((await fetchOverview("token", fetcher)).kind).toBe("unauthorized");
  });
});

describe("fetchEvents", () => {
  it("omits the cursor on a first load and sends it afterwards", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { events: [], page: { next_cursor: "estado:5" } }),
      ),
    ) as unknown as ResolutionFetcher & { mock: { calls: unknown[][] } };

    await fetchEvents("token", null, fetcher);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("/api/polymarket/events");

    await fetchEvents("token", "estado:5,decisao:9", fetcher);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "/api/polymarket/events?after=estado%3A5%2Cdecisao%3A9",
    );
  });

  it("parses events and drops rows without a source or an id", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          events: [
            {
              source: "estado",
              kind: "PORTFOLIO_STATE",
              event_id: 4,
              occurred_at: "2026-09-01T10:00:00Z",
              severity: "alert",
              summary: "NORMAL → HALTED",
              detail: { to_state: "HALTED" },
            },
            { kind: "SEM_FONTE", event_id: 5 },
            { source: "decisao" },
            "lixo",
          ],
          page: { next_cursor: "estado:4" },
        }),
      ),
    ) as unknown as ResolutionFetcher;
    const result = await fetchEvents("token", null, fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.events).toHaveLength(1);
    expect(result.value.events[0]?.severity).toBe("alert");
    expect(result.value.nextCursor).toBe("estado:4");
  });

  it("falls back to info for a severity it does not recognise", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          events: [{ source: "g2", event_id: 1, severity: "catastrofe" }],
          page: {},
        }),
      ),
    ) as unknown as ResolutionFetcher;
    const result = await fetchEvents("token", null, fetcher);
    if (result.kind !== "ok") {
      throw new Error("esperava ok");
    }
    expect(result.value.events[0]?.severity).toBe("info");
    expect(result.value.nextCursor).toBeNull();
  });
});

describe("fetchPerformance", () => {
  it("keeps an unrealised null as null, never as zero", async () => {
    // The report returns null when an open position has no executable mark.
    // Printing 0 would tell the operator there is no open risk.
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          columns: {
            optimistic_realized_usd: "1.500000",
            base_realized_usd: "-0.725400",
            base_unrealized_usd: null,
            base_net_usd: null,
            stress_realized_usd: "-1.100000",
            note: "optimistic is diagnostic only",
          },
          fees_paid_usd: "0.031000",
        }),
      ),
    ) as unknown as ResolutionFetcher;
    const result = await fetchPerformance("token", fetcher);
    if (result.kind !== "ok") {
      throw new Error("esperava ok");
    }
    expect(result.value.base_unrealized_usd).toBeNull();
    expect(result.value.base_net_usd).toBeNull();
    expect(result.value.base_realized_usd).toBe(-0.7254);
    expect(result.value.fees_paid_usd).toBe(0.031);
  });

  it("survives a body with no columns block", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { simulation: "…" })),
    ) as unknown as ResolutionFetcher;
    const result = await fetchPerformance("token", fetcher);
    if (result.kind !== "ok") {
      throw new Error("esperava ok");
    }
    expect(result.value.base_realized_usd).toBeNull();
  });
});

describe("precisaRecarregar", () => {
  // The lesson of 2026-08-31, as a unit. The rearm button "did not work" for
  // an hour because the SPA in memory was an old bundle; logging in inside the
  // app does not reload it and index.html is no-store, so one reload fixed it
  // and nothing on screen said so. This is the only carona whose entire value
  // is that it FIRES, so it gets a test that fails if it stops firing.
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  it("warns when the bundle and the API are on different revisions", () => {
    expect(precisaRecarregar(A, B)).toBe(true);
  });

  it("says nothing when they match", () => {
    expect(precisaRecarregar(A, A)).toBe(false);
  });

  it("says nothing when either side is unknown", () => {
    // A dev checkout leaves the release-sha placeholder literal, and an older
    // API does not report one at all. Warning in either case would train the
    // operator to ignore the warning.
    expect(precisaRecarregar("unknown", A)).toBe(false);
    expect(precisaRecarregar(A, "unknown")).toBe(false);
    expect(precisaRecarregar(A, null)).toBe(false);
    expect(precisaRecarregar("unknown", null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RFC-027 D1–D3: o funil, o último ciclo e o "Quase" no cliente
// ---------------------------------------------------------------------------

const FUNNEL_BODY = {
  ...OVERVIEW,
  funnel_24h: {
    source: "hourly",
    window_from: "2026-08-31T18:00:00.000Z",
    window_to: "2026-09-01T17:00:00.000Z",
    steps: [
      {
        outcome: "REJECTED",
        reason_code: "DATA_STALE",
        decisions: 9177,
        markets: 61,
      },
      {
        outcome: "REJECTED",
        reason_code: "EDGE_BELOW_MIN",
        decisions: 71,
        markets: 12,
      },
      { outcome: "ACCEPTED", reason_code: null, decisions: 74, markets: 30 },
    ],
  },
  last_cycle: {
    cycle_at: "2026-09-01T16:59:31.000Z",
    evaluated: 62,
    entrable: 0,
    decisions_written: 7,
    state: "NORMAL",
    positions: 2,
    open_breakers: 54,
    stale_marks: 1,
  },
  near_misses_24h: [
    {
      reason_code: "EDGE_BELOW_MIN",
      count: 71,
      folga_min: "-0.009962",
      folga_p50: null,
    },
  ],
};

describe("fetchOverview — funil das 24 h (RFC-027)", () => {
  it("lê os degraus, o último ciclo e o Quase", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, FUNNEL_BODY)),
    ) as unknown as ResolutionFetcher;
    const result = await fetchOverview("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.funnel_24h?.source).toBe("hourly");
    expect(result.value.funnel_24h?.steps).toHaveLength(3);
    expect(result.value.last_cycle?.open_breakers).toBe(54);
    // Folga em TEXTO: a tela formata centavos a partir dela e nunca faz
    // aritmética de dinheiro em float.
    expect(result.value.near_misses_24h[0]?.folga_min).toBe("-0.009962");
    expect(typeof result.value.near_misses_24h[0]?.folga_min).toBe("string");
    expect(result.value.near_misses_24h[0]?.folga_p50).toBeNull();
  });

  it("trata funnel_24h ausente e vazio como indisponível", async () => {
    for (const funnel of [
      undefined,
      null,
      // Um agregado que existe mas não tem degrau NÃO é um funil de zeros: é a
      // ausência de dado, e a tela precisa poder dizer isso.
      {
        source: "hourly",
        window_from: null,
        window_to: null,
        steps: [],
      },
    ]) {
      const fetcher = vi.fn(() =>
        Promise.resolve(jsonResponse(200, { ...OVERVIEW, funnel_24h: funnel })),
      ) as unknown as ResolutionFetcher;
      const result = await fetchOverview("token", fetcher);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") {
        return;
      }
      expect(result.value.funnel_24h).toBeNull();
    }
  });

  it("sobrevive a um corpo sem nenhum dos três blocos", async () => {
    // O código anterior ao PR 1 não publica nenhum deles. O painel novo contra
    // uma API antiga (a janela entre o CD e o rebuild) tem de renderizar, não
    // ficar em branco.
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, OVERVIEW)),
    ) as unknown as ResolutionFetcher;
    const result = await fetchOverview("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.funnel_24h).toBeNull();
    expect(result.value.last_cycle).toBeNull();
    expect(result.value.near_misses_24h).toEqual([]);
    expect(result.value.circuit_breakers.open).toBe(41);
  });
});

// ---------------------------------------------------------------------------
// RFC-027 D6: o detalhe do feed em texto, e os semáforos
// ---------------------------------------------------------------------------

describe("traduzDetalhe (RFC-027 D6)", () => {
  it("traduz a chave E o valor de um evento de estado", () => {
    // Traduzir só a chave deixaria "para: HALTED" — metade em português,
    // metade em código.
    const campos = traduzDetalhe({
      from_state: "NORMAL",
      to_state: "HALTED",
      reason: "drawdown",
      trigger_source: "automatic",
    });
    const porChave = new Map(campos.map((campo) => [campo.chave, campo]));
    expect(porChave.get("to_state")?.rotulo).toBe("para");
    expect(porChave.get("to_state")?.valor).toBe("Parado");
    expect(porChave.get("from_state")?.valor).toBe("Normal");
    // O código cru sobrevive no title: é a regra do dicionário.
    expect(porChave.get("to_state")?.titulo).toContain("HALTED");
    // Uma chave sem dicionário de valor passa o valor adiante como está.
    expect(porChave.get("reason")?.valor).toBe("drawdown");
  });

  it("traduz booleanos e números em vez de imprimir 'true'", () => {
    const campos = traduzDetalhe({
      position_held: true,
      suppressed: false,
      magnitude_bps: 43,
    });
    const porChave = new Map(campos.map((campo) => [campo.chave, campo]));
    expect(porChave.get("position_held")?.valor).toBe("sim");
    expect(porChave.get("suppressed")?.valor).toBe("não");
    expect(porChave.get("magnitude_bps")?.valor).toBe("43");
  });

  it("deixa a chave desconhecida para o modo engenheiro, sem quebrar", () => {
    // Uma fonte de evento nova. Ela não some da tela em silêncio: `traduzDetalhe`
    // a ignora e `chavesDesconhecidas` a nomeia, para que a tela mande ligar o
    // modo engenheiro.
    const detail = { to_state: "HALTED", campo_do_futuro: "algo" };
    expect(traduzDetalhe(detail).map((campo) => campo.chave)).toEqual([
      "to_state",
    ]);
    expect(chavesDesconhecidas(detail)).toEqual(["campo_do_futuro"]);
  });

  it("manda um valor aninhado para o modo engenheiro em vez de achatá-lo", () => {
    // Achatar um objeto numa linha reinventaria o JSON com menos informação.
    const detail = { reason: { motivo: "aninhado" } };
    expect(traduzDetalhe(detail)).toEqual([]);
    expect(chavesDesconhecidas(detail)).toEqual(["reason"]);
  });

  it("omite o que é nulo ou vazio, em vez de escrever '—' em toda linha", () => {
    expect(
      traduzDetalhe({ ended_at: null, order_id: "", kind: "PARAM_CHANGE" }),
    ).toHaveLength(1);
    expect(chavesDesconhecidas({ ended_at: null, order_id: "" })).toEqual([]);
  });

  it("cobre as chaves das oito fontes que o /events publica", () => {
    // Se uma fonte nova entrar em EVENT_SOURCES com uma chave nova, ela cai no
    // modo engenheiro — o que é o comportamento desejado — mas as que existem
    // hoje têm de estar traduzidas, ou o feed volta a ser JSON.
    for (const chave of [
      "from_state",
      "to_state",
      "reason",
      "trigger_source",
      "decision_kind",
      "condition_id",
      "token_id",
      "market_side",
      "size_shares",
      "edge_net",
      "outcome",
      "binding_constraint",
      "event_type",
      "order_id",
      "kind",
      "scope",
      "ended_at",
      "edge_key",
      "magnitude_bps",
      "magnitude",
      "suppressed",
      "direction",
      "position_held",
      "category",
      "previous_start",
      "new_start",
    ]) {
      expect(CHAVE_DETALHE[chave], chave).toBeTruthy();
    }
  });
});

describe("semaforo (RFC-027 D6)", () => {
  it("aplica os cortes de 60 s e 5 min nas bordas", () => {
    expect(semaforo(59_000)).toBe("ok");
    expect(semaforo(61_000)).toBe("atencao");
    expect(semaforo(301_000)).toBe("alerta");
    // Exatamente no corte: 60 s já é âmbar, 5 min já é vermelho. Um limite
    // aberto de um lado e fechado do outro é a única forma de não ter buraco.
    expect(semaforo(SEMAFORO_VERDE_MS)).toBe("atencao");
    expect(semaforo(SEMAFORO_AMBAR_MS)).toBe("alerta");
  });

  it("não pinta de verde o que não foi medido", () => {
    // O heartbeat por worker é fase 2. Até lá, "não sei" é cinza — nunca verde
    // por omissão.
    expect(semaforo(null)).toBe("neutro");
  });
});

describe("fetchDataQuality (RFC-027 D6)", () => {
  const BODY = {
    generated_at: "2026-09-09T02:00:00.000Z",
    gaps_24h: [{ source: "book", count: 2, total_duration_ms: 45000 }],
    ingest_lag_ms_last_hour: { p50: 120.5, p99: 890 },
    fast_coverage: {
      serie: "btc-up-or-down-hourly",
      dias: [
        {
          dia: "2026-09-08",
          emitidos: 24,
          com_livro_t15_pct: 95.8,
          catalogados_60min_pct: 100,
          lead_mediano_min: 73,
        },
        // O dia degenerado da RFC-024: sem mercados emitidos, tudo `null`.
        {
          dia: "2026-09-09",
          emitidos: 0,
          com_livro_t15_pct: null,
          catalogados_60min_pct: null,
          lead_mediano_min: null,
        },
      ],
      subscribe_book_missing_24h: { total: 1, abertas: 0 },
    },
    storage: {
      budget_bytes: 118111600640,
      total_bytes: 42000000000,
      budget_used_pct: 35.56,
      tables: [
        {
          table_name: "portfolio_decision_hourly",
          live_bytes: 1000,
          physical_bytes: 2000,
          quota_bytes: 5368709,
          protected: true,
        },
      ],
    },
  };

  it("lê lacunas, lag, quota por tabela e a cobertura já calculada", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, BODY)),
    ) as unknown as ResolutionFetcher;
    const result = await fetchDataQuality("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.gaps_24h[0]?.total_duration_ms).toBe(45000);
    expect(result.value.ingest_lag_ms_last_hour.p99).toBe(890);
    expect(result.value.storage.tables[0]?.protected).toBe(true);
    // A cobertura vem PRONTA da RFC-024; o cliente exibe e não recalcula.
    expect(result.value.fast_coverage?.dias[0]?.com_livro_t15_pct).toBe(95.8);
    // O dia degenerado continua `null` — 0/0 publicado como 100 % é a falha
    // que aquele guarda existe para impedir, e o cliente não a reintroduz.
    expect(result.value.fast_coverage?.dias[1]?.com_livro_t15_pct).toBeNull();
    expect(result.value.fast_coverage?.dias[1]?.emitidos).toBe(0);
  });

  it("bate na rota que já estava publicada, sem location nova", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, BODY)),
    ) as unknown as ResolutionFetcher;
    await fetchDataQuality("token", fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/polymarket/data-quality",
      expect.anything(),
    );
  });

  it("sobrevive a uma resposta sem cobertura", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { ...BODY, fast_coverage: undefined })),
    ) as unknown as ResolutionFetcher;
    const result = await fetchDataQuality("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.fast_coverage).toBeNull();
    expect(result.value.storage.total_bytes).toBe(42000000000);
  });
});
