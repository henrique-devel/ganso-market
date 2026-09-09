// RFC-028 D4-D7: a configuração da estratégia `fast_btc_updown`, versionada e
// congelada antes do deploy.
//
// Mesmo padrão de `portfolio/config.ts` — um arquivo JSON nomeado por uma env
// var, parser que recusa chave desconhecida e valor fora de faixa, e um hash do
// material que muda o significado de uma DECISÃO — com uma diferença
// deliberada: aqui NÃO existe default.
//
// POR QUE SEM DEFAULT. `loadPortfolioConfig` devolve
// `DEFAULT_PORTFOLIO_CONFIG` quando a env var não está setada, e isso é
// defensável para o motor de carteira, cujos defaults estão congelados no
// código e revisados na RFC-013. Para esta estratégia seria o contrário do que
// a D4 pede: um arquivo ausente ou ilegível passaria a rodar uma configuração
// que ninguém congelou, sem linha em `fast_config_versions` e portanto sem
// hash que qualquer decisão gravada possa citar. Arquivo ausente é erro
// nomeado; o worker não sobe (RFC-028, "Testes obrigatórios").

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const FAST_CONFIG_FILE_ENV = "GANSO_FAST_CONFIG_FILE";

export class FastConfigError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "FastConfigError";
    this.reasonCode = reasonCode;
  }
}

/** O modo de um braço. `shadow` decide e grava; `paper` emitiria ordem. */
export type FastArmMode = "shadow" | "paper";

/** Os quatro braços que decidem. B existe só no replay e não tem config. */
export type FastArm = "A" | "C" | "D" | "E";

export const FAST_ARMS: readonly FastArm[] = ["A", "C", "D", "E"];

export interface FastUniverseConfig {
  /** Regex ESTRITA da D4: só a série horária, nunca a de 15 min ou de 4 h. */
  readonly questionPattern: string;
  readonly windowMinutes: number;
}

export interface FastSignalConfig {
  /** σ em bps/min. Parâmetro CONGELADO da 0.1.0, sem medição prévia auditada. */
  readonly sigmaBpsPerMin: string;
  /** Zona de empate: |ln(S_t/S0)| abaixo disto, faltando pouco, ninguém opera. */
  readonly tieZoneBps: string;
  readonly tieZoneMaxK: number;
}

export interface FastPreconditionConfig {
  readonly bookMaxAgeS: number;
  readonly bookMaxSpread: string;
  /** Idade da amostra de `twap30`, medida em `polymarket_rtds_prices`. */
  readonly rtdsMaxSampleAgeS: number;
  readonly rtdsNoGapWindowMin: number;
  readonly warmupS: number;
  readonly minSecondsToEnd: number;
}

export interface FastCostConfig {
  /**
   * Fee taker assumida, 0,07. Vive SÓ aqui: ligá-la na policy global acenderia
   * o ramo taker de `policy.ts:206-208` para a carteira principal em 998/998
   * updown, o que os dois juízes rejeitaram (D3).
   */
  readonly assumedTakerFeeRate: string;
}

export interface FastTicketConfig {
  readonly shares: string;
  /** TTL da tentativa marketable. Toda saída tem ttl: nenhuma é GTC (D3). */
  readonly fakTtlS: number;
}

export interface FastArmCConfig {
  readonly mode: FastArmMode;
  readonly kMin: number;
  readonly kMax: number;
  readonly bandLow: string;
  readonly bandHigh: string;
  readonly minAbsZ: string;
  readonly gtdUntilK: number;
  readonly maxQueueTicketMultiple: string;
}

export interface FastArmEConfig {
  readonly mode: FastArmMode;
  readonly kMin: number;
  readonly kMax: number;
  readonly bandLow: string;
  /** Limite SUPERIOR EXCLUSIVO: a D5 escreve [0,80; 0,95). */
  readonly bandHigh: string;
  readonly minAbsZ: string;
  readonly reversalBuckets: number;
}

export interface FastArmLateConfig {
  readonly mode: FastArmMode;
  readonly targetK: number;
  readonly toleranceS: number;
  readonly minMid: string;
  readonly askLow: string;
  readonly askHigh: string;
}

export interface FastArmDConfig extends FastArmLateConfig {
  /** Semente do sorteio. Combinada com o `condition_id`: mesmo mercado, mesmo lado. */
  readonly seed: number;
}

export interface FastArmsConfig {
  readonly A: FastArmLateConfig;
  readonly C: FastArmCConfig;
  readonly D: FastArmDConfig;
  readonly E: FastArmEConfig;
}

export interface FastLimitsConfig {
  readonly maxOrdersPerArmPerMarket: number;
  readonly maxOpenPositionsPerArm: number;
  readonly maxOrdersPerDay: number;
  readonly dailyStopUsdPerArm: string;
  readonly dailyStopUsdSubAccount: string;
  readonly subAccountBankrollUsd: string;
}

export interface FastCriteriaConfig {
  readonly pauseMinN: number;
  readonly pauseHitRateGapPoints: string;
  readonly stopMinN: number;
  readonly dailyStopStrikes: number;
  readonly dailyStopStrikeWindowDays: number;
  readonly promoteMinN: number;
  readonly promoteTicketShares: string;
  readonly promoteMaxPValue: string;
  readonly promoteReplayMaxDeviationPct: string;
  readonly endAfterDays: number;
  readonly endAfterMarketsPerArm: number;
}

export interface FastConfig {
  readonly version: string;
  readonly universe: FastUniverseConfig;
  readonly signal: FastSignalConfig;
  readonly preconditions: FastPreconditionConfig;
  readonly costs: FastCostConfig;
  readonly ticket: FastTicketConfig;
  readonly arms: FastArmsConfig;
  readonly limits: FastLimitsConfig;
  readonly criteria: FastCriteriaConfig;
}

function fail(reasonCode: string, message: string): never {
  throw new FastConfigError(reasonCode, message);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("FAST_CONFIG_INVALID", `${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      fail("FAST_CONFIG_UNKNOWN_KEY", `${where}.${key} is not a known key`);
    }
  }
}

interface Bounds {
  readonly min: number;
  readonly max: number;
}

/**
 * Um inteiro obrigatório. Ausente é erro, nunca default: a 0.1.0 declara TODOS
 * os parâmetros da D4-D6, e um campo faltante significa que o arquivo não é a
 * versão que alguém congelou.
 */
function int(
  raw: Record<string, unknown>,
  key: string,
  bounds: Bounds,
  where: string,
): number {
  const value = raw[key];
  if (value === undefined) {
    fail("FAST_CONFIG_MISSING", `${where}.${key} is required`);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail("FAST_CONFIG_INVALID", `${where}.${key} must be an integer`);
  }
  if (value < bounds.min || value > bounds.max) {
    fail(
      "FAST_CONFIG_OUT_OF_RANGE",
      `${where}.${key} must be within [${String(bounds.min)}, ${String(bounds.max)}]`,
    );
  }
  return value;
}

/**
 * Um decimal em TEXTO, obrigatório, estritamente positivo por omissão.
 *
 * Dinheiro e preço não passam por `number` em nenhum ponto do módulo — é a
 * invariante da casa —, então a config guarda o texto e quem calcula converte
 * com `parseScaled`. A validação aqui é sintática e de faixa; a aritmética é do
 * chamador.
 */
function decimal(
  raw: Record<string, unknown>,
  key: string,
  bounds: Bounds,
  where: string,
): string {
  const value = raw[key];
  if (value === undefined) {
    fail("FAST_CONFIG_MISSING", `${where}.${key} is required`);
  }
  if (typeof value !== "string" || !/^-?[0-9]+(\.[0-9]+)?$/.test(value)) {
    fail(
      "FAST_CONFIG_INVALID",
      `${where}.${key} must be a decimal string, not ${typeof value}`,
    );
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    fail("FAST_CONFIG_INVALID", `${where}.${key} is not a finite decimal`);
  }
  if (numeric < bounds.min || numeric > bounds.max) {
    fail(
      "FAST_CONFIG_OUT_OF_RANGE",
      `${where}.${key} must be within [${String(bounds.min)}, ${String(bounds.max)}]`,
    );
  }
  return value;
}

function mode(raw: Record<string, unknown>, where: string): FastArmMode {
  const value = raw["mode"];
  if (value === undefined) {
    fail("FAST_CONFIG_MISSING", `${where}.mode is required`);
  }
  if (value !== "shadow" && value !== "paper") {
    fail(
      "FAST_CONFIG_INVALID",
      `${where}.mode must be "shadow" or "paper", not ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Faixas. `PROBABILITY` exclui 0 e 1: nenhum limite de banda é degenerado. */
const PROBABILITY: Bounds = { min: 0.000001, max: 0.999999 };
const POSITIVE: Bounds = { min: 0.000001, max: Number.MAX_SAFE_INTEGER };
const MINUTES: Bounds = { min: 1, max: 1_440 };
const SECONDS: Bounds = { min: 1, max: 86_400 };
const COUNT: Bounds = { min: 1, max: 1_000_000 };
const FEE_RATE: Bounds = { min: 0, max: 1 };

/** Bandas invertidas são recusa nomeada, nunca ordenação silenciosa. */
function requireBand(low: string, high: string, where: string): void {
  if (Number(low) >= Number(high)) {
    fail(
      "FAST_CONFIG_OUT_OF_RANGE",
      `${where}.bandLow must be strictly below ${where}.bandHigh`,
    );
  }
}

function parseArmC(raw: unknown): FastArmCConfig {
  const where = "fast.arms.C";
  const armRaw = record(raw, where);
  rejectUnknownKeys(
    armRaw,
    [
      "mode",
      "kMin",
      "kMax",
      "bandLow",
      "bandHigh",
      "minAbsZ",
      "gtdUntilK",
      "maxQueueTicketMultiple",
    ],
    where,
  );
  const arm: FastArmCConfig = {
    mode: mode(armRaw, where),
    kMin: int(armRaw, "kMin", MINUTES, where),
    kMax: int(armRaw, "kMax", MINUTES, where),
    bandLow: decimal(armRaw, "bandLow", PROBABILITY, where),
    bandHigh: decimal(armRaw, "bandHigh", PROBABILITY, where),
    minAbsZ: decimal(armRaw, "minAbsZ", POSITIVE, where),
    gtdUntilK: int(armRaw, "gtdUntilK", MINUTES, where),
    maxQueueTicketMultiple: decimal(
      armRaw,
      "maxQueueTicketMultiple",
      POSITIVE,
      where,
    ),
  };
  requireBand(arm.bandLow, arm.bandHigh, where);
  if (arm.kMin > arm.kMax) {
    fail("FAST_CONFIG_OUT_OF_RANGE", `${where}.kMin cannot exceed kMax`);
  }
  // O GTD morre ANTES do fim da janela de entrada; caso contrário a ordem
  // repousaria além do instante em que o braço deixa de querer estar no livro.
  if (arm.gtdUntilK >= arm.kMin) {
    fail(
      "FAST_CONFIG_OUT_OF_RANGE",
      `${where}.gtdUntilK must be strictly below kMin`,
    );
  }
  return arm;
}

function parseArmE(raw: unknown): FastArmEConfig {
  const where = "fast.arms.E";
  const armRaw = record(raw, where);
  rejectUnknownKeys(
    armRaw,
    [
      "mode",
      "kMin",
      "kMax",
      "bandLow",
      "bandHigh",
      "minAbsZ",
      "reversalBuckets",
    ],
    where,
  );
  const arm: FastArmEConfig = {
    mode: mode(armRaw, where),
    kMin: int(armRaw, "kMin", MINUTES, where),
    kMax: int(armRaw, "kMax", MINUTES, where),
    bandLow: decimal(armRaw, "bandLow", PROBABILITY, where),
    bandHigh: decimal(armRaw, "bandHigh", PROBABILITY, where),
    minAbsZ: decimal(armRaw, "minAbsZ", POSITIVE, where),
    reversalBuckets: int(armRaw, "reversalBuckets", COUNT, where),
  };
  requireBand(arm.bandLow, arm.bandHigh, where);
  if (arm.kMin > arm.kMax) {
    fail("FAST_CONFIG_OUT_OF_RANGE", `${where}.kMin cannot exceed kMax`);
  }
  return arm;
}

function parseArmLate(
  raw: unknown,
  where: string,
  extraKeys: readonly string[],
): { readonly base: FastArmLateConfig; readonly raw: Record<string, unknown> } {
  const armRaw = record(raw, where);
  rejectUnknownKeys(
    armRaw,
    [
      "mode",
      "targetK",
      "toleranceS",
      "minMid",
      "askLow",
      "askHigh",
      ...extraKeys,
    ],
    where,
  );
  const base: FastArmLateConfig = {
    mode: mode(armRaw, where),
    targetK: int(armRaw, "targetK", MINUTES, where),
    toleranceS: int(armRaw, "toleranceS", SECONDS, where),
    minMid: decimal(armRaw, "minMid", PROBABILITY, where),
    askLow: decimal(armRaw, "askLow", PROBABILITY, where),
    askHigh: decimal(armRaw, "askHigh", PROBABILITY, where),
  };
  if (Number(base.askLow) >= Number(base.askHigh)) {
    fail(
      "FAST_CONFIG_OUT_OF_RANGE",
      `${where}.askLow must be strictly below ${where}.askHigh`,
    );
  }
  return { base, raw: armRaw };
}

export function parseFastConfig(raw: unknown): FastConfig {
  const top = record(raw, "fast");
  rejectUnknownKeys(
    top,
    [
      "version",
      "universe",
      "signal",
      "preconditions",
      "costs",
      "ticket",
      "arms",
      "limits",
      "criteria",
    ],
    "fast",
  );

  const version = top["version"];
  if (
    typeof version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)
  ) {
    fail("FAST_CONFIG_INVALID", "fast.version must be semver-like");
  }

  const universeRaw = record(top["universe"], "fast.universe");
  rejectUnknownKeys(
    universeRaw,
    ["questionPattern", "windowMinutes"],
    "fast.universe",
  );
  const questionPattern = universeRaw["questionPattern"];
  if (typeof questionPattern !== "string" || questionPattern.length === 0) {
    fail(
      "FAST_CONFIG_INVALID",
      "fast.universe.questionPattern must be a non-empty string",
    );
  }
  // Uma regex que não compila derrubaria o worker no primeiro mercado, não na
  // carga: compile aqui para que o arquivo inválido seja recusado agora.
  try {
    new RegExp(questionPattern);
  } catch {
    fail(
      "FAST_CONFIG_INVALID",
      "fast.universe.questionPattern is not a valid regular expression",
    );
  }
  // A regex ESTRITA da D4 é ancorada nas duas pontas. Sem as âncoras ela
  // aceitaria a série de 15 min ("... 5:00PM-5:15PM ET"), que é justamente o
  // que a `SHORT_SERIES_PATTERN` leniente do registry já faz e que a D4
  // rejeita: 254 dos 643 mercados com esse prefixo em produção (09/09) são de
  // outra série.
  if (!questionPattern.startsWith("^") || !questionPattern.endsWith("$")) {
    fail(
      "FAST_CONFIG_INVALID",
      "fast.universe.questionPattern must be anchored at both ends",
    );
  }
  const universe: FastUniverseConfig = {
    questionPattern,
    windowMinutes: int(universeRaw, "windowMinutes", MINUTES, "fast.universe"),
  };

  const signalRaw = record(top["signal"], "fast.signal");
  rejectUnknownKeys(
    signalRaw,
    ["sigmaBpsPerMin", "tieZoneBps", "tieZoneMaxK"],
    "fast.signal",
  );
  const signal: FastSignalConfig = {
    sigmaBpsPerMin: decimal(
      signalRaw,
      "sigmaBpsPerMin",
      POSITIVE,
      "fast.signal",
    ),
    tieZoneBps: decimal(signalRaw, "tieZoneBps", POSITIVE, "fast.signal"),
    tieZoneMaxK: int(signalRaw, "tieZoneMaxK", MINUTES, "fast.signal"),
  };

  const preRaw = record(top["preconditions"], "fast.preconditions");
  rejectUnknownKeys(
    preRaw,
    [
      "bookMaxAgeS",
      "bookMaxSpread",
      "rtdsMaxSampleAgeS",
      "rtdsNoGapWindowMin",
      "warmupS",
      "minSecondsToEnd",
    ],
    "fast.preconditions",
  );
  const preconditions: FastPreconditionConfig = {
    bookMaxAgeS: int(preRaw, "bookMaxAgeS", SECONDS, "fast.preconditions"),
    bookMaxSpread: decimal(
      preRaw,
      "bookMaxSpread",
      PROBABILITY,
      "fast.preconditions",
    ),
    rtdsMaxSampleAgeS: int(
      preRaw,
      "rtdsMaxSampleAgeS",
      SECONDS,
      "fast.preconditions",
    ),
    rtdsNoGapWindowMin: int(
      preRaw,
      "rtdsNoGapWindowMin",
      MINUTES,
      "fast.preconditions",
    ),
    warmupS: int(preRaw, "warmupS", SECONDS, "fast.preconditions"),
    minSecondsToEnd: int(
      preRaw,
      "minSecondsToEnd",
      SECONDS,
      "fast.preconditions",
    ),
  };

  const costsRaw = record(top["costs"], "fast.costs");
  rejectUnknownKeys(costsRaw, ["assumedTakerFeeRate"], "fast.costs");
  const costs: FastCostConfig = {
    assumedTakerFeeRate: decimal(
      costsRaw,
      "assumedTakerFeeRate",
      FEE_RATE,
      "fast.costs",
    ),
  };

  const ticketRaw = record(top["ticket"], "fast.ticket");
  rejectUnknownKeys(ticketRaw, ["shares", "fakTtlS"], "fast.ticket");
  const ticket: FastTicketConfig = {
    shares: decimal(ticketRaw, "shares", POSITIVE, "fast.ticket"),
    fakTtlS: int(ticketRaw, "fakTtlS", SECONDS, "fast.ticket"),
  };

  const armsRaw = record(top["arms"], "fast.arms");
  rejectUnknownKeys(armsRaw, [...FAST_ARMS], "fast.arms");
  for (const arm of FAST_ARMS) {
    if (armsRaw[arm] === undefined) {
      fail("FAST_CONFIG_MISSING", `fast.arms.${arm} is required`);
    }
  }
  const armA = parseArmLate(armsRaw["A"], "fast.arms.A", []);
  const armD = parseArmLate(armsRaw["D"], "fast.arms.D", ["seed"]);
  const arms: FastArmsConfig = {
    A: armA.base,
    C: parseArmC(armsRaw["C"]),
    D: {
      ...armD.base,
      seed: int(
        armD.raw,
        "seed",
        { min: 0, max: Number.MAX_SAFE_INTEGER },
        "fast.arms.D",
      ),
    },
    E: parseArmE(armsRaw["E"]),
  };

  const limitsRaw = record(top["limits"], "fast.limits");
  rejectUnknownKeys(
    limitsRaw,
    [
      "maxOrdersPerArmPerMarket",
      "maxOpenPositionsPerArm",
      "maxOrdersPerDay",
      "dailyStopUsdPerArm",
      "dailyStopUsdSubAccount",
      "subAccountBankrollUsd",
    ],
    "fast.limits",
  );
  const limits: FastLimitsConfig = {
    maxOrdersPerArmPerMarket: int(
      limitsRaw,
      "maxOrdersPerArmPerMarket",
      COUNT,
      "fast.limits",
    ),
    maxOpenPositionsPerArm: int(
      limitsRaw,
      "maxOpenPositionsPerArm",
      COUNT,
      "fast.limits",
    ),
    maxOrdersPerDay: int(limitsRaw, "maxOrdersPerDay", COUNT, "fast.limits"),
    dailyStopUsdPerArm: decimal(
      limitsRaw,
      "dailyStopUsdPerArm",
      POSITIVE,
      "fast.limits",
    ),
    dailyStopUsdSubAccount: decimal(
      limitsRaw,
      "dailyStopUsdSubAccount",
      POSITIVE,
      "fast.limits",
    ),
    subAccountBankrollUsd: decimal(
      limitsRaw,
      "subAccountBankrollUsd",
      POSITIVE,
      "fast.limits",
    ),
  };
  // O stop de braço não pode passar do stop da sub-carteira: se passasse, o
  // limite maior nunca morderia e a D6 diria uma coisa e o código outra.
  if (
    Number(limits.dailyStopUsdPerArm) > Number(limits.dailyStopUsdSubAccount)
  ) {
    fail(
      "FAST_CONFIG_OUT_OF_RANGE",
      "fast.limits.dailyStopUsdPerArm cannot exceed dailyStopUsdSubAccount",
    );
  }

  const criteriaRaw = record(top["criteria"], "fast.criteria");
  rejectUnknownKeys(
    criteriaRaw,
    [
      "pauseMinN",
      "pauseHitRateGapPoints",
      "stopMinN",
      "dailyStopStrikes",
      "dailyStopStrikeWindowDays",
      "promoteMinN",
      "promoteTicketShares",
      "promoteMaxPValue",
      "promoteReplayMaxDeviationPct",
      "endAfterDays",
      "endAfterMarketsPerArm",
    ],
    "fast.criteria",
  );
  const criteria: FastCriteriaConfig = {
    pauseMinN: int(criteriaRaw, "pauseMinN", COUNT, "fast.criteria"),
    pauseHitRateGapPoints: decimal(
      criteriaRaw,
      "pauseHitRateGapPoints",
      POSITIVE,
      "fast.criteria",
    ),
    stopMinN: int(criteriaRaw, "stopMinN", COUNT, "fast.criteria"),
    dailyStopStrikes: int(
      criteriaRaw,
      "dailyStopStrikes",
      COUNT,
      "fast.criteria",
    ),
    dailyStopStrikeWindowDays: int(
      criteriaRaw,
      "dailyStopStrikeWindowDays",
      COUNT,
      "fast.criteria",
    ),
    promoteMinN: int(criteriaRaw, "promoteMinN", COUNT, "fast.criteria"),
    promoteTicketShares: decimal(
      criteriaRaw,
      "promoteTicketShares",
      POSITIVE,
      "fast.criteria",
    ),
    promoteMaxPValue: decimal(
      criteriaRaw,
      "promoteMaxPValue",
      PROBABILITY,
      "fast.criteria",
    ),
    promoteReplayMaxDeviationPct: decimal(
      criteriaRaw,
      "promoteReplayMaxDeviationPct",
      POSITIVE,
      "fast.criteria",
    ),
    endAfterDays: int(criteriaRaw, "endAfterDays", COUNT, "fast.criteria"),
    endAfterMarketsPerArm: int(
      criteriaRaw,
      "endAfterMarketsPerArm",
      COUNT,
      "fast.criteria",
    ),
  };
  // Parar exige mais evidência que pausar, e promover mais que parar. Invertida
  // qualquer das duas, um braço poderia ser promovido com menos observações do
  // que as que o pausariam.
  if (criteria.pauseMinN > criteria.stopMinN) {
    fail(
      "FAST_CONFIG_OUT_OF_RANGE",
      "fast.criteria.pauseMinN cannot exceed stopMinN",
    );
  }
  if (criteria.stopMinN > criteria.promoteMinN) {
    fail(
      "FAST_CONFIG_OUT_OF_RANGE",
      "fast.criteria.stopMinN cannot exceed promoteMinN",
    );
  }
  if (Number(criteria.promoteTicketShares) < Number(ticket.shares)) {
    fail(
      "FAST_CONFIG_OUT_OF_RANGE",
      "fast.criteria.promoteTicketShares cannot be below fast.ticket.shares",
    );
  }

  return {
    version,
    universe,
    signal,
    preconditions,
    costs,
    ticket,
    arms,
    limits,
    criteria,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Hash de TUDO que a config declara.
 *
 * `portfolioConfigHash` exclui as cadências de propósito, porque elas mudam
 * quando o motor roda e não o que ele decide. Aqui não há o que excluir: a
 * cadência do worker `fast` é env do container (PR 3), não campo do arquivo, e
 * todo campo desta config entra em alguma decisão. Excluir qualquer um seria
 * abrir a porta para dois arquivos diferentes com o mesmo hash.
 */
export function fastConfigHash(config: FastConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(config)))
    .digest("hex");
}

export interface LoadFastConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly readTextFile?: (path: string) => Promise<string>;
}

/**
 * Carrega a config. Env var ausente é ERRO, não default: ver o cabeçalho.
 */
export async function loadFastConfig(
  options: LoadFastConfigOptions = {},
): Promise<FastConfig> {
  const env = options.env ?? process.env;
  const path = env[FAST_CONFIG_FILE_ENV];
  if (path === undefined || path === "") {
    throw new FastConfigError(
      "FAST_CONFIG_FILE_UNSET",
      `${FAST_CONFIG_FILE_ENV} is required: the fast strategy has no default configuration`,
    );
  }
  const readTextFile =
    options.readTextFile ?? ((file: string) => readFile(file, "utf8"));
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    throw new FastConfigError(
      "FAST_CONFIG_FILE_UNREADABLE",
      "configured fast config file could not be read",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new FastConfigError(
      "FAST_CONFIG_FILE_INVALID_JSON",
      "fast config file is not valid JSON",
    );
  }
  return parseFastConfig(parsed);
}
