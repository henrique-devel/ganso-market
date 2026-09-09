// RFC-027 D5/D6: o que a tela Sistema mostra.
//
// Os aceites 3 e 5 são sobre TEXTO: cada gate tem de dizer a natureza do seu
// bloqueio (e o G5, a data), e nenhum JSON cru pode estar visível com o modo
// engenheiro desligado.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Limites, QualidadeDeDados, Semaforos } from "../src/Sistema.tsx";
import { ModoEngenheiroProvider } from "../src/modo.tsx";
import type { DataQuality, Overview } from "../src/overview.js";
import type { PortfolioLimits } from "../src/portfolio.js";

function texto(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

function render(node: React.ReactElement, engenheiro = false): string {
  return renderToStaticMarkup(
    <ModoEngenheiroProvider ligado={engenheiro}>{node}</ModoEngenheiroProvider>,
  );
}

const AGORA = "2026-09-09T02:00:00.000Z";

function overview(patch: Partial<Overview>): Overview {
  return {
    generated_at: AGORA,
    release_sha: null,
    portfolio: null,
    circuit_breakers: { open: 0, opened_last_hour: 0, most_recent_at: null },
    kill_switch: null,
    rfc_009_status: "BLOCKED",
    gates: [],
    collection: {
      last_book_delta_at: null,
      last_book_delta_age_ms: null,
      open_gaps: 0,
      gaps_24h: 0,
      universe_members: 0,
    },
    model: {
      estimates_last_hour: 0,
      last_estimate_at: null,
      active_models: 0,
      shadow_models: 0,
    },
    resolution: {
      markets: 0,
      blocked: 0,
      buffered: 0,
      open_violations: 0,
      open_divergences: 0,
    },
    paper: { open_orders: 0, positions: 0, fills_24h: 0 },
    storage: {
      budget_bytes: 0,
      live_bytes: 0,
      physical_bytes: 0,
      bloat_bytes: 0,
      budget_used_pct: null,
    },
    drawdown_limit: 0.1,
    funnel_24h: null,
    last_cycle: null,
    near_misses_24h: [],
    ...patch,
  };
}

describe("Semaforos (RFC-027 D6)", () => {
  it("pinta cada fonte pela idade dela", () => {
    const html = render(
      <Semaforos
        overview={overview({
          collection: {
            last_book_delta_at: null,
            last_book_delta_age_ms: 7_000,
            open_gaps: 0,
            gaps_24h: 0,
            universe_members: 0,
          },
          model: {
            estimates_last_hour: 0,
            // 4 minutos atrás: âmbar.
            last_estimate_at: "2026-09-09T01:56:00.000Z",
            active_models: 0,
            shadow_models: 0,
          },
        })}
      />,
    );
    expect(html).toContain('data-tom="ok"');
    expect(html).toContain('data-tom="atencao"');
    // Sem idade publicada: cinza e dito.
    expect(html).toContain('data-tom="neutro"');
    expect(texto(html)).toContain("não medido no painel");
  });

  it("avisa que um disjuntor velho é bom, em vez de deixar ler como defeito", () => {
    const visivel = texto(render(<Semaforos overview={overview({})} />));
    expect(visivel).toContain("aqui, velho é bom");
  });
});

describe("QualidadeDeDados (RFC-027 D6)", () => {
  const qualidade: DataQuality = {
    generated_at: AGORA,
    gaps_24h: [{ source: "book", count: 2, total_duration_ms: 45_000 }],
    ingest_lag_ms_last_hour: { p50: 120, p99: 890 },
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
      budget_bytes: 118_111_600_640,
      total_bytes: 42_000_000_000,
      budget_used_pct: 35.56,
      tables: [
        {
          table_name: "polymarket_book_deltas",
          live_bytes: 50 * 1024 ** 3,
          physical_bytes: 52 * 1024 ** 3,
          quota_bytes: 52 * 1024 ** 3,
          protected: false,
        },
        {
          table_name: "portfolio_decision_hourly",
          live_bytes: 1_000,
          physical_bytes: 2_000,
          quota_bytes: 5_368_709,
          protected: true,
        },
      ],
    },
  };

  it("mostra lacunas, lag e quota por tabela", () => {
    const visivel = texto(render(<QualidadeDeDados qualidade={qualidade} />));
    expect(visivel).toContain("book");
    expect(visivel).toContain("45,0 s sem dado no total");
    expect(visivel).toContain("120 ms");
    expect(visivel).toContain("890 ms");
    expect(visivel).toContain("polymarket_book_deltas");
    expect(visivel).toContain("protegida");
  });

  it("exibe a cobertura da RFC-024 sem recalcular, e o dia degenerado como '—'", () => {
    const visivel = texto(render(<QualidadeDeDados qualidade={qualidade} />));
    expect(visivel).toContain("95.8 %");
    expect(visivel).toContain("73 min");
    // O dia sem mercados emitidos: nunca 100 %, nunca 0 como lead.
    expect(visivel).not.toContain("100 % 100 %");
    expect(visivel).toContain("2026-09-09 0");
  });

  it("não mostra JSON cru fora do modo engenheiro", () => {
    const html = render(<QualidadeDeDados qualidade={qualidade} />);
    expect(html).not.toContain("<pre>");
    expect(html).not.toContain("{&quot;");
  });

  it("diz 'não lido' em vez de desenhar zeros", () => {
    const visivel = texto(render(<QualidadeDeDados qualidade={null} />));
    expect(visivel).toContain("Não lido nesta tentativa");
    expect(visivel).not.toContain("0 %");
  });
});

describe("Limites (RFC-027 D6)", () => {
  const limites: PortfolioLimits = {
    caps: [
      {
        dimension: "market",
        dimension_key: "0xa",
        worst_case_usd: "40.000000",
        cap_usd: "50.000000",
        utilization: 0.8,
      },
    ],
    bindingConstraints24h: [
      { binding_constraint: "CAP_MERCADO", decisions: 900 },
      { binding_constraint: "KELLY_CAP", decisions: 100 },
    ],
    config: {
      config_version: "1.2.0",
      edgeLiqMin: "0.02",
      safetyMarginMin: "0.005",
      bookMaxAgeMs: 60_000,
      estimateMaxAgeMs: 3_600_000,
    },
  };

  it("mostra os quatro números da config e o limitador dominante", () => {
    const visivel = texto(render(<Limites limites={limites} />));
    expect(visivel).toContain("1.2.0");
    expect(visivel).toContain("0.02");
    expect(visivel).toContain("cap do mercado");
    // 900 de 1000 decisões.
    expect(visivel).toContain("90,0 % das decisões");
    expect(visivel).toContain("900");
  });

  it("mostra os caps por dimensão, que não tinham tela", () => {
    const visivel = texto(render(<Limites limites={limites} />));
    expect(visivel).toContain("market");
    expect(visivel).toContain("80,0 %");
  });

  it("escreve 'config não medida' em vez de inventar um limite", () => {
    const visivel = texto(
      render(<Limites limites={{ ...limites, config: null }} />),
    );
    expect(visivel).toContain("Config não medida");
    expect(visivel).not.toContain("0.02");
  });
});

describe("aceite 5 — nenhum JSON cru fora do modo engenheiro", () => {
  it("mantém o JSON do detalhe do feed atrás do modo engenheiro", async () => {
    const { OverviewPanel } = await import("../src/Overview.tsx");
    const evento = {
      source: "estado",
      kind: "PORTFOLIO_STATE",
      event_id: 1,
      occurred_at: AGORA,
      severity: "alert" as const,
      summary: "NORMAL → HALTED",
      detail: {
        from_state: "NORMAL",
        to_state: "HALTED",
        reason: "drawdown",
        campo_do_futuro: "algo",
      },
    };
    const desligado = render(
      <OverviewPanel
        overview={overview({})}
        events={[evento]}
        feedDegraded={false}
      />,
    );
    // Sem modo engenheiro: texto, e nenhum JSON.
    expect(desligado).not.toContain("<pre>");
    expect(texto(desligado)).toContain("Parado");
    // O rótulo e o valor, um ao lado do outro. Os dois pontos vêm do CSS
    // (`.feed-campo-rot::after`), então não estão no DOM — asserta-se a
    // estrutura, não a pontuação.
    expect(desligado).toContain('<span class="feed-campo-rot">de</span>Normal');
    expect(desligado).toContain(
      '<span class="feed-campo-rot">para</span>Parado',
    );
    // A chave que ninguém traduziu é NOMEADA, não escondida.
    expect(texto(desligado)).toContain("+1 sem tradução");

    const ligado = render(
      <OverviewPanel
        overview={overview({})}
        events={[evento]}
        feedDegraded={false}
      />,
      true,
    );
    expect(ligado).toContain("<pre>");
    expect(ligado).toContain("campo_do_futuro");
  });
});
