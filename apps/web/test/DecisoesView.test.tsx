// RFC-027 D1–D4: o que a tela Decisões mostra, e o que ela se recusa a mostrar.
//
// Estes testes afirmam sobre TEXTO RENDERIZADO, não sobre dado. É onde estão os
// aceites: a linha do funil (1), o "indisponível" em vez de barras (D1), a
// contagem regressiva com a janela do motor (D3) e a ausência de número de
// produção fixado (5).
//
// `texto()` tira as tags: é o que separa "está no title" de "está na tela".

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Congeladas,
  Funil,
  Quase,
  UltimoCiclo,
  centavos,
  duracao,
} from "../src/Decisoes.tsx";
import { ModoEngenheiroProvider } from "../src/modo.tsx";
import type { Overview } from "../src/overview.js";
import type { PortfolioLimits } from "../src/portfolio.js";

function texto(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

function render(node: React.ReactElement, engenheiro = false): string {
  return renderToStaticMarkup(
    <ModoEngenheiroProvider ligado={engenheiro}>{node}</ModoEngenheiroProvider>,
  );
}

/** O `Overview` mínimo: só o que estes quatro blocos leem. */
function overview(patch: Partial<Overview>): Overview {
  return {
    generated_at: "2026-09-01T17:00:00.000Z",
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
    paper: { open_orders: 3, positions: 2, fills_24h: 30 },
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

const FUNIL = {
  source: "hourly",
  window_from: "2026-08-31T18:00:00.000Z",
  window_to: "2026-09-01T17:00:00.000Z",
  steps: [
    {
      outcome: "REJECTED" as const,
      reason_code: "DATA_STALE",
      decisions: 9177,
      markets: 61,
    },
    {
      outcome: "REJECTED" as const,
      reason_code: "EDGE_BELOW_MIN",
      decisions: 71,
      markets: 12,
    },
    {
      outcome: "ACCEPTED" as const,
      reason_code: null,
      decisions: 74,
      markets: 30,
    },
  ],
};

describe("Funil (RFC-027 D1)", () => {
  it("escreve a linha do aceite 1 com os quatro degraus", () => {
    const html = render(<Funil overview={overview({ funnel_24h: FUNIL })} />);
    const visivel = texto(html);
    // 9177 + 71 + 74 = 9322 avaliadas; 74 aceitas; ordens e fills do ledger.
    expect(visivel).toContain("9.322");
    expect(visivel).toContain("avaliadas");
    expect(visivel).toContain("74");
    expect(visivel).toContain("aceitas");
    expect(visivel).toContain("ordens");
    expect(visivel).toContain("fills");
  });

  it("diz a janela que desenhou e a fonte, em vez de dizer '24 h'", () => {
    const visivel = texto(
      render(<Funil overview={overview({ funnel_24h: FUNIL })} />),
    );
    expect(visivel).toContain("2026-08-31 18:00:00Z");
    expect(visivel).toContain("2026-09-01 17:00:00Z");
    expect(visivel).toContain("agregado por hora");
    // O degrau do ledger tem população própria, e a tela o diz.
    expect(visivel).toContain("ledger");
  });

  it("desenha uma barra por recusa, e nenhuma pela aceitação", () => {
    const html = render(<Funil overview={overview({ funnel_24h: FUNIL })} />);
    // Duas recusas => duas barras. A aceitação é o resultado, não um degrau
    // de perda, e não recebe barra.
    expect(html.match(/class="bar"/g)).toHaveLength(2);
    // A maior recusa preenche a barra inteira; a escala é relativa a ela.
    expect(html).toContain("width:100%");
  });

  it("diz 'indisponível' e NÃO desenha barras sem agregado", () => {
    const html = render(<Funil overview={overview({ funnel_24h: null })} />);
    expect(texto(html)).toContain("Funil indisponível");
    expect(html).not.toContain('class="bar"');
    // A regra da D1, dita na própria tela: nunca um funil de amostra.
    expect(texto(html)).toContain("não desenha o funil sobre a amostra");
  });

  it("mostra a porcentagem calculada, sem nenhum número de produção fixado", () => {
    const visivel = texto(
      render(<Funil overview={overview({ funnel_24h: FUNIL })} />),
    );
    // 9177 / 9322 = 98,4 %. Calculado do fixture, não escrito no componente:
    // troque o fixture e o número muda.
    expect(visivel).toContain("98,4 %");
    expect(visivel).toContain("61 mercados no pico de uma hora");
  });
});

describe("UltimoCiclo (RFC-027 D2)", () => {
  const ciclo = {
    cycle_at: "2026-09-01T16:59:31.000Z",
    evaluated: 62,
    entrable: 0,
    decisions_written: 7,
    state: "NORMAL",
    positions: 2,
    open_breakers: 54,
    stale_marks: 1,
  };

  it("escreve a frase da D2 com os números do ciclo", () => {
    const visivel = texto(
      render(<UltimoCiclo overview={overview({ last_cycle: ciclo })} />),
    );
    expect(visivel).toContain("Nenhum mercado entrável agora");
    expect(visivel).toContain("62 avaliados");
    expect(visivel).toContain("54 sob disjuntor");
    expect(visivel).toContain("1 com marca velha");
    expect(visivel).toContain("2026-09-01 16:59:31Z");
  });

  it("omite os zeros em vez de escrever '0 sob disjuntor'", () => {
    const visivel = texto(
      render(
        <UltimoCiclo
          overview={overview({
            last_cycle: { ...ciclo, open_breakers: 0, stale_marks: 0 },
          })}
        />,
      ),
    );
    expect(visivel).not.toContain("sob disjuntor");
    expect(visivel).not.toContain("marca velha");
  });

  it("distingue 'ainda não medido' de 'nada entrável'", () => {
    const visivel = texto(
      render(<UltimoCiclo overview={overview({ last_cycle: null })} />),
    );
    expect(visivel).toContain("Ainda não medido");
    expect(visivel).not.toContain("Nenhum mercado entrável");
  });
});

describe("Quase (RFC-027 D3)", () => {
  const limites = (edgeLiqMin: string | null): PortfolioLimits => ({
    caps: [],
    bindingConstraints24h: [],
    config:
      edgeLiqMin === null
        ? null
        : {
            config_version: "1.2.0",
            edgeLiqMin,
            safetyMarginMin: "0.005000",
            bookMaxAgeMs: 60000,
            estimateMaxAgeMs: 3600000,
          },
  });
  const quase = [
    {
      reason_code: "EDGE_BELOW_MIN",
      count: 71,
      folga_min: "-0.009962",
      folga_p50: null,
    },
  ];

  it("formata a folga em centavos a partir do texto do servidor", () => {
    const visivel = texto(
      render(
        <Quase
          overview={overview({ near_misses_24h: quase })}
          limites={limites("0.020000")}
        />,
      ),
    );
    expect(visivel).toContain("71");
    expect(visivel).toContain("faltou 1,0 c");
  });

  it("lê o piso de /portfolio/limits, e nunca fixa 0,02", () => {
    const visivel = texto(
      render(
        <Quase
          overview={overview({ near_misses_24h: quase })}
          limites={limites("0.035000")}
        />,
      ),
    );
    // O piso mostrado é o da config recebida. Se o componente tivesse 0,02
    // escrito nele, este teste veria 0,02 aqui.
    expect(visivel).toContain("0.035000");
    expect(visivel).toContain("config 1.2.0");
    expect(visivel).not.toContain("0,02");
  });

  it("escreve 'não medido' quando a API não sabe o piso", () => {
    const visivel = texto(
      render(
        <Quase
          overview={overview({ near_misses_24h: quase })}
          limites={limites(null)}
        />,
      ),
    );
    expect(visivel).toContain("não medido");
  });

  it("distingue 'nenhum quase' de 'não sei'", () => {
    const visivel = texto(
      render(
        <Quase
          overview={overview({ near_misses_24h: [] })}
          limites={limites("0.020000")}
        />,
      ),
    );
    expect(visivel).toContain("Nenhuma decisão na banda");
    expect(visivel).toContain("é uma medição");
  });

  it("formata centavos sem tocar em float na tela", () => {
    // −0,009962 => 1,0 c. A tela arredonda para exibir; o valor que ela recebeu
    // continua sendo o texto decimal exato.
    expect(centavos("-0.009962")).toBe("1,0 c");
    expect(centavos("-0.004000")).toBe("0,4 c");
    expect(centavos(null)).toBe("—");
    // Texto que não é número volta como veio, em vez de virar NaN na tela.
    expect(centavos("indefinido")).toBe("indefinido");
  });
});

describe("Congeladas (RFC-027 D3)", () => {
  const AGORA = new Date("2026-09-01T17:00:00.000Z").getTime();
  const JANELA = 24 * 3_600_000;

  it("conta a regressiva com a janela do motor, não com 24 h fixadas", () => {
    // Aberto às 16:00Z com janela de 2 h => libera em 1 h. Se a tela fixasse
    // 24 h, este teste veria 23 h.
    const visivel = texto(
      render(
        <Congeladas
          breakers={[
            {
              kind: "PARAM_CHANGE",
              scope: "market",
              condition_id: "0xaa",
              started_at: "2026-09-01T16:00:00.000Z",
              window_ms: 2 * 3_600_000,
            },
          ]}
          agoraMs={AGORA}
        />,
      ),
    );
    expect(visivel).toContain("1 h 0 min");
    expect(visivel).not.toContain("23 h");
  });

  it("agrupa por tipo e conta pelo mais antigo do grupo", () => {
    const visivel = texto(
      render(
        <Congeladas
          breakers={[
            {
              kind: "PARAM_CHANGE",
              scope: "market",
              condition_id: "0xaa",
              started_at: "2026-09-01T10:00:00.000Z",
              window_ms: JANELA,
            },
            {
              kind: "PARAM_CHANGE",
              scope: "market",
              condition_id: "0xbb",
              started_at: "2026-09-01T16:00:00.000Z",
              window_ms: JANELA,
            },
            {
              kind: "DATA_STALENESS",
              scope: "token",
              condition_id: "0xcc",
              started_at: "2026-09-01T16:30:00.000Z",
              window_ms: JANELA,
            },
          ]}
          agoraMs={AGORA}
        />,
      ),
    );
    expect(visivel).toContain("2 mercados");
    expect(visivel).toContain("1 mercado");
    // O mais antigo do grupo abriu às 10:00Z: 24 h − 7 h = 17 h.
    expect(visivel).toContain("17 h 0 min");
    expect(visivel).toContain("parâmetro mudou");
    expect(visivel).toContain("dado velho");
  });

  it("não inventa prazo para um disjuntor que fecha por condição", () => {
    const visivel = texto(
      render(
        <Congeladas
          breakers={[
            {
              kind: "DATA_STALENESS",
              scope: "token",
              condition_id: "0xcc",
              started_at: "2026-09-01T16:30:00.000Z",
              window_ms: JANELA,
            },
          ]}
          agoraMs={AGORA}
        />,
      ),
    );
    expect(visivel).toContain("fecha quando a condição cessar, sem prazo");
  });

  it("mostra o disjuntor sem contagem quando a API não publicou a janela", () => {
    // A janela entre o CD e o rebuild: painel novo, API antiga. Melhor sem
    // relógio do que com um relógio inventado.
    const visivel = texto(
      render(
        <Congeladas
          breakers={[
            {
              kind: "PARAM_CHANGE",
              scope: "market",
              condition_id: "0xaa",
              started_at: "2026-09-01T16:00:00.000Z",
              window_ms: null,
            },
          ]}
          agoraMs={AGORA}
        />,
      ),
    );
    expect(visivel).toContain("sem prazo");
    expect(visivel).not.toContain("libera em");
  });

  it("guarda o JSON e os milissegundos para o modo engenheiro", () => {
    const semEngenheiro = texto(
      render(
        <Congeladas
          breakers={[
            {
              kind: "PARAM_CHANGE",
              scope: "market",
              condition_id: "0xaa",
              started_at: "2026-09-01T16:00:00.000Z",
              window_ms: JANELA,
            },
          ]}
          agoraMs={AGORA}
        />,
      ),
    );
    expect(semEngenheiro).not.toContain("86400000");
    const comEngenheiro = texto(
      render(
        <Congeladas
          breakers={[
            {
              kind: "PARAM_CHANGE",
              scope: "market",
              condition_id: "0xaa",
              started_at: "2026-09-01T16:00:00.000Z",
              window_ms: JANELA,
            },
          ]}
          agoraMs={AGORA}
        />,
        true,
      ),
    );
    expect(comEngenheiro).toContain("86400000");
    expect(comEngenheiro).toContain("PARAM_CHANGE");
  });

  it("diz 'vencido' em vez de uma contagem negativa", () => {
    expect(duracao(-1)).toBe("vencido");
    expect(duracao(0)).toBe("vencido");
    expect(duracao(90_000)).toBe("1 min 30 s");
  });

  it("escreve que nenhum disjuntor está aberto, em vez de nada", () => {
    const visivel = texto(render(<Congeladas breakers={[]} agoraMs={AGORA} />));
    expect(visivel).toContain("Nenhum disjuntor aberto");
  });
});
