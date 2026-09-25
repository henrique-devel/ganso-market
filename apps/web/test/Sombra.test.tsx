// RFC-029 D4 — a tela Sombra, contra o arquivo que o job REALMENTE gravou.
//
// A fixture não é um objeto montado à mão: é `latest-B.json` e `latest-A.json`
// copiados de /var/lib/ganso/shadow-replay depois da primeira rodada do timer
// em produção, 2026-09-09T17:44:45Z–17:49:56Z. Isso é deliberado. Uma fixture
// escrita por quem escreve o parser concorda com o parser por construção; esta
// concorda com o CLI, que é a única concordância que importa quando um campo
// muda de nome numa versão futura.
//
// O que estes testes NÃO deixam passar: um número inventado, uma ressalva que
// some quando o resultado é bom, e qualquer botão.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TELAS } from "../src/App.tsx";
import {
  AvisoModelosMisturados,
  CartaoPnl,
  FalhaDeHoje,
  Funil,
  SombraView,
  Transicoes,
  Varredura,
  buscaDaTelaSombra,
} from "../src/Sombra.tsx";
import {
  modelosMisturados,
  parseRodada,
  parseTransicao,
  type RodadaSombra,
} from "../src/sombra";

import latestB from "./fixtures/shadow-replay-latest-B.json" with { type: "json" };
import latestA from "./fixtures/shadow-replay-latest-A.json" with { type: "json" };

/** O envelope que a API põe em volta do JSON do CLI (RFC-029 D3). */
function envelope(
  payload: unknown,
  extras: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    simulation: "SIMULAÇÃO — SEM EXECUÇÃO REAL",
    mode: "B",
    run_date: "2026-09-09",
    generated_at: "2026-09-09T17:48:52.000Z",
    stale: false,
    bytes: 3433,
    failure: null,
    payload,
    ...extras,
  };
}

const RODADA_B = parseRodada("B", envelope(latestB)) as RodadaSombra;
const RODADA_A = parseRodada(
  "A",
  envelope(latestA, { mode: "A", bytes: 11134 }),
) as RodadaSombra;

describe("parser do shadow replay", () => {
  it("lê o funil do arquivo real, sem inventar campo nenhum", () => {
    expect(RODADA_B.modoB).not.toBeNull();
    expect(RODADA_B.modoB?.funil).toEqual({
      vistas: 58451,
      admitidas: 11839,
      alcancamEstimativa: 8109,
      agiriamDiferente: 3192,
      aceitasSoPelaSombra: 3121,
      liquidadas: 443,
    });
    expect(RODADA_B.modoB?.mercadosQueAgiriamDiferente).toBe(67);
    expect(RODADA_B.modoB?.pnl.liquidoUsd).toBeCloseTo(916.6407386933374, 10);
    expect(RODADA_B.modoB?.pnl.vitorias).toBe(396);
    expect(RODADA_B.modoB?.pnl.derrotas).toBe(47);
  });

  it("ordena as exclusões pela maior e descarta as zeradas", () => {
    const exclusoes = RODADA_B.modoB?.exclusoes ?? [];
    expect(exclusoes[0]).toEqual({ codigo: "SHADOW_MISSING", linhas: 46612 });
    // Zeradas fora: uma lista com seis linhas em zero esconde a única que
    // importa atrás de cinco que não dizem nada.
    expect(exclusoes.map((e) => e.codigo)).not.toContain("SHADOW_STALE");
  });

  it("parte uma transição em veredito e motivo, e guarda o código cru", () => {
    expect(
      parseTransicao("REJECTED:LOWER_BOUND_BELOW_COSTS -> ACCEPTED:-", 2418),
    ).toEqual({
      codigo: "REJECTED:LOWER_BOUND_BELOW_COSTS -> ACCEPTED:-",
      deResultado: "REJECTED",
      deMotivo: "LOWER_BOUND_BELOW_COSTS",
      paraResultado: "ACCEPTED",
      paraMotivo: null,
      linhas: 2418,
    });
    // O modo A escreve o lado na frente; a matriz é sobre veredito e motivo.
    expect(
      parseTransicao("NO/REJECTED:EDGE_BELOW_MIN -> NO/ACCEPTED:-", 81)
        ?.deMotivo,
    ).toBe("EDGE_BELOW_MIN");
  });

  it("lê a varredura do modo A e separa o que nasce abaixo da ordem mínima", () => {
    expect(RODADA_A.modoA?.chave).toBe("costs.edgeLiqMin");
    expect(RODADA_A.modoA?.valorGravado).toBe(0.02);
    expect(RODADA_A.modoA?.candidatos).toEqual([
      { valor: 0.01, linhas: 141, mercados: 43, abaixoDaOrdemMinima: 52 },
      { valor: 0.015, linhas: 91, mercados: 32, abaixoDaOrdemMinima: 3 },
      { valor: 0.02, linhas: 0, mercados: 0, abaixoDaOrdemMinima: 0 },
      { valor: 0.03, linhas: 88, mercados: 35, abaixoDaOrdemMinima: 0 },
    ]);
    expect(RODADA_A.modoA?.viradas.length).toBe(10);
    expect(RODADA_A.modoA?.viradas[0]).toBeCloseTo(0.020128609260873245, 12);
  });

  it("não lança em documento truncado, campo faltando ou tipo trocado", () => {
    for (const corpo of [
      null,
      {},
      { payload: null },
      { payload: {} },
      { payload: { report: "não é objeto" } },
      { payload: { report: { totals: { decisionsSeen: "58451" } } } },
      envelope({ report: { totals: {}, counterfactual_pnl: {} } }),
    ]) {
      expect(() => parseRodada("B", corpo)).not.toThrow();
    }
    // Um número que veio como string é "não veio", não 58451: aceitar a
    // coerção transformaria uma mudança de tipo num valor plausível.
    const trocado = parseRodada("B", {
      payload: { report: { totals: { decisionsSeen: "58451" } } },
    });
    expect(trocado?.modoB?.funil.vistas).toBeNull();
  });
});

describe("aviso de modelos misturados", () => {
  it("aparece com os dois modelos do arquivo real", () => {
    // O arquivo tem 1.0.0 e 1.1.0 em shadow_estimates_in_window: o as-of
    // compara o motor contra duas coisas ao mesmo tempo.
    expect(RODADA_B.proveniencia?.modelIds).toEqual([
      "crypto_updown_gbm@1.0.0",
      "crypto_updown_gbm@1.1.0",
    ]);
    expect(modelosMisturados(RODADA_B)).toBe(true);
    const html = renderToStaticMarkup(
      <AvisoModelosMisturados rodada={RODADA_B} />,
    );
    expect(html).toContain("Modelos misturados");
    expect(html).toContain("não usar para promoção");
  });

  it("some quando a janela tem um modelo só", () => {
    const umModelo = parseRodada("B", {
      payload: {
        provenance: {
          shadow_estimates_in_window: {
            model_ids: ["crypto_updown_gbm@1.1.0"],
          },
        },
      },
    });
    expect(modelosMisturados(umModelo)).toBe(false);
    expect(
      renderToStaticMarkup(<AvisoModelosMisturados rodada={umModelo} />),
    ).toBe("");
  });
});

describe("a tela contra o arquivo real", () => {
  const html = renderToStaticMarkup(
    <SombraView
      estado={{
        tipo: "ok",
        modoB: RODADA_B,
        modoA: RODADA_A,
        rodadas: [
          { runDate: "2026-09-09", modo: "A", bytes: 11134, mtime: null },
          { runDate: "2026-09-09", modo: "B", bytes: 3433, mtime: null },
        ],
      }}
    />,
  );

  it("imprime o funil, do topo ao liquidado", () => {
    for (const numero of [
      "58.451",
      "11.839",
      "8.109",
      "3.192",
      "3.121",
      "443",
    ]) {
      expect(html, numero).toContain(numero);
    }
  });

  it("imprime o PnL com selo HIPOTÉTICO e sufixo paper", () => {
    expect(html).toContain("+US$ 916,64");
    expect(html).toContain("HIPOTÉTICO");
    expect(html).toContain("(paper)");
  });

  it("imprime a ressalva fixa com N liquidadas em ≤ M mercados", () => {
    expect(html).toContain("Soma de linhas, não posições");
    expect(html).toContain("443");
    expect(html).toContain("≤ 67");
    // A ressalva não é opcional: ela vale mesmo — sobretudo — quando o número
    // é bom, e este é bom.
    expect(html).toContain("sobe ou desce");
  });

  it("imprime a proveniência e diz que não é auditoria", () => {
    // Sem separador de milhar: é um identificador, não uma quantidade.
    expect(html).toContain("910574");
    expect(html).not.toContain("910.574");
    // UTC com o Z à mostra, como o resto do painel: o job roda às 03:30 UTC.
    expect(html).toContain("2026-09-09 17:48:52Z");
    expect(html).toContain("crypto_updown_gbm@1.0.0");
    expect(html).toContain("portfolio_decisions");
    // Em PORTUGUÊS: a tela existe porque estes números só existiam em inglês
    // no stdout de uma sessão SSH. A frase do CLI fica no title, não no corpo.
    expect(html).toContain("Não é auditoria");
    expect(html).toContain("fundamental_estimates");
    expect(html).toContain(
      'title="mode B reads market tables, so its window is bounded',
    );
  });

  it("traduz a matriz de transições e guarda o código cru no title", () => {
    expect(html).toContain("limite inferior não cobre os custos");
    expect(html).toContain("2.418");
    expect(html).toContain("REJECTED:LOWER_BOUND_BELOW_COSTS -&gt; ACCEPTED:-");
  });

  it("desenha a varredura com o valor gravado marcado", () => {
    expect(html).toContain("costs.edgeLiqMin");
    expect(html).toContain("(gravado)");
    expect(html).toContain("52 nascem abaixo da ordem mínima");
  });

  it("NÃO tem controle nenhum: nada aqui é clicável", () => {
    // Sem promoção, sem cunhagem, sem "rodar agora". Uma tela de leitura com
    // ressalvas vira uma decisão sem elas no dia em que ganha um botão.
    //
    // A asserção é sobre CONTROLES, não sobre a palavra: o aviso de modelos
    // misturados diz "promover exige uma janela de um modelo só", e essa frase
    // é o conteúdo certo. O que não pode existir é algo em que se clique.
    for (const controle of [
      "<button",
      "<form",
      "<input",
      "<select",
      "onclick",
    ]) {
      expect(html.toLowerCase(), controle).not.toContain(controle);
    }
  });

  it("mostra os valores de virada em casas legíveis, não em dezoito dígitos", () => {
    expect(html).toContain("0,020129");
    expect(html).not.toContain("0.020128609260873245");
    // O valor gravado também, e em pt-BR.
    expect(html).toContain("0,02");
  });
});

describe("uma rodada que falhou", () => {
  const comFalha = parseRodada(
    "B",
    envelope(latestB, {
      run_date: "2026-09-08",
      failure: {
        status: "error",
        reason_code: "SWEEP_KEY_REFUSED",
        exit_status: 1,
        message: "shadow_replay_failed",
      },
    }),
  ) as RodadaSombra;

  it("diz que a de hoje falhou e de quando é o número que está na tela", () => {
    const html = renderToStaticMarkup(<FalhaDeHoje rodada={comFalha} />);
    expect(html).toContain("A rodada de hoje falhou: SWEEP_KEY_REFUSED");
    expect(html).toContain("2026-09-08");
    expect(html).toContain("não são de hoje");
  });

  it("não some com o dado bom que ainda existe", () => {
    // As duas coisas ao mesmo tempo: a falha de hoje E os últimos números bons.
    expect(comFalha.modoB?.funil.vistas).toBe(58451);
  });

  it("uma rodada sem falha não imprime nada", () => {
    expect(renderToStaticMarkup(<FalhaDeHoje rodada={RODADA_B} />)).toBe("");
  });

  it("sem rodada boa anterior, diz isso em vez de mostrar vazio", () => {
    const semBoa = parseRodada("B", {
      payload: null,
      run_date: null,
      failure: { reason_code: "USAGE" },
    }) as RodadaSombra;
    const html = renderToStaticMarkup(<FalhaDeHoje rodada={semBoa} />);
    expect(html).toContain("USAGE");
    expect(html).toContain("Não há rodada boa anterior");
  });
});

describe("carimbo de velho", () => {
  it("avisa quando o envelope diz stale", () => {
    const velha = parseRodada(
      "B",
      envelope(latestB, { stale: true }),
    ) as RodadaSombra;
    expect(velha.velho).toBe(true);
    const html = renderToStaticMarkup(
      <SombraView
        estado={{ tipo: "ok", modoB: velha, modoA: null, rodadas: [] }}
      />,
    );
    expect(html).toContain("mais de 36 h");
  });
});

describe("a rede desta tela", () => {
  it("faz três GET e nada além de GET", async () => {
    const espiao = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(envelope(latestB)),
      }),
    );

    await buscaDaTelaSombra(
      "tok",
      espiao as unknown as typeof fetch,
      new AbortController().signal,
    );

    const chamadas = espiao.mock.calls.map(([url, init]) => ({
      url,
      metodo: (init as RequestInit | undefined)?.method ?? "GET",
    }));
    expect(chamadas.map((c) => c.url).sort()).toEqual([
      "/api/polymarket/shadow-replay/latest?mode=A",
      "/api/polymarket/shadow-replay/latest?mode=B",
      "/api/polymarket/shadow-replay/runs",
    ]);
    for (const chamada of chamadas) {
      expect(chamada.metodo, chamada.url).toBe("GET");
    }
  });

  it("leva o AbortSignal em todas as três", async () => {
    const controller = new AbortController();
    const espiao = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(envelope(latestB)),
      }),
    );

    await buscaDaTelaSombra(
      "tok",
      espiao as unknown as typeof fetch,
      controller.signal,
    );

    for (const [url, init] of espiao.mock.calls) {
      expect((init as RequestInit | undefined)?.signal, url).toBe(
        controller.signal,
      );
    }
  });

  it("401 numa das três é 401 da tela", async () => {
    const espiao = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ reason_code: "AUTH_UNAUTHENTICATED" }),
      }),
    );

    const [b] = await buscaDaTelaSombra(
      "tok",
      espiao as unknown as typeof fetch,
    );

    expect(b.kind).toBe("unauthorized");
  });
});

describe("estados sem dado", () => {
  it("carregando não imprime número nenhum", () => {
    const html = renderToStaticMarkup(
      <SombraView estado={{ tipo: "carregando" }} />,
    );
    expect(html).toContain("Lendo a rodada de hoje");
    expect(html).not.toContain("US$");
  });

  it("erro aponta o runbook em vez de mostrar tela vazia", () => {
    const html = renderToStaticMarkup(<SombraView estado={{ tipo: "erro" }} />);
    expect(html).toContain("SHADOW_REPLAY_JOB.md");
  });

  it("um relatório sem totals nenhum some, em vez de virar seis travessões", () => {
    const vazio = parseRodada(
      "B",
      envelope({ report: { totals: {}, counterfactual_pnl: {} } }),
    ) as RodadaSombra;
    expect(vazio.modoB).toBeNull();
    const html = renderToStaticMarkup(
      <SombraView
        estado={{ tipo: "ok", modoB: vazio, modoA: null, rodadas: [] }}
      />,
    );
    // A proveniência continua (ela é o que explica a ausência); o funil não.
    expect(html).toContain("Proveniência");
    expect(html).not.toContain("Funil da população");
  });

  it("os blocos aguentam um relatório com metade dos campos faltando", () => {
    const esburacado = parseRodada(
      "B",
      envelope({
        report: {
          totals: { decisionsSeen: 7 },
          counterfactual_pnl: { wins: 1 },
        },
      }),
    ) as RodadaSombra;
    const relatorio = esburacado.modoB;
    expect(relatorio).not.toBeNull();
    if (relatorio === null) {
      return;
    }
    const html = renderToStaticMarkup(
      <>
        <Funil relatorio={relatorio} />
        <CartaoPnl relatorio={relatorio} />
        <Transicoes relatorio={relatorio} />
      </>,
    );
    // O que veio aparece; o que não veio é travessão, nunca zero nem NaN.
    expect(html).toContain("7");
    expect(html).toContain("—");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("a varredura aguenta zero candidatos", () => {
    const vazioA = parseRodada(
      "A",
      envelope({ report: { totals: {} } }, { mode: "A" }),
    ) as RodadaSombra;
    expect(vazioA.modoA).toBeNull();
    expect(() =>
      renderToStaticMarkup(
        <Varredura
          relatorio={{
            chave: null,
            valorGravado: null,
            candidatos: [],
            viradas: [],
            viradasProcuradas: null,
          }}
        />,
      ),
    ).not.toThrow();
  });
});

describe("a aba da tela", () => {
  it("a tecla 4 existe, está habilitada e chama-se Sombra", () => {
    // A RFC-026 reservou a `4` e a deixou desabilitada com uma nota. Esta RFC
    // põe tela atrás dela. Sem esta asserção, desabilitá-la de novo por
    // acidente não quebraria nada — foi exatamente o que se verificou ao tentar
    // a regressão: mudar `disponivel` para `false` passava em toda a suíte.
    const sombra = TELAS.find((aba) => aba.chave === "sombra");
    expect(sombra).toBeDefined();
    expect(sombra?.tecla).toBe("4");
    expect(sombra?.rotulo).toBe("Sombra");
    expect(sombra?.disponivel).toBe(true);
    // A nota "nada aqui ainda" tem de ter saído junto com a espera.
    expect(sombra?.nota).toBeUndefined();
  });

  it("as outras cinco teclas não se mexeram", () => {
    // Renumerar moveria as telas debaixo dos dedos de quem opera.
    expect(TELAS.map((aba) => `${aba.tecla}:${aba.chave}`)).toEqual([
      "1:mesa",
      "2:carteira",
      "3:decisoes",
      "4:sombra",
      "5:resolucao",
      "6:sistema",
    ]);
  });
});

describe("a fixture continua sendo o arquivo do job", () => {
  // O valor da fixture é não ter sido tocada. Um `make format` já a reformatou
  // uma vez — o prettier quebrou `"model_ids": ["a", "b"]` em três linhas — e
  // com isso ela deixou de ser byte-idêntica ao que a API serve, que é a
  // propriedade que o teste de `payload` do lado da API afirma.
  //
  // Os dois hashes abaixo são os de `/var/lib/ganso/shadow-replay` no servidor,
  // conferidos com `sha256sum` depois da primeira rodada do timer. `.prettierignore`
  // mantém os arquivos fora do formatador; este teste é o que percebe se algo
  // os tocar mesmo assim.
  const ESPERADO: Readonly<Record<string, string>> = {
    "shadow-replay-latest-B.json":
      "46f536fc13d5070dbdde3c2ee0c221311666c8428b09064fde5bcde650b0e02f",
    "shadow-replay-latest-A.json":
      "c5e724ee196411d07b6afe11e7517e0adb6a98dafd58efdc796a0f090655b769",
  };

  it("bate byte a byte com o que o job gravou em produção", () => {
    for (const [nome, hash] of Object.entries(ESPERADO)) {
      const bytes = readFileSync(
        new URL(`./fixtures/${nome}`, import.meta.url),
      );
      expect(createHash("sha256").update(bytes).digest("hex"), nome).toBe(hash);
    }
  });
});
