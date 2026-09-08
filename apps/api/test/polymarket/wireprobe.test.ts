import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { subscribeMessage } from "../../src/polymarket/recorder.js";
import {
  HOURLY_SERIES_ID,
  HOURLY_SERIES_SLUG_PATTERN,
  listHourlySeries,
  parseProbeFrame,
  parseTokenIds,
  probeSubscribeFrame,
  projectVolumetry,
  runProbeRound,
  type ProbeFetcher,
  type ProbeSocket,
} from "../../src/polymarket/wireprobe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../src");

/**
 * The 24 real hourly slugs of a day, plus every neighbouring form the venue
 * publishes, captured live from Gamma on 2026-09-08 (RFC-024 D2). The regex
 * has to take the 24 and refuse all the rest.
 */
const HOURLY_SLUGS = [
  "bitcoin-up-or-down-september-8-2026-12am-et",
  "bitcoin-up-or-down-september-8-2026-1am-et",
  "bitcoin-up-or-down-september-8-2026-2am-et",
  "bitcoin-up-or-down-september-8-2026-3am-et",
  "bitcoin-up-or-down-september-8-2026-4am-et",
  "bitcoin-up-or-down-september-8-2026-5am-et",
  "bitcoin-up-or-down-september-8-2026-6am-et",
  "bitcoin-up-or-down-september-8-2026-7am-et",
  "bitcoin-up-or-down-september-8-2026-8am-et",
  "bitcoin-up-or-down-september-8-2026-9am-et",
  "bitcoin-up-or-down-september-8-2026-10am-et",
  "bitcoin-up-or-down-september-8-2026-11am-et",
  "bitcoin-up-or-down-september-8-2026-12pm-et",
  "bitcoin-up-or-down-september-8-2026-1pm-et",
  "bitcoin-up-or-down-september-8-2026-2pm-et",
  "bitcoin-up-or-down-september-8-2026-3pm-et",
  "bitcoin-up-or-down-september-8-2026-4pm-et",
  "bitcoin-up-or-down-september-8-2026-5pm-et",
  "bitcoin-up-or-down-september-8-2026-6pm-et",
  "bitcoin-up-or-down-september-8-2026-7pm-et",
  "bitcoin-up-or-down-september-8-2026-8pm-et",
  "bitcoin-up-or-down-september-8-2026-9pm-et",
  "bitcoin-up-or-down-september-8-2026-10pm-et",
  "bitcoin-up-or-down-september-8-2026-11pm-et",
];

const NON_HOURLY_SLUGS = [
  // 5 min / 15 min / 4 h: a different slug scheme entirely.
  "btc-updown-5m-1788807600",
  "btc-updown-15m-1788827400",
  "btc-updown-4h-1788811200",
  // The daily, which shares the prefix and is separated by `-on-`.
  "bitcoin-up-or-down-on-september-7-2026",
  // Other assets in the same family.
  "ethereum-up-or-down-september-8-2026-3pm-et",
  // Shapes the old SHORT_SERIES_PATTERN would have matched.
  "bitcoin-up-or-down-september-8-2026-3pm-et-resolved",
  "bitcoin-up-or-down-september-8-2026-13pm-et",
  "bitcoin-up-or-down-sept-8-2026-3pm-et",
];

class FakeProbeSocket implements ProbeSocket {
  public readonly sent: string[] = [];
  public closed = false;
  #open: (() => void) | null = null;
  #message: ((raw: string) => void) | null = null;
  #close: (() => void) | null = null;
  #error: ((error: unknown) => void) | null = null;

  public onOpen(handler: () => void): void {
    this.#open = handler;
  }
  public onMessage(handler: (raw: string) => void): void {
    this.#message = handler;
  }
  public onClose(handler: () => void): void {
    this.#close = handler;
  }
  public onError(handler: (error: unknown) => void): void {
    this.#error = handler;
  }
  public send(data: string): void {
    this.sent.push(data);
  }
  public close(): void {
    this.closed = true;
    this.#close?.();
  }
  public fireOpen(): void {
    this.#open?.();
  }
  public deliver(raw: string): void {
    this.#message?.(raw);
  }
  public fail(error: unknown): void {
    this.#error?.(error);
  }
}

function bookFrame(assetId: string): string {
  return JSON.stringify([
    { event_type: "book", asset_id: assetId, market: "0xm", hash: "h" },
  ]);
}

function priceChangeFrame(assetId: string): string {
  return JSON.stringify([
    { event_type: "price_change", asset_id: assetId, market: "0xm" },
  ]);
}

/**
 * A deterministic clock plus a timer queue: `setTimer` records the callback,
 * and `advance` fires everything due, moving the clock as it goes. Without
 * this the round's 60 s / 120 s / 600 s waits would be real seconds.
 */
function fakeTimers(startMs = 1_000_000) {
  let nowMs = startMs;
  let pending: Array<{ at: number; seq: number; run: () => void }> = [];
  let seq = 0;
  // Each timer fired hands control back to an async continuation that may
  // register the NEXT timer, so a single microtask turn is not enough: the
  // queue has to be re-checked after draining, or the round's 60 s wait is
  // never registered and the whole chain stalls.
  const drain = async (): Promise<void> => {
    for (let turn = 0; turn < 50; turn += 1) {
      await Promise.resolve();
    }
  };
  return {
    clock: (): number => nowMs,
    setTimer: (run: () => void, delayMs: number): unknown => {
      seq += 1;
      pending.push({ at: nowMs + delayMs, seq, run });
      return null;
    },
    /** Run every timer due within `byMs`, in due order, draining between. */
    async advance(byMs: number): Promise<void> {
      const target = nowMs + byMs;
      await drain();
      for (;;) {
        pending.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.seq - b.seq));
        const next = pending[0];
        if (next === undefined || next.at > target) {
          break;
        }
        pending = pending.slice(1);
        nowMs = Math.max(nowMs, next.at);
        next.run();
        await drain();
      }
      nowMs = target;
      await drain();
    },
  };
}

describe("RFC-024 D1 — o CLI da prova no fio nao tem banco", () => {
  // The RFC's stop condition in code form: the probe runs in the recorder
  // image, where GANSO_CONFIG_FILE and GANSO_POSTGRES_PASSWORD_FILE are set.
  // If it reached database.ts it would try to connect, and a probe that needs
  // the database is not a probe that can run without touching collection.
  //
  // The assertion is on the IMPORT SPECIFIERS, not on the file text: the two
  // files name `database.ts` and `pg` in their comments precisely to explain
  // why they do not import them, and a grep over raw text would flunk the
  // explanation instead of the dependency.
  const FORBIDDEN_MODULES = ["pg", "pg-pool", "postgres"];
  const FORBIDDEN_LOCAL = /(?:^|\/)(database|config)\.(?:js|ts)$/;

  interface Module {
    readonly source: string;
    readonly specifiers: readonly string[];
  }

  function importSpecifiers(source: string): string[] {
    const out: string[] = [];
    // `import ... from "x"`, bare `import "x"`, `export ... from "x"`, and
    // dynamic `import("x")` — every form that creates a runtime edge.
    const patterns = [
      /(?:^|\n)\s*import\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/g,
      /(?:^|\n)\s*import\s+["']([^"']+)["']/g,
      /(?:^|\n)\s*export\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier !== undefined) {
          out.push(specifier);
        }
      }
    }
    return out;
  }

  /** Every module reachable from `entry` by relative import, transitively. */
  function transitiveGraph(entry: string): Map<string, Module> {
    const seen = new Map<string, Module>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      const specifiers = importSpecifiers(source);
      seen.set(file, { source, specifiers });
      for (const specifier of specifiers) {
        // Type-only imports are erased by tsc, so they cannot pull a runtime
        // module in — they are followed anyway, which makes the assertion
        // STRICTER than the runtime claim, not weaker.
        if (specifier.startsWith(".")) {
          queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
        }
      }
    }
    return seen;
  }

  it("wire-probe-cli.ts nao alcanca database.ts, config.ts nem pg", () => {
    const graph = transitiveGraph(resolve(SRC, "wire-probe-cli.ts"));
    const files = [...graph.keys()]
      .map((file) => file.replace(`${SRC}/`, ""))
      .sort();
    // The graph is small on purpose: the CLI and the probe module. Anything
    // else appearing here is a new dependency that has to be justified.
    expect(files).toEqual(["polymarket/wireprobe.ts", "wire-probe-cli.ts"]);
    for (const [file, module] of graph) {
      const short = file.replace(`${SRC}/`, "");
      for (const specifier of module.specifiers) {
        expect(
          FORBIDDEN_MODULES.includes(specifier),
          `${short} importa ${specifier}`,
        ).toBe(false);
        expect(
          FORBIDDEN_LOCAL.test(specifier),
          `${short} importa ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("o unico pacote externo e `ws`", () => {
    const graph = transitiveGraph(resolve(SRC, "wire-probe-cli.ts"));
    const external = [...graph.values()]
      .flatMap((module) => module.specifiers)
      .filter((specifier) => !specifier.startsWith("."));
    expect([...new Set(external)].sort()).toEqual(["ws"]);
  });

  it("nao le GANSO_CONFIG_FILE nem GANSO_POSTGRES_PASSWORD_FILE", () => {
    const graph = transitiveGraph(resolve(SRC, "wire-probe-cli.ts"));
    for (const [file, module] of graph) {
      // The comments name both variables to explain WHY they are ignored;
      // what must not appear is a read of process.env for them.
      expect(
        /process\.env\[?["']?GANSO_/.test(module.source),
        `${file} le uma variavel GANSO_*`,
      ).toBe(false);
    }
  });

  it("roda igual com as variaveis do recorder presentes ou ausentes", async () => {
    // The claim: the probe behaves identically whether or not
    // GANSO_CONFIG_FILE and GANSO_POSTGRES_PASSWORD_FILE are set — both are
    // set on the `polymarket-recorder` service the probe runs inside.
    //
    // Checked IN PROCESS, against the module vitest already loaded, and not by
    // executing `dist/wire-probe-cli.js`: `make verify` runs `test` BEFORE
    // `build`, so a test that shells out to the compiled artifact passes
    // locally after a build and fails in CI on a clean tree. Measured: that is
    // exactly how it failed on the PR #117 merge.
    const fetcher: ProbeFetcher = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            {
              slug: "bitcoin-up-or-down-september-8-2026-3pm-et",
              endDate: "2026-09-08T20:00:00Z",
              markets: [
                {
                  conditionId: "0xabc",
                  endDate: "2026-09-08T20:00:00Z",
                  clobTokenIds: '["u1","d1"]',
                },
              ],
            },
          ]),
      });
    const now = Date.parse("2026-09-08T19:00:00Z");

    const observe = async (): Promise<string> =>
      JSON.stringify({
        frame: probeSubscribeFrame(["a", "b"]),
        series: await listHourlySeries(fetcher, now),
      });

    const saved = {
      config: process.env["GANSO_CONFIG_FILE"],
      password: process.env["GANSO_POSTGRES_PASSWORD_FILE"],
    };
    try {
      delete process.env["GANSO_CONFIG_FILE"];
      delete process.env["GANSO_POSTGRES_PASSWORD_FILE"];
      const without = await observe();

      process.env["GANSO_CONFIG_FILE"] = "/nonexistent/runtime.json";
      process.env["GANSO_POSTGRES_PASSWORD_FILE"] = "/nonexistent/password";
      const present = await observe();

      expect(present).toBe(without);
      expect(JSON.parse(present).series).toHaveLength(1);
    } finally {
      // Restore, or the next test file inherits whatever this one left.
      if (saved.config === undefined) {
        delete process.env["GANSO_CONFIG_FILE"];
      } else {
        process.env["GANSO_CONFIG_FILE"] = saved.config;
      }
      if (saved.password === undefined) {
        delete process.env["GANSO_POSTGRES_PASSWORD_FILE"];
      } else {
        process.env["GANSO_POSTGRES_PASSWORD_FILE"] = saved.password;
      }
    }
  });

  it("o CLI nao le nenhuma variavel de ambiente alem de process.argv", () => {
    // The static half of the same claim, and the stricter one: the CLI cannot
    // be sensitive to an env var it never reads. `process.argv` is the only
    // input it takes from the process.
    const graph = transitiveGraph(resolve(SRC, "wire-probe-cli.ts"));
    for (const [file, module] of graph) {
      const short = file.replace(`${SRC}/`, "");
      expect(
        /process\.env/.test(module.source),
        `${short} le process.env`,
      ).toBe(false);
    }
  });
});

describe("RFC-024 D1 — o frame e o mesmo que o recorder envia", () => {
  it("probeSubscribeFrame e byte-identico a subscribeMessage", () => {
    for (const tokens of [[], ["a"], ["a", "b"], ["1", "2", "3"]]) {
      expect(probeSubscribeFrame(tokens)).toBe(subscribeMessage(tokens));
    }
  });
});

describe("RFC-024 D1 — a rodada", () => {
  it("sem controle positivo em B sai INVALID, nao resultado", async () => {
    const sockets: FakeProbeSocket[] = [];
    const timers = fakeTimers();
    const promise = runProbeRound(
      {
        baselineTokenIds: ["base1"],
        newTokenId: "novo",
        variant: "only_new",
      },
      {
        socketFactory: () => {
          const socket = new FakeProbeSocket();
          sockets.push(socket);
          return socket;
        },
        clock: timers.clock,
        setTimer: timers.setTimer,
      },
    );
    await Promise.resolve();
    const a = sockets[0] as FakeProbeSocket;
    a.fireOpen();
    a.deliver(bookFrame("base1"));
    await timers.advance(60_000);
    // B is opened at the extra-frame instant and never delivers: the token is
    // quiet, so the round cannot decide.
    (sockets[1] as FakeProbeSocket).fireOpen();
    await timers.advance(5_000);
    const result = await promise;
    expect(result.verdict).toBe("INVALID");
    expect(result.invalidReason).toBe("no_control_book_on_b_in_5000ms");
    expect(result.msToBookOnA).toBeNull();
  });

  it("sem book da linha-base em A sai INVALID", async () => {
    const sockets: FakeProbeSocket[] = [];
    const timers = fakeTimers();
    const promise = runProbeRound(
      { baselineTokenIds: ["base1"], newTokenId: "novo", variant: "only_new" },
      {
        socketFactory: () => {
          const socket = new FakeProbeSocket();
          sockets.push(socket);
          return socket;
        },
        clock: timers.clock,
        setTimer: timers.setTimer,
      },
    );
    await Promise.resolve();
    (sockets[0] as FakeProbeSocket).fireOpen();
    await timers.advance(5_000);
    const result = await promise;
    expect(result.verdict).toBe("INVALID");
    expect(result.invalidReason).toBe("no_baseline_book_on_a_in_5000ms");
  });

  it("H1 confirmada: book em B, nunca em A, e os antigos seguem fluindo", async () => {
    const sockets: FakeProbeSocket[] = [];
    const timers = fakeTimers();
    const promise = runProbeRound(
      {
        baselineTokenIds: ["base1", "base2"],
        newTokenId: "novo",
        variant: "old_plus_new",
      },
      {
        socketFactory: () => {
          const socket = new FakeProbeSocket();
          sockets.push(socket);
          return socket;
        },
        clock: timers.clock,
        setTimer: timers.setTimer,
      },
    );
    await Promise.resolve();
    const a = sockets[0] as FakeProbeSocket;
    a.fireOpen();
    a.deliver(bookFrame("base1"));
    await timers.advance(60_000);
    // The extra frame carried the old list plus the new token, exactly as
    // `resubscribe` does.
    expect(a.sent[1]).toBe(
      JSON.stringify({
        assets_ids: ["base1", "base2", "novo"],
        type: "market",
      }),
    );
    // B was opened at that same instant: the control positive.
    expect(sockets).toHaveLength(2);
    const b = sockets[1] as FakeProbeSocket;
    b.fireOpen();
    b.deliver(bookFrame("novo"));
    await timers.advance(5_000);
    // Old tokens keep flowing on A: the frame SUMS, it does not silence them.
    a.deliver(priceChangeFrame("base1"));
    a.deliver(priceChangeFrame("base2"));
    // ...but the new token's book never arrives on A.
    await timers.advance(120_000);
    b.deliver(priceChangeFrame("novo"));
    b.deliver(priceChangeFrame("novo"));
    await timers.advance(600_000);
    const result = await promise;
    expect(result.verdict).toBe("NEVER_ON_A");
    expect(result.msToBookOnA).toBeNull();
    expect(result.msToBookOnB).toBe(0);
    expect(result.baselineStillFlowingOnA).toBe(true);
    expect(result.baselineFramesAfterExtra).toBe(2);
    expect(result.priceChangeFramesOnB).toBe(2);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
  });

  it("H1 refutada: o frame extra entrega o book em A", async () => {
    const sockets: FakeProbeSocket[] = [];
    const timers = fakeTimers();
    const promise = runProbeRound(
      { baselineTokenIds: ["base1"], newTokenId: "novo", variant: "only_new" },
      {
        socketFactory: () => {
          const socket = new FakeProbeSocket();
          sockets.push(socket);
          return socket;
        },
        clock: timers.clock,
        setTimer: timers.setTimer,
      },
    );
    await Promise.resolve();
    const a = sockets[0] as FakeProbeSocket;
    a.fireOpen();
    a.deliver(bookFrame("base1"));
    await timers.advance(60_000);
    expect(a.sent[1]).toBe(
      JSON.stringify({ assets_ids: ["novo"], type: "market" }),
    );
    const b = sockets[1] as FakeProbeSocket;
    b.fireOpen();
    b.deliver(bookFrame("novo"));
    await timers.advance(3_000);
    a.deliver(bookFrame("novo"));
    await timers.advance(600_000);
    const result = await promise;
    expect(result.verdict).toBe("BOOK_ON_A");
    expect(result.msToBookOnA).toBe(3_000);
  });
});

describe("RFC-024 D2 — a regex horaria", () => {
  it("casa os 24 slugs reais do dia", () => {
    expect(HOURLY_SLUGS).toHaveLength(24);
    for (const slug of HOURLY_SLUGS) {
      expect(HOURLY_SERIES_SLUG_PATTERN.test(slug), slug).toBe(true);
    }
  });

  it("recusa 5 min, 15 min, 4 h, diario e vizinhos", () => {
    for (const slug of NON_HOURLY_SLUGS) {
      expect(HOURLY_SERIES_SLUG_PATTERN.test(slug), slug).toBe(false);
    }
  });
});

describe("RFC-024 D2 — listagem da serie ao vivo", () => {
  const event = (slug: string, endDate: string, tokens: string[]): unknown => ({
    id: "1",
    slug,
    endDate,
    markets: [
      {
        conditionId: `0x${slug.slice(-6)}`,
        endDate,
        // Gamma serialises this as a JSON STRING, not an array.
        clobTokenIds: JSON.stringify(tokens),
      },
    ],
  });

  it("usa /events?series_id e ordena por proximidade do fim", async () => {
    const urls: string[] = [];
    const fetcher: ProbeFetcher = (input) => {
      urls.push(input);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            event(
              "bitcoin-up-or-down-september-8-2026-5pm-et",
              "2026-09-08T22:00:00Z",
              ["t5a", "t5b"],
            ),
            event(
              "bitcoin-up-or-down-september-8-2026-3pm-et",
              "2026-09-08T20:00:00Z",
              ["t3a", "t3b"],
            ),
            // Must be dropped by the regex.
            event("btc-updown-15m-1788827400", "2026-09-08T20:15:00Z", ["x"]),
            event(
              "bitcoin-up-or-down-on-september-8-2026",
              "2026-09-08T20:00:00Z",
              ["y"],
            ),
          ]),
      });
    };
    const now = Date.parse("2026-09-08T19:00:00Z");
    const out = await listHourlySeries(fetcher, now);
    expect(urls[0]).toBe(
      `https://gamma-api.polymarket.com/events?series_id=${HOURLY_SERIES_ID}&closed=false&limit=100`,
    );
    expect(out.map((entry) => entry.slug)).toEqual([
      "bitcoin-up-or-down-september-8-2026-3pm-et",
      "bitcoin-up-or-down-september-8-2026-5pm-et",
    ]);
    expect(out[0]?.minutesToEnd).toBe(60);
    expect(out[0]?.tokenIds).toEqual(["t3a", "t3b"]);
  });

  it("HTTP nao-ok vira erro nomeado, nao lista vazia silenciosa", async () => {
    const fetcher: ProbeFetcher = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve([]),
      });
    await expect(listHourlySeries(fetcher, Date.now())).rejects.toThrow(
      "gamma_series_http_503",
    );
  });
});

describe("RFC-024 — utilitarios da prova", () => {
  it("parseProbeFrame ignora PONG, lixo e frames sem event_type", () => {
    expect(parseProbeFrame("PONG")).toEqual([]);
    expect(parseProbeFrame("   ")).toEqual([]);
    expect(parseProbeFrame("{nao json")).toEqual([]);
    expect(parseProbeFrame(JSON.stringify([{ asset_id: "a" }]))).toEqual([]);
    expect(parseProbeFrame(bookFrame("a"))).toEqual([
      { eventType: "book", assetId: "a" },
    ]);
  });

  it("parseTokenIds aceita string JSON e array, e recusa o resto", () => {
    expect(parseTokenIds('["a","b"]')).toEqual(["a", "b"]);
    expect(parseTokenIds(["a"])).toEqual(["a"]);
    expect(parseTokenIds("nao json")).toEqual([]);
    expect(parseTokenIds(null)).toEqual([]);
    expect(parseTokenIds([1, "a", null])).toEqual(["a"]);
  });

  it("projectVolumetry usa a taxa medida e os 313,67 B/linha", () => {
    const out = projectVolumetry({
      perMinutePerToken: 2_400,
      tokensPerMarket: 2,
      minutesPerMarket: 65,
      marketsPerDay: 24,
      bytesPerRow: 313.67,
    });
    expect(out.rowsPerDay).toBe(7_488_000);
    // The RFC's own estimate: +7,5 M linhas/dia, +2,3 GB/dia.
    expect(out.gbPerDay).toBeCloseTo(2.35, 2);
  });
});

// ---------------------------------------------------------------------------
// RFC-024 D1 — os tres defeitos que a primeira rodada ao vivo revelou
// ---------------------------------------------------------------------------

/**
 * The first live round, 2026-09-08T02:19:43Z, came back:
 *
 *   | 1 | only_new | ... | BOOK_ON_A | -59999 ms | sim (537 frames) | 22 ms | 0 |
 *
 * Three things wrong in one line, and the RFC's stop condition reads
 * `BOOK_ON_A` as "H1 refuted, do not write PR 3". Each defect gets a test.
 */
describe("RFC-024 D1 — defeitos vistos na primeira rodada ao vivo", () => {
  it("o token novo dentro da linha-base sai INVALID, nao BOOK_ON_A", async () => {
    // Defect 1: the CLI picked the baseline market as the "new" market too.
    const timers = fakeTimers();
    const result = await runProbeRound(
      {
        baselineTokenIds: ["base1", "base2"],
        // The same token as the baseline: nothing to measure.
        newTokenId: "base1",
        variant: "only_new",
      },
      {
        socketFactory: () => new FakeProbeSocket(),
        clock: timers.clock,
        setTimer: timers.setTimer,
      },
    );
    expect(result.verdict).toBe("INVALID");
    expect(result.invalidReason).toBe("new_token_is_in_baseline");
  });

  it("book visto ANTES do frame extra sai INVALID: tempo negativo e impossivel", async () => {
    // Defect 2: the book arrived during the baseline phase, 60 s before the
    // extra frame, and was reported as if the frame had delivered it.
    const sockets: FakeProbeSocket[] = [];
    const timers = fakeTimers();
    const promise = runProbeRound(
      {
        baselineTokenIds: ["base1"],
        newTokenId: "novo",
        variant: "only_new",
      },
      {
        socketFactory: () => {
          const socket = new FakeProbeSocket();
          sockets.push(socket);
          return socket;
        },
        clock: timers.clock,
        setTimer: timers.setTimer,
      },
    );
    await Promise.resolve();
    const a = sockets[0] as FakeProbeSocket;
    a.fireOpen();
    a.deliver(bookFrame("base1"));
    // The venue volunteers the new token's book while A is still on the
    // baseline subscription — the token was already flowing.
    a.deliver(bookFrame("novo"));
    await timers.advance(60_000);
    const b = sockets[1] as FakeProbeSocket;
    b.fireOpen();
    b.deliver(bookFrame("novo"));
    await timers.advance(130_000);
    const result = await promise;
    expect(result.verdict).toBe("INVALID");
    expect(result.invalidReason).toBe("book_on_a_before_extra_frame");
    // And never a negative measurement.
    expect(result.msToBookOnA).toBeNull();
  });

  it("price_change conta pelo asset_id ANINHADO em price_changes[]", () => {
    // Defect 3: the live feed nests the token id one level down, so reading
    // only the top-level `asset_id` counted zero price_change for a token
    // that was trading — and the volumetry P2 needs came out 0.
    const frame = JSON.stringify([
      {
        event_type: "price_change",
        market: "0xm",
        timestamp: "1787098645123",
        price_changes: [
          { asset_id: "tokA", price: "0.50", size: "0", side: "BUY" },
          { asset_id: "tokB", price: "0.51", size: "3", side: "SELL" },
        ],
      },
    ]);
    // Two entries, one per token whose price moved.
    expect(parseProbeFrame(frame)).toEqual([
      { eventType: "price_change", assetId: "tokA" },
      { eventType: "price_change", assetId: "tokB" },
    ]);
    // The old reading produced exactly one entry with assetId null, which
    // matched no token and counted nothing.
    expect(
      parseProbeFrame(frame).filter((entry) => entry.assetId === null),
    ).toEqual([]);
  });

  it("book segue lendo o asset_id de topo (nao ha price_changes nele)", () => {
    expect(parseProbeFrame(bookFrame("tok"))).toEqual([
      { eventType: "book", assetId: "tok" },
    ]);
  });

  it("price_changes vazio cai de volta no asset_id de topo", () => {
    const frame = JSON.stringify([
      { event_type: "price_change", asset_id: "tok", price_changes: [] },
    ]);
    expect(parseProbeFrame(frame)).toEqual([
      { eventType: "price_change", assetId: "tok" },
    ]);
  });

  it("a volumetria conta os price_change aninhados, e nao sai 0", async () => {
    const sockets: FakeProbeSocket[] = [];
    const timers = fakeTimers();
    const promise = runProbeRound(
      { baselineTokenIds: ["base1"], newTokenId: "novo", variant: "only_new" },
      {
        socketFactory: () => {
          const socket = new FakeProbeSocket();
          sockets.push(socket);
          return socket;
        },
        clock: timers.clock,
        setTimer: timers.setTimer,
      },
    );
    await Promise.resolve();
    const a = sockets[0] as FakeProbeSocket;
    a.fireOpen();
    a.deliver(bookFrame("base1"));
    await timers.advance(60_000);
    const b = sockets[1] as FakeProbeSocket;
    b.fireOpen();
    b.deliver(bookFrame("novo"));
    await timers.advance(5_000);
    const nested = JSON.stringify([
      {
        event_type: "price_change",
        market: "0xm",
        price_changes: [
          { asset_id: "novo", price: "0.5", size: "1", side: "BUY" },
        ],
      },
    ]);
    for (let i = 0; i < 30; i += 1) {
      b.deliver(nested);
    }
    await timers.advance(700_000);
    const result = await promise;
    expect(result.verdict).toBe("NEVER_ON_A");
    expect(result.priceChangeFramesOnB).toBe(30);
    expect(result.priceChangePerMinuteOnB).toBeGreaterThan(0);
  });
});
