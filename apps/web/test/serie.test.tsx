// RFC-026 D10 (PR 3): o que o gráfico desenha, e o que ele se recusa a desenhar.
//
// Os casos que importam aqui não são "a linha aparece". São os três em que um
// gráfico ingênuo mente:
//
//  - série vazia virando linha no zero ("o preço caiu a zero");
//  - lacuna virando reta ("o preço andou devagar entre as 3 h e as 7 h");
//  - livro congelado virando nada ("não há série" quando há, e ela é reta).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  GraficoSerie,
  Sparkline,
  direcao,
  marcas,
  pontos,
} from "../src/Serie.tsx";
import type { SeriesPoint } from "../src/portfolio.js";
import type { PaperPosition } from "../src/paper.js";

const T0 = Date.parse("2026-09-08T12:00:00.000Z");

function bucket(
  minuto: number,
  close: string | null,
  extra: Partial<SeriesPoint> = {},
): SeriesPoint {
  return {
    bucket_start: new Date(T0 + minuto * 60_000).toISOString(),
    mid_open: close,
    mid_high: close,
    mid_low: close,
    mid_close: close,
    updates_count: 3,
    ...extra,
  };
}

/** Só o texto: nada de atributo, nada de tag. */
function texto(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

describe("pontos", () => {
  it("descarta bucket sem mid_close em vez de tratá-lo como zero", () => {
    const pts = pontos([bucket(0, "0.50"), bucket(1, null), bucket(2, "0.52")]);
    expect(pts).toHaveLength(2);
    expect(pts.map((p) => p.close)).toEqual([0.5, 0.52]);
  });

  it("faz low/high caírem para o close quando a banda falta", () => {
    const pts = pontos([bucket(0, "0.50", { mid_low: null, mid_high: null })]);
    expect(pts[0]?.low).toBe(0.5);
    expect(pts[0]?.high).toBe(0.5);
  });
});

describe("direcao", () => {
  it("compara o primeiro com o último, e chama de estável o que não andou", () => {
    expect(direcao(pontos([bucket(0, "0.50"), bucket(1, "0.55")]))).toBe(
      "alta",
    );
    expect(direcao(pontos([bucket(0, "0.55"), bucket(1, "0.50")]))).toBe(
      "baixa",
    );
    expect(direcao(pontos([bucket(0, "0.50"), bucket(1, "0.50")]))).toBe(
      "estavel",
    );
  });
});

describe("Sparkline", () => {
  it("diz `sem série` em palavras e não desenha linha nenhuma", () => {
    const html = renderToStaticMarkup(
      <Sparkline serie={[]} nome="Mercado X" />,
    );
    expect(texto(html)).toContain("sem série");
    expect(html).not.toContain("<polyline");
    expect(html).not.toContain("<svg");
  });

  it("separa `ainda não sei` de `sem série`", () => {
    // Token ausente do lote: a resposta ainda não voltou. Escrever "sem série"
    // aqui afirmaria algo que não foi medido.
    const html = renderToStaticMarkup(
      <Sparkline serie={undefined} nome="Mercado X" />,
    );
    expect(texto(html)).not.toContain("sem série");
  });

  it("desenha o livro congelado como uma reta, e não o esconde", () => {
    const serie = [0, 1, 2, 3].map((m) => bucket(m, "0.50"));
    const html = renderToStaticMarkup(
      <Sparkline serie={serie} nome="Mercado X" />,
    );
    expect(html).toContain("<polyline");
    expect(html).toContain("spark--estavel");
    // Todos os y iguais: é uma reta, e ela está dentro da caixa e não colada
    // numa borda onde sumiria.
    const pontosDoSvg = /points="([^"]+)"/.exec(html)?.[1] ?? "";
    const ys = pontosDoSvg.split(" ").map((par) => Number(par.split(",")[1]));
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeGreaterThan(0);
    expect(ys[0]).toBeLessThan(22);
  });

  it("parte a linha na lacuna em vez de atravessá-la", () => {
    // Buckets em 0, 1 e depois 40: o buraco de 39 min não é uma tendência.
    const serie = [bucket(0, "0.50"), bucket(1, "0.51"), bucket(40, "0.70")];
    const html = renderToStaticMarkup(
      <Sparkline serie={serie} nome="Mercado X" />,
    );
    expect(html.match(/<polyline/g) ?? []).toHaveLength(1);
    // O trecho de um ponto só vira círculo, senão desapareceria.
    expect(html).toContain("<circle");
  });

  it("põe a direção em palavras, e não só na cor", () => {
    const serie = [bucket(0, "0.50"), bucket(1, "0.55")];
    const html = renderToStaticMarkup(
      <Sparkline serie={serie} nome="Mercado X" />,
    );
    expect(html).toContain("spark--alta");
    expect(html).toContain('aria-label="Mercado X: alta');
    expect(texto(html)).toContain("alta");
  });
});

describe("marcas", () => {
  const decisao = (extra: Record<string, unknown>) =>
    ({
      decision_id: 1,
      decision_kind: "ENTRY",
      condition_id: "0xc",
      token_id: "t1",
      question: null,
      category: null,
      decision_ts: new Date(T0 + 5 * 60_000).toISOString(),
      market_side: "NO",
      edge_net: null,
      size_shares: null,
      binding_constraint: null,
      outcome: "REJECTED",
      reason_code: null,
      portfolio_state: "NORMAL",
      exec_price: "0.51",
      paper_order_id: null,
      ...extra,
    }) as never;

  const posicao = (extra: Partial<PaperPosition> = {}): PaperPosition =>
    ({
      token_id: "t1",
      condition_id: "0xc",
      question: null,
      shares: "10",
      cost_usd: "5.10",
      realized_pnl_usd: null,
      fees_paid_usd: null,
      unrealized_pnl_usd: null,
      mark_value_usd: null,
      mark_stale: null,
      marked_at: null,
      opened_at: new Date(T0 + 7 * 60_000).toISOString(),
      current_lockup_s: null,
      end_ts: null,
      ...extra,
    }) as PaperPosition;

  it("marca aceite, ordem e posição aberta, e ignora outro mercado", () => {
    const resultado = marcas(
      "t1",
      [
        decisao({ outcome: "ACCEPTED" }),
        decisao({ outcome: "ACCEPTED", paper_order_id: 42 }),
        decisao({ outcome: "ACCEPTED", token_id: "OUTRO" }),
        decisao({ outcome: "REJECTED" }),
      ],
      [posicao(), posicao({ token_id: "OUTRO" })],
    );
    const tipos = resultado.map((m) => m.tipo).sort();
    // Dois aceites (um deles virou ordem, e por isso conta duas vezes) e um
    // fill. A recusa e o outro mercado não entram.
    expect(tipos).toEqual(["aceite", "aceite", "fill", "ordem"]);
    expect(resultado.find((m) => m.tipo === "ordem")?.texto).toBe("ordem 42");
  });

  it("não inventa preço para o fill", () => {
    // `opened_at` diz quando, `paper_positions` não diz a que preço aquele
    // instante caiu na escala. A marca vai para a base, não para uma altura
    // adivinhada.
    const resultado = marcas("t1", [], [posicao()]);
    expect(resultado[0]?.preco).toBeNull();
  });
});

describe("GraficoSerie", () => {
  const serie = [0, 1, 2, 3, 4].map((m) =>
    bucket(m, `0.5${String(m)}`, {
      mid_low: `0.4${String(m)}`,
      mid_high: `0.6${String(m)}`,
    }),
  );

  const grafico = (props: Partial<Parameters<typeof GraficoSerie>[0]> = {}) =>
    renderToStaticMarkup(
      <GraficoSerie
        serie={serie}
        carregando={false}
        nome="Mercado X"
        marcasDoMercado={[]}
        killSwitchEm={null}
        {...props}
      />,
    );

  it("escreve `sem série` sem desenhar eixo no zero", () => {
    const html = grafico({ serie: [] });
    expect(texto(html)).toContain("sem série");
    expect(html).not.toContain("<svg");
  });

  it("separa `ainda não perguntei` de `sem série`, com e sem carga", () => {
    const carregando = grafico({ serie: null, carregando: true });
    expect(texto(carregando)).toContain("carregando");
    expect(texto(carregando)).not.toContain("sem série");

    // Sem série pedida e sem carga em curso: continua sendo "não sei", e não
    // "não há". É o estado do detalhe antes de a leitura deliberada sair.
    const parado = grafico({ serie: null, carregando: false });
    expect(texto(parado)).not.toContain("sem série");
    expect(texto(parado)).toContain("ainda não carregada");
  });

  it("desenha a banda mid_low/mid_high além da linha", () => {
    const html = grafico();
    expect(html).toContain("serie-banda");
    expect(html).toContain("serie-linha");
  });

  it("põe as marcas com glifo e a legenda em palavras", () => {
    const html = grafico({
      marcasDoMercado: [
        { t: T0 + 60_000, preco: 0.51, tipo: "aceite", texto: "aceite" },
        { t: T0 + 120_000, preco: null, tipo: "fill", texto: "posição aberta" },
      ] as never,
    });
    expect(html).toContain("serie-marca--aceite");
    expect(html).toContain("serie-marca--fill");
    // Nunca só glifo: a legenda diz o que cada um é.
    expect(texto(html)).toContain("aceite");
    expect(texto(html)).toContain("posição aberta");
  });

  it("desenha o engate do kill switch dentro da janela, e só dentro dela", () => {
    const dentro = grafico({
      killSwitchEm: new Date(T0 + 2 * 60_000).toISOString(),
    });
    expect(dentro).toContain("serie-engate");
    expect(texto(dentro)).toContain("kill switch engatado");

    const fora = grafico({
      killSwitchEm: new Date(T0 - 86_400_000).toISOString(),
    });
    expect(fora).not.toContain("serie-engate");
  });

  it("diz que a reta é preço, e não falta de preço", () => {
    const congelada = [0, 1, 2].map((m) =>
      bucket(m, "0.50", { mid_low: "0.50", mid_high: "0.50" }),
    );
    const html = grafico({ serie: congelada });
    expect(html).toContain("serie-linha");
    expect(texto(html)).toContain("livro parado na janela");
  });
});
