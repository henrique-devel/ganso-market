// RFC-024 D1: the wire proof, as a pure module.
//
// Hypothesis H1: the CLOB market WebSocket ignores additional `subscribe`
// frames on a live connection, so books for newly-subscribed tokens are only
// born on reconnect/restart. The recorder's `resubscribe`
// (`dualws.ts`) sends exactly such a frame, and 19 of 27 tokens measured on
// 02-03/09/2026 never received a `book` after entering the universe.
//
// Nothing in this module touches the database. It is imported ONLY by
// `wire-probe-cli.ts`, and a test asserts that neither file reaches
// `database.ts` or `pg` — statically or through any transitive import. The
// probe runs inside the recorder image, where GANSO_CONFIG_FILE and
// GANSO_POSTGRES_PASSWORD_FILE are set; it must behave identically whether
// they are present or absent, so it never reads them.
//
// SIMULAÇÃO — read-only market data over a public feed. No order, no auth, no
// write of any kind.

/** The market WSS endpoint the recorder uses (`recorder.ts` MARKET_WS_URL). */
export const PROBE_MARKET_WS_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";
export const PROBE_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

/**
 * RFC-024 D2: the hourly BTC "up or down" series.
 *
 * Measured live on 2026-09-08 (see the RFC's series section): the hourly
 * markets carry slugs like `bitcoin-up-or-down-september-8-2026-3pm-et`, while
 * 5min/15min/4h carry `btc-updown-5m-<epoch>` / `-15m-` / `-4h-` and the daily
 * carries `bitcoin-up-or-down-on-september-8-2026`. The `-on-` and the
 * `btc-updown-` prefixes are what separate the three families, so anchoring on
 * the month name plus a single hour marker matches the hourly series and
 * nothing else.
 */
export const HOURLY_SERIES_SLUG_PATTERN =
  /^bitcoin-up-or-down-(?:january|february|march|april|may|june|july|august|september|october|november|december)-(?:[1-9]|[12][0-9]|3[01])-\d{4}-(?:1[0-2]|[1-9])(?:am|pm)-et$/;

/** Gamma series id of `btc-up-or-down-hourly`, confirmed live 2026-09-08. */
export const HOURLY_SERIES_ID = "10114";

/**
 * The subscribe frame. Byte-identical to `subscribeMessage` in `recorder.ts`
 * — the probe must send what `resubscribe` sends, or it proves nothing about
 * the recorder. Duplicated rather than imported because importing
 * `recorder.js` would drag the recorder's module graph (and its database
 * types) into a CLI that must not have one; `wireprobe.test.ts` asserts the
 * two produce the same bytes.
 */
export function probeSubscribeFrame(tokenIds: readonly string[]): string {
  return JSON.stringify({ assets_ids: tokenIds, type: "market" });
}

export interface ProbeSocket {
  onOpen(handler: () => void): void;
  onMessage(handler: (raw: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export type ProbeSocketFactory = (url: string) => ProbeSocket;

export type ProbeFetcher = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Which shape of extra subscribe frame the round sends on connection A. */
export type ProbeVariant = "only_new" | "old_plus_new";

export interface ProbeRoundInput {
  /** Tokens subscribed on A at t=0 (a market already in the universe). */
  readonly baselineTokenIds: readonly string[];
  /** The token whose book we are trying to obtain on a live connection. */
  readonly newTokenId: string;
  readonly variant: ProbeVariant;
  /** Wait for the baseline book on A before the round counts (5 s in D1). */
  readonly baselineBookTimeoutMs?: number;
  /** Delay between A's baseline subscribe and the extra frame (60 s in D1). */
  readonly extraFrameDelayMs?: number;
  /** How long to wait for the new token's book on A (120 s in D1). */
  readonly newBookTimeoutMs?: number;
  /** Control-positive deadline on connection B (5 s in D1). */
  readonly controlTimeoutMs?: number;
  /** `price_change` counting window on B (600 s in D1). */
  readonly rateWindowMs?: number;
}

export interface ProbeRoundResult {
  readonly variant: ProbeVariant;
  readonly startedAt: string;
  /**
   * `INVALID` whenever the round cannot decide: no baseline book on A inside
   * the deadline, or no book on B (the control positive). An invalid round is
   * never reported as a result — RFC-024 "Testes obrigatórios".
   */
  readonly verdict: "BOOK_ON_A" | "NEVER_ON_A" | "INVALID";
  readonly invalidReason: string | null;
  /** ms from the extra frame to the new token's first `book` on A. */
  readonly msToBookOnA: number | null;
  /** ms from B's subscribe to the new token's first `book` on B. */
  readonly msToBookOnB: number | null;
  /** Did the baseline tokens keep flowing on A after the extra frame? */
  readonly baselineStillFlowingOnA: boolean;
  readonly baselineFramesAfterExtra: number;
  /** `price_change` frames per minute for the new token on B. */
  readonly priceChangePerMinuteOnB: number | null;
  readonly priceChangeFramesOnB: number;
  readonly rateWindowMs: number;
}

interface FrameInfo {
  readonly eventType: string;
  readonly assetId: string | null;
}

/**
 * The one frame parser the probe needs: event type and asset id. Kept local
 * and forgiving — a frame we cannot parse is counted as unparsed rather than
 * throwing inside a socket handler.
 */
export function parseProbeFrame(raw: string): FrameInfo[] {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "PONG") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: FrameInfo[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const eventType =
      typeof record["event_type"] === "string" ? record["event_type"] : "";
    if (eventType === "") {
      continue;
    }
    const assetId =
      typeof record["asset_id"] === "string" ? record["asset_id"] : null;
    out.push({ eventType, assetId });
  }
  return out;
}

export interface HourlyCandidate {
  readonly slug: string;
  readonly conditionId: string;
  readonly endDate: string;
  readonly tokenIds: readonly string[];
  readonly minutesToEnd: number;
}

/**
 * List the hourly series live, GET only.
 *
 * `GET /events?series_id=10114&closed=false` is the query that works;
 * measured 2026-09-08, `GET /markets?series_id=...` IGNORES the filter and
 * returns unrelated markets, so it must not be used.
 */
export async function listHourlySeries(
  fetcher: ProbeFetcher,
  nowMs: number,
  baseUrl: string = PROBE_GAMMA_BASE_URL,
): Promise<HourlyCandidate[]> {
  const url =
    `${baseUrl}/events?series_id=${HOURLY_SERIES_ID}` +
    `&closed=false&limit=100`;
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`gamma_series_http_${String(response.status)}`);
  }
  const body = (await response.json()) as unknown;
  const events = Array.isArray(body) ? body : [];
  const out: HourlyCandidate[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) {
      continue;
    }
    const record = event as Record<string, unknown>;
    const slug = typeof record["slug"] === "string" ? record["slug"] : "";
    if (!HOURLY_SERIES_SLUG_PATTERN.test(slug)) {
      continue;
    }
    const markets = Array.isArray(record["markets"]) ? record["markets"] : [];
    const first = markets[0];
    if (typeof first !== "object" || first === null) {
      continue;
    }
    const market = first as Record<string, unknown>;
    const conditionId =
      typeof market["conditionId"] === "string" ? market["conditionId"] : "";
    const endDate =
      typeof market["endDate"] === "string"
        ? market["endDate"]
        : typeof record["endDate"] === "string"
          ? record["endDate"]
          : "";
    const tokenIds = parseTokenIds(market["clobTokenIds"]);
    if (conditionId === "" || endDate === "" || tokenIds.length === 0) {
      continue;
    }
    const endMs = Date.parse(endDate);
    if (!Number.isFinite(endMs)) {
      continue;
    }
    out.push({
      slug,
      conditionId,
      endDate,
      tokenIds,
      minutesToEnd: (endMs - nowMs) / 60_000,
    });
  }
  out.sort((left, right) => left.minutesToEnd - right.minutesToEnd);
  return out;
}

/** Gamma serialises `clobTokenIds` as a JSON string, not an array. */
export function parseTokenIds(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

export interface RunRoundDeps {
  readonly socketFactory: ProbeSocketFactory;
  readonly url?: string;
  readonly clock: () => number;
  readonly setTimer: (run: () => void, delayMs: number) => unknown;
  readonly log?: (line: string) => void;
}

const DEFAULTS = {
  baselineBookTimeoutMs: 5_000,
  extraFrameDelayMs: 60_000,
  newBookTimeoutMs: 120_000,
  controlTimeoutMs: 5_000,
  rateWindowMs: 600_000,
} as const;

/**
 * One round of the D1 protocol.
 *
 * A: subscribe the baseline, wait for its `book` (else INVALID), wait
 * `extraFrameDelayMs`, then send the extra subscribe frame — `only_new` or
 * `old_plus_new`, the second being exactly what `resubscribe` does today.
 * B: opened at the same instant with only the new token; its `book` is the
 * control positive (else INVALID: the token is simply quiet).
 *
 * Measured on A: time to the new token's first `book` (or never), and whether
 * the baseline tokens keep flowing — the frame SUMS or REPLACES. Measured on
 * B: `price_change` per minute for the new token, the volumetry input for P2.
 */
export async function runProbeRound(
  input: ProbeRoundInput,
  deps: RunRoundDeps,
): Promise<ProbeRoundResult> {
  const url = deps.url ?? PROBE_MARKET_WS_URL;
  const log = deps.log ?? ((): void => {});
  const baselineBookTimeoutMs =
    input.baselineBookTimeoutMs ?? DEFAULTS.baselineBookTimeoutMs;
  const extraFrameDelayMs =
    input.extraFrameDelayMs ?? DEFAULTS.extraFrameDelayMs;
  const newBookTimeoutMs = input.newBookTimeoutMs ?? DEFAULTS.newBookTimeoutMs;
  const controlTimeoutMs = input.controlTimeoutMs ?? DEFAULTS.controlTimeoutMs;
  const rateWindowMs = input.rateWindowMs ?? DEFAULTS.rateWindowMs;
  const startedAt = new Date(deps.clock()).toISOString();
  const baseline = new Set(input.baselineTokenIds);

  let baselineBookOnA = false;
  let extraFrameSentAtMs: number | null = null;
  let bookOnAAtMs: number | null = null;
  let baselineFramesAfterExtra = 0;
  let subscribedBOnAtMs: number | null = null;
  let bookOnBAtMs: number | null = null;
  let priceChangeOnB = 0;
  let socketErrorA: string | null = null;
  let socketErrorB: string | null = null;

  const socketA = deps.socketFactory(url);
  // B is NOT opened here. D1 step 3 says "no mesmo instante": the control
  // positive only controls for anything if it asks the venue for the same
  // token at the same moment A is asked. A B opened 60 s early would prove
  // the token was live a minute ago, which is not the question.
  let socketB: ProbeSocket | null = null;

  const waitBaselineBook = deferred<void>();
  const waitBookOnA = deferred<void>();
  const waitBookOnB = deferred<void>();

  socketA.onError((error) => {
    socketErrorA = error instanceof Error ? error.message : String(error);
    waitBaselineBook.resolve();
  });

  socketA.onOpen(() => {
    socketA.send(probeSubscribeFrame([...input.baselineTokenIds]));
    log(`A open, subscribed baseline (${String(baseline.size)} tokens)`);
  });

  socketA.onMessage((raw) => {
    for (const frame of parseProbeFrame(raw)) {
      const isBaseline = frame.assetId !== null && baseline.has(frame.assetId);
      if (isBaseline) {
        if (frame.eventType === "book" && !baselineBookOnA) {
          baselineBookOnA = true;
          waitBaselineBook.resolve();
        }
        if (extraFrameSentAtMs !== null) {
          baselineFramesAfterExtra += 1;
        }
      }
      if (
        frame.assetId === input.newTokenId &&
        frame.eventType === "book" &&
        bookOnAAtMs === null
      ) {
        bookOnAAtMs = deps.clock();
        waitBookOnA.resolve();
      }
    }
  });

  function openControlConnection(): ProbeSocket {
    const socket = deps.socketFactory(url);
    socket.onError((error) => {
      socketErrorB = error instanceof Error ? error.message : String(error);
      waitBookOnB.resolve();
    });
    socket.onOpen(() => {
      subscribedBOnAtMs = deps.clock();
      socket.send(probeSubscribeFrame([input.newTokenId]));
      log("B open, subscribed the new token only (control positive)");
    });
    socket.onMessage((raw) => {
      for (const frame of parseProbeFrame(raw)) {
        if (frame.assetId !== input.newTokenId) {
          continue;
        }
        if (frame.eventType === "book" && bookOnBAtMs === null) {
          bookOnBAtMs = deps.clock();
          waitBookOnB.resolve();
        }
        if (frame.eventType === "price_change") {
          priceChangeOnB += 1;
        }
      }
    });
    return socket;
  }

  const invalid = (reason: string): ProbeRoundResult => {
    socketA.close();
    socketB?.close();
    return {
      variant: input.variant,
      startedAt,
      verdict: "INVALID",
      invalidReason: reason,
      msToBookOnA: null,
      msToBookOnB: null,
      baselineStillFlowingOnA: false,
      baselineFramesAfterExtra: 0,
      priceChangePerMinuteOnB: null,
      priceChangeFramesOnB: 0,
      rateWindowMs,
    };
  };

  // 1. A must be delivering the baseline book, or there is nothing to test.
  await raceTimer(waitBaselineBook.promise, baselineBookTimeoutMs, deps);
  if (!baselineBookOnA) {
    return invalid(
      socketErrorA === null
        ? `no_baseline_book_on_a_in_${String(baselineBookTimeoutMs)}ms`
        : `socket_a_error:${socketErrorA}`,
    );
  }

  // 2. Wait, then send the extra frame on the LIVE connection A — and open B
  // with the new token at the same instant.
  await sleep(extraFrameDelayMs, deps);
  extraFrameSentAtMs = deps.clock();
  socketB = openControlConnection();
  const extraFrameTokens =
    input.variant === "only_new"
      ? [input.newTokenId]
      : [...input.baselineTokenIds, input.newTokenId];
  socketA.send(probeSubscribeFrame(extraFrameTokens));
  log(
    `A: extra subscribe frame sent (variant ${input.variant}, ` +
      `${String(extraFrameTokens.length)} tokens)`,
  );

  // 3. The control positive: B must produce the book, or the token is quiet
  //    and the round does not count. The deadline covers B's handshake too —
  //    a socket that never opens is as much "no control" as a quiet token.
  await raceTimer(waitBookOnB.promise, controlTimeoutMs, deps);
  if (bookOnBAtMs === null) {
    return invalid(
      socketErrorB === null
        ? `no_control_book_on_b_in_${String(controlTimeoutMs)}ms`
        : `socket_b_error:${socketErrorB}`,
    );
  }

  // 4. The measurement: does A ever deliver the new token's book?
  await raceTimer(waitBookOnA.promise, newBookTimeoutMs, deps);
  const verdict = bookOnAAtMs === null ? "NEVER_ON_A" : "BOOK_ON_A";

  // 5. Volumetry for P2: price_change per minute on B, over the rate window.
  const alreadyWaitedMs = deps.clock() - extraFrameSentAtMs;
  const remainingMs = Math.max(rateWindowMs - alreadyWaitedMs, 0);
  if (remainingMs > 0) {
    await sleep(remainingMs, deps);
  }
  const observedWindowMs = Math.max(
    deps.clock() - (subscribedBOnAtMs ?? extraFrameSentAtMs),
    1,
  );

  socketA.close();
  socketB?.close();

  return {
    variant: input.variant,
    startedAt,
    verdict,
    invalidReason: null,
    msToBookOnA: bookOnAAtMs === null ? null : bookOnAAtMs - extraFrameSentAtMs,
    msToBookOnB:
      subscribedBOnAtMs === null ? null : bookOnBAtMs - subscribedBOnAtMs,
    baselineStillFlowingOnA: baselineFramesAfterExtra > 0,
    baselineFramesAfterExtra,
    priceChangePerMinuteOnB:
      Math.round((priceChangeOnB / observedWindowMs) * 60_000 * 10) / 10,
    priceChangeFramesOnB: priceChangeOnB,
    rateWindowMs: observedWindowMs,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number, deps: RunRoundDeps): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    deps.setTimer(() => {
      resolve();
    }, ms);
  });
}

function raceTimer(
  promise: Promise<void>,
  timeoutMs: number,
  deps: RunRoundDeps,
): Promise<void> {
  return Promise.race([promise, sleep(timeoutMs, deps)]);
}

/**
 * Volumetry projection for P2, from the measured `price_change` rate.
 *
 * Deliberately explicit about its assumption: one `price_change` frame is
 * counted as one `polymarket_book_deltas` row. `bytesPerRow` is the measured
 * 313.67 B/row (decision #88, re-measured 2026-09-08: identical).
 */
export function projectVolumetry(input: {
  readonly perMinutePerToken: number;
  readonly tokensPerMarket: number;
  readonly minutesPerMarket: number;
  readonly marketsPerDay: number;
  readonly bytesPerRow: number;
}): { rowsPerDay: number; gibPerDay: number; gbPerDay: number } {
  const rowsPerDay =
    input.perMinutePerToken *
    input.tokensPerMarket *
    input.minutesPerMarket *
    input.marketsPerDay;
  const bytes = rowsPerDay * input.bytesPerRow;
  return {
    rowsPerDay: Math.round(rowsPerDay),
    gibPerDay: Math.round((bytes / 1024 ** 3) * 100) / 100,
    gbPerDay: Math.round((bytes / 1000 ** 3) * 100) / 100,
  };
}
