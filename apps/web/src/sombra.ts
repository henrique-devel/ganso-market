// RFC-029 D4 — o que a tela Sombra lê, e o que ela recusa a ler.
//
// A fonte é um arquivo: o job diário roda o CLI `shadow-replay` no host e deixa
// um JSON num diretório que a API monta `:ro`. Este módulo é o único lugar que
// conhece a forma desse JSON, e a converte em tipos estreitos antes de qualquer
// coisa ser desenhada.
//
// A regra deste arquivo: **nenhum `any`, e nenhum campo assumido.** O documento
// é escrito por um CLI que evolui; um campo que sumir tem de virar `null` e uma
// tela que diz "não veio", não uma exceção no meio da renderização nem um
// `undefined` impresso como se fosse número. Todo `parse*` aqui devolve o tipo
// ou o buraco, nunca lança.
//
// Só leitura, e nada além de leitura: não há aqui — nem vai haver — chamada que
// promova modelo, cunhe config ou dispare a rodada. O job é do host.

import { authorizedGet } from "./resolution";
import type { ResolutionFetcher, ResolutionGetResult } from "./resolution";

export type ModoSombra = "A" | "B";

/** Uma transição de veredito da matriz do modo B, já partida em pedaços. */
export interface TransicaoSombra {
  /** O código cru, como o CLI escreveu: `REJECTED:PRICE_OUT_OF_BAND -> ACCEPTED:-`. */
  readonly codigo: string;
  readonly deResultado: string;
  readonly deMotivo: string | null;
  readonly paraResultado: string;
  readonly paraMotivo: string | null;
  readonly linhas: number;
}

/** O funil da população, na ordem em que a RFC o descreve. */
export interface FunilSombra {
  readonly vistas: number | null;
  readonly admitidas: number | null;
  readonly alcancamEstimativa: number | null;
  readonly agiriamDiferente: number | null;
  readonly aceitasSoPelaSombra: number | null;
  readonly liquidadas: number | null;
}

export interface PnlContrafactual {
  readonly consideradas: number | null;
  readonly liquidadas: number | null;
  readonly semRotuloFinal: number | null;
  readonly brutoUsd: number | null;
  readonly custosUsd: number | null;
  readonly degradacaoUsd: number | null;
  readonly liquidoUsd: number | null;
  readonly vitorias: number | null;
  readonly derrotas: number | null;
}

export interface ProvenienciaSombra {
  readonly modo: string | null;
  readonly janelaDe: string | null;
  readonly janelaAte: string | null;
  readonly linhasNoLog: number | null;
  readonly fechadoEmDecisionId: number | null;
  /**
   * Os modelos de sombra PRESENTES na janela — não os que sobreviveram ao
   * funil. É esta lista que decide o aviso de modelos misturados, porque a
   * mistura acontece na entrada do as-of, antes de qualquer filtro.
   */
  readonly modelIds: readonly string[];
  readonly leTabelas: readonly string[];
  readonly naoEAuditoria: string | null;
  readonly algumModeloPromovido: boolean | null;
}

export interface RelatorioModoB {
  readonly funil: FunilSombra;
  readonly mercadosVistos: number | null;
  readonly mercadosAdmitidos: number | null;
  readonly mercadosQueAgiriamDiferente: number | null;
  readonly exclusoes: readonly {
    readonly codigo: string;
    readonly linhas: number;
  }[];
  readonly transicoes: readonly TransicaoSombra[];
  readonly pnl: PnlContrafactual;
  readonly cobertoDe: string | null;
  readonly cobertoAte: string | null;
}

/** Um valor varrido do modo A, com o que ele mudaria. */
export interface CandidatoModoA {
  readonly valor: number;
  readonly linhas: number;
  readonly mercados: number;
  /** Das linhas que mudaram, quantas nasceram abaixo da ordem mínima. */
  readonly abaixoDaOrdemMinima: number;
}

export interface RelatorioModoA {
  readonly chave: string | null;
  readonly valorGravado: number | null;
  readonly candidatos: readonly CandidatoModoA[];
  /** Os pontos de virada de AÇÃO, ordenados. */
  readonly viradas: readonly number[];
  readonly viradasProcuradas: number | null;
}

/** O que uma rodada falhada deixou no lugar do resultado. */
export interface FalhaSombra {
  readonly reasonCode: string;
  readonly runDate: string | null;
  readonly exitStatus: number | null;
}

export interface RodadaSombra {
  readonly modo: ModoSombra;
  readonly runDate: string | null;
  readonly geradoEm: string | null;
  readonly velho: boolean;
  readonly bytes: number | null;
  readonly falha: FalhaSombra | null;
  readonly proveniencia: ProvenienciaSombra | null;
  readonly modoB: RelatorioModoB | null;
  readonly modoA: RelatorioModoA | null;
}

export interface RodadaListada {
  readonly runDate: string;
  readonly modo: string;
  readonly bytes: number | null;
  readonly mtime: string | null;
}

// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Um número do documento, ou o buraco.
 *
 * Sem coerção de string: o CLI escreve números como números, e aceitar `"12"`
 * aqui só serviria para transformar um campo que mudou de tipo num valor
 * plausível em vez de num "não veio" visível.
 */
function numero(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function texto(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function textos(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = texto(item);
        return parsed === null ? [] : [parsed];
      })
    : [];
}

function em(
  record: Record<string, unknown>,
  chave: string,
): Record<string, unknown> {
  const valor = record[chave];
  return isRecord(valor) ? valor : {};
}

/**
 * `REJECTED:PRICE_OUT_OF_BAND -> ACCEPTED:-` vira as suas quatro partes.
 *
 * O modo A escreve o mesmo com o lado na frente (`NO/REJECTED:EDGE_BELOW_MIN`),
 * então o lado é descartado aqui: a matriz da tela é sobre veredito e motivo, e
 * o código cru continua inteiro em `codigo` para o tooltip.
 */
export function parseTransicao(
  codigo: string,
  linhas: number,
): TransicaoSombra | null {
  const [esquerda, direita] = codigo.split(" -> ");
  if (esquerda === undefined || direita === undefined) {
    return null;
  }
  const parte = (
    lado: string,
  ): { resultado: string; motivo: string | null } => {
    const semLado = lado.includes("/") ? (lado.split("/").pop() ?? lado) : lado;
    const [resultado, motivo] = semLado.split(":");
    return {
      resultado: resultado ?? semLado,
      motivo: motivo === undefined || motivo === "-" ? null : motivo,
    };
  };
  const de = parte(esquerda);
  const para = parte(direita);
  return {
    codigo,
    deResultado: de.resultado,
    deMotivo: de.motivo,
    paraResultado: para.resultado,
    paraMotivo: para.motivo,
    linhas,
  };
}

function parseModoB(report: Record<string, unknown>): RelatorioModoB | null {
  const totals = em(report, "totals");
  if (Object.keys(totals).length === 0) {
    return null;
  }
  const pnl = em(report, "counterfactual_pnl");
  const exclusoesRaw = em(totals, "exclusions");
  const transicoesRaw = em(totals, "verdictTransitions");
  return {
    funil: {
      vistas: numero(totals.decisionsSeen),
      admitidas: numero(totals.decisionsAdmitted),
      alcancamEstimativa: numero(totals.decisionsReachingEstimate),
      agiriamDiferente: numero(totals.linesOutcomeChanged),
      aceitasSoPelaSombra: numero(totals.shadowOnlyAccepted),
      liquidadas: numero(pnl.entriesSettled),
    },
    mercadosVistos: numero(totals.marketsSeen),
    mercadosAdmitidos: numero(totals.marketsAdmitted),
    mercadosQueAgiriamDiferente: numero(totals.marketsOutcomeChanged),
    exclusoes: Object.keys(exclusoesRaw)
      .flatMap((codigo) => {
        const linhas = numero(exclusoesRaw[codigo]);
        return linhas === null || linhas === 0 ? [] : [{ codigo, linhas }];
      })
      .sort((a, b) => b.linhas - a.linhas),
    transicoes: Object.keys(transicoesRaw)
      .flatMap((codigo) => {
        const linhas = numero(transicoesRaw[codigo]);
        if (linhas === null) {
          return [];
        }
        const parsed = parseTransicao(codigo, linhas);
        return parsed === null ? [] : [parsed];
      })
      .sort((a, b) => b.linhas - a.linhas),
    pnl: {
      consideradas: numero(pnl.entriesConsidered),
      liquidadas: numero(pnl.entriesSettled),
      semRotuloFinal: numero(pnl.entriesWithoutFinalLabel),
      brutoUsd: numero(pnl.grossUsd),
      custosUsd: numero(pnl.costsUsd),
      degradacaoUsd: numero(pnl.degradationUsd),
      liquidoUsd: numero(pnl.netUsd),
      vitorias: numero(pnl.wins),
      derrotas: numero(pnl.losses),
    },
    cobertoDe: texto(totals.coveredFrom),
    cobertoAte: texto(totals.coveredTo),
  };
}

function parseModoA(report: Record<string, unknown>): RelatorioModoA | null {
  const totals = em(report, "totals");
  if (Object.keys(totals).length === 0) {
    return null;
  }
  const candidatosRaw = totals.candidates;
  const candidatos = Array.isArray(candidatosRaw)
    ? candidatosRaw.flatMap((item): CandidatoModoA[] => {
        if (!isRecord(item)) {
          return [];
        }
        const valor = numero(item.value);
        if (valor === null) {
          return [];
        }
        const transicoes = em(item, "verdictTransitions");
        // A sub-barra da D4: das linhas que mudaram, as que nasceram abaixo da
        // ordem mínima — aceitar por edge e não conseguir dimensionar não é
        // uma AÇÃO nova, e somá-las com as outras contaria ganho que não há.
        const abaixo = Object.keys(transicoes).reduce((soma, codigo) => {
          const destino = codigo.split(" -> ").pop() ?? "";
          const linhas = numero(transicoes[codigo]) ?? 0;
          return destino.includes("SIZE_BELOW_MIN_ORDER")
            ? soma + linhas
            : soma;
        }, 0);
        return [
          {
            valor,
            linhas: numero(item.linesOutcomeChanged) ?? 0,
            mercados: numero(item.marketsOutcomeChanged) ?? 0,
            abaixoDaOrdemMinima: abaixo,
          },
        ];
      })
    : [];
  const viradasRaw = report.actionBreakevens;
  const viradas = Array.isArray(viradasRaw)
    ? viradasRaw
        .flatMap((item) => {
          if (!isRecord(item)) {
            return [];
          }
          const valor = numero(item.value);
          return valor === null ? [] : [valor];
        })
        .sort((a, b) => a - b)
    : [];
  return {
    chave: texto(totals.path),
    valorGravado: numero(totals.recordedValue),
    candidatos: candidatos.sort((a, b) => a.valor - b.valor),
    viradas,
    viradasProcuradas: numero(report.breakevenSearched),
  };
}

function parseProveniencia(raw: unknown): ProvenienciaSombra | null {
  if (!isRecord(raw)) {
    return null;
  }
  const janela = em(raw, "decision_log_window");
  const sombras = em(raw, "shadow_estimates_in_window");
  return {
    modo: texto(raw.mode),
    janelaDe: texto(janela.oldest),
    janelaAte: texto(janela.newest),
    linhasNoLog: numero(janela.rows),
    fechadoEmDecisionId: numero(janela.closed_at_decision_id),
    modelIds: textos(sombras.model_ids),
    leTabelas: textos(raw.reads),
    naoEAuditoria: texto(raw.not_an_audit),
    algumModeloPromovido:
      typeof raw.any_model_promoted === "boolean"
        ? raw.any_model_promoted
        : null,
  };
}

function parseFalha(raw: unknown): FalhaSombra | null {
  if (!isRecord(raw)) {
    return null;
  }
  return {
    reasonCode: texto(raw.reason_code) ?? "SHADOW_REPLAY_FAILED",
    runDate: texto(raw.run_date),
    exitStatus: numero(raw.exit_status),
  };
}

/** O envelope da API mais o JSON do CLI dentro dele. Nunca lança. */
export function parseRodada(
  modo: ModoSombra,
  body: unknown,
): RodadaSombra | null {
  if (!isRecord(body)) {
    return null;
  }
  const payload = isRecord(body.payload) ? body.payload : null;
  const report = payload === null ? {} : em(payload, "report");
  return {
    modo,
    runDate: texto(body.run_date),
    geradoEm: texto(body.generated_at),
    velho: body.stale === true,
    bytes: numero(body.bytes),
    falha: parseFalha(body.failure),
    proveniencia:
      payload === null ? null : parseProveniencia(payload.provenance),
    modoB: modo === "B" && payload !== null ? parseModoB(report) : null,
    modoA: modo === "A" && payload !== null ? parseModoA(report) : null,
  };
}

/**
 * O aviso da D4: mais de um modelo de sombra na janela ⇒ os números misturam
 * duas coisas e não servem para promoção.
 */
export function modelosMisturados(rodada: RodadaSombra | null): boolean {
  return (rodada?.proveniencia?.modelIds.length ?? 0) > 1;
}

export function fetchRodadaSombra(
  accessToken: string,
  modo: ModoSombra,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<RodadaSombra>> {
  const query = new URLSearchParams({ mode: modo });
  return authorizedGet(
    `/api/polymarket/shadow-replay/latest?${query.toString()}`,
    accessToken,
    (body) => parseRodada(modo, body),
    fetcher,
    signal,
  );
}

export function fetchRodadasSombra(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<readonly RodadaListada[]>> {
  return authorizedGet(
    "/api/polymarket/shadow-replay/runs",
    accessToken,
    (body) => {
      if (!isRecord(body) || !Array.isArray(body.runs)) {
        return null;
      }
      return body.runs.flatMap((item): RodadaListada[] => {
        if (!isRecord(item)) {
          return [];
        }
        const runDate = texto(item.run_date);
        const modo = texto(item.mode);
        return runDate === null || modo === null
          ? []
          : [
              {
                runDate,
                modo,
                bytes: numero(item.bytes),
                mtime: texto(item.mtime),
              },
            ];
      });
    },
    fetcher,
    signal,
  );
}
