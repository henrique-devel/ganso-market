// RFC-026 PR 1: o que a Mesa mostra, e o que ela deliberadamente NÃO mostra.
//
// Os dois aceites que este arquivo cobre (A3 e A4) são sobre TEXTO RENDERIZADO,
// não sobre dado: o nome do mercado tem de estar em toda linha, e o código
// bruto NÃO pode estar no texto com o modo engenheiro desligado. `title` e o
// modo engenheiro seguem carregando o código — o invariante do `dicionario.ts`
// continua valendo.
//
// `texto()` tira as tags e deixa só o que um olho lê. É o que separa "o hash
// está no title" de "o hash está na tela".

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ESTADO_PORTFOLIO } from "../src/dicionario.js";
import { AgoraBloco, MesaView, escada, frasesAgora } from "../src/Mesa.tsx";
import { Badge } from "../src/Overview.tsx";
import { ModoEngenheiroProvider } from "../src/modo.tsx";
import type { Decision, LimitsConfig, Opportunity } from "../src/portfolio.js";
import type { Overview } from "../src/overview.js";

import painelDezNiveis from "./fixtures/painel-10-niveis.json" with { type: "json" };

/** Só o texto: nada de atributo, nada de tag. */
function texto(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

const HASH = "0x9c8a1f2e3d4b5a6978";

const CONFIG: LimitsConfig = {
  config_version: "1.2.0",
  edgeLiqMin: "0.02",
  safetyMarginMin: "0.01",
  bookMaxAgeMs: 30000,
  estimateMaxAgeMs: 300000,
};

const PAINEL = painelDezNiveis as {
  book: {
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
  };
  costs: { safety_margin: string | null };
  edge: { net: string | null };
};

function oportunidade(extra: Partial<Opportunity> = {}): Opportunity {
  return {
    condition_id: HASH,
    token_id: "t1",
    question: "Bitcoin acima de US$ 200 mil em 2026?",
    category: "crypto",
    computed_at: "2026-09-08T17:00:00.000Z",
    entrable: false,
    vetoed: false,
    veto_reason: null,
    config_version: "1.2.0",
    end_ts: "2026-09-09T00:00:00.000Z",
    panel: {
      market_bid: "0.056",
      market_ask: "0.059",
      microprice: "0.058454",
      q: "0.059003",
      q_lo: "0.040793",
      q_hi: "0.077214",
      estimate_source: "MARKET_BASELINE",
      suggested_side: "NO",
      spread: "0.003000",
      edge_gross: "0.000179",
      edge_net: "-0.016912",
      fee: "0.000000",
      slippage: "0.000000",
      capital: "0.000000",
      resolution_buffer: "0.000013",
      safety_margin: "0.010000",
      max_size_shares: null,
      binding_constraint: null,
      limiters: [],
      resolution_action: "NONE",
      p_5050: "0.000000",
      expected_lockup_s: 2280,
      entry_reason: "limite inferior não supera preço + custos + margem",
      invalidation_condition: null,
      book_age_ms: 905,
      estimate_age_ms: 140639,
      resolution_age_ms: 430093,
      worst_case: "perda total da posição",
      book_bids: PAINEL.book.bids,
      book_asks: PAINEL.book.asks,
      rule_excerpt: "This market will resolve to Yes if…",
      correlated_markets: [],
      best_case: "1.000000",
      likely_case: "0.886496",
      fifty_fifty_case: "0.000000",
    },
    ...extra,
  };
}

function decisao(extra: Partial<Decision> = {}): Decision {
  return {
    decision_id: 890828,
    decision_kind: "ENTRY",
    condition_id: HASH,
    token_id: "t1",
    question: "Bitcoin acima de US$ 200 mil em 2026?",
    category: "crypto",
    decision_ts: "2026-09-08T17:53:49.325Z",
    market_side: "NO",
    edge_net: -0.016912,
    size_shares: null,
    binding_constraint: null,
    outcome: "REJECTED",
    reason_code: "LOWER_BOUND_BELOW_COSTS",
    portfolio_state: "NORMAL",
    exec_price: "0.059000",
    paper_order_id: null,
    ...extra,
  };
}

function mesa(
  props: Partial<Parameters<typeof MesaView>[0]> = {},
  engenheiro = false,
): string {
  return renderToStaticMarkup(
    <ModoEngenheiroProvider ligado={engenheiro}>
      <MesaView
        opportunities={[oportunidade()]}
        decisoes={[decisao()]}
        config={CONFIG}
        comPosicao={new Set<string>()}
        overview={null}
        falhou={false}
        atualizadoEm={Date.now()}
        onRearmar={null}
        rearmando={false}
        erroRearme={null}
        {...props}
      />
    </ModoEngenheiroProvider>,
  );
}

describe("RFC-026 D10 — o sparkline na linha da Mesa", () => {
  const serie = [0, 1, 2].map((m) => ({
    bucket_start: new Date(
      Date.parse("2026-09-08T17:00:00Z") + m * 60_000,
    ).toISOString(),
    mid_open: "0.50",
    mid_high: "0.52",
    mid_low: "0.49",
    mid_close: `0.5${String(m)}`,
    updates_count: 4,
  }));

  it("desenha a série da linha quando o lote a trouxe", () => {
    const html = mesa({ series: new Map([["t1", serie]]) });

    expect(html).toContain("mesa-spark");
    expect(html).toContain("<polyline");
    // Direção em palavras, não só em cor (D3).
    expect(html).toContain("spark--alta");
  });

  it("um mercado sem série diz `sem série`, e não desenha linha no zero", () => {
    const html = mesa({ series: new Map([["t1", []]]) });

    expect(texto(html)).toContain("sem série");
    expect(html).not.toContain("<polyline");
  });

  it("sem lote nenhum, a coluna não afirma que não há série", () => {
    // O padrão do prop é um mapa vazio: nenhum token foi respondido ainda.
    const html = mesa();

    expect(html).toContain("mesa-spark");
    expect(texto(html)).not.toContain("sem série");
  });
});

describe("A3 — o nome do mercado em toda célula", () => {
  it("mostra o nome na lista e no detalhe", () => {
    const html = mesa();

    expect(texto(html)).toContain("Bitcoin acima de US$ 200 mil em 2026?");
  });

  it("mantém o hash no title, e fora do texto", () => {
    const html = mesa();

    expect(html).toContain(HASH);
    expect(texto(html)).not.toContain(HASH);
  });

  it("um mercado sem nome diz “sem nome”, e não fica em branco", () => {
    const html = mesa({
      opportunities: [oportunidade({ question: null, category: null })],
    });

    expect(texto(html)).toContain("sem nome");
    expect(texto(html)).not.toContain(HASH);
  });

  it("o modo engenheiro reimprime o hash no texto", () => {
    const html = mesa({}, true);

    expect(texto(html)).toContain(HASH);
  });
});

describe("A4 — nenhum código no texto com o modo engenheiro desligado", () => {
  it("o Badge imprime o rótulo e guarda o código", () => {
    const html = renderToStaticMarkup(
      <ModoEngenheiroProvider ligado={false}>
        <Badge codigo="NORMAL" dicionario={ESTADO_PORTFOLIO} />
      </ModoEngenheiroProvider>,
    );

    expect(texto(html)).toContain("Normal");
    // "Normal NORMAL" era o que a tela mostrava em nove lugares.
    expect(texto(html)).not.toContain("NORMAL");
    expect(html).toContain("NORMAL");
  });

  it("o modo engenheiro devolve o código ao texto", () => {
    const html = renderToStaticMarkup(
      <ModoEngenheiroProvider ligado>
        <Badge codigo="NORMAL" dicionario={ESTADO_PORTFOLIO} />
      </ModoEngenheiroProvider>,
    );

    expect(texto(html)).toContain("NORMAL");
  });

  it("a Mesa não imprime nenhum código de motivo cru", () => {
    const html = texto(mesa());

    expect(html).not.toContain("LOWER_BOUND_BELOW_COSTS");
    expect(html).not.toContain("MARKET_BASELINE");
    expect(html).toContain("baseline do mercado");
  });
});

describe("a folga na tela", () => {
  it("escreve quanto falta, não um zero", () => {
    expect(texto(mesa())).toContain("faltam 0.036912");
  });

  it("sem o bloco config a folga sai como não medido", () => {
    const html = texto(mesa({ config: null }));

    expect(html).toContain("não medido");
    expect(html).not.toContain("faltam 0.036912");
  });
});

describe("o livro L2", () => {
  it("mostra os dez níveis de cada lado e marca o preço da ordem", () => {
    const html = mesa();

    expect(html).toContain("Livro L2 · 10 bids / 10 asks");
    expect(html).toContain("preço da ordem sugerida");
  });
});

describe("a escada do motor", () => {
  it("marca o degrau em que o motor parou e não afirma nada depois dele", () => {
    const degraus = escada(
      oportunidade().panel,
      CONFIG,
      decisao({ reason_code: "LOWER_BOUND_BELOW_COSTS" }),
    );

    expect(degraus.map((degrau) => degrau.marca)).toEqual([
      "✓",
      "✓",
      "✓",
      "✓",
      "✗",
      "·",
      "·",
    ]);
    // Recusa por regra é cinza, não vermelha: é o normal do motor.
    expect(degraus[4]?.tom).toBe("regra");
    expect(degraus[5]?.valor).toBe("não avaliado");
  });

  it("livro velho é defeito de dado, e sai em vermelho", () => {
    const degraus = escada(
      oportunidade().panel,
      CONFIG,
      decisao({ reason_code: "BOOK_STALE" }),
    );

    expect(degraus[1]?.marca).toBe("✗");
    expect(degraus[1]?.tom).toBe("dado");
  });

  it("sem decisão do mercado na amostra, nenhum degrau se diz aprovado", () => {
    const degraus = escada(oportunidade().panel, CONFIG, null);

    expect(degraus.every((degrau) => degrau.marca === "·")).toBe(true);
  });
});

describe("D7 — o bloco de ação", () => {
  const overviewCom = (engatado: boolean): Overview =>
    ({
      kill_switch: {
        engaged: engatado,
        reason: "RECORDER_STALE",
        engaged_at: null,
        rearmed_at: null,
        frozen_count: null,
      },
    }) as Overview;

  it("cala quando nada exige ação", () => {
    const frases = frasesAgora(overviewCom(false), [decisao()]);

    expect(frases).toEqual([]);
    expect(
      texto(
        renderToStaticMarkup(
          <AgoraBloco
            frases={frases}
            onRearmar={null}
            rearmando={false}
            erroRearme={null}
          />,
        ),
      ),
    ).toContain("Nada exige ação agora");
  });

  it("recusa rotineira do motor não vira frase", () => {
    const rotina = Array.from({ length: 40 }, () =>
      decisao({ outcome: "REJECTED", reason_code: "LOWER_BOUND_BELOW_COSTS" }),
    );

    expect(frasesAgora(overviewCom(false), rotina)).toEqual([]);
  });

  it("kill switch engatado e aceite sem ordem viram frase", () => {
    const frases = frasesAgora(overviewCom(true), [
      decisao({ outcome: "ACCEPTED", reason_code: null, paper_order_id: null }),
      decisao({ outcome: "ACCEPTED", reason_code: null, paper_order_id: 7 }),
    ]);

    expect(frases).toHaveLength(2);
    expect(frases[0]?.texto).toContain("Kill switch ENGATADO");
    expect(frases[0]?.tom).toBe("alerta");
    expect(frases[1]?.texto).toContain("1 aceite(s) não viraram ordem paper");
  });

  it("oferece o rearme só com o switch engatado", () => {
    const html = renderToStaticMarkup(
      <AgoraBloco
        frases={frasesAgora(overviewCom(true), [])}
        onRearmar={() => undefined}
        rearmando={false}
        erroRearme={null}
      />,
    );

    expect(html).toContain("Rearmar o kill switch");

    const desarmado = renderToStaticMarkup(
      <AgoraBloco
        frases={frasesAgora(overviewCom(false), [])}
        onRearmar={() => undefined}
        rearmando={false}
        erroRearme={null}
      />,
    );

    expect(desarmado).not.toContain("Rearmar o kill switch");
  });
});
