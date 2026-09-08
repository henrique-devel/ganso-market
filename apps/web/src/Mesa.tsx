// RFC-026 · tela 1: a Mesa.
//
// Substitui "Visão geral" + "Oportunidades" + "Rápidos" por uma tela de duas
// colunas: a lista à esquerda, o mercado escolhido à direita. Nada aqui é dado
// novo — é o `panel_json` que o motor já grava e que a tela descartava, mais o
// nome do mercado que a RFC-026 D2 acrescentou aos dois SELECTs.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL. Só GET. O único controle é o rearme do kill
// switch, que já existia e já é publicado como um path exato.
//
// Três regras de leitura valem em toda a tela (D3):
//
//   - ausência nunca é zero. "não medido" e "sem dado" saem em cinza; um zero
//     no lugar de um dado que falta é a mentira que esta RFC nasceu para
//     apagar;
//   - recusa por REGRA de negócio (banda, custos, edge mínimo) é cinza, porque
//     é o normal do motor e não deve gritar; recusa por DADO velho ou ausente
//     é vermelha, porque é defeito;
//   - nenhum limite fixo no cliente. Os quatro números que explicam a recusa
//     vêm do bloco `config` de `/portfolio/limits` (D6). Sem ele a tela diz
//     "não medido" em vez de inventar 0,02.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ACAO_RESOLUCAO,
  CATEGORIA,
  FONTE_ESTIMATIVA,
  LADO,
  LIMITADOR,
  MOTIVO_DECISAO,
  RESULTADO_DECISAO,
  TIPO_DECISAO,
  consequencia,
  rotulo,
} from "./dicionario";
import { Badge, idade } from "./Overview.tsx";
import { horizonLabel, horizonMs, roundTripCost } from "./Portfolio.tsx";
import { useModoEngenheiro } from "./modo.tsx";
import {
  fetchPaperPositions,
  rearmKillSwitch,
  type PaperPosition,
} from "./paper.js";
import {
  fetchDecisions,
  fetchExposures,
  fetchLimits,
  fetchOpportunities,
  folgaParaAceitar,
  type BookLevel,
  type Decision,
  type Folga,
  type LimitsConfig,
  type Opportunity,
  type OpportunityPanel,
} from "./portfolio";
import type { Overview } from "./overview";

const REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const ROWS_PER_PAGE = 25;
/** Decisões do mercado escolhido que a coluna direita mostra. */
const DECISOES_DO_MERCADO = 10;
/** "Rápidos": vence dentro desta janela. Era o padrão da aba que ela substitui. */
const JANELA_RAPIDOS_MS = 6 * 3_600_000;

type Chip = "todos" | "rapidos" | "posicao";

type Campo = "nome" | "categoria" | "edge" | "folga" | "livro" | "horizonte";

interface Ordenacao {
  readonly campo: Campo;
  readonly desc: boolean;
}

// ---------------------------------------------------------------------------
// A escada do motor (D6)
// ---------------------------------------------------------------------------

/**
 * Os sete degraus na ordem em que o motor os avalia.
 *
 * A ordem não é decorativa: é ela que permite ler a última decisão do mercado
 * como um corte. O `reason_code` diz em que degrau o motor parou; logo todos os
 * degraus ANTES dele passaram, aquele reprovou, e os DEPOIS nunca foram
 * avaliados — e "nunca avaliado" é "não medido", não "passou". Sem essa regra a
 * escada precisaria adivinhar, e adivinhar aqui produz exatamente a tela
 * otimista que a RFC proíbe.
 */
const DEGRAUS = [
  "Disjuntor",
  "Livro",
  "Estimativa",
  "Banda de preço",
  "Custos",
  "Edge",
  "Tamanho",
] as const;

/** Em que degrau cada motivo de recusa para. */
const MOTIVO_NO_DEGRAU: Readonly<Record<string, number>> = {
  PORTFOLIO_CIRCUIT_BREAKER: 0,
  BOOK_STALE: 1,
  DATA_STALE: 2,
  INSUFFICIENT_DATA: 2,
  PRICE_OUT_OF_BAND: 3,
  LOWER_BOUND_BELOW_COSTS: 4,
  EDGE_BELOW_MIN: 5,
};

/**
 * Tom de cada motivo, na semântica fixa da D3.
 *
 * Vermelho é defeito de dado; âmbar é "envelhecido / disjuntor / quase"; cinza
 * é a recusa por regra de negócio, que é o normal do motor.
 */
const TOM_DO_MOTIVO: Readonly<Record<string, TomDegrau>> = {
  PORTFOLIO_CIRCUIT_BREAKER: "aberto",
  BOOK_STALE: "dado",
  DATA_STALE: "dado",
  INSUFFICIENT_DATA: "aberto",
  PRICE_OUT_OF_BAND: "regra",
  LOWER_BOUND_BELOW_COSTS: "regra",
  EDGE_BELOW_MIN: "regra",
};

export type TomDegrau = "ok" | "regra" | "dado" | "aberto" | "nao_medido";

export interface Degrau {
  readonly nome: string;
  readonly marca: "✓" | "✗" | "·";
  readonly tom: TomDegrau;
  readonly valor: string;
  readonly nota: string | null;
}

function medida(valor: string | null, sufixo = ""): string {
  return valor === null ? "não medido" : `${valor}${sufixo}`;
}

/**
 * A escada de um mercado: o valor medido de cada degrau e onde o motor parou.
 *
 * `decisao` é a decisão mais recente DESTE mercado dentro das 500 que a rota
 * devolve. Quando ela não está na amostra, a escada fica só com o que o
 * `panel_json` mede por si — e diz isso.
 */
export function escada(
  panel: OpportunityPanel,
  config: LimitsConfig | null,
  decisao: Decision | null,
): readonly Degrau[] {
  const aceita = decisao?.outcome === "ACCEPTED";
  const motivo = decisao?.reason_code ?? null;
  const parou =
    motivo !== null && motivo in MOTIVO_NO_DEGRAU
      ? (MOTIVO_NO_DEGRAU[motivo] ?? null)
      : null;
  const folga = folgaParaAceitar(panel, config);
  const custo = roundTripCost(panel);

  const valores: readonly (readonly [string, string, string | null])[] = [
    [
      DEGRAUS[0],
      decisao === null ? "não medido" : parou === 0 ? "aberto" : "fechado",
      // A nota deste degrau fala do disjuntor, e só quando é ele que barra.
      // `consequencia` termina no código bruto de propósito — ela é `title`,
      // nunca texto: imprimi-la aqui punha "(LOWER_BOUND_BELOW_COSTS)" na tela
      // e violava o aceite A4 pelo caminho mais discreto possível.
      parou === 0 ? "a recusa é do portfólio inteiro, não deste mercado" : null,
    ],
    [
      DEGRAUS[1],
      medida(panel.book_age_ms === null ? null : idade(panel.book_age_ms)),
      config?.bookMaxAgeMs === null || config === null
        ? "TTL do livro não publicado"
        : `TTL ${idade(config.bookMaxAgeMs)}`,
    ],
    [
      DEGRAUS[2],
      panel.q === null
        ? "não medido"
        : `q ${panel.q} [${panel.q_lo ?? "—"}, ${panel.q_hi ?? "—"}]`,
      panel.estimate_age_ms === null
        ? null
        : `idade ${idade(panel.estimate_age_ms)}${
            config?.estimateMaxAgeMs == null
              ? ""
              : ` · TTL ${idade(config.estimateMaxAgeMs)}`
          }`,
    ],
    [
      DEGRAUS[3],
      panel.market_bid === null || panel.market_ask === null
        ? "não medido"
        : `${panel.market_bid} / ${panel.market_ask}`,
      panel.microprice === null ? null : `microprice ${panel.microprice}`,
    ],
    [
      DEGRAUS[4],
      custo === null ? "não medido" : custo.toFixed(6),
      `spread ${panel.spread ?? "—"} + 2 × (fee ${panel.fee ?? "—"} + slippage ${panel.slippage ?? "—"})`,
    ],
    [
      DEGRAUS[5],
      medida(panel.edge_net),
      folga.piso === null ? null : `piso ${folga.piso.toFixed(6)}`,
    ],
    [
      DEGRAUS[6],
      medida(panel.max_size_shares, " cotas"),
      panel.binding_constraint === null
        ? panel.limiters.length === 0
          ? "nada limitou porque nada foi dimensionado"
          : null
        : `limitador: ${rotulo(panel.binding_constraint, LIMITADOR)}`,
    ],
  ];

  return valores.map(([nome, valor, nota], indice) => {
    const semValor = valor === "não medido";
    if (aceita) {
      return {
        nome,
        marca: "✓" as const,
        tom: semValor ? ("nao_medido" as const) : ("ok" as const),
        valor,
        nota,
      };
    }
    if (parou === null) {
      // Sem decisão deste mercado na amostra: cada degrau vale o que o painel
      // mede por si, e nada além disso é afirmado — daí a marca neutra "·" em
      // vez de um ✓ que diria "passou".
      return {
        nome,
        marca: "·" as const,
        tom: semValor ? ("nao_medido" as const) : ("ok" as const),
        valor,
        nota,
      };
    }
    if (indice < parou) {
      return { nome, marca: "✓" as const, tom: "ok" as const, valor, nota };
    }
    if (indice === parou) {
      return {
        nome,
        marca: "✗" as const,
        tom: TOM_DO_MOTIVO[motivo ?? ""] ?? "regra",
        valor,
        nota:
          motivo === null
            ? nota
            : `${rotulo(motivo, MOTIVO_DECISAO)}${nota === null ? "" : ` · ${nota}`}`,
      };
    }
    return {
      nome,
      marca: "·" as const,
      tom: "nao_medido" as const,
      valor: "não avaliado",
      nota: "o motor parou antes deste degrau",
    };
  });
}

function somaTamanhos(niveis: readonly BookLevel[]): number | null {
  if (niveis.length === 0) {
    return null;
  }
  let total = 0;
  for (const nivel of niveis) {
    const tamanho = Number(nivel.size);
    if (Number.isFinite(tamanho)) {
      total += tamanho;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// D7 — "O que eu faço agora?"
// ---------------------------------------------------------------------------

export interface Frase {
  readonly texto: string;
  readonly tom: "alerta" | "atencao" | "neutro";
  readonly chave: string;
}

/**
 * Até três frases, e só quando exigem ação ou decisão de quem opera.
 *
 * Recusa rotineira NUNCA vira frase: 18 931 recusas em 24 h (RFC-026, remedido
 * em 08/09; eram 52 868 em 02/09) transformariam este bloco no próprio ruído
 * que ele existe para cortar.
 *
 * As três fontes, na ordem em que aparecem, que é a ordem de quem não sai
 * sozinho primeiro: o kill switch engatado (o broker não aceita ordem até o
 * rearme), aceites que não viraram ordem, e posição com o mercado resolvido na
 * venue e ainda não liquidada no paper. A terceira chegou com o PR 2, quando
 * `/paper/positions` passou a ser publicada e a trazer `pending_settlement`.
 */
export function frasesAgora(
  overview: Overview | null,
  decisoes: readonly Decision[],
  posicoes: readonly PaperPosition[] = [],
): readonly Frase[] {
  const frases: Frase[] = [];
  const kill = overview?.kill_switch ?? null;
  if (kill?.engaged === true) {
    frases.push({
      chave: "kill",
      tom: "alerta",
      texto: `Kill switch ENGATADO${
        kill.reason === null ? "" : ` — ${kill.reason}`
      }. O broker paper não aceita ordem até o rearme.`,
    });
  }
  const semOrdem = decisoes.filter(
    (decisao) =>
      decisao.outcome === "ACCEPTED" && decisao.paper_order_id === null,
  ).length;
  if (semOrdem > 0) {
    frases.push({
      chave: "sem-ordem",
      tom: "atencao",
      texto: `${String(semOrdem)} aceite(s) não viraram ordem paper (amostra das últimas 500 decisões).`,
    });
  }
  // `pending_settlement` vem decidido do servidor (D8): rótulo fundamental
  // final E cotas positivas. A tela não recalcula nem adivinha — e não usa
  // "marca velha" nem "venceu" como substituto, porque nenhum dos dois é o
  // mesmo fato. Vermelho: a liquidação não acontece sozinha.
  const naoLiquidadas = posicoes.filter(
    (posicao) => posicao.pending_settlement,
  ).length;
  if (naoLiquidadas > 0) {
    frases.push({
      chave: "nao-liquidada",
      tom: "alerta",
      texto: `${String(naoLiquidadas)} posição(ões) com o mercado resolvido na venue e ainda não liquidada(s) no paper.`,
    });
  }
  return frases.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Lista da esquerda
// ---------------------------------------------------------------------------

interface Linha {
  readonly opportunity: Opportunity;
  readonly folga: Folga;
  readonly horizonteMs: number | null;
  readonly temPosicao: boolean;
}

function nomeDe(opportunity: Opportunity): string {
  return opportunity.question ?? "sem nome";
}

function ordenar(linhas: readonly Linha[], ordem: Ordenacao): readonly Linha[] {
  const sinal = ordem.desc ? -1 : 1;
  const chave = (linha: Linha): number | string => {
    switch (ordem.campo) {
      case "nome":
        return nomeDe(linha.opportunity).toLocaleLowerCase("pt-BR");
      case "categoria":
        return linha.opportunity.category ?? "";
      case "edge":
        return Number(linha.opportunity.panel.edge_net ?? Number.NaN);
      case "folga":
        return linha.folga.valor ?? Number.NaN;
      case "livro":
        return linha.opportunity.panel.book_age_ms ?? Number.NaN;
      case "horizonte":
        return linha.horizonteMs ?? Number.NaN;
    }
  };
  return [...linhas].sort((esquerda, direita) => {
    const a = chave(esquerda);
    const b = chave(direita);
    if (typeof a === "string" || typeof b === "string") {
      return sinal * String(a).localeCompare(String(b), "pt-BR");
    }
    // NaN é "não medido" e vai para o fim das duas direções: um mercado sem o
    // número não pode liderar uma ordenação por esse número.
    const aVazio = Number.isNaN(a);
    const bVazio = Number.isNaN(b);
    if (aVazio || bVazio) {
      return aVazio && bVazio ? 0 : aVazio ? 1 : -1;
    }
    return sinal * (a - b);
  });
}

/**
 * Cor da idade do dado, com o limite lido da config (D3).
 *
 * Sem `config` não há cor: a idade sai em cinza. Fixar 30 000 aqui era
 * exatamente o que a D6 removeu da tela.
 */
function tomDaIdade(
  ms: number | null,
  limite: number | null,
): "ok" | "atencao" | "alerta" | "neutro" {
  if (ms === null || limite === null || limite <= 0) {
    return "neutro";
  }
  if (ms > limite) {
    return "alerta";
  }
  return ms > limite * 0.5 ? "atencao" : "ok";
}

export function MesaLista({
  linhas,
  total,
  selecionado,
  onSelecionar,
  ordem,
  onOrdenar,
  config,
}: Readonly<{
  linhas: readonly Linha[];
  total: number;
  selecionado: string | null;
  onSelecionar: (tokenId: string) => void;
  ordem: Ordenacao;
  onOrdenar: (campo: Campo) => void;
  config: LimitsConfig | null;
}>) {
  const engenheiro = useModoEngenheiro();
  const cabecalho: readonly (readonly [Campo, string])[] = [
    ["nome", "Mercado"],
    ["categoria", "Categoria"],
    ["edge", "Edge líq."],
    ["folga", "Folga"],
    ["livro", "Livro"],
    ["horizonte", "Vence em"],
  ];
  return (
    <table className="grid grid--compacta mesa-tabela">
      <caption>
        {String(linhas.length)} de {String(total)} mercados do painel. Um
        mercado vetado aparece aqui com o motivo — nunca escondido. Clique no
        nome, ou use <kbd>↑</kbd> <kbd>↓</kbd> e <kbd>Enter</kbd>.
      </caption>
      <thead>
        <tr>
          {cabecalho.map(([campo, texto]) => (
            <th key={campo} scope="col" aria-sort={ariaSort(ordem, campo)}>
              <button
                type="button"
                className="ordenar"
                onClick={() => {
                  onOrdenar(campo);
                }}
              >
                {texto}
                {ordem.campo === campo ? (ordem.desc ? " ↓" : " ↑") : ""}
              </button>
            </th>
          ))}
          <th scope="col">Situação</th>
        </tr>
      </thead>
      <tbody>
        {linhas.map(({ opportunity, folga, horizonteMs, temPosicao }) => {
          const panel = opportunity.panel;
          const escolhido = opportunity.token_id === selecionado;
          return (
            <tr
              key={opportunity.token_id}
              className={escolhido ? "linha--escolhida" : undefined}
              aria-selected={escolhido}
            >
              <th scope="row">
                <button
                  type="button"
                  className="mesa-nome"
                  // O hash fica no title e no modo engenheiro, nunca como nome.
                  title={`${opportunity.condition_id} · token ${opportunity.token_id}`}
                  onClick={() => {
                    onSelecionar(opportunity.token_id);
                  }}
                >
                  <span
                    className={
                      opportunity.question === null
                        ? "sem-nome"
                        : "mesa-nome-texto"
                    }
                  >
                    {nomeDe(opportunity)}
                  </span>
                </button>
                {temPosicao ? (
                  <span className="badge badge--neutro">com posição</span>
                ) : null}
                {engenheiro ? (
                  <code className="mesa-hash">{opportunity.condition_id}</code>
                ) : null}
              </th>
              <td title={consequencia(opportunity.category, CATEGORIA)}>
                {opportunity.category === null
                  ? "—"
                  : rotulo(opportunity.category, CATEGORIA)}
              </td>
              <td>{panel.edge_net ?? "—"}</td>
              <td className={`folga folga--${classeDaFolga(folga)}`}>
                {textoDaFolga(folga)}
              </td>
              <td>
                <span
                  className={`idade idade--${tomDaIdade(panel.book_age_ms, config?.bookMaxAgeMs ?? null)}`}
                >
                  {panel.book_age_ms === null
                    ? "não medido"
                    : idade(panel.book_age_ms)}
                </span>
              </td>
              <td>{horizonLabel(horizonteMs)}</td>
              <td>
                {opportunity.vetoed ? (
                  <span className="badge badge--alerta">
                    Vetado: {opportunity.veto_reason ?? "sem motivo"}
                  </span>
                ) : opportunity.entrable ? (
                  <span className="badge badge--ok">entrável</span>
                ) : (
                  <span className="badge badge--neutro">
                    {panel.entry_reason ?? "não entrável"}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ariaSort(
  ordem: Ordenacao,
  campo: Campo,
): "ascending" | "descending" | "none" {
  if (ordem.campo !== campo) {
    return "none";
  }
  return ordem.desc ? "descending" : "ascending";
}

function classeDaFolga(folga: Folga): string {
  if (folga.valor === null) {
    return "nao-medida";
  }
  return folga.valor >= 0 ? "positiva" : "negativa";
}

/**
 * "faltam 0,004 para aceitar" — ou o que falta medir para saber.
 *
 * Nunca zero no lugar de ausência: sem uma das três entradas a célula diz "não
 * medido" e o `title` diz qual delas falta.
 */
export function textoDaFolga(folga: Folga): string {
  if (folga.valor === null) {
    return "não medido";
  }
  return folga.valor >= 0
    ? `sobra ${folga.valor.toFixed(6)}`
    : `faltam ${Math.abs(folga.valor).toFixed(6)}`;
}

// ---------------------------------------------------------------------------
// Detalhe da direita
// ---------------------------------------------------------------------------

export function MesaDetalhe({
  opportunity,
  config,
  decisoes,
}: Readonly<{
  opportunity: Opportunity | null;
  config: LimitsConfig | null;
  decisoes: readonly Decision[];
}>) {
  const engenheiro = useModoEngenheiro();
  if (opportunity === null) {
    return (
      <div className="mesa-detalhe" aria-label="Mercado escolhido">
        <p className="scope">
          Escolha um mercado na lista para ver a escada do motor, as oito
          respostas e o livro.
        </p>
      </div>
    );
  }
  const panel = opportunity.panel;
  const doMercado = decisoes.filter(
    (decisao) => decisao.condition_id === opportunity.condition_id,
  );
  const ultima = doMercado[0] ?? null;
  const folga = folgaParaAceitar(panel, config);
  const degraus = escada(panel, config, ultima);

  return (
    <div className="mesa-detalhe" aria-label="Mercado escolhido">
      <h3 className={opportunity.question === null ? "sem-nome" : undefined}>
        {nomeDe(opportunity)}
      </h3>
      <p className="scope">
        {opportunity.category === null
          ? "sem categoria"
          : rotulo(opportunity.category, CATEGORIA)}{" "}
        · atualizado{" "}
        {opportunity.computed_at === null
          ? "em instante não registrado"
          : `em ${opportunity.computed_at.replace("T", " ").slice(0, 19)}Z`}
        {engenheiro ? (
          <>
            {" · "}
            <code>{opportunity.condition_id}</code> ·{" "}
            <code>token {opportunity.token_id}</code> ·{" "}
            <code>config {opportunity.config_version ?? "—"}</code>
          </>
        ) : null}
      </p>

      <Escada degraus={degraus} folga={folga} config={config} ultima={ultima} />
      <CartaoPrd panel={panel} folga={folga} />
      <LivroL2 panel={panel} ultima={ultima} />
      <DecisoesDoMercado decisoes={doMercado} />

      {engenheiro ? (
        <details className="mesa-cru">
          <summary>JSON cru do painel</summary>
          <pre>{JSON.stringify(opportunity, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function Escada({
  degraus,
  folga,
  config,
  ultima,
}: Readonly<{
  degraus: readonly Degrau[];
  folga: Folga;
  config: LimitsConfig | null;
  ultima: Decision | null;
}>) {
  return (
    <section className="escada" aria-label="Escada do motor">
      <h4>Por onde a decisão passou</h4>
      {/* De onde a escada foi lida. O painel e a decisão são de ciclos
          diferentes e podem discordar — o painel é o estado de agora, a
          decisão é o que o motor concluiu quando concluiu. Dizer qual decisão
          alimentou os ✓/✗ é o que impede ler a discordância como defeito. */}
      <p className="pnl-nota">
        {ultima === null
          ? "Nenhuma decisão deste mercado nas últimas 500 do log: os degraus mostram só o que o painel mede, e nenhum se declara aprovado."
          : `Degraus lidos da decisão ${String(ultima.decision_id ?? "—")}, de ${
              ultima.decision_ts === null
                ? "instante não registrado"
                : `${ultima.decision_ts.replace("T", " ").slice(0, 19)}Z`
            }; os valores medidos são os do painel acima.`}
      </p>
      <ol>
        {degraus.map((degrau) => (
          <li key={degrau.nome} data-tom={degrau.tom}>
            <span className="escada-marca" aria-hidden="true">
              {degrau.marca}
            </span>
            <span className="escada-nome">{degrau.nome}</span>
            <span className="escada-valor">{degrau.valor}</span>
            {degrau.nota === null ? null : (
              <span className="escada-nota">{degrau.nota}</span>
            )}
          </li>
        ))}
      </ol>
      <div className="folga-barra">
        <span className="card-rot">Folga para aceitar</span>
        <span className={`card-val folga--${classeDaFolga(folga)}`}>
          {textoDaFolga(folga)}
        </span>
        <span className="pnl-nota">
          {folga.valor === null
            ? `edge líquido − máx(margem de segurança, piso da config) — falta: ${folga.faltando.join(", ")}`
            : `edge líquido − máx(margem de segurança, piso da config) · piso ${folga.piso?.toFixed(6) ?? "—"}${
                config?.config_version === null || config === null
                  ? ""
                  : ` · config ${config.config_version ?? "—"}`
              }`}
        </span>
      </div>
    </section>
  );
}

/**
 * As oito respostas do POLY-10 (emenda de 2026-08-18), na ordem do PRD.
 *
 * Nenhuma delas é dado novo: todas saem do `panel_json` que o motor grava por
 * mercado. Trecho da regra, correlacionados e cenários ficam no modo
 * engenheiro, como a D6 manda.
 */
function CartaoPrd({
  panel,
  folga,
}: Readonly<{ panel: OpportunityPanel; folga: Folga }>) {
  const engenheiro = useModoEngenheiro();
  const custo = roundTripCost(panel);
  const profundidade = somaTamanhos([...panel.book_bids, ...panel.book_asks]);
  const respostas: readonly (readonly [string, React.ReactNode])[] = [
    [
      "1. Probabilidade",
      <>
        {panel.q ?? "não medido"}{" "}
        <Badge codigo={panel.estimate_source} dicionario={FONTE_ESTIMATIVA} />
      </>,
    ],
    [
      "2. Incerteza",
      panel.q_lo === null || panel.q_hi === null ? (
        "não medida"
      ) : (
        <>
          [{panel.q_lo}, {panel.q_hi}]
        </>
      ),
    ],
    [
      "3. Preço executável",
      panel.market_bid === null || panel.market_ask === null ? (
        "não medido"
      ) : (
        <>
          bid {panel.market_bid} / ask {panel.market_ask} · spread{" "}
          {panel.spread ?? "—"}
        </>
      ),
    ],
    [
      "4. Custo de ida e volta",
      custo === null ? (
        "não medido"
      ) : (
        <span
          title={`spread ${panel.spread ?? "—"} + 2 × (fee ${panel.fee ?? "—"} + slippage ${panel.slippage ?? "—"})`}
        >
          {custo.toFixed(6)} por cota · margem {panel.safety_margin ?? "—"} ·
          colchão {panel.resolution_buffer ?? "—"}
        </span>
      ),
    ],
    [
      "5. Liquidez",
      profundidade === null ? (
        "sem livro"
      ) : (
        <>
          {profundidade.toFixed(2)} cotas nos{" "}
          {String(panel.book_bids.length + panel.book_asks.length)} níveis
          publicados
        </>
      ),
    ],
    [
      "6. Objetividade da regra",
      <>
        <Badge codigo={panel.resolution_action} dicionario={ACAO_RESOLUCAO} />{" "}
        p(50/50) {panel.p_5050 ?? "não medido"} · lockup{" "}
        {panel.expected_lockup_s === null
          ? "não medido"
          : `${(panel.expected_lockup_s / 3600).toFixed(1)} h`}
      </>,
    ],
    [
      "7. Consistência com relacionados",
      panel.correlated_markets.length === 0
        ? "nenhum correlacionado registrado"
        : `${String(panel.correlated_markets.length)} correlacionado(s)`,
    ],
    [
      "8. Impacto no portfólio",
      <>
        {panel.max_size_shares === null
          ? "não dimensionado"
          : `${panel.max_size_shares} cotas`}
        {" · "}
        {panel.binding_constraint === null
          ? "nada limitou"
          : rotulo(panel.binding_constraint, LIMITADOR)}
        {" · pior caso "}
        {panel.worst_case ?? "não medido"}
      </>,
    ],
  ];

  return (
    <section className="cartao-prd" aria-label="As oito respostas">
      <h4>As oito respostas (POLY-10)</h4>
      <div className="detalhe-grid">
        {respostas.map(([rot, val]) => (
          <p key={rot}>
            <span className="card-rot">{rot}</span>
            <span className="card-val">{val}</span>
          </p>
        ))}
      </div>
      <p className="pnl-nota">
        Lado sugerido <strong>{rotulo(panel.suggested_side, LADO)}</strong> ·
        motivo de entrada: {panel.entry_reason ?? "não registrado"} · invalida
        se: {panel.invalidation_condition ?? "nenhuma condição registrada"} ·
        folga {textoDaFolga(folga)}
      </p>
      {engenheiro ? (
        <details>
          <summary>trecho da regra, correlacionados e cenários</summary>
          <p className="card-val">
            {panel.rule_excerpt ?? "sem trecho de regra registrado"}
          </p>
          <p className="card-val">
            correlacionados:{" "}
            {panel.correlated_markets.length === 0
              ? "nenhum"
              : panel.correlated_markets.join(", ")}
          </p>
          <p className="card-val">
            cenários — provável {panel.likely_case ?? "—"} · melhor{" "}
            {panel.best_case ?? "—"} · pior {panel.worst_case ?? "—"} · 50/50{" "}
            {panel.fifty_fifty_case ?? "—"}
          </p>
        </details>
      ) : null}
    </section>
  );
}

/**
 * O livro L2 que já viajava e era descartado.
 *
 * As barras são proporcionais ao maior tamanho visível, não a um teto fixo: um
 * livro fino e um livro grosso são ambos legíveis, e a escala está escrita ao
 * lado para que ninguém compare dois mercados pelo comprimento da barra.
 */
function LivroL2({
  panel,
  ultima,
}: Readonly<{ panel: OpportunityPanel; ultima: Decision | null }>) {
  const niveis = [...panel.book_bids, ...panel.book_asks];
  if (niveis.length === 0) {
    return (
      <section className="livro" aria-label="Livro">
        <h4>Livro</h4>
        <p className="scope">Sem livro no último painel deste mercado.</p>
      </section>
    );
  }
  const maior = niveis.reduce((maximo, nivel) => {
    const tamanho = Number(nivel.size);
    return Number.isFinite(tamanho) && tamanho > maximo ? tamanho : maximo;
  }, 0);
  const precoDaOrdem = ultima?.exec_price ?? null;

  return (
    <section className="livro" aria-label="Livro">
      <h4>
        Livro L2 · {String(panel.book_bids.length)} bids /{" "}
        {String(panel.book_asks.length)} asks
      </h4>
      <div className="livro-lados">
        <LadoDoLivro
          titulo="Compradores (bid)"
          lado="bid"
          niveis={panel.book_bids}
          maior={maior}
          marcado={precoDaOrdem}
          topo={panel.market_bid}
        />
        <LadoDoLivro
          titulo="Vendedores (ask)"
          lado="ask"
          niveis={panel.book_asks}
          maior={maior}
          marcado={precoDaOrdem}
          topo={panel.market_ask}
        />
      </div>
      <p className="pnl-nota">
        Barra proporcional ao maior nível visível ({maior.toFixed(2)} cotas).
        {precoDaOrdem === null
          ? " A última decisão deste mercado não registrou preço de ordem."
          : ` ◆ marca o preço da ordem sugerida (${precoDaOrdem}).`}{" "}
        Fila da minha ordem (`queue_ahead`) chega no PR 2 desta RFC.
      </p>
    </section>
  );
}

function LadoDoLivro({
  titulo,
  lado,
  niveis,
  maior,
  marcado,
  topo,
}: Readonly<{
  titulo: string;
  lado: "bid" | "ask";
  niveis: readonly BookLevel[];
  maior: number;
  marcado: string | null;
  topo: string | null;
}>) {
  return (
    <table className="grid grid--compacta livro-tabela">
      <caption>{titulo}</caption>
      <thead>
        <tr>
          <th scope="col">Preço</th>
          <th scope="col">Cotas</th>
        </tr>
      </thead>
      <tbody>
        {niveis.map((nivel, indice) => {
          const tamanho = Number(nivel.size);
          const largura =
            maior > 0 && Number.isFinite(tamanho)
              ? Math.max(2, (tamanho / maior) * 100)
              : 0;
          const mesmoPreco = (valor: string | null): boolean =>
            valor !== null && Number(valor) === Number(nivel.price);
          return (
            <tr key={`${nivel.price}-${String(indice)}`}>
              <th scope="row">
                {nivel.price}
                {mesmoPreco(marcado) ? (
                  <span title="preço da ordem sugerida"> ◆</span>
                ) : mesmoPreco(topo) ? (
                  <span title="topo do livro"> ●</span>
                ) : null}
              </th>
              <td>
                <span className="livro-barra-caixa">
                  <span
                    className={`livro-barra livro-barra--${lado}`}
                    style={{ width: `${String(largura)}%` }}
                  />
                  <span className="livro-cotas">{nivel.size}</span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DecisoesDoMercado({
  decisoes,
}: Readonly<{ decisoes: readonly Decision[] }>) {
  const mostradas = decisoes.slice(0, DECISOES_DO_MERCADO);
  return (
    <section className="decisoes-mercado" aria-label="Decisões deste mercado">
      <h4>Últimas decisões deste mercado</h4>
      {mostradas.length === 0 ? (
        <p className="scope">
          Nenhuma decisão deste mercado nas últimas 500 do log. Isso é diferente
          de &quot;nunca decidido&quot;: a amostra é a página da rota.
        </p>
      ) : (
        <table className="grid grid--compacta">
          <tbody>
            {mostradas.map((decisao) => (
              <tr key={String(decisao.decision_id)}>
                <th scope="row">
                  {decisao.decision_ts === null
                    ? "—"
                    : decisao.decision_ts.replace("T", " ").slice(0, 19)}
                </th>
                <td>{rotulo(decisao.decision_kind, TIPO_DECISAO)}</td>
                <td>
                  <Badge
                    codigo={decisao.outcome}
                    dicionario={RESULTADO_DECISAO}
                  />
                </td>
                <td title={consequencia(decisao.reason_code, MOTIVO_DECISAO)}>
                  {rotulo(decisao.reason_code, MOTIVO_DECISAO)}
                </td>
                <td>
                  {decisao.outcome === "ACCEPTED"
                    ? decisao.paper_order_id === null
                      ? "sem ordem"
                      : `ordem ${String(decisao.paper_order_id)}`
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// O bloco de ação (D7)
// ---------------------------------------------------------------------------

export function AgoraBloco({
  frases,
  onRearmar,
  rearmando,
  erroRearme,
}: Readonly<{
  frases: readonly Frase[];
  onRearmar: (() => void) | null;
  rearmando: boolean;
  erroRearme: string | null;
}>) {
  const [confirmando, setConfirmando] = useState(false);
  const engatado = frases.some((frase) => frase.chave === "kill");
  return (
    <section className="agora" aria-label="O que eu faço agora">
      <h3>O que eu faço agora?</h3>
      {frases.length === 0 ? (
        <p className="scope">
          Nada exige ação agora. Recusa rotineira do motor não entra aqui — é o
          normal dele.
        </p>
      ) : (
        <ul className="agora-lista">
          {frases.map((frase) => (
            <li key={frase.chave} className={`badge badge--${frase.tom}`}>
              {frase.texto}
            </li>
          ))}
        </ul>
      )}
      {engatado && onRearmar !== null ? (
        confirmando ? (
          <p className="agora-acao">
            <strong>SIMULAÇÃO:</strong> o rearme libera o SIMULADOR a aceitar
            ordens de novo. Nenhuma ordem real existe.{" "}
            <button
              type="button"
              disabled={rearmando}
              onClick={() => {
                onRearmar();
                setConfirmando(false);
              }}
            >
              {rearmando ? "Rearmando…" : "Confirmar rearme"}
            </button>{" "}
            <button
              type="button"
              onClick={() => {
                setConfirmando(false);
              }}
            >
              Cancelar
            </button>
          </p>
        ) : (
          <p className="agora-acao">
            <button
              type="button"
              onClick={() => {
                setConfirmando(true);
              }}
            >
              Rearmar o kill switch
            </button>
          </p>
        )
      ) : null}
      {erroRearme === null ? null : (
        <p className="scope" role="alert">
          O rearme não foi aceito: <code>{erroRearme}</code>. Isso não é erro de
          tela — o servidor tem um motivo, e ele fica registrado.
        </p>
      )}
      <p className="pnl-nota">
        Posição resolvida na venue e não liquidada no paper entra aqui no PR 2
        desta RFC, com <code>/paper/positions</code> publicado.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

export function MesaView({
  opportunities,
  decisoes,
  posicoes = [],
  config,
  comPosicao,
  overview,
  falhou,
  atualizadoEm,
  onRearmar,
  rearmando,
  erroRearme,
}: Readonly<{
  opportunities: readonly Opportunity[];
  decisoes: readonly Decision[];
  /** Só para a terceira frase da D7; a Mesa não lista posições. */
  posicoes?: readonly PaperPosition[];
  config: LimitsConfig | null;
  comPosicao: ReadonlySet<string>;
  overview: Overview | null;
  falhou: boolean;
  atualizadoEm: number | null;
  onRearmar: (() => void) | null;
  rearmando: boolean;
  erroRearme: string | null;
}>) {
  const [chip, setChip] = useState<Chip>("todos");
  const [texto, setTexto] = useState("");
  const [categoria, setCategoria] = useState("");
  const [ordem, setOrdem] = useState<Ordenacao>({
    campo: "folga",
    desc: true,
  });
  const [pagina, setPagina] = useState(0);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const agora = Date.now();

  const todas: readonly Linha[] = useMemo(
    () =>
      opportunities.map((opportunity) => ({
        opportunity,
        folga: folgaParaAceitar(opportunity.panel, config),
        horizonteMs: horizonMs(opportunity.end_ts, agora),
        temPosicao: comPosicao.has(opportunity.condition_id),
      })),
    // `agora` fica fora de propósito: o horizonte é recalculado a cada
    // renderização, e prendê-lo aqui congelaria a coluna "Vence em".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opportunities, config, comPosicao, agora],
  );

  const categorias = useMemo(() => {
    const vistas = new Set<string>();
    for (const linha of todas) {
      const categoriaDaLinha = linha.opportunity.category;
      if (categoriaDaLinha !== null) {
        vistas.add(categoriaDaLinha);
      }
    }
    return [...vistas].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [todas]);

  const filtradas = useMemo(() => {
    const busca = texto.trim().toLocaleLowerCase("pt-BR");
    return todas.filter((linha) => {
      if (chip === "rapidos") {
        const ms = linha.horizonteMs;
        if (ms === null || ms <= 0 || ms > JANELA_RAPIDOS_MS) {
          return false;
        }
      }
      if (chip === "posicao" && !linha.temPosicao) {
        return false;
      }
      if (categoria !== "" && linha.opportunity.category !== categoria) {
        return false;
      }
      if (busca === "") {
        return true;
      }
      const nome = nomeDe(linha.opportunity).toLocaleLowerCase("pt-BR");
      return (
        nome.includes(busca) ||
        linha.opportunity.condition_id
          .toLocaleLowerCase("pt-BR")
          .includes(busca)
      );
    });
  }, [todas, chip, categoria, texto]);

  const ordenadas = useMemo(
    () => ordenar(filtradas, ordem),
    [filtradas, ordem],
  );
  const paginas = Math.max(1, Math.ceil(ordenadas.length / ROWS_PER_PAGE));
  const indice = Math.min(pagina, paginas - 1);
  const visiveis = ordenadas.slice(
    indice * ROWS_PER_PAGE,
    (indice + 1) * ROWS_PER_PAGE,
  );

  const escolhida =
    ordenadas.find((linha) => linha.opportunity.token_id === selecionado)
      ?.opportunity ??
    visiveis[0]?.opportunity ??
    null;

  const mover = useCallback(
    (passo: number) => {
      if (visiveis.length === 0) {
        return;
      }
      const atual = visiveis.findIndex(
        (linha) => linha.opportunity.token_id === escolhida?.token_id,
      );
      const proximo = Math.min(
        visiveis.length - 1,
        Math.max(0, (atual === -1 ? 0 : atual) + passo),
      );
      const alvo = visiveis[proximo];
      if (alvo !== undefined) {
        setSelecionado(alvo.opportunity.token_id);
      }
    },
    [visiveis, escolhida],
  );

  return (
    <section className="panel mesa" aria-label="Mesa">
      <p className="scope">
        <strong>SIMULAÇÃO — SEM EXECUÇÃO REAL.</strong> Nenhuma ordem real é
        criada por nada nesta tela. Não existe stop-loss: um livro binário pode
        saltar de preço alto para perto de zero sem negociar os níveis
        intermediários, então o dimensionamento assume perda total da posição.
      </p>

      <AgoraBloco
        frases={frasesAgora(overview, decisoes, posicoes)}
        onRearmar={onRearmar}
        rearmando={rearmando}
        erroRearme={erroRearme}
      />

      {falhou ? (
        <p className="scope" role="alert">
          A última atualização da Mesa falhou. Os números abaixo são os
          anteriores.
        </p>
      ) : null}

      <div className="mesa-colunas">
        <div
          className="mesa-lista"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              mover(1);
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              mover(-1);
            }
          }}
        >
          <form
            className="filters"
            aria-label="Filtros da Mesa"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <label>
              Buscar
              <input
                type="search"
                value={texto}
                placeholder="nome do mercado ou hash"
                onChange={(event) => {
                  setTexto(event.target.value);
                  setPagina(0);
                }}
              />
            </label>
            <label>
              Categoria
              <select
                value={categoria}
                onChange={(event) => {
                  setCategoria(event.target.value);
                  setPagina(0);
                }}
              >
                <option value="">todas</option>
                {categorias.map((chave) => (
                  <option key={chave} value={chave}>
                    {rotulo(chave, CATEGORIA)}
                  </option>
                ))}
              </select>
            </label>
            <div className="chips" role="group" aria-label="Recortes">
              {(
                [
                  ["todos", "Todos"],
                  ["rapidos", "Rápidos"],
                  ["posicao", "Com posição"],
                ] as const
              ).map(([chave, texto_]) => (
                <button
                  key={chave}
                  type="button"
                  className={chip === chave ? "chip chip--ativo" : "chip"}
                  aria-pressed={chip === chave}
                  onClick={() => {
                    setChip(chave);
                    setPagina(0);
                  }}
                >
                  {texto_}
                </button>
              ))}
            </div>
          </form>

          <MesaLista
            linhas={visiveis}
            total={opportunities.length}
            selecionado={escolhida?.token_id ?? null}
            onSelecionar={setSelecionado}
            ordem={ordem}
            onOrdenar={(campo) => {
              setOrdem((atual) =>
                atual.campo === campo
                  ? { campo, desc: !atual.desc }
                  : { campo, desc: true },
              );
              setPagina(0);
            }}
            config={config}
          />

          <nav className="pager" aria-label="Paginação da Mesa">
            <button
              type="button"
              disabled={indice === 0}
              onClick={() => {
                setPagina(indice - 1);
              }}
            >
              Anterior
            </button>
            <span>
              Página {String(indice + 1)} de {String(paginas)} ·{" "}
              {String(ordenadas.length)} linhas
            </span>
            <button
              type="button"
              disabled={indice >= paginas - 1}
              onClick={() => {
                setPagina(indice + 1);
              }}
            >
              Próxima
            </button>
          </nav>

          <p className="pnl-nota">
            {atualizadoEm === null
              ? "Ainda carregando."
              : `Atualizado há ${((agora - atualizadoEm) / 1000).toFixed(0)} s · a Mesa relê a cada 30 s.`}
            {chip === "posicao"
              ? " “Com posição” vem de /portfolio/exposure (dimensão mercado); o cartão da posição chega no PR 2."
              : ""}
          </p>
        </div>

        <MesaDetalhe
          opportunity={escolhida}
          config={config}
          decisoes={decisoes}
        />
      </div>
    </section>
  );
}

/**
 * A Mesa ligada à API.
 *
 * Três chamadas no poll de 30 s (`/opportunities`, `/decisions`,
 * `/portfolio/exposure`) = 6 req/min, mais as 8 da faixa (`/overview` e
 * `/paper/performance` a 15 s): **14 por minuto** com a Mesa aberta, contra as
 * 20 que a D5 orça.
 *
 * O status do App não entra na conta porque ele deixou de rodar fora do
 * Sistema (App.tsx) — e ele são DUAS requisições por tique, não uma, que é a
 * premissa da D5 que caiu nesta sessão.
 *
 * `/portfolio/limits` fica FORA do poll de propósito: o bloco `config` só muda
 * quando o motor sobe com outra versão, então ele é lido uma vez e relido
 * apenas quando a versão que vem no painel discorda da que está carregada.
 */
export function Mesa({
  accessToken,
  onUnauthorized,
  overview,
}: Readonly<{
  accessToken: string;
  onUnauthorized: () => void;
  overview: Overview | null;
}>) {
  const [opportunities, setOpportunities] = useState<readonly Opportunity[]>(
    [],
  );
  const [decisoes, setDecisoes] = useState<readonly Decision[]>([]);
  const [comPosicao, setComPosicao] = useState<ReadonlySet<string>>(new Set());
  const [posicoes, setPosicoes] = useState<readonly PaperPosition[]>([]);
  const [config, setConfig] = useState<LimitsConfig | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [atualizadoEm, setAtualizadoEm] = useState<number | null>(null);
  const [rearmando, setRearmando] = useState(false);
  const [erroRearme, setErroRearme] = useState<string | null>(null);
  const mounted = useRef(true);

  const recarregar = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    // Quatro requisições por tique de 30 s = 8/min, mais a faixa fixa
    // (`/overview` + `/paper/performance` a 15 s = 8/min): 16 req/min, sob o
    // teto de 20 da D5/A5. `/paper/positions` entrou aqui porque a terceira
    // frase da D7 depende dela e o bloco "O que eu faço agora?" é da Mesa.
    const [painel, log, exposicoes, carteira] = await Promise.all([
      fetchOpportunities(accessToken, fetch, controller.signal),
      fetchDecisions(accessToken, fetch, controller.signal),
      fetchExposures(accessToken, fetch, controller.signal),
      fetchPaperPositions(accessToken, fetch, controller.signal),
    ]);
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    const resultados = [painel, log, exposicoes, carteira];
    if (resultados.some((resultado) => resultado.kind === "unauthorized")) {
      onUnauthorized();
      return;
    }
    setFalhou(resultados.every((resultado) => resultado.kind === "error"));
    if (painel.kind === "ok") {
      setOpportunities(painel.value);
    }
    if (log.kind === "ok") {
      setDecisoes(log.value);
    }
    if (exposicoes.kind === "ok") {
      setComPosicao(
        new Set(
          exposicoes.value
            .filter(
              (exposicao) =>
                exposicao.dimension === "market" &&
                (exposicao.position_count ?? 0) > 0,
            )
            .map((exposicao) => exposicao.dimension_key),
        ),
      );
    }
    if (carteira.kind === "ok") {
      setPosicoes(carteira.value);
    }
    setAtualizadoEm(Date.now());
  }, [accessToken, onUnauthorized]);

  const recarregarLimites = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    const limites = await fetchLimits(accessToken, fetch, controller.signal);
    window.clearTimeout(timeout);
    if (!mounted.current) {
      return;
    }
    if (limites.kind === "unauthorized") {
      onUnauthorized();
      return;
    }
    if (limites.kind === "ok") {
      setConfig(limites.value.config);
    }
  }, [accessToken, onUnauthorized]);

  useEffect(() => {
    mounted.current = true;
    void recarregar();
    void recarregarLimites();
    const timer = window.setInterval(() => {
      void recarregar();
    }, REFRESH_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [recarregar, recarregarLimites]);

  // A config do painel mudou de versão: os limites em memória são de outra
  // config e precisam ser relidos. É o único caminho pelo qual /portfolio/limits
  // volta a ser chamado depois da montagem.
  const versaoNoPainel = opportunities[0]?.config_version ?? null;
  useEffect(() => {
    if (
      versaoNoPainel !== null &&
      config !== null &&
      config.config_version !== versaoNoPainel
    ) {
      void recarregarLimites();
    }
  }, [versaoNoPainel, config, recarregarLimites]);

  const rearmar = useCallback((): void => {
    setRearmando(true);
    setErroRearme(null);
    void (async () => {
      const resultado = await rearmKillSwitch(accessToken);
      if (!mounted.current) {
        return;
      }
      setRearmando(false);
      if (resultado.kind === "unauthorized") {
        onUnauthorized();
        return;
      }
      if (resultado.kind === "ok") {
        return;
      }
      setErroRearme(
        resultado.kind === "refused"
          ? (resultado.reason ?? "recusado")
          : "falha de rede",
      );
    })();
  }, [accessToken, onUnauthorized]);

  return (
    <MesaView
      opportunities={opportunities}
      decisoes={decisoes}
      posicoes={posicoes}
      config={config}
      comPosicao={comPosicao}
      overview={overview}
      falhou={falhou}
      atualizadoEm={atualizadoEm}
      onRearmar={rearmar}
      rearmando={rearmando}
      erroRearme={erroRearme}
    />
  );
}
