// RFC-028 D7: o backtest AUDITADO do filtro z, sobre os mercados BTC horários
// já resolvidos.
//
// A aritmética vive aqui, separada do CLI, por um motivo prático: `make verify`
// roda `test` ANTES de `build`, então um teste que executasse
// `apps/api/dist/fast-backtest-cli.js` passaria na máquina de quem já buildou e
// reprovaria no CI numa árvore limpa. O que se verifica é este módulo, em
// processo.
//
// SEM LOOK-AHEAD, e isto é a única coisa que o módulo defende com afinco:
//
//   * `S0` é o `open` do `twap60` no balde da ABERTURA da janela;
//   * `S_t` é o `close` do `twap30` do balde ANTERIOR ao instante da decisão —
//     nunca o do próprio balde, que só fecha depois de decidir;
//   * a cotação é o balde em ou antes do instante da decisão;
//   * o rótulo entra só no cálculo do payout, nunca na seleção.
//
// O backtest de proposta (síntese, braço E: +0,055/cota em 28 observações, IC
// incluindo zero) NÃO foi auditado e cotou `bid = p − 0,01` em vez de join.
// Este reproduz o mesmo instante e o mesmo lado com um modelo de execução
// explícito, e é ele que a condição de parada da RFC-028 lê.

import { blockBootstrapMean } from "../portfolio/bootstrap.js";
import type { FastArm, FastConfig } from "./fastconfig.js";
import { controlOutcome } from "./fastpolicy.js";

/** Resamples e semente do IC. Fixos: um IC irreproduzível não é um IC. */
export const BACKTEST_RESAMPLES = 2_000;
export const BACKTEST_SEED = 20_260_909;

/** Tolerância de frescor da cotação as-of, em minutos de balde. */
export const QUOTE_STALENESS_BUCKETS = 3;

export interface BacktestQuote {
  readonly bucketStart: Date;
  readonly bestBid: string;
  readonly bestAsk: string;
}

export interface BacktestFeedPoint {
  readonly bucketStart: Date;
  readonly open: string;
  readonly close: string;
}

export interface BacktestMarket {
  readonly conditionId: string;
  readonly question: string;
  /** Abertura da janela: `end_ts` menos `universe.windowMinutes`. */
  readonly openTs: Date;
  readonly endTs: Date;
  readonly tickSize: string;
  readonly affirmativeTokenId: string;
  readonly complementTokenId: string | null;
  /** Do rótulo final: o token afirmativo venceu. */
  readonly affirmativeWon: boolean;
  /** Cotações por minuto do token afirmativo. */
  readonly affirmativeQuotes: readonly BacktestQuote[];
  /** Cotações por minuto do token complementar, quando existem. */
  readonly complementQuotes: readonly BacktestQuote[];
  /** `twap60` por minuto: fornece `S0` no balde da abertura. */
  readonly twap60: readonly BacktestFeedPoint[];
  /** `twap30` por minuto: fornece `S_t` no balde anterior à decisão. */
  readonly twap30: readonly BacktestFeedPoint[];
}

/**
 * As bandas de preço da grade. Iguais para todo braço, para comparar.
 *
 * Cobrem (0, 1) INTEIRO, e não só a metade favorita. O braço D sorteia o lado,
 * então compra o azarão em metade dos mercados — a ~0,16 nos horários medidos.
 * Uma grade que começasse em 0,50 jogaria essas observações fora como "fora de
 * banda" e o braço de CONTROLE perderia metade da amostra sem dizer nada, o que
 * é o oposto do que a D1 pede dele.
 */
export const BANDS: ReadonlyArray<{
  readonly label: string;
  readonly low: number;
  readonly high: number;
}> = [
  { label: "[0.01,0.10)", low: 0.01, high: 0.1 },
  { label: "[0.10,0.20)", low: 0.1, high: 0.2 },
  { label: "[0.20,0.35)", low: 0.2, high: 0.35 },
  { label: "[0.35,0.50)", low: 0.35, high: 0.5 },
  { label: "[0.50,0.60)", low: 0.5, high: 0.6 },
  { label: "[0.60,0.70)", low: 0.6, high: 0.7 },
  { label: "[0.70,0.80)", low: 0.7, high: 0.8 },
  { label: "[0.80,0.90)", low: 0.8, high: 0.9 },
  { label: "[0.90,0.95)", low: 0.9, high: 0.95 },
  { label: "[0.95,1.00)", low: 0.95, high: 1 },
];

export interface CellObservation {
  readonly conditionId: string;
  readonly arm: FastArm;
  readonly k: number;
  readonly bandLabel: string;
  readonly z: number;
  readonly entryPrice: number;
  readonly feePerShare: number;
  readonly payout: number;
  /** payout − entrada − fee. Líquido, por cota. */
  readonly pnlPerShare: number;
  readonly filled: boolean;
}

export interface CellResult {
  readonly arm: FastArm;
  readonly k: number;
  readonly bandLabel: string;
  readonly n: number;
  readonly meanPnlPerShare: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly hitRate: number;
  readonly meanEntry: number;
}

export interface RealizedSigma {
  readonly feed: string;
  readonly samples: number;
  /** Desvio padrão dos retornos log por minuto, em bps/min. */
  readonly bpsPerMin: number;
  readonly medianAbsBpsPerMin: number;
}

export interface ReversalStat {
  readonly k: number;
  readonly instants: number;
  readonly reversals: number;
  readonly rate: number;
}

export interface BacktestReport {
  readonly marketsConsidered: number;
  readonly marketsWithS0: number;
  readonly marketsWithQuote: number;
  readonly cells: readonly CellResult[];
  readonly sigma: readonly RealizedSigma[];
  readonly reversals: readonly ReversalStat[];
  readonly observations: readonly CellObservation[];
  readonly skipped: Readonly<Record<string, number>>;
}

const MINUTE_MS = 60_000;

function floorMinute(at: Date): number {
  return Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
}

function bandOf(price: number): string | null {
  for (const band of BANDS) {
    if (price >= band.low && price < band.high) {
      return band.label;
    }
  }
  return null;
}

/** `S0`: o `open` do `twap60` no balde da abertura da janela. */
export function s0Of(market: BacktestMarket): number | null {
  const target = floorMinute(market.openTs);
  for (const point of market.twap60) {
    if (floorMinute(point.bucketStart) === target) {
      const value = Number(point.open);
      return Number.isFinite(value) && value > 0 ? value : null;
    }
  }
  return null;
}

/**
 * `S_t`: o `close` do `twap30` do balde ANTERIOR ao instante da decisão.
 *
 * Estritamente anterior. O balde que contém o instante da decisão só fecha um
 * minuto depois, e usá-lo seria ler o futuro — a forma mais fácil de um
 * backtest de sinal se enganar.
 */
export function stAtOrBefore(
  market: BacktestMarket,
  decisionMs: number,
): { readonly value: number; readonly bucketMs: number } | null {
  const limit = floorMinute(new Date(decisionMs));
  let best: BacktestFeedPoint | null = null;
  for (const point of market.twap30) {
    const bucket = floorMinute(point.bucketStart);
    if (bucket >= limit) {
      continue;
    }
    if (best === null || bucket > floorMinute(best.bucketStart)) {
      best = point;
    }
  }
  if (best === null) {
    return null;
  }
  const value = Number(best.close);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return { value, bucketMs: floorMinute(best.bucketStart) };
}

/** A cotação do balde em ou antes da decisão, dentro da tolerância. */
export function quoteAtOrBefore(
  quotes: readonly BacktestQuote[],
  decisionMs: number,
): BacktestQuote | null {
  const limit = floorMinute(new Date(decisionMs));
  const floor = limit - QUOTE_STALENESS_BUCKETS * MINUTE_MS;
  let best: BacktestQuote | null = null;
  for (const quote of quotes) {
    const bucket = floorMinute(quote.bucketStart);
    if (bucket > limit || bucket < floor) {
      continue;
    }
    if (best === null || bucket > floorMinute(best.bucketStart)) {
      best = quote;
    }
  }
  if (best === null) {
    return null;
  }
  const bid = Number(best.bestBid);
  const ask = Number(best.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask >= 1) {
    return null;
  }
  if (bid >= ask) {
    return null;
  }
  return best;
}

export function zAt(
  logMove: number,
  sigmaBpsPerMin: number,
  k: number,
): number | null {
  const sigma = sigmaBpsPerMin / 10_000;
  if (!(sigma > 0) || !(k > 0)) {
    return null;
  }
  const z = logMove / (sigma * Math.sqrt(k));
  return Number.isFinite(z) ? z : null;
}

/**
 * σ REALIZADO: desvio padrão dos retornos log por minuto, em bps/min.
 *
 * Só entre baldes ADJACENTES: um retorno medido sobre um vão de baldes (e
 * 9,58 % deles faltam em 7 dias, medido em 09/09) não é um retorno de um
 * minuto, e incluí-lo infla σ exatamente na direção que faria o filtro z
 * parecer mais seletivo do que é.
 */
export function realizedSigma(
  feed: string,
  points: readonly BacktestFeedPoint[],
): RealizedSigma {
  const ordered = [...points].sort(
    (a, b) => a.bucketStart.getTime() - b.bucketStart.getTime(),
  );
  const returns: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (
      floorMinute(current.bucketStart) - floorMinute(previous.bucketStart) !==
      MINUTE_MS
    ) {
      continue;
    }
    const a = Number(previous.close);
    const b = Number(current.close);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
      continue;
    }
    returns.push(Math.log(b / a));
  }
  if (returns.length < 2) {
    return {
      feed,
      samples: returns.length,
      bpsPerMin: 0,
      medianAbsBpsPerMin: 0,
    };
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (returns.length - 1);
  const absolutes = returns
    .map((value) => Math.abs(value) * 10_000)
    .sort((a, b) => a - b);
  const middle = Math.floor(absolutes.length / 2);
  const median =
    absolutes.length % 2 === 0
      ? ((absolutes[middle - 1] ?? 0) + (absolutes[middle] ?? 0)) / 2
      : (absolutes[middle] ?? 0);
  return {
    feed,
    samples: returns.length,
    bpsPerMin: Math.sqrt(variance) * 10_000,
    medianAbsBpsPerMin: median,
  };
}

interface Execution {
  readonly entryPrice: number;
  readonly feePerShare: number;
  readonly filled: boolean;
  readonly boughtAffirmative: boolean;
}

/**
 * O modelo de execução, explícito por braço.
 *
 * C é MAKER: repousa no melhor bid e só é preenchido se o preço vier até ele —
 * `best_ask <= limite` em algum balde até o vencimento do GTD. É essa condição
 * que carrega a seleção adversa: o braço é preenchido justamente quando o
 * mercado se move contra a compra. Um backtest de maker que assume
 * preenchimento sempre mede outra coisa.
 *
 * A, D e E são TAKER: pagam o ask (E, o ask + 1 tick) e a fee assumida de 0,07.
 */
function execute(
  arm: FastArm,
  config: FastConfig,
  quotes: readonly BacktestQuote[],
  quote: BacktestQuote,
  boughtAffirmative: boolean,
  decisionMs: number,
  tickSize: number,
): Execution | null {
  const rate = Number(config.costs.assumedTakerFeeRate);
  if (arm === "C") {
    const limit = Number(quote.bestBid);
    if (!Number.isFinite(limit) || limit <= 0 || limit >= 1) {
      return null;
    }
    // O GTD vive de T-kMin até T-gtdUntilK, medido do instante da decisão.
    const expiryMs =
      floorMinute(new Date(decisionMs)) +
      (config.arms.C.kMin - config.arms.C.gtdUntilK) * MINUTE_MS;
    let filled = false;
    for (const candidate of quotes) {
      const bucket = floorMinute(candidate.bucketStart);
      if (bucket <= floorMinute(new Date(decisionMs)) || bucket > expiryMs) {
        continue;
      }
      const ask = Number(candidate.bestAsk);
      if (Number.isFinite(ask) && ask <= limit) {
        filled = true;
        break;
      }
    }
    // Maker: fee zero. Não preenchido: PnL zero e a observação sai marcada.
    return { entryPrice: limit, feePerShare: 0, filled, boughtAffirmative };
  }
  const ask = Number(quote.bestAsk);
  if (!Number.isFinite(ask) || ask <= 0) {
    return null;
  }
  const entry = arm === "E" ? ask + tickSize : ask;
  if (entry >= 1) {
    return null;
  }
  return {
    entryPrice: entry,
    feePerShare: rate * entry * (1 - entry),
    filled: true,
    boughtAffirmative,
  };
}

/**
 * Qual lado cada braço compra, dado o sinal e o livro.
 *
 * As REGRAS estão escritas aqui de novo de propósito: se o backtest importasse
 * `decideFastStrategyOrder`, ele mediria a implementação em vez da regra, e um
 * erro na policy passaria a validar a si mesmo.
 *
 * O sorteio do braço D é a exceção, e vem de `controlOutcome`: ali não há
 * regra a auditar, só um mapa determinístico de `condition_id` para lado. Usar
 * um sorteio diferente aqui faria o controle do backtest não ser o controle
 * que a produção vai rodar.
 */
function sideFor(
  arm: FastArm,
  z: number,
  affirmativeQuote: BacktestQuote | null,
  complementQuote: BacktestQuote | null,
  seed: number,
  conditionId: string,
): boolean | null {
  if (arm === "E") {
    return z > 0;
  }
  if (arm === "D") {
    return controlOutcome(seed, conditionId) === "affirmative";
  }
  // A e C compram o favorito: o lado de maior mid.
  const affirmativeMid =
    affirmativeQuote === null
      ? null
      : (Number(affirmativeQuote.bestBid) + Number(affirmativeQuote.bestAsk)) /
        2;
  const complementMid =
    complementQuote === null
      ? null
      : (Number(complementQuote.bestBid) + Number(complementQuote.bestAsk)) / 2;
  if (affirmativeMid === null && complementMid === null) {
    return null;
  }
  if (complementMid === null) {
    return true;
  }
  if (affirmativeMid === null) {
    return false;
  }
  return affirmativeMid >= complementMid;
}

export interface BacktestOptions {
  readonly config: FastConfig;
  readonly arms: readonly FastArm[];
  readonly ks: readonly number[];
  /** σ usado no z. Por omissão o congelado da config (5 bps/min). */
  readonly sigmaBpsPerMin?: number;
  /** Filtro |z| mínimo por braço; por omissão o da config. */
  readonly minAbsZ?: Readonly<Partial<Record<FastArm, number>>>;
}

/**
 * Roda a grade braço × banda × k sobre os mercados dados.
 *
 * Cada mercado contribui NO MÁXIMO uma observação por célula, que é a unidade
 * experimental da D4 ("IC por mercado, nunca por cota"): dois instantes do
 * mesmo mercado-hora não são duas amostras independentes.
 */
export function runBacktest(
  markets: readonly BacktestMarket[],
  options: BacktestOptions,
): BacktestReport {
  const { config } = options;
  const sigma = options.sigmaBpsPerMin ?? Number(config.signal.sigmaBpsPerMin);
  const observations: CellObservation[] = [];
  const skipped: Record<string, number> = {};
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  let withS0 = 0;
  let withQuote = 0;

  for (const market of markets) {
    const s0 = s0Of(market);
    if (s0 === null) {
      bump("NO_S0");
      continue;
    }
    withS0 += 1;
    let quotedSomewhere = false;

    for (const arm of options.arms) {
      const armMinAbsZ =
        options.minAbsZ?.[arm] ??
        (arm === "C"
          ? Number(config.arms.C.minAbsZ)
          : arm === "E"
            ? Number(config.arms.E.minAbsZ)
            : 0);
      for (const k of options.ks) {
        const decisionMs = market.endTs.getTime() - k * MINUTE_MS;
        if (decisionMs <= market.openTs.getTime()) {
          bump("BEFORE_OPEN");
          continue;
        }
        const st = stAtOrBefore(market, decisionMs);
        if (st === null) {
          bump("NO_ST");
          continue;
        }
        const z = zAt(Math.log(st.value / s0), sigma, k);
        if (z === null) {
          bump("NO_Z");
          continue;
        }
        if (Math.abs(z) < armMinAbsZ) {
          bump("Z_BELOW");
          continue;
        }
        const affirmativeQuote = quoteAtOrBefore(
          market.affirmativeQuotes,
          decisionMs,
        );
        const complementQuote = quoteAtOrBefore(
          market.complementQuotes,
          decisionMs,
        );
        const buyAffirmative = sideFor(
          arm,
          z,
          affirmativeQuote,
          complementQuote,
          config.arms.D.seed,
          market.conditionId,
        );
        if (buyAffirmative === null) {
          bump("NO_BOOK");
          continue;
        }
        const quote = buyAffirmative ? affirmativeQuote : complementQuote;
        if (quote === null) {
          bump("NO_BOOK_ON_SIDE");
          continue;
        }
        quotedSomewhere = true;
        const execution = execute(
          arm,
          config,
          buyAffirmative ? market.affirmativeQuotes : market.complementQuotes,
          quote,
          buyAffirmative,
          decisionMs,
          Number(market.tickSize),
        );
        if (execution === null) {
          bump("NO_EXECUTION");
          continue;
        }
        const bandLabel = bandOf(execution.entryPrice);
        if (bandLabel === null) {
          bump("OUT_OF_BANDS");
          continue;
        }
        const won = buyAffirmative
          ? market.affirmativeWon
          : !market.affirmativeWon;
        const payout = won ? 1 : 0;
        const pnl = execution.filled
          ? payout - execution.entryPrice - execution.feePerShare
          : 0;
        observations.push({
          conditionId: market.conditionId,
          arm,
          k,
          bandLabel,
          z,
          entryPrice: execution.entryPrice,
          feePerShare: execution.feePerShare,
          payout,
          pnlPerShare: pnl,
          filled: execution.filled,
        });
      }
    }
    if (quotedSomewhere) {
      withQuote += 1;
    }
  }

  const cells: CellResult[] = [];
  const byCell = new Map<string, CellObservation[]>();
  for (const observation of observations) {
    // Só as observações PREENCHIDAS entram no PnL: uma ordem maker que nunca
    // foi preenchida não é um trade de PnL zero, é um trade que não houve.
    if (!observation.filled) {
      continue;
    }
    const key = `${observation.arm}|${String(observation.k)}|${observation.bandLabel}`;
    const list = byCell.get(key) ?? [];
    list.push(observation);
    byCell.set(key, list);
  }
  for (const [key, list] of [...byCell.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const parts = key.split("|");
    const samples = list.map((observation) => observation.pnlPerShare);
    // blockSize 1: a unidade é o mercado-hora e cada mercado entra uma vez na
    // célula, então não há dependência de bloco a preservar aqui.
    const boot = blockBootstrapMean({
      samples,
      resamples: BACKTEST_RESAMPLES,
      blockSize: 1,
      seed: BACKTEST_SEED,
      haircut: 0,
    });
    cells.push({
      arm: (parts[0] ?? "A") as FastArm,
      k: Number(parts[1] ?? "0"),
      bandLabel: parts[2] ?? "",
      n: list.length,
      meanPnlPerShare: boot.mean,
      ciLow: boot.ciLow,
      ciHigh: boot.ciHigh,
      hitRate:
        list.filter((observation) => observation.payout === 1).length /
        list.length,
      meanEntry:
        list.reduce((sum, observation) => sum + observation.entryPrice, 0) /
        list.length,
    });
  }

  const reversals = reversalStats(markets, options.ks, sigma);
  const twap30 = markets.flatMap((market) => market.twap30);
  const twap60 = markets.flatMap((market) => market.twap60);

  return {
    marketsConsidered: markets.length,
    marketsWithS0: withS0,
    marketsWithQuote: withQuote,
    cells,
    sigma: [
      realizedSigma("twap30", dedupe(twap30)),
      realizedSigma("twap60", dedupe(twap60)),
    ],
    reversals,
    observations,
    skipped,
  };
}

function dedupe(
  points: readonly BacktestFeedPoint[],
): readonly BacktestFeedPoint[] {
  const seen = new Map<number, BacktestFeedPoint>();
  for (const point of points) {
    seen.set(floorMinute(point.bucketStart), point);
  }
  return [...seen.values()];
}

/**
 * Reversão do z: com que frequência o sinal de z no instante da decisão difere
 * do sinal em algum dos baldes anteriores.
 *
 * É o insumo do veto do braço E. Uma taxa alta significa que o filtro veta
 * muito; uma taxa perto de zero significa que o veto quase nunca morde e
 * portanto quase não explica nada do resultado.
 */
export function reversalStats(
  markets: readonly BacktestMarket[],
  ks: readonly number[],
  sigmaBpsPerMin: number,
): readonly ReversalStat[] {
  const stats: ReversalStat[] = [];
  for (const k of [...ks].sort((a, b) => a - b)) {
    let instants = 0;
    let reversals = 0;
    for (const market of markets) {
      const s0 = s0Of(market);
      if (s0 === null) {
        continue;
      }
      const decisionMs = market.endTs.getTime() - k * MINUTE_MS;
      const current = stAtOrBefore(market, decisionMs);
      if (current === null) {
        continue;
      }
      const z = zAt(Math.log(current.value / s0), sigmaBpsPerMin, k);
      if (z === null) {
        continue;
      }
      instants += 1;
      const sign = Math.sign(z);
      let reverted = false;
      for (let back = 1; back <= 3; back += 1) {
        const earlier = stAtOrBefore(market, decisionMs - back * MINUTE_MS);
        if (earlier === null) {
          continue;
        }
        const earlierZ = zAt(
          Math.log(earlier.value / s0),
          sigmaBpsPerMin,
          k + back,
        );
        if (earlierZ === null) {
          continue;
        }
        const earlierSign = Math.sign(earlierZ);
        if (earlierSign !== 0 && sign !== 0 && earlierSign !== sign) {
          reverted = true;
          break;
        }
      }
      if (reverted) {
        reversals += 1;
      }
    }
    stats.push({
      k,
      instants,
      reversals,
      rate: instants === 0 ? 0 : reversals / instants,
    });
  }
  return stats;
}
