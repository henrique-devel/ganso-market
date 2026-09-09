// RFC-028 D3-D5: a policy PRÓPRIA da estratégia `fast_btc_updown`, pura.
//
// `policy.ts` (POLICY_VERSION 1.0.0, `decideOrderType`) fica INTOCADA e não é
// chamada daqui. A única coisa importada dela é `takerFeePerShare`, que é
// aritmética pura (rate x p x (1 - p)) e não decide nada.
//
// POR QUE UMA POLICY SEPARADA E NÃO UM RAMO NA GLOBAL. A estratégia assume fee
// taker 0,07, e `taker_fee_bps` está NULL em 1344/1344 mercados updown medidos
// em 09/09/2026. Ligar esse 0,07 na policy global acenderia o ramo taker de
// `policy.ts:206-208` para a carteira PRINCIPAL em todos eles — que é
// exatamente o que os dois juízes rejeitaram (D3). A fee assumida vive só no
// contexto desta policy e é gravada em cada decisão.
//
// As invariantes desta policy são MAIS ESTRITAS que as da global (D4):
//
//   * toda saída tem `limitPrice`;
//   * C nunca é taker (só repousa post-only);
//   * E nunca é GTC — na verdade NENHUM braço é: `ttlS` é obrigatório em toda
//     ordem, o que é mais forte que a global, onde `ttlS null => GTC`
//     (`policy.ts:158-159`) produziu 18/18 ordens GTC em produção;
//   * FAK sem `worstPrice` é recusa, nunca ordem.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL. Em 0.1.0 todos os braços têm `mode: "shadow"`:
// esta função devolve o plano, e quem grava a decisão não o submete (D8). O
// plano existe mesmo em sombra porque é ele que o replay tem de reproduzir.

import { createHash } from "node:crypto";

import { SCALE, formatScaled, mul, parseScaled } from "../fundamental/fixed.js";
import type { PriceLevel } from "../types.js";
import { takerFeePerShare } from "./policy.js";
import type { FastArm, FastArmMode, FastConfig } from "./fastconfig.js";
import type { OrderSide, OrderType } from "./validator.js";

export const FAST_POLICY_VERSION = "0.1.0";

export const FAST_STRATEGY_ID = "fast_btc_updown";

/** Casas decimais do preço gravado, como em `policy.ts:156`. */
const PRICE_DIGITS = 6;

/** Qual dos dois tokens do mercado binário. */
export type FastOutcome = "affirmative" | "complement";

export interface FastBook {
  readonly tokenId: string;
  readonly outcome: FastOutcome;
  /** Instante do livro as-of, em ms. A idade é medida contra `nowMs`. */
  readonly asOfMs: number;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
}

export interface FastMarket {
  readonly conditionId: string;
  readonly question: string;
  /** Fim da janela horária (o `end_ts` da 0017). A abertura é fim - 60 min. */
  readonly endTs: Date;
  readonly tickSize: string;
}

export interface FastRtdsInputs {
  /**
   * Idade, em segundos, da última amostra `twap30` em
   * `polymarket_rtds_prices.received_at`. NUNCA derivada de
   * `polymarket_rtds_1m`: um balde de 1 min ou recusa 100 % ou inventa (D4).
   */
  readonly twap30SampleAgeS: number | null;
  /** Baldes faltantes de `polymarket_rtds_1m` na janela recente. */
  readonly missingBuckets: number;
  /** `open` do `twap60` no balde da abertura da janela. */
  readonly s0: string | null;
  /** `close` do `twap30` do balde ANTERIOR (sem look-ahead). */
  readonly st: string | null;
  /**
   * Sinais de z nos baldes anteriores, do mais recente para o mais antigo.
   * O braço E não opera se z trocou de sinal nos `reversalBuckets` últimos.
   */
  readonly previousZSigns: readonly number[];
}

export interface FastStateInputs {
  readonly killSwitchEngaged: boolean;
  /** `kind` de TODO disjuntor aberto no mercado/token. Qualquer um recusa. */
  readonly openBreakerKinds: readonly string[];
  readonly processUptimeS: number;
  /** A carteira principal já segura este token (D2). */
  readonly mainPortfolioHoldsToken: boolean;
  readonly armPaused: boolean;
}

export interface FastContext {
  readonly arm: FastArm;
  readonly config: FastConfig;
  readonly nowMs: number;
  readonly market: FastMarket;
  /** Os dois lados do mercado binário. O braço escolhe qual. */
  readonly books: readonly FastBook[];
  readonly rtds: FastRtdsInputs;
  readonly state: FastStateInputs;
}

export interface FastOrderPlan {
  readonly strategyId: string;
  readonly arm: FastArm;
  readonly tokenId: string;
  readonly outcome: FastOutcome;
  readonly side: OrderSide;
  readonly orderType: Extract<OrderType, "GTD" | "FAK">;
  /** SEMPRE presente: a policy não emite ordem sem limite. */
  readonly limitPrice: string;
  readonly postOnly: boolean;
  /** Não nulo se e somente se `orderType === "FAK"`. */
  readonly worstPrice: string | null;
  /** SEMPRE presente e positivo: nenhum braço é GTC. */
  readonly ttlS: number;
  readonly sizeShares: string;
  readonly assumedTakerFeeRate: string;
  /** Fee assumida por cota ao `worstPrice`; "0" quando repousa (maker). */
  readonly assumedFeePerShare: string;
}

/** Insumos as-of que a decisão grava, para o replay reproduzi-la (D7). */
export interface FastAsOfInputs {
  readonly tokenId: string | null;
  readonly outcome: FastOutcome | null;
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  readonly spread: string | null;
  readonly queueAhead: string | null;
  readonly s0: string | null;
  readonly st: string | null;
  readonly z: string | null;
  readonly k: number | null;
  readonly assumedTakerFeeRate: string;
}

export type FastVerdict = "order" | "skip";

export interface FastDecision {
  /** `false` só quando o CONTEXTO é malformado: não há decisão a gravar. */
  readonly ok: boolean;
  readonly arm: FastArm;
  readonly verdict: FastVerdict;
  /** Código de máquina `FAST_*`. O rótulo PT vive em `dicionario.ts` (D7). */
  readonly reason: string;
  readonly mode: FastArmMode;
  readonly asOf: FastAsOfInputs;
  readonly order?: FastOrderPlan;
}

function armMode(config: FastConfig, arm: FastArm): FastArmMode {
  return config.arms[arm].mode;
}

function emptyAsOf(config: FastConfig): FastAsOfInputs {
  return {
    tokenId: null,
    outcome: null,
    bestBid: null,
    bestAsk: null,
    spread: null,
    queueAhead: null,
    s0: null,
    st: null,
    z: null,
    k: null,
    assumedTakerFeeRate: config.costs.assumedTakerFeeRate,
  };
}

function skip(
  context: FastContext,
  reason: string,
  asOf?: FastAsOfInputs,
): FastDecision {
  return {
    ok: true,
    arm: context.arm,
    verdict: "skip",
    reason,
    mode: armMode(context.config, context.arm),
    asOf: asOf ?? emptyAsOf(context.config),
  };
}

function malformed(context: FastContext, reason: string): FastDecision {
  return {
    ok: false,
    arm: context.arm,
    verdict: "skip",
    reason,
    mode: armMode(context.config, context.arm),
    asOf: emptyAsOf(context.config),
  };
}

const fmt = (value: bigint): string => formatScaled(value, PRICE_DIGITS);

interface Touch {
  readonly book: FastBook;
  readonly bid: bigint;
  readonly ask: bigint;
  readonly mid: bigint;
  readonly spread: bigint;
  /** Tamanho visível no melhor bid: a fila à frente de um join post-only. */
  readonly bidSize: bigint;
}

function touchOf(book: FastBook): Touch | null {
  const bid = parseScaled(book.bids[0]?.price ?? "");
  const ask = parseScaled(book.asks[0]?.price ?? "");
  const bidSize = parseScaled(book.bids[0]?.size ?? "0");
  if (bid === null || ask === null || bidSize === null) {
    return null;
  }
  if (bid <= 0n || ask <= 0n || bid >= ask || ask >= SCALE) {
    return null;
  }
  return {
    book,
    bid,
    ask,
    mid: (bid + ask) / 2n,
    spread: ask - bid,
    bidSize,
  };
}

/** ln(x) sobre um valor escalado, em ponto flutuante. */
function logRatio(stScaled: bigint, s0Scaled: bigint): number {
  return Math.log(Number(stScaled) / Number(s0Scaled));
}

/**
 * z = ln(S_t/S0) / (σ √k), com σ em bps/min (D4).
 *
 * Ponto flutuante aqui é deliberado e seguro: z é um ESCORE adimensional que
 * só é comparado a um limiar, nunca um preço nem dinheiro. Preço e dinheiro
 * seguem em `bigint` escalado do começo ao fim.
 */
function zScore(
  logMove: number,
  sigmaBpsPerMin: string,
  k: number,
): number | null {
  const sigma = Number(sigmaBpsPerMin) / 10_000;
  if (!(sigma > 0) || !(k > 0)) {
    return null;
  }
  const denominator = sigma * Math.sqrt(k);
  if (!(denominator > 0)) {
    return null;
  }
  const z = logMove / denominator;
  return Number.isFinite(z) ? z : null;
}

/** O lado favorito é o de maior mid. Empate exato: o afirmativo. */
function favourite(touches: readonly Touch[]): Touch | null {
  let best: Touch | null = null;
  for (const touch of touches) {
    if (best === null || touch.mid > best.mid) {
      best = touch;
      continue;
    }
    if (touch.mid === best.mid && touch.book.outcome === "affirmative") {
      best = touch;
    }
  }
  return best;
}

function touchFor(
  touches: readonly Touch[],
  outcome: FastOutcome,
): Touch | null {
  return touches.find((touch) => touch.book.outcome === outcome) ?? null;
}

function asOfFor(
  config: FastConfig,
  touch: Touch | null,
  rtds: FastRtdsInputs,
  z: number | null,
  k: number | null,
): FastAsOfInputs {
  return {
    tokenId: touch?.book.tokenId ?? null,
    outcome: touch?.book.outcome ?? null,
    bestBid: touch === null ? null : fmt(touch.bid),
    bestAsk: touch === null ? null : fmt(touch.ask),
    spread: touch === null ? null : fmt(touch.spread),
    queueAhead: touch === null ? null : formatScaled(touch.bidSize, 6),
    s0: rtds.s0,
    st: rtds.st,
    z: z === null ? null : z.toFixed(6),
    k,
    assumedTakerFeeRate: config.costs.assumedTakerFeeRate,
  };
}

/**
 * O lado sorteado do braço de controle: SHA-256 da semente com o
 * `condition_id`, bit menos significativo. Determinístico por mercado — o
 * mesmo mercado sorteia sempre o mesmo lado, que é o que a D5 exige para o
 * controle ser replayável.
 */
export function controlOutcome(seed: number, conditionId: string): FastOutcome {
  const digest = createHash("sha256")
    .update(`${String(seed)}|${conditionId}`)
    .digest();
  return ((digest.at(-1) ?? 0) & 1) === 0 ? "affirmative" : "complement";
}

function restingOrder(
  context: FastContext,
  touch: Touch,
  limit: bigint,
  ttlS: number,
): FastOrderPlan {
  return {
    strategyId: FAST_STRATEGY_ID,
    arm: context.arm,
    tokenId: touch.book.tokenId,
    outcome: touch.book.outcome,
    side: "BUY",
    orderType: "GTD",
    limitPrice: fmt(limit),
    postOnly: true,
    worstPrice: null,
    ttlS,
    sizeShares: context.config.ticket.shares,
    assumedTakerFeeRate: context.config.costs.assumedTakerFeeRate,
    // Repousando, a fee taker não é paga: o maker fee é zero. Formatado na
    // mesma escala dos outros campos de preço, para que o replay compare texto
    // com texto sem normalizar nada.
    assumedFeePerShare: fmt(0n),
  };
}

function marketableOrder(
  context: FastContext,
  touch: Touch,
  worst: bigint,
): FastOrderPlan | null {
  const rate = parseScaled(context.config.costs.assumedTakerFeeRate);
  if (rate === null || rate < 0n) {
    return null;
  }
  return {
    strategyId: FAST_STRATEGY_ID,
    arm: context.arm,
    tokenId: touch.book.tokenId,
    outcome: touch.book.outcome,
    side: "BUY",
    orderType: "FAK",
    // O limite É o pior preço: o resto do book-walk fica sem execução.
    limitPrice: fmt(worst),
    postOnly: false,
    worstPrice: fmt(worst),
    ttlS: context.config.ticket.fakTtlS,
    sizeShares: context.config.ticket.shares,
    assumedTakerFeeRate: context.config.costs.assumedTakerFeeRate,
    assumedFeePerShare: fmt(takerFeePerShare(rate, worst)),
  };
}

/**
 * A decisão de um braço sobre um mercado-hora. Pura: nenhum I/O, nenhum
 * relógio próprio, nenhuma chamada a `decideOrderType`.
 *
 * A ordem de avaliação é a da D4 e não é acidental: soberania primeiro (kill
 * switch e disjuntores), depois estado do processo, depois universo, depois
 * frescor dos dados, e só então o sinal. Um `FAST_SKIPPED_*` de pré-condição
 * significa que o braço nunca chegou a ver o sinal — que é exatamente o que o
 * aceite "braços exercitados" mede.
 */
export function decideFastStrategyOrder(context: FastContext): FastDecision {
  const { config, state, rtds, market, arm } = context;

  // --- Soberania: kill switch e disjuntores vêm antes de tudo (D6). ---
  if (state.killSwitchEngaged) {
    return skip(context, "FAST_SKIPPED_KILL_SWITCH");
  }
  if (state.openBreakerKinds.length > 0) {
    return skip(context, "FAST_SKIPPED_BREAKER_OPEN");
  }

  // --- Estado do processo e do braço. ---
  if (state.processUptimeS < config.preconditions.warmupS) {
    return skip(context, "FAST_SKIPPED_WARMUP");
  }
  if (state.armPaused) {
    return skip(context, "FAST_ARM_PAUSED");
  }

  // --- Universo: a regex ESTRITA, nunca a leniente do registry (D4). ---
  let pattern: RegExp;
  try {
    pattern = new RegExp(config.universe.questionPattern);
  } catch {
    return malformed(context, "FAST_INVALID_UNIVERSE_PATTERN");
  }
  if (!pattern.test(market.question)) {
    return skip(context, "FAST_SKIPPED_NOT_IN_UNIVERSE");
  }

  const endMs = market.endTs.getTime();
  if (!Number.isFinite(endMs)) {
    return malformed(context, "FAST_INVALID_END_TS");
  }
  const secondsToEnd = (endMs - context.nowMs) / 1_000;
  if (secondsToEnd <= config.preconditions.minSecondsToEnd) {
    return skip(context, "FAST_SKIPPED_MARKET_ENDING");
  }
  // k em MINUTOS até o fim (D4). Fracionário: o braço A quer T-10 +/- 30 s.
  const k = secondsToEnd / 60;

  // --- Frescor do RTDS. A idade vem da amostra, não do balde (D4). ---
  if (
    rtds.twap30SampleAgeS === null ||
    rtds.twap30SampleAgeS > config.preconditions.rtdsMaxSampleAgeS
  ) {
    return skip(context, "FAST_SKIPPED_RTDS_STALE");
  }
  if (rtds.missingBuckets > 0) {
    return skip(context, "FAST_SKIPPED_RTDS_GAP");
  }
  const s0 = rtds.s0 === null ? null : parseScaled(rtds.s0);
  const st = rtds.st === null ? null : parseScaled(rtds.st);
  if (s0 === null || s0 <= 0n) {
    return skip(context, "FAST_SKIPPED_NO_S0");
  }
  if (st === null || st <= 0n) {
    return skip(context, "FAST_SKIPPED_NO_ST");
  }

  // --- Livro: idade e spread, no lado que o braço vai olhar. ---
  const bookAgeS =
    (context.nowMs - Math.max(...context.books.map((b) => b.asOfMs))) / 1_000;
  if (context.books.length === 0) {
    return skip(context, "FAST_SKIPPED_NO_BOOK");
  }
  if (
    !Number.isFinite(bookAgeS) ||
    bookAgeS > config.preconditions.bookMaxAgeS
  ) {
    return skip(context, "FAST_SKIPPED_BOOK_STALE");
  }
  const touches: Touch[] = [];
  for (const book of context.books) {
    const touch = touchOf(book);
    if (touch !== null) {
      touches.push(touch);
    }
  }
  if (touches.length === 0) {
    return skip(context, "FAST_SKIPPED_NO_BOOK");
  }

  // --- Sinal. ---
  const logMove = logRatio(st, s0);
  const z = zScore(logMove, config.signal.sigmaBpsPerMin, k);
  if (z === null) {
    return malformed(context, "FAST_INVALID_SIGNAL");
  }

  const tieZone = parseScaled(config.signal.tieZoneBps);
  if (tieZone === null || tieZone <= 0n) {
    return malformed(context, "FAST_INVALID_TIE_ZONE");
  }
  // |ln(S_t/S0)| abaixo da zona de empate, faltando pouco: ninguém opera (D4).
  const absMoveBps = Math.abs(logMove) * 10_000;
  const tieZoneBps = Number(config.signal.tieZoneBps);
  if (k < config.signal.tieZoneMaxK && absMoveBps < tieZoneBps) {
    return skip(
      context,
      "FAST_SKIPPED_TIE_ZONE",
      asOfFor(config, favourite(touches), rtds, z, k),
    );
  }

  switch (arm) {
    case "C":
      return decideArmC(context, touches, z, k);
    case "E":
      return decideArmE(context, touches, z, k);
    case "A":
      return decideArmA(context, touches, z, k);
    case "D":
      return decideArmD(context, touches, z, k);
    default:
      return malformed(context, "FAST_UNKNOWN_ARM");
  }
}

/**
 * C — maker: T-12..T-8, favorito na banda com |z| >= 1, join post-only do
 * melhor bid, GTD até T-4, recusa se a fila visível passa de 3x o ticket.
 *
 * NUNCA taker: a única saída deste braço é `GTD` post-only. O `gtdUntilK` da
 * config vira o `ttlS` medido do instante da decisão, e não um instante
 * absoluto, porque é assim que a ordem expira sozinha se o job atrasar.
 */
function decideArmC(
  context: FastContext,
  touches: readonly Touch[],
  z: number,
  k: number,
): FastDecision {
  const { config } = context;
  const arm = config.arms.C;
  const favourited = favourite(touches);
  const asOf = asOfFor(config, favourited, context.rtds, z, k);
  if (k < arm.kMin || k > arm.kMax) {
    return skip(context, "FAST_SKIPPED_WINDOW", asOf);
  }
  if (favourited === null) {
    return skip(context, "FAST_SKIPPED_NO_BOOK", asOf);
  }
  if (
    favourited.spread > (parseScaled(config.preconditions.bookMaxSpread) ?? 0n)
  ) {
    return skip(context, "FAST_SKIPPED_SPREAD_WIDE", asOf);
  }
  const low = parseScaled(arm.bandLow);
  const high = parseScaled(arm.bandHigh);
  if (low === null || high === null) {
    return malformed(context, "FAST_INVALID_BAND");
  }
  if (favourited.mid < low || favourited.mid > high) {
    return skip(context, "FAST_SKIPPED_BAND", asOf);
  }
  if (Math.abs(z) < Number(arm.minAbsZ)) {
    return skip(context, "FAST_SKIPPED_Z_BELOW", asOf);
  }
  // Fila visível à frente do join, contra o múltiplo do ticket.
  const ticket = parseScaled(config.ticket.shares);
  const multiple = parseScaled(arm.maxQueueTicketMultiple);
  if (ticket === null || multiple === null || ticket <= 0n) {
    return malformed(context, "FAST_INVALID_TICKET");
  }
  if (favourited.bidSize > mul(multiple, ticket)) {
    return skip(context, "FAST_SKIPPED_QUEUE_AHEAD", asOf);
  }
  // O GTD morre em T-`gtdUntilK`; nunca requota (D5).
  const ttlS = Math.round((k - arm.gtdUntilK) * 60);
  if (ttlS <= 0) {
    return skip(context, "FAST_SKIPPED_WINDOW", asOf);
  }
  return {
    ok: true,
    arm: "C",
    verdict: "order",
    reason: "FAST_C_MAKER_JOIN",
    mode: arm.mode,
    asOf,
    order: restingOrder(context, favourited, favourited.bid, ttlS),
  };
}

/**
 * E — convergência: |z| >= 1,5, k em [4, 10], ask+1 tick na banda [0,80; 0,95),
 * FAK com `worstPrice = ask + 1 tick`, e nada se z trocou de sinal nos baldes
 * anteriores.
 *
 * NUNCA GTC: a saída é FAK com `ttlS` explícito. O lado é o que o movimento
 * favorece — z > 0 é alta, logo o token afirmativo ("Up").
 */
function decideArmE(
  context: FastContext,
  touches: readonly Touch[],
  z: number,
  k: number,
): FastDecision {
  const { config } = context;
  const arm = config.arms.E;
  const outcome: FastOutcome = z > 0 ? "affirmative" : "complement";
  const target = touchFor(touches, outcome);
  const asOf = asOfFor(config, target, context.rtds, z, k);
  if (k < arm.kMin || k > arm.kMax) {
    return skip(context, "FAST_SKIPPED_WINDOW", asOf);
  }
  if (Math.abs(z) < Number(arm.minAbsZ)) {
    return skip(context, "FAST_SKIPPED_Z_BELOW", asOf);
  }
  // Reversão: z trocou de sinal em algum dos baldes anteriores.
  const recent = context.rtds.previousZSigns.slice(0, arm.reversalBuckets);
  const current = Math.sign(z);
  if (
    recent.length > 0 &&
    recent.some((sign) => sign !== 0 && sign !== current)
  ) {
    return skip(context, "FAST_SKIPPED_Z_REVERSAL", asOf);
  }
  if (target === null) {
    return skip(context, "FAST_SKIPPED_NO_BOOK", asOf);
  }
  if (target.spread > (parseScaled(config.preconditions.bookMaxSpread) ?? 0n)) {
    return skip(context, "FAST_SKIPPED_SPREAD_WIDE", asOf);
  }
  const tick = parseScaled(context.market.tickSize);
  if (tick === null || tick <= 0n) {
    return malformed(context, "FAST_INVALID_TICK_SIZE");
  }
  const worst = target.ask + tick;
  const low = parseScaled(arm.bandLow);
  const high = parseScaled(arm.bandHigh);
  if (low === null || high === null) {
    return malformed(context, "FAST_INVALID_BAND");
  }
  // Superior EXCLUSIVO: a D5 escreve [0,80; 0,95).
  if (worst < low || worst >= high) {
    return skip(context, "FAST_SKIPPED_BAND", asOf);
  }
  if (worst >= SCALE) {
    return skip(context, "FAST_SKIPPED_NO_SAFE_QUOTE", asOf);
  }
  const order = marketableOrder(context, target, worst);
  // FAK sem `worstPrice` é recusa, nunca ordem.
  if (order === null || order.worstPrice === null) {
    return skip(context, "FAST_SKIPPED_NO_WORST_PRICE", asOf);
  }
  return {
    ok: true,
    arm: "E",
    verdict: "order",
    reason: "FAST_E_CONVERGENCE_FAK",
    mode: arm.mode,
    asOf,
    order,
  };
}

/** A regra de preço comum a A e D: favorito com mid >= minMid e ask na banda. */
function decideLateFavourite(
  context: FastContext,
  target: Touch | null,
  z: number,
  k: number,
  arm: {
    readonly mode: FastArmMode;
    readonly targetK: number;
    readonly toleranceS: number;
    readonly minMid: string;
    readonly askLow: string;
    readonly askHigh: string;
  },
  reason: string,
): FastDecision {
  const { config } = context;
  const asOf = asOfFor(config, target, context.rtds, z, k);
  // T-`targetK` +/- `toleranceS` segundos.
  if (Math.abs(k - arm.targetK) * 60 > arm.toleranceS) {
    return skip(context, "FAST_SKIPPED_WINDOW", asOf);
  }
  if (target === null) {
    return skip(context, "FAST_SKIPPED_NO_BOOK", asOf);
  }
  if (target.spread > (parseScaled(config.preconditions.bookMaxSpread) ?? 0n)) {
    return skip(context, "FAST_SKIPPED_SPREAD_WIDE", asOf);
  }
  const minMid = parseScaled(arm.minMid);
  const askLow = parseScaled(arm.askLow);
  const askHigh = parseScaled(arm.askHigh);
  if (minMid === null || askLow === null || askHigh === null) {
    return malformed(context, "FAST_INVALID_BAND");
  }
  if (target.mid < minMid) {
    return skip(context, "FAST_SKIPPED_BAND", asOf);
  }
  if (target.ask < askLow || target.ask > askHigh) {
    return skip(context, "FAST_SKIPPED_BAND", asOf);
  }
  const order = marketableOrder(context, target, target.ask);
  if (order === null || order.worstPrice === null) {
    return skip(context, "FAST_SKIPPED_NO_WORST_PRICE", asOf);
  }
  return {
    ok: true,
    arm: context.arm,
    verdict: "order",
    reason,
    mode: arm.mode,
    asOf,
    order,
  };
}

/** A — favorito tardio: T-10 +/- 30 s, o lado com mid >= 0,60. */
function decideArmA(
  context: FastContext,
  touches: readonly Touch[],
  z: number,
  k: number,
): FastDecision {
  return decideLateFavourite(
    context,
    favourite(touches),
    z,
    k,
    context.config.arms.A,
    "FAST_A_LATE_FAVOURITE",
  );
}

/**
 * D — controle: o lado é SORTEADO com semente fixa por `condition_id`, e daí
 * em diante a regra de preço é a mesma do A.
 *
 * O sorteio é o braço de controle da D1: sem ele, um resultado positivo em A
 * não se distingue de "comprar o favorito tardio é o mesmo que comprar
 * qualquer lado tardio".
 */
function decideArmD(
  context: FastContext,
  touches: readonly Touch[],
  z: number,
  k: number,
): FastDecision {
  const arm = context.config.arms.D;
  const outcome = controlOutcome(arm.seed, context.market.conditionId);
  return decideLateFavourite(
    context,
    touchFor(touches, outcome),
    z,
    k,
    arm,
    "FAST_D_CONTROL",
  );
}
