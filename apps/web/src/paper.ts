// The one RFC-011 control the panel publishes: rearming the paper broker's kill
// switch.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL. Rearming lets the SIMULATOR accept orders
// again; no real order, wallet or credential exists anywhere in this project.
//
// There is no read call here on purpose. The switch's state already rides on
// GET /api/polymarket/resolution-risk/pipeline, which the dashboard already
// fetches and renders — a second endpoint for the same fact would be a second
// thing to keep in agreement with it.
//
// There is no engage call either. The switch has automatic triggers (recorder
// staleness, daily loss), so stopping does not need a human; a manual halt stays
// an action taken from inside the server, and the perimeter does not publish it.

import { authorizedGet, authorizedPost } from "./resolution";
import type {
  ResolutionFetcher,
  ResolutionGetResult,
  ResolutionPostResult,
} from "./resolution";

export interface RearmOutcome {
  /** The switch's state AFTER the rearm, as the server reports it. */
  readonly engaged: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deliberately NOT permissive about `engaged`: only an explicit boolean is
 * accepted. A malformed payload must not read as "the broker is running", which
 * is the reading that would make an operator stop looking while the broker is in
 * fact still halted.
 */
export function parseRearmOutcome(body: unknown): RearmOutcome | null {
  if (!isRecord(body) || typeof body.engaged !== "boolean") {
    return null;
  }
  return { engaged: body.engaged };
}

export function rearmKillSwitch(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionPostResult<RearmOutcome>> {
  return authorizedPost(
    "/api/polymarket/paper/kill-switch/rearm",
    accessToken,
    parseRearmOutcome,
    fetcher,
    signal,
  );
}

// ---------------------------------------------------------------------------
// RFC-026 D8 — the two reads the perimeter publishes for the Carteira screen
// ---------------------------------------------------------------------------
//
// Money stays TEXT the whole way. Every dollar and every share count below is
// the decimal string the API sent, never a `number`: the API keeps these in
// TEXT columns precisely so no float ever rounds a position, and parsing them
// here to render them would undo that in the last metre. The only numbers in
// these types are counts and durations, which are counts of things.

export interface PaperPosition {
  readonly token_id: string;
  readonly condition_id: string | null;
  /** O nome do mercado, ou `null` quando o registro não tem a linha. */
  readonly question: string | null;
  readonly shares: string | null;
  readonly cost_usd: string | null;
  readonly realized_pnl_usd: string | null;
  readonly fees_paid_usd: string | null;
  /**
   * PnL não realizado calculado NO SERVIDOR (`paper/api.ts`), em texto.
   *
   * `null` é "não medido" e nunca zero: sem marca fresca o servidor se recusa
   * a inventar um número, e a tela tem de dizer isso em vez de imprimir 0,00 —
   * que um operador lê como "estou no zero a zero", não como "não sei".
   */
  readonly unrealized_pnl_usd: string | null;
  readonly mark_value_usd: string | null;
  readonly mark_stale: boolean | null;
  readonly marked_at: string | null;
  readonly opened_at: string | null;
  /** Segundos desde a abertura, do servidor. `null` em posição fechada. */
  readonly current_lockup_s: number | null;
  readonly end_ts: string | null;
  /**
   * `is_final` do rótulo fundamental, ou `null` quando não existe rótulo.
   *
   * Fica exposto além de `pending_settlement` para o modo engenheiro poder
   * mostrar POR QUE o selo apareceu — ou por que não apareceu.
   */
  readonly is_final: boolean | null;
  /**
   * Resolvido na venue e ainda com posição: `is_final AND shares > 0`,
   * decidido pelo servidor (RFC-026 D8).
   *
   * Não é heurística de marca velha nem de vencimento passado. Marca velha
   * quer dizer que o gravador parou; vencimento passado é um calendário, não
   * um resultado. Só o rótulo diz que o resultado é conhecido.
   */
  readonly pending_settlement: boolean;
}

export interface PaperOrder {
  readonly order_id: string;
  readonly token_id: string | null;
  readonly condition_id: string | null;
  readonly question: string | null;
  readonly side: string | null;
  readonly order_type: string | null;
  readonly status: string | null;
  readonly limit_price: string | null;
  readonly size: string | null;
  readonly filled_size: string | null;
  /**
   * Tamanho à frente na fila no momento do aceite, em texto.
   *
   * Posição CONSERVADORA: atrás de todo o tamanho visível no nível, e
   * cancelamentos à frente nunca a melhoram (RFC-011 C2). `null` é "não
   * medido" — hoje 63 de 63 ordens têm o número (medido em 08/09).
   */
  readonly queue_ahead: string | null;
  readonly decided_at: string | null;
  readonly created_at: string | null;
  readonly closed_at: string | null;
}

/** Status que o broker grava; a tela agrupa em Abertas e Encerradas. */
export const STATUS_ABERTO: readonly string[] = ["open"];

function asTexto(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBooleano(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asContagem(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePosition(row: unknown): PaperPosition | null {
  if (!isRecord(row)) {
    return null;
  }
  const tokenId = asTexto(row.token_id);
  if (tokenId === null) {
    return null;
  }
  return {
    token_id: tokenId,
    condition_id: asTexto(row.condition_id),
    question: asTexto(row.question),
    shares: asTexto(row.shares),
    cost_usd: asTexto(row.cost_usd),
    realized_pnl_usd: asTexto(row.realized_pnl_usd),
    fees_paid_usd: asTexto(row.fees_paid_usd),
    unrealized_pnl_usd: asTexto(row.unrealized_pnl_usd),
    mark_value_usd: asTexto(row.mark_value_usd),
    mark_stale: asBooleano(row.mark_stale),
    marked_at: asTexto(row.marked_at),
    opened_at: asTexto(row.opened_at),
    current_lockup_s: asContagem(row.current_lockup_s),
    end_ts: asTexto(row.end_ts),
    is_final: asBooleano(row.is_final),
    // Só `true` é verdadeiro. Um payload malformado não pode virar um selo
    // vermelho de "resolvido na venue" que não veio do servidor.
    pending_settlement: row.pending_settlement === true,
  };
}

function parseOrder(row: unknown): PaperOrder | null {
  if (!isRecord(row)) {
    return null;
  }
  const orderId = asTexto(row.order_id);
  if (orderId === null) {
    return null;
  }
  return {
    order_id: orderId,
    token_id: asTexto(row.token_id),
    condition_id: asTexto(row.condition_id),
    question: asTexto(row.question),
    side: asTexto(row.side),
    order_type: asTexto(row.order_type),
    status: asTexto(row.status),
    limit_price: asTexto(row.limit_price),
    size: asTexto(row.size),
    filled_size: asTexto(row.filled_size),
    queue_ahead: asTexto(row.queue_ahead),
    decided_at: asTexto(row.decided_at),
    created_at: asTexto(row.created_at),
    closed_at: asTexto(row.closed_at),
  };
}

function parseLista<T>(
  raw: unknown,
  parse: (row: unknown) => T | null,
): readonly T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: T[] = [];
  for (const row of raw) {
    const parsed = parse(row);
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  return out;
}

export function fetchPaperPositions(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<readonly PaperPosition[]>> {
  return authorizedGet(
    "/api/polymarket/paper/positions",
    accessToken,
    (body) =>
      isRecord(body) ? parseLista(body.positions, parsePosition) : null,
    fetcher,
    signal,
  );
}

export function fetchPaperOrders(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<readonly PaperOrder[]>> {
  return authorizedGet(
    "/api/polymarket/paper/orders",
    accessToken,
    (body) => (isRecord(body) ? parseLista(body.orders, parseOrder) : null),
    fetcher,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Formatação de texto decimal — sem passar por `number`
// ---------------------------------------------------------------------------
//
// A API guarda dinheiro em TEXT para que nenhum float arredonde uma posição.
// Converter para `number` só para imprimir desfaria isso no último metro, e é
// justamente na impressão que o operador lê o número. As duas funções abaixo
// trabalham sobre a string com `BigInt`, então o que aparece na tela é o que
// está no banco, arredondado uma vez e de forma exata.

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Dinheiro em dólar a partir do texto decimal, com duas casas.
 *
 * `null`, vazio ou texto não numérico viram "—": um valor que não dá para ler
 * é "não medido", nunca zero. O sinal usa o menos tipográfico (−) como o resto
 * do painel, e um valor que arredonda para zero não recebe sinal — "−$0,00"
 * anuncia uma perda que não existe.
 */
export function usdTexto(value: string | null | undefined): string {
  const centavos = emCentavos(value);
  if (centavos === null) {
    return "—";
  }
  const negativo = centavos < 0n;
  const absoluto = (negativo ? -centavos : centavos)
    .toString()
    .padStart(3, "0");
  const inteiro = absoluto.slice(0, -2);
  const resto = absoluto.slice(-2);
  return `${negativo ? "−" : ""}$${inteiro}.${resto}`;
}

/** O sinal do valor: -1, 0 ou 1. `null` quando não dá para ler. */
export function sinalTexto(value: string | null | undefined): number | null {
  const centavos = emCentavos(value);
  if (centavos === null) {
    return null;
  }
  return centavos < 0n ? -1 : centavos > 0n ? 1 : 0;
}

function emCentavos(value: string | null | undefined): bigint | null {
  if (typeof value !== "string") {
    return null;
  }
  const texto = value.trim();
  if (!DECIMAL.test(texto)) {
    return null;
  }
  const negativo = texto.startsWith("-");
  const semSinal = negativo ? texto.slice(1) : texto;
  const [inteiro = "0", fracao = ""] = semSinal.split(".");
  const duas = `${fracao}00`.slice(0, 2);
  let centavos = BigInt(inteiro) * 100n + BigInt(duas);
  // Arredonda para cima na terceira casa, com inteiros: nenhum float envolvido.
  if ((fracao[2] ?? "0") >= "5") {
    centavos += 1n;
  }
  return negativo ? -centavos : centavos;
}

/**
 * Uma quantidade (cotas, tamanho de fila) a partir do texto decimal.
 *
 * Diferente de dinheiro: não força duas casas, só tira os zeros à direita que
 * o banco grava. "150.000000" vira "150" e "12.090000" vira "12.09" — a mesma
 * quantidade, sem seis casas de ruído em cada célula da tabela.
 */
export function quantidadeTexto(value: string | null | undefined): string {
  if (typeof value !== "string" || !DECIMAL.test(value.trim())) {
    return "—";
  }
  const texto = value.trim();
  if (!texto.includes(".")) {
    return texto;
  }
  const limpo = texto.replace(/0+$/, "").replace(/\.$/, "");
  return limpo === "" || limpo === "-" ? "0" : limpo;
}

/**
 * Uma DURAÇÃO decorrida em texto curto ("12 s", "2,0 h").
 *
 * Separada de `horizonLabel`, que mede o tempo que FALTA e por isso chama de
 * "vencido" tudo que é <= 0. Capital preso há zero segundo não está vencido:
 * está começando agora, e imprimir "vencido" num cartão de posição aberta é o
 * tipo de rótulo que faz alguém agir pelo motivo errado.
 */
export function duracaoTexto(segundos: number | null): string {
  if (segundos === null || !Number.isFinite(segundos) || segundos < 0) {
    return "—";
  }
  if (segundos < 90) {
    return `${String(Math.floor(segundos))} s`;
  }
  if (segundos < 3_600) {
    return `${String(Math.floor(segundos / 60))} min`;
  }
  if (segundos < 86_400) {
    return `${(segundos / 3_600).toFixed(1)} h`;
  }
  return `${(segundos / 86_400).toFixed(1)} d`;
}

/**
 * Idade de um instante em texto curto ("há 12 s", "há 4 min").
 *
 * `null` vira "não medido" e nunca "há 0 s": as duas coisas se leem de formas
 * opostas, e a marca ausente é exatamente o caso que a tela precisa mostrar.
 */
export function idadeTexto(instante: string | null, agoraMs: number): string {
  if (instante === null) {
    return "não medido";
  }
  const ms = Date.parse(instante);
  if (Number.isNaN(ms)) {
    return "não medido";
  }
  const s = Math.max(0, Math.floor((agoraMs - ms) / 1_000));
  if (s < 90) {
    return `há ${String(s)} s`;
  }
  if (s < 5_400) {
    return `há ${String(Math.floor(s / 60))} min`;
  }
  if (s < 172_800) {
    return `há ${String(Math.floor(s / 3_600))} h`;
  }
  return `há ${String(Math.floor(s / 86_400))} d`;
}
