// RFC-028 D7 / PR 1: o backtest AUDITADO do filtro z, em CLI read-only.
//
// Um CLI e não um endpoint, pelo mesmo motivo do `shadow-replay-cli`: isto lê a
// série de preços inteira e os rótulos, e o perímetro da RFC-013 publica
// superfícies GET-only. Uma rota que despeje a série toda para quem alcança a
// borda é uma superfície que não vale a pena ter.
//
// Rodar dentro do container da API:
//
//   docker exec ganso-market-api-1 node apps/api/dist/fast-backtest-cli.js
//
// Flags: --arms A,C,D,E  --ks 4,6,8,10,12  --sigma 5  --limit 400
//        --min-abs-z 0  --json
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL. Este programa não decide e não escreve: o pool
// passa por `readOnlyPool`, que recusa qualquer statement que não seja leitura
// e abre a transação com SET TRANSACTION READ ONLY. O número que ele produz é
// insumo da condição de parada da RFC-028, não uma decisão.

import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { errorFields } from "./errors.js";
import {
  FAST_CONFIG_FILE_ENV,
  FastConfigError,
  fastConfigHash,
  loadFastConfig,
  parseFastConfig,
  type FastArm,
  type FastConfig,
} from "./polymarket/paper/fastconfig.js";
import {
  runBacktest,
  type BacktestFeedPoint,
  type BacktestMarket,
  type BacktestQuote,
} from "./polymarket/paper/fastbacktest.js";
import { readOnlyPool } from "./polymarket/portfolio/sweepstore.js";

const DEFAULT_ARMS: readonly FastArm[] = ["A", "C", "D", "E"];
const DEFAULT_KS: readonly number[] = [4, 5, 6, 8, 10, 12];
const DEFAULT_LIMIT = 400;

class CliError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "CliError";
    this.reasonCode = reasonCode;
  }
}

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function parseArms(raw: string | null): readonly FastArm[] {
  if (raw === null) {
    return DEFAULT_ARMS;
  }
  const arms = raw.split(",").map((part) => part.trim().toUpperCase());
  for (const arm of arms) {
    if (!DEFAULT_ARMS.includes(arm as FastArm)) {
      throw new CliError("INVALID_ARM", `unknown arm: ${arm}`);
    }
  }
  return arms as readonly FastArm[];
}

function parseKs(raw: string | null): readonly number[] {
  if (raw === null) {
    return DEFAULT_KS;
  }
  const ks = raw.split(",").map((part) => Number(part.trim()));
  for (const k of ks) {
    if (!Number.isInteger(k) || k <= 0 || k > 60) {
      throw new CliError(
        "INVALID_K",
        `k must be an integer in [1, 60]: ${String(k)}`,
      );
    }
  }
  return ks;
}

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function instant(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

interface MarketRow extends Row {
  condition_id: string;
  question: string;
  end_ts: Date | string;
  tick_size: string | null;
  affirmative_token_id: string;
  complement_token_id: string | null;
  affirmative_won: boolean;
}

/**
 * O universo: a regex ESTRITA da config, `end_ts` no passado e rótulo final do
 * token afirmativo.
 *
 * `end_ts` e não `end_date_iso`: medido em 09/09/2026, `end_date_iso` é uma
 * DATA ('2026-09-09'), não um instante — derivar o fim dela daria meia-noite
 * UTC para todo mercado do dia e mediria o instante errado em 23 de 24 casos.
 * O preço disso é o denominador: 183 dos 389 mercados da série horária têm
 * `end_ts`, e é sobre esses 183 que o backtest fala.
 */
async function loadMarkets(
  pool: {
    query: <R extends Row>(
      text: string,
      params?: readonly unknown[],
    ) => Promise<{ rows: R[] }>;
  },
  config: FastConfig,
  limit: number,
): Promise<readonly BacktestMarket[]> {
  const markets = await pool.query<MarketRow>(
    `SELECT m.condition_id,
            m.question,
            m.end_ts,
            m.tick_size,
            m.affirmative_token_id,
            (SELECT t.value #>> '{}'
               FROM jsonb_array_elements(m.clob_token_ids) AS t(value)
              WHERE t.value #>> '{}' <> m.affirmative_token_id
              LIMIT 1) AS complement_token_id,
            (l.label = '1') AS affirmative_won
       FROM polymarket_markets m
       JOIN fundamental_labels l
         ON l.token_id = m.affirmative_token_id AND l.is_final
      WHERE m.question ~ $1
        AND m.end_ts IS NOT NULL
        AND m.end_ts < now()
        AND m.affirmative_token_id IS NOT NULL
      ORDER BY m.end_ts DESC
      LIMIT $2`,
    [config.universe.questionPattern, limit],
  );

  const out: BacktestMarket[] = [];
  for (const row of markets.rows) {
    const endTs = instant(row.end_ts);
    if (endTs === null) {
      continue;
    }
    const openTs = new Date(
      endTs.getTime() - config.universe.windowMinutes * 60_000,
    );
    const affirmativeTokenId = row.affirmative_token_id;
    const complementTokenId = text(row.complement_token_id);
    const [affirmativeQuotes, complementQuotes, twap30, twap60] =
      await Promise.all([
        loadQuotes(pool, affirmativeTokenId, openTs, endTs),
        complementTokenId === null
          ? Promise.resolve([] as readonly BacktestQuote[])
          : loadQuotes(pool, complementTokenId, openTs, endTs),
        loadFeed(pool, "twap30", openTs, endTs),
        loadFeed(pool, "twap60", openTs, endTs),
      ]);
    out.push({
      conditionId: row.condition_id,
      question: row.question,
      openTs,
      endTs,
      tickSize: text(row.tick_size) ?? "0.01",
      affirmativeTokenId,
      complementTokenId,
      affirmativeWon: row.affirmative_won === true,
      affirmativeQuotes,
      complementQuotes,
      twap30,
      twap60,
    });
  }
  return out;
}

async function loadQuotes(
  pool: {
    query: <R extends Row>(
      text: string,
      params?: readonly unknown[],
    ) => Promise<{ rows: R[] }>;
  },
  tokenId: string,
  from: Date,
  to: Date,
): Promise<readonly BacktestQuote[]> {
  const result = await pool.query<Row>(
    `SELECT bucket_start, best_bid, best_ask
       FROM polymarket_series_1m
      WHERE token_id = $1
        AND bucket_start >= $2
        AND bucket_start <= $3
        AND best_bid IS NOT NULL
        AND best_ask IS NOT NULL
      ORDER BY bucket_start`,
    [tokenId, from, to],
  );
  const quotes: BacktestQuote[] = [];
  for (const row of result.rows) {
    const bucketStart = instant(row["bucket_start"]);
    const bestBid = text(row["best_bid"]);
    const bestAsk = text(row["best_ask"]);
    if (bucketStart === null || bestBid === null || bestAsk === null) {
      continue;
    }
    quotes.push({ bucketStart, bestBid, bestAsk });
  }
  return quotes;
}

async function loadFeed(
  pool: {
    query: <R extends Row>(
      text: string,
      params?: readonly unknown[],
    ) => Promise<{ rows: R[] }>;
  },
  feed: string,
  from: Date,
  to: Date,
): Promise<readonly BacktestFeedPoint[]> {
  // Um balde a mais de cada lado: `S_t` é o balde ANTERIOR à decisão, e a
  // reversão olha três baldes atrás.
  const result = await pool.query<Row>(
    `SELECT bucket_start, open, close
       FROM polymarket_rtds_1m
      WHERE feed = $1
        AND symbol = 'btc/usd'
        AND bucket_start >= $2::timestamptz - INTERVAL '5 minutes'
        AND bucket_start <= $3
      ORDER BY bucket_start`,
    [feed, from, to],
  );
  const points: BacktestFeedPoint[] = [];
  for (const row of result.rows) {
    const bucketStart = instant(row["bucket_start"]);
    const open = text(row["open"]);
    const close = text(row["close"]);
    if (bucketStart === null || open === null || close === null) {
      continue;
    }
    points.push({ bucketStart, open, close });
  }
  return points;
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width
    ? value
    : " ".repeat(width - value.length) + value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");

  // A config congelada. Sem ela o backtest não sabe qual universo medir, e
  // inventar um default aqui seria medir uma estratégia que ninguém congelou.
  let fast: FastConfig;
  if (process.env[FAST_CONFIG_FILE_ENV] === undefined) {
    // O PR 1 não monta o arquivo em container nenhum (isso é o PR 3), então o
    // caminho do repositório é o default DESTE CLI — e só dele.
    const { readFile } = await import("node:fs/promises");
    const path = flagValue(argv, "--config") ?? "config/fast.json";
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new CliError(
        "FAST_CONFIG_UNREADABLE",
        `could not read ${path}; pass --config or set ${FAST_CONFIG_FILE_ENV}`,
      );
    }
    fast = parseFastConfig(JSON.parse(raw) as unknown);
  } else {
    fast = await loadFastConfig();
  }

  const arms = parseArms(flagValue(argv, "--arms"));
  const ks = parseKs(flagValue(argv, "--ks"));
  const sigmaRaw = flagValue(argv, "--sigma");
  const sigma =
    sigmaRaw === null ? Number(fast.signal.sigmaBpsPerMin) : Number(sigmaRaw);
  if (!(sigma > 0)) {
    throw new CliError("INVALID_SIGMA", "--sigma must be positive");
  }
  const limitRaw = flagValue(argv, "--limit");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 5_000) {
    throw new CliError(
      "INVALID_LIMIT",
      "--limit must be an integer in [1, 5000]",
    );
  }
  const minAbsZRaw = flagValue(argv, "--min-abs-z");
  const minAbsZ =
    minAbsZRaw === null
      ? undefined
      : Object.fromEntries(
          DEFAULT_ARMS.map((arm) => [arm, Number(minAbsZRaw)]),
        );

  const config = await loadConfig();
  // Uma passada lê a série de minuto de centenas de mercados; o timeout de
  // consulta default da API abortaria a varredura no meio e reportaria uma
  // população truncada como se fosse a janela.
  const database = createDatabasePool(config, {
    max: 2,
    queryTimeoutMs: 120_000,
    applicationName: "ganso-fast-backtest",
  });
  const pool = readOnlyPool(database);
  try {
    const markets = await loadMarkets(pool, fast, limit);
    const report = runBacktest(markets, {
      config: fast,
      arms,
      ks,
      sigmaBpsPerMin: sigma,
      ...(minAbsZ === undefined ? {} : { minAbsZ }),
    });

    if (asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            fast_config_version: fast.version,
            fast_config_hash: fastConfigHash(fast),
            sigma_bps_per_min: sigma,
            arms,
            ks,
            report: { ...report, observations: report.observations.length },
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const lines: string[] = [];
    lines.push("RFC-028 D7 — backtest do filtro z (SIMULAÇÃO, read-only)");
    lines.push(
      `config ${fast.version} hash ${fastConfigHash(fast).slice(0, 16)}… | σ ${String(sigma)} bps/min`,
    );
    lines.push(
      `mercados: ${String(report.marketsConsidered)} considerados, ${String(report.marketsWithS0)} com S0, ${String(report.marketsWithQuote)} com cotação`,
    );
    lines.push("");
    lines.push("σ REALIZADO (bps/min)");
    lines.push(
      `  ${pad("feed", 8)}${padLeft("amostras", 10)}${padLeft("σ", 10)}${padLeft("|r| mediano", 14)}`,
    );
    for (const sigmaRow of report.sigma) {
      lines.push(
        `  ${pad(sigmaRow.feed, 8)}${padLeft(String(sigmaRow.samples), 10)}${padLeft(sigmaRow.bpsPerMin.toFixed(3), 10)}${padLeft(sigmaRow.medianAbsBpsPerMin.toFixed(3), 14)}`,
      );
    }
    lines.push("");
    lines.push(
      "REVERSÃO DE z (sinal diferente em algum dos 3 baldes anteriores)",
    );
    lines.push(
      `  ${padLeft("k", 4)}${padLeft("instantes", 11)}${padLeft("reversões", 11)}${padLeft("taxa", 9)}`,
    );
    for (const reversal of report.reversals) {
      lines.push(
        `  ${padLeft(String(reversal.k), 4)}${padLeft(String(reversal.instants), 11)}${padLeft(String(reversal.reversals), 11)}${padLeft(reversal.rate.toFixed(3), 9)}`,
      );
    }
    lines.push("");
    lines.push(
      "GRADE braço × banda × k — PnL/cota LÍQUIDO, IC95 bootstrap por mercado",
    );
    lines.push(
      `  ${pad("braço", 6)}${padLeft("k", 4)}  ${pad("banda", 13)}${padLeft("N", 5)}${padLeft("PnL/cota", 11)}${padLeft("IC95 inf", 11)}${padLeft("IC95 sup", 11)}${padLeft("acerto", 9)}${padLeft("entrada", 10)}`,
    );
    for (const cell of report.cells) {
      lines.push(
        `  ${pad(cell.arm, 6)}${padLeft(String(cell.k), 4)}  ${pad(cell.bandLabel, 13)}${padLeft(String(cell.n), 5)}${padLeft(cell.meanPnlPerShare.toFixed(4), 11)}${padLeft(cell.ciLow.toFixed(4), 11)}${padLeft(cell.ciHigh.toFixed(4), 11)}${padLeft(cell.hitRate.toFixed(3), 9)}${padLeft(cell.meanEntry.toFixed(4), 10)}`,
      );
    }
    if (report.cells.length === 0) {
      lines.push("  (nenhuma célula com observação preenchida)");
    }
    lines.push("");
    lines.push("POR QUE CADA INSTANTE FOI DESCARTADO");
    for (const [reason, count] of Object.entries(report.skipped).sort(
      ([, a], [, b]) => b - a,
    )) {
      lines.push(`  ${pad(reason, 20)}${padLeft(String(count), 8)}`);
    }
    lines.push("");
    lines.push(
      "DIREÇÃO DO BRAÇO E (a proposta mediu +0,055/cota em 28 obs., IC incluindo zero)",
    );
    const eCells = report.cells.filter((cell) => cell.arm === "E");
    if (eCells.length === 0) {
      lines.push("  braço E sem célula preenchida: direção NÃO reproduzida");
    } else {
      const totalN = eCells.reduce((sum, cell) => sum + cell.n, 0);
      const weighted =
        eCells.reduce((sum, cell) => sum + cell.meanPnlPerShare * cell.n, 0) /
        totalN;
      lines.push(
        `  N total ${String(totalN)} | PnL/cota ponderado ${weighted.toFixed(4)} | ${weighted > 0 ? "direção REPRODUZIDA (positiva)" : "direção NÃO reproduzida (não positiva)"}`,
      );
    }
    const anyPositiveUpper = report.cells.some((cell) => cell.ciHigh >= 0);
    lines.push(
      `  IC95 superior >= 0 em alguma célula: ${anyPositiveUpper ? "SIM" : "NÃO — parada da RFC-028"}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  if (
    error instanceof CliError ||
    error instanceof FastConfigError ||
    error instanceof ConfigError
  ) {
    process.stderr.write(
      `${JSON.stringify({ error: error.name, ...errorFields(error) })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${JSON.stringify(errorFields(error))}\n`);
  process.exitCode = 1;
});
