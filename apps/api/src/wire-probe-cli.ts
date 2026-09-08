// RFC-024 D1: the wire proof, run from inside the recorder image.
//
// The recorder resubscribes by sending a fresh `subscribe` frame on a live
// socket (`dualws.ts` `resubscribe`). Measured on 02-03/09/2026, 19 of 27
// tokens that entered the universe NEVER received a `book` afterwards. This
// CLI decides whether the frame is the cause, before a single line of the
// recorder changes.
//
// Run it in the same image as the collector, WITHOUT touching the collector:
//
//   docker compose run --rm --no-deps polymarket-recorder \
//     node apps/api/dist/wire-probe-cli.js --rounds 3
//
// `run --rm --no-deps` starts a throwaway container; `exec` would need the
// recorder up and would share its process. The path is `apps/api/dist/...`
// because the image's WORKDIR is the repository root.
//
// NO DATABASE. This file and `wireprobe.ts` never import `database.ts`, `pg`,
// or `config.ts`, and never read GANSO_CONFIG_FILE or
// GANSO_POSTGRES_PASSWORD_FILE — both of which the `polymarket-recorder`
// service sets. The probe therefore behaves identically with them present or
// absent, which is what `wireprobe.test.ts` asserts. Output is stdout only.
//
// SIMULAÇÃO — public market data, read-only. No order, no auth, no write.

import { WebSocket } from "ws";

import {
  PROBE_MARKET_WS_URL,
  listHourlySeries,
  projectVolumetry,
  runProbeRound,
  type ProbeFetcher,
  type ProbeRoundResult,
  type ProbeSocket,
  type ProbeVariant,
} from "./polymarket/wireprobe.js";

// Polymarket sits behind Cloudflare, which rejects non-browser-like clients.
const USER_AGENT = "GansoMarketRecorder/1.0 (+public-data-recorder)";
const WEB_ORIGIN = "https://polymarket.com";

/** Measured 2026-09-08 and in decision #88: bytes per book_deltas row. */
const BYTES_PER_DELTA_ROW = 313.67;

const USAGE = `RFC-024 D1 — prova no fio do resubscribe (somente leitura)

  node apps/api/dist/wire-probe-cli.js [--rounds N] [--baseline-token ID]
                                       [--new-token ID] [--fast]

  --rounds N          rodadas por variante (padrao 3; a RFC pede 3 em horas
                      distintas, cada uma nas duas variantes)
  --baseline-token    token ja no universo para a linha-base de A; por padrao
                      o do horario BTC mais proximo do fim
  --new-token         token novo a assinar em A; por padrao o token Up do
                      horario BTC em curso (T-30..T-60)
  --fast              janelas curtas (para fumaca; NAO e a prova da RFC)

Saida: uma tabela por rodada em stdout, mais o bloco de volumetria. Rodada sem
controle positivo sai como INVALID e nao conta como resultado.`;

function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function nodeProbeSocket(url: string): ProbeSocket {
  const socket = new WebSocket(url, {
    headers: { "user-agent": USER_AGENT, origin: WEB_ORIGIN },
  });
  return {
    onOpen(handler): void {
      socket.on("open", handler);
    },
    onMessage(handler): void {
      socket.on("message", (data: unknown) => {
        handler(String(data));
      });
    },
    onClose(handler): void {
      socket.on("close", handler);
    },
    onError(handler): void {
      socket.on("error", handler);
    },
    send(data): void {
      try {
        socket.send(data);
      } catch {
        // A send on a socket the venue already closed is not a result.
      }
    },
    close(): void {
      try {
        socket.close();
      } catch {
        // Closing an already-dead socket must not throw.
      }
    },
  };
}

const fetcher: ProbeFetcher = async (input, init) => {
  const response = await fetch(input, {
    headers: { ...(init?.headers ?? {}), "user-agent": USER_AGENT },
  });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json() as Promise<unknown>,
  };
};

function row(result: ProbeRoundResult, index: number): string {
  const cells = [
    String(index + 1),
    result.variant,
    result.startedAt,
    result.verdict,
    result.msToBookOnA === null ? "nunca" : `${String(result.msToBookOnA)} ms`,
    result.baselineStillFlowingOnA
      ? `sim (${String(result.baselineFramesAfterExtra)} frames)`
      : "NAO",
    result.msToBookOnB === null ? "-" : `${String(result.msToBookOnB)} ms`,
    result.priceChangePerMinuteOnB === null
      ? "-"
      : String(result.priceChangePerMinuteOnB),
    result.invalidReason ?? "",
  ];
  return `| ${cells.join(" | ")} |`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const rounds = Number(flag(argv, "--rounds") ?? "3");
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
    process.stdout.write("ERRO: --rounds deve ser inteiro entre 1 e 10\n");
    return 2;
  }
  const fast = argv.includes("--fast");
  const windows = fast
    ? {
        baselineBookTimeoutMs: 5_000,
        extraFrameDelayMs: 5_000,
        newBookTimeoutMs: 15_000,
        controlTimeoutMs: 5_000,
        rateWindowMs: 30_000,
      }
    : {
        baselineBookTimeoutMs: 5_000,
        extraFrameDelayMs: 60_000,
        newBookTimeoutMs: 120_000,
        controlTimeoutMs: 5_000,
        rateWindowMs: 600_000,
      };

  process.stdout.write("RFC-024 D1 — prova no fio do resubscribe\n");
  process.stdout.write(`url: ${PROBE_MARKET_WS_URL}\n`);
  process.stdout.write(`iniciado: ${new Date().toISOString()}\n`);
  process.stdout.write(
    `janelas: baseline ${String(windows.baselineBookTimeoutMs)} ms, ` +
      `frame extra em ${String(windows.extraFrameDelayMs)} ms, ` +
      `book em A ate ${String(windows.newBookTimeoutMs)} ms, ` +
      `taxa ${String(windows.rateWindowMs)} ms` +
      `${fast ? "  [--fast: NAO e a prova da RFC]" : ""}\n\n`,
  );

  const series = await listHourlySeries(fetcher, Date.now());
  const live = series.filter((entry) => entry.minutesToEnd > 0);
  process.stdout.write(
    `serie horaria (GET /events?series_id=10114&closed=false): ` +
      `${String(series.length)} slugs casando a regex, ` +
      `${String(live.length)} com fim no futuro\n`,
  );
  for (const entry of live.slice(0, 4)) {
    process.stdout.write(
      `  ${entry.slug}  fim em ${String(Math.round(entry.minutesToEnd))} min  ` +
        `tokens ${String(entry.tokenIds.length)}\n`,
    );
  }

  // Baseline: the hourly closest to its end is the one actually trading, so
  // its tokens are the ones already flowing on the wire.
  const baselineEntry = live[0];
  const baselineTokenIds =
    flag(argv, "--baseline-token") !== null
      ? [flag(argv, "--baseline-token") as string]
      : (baselineEntry?.tokenIds.slice(0, 2) ?? []);
  const baselineTokens = new Set(baselineTokenIds);

  // The new token has to come from a DIFFERENT market. Measured on
  // 2026-09-08: picking "the first entry between 30 and 75 min" selected the
  // baseline market itself, so the probe subscribed a token it already had,
  // saw its book from the baseline phase, and reported BOOK_ON_A with
  // msToBookOnA = -59999 ms — a tautology dressed as a refutation of H1.
  const newEntry =
    flag(argv, "--new-token") !== null
      ? undefined
      : live.find(
          (entry) =>
            entry.conditionId !== baselineEntry?.conditionId &&
            !entry.tokenIds.some((id) => baselineTokens.has(id)),
        );
  const newTokenId = flag(argv, "--new-token") ?? newEntry?.tokenIds[0] ?? null;

  if (
    baselineTokenIds.length === 0 ||
    newTokenId === null ||
    baselineTokens.has(newTokenId)
  ) {
    process.stdout.write(
      "\nINVALID: a serie nao ofereceu linha-base e token novo de mercados " +
        "DISTINTOS\n",
    );
    return 3;
  }
  process.stdout.write(
    `\nlinha-base: ${baselineEntry?.slug ?? "(argumento)"} ` +
      `fim em ${String(Math.round(baselineEntry?.minutesToEnd ?? 0))} min ` +
      `(${String(baselineTokenIds.length)} tokens)\n` +
      `token novo: ${newEntry?.slug ?? "(argumento)"} ` +
      `fim em ${String(Math.round(newEntry?.minutesToEnd ?? 0))} min\n\n`,
  );

  const variants: ProbeVariant[] = ["only_new", "old_plus_new"];
  const results: ProbeRoundResult[] = [];
  process.stdout.write(
    "| # | variante | inicio | veredito | book em A | antigos seguem em A | book em B | price_change/min em B | motivo do INVALID |\n" +
      "| - | --- | --- | --- | --- | --- | --- | --- | --- |\n",
  );
  for (let round = 0; round < rounds; round += 1) {
    for (const variant of variants) {
      const result = await runProbeRound(
        { baselineTokenIds, newTokenId, variant, ...windows },
        {
          socketFactory: nodeProbeSocket,
          clock: () => Date.now(),
          setTimer: (run, delayMs) => setTimeout(run, delayMs),
        },
      );
      results.push(result);
      process.stdout.write(`${row(result, results.length - 1)}\n`);
    }
  }

  const valid = results.filter((entry) => entry.verdict !== "INVALID");
  process.stdout.write(
    `\nrodadas validas: ${String(valid.length)} de ${String(results.length)}\n`,
  );
  if (valid.length === 0) {
    process.stdout.write(
      "VEREDITO: INVALID — sem controle positivo, a hipotese H1 nao foi testada.\n" +
        "RFC-024: nao codar o PR 3 por hipotese.\n",
    );
    return 4;
  }
  const never = valid.filter((entry) => entry.verdict === "NEVER_ON_A").length;
  process.stdout.write(
    `H1 (o frame extra NAO entrega livro): ${String(never)} de ` +
      `${String(valid.length)} rodadas validas\n`,
  );
  const sums = valid.filter((entry) => entry.baselineStillFlowingOnA).length;
  process.stdout.write(
    `o frame SOMA (antigos seguem fluindo): ${String(sums)} de ` +
      `${String(valid.length)}; SUBSTITUI: ` +
      `${String(valid.length - sums)} de ${String(valid.length)}\n`,
  );

  const rates = valid
    .map((entry) => entry.priceChangePerMinuteOnB)
    .filter((value): value is number => value !== null && value > 0);
  if (rates.length > 0) {
    const median = [...rates].sort((a, b) => a - b)[
      Math.floor(rates.length / 2)
    ] as number;
    const projection = projectVolumetry({
      perMinutePerToken: median,
      tokensPerMarket: 2,
      minutesPerMarket: 65,
      marketsPerDay: 24,
      bytesPerRow: BYTES_PER_DELTA_ROW,
    });
    process.stdout.write(
      `\nVOLUMETRIA (P2), da taxa medida em B\n` +
        `  price_change/min por token (mediana de ${String(rates.length)}): ${String(median)}\n` +
        `  assuncao: 1 price_change = 1 linha de polymarket_book_deltas a ${String(BYTES_PER_DELTA_ROW)} B\n` +
        `  incremento: 2 tokens x 65 min x 24 mercados/dia = ` +
        `${String(projection.rowsPerDay)} linhas/dia = ` +
        `${String(projection.gibPerDay)} GiB/dia (${String(projection.gbPerDay)} GB/dia)\n`,
    );
  } else {
    process.stdout.write(
      "\nVOLUMETRIA: sem price_change medido em B — nao projetar.\n",
    );
  }
  process.stdout.write(`\nterminado: ${new Date().toISOString()}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stdout.write(
      `ERRO: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
