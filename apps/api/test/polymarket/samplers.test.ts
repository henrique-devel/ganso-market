import { describe, expect, it } from "vitest";

import type { QueryResultRow } from "pg";

import type { QueryResult, SqlExecutor } from "../../src/database.js";
import {
  PENDING_RESOLUTION_LIMIT,
  PENDING_RESOLUTION_LOOKBACK_MS,
  computeConcentration,
  createOiHoldersSampler,
  createUmaStatusPoller,
  normalizeUmaStatus,
  pendingResolutionIds,
  recordMarketResolved,
} from "../../src/polymarket/samplers.js";

interface CapturedQuery {
  readonly text: string;
  readonly params: unknown[];
}

type Responder = (
  text: string,
  params: readonly unknown[],
) => { rows: Record<string, unknown>[] } | undefined;

function createFakeExecutor(responder?: Responder): {
  calls: CapturedQuery[];
  executor: SqlExecutor;
} {
  const calls: CapturedQuery[] = [];
  const executor: SqlExecutor = {
    query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      calls.push({ text, params: [...(params ?? [])] });
      const canned = responder?.(text, params ?? []);
      return Promise.resolve({
        rows: (canned?.rows ?? []) as R[],
        rowCount: canned?.rows.length ?? 0,
      });
    },
  };
  return { calls, executor };
}

function jsonResponse(
  body: unknown,
  ok = true,
  status = 200,
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok, status, json: () => Promise.resolve(body) };
}

describe("computeConcentration (bigint shares)", () => {
  it("computes top1/top5 as 6-place decimal ratios", () => {
    const { top1Share, top5Share } = computeConcentration([
      "30",
      "50",
      "10",
      "5",
      "3",
      "2",
    ]);
    expect(top1Share).toBe("0.500000");
    expect(top5Share).toBe("0.980000");
  });

  it("handles fractional amounts exactly, without floats", () => {
    // total = 0.3; top1 = 0.1/0.3 = 1/3 -> 0.333333 (half-up on bigints).
    const { top1Share, top5Share } = computeConcentration([
      "0.1",
      "0.1",
      "0.1",
    ]);
    expect(top1Share).toBe("0.333333");
    expect(top5Share).toBe("1.000000");
  });

  it("returns nulls when there are no usable amounts", () => {
    expect(computeConcentration([])).toEqual({
      top1Share: null,
      top5Share: null,
    });
    expect(computeConcentration(["0", "0"])).toEqual({
      top1Share: null,
      top5Share: null,
    });
    expect(computeConcentration(["1e5", "abc"])).toEqual({
      top1Share: null,
      top5Share: null,
    });
  });
});

describe("oi/holders sampler", () => {
  const universe = [{ conditionId: "0xcond", tokenIds: ["111", "222"] }];

  function makeFetcher(
    overrides?: Partial<Record<"oi" | "volume" | "holders", unknown>>,
  ): (url: string) => Promise<ReturnType<typeof jsonResponse>> {
    return (url: string) => {
      if (url.includes("/oi?")) {
        return Promise.resolve(
          jsonResponse(overrides?.oi ?? { value: 1234.5 }),
        );
      }
      if (url.includes("/live-volume?")) {
        return Promise.resolve(
          jsonResponse(overrides?.volume ?? { total: "999" }),
        );
      }
      return Promise.resolve(
        jsonResponse(
          overrides?.holders ?? [
            {
              token: "111",
              holders: [
                { proxyWallet: "a", amount: 50 },
                { proxyWallet: "b", amount: 30 },
                { proxyWallet: "c", amount: 10 },
                { proxyWallet: "d", amount: 5 },
                { proxyWallet: "e", amount: 3 },
                { proxyWallet: "f", amount: 2 },
              ],
            },
          ],
        ),
      );
    };
  }

  it("persists one row per holder group with derived concentration", async () => {
    const { calls, executor } = createFakeExecutor();
    const sampler = createOiHoldersSampler({
      pool: executor,
      fetcher: makeFetcher(),
      clock: () => 1_000_000,
    });
    await sampler.sampleOnce(universe);

    const inserts = calls.filter((call) =>
      call.text.includes("INSERT INTO polymarket_oi_holders"),
    );
    expect(inserts).toHaveLength(1);
    const params = inserts[0]?.params;
    expect(params?.[0]).toBe("0xcond");
    expect(params?.[1]).toBe("111");
    expect(params?.[2]).toBe("1234.5"); // open_interest as decimal string
    expect(params?.[3]).toBe("999"); // live_volume
    expect(params?.[4]).toBe(6); // holders_count
    expect(params?.[5]).toBe("0.500000"); // top1_share
    expect(params?.[6]).toBe("0.980000"); // top5_share
    expect(params?.[8]).toBeInstanceOf(Date);
    expect((params?.[8] as Date).getTime()).toBe(1_000_000);
  });

  it("logs and continues when one market fails, without a gap row", async () => {
    const twoMarkets = [
      { conditionId: "0xbad", tokenIds: ["1"] },
      { conditionId: "0xgood", tokenIds: ["2"] },
    ];
    const fetcher = (url: string): Promise<ReturnType<typeof jsonResponse>> => {
      if (url.includes("0xbad")) {
        return Promise.reject(new Error("boom"));
      }
      return makeFetcher()(url);
    };
    const { calls, executor } = createFakeExecutor();
    const sampler = createOiHoldersSampler({
      pool: executor,
      fetcher,
      clock: () => 0,
    });
    await sampler.sampleOnce(twoMarkets);

    const inserts = calls.filter((call) =>
      call.text.includes("polymarket_oi_holders"),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params[0]).toBe("0xgood");
    expect(
      calls.some((call) => call.text.includes("polymarket_data_gaps")),
    ).toBe(false);
  });

  it("records a data_api gap covering the cycle when every market fails", async () => {
    let now = 500;
    const { calls, executor } = createFakeExecutor();
    const sampler = createOiHoldersSampler({
      pool: executor,
      fetcher: () => Promise.reject(new Error("network down")),
      clock: () => {
        now += 100;
        return now;
      },
    });
    await sampler.sampleOnce(universe);

    const gap = calls.find((call) =>
      call.text.includes("INSERT INTO polymarket_data_gaps"),
    );
    expect(gap).toBeDefined();
    expect(gap?.text).toContain("'data_api'");
    expect(gap?.params[0]).toBeInstanceOf(Date);
    expect(gap?.params[2]).toBe("oi_holders_sample_failed_all");
  });
});

describe("uma status poller", () => {
  function gammaFetcher(
    statuses: () => {
      umaResolutionStatus?: string;
      closed?: boolean;
      resolved?: boolean;
    },
  ): (url: string) => Promise<ReturnType<typeof jsonResponse>> {
    return () =>
      Promise.resolve(jsonResponse([{ conditionId: "0xcond", ...statuses() }]));
  }

  it("emits exactly one event per transition and nothing in steady state", async () => {
    const sequence = [
      { umaResolutionStatus: "proposed", closed: false },
      { umaResolutionStatus: "proposed", closed: false }, // steady state
      { umaResolutionStatus: "disputed", closed: false },
      { umaResolutionStatus: "resolved", closed: true },
      { umaResolutionStatus: "resolved", closed: true }, // steady state
    ];
    let index = 0;
    const { calls, executor } = createFakeExecutor((text) => {
      if (text.includes("DISTINCT ON")) {
        return { rows: [] };
      }
      return undefined;
    });
    const poller = createUmaStatusPoller({
      pool: executor,
      fetcher: gammaFetcher(() => sequence[Math.min(index, 4)] ?? {}),
      clock: () => 0,
    });
    for (index = 0; index < sequence.length; index += 1) {
      await poller.pollOnce(["0xcond"]);
    }

    const inserts = calls.filter((call) =>
      call.text.includes("INSERT INTO polymarket_resolution_events"),
    );
    expect(inserts.map((call) => call.params[1])).toEqual([
      "proposed",
      "disputed",
      "resolved",
    ]);
    const payloads = inserts.map(
      (call) =>
        JSON.parse(String(call.params[2])) as { from: unknown; to: unknown },
    );
    expect(payloads[0]).toMatchObject({ from: null, to: "proposed" });
    expect(payloads[1]).toMatchObject({ from: "proposed", to: "disputed" });
    expect(payloads[2]).toMatchObject({ from: "disputed", to: "resolved" });
  });

  it("re-hydrates the last known status from the database on boot", async () => {
    const { calls, executor } = createFakeExecutor((text) => {
      if (text.includes("DISTINCT ON")) {
        return {
          rows: [
            {
              condition_id: "0xcond",
              event_type: "proposed",
              payload_json: { from: null, to: "proposed" },
            },
          ],
        };
      }
      return undefined;
    });
    const poller = createUmaStatusPoller({
      pool: executor,
      fetcher: gammaFetcher(() => ({
        umaResolutionStatus: "proposed",
        closed: false,
      })),
      clock: () => 0,
    });
    await poller.pollOnce(["0xcond"]);

    expect(
      calls.some((call) =>
        call.text.includes("INSERT INTO polymarket_resolution_events"),
      ),
    ).toBe(false);
  });

  it("does not re-emit the current status after restart when a rule_change follows it", async () => {
    // Database timeline: 'proposed' (status) then a 'rule_change'
    // clarification (no status). Hydration must skip the rule_change row and
    // still see 'proposed' as the current status.
    const statusTypes = new Set([
      "proposed",
      "disputed",
      "resolved",
      "closed",
      "market_resolved",
    ]);
    const storedEvents = [
      {
        condition_id: "0xcond",
        event_type: "proposed",
        payload_json: { from: null, to: "proposed" },
        received_at: 1,
      },
      {
        condition_id: "0xcond",
        event_type: "rule_change",
        payload_json: { reason: "clarification" },
        received_at: 2,
      },
    ];
    const { calls, executor } = createFakeExecutor((text) => {
      if (text.includes("DISTINCT ON")) {
        // Emulate the hydration SQL: honor the event_type filter when the
        // query carries one, then DISTINCT ON keeps the latest received_at.
        const candidates = text.includes("event_type IN")
          ? storedEvents.filter((event) => statusTypes.has(event.event_type))
          : storedEvents;
        const latest = [...candidates].sort(
          (a, b) => b.received_at - a.received_at,
        )[0];
        return { rows: latest === undefined ? [] : [latest] };
      }
      return undefined;
    });
    const poller = createUmaStatusPoller({
      pool: executor,
      fetcher: gammaFetcher(() => ({
        umaResolutionStatus: "proposed",
        closed: false,
      })),
      clock: () => 0,
    });
    await poller.pollOnce(["0xcond"]);

    const hydrateQuery = calls.find((call) =>
      call.text.includes("DISTINCT ON"),
    );
    expect(hydrateQuery?.text).toContain("event_type IN");
    expect(hydrateQuery?.text).not.toContain("'rule_change'");
    // Steady state: the current status is 'proposed' both in the database and
    // at Gamma, so nothing is re-emitted.
    expect(
      calls.some((call) =>
        call.text.includes("INSERT INTO polymarket_resolution_events"),
      ),
    ).toBe(false);
  });

  it("records a gamma gap when the status poll fails outright", async () => {
    const { calls, executor } = createFakeExecutor((text) => {
      if (text.includes("DISTINCT ON")) {
        return { rows: [] };
      }
      return undefined;
    });
    const poller = createUmaStatusPoller({
      pool: executor,
      fetcher: () => Promise.resolve(jsonResponse(null, false, 500)),
      clock: () => 42,
    });
    await poller.pollOnce(["0xcond"]);

    const gap = calls.find((call) =>
      call.text.includes("INSERT INTO polymarket_data_gaps"),
    );
    expect(gap).toBeDefined();
    expect(gap?.text).toContain("'gamma'");
    expect(gap?.params[2]).toBe("uma_status_poll_failed");
  });

  it("maps status text tolerantly", () => {
    expect(normalizeUmaStatus("proposed", false)).toBe("proposed");
    expect(normalizeUmaStatus("disputed", false)).toBe("disputed");
    expect(normalizeUmaStatus("challenged", false)).toBe("disputed");
    expect(normalizeUmaStatus("resolved", true)).toBe("resolved");
    expect(normalizeUmaStatus(null, true)).toBe("closed");
    expect(normalizeUmaStatus(null, false)).toBeNull();
  });
});

describe("recordMarketResolved", () => {
  it("inserts an immutable market_resolved event with source_ts from payload", async () => {
    const { calls, executor } = createFakeExecutor();
    await recordMarketResolved(
      executor,
      "0xcond",
      { winning_asset_id: "111", timestamp: "1787098643398" },
      () => 1_787_098_650_000,
    );

    const insert = calls[0];
    expect(insert?.text).toContain("polymarket_resolution_events");
    expect(insert?.text).toContain("'market_resolved'");
    expect(insert?.params[0]).toBe("0xcond");
    expect(String(insert?.params[1])).toContain("winning_asset_id");
    expect(insert?.params[2]).toBeInstanceOf(Date);
    expect((insert?.params[2] as Date).getTime()).toBe(1_787_098_643_398);
    expect((insert?.params[3] as Date).getTime()).toBe(1_787_098_650_000);
  });

  it("never throws when persistence fails", async () => {
    const failing: SqlExecutor = {
      query<R extends QueryResultRow>(): Promise<QueryResult<R>> {
        return Promise.reject(new Error("db down"));
      },
    };
    await expect(
      recordMarketResolved(failing, "0xcond", {}, () => 0),
    ).resolves.toBeUndefined();
  });
});

describe("uma status poller records the outcome, not only the status", () => {
  it("carries outcomePrices and outcomes into the resolution event", async () => {
    const inserts: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      query<R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<{ rows: R[]; rowCount: number }> {
        if (text.includes("INSERT INTO polymarket_resolution_events")) {
          inserts.push({ text, params: [...(params ?? [])] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const poller = createUmaStatusPoller({
      pool: pool as never,
      clock: () => Date.parse("2026-08-19T12:00:00.000Z"),
      fetcher: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve([
              {
                conditionId: "0xresolved",
                umaResolutionStatus: "resolved",
                closed: true,
                resolved: true,
                // Gamma sends these JSON-encoded.
                outcomePrices: '["1", "0"]',
                outcomes: '["Yes", "No"]',
              },
            ]),
        }) as never,
    });

    await poller.pollOnce(["0xresolved"]);

    expect(inserts).toHaveLength(1);
    const payload = JSON.parse(String(inserts[0]?.params[2])) as {
      raw: { outcomePrices: string[]; outcomes: string[] };
    };
    // Without the outcome the RFC-010 label store has nothing to score.
    expect(payload.raw.outcomePrices).toEqual(["1", "0"]);
    expect(payload.raw.outcomes).toEqual(["Yes", "No"]);
  });
});

describe("resolution follow-up after a market leaves the universe", () => {
  it("asks Gamma with closed=true, without which a resolved market is invisible", async () => {
    // Verified against the live API: /markets defaults to closed=false, so the
    // same condition_id returns 0 results without the filter and the resolved
    // market with it. This is the reason no label could ever be produced.
    const urls: string[] = [];
    const inserts: unknown[][] = [];
    const pool = {
      query<R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<{ rows: R[]; rowCount: number }> {
        if (text.includes("INSERT INTO polymarket_resolution_events")) {
          inserts.push([...(params ?? [])]);
        }
        if (text.includes("WITH membership")) {
          return Promise.resolve({
            rows: [{ condition_id: "0xgone" } as unknown as R],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const poller = createUmaStatusPoller({
      pool: pool as never,
      clock: () => Date.parse("2026-08-21T23:00:00.000Z"),
      fetcher: ((url: string) => {
        urls.push(url);
        const isClosedQuery = url.includes("closed=true");
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              isClosedQuery
                ? [
                    {
                      conditionId: "0xgone",
                      umaResolutionStatus: "resolved",
                      closed: true,
                      resolved: true,
                      outcomePrices: '["1", "0"]',
                      outcomes: '["Yes", "No"]',
                    },
                  ]
                : [],
            ),
        });
      }) as never,
    });

    await poller.pollPendingOnce();

    // Both filters are tried: still-open markets awaiting liveness, and
    // already-closed ones.
    expect(urls.some((url) => url.includes("closed=true"))).toBe(true);
    expect(urls.some((url) => !url.includes("closed=true"))).toBe(true);

    expect(inserts).toHaveLength(1);
    const [conditionId, eventType, payloadJson] = inserts[0] ?? [];
    expect(conditionId).toBe("0xgone");
    expect(eventType).toBe("resolved");
    const payload = JSON.parse(String(payloadJson)) as {
      raw: { outcomePrices: string[] };
    };
    // With the outcome attached, the label store finally has something to score.
    expect(payload.raw.outcomePrices).toEqual(["1", "0"]);
  });

  it("asks Gamma with include_tag=true, without which it erases categories", async () => {
    // The sweep's payload does not merely inform the affirmative-token
    // mapping — it is written to the metadata history as an observation. Gamma
    // omits the tag array unless asked, tags are the PRIMARY classifier, and a
    // tagless payload therefore demotes every market to the keyword fallback.
    //
    // Measured in production on 2026-08-27: 30 markets had a crypto/macro
    // category replaced by NULL in two days this way, 29 of them still
    // unresolved — every one destined for the report's `unknown` bucket and
    // invisible to the G5 regime query in the meantime.
    const urls: string[] = [];
    const pool = {
      query<R extends Record<string, unknown>>(
        text: string,
      ): Promise<{ rows: R[]; rowCount: number }> {
        if (text.includes("WITH membership")) {
          return Promise.resolve({
            rows: [{ condition_id: "0xgone" } as unknown as R],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const poller = createUmaStatusPoller({
      pool: pool as never,
      clock: () => Date.parse("2026-08-21T23:00:00.000Z"),
      fetcher: ((url: string) => {
        urls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([]),
        });
      }) as never,
    });

    await poller.pollPendingOnce();

    expect(urls.length).toBeGreaterThan(0);
    // EVERY call, not merely one of them: the open and closed queries both
    // reach backfillMetadata.
    for (const url of urls) {
      expect(url).toContain("include_tag=true");
    }
  });

  it("carries the category forward when the observed one is null", async () => {
    // A null category is "not observed", never "no category". The sweep used to
    // write it straight through, closing a crypto/macro window and opening an
    // uncategorized one — irreversibly, since the registry re-observes only the
    // CURRENT universe and these markets have already left it.
    const captured: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      query<R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<{ rows: R[]; rowCount: number }> {
        captured.push({ text, params: [...(params ?? [])] });
        if (text.includes("WITH membership")) {
          return Promise.resolve({
            rows: [{ condition_id: "0xgone" } as unknown as R],
            rowCount: 1,
          });
        }
        // The open window: this market is known to be crypto.
        if (text.includes("FROM polymarket_market_metadata_versions")) {
          return Promise.resolve({
            rows: [
              {
                version: 4,
                question: "Will STRC hit $100 by September 30?",
                category: "crypto",
                clob_token_ids: ["tokenYes", "tokenNo"],
                affirmative_token_id: "tokenYes",
                valid_from: new Date("2026-08-20T00:00:00.000Z"),
              } as unknown as R,
            ],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    // A real in-universe market whose question the keyword list does not name,
    // arriving WITHOUT tags — the exact payload that cost 30 categories.
    const market = {
      conditionId: "0xgone",
      question: "Will STRC hit $100 by September 30?",
      slug: "strc-100-sep-30",
      clobTokenIds: '["tokenYes", "tokenNo"]',
      description: "Resolves YES if the price prints at or above $100.",
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0", "1"]',
      umaResolutionStatus: "proposed",
      closed: false,
      resolved: false,
      updatedAt: "2026-08-21T22:00:00.000Z",
    };
    const poller = createUmaStatusPoller({
      pool: pool as never,
      clock: () => Date.parse("2026-08-21T23:00:00.000Z"),
      fetcher: ((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(url.includes("closed=true") ? [] : [market]),
        })) as never,
    });

    await poller.pollPendingOnce();

    // Nothing was written at all: with the category carried forward, the
    // observation is identical to the open window and the write is skipped.
    const insert = captured.find((query) =>
      query.text.includes("INSERT INTO polymarket_market_metadata_versions"),
    );
    expect(insert).toBeUndefined();
    const close = captured.find((query) => query.text.includes("SET valid_to"));
    expect(close).toBeUndefined();
  });

  it("backfills the affirmative-token mapping for markets that already left the universe", async () => {
    // Measured in production on 2026-08-25: 100/100 in-universe markets were
    // mapped and 99/99 recently-exited ones were not, because migration 0012 is
    // prospective and the registry only re-observes the CURRENT universe. The
    // RFC-012 resolution service scores the exited-but-unresolved window too and
    // fails closed on a missing mapping, so it would have crash-looped forever.
    // Every market that exits without resolving joins that window, so waiting it
    // out never converges — the mapping has to be backfilled here.
    const captured: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      query<R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<{ rows: R[]; rowCount: number }> {
        captured.push({ text, params: [...(params ?? [])] });
        if (text.includes("WITH membership")) {
          return Promise.resolve({
            rows: [{ condition_id: "0xgone" } as unknown as R],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const market = {
      conditionId: "0xgone",
      question: "Will BTC be up?",
      slug: "btc-up",
      category: "crypto",
      negRisk: false,
      clobTokenIds: '["tokenUp", "tokenDown"]',
      description: "resolves by Chainlink",
      outcomes: '["Up", "Down"]',
      outcomePrices: '["1", "0"]',
      umaResolutionStatus: "proposed",
      closed: false,
      resolved: false,
      updatedAt: "2026-08-21T22:00:00.000Z",
    };
    const poller = createUmaStatusPoller({
      pool: pool as never,
      clock: () => Date.parse("2026-08-21T23:00:00.000Z"),
      fetcher: ((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(url.includes("closed=true") ? [] : [market]),
        })) as never,
    });

    await poller.pollPendingOnce();

    const insert = captured.find((query) =>
      query.text.includes("INSERT INTO polymarket_market_metadata_versions"),
    );
    expect(insert).toBeDefined();
    // "Up" is the affirmative outcome, so its token is the mapped one — taken
    // by NAME, never by array position.
    expect(insert?.params).toContain("tokenUp");
    expect(insert?.params).toContain("0xgone");
  });

  it("never guesses the affirmative token when the outcomes are not a binary Yes/No or Up/Down pair", async () => {
    const captured: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      query<R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<{ rows: R[]; rowCount: number }> {
        captured.push({ text, params: [...(params ?? [])] });
        if (text.includes("WITH membership")) {
          return Promise.resolve({
            rows: [{ condition_id: "0xamb" } as unknown as R],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const poller = createUmaStatusPoller({
      pool: pool as never,
      clock: () => Date.parse("2026-08-21T23:00:00.000Z"),
      fetcher: ((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              url.includes("closed=true")
                ? []
                : [
                    {
                      conditionId: "0xamb",
                      question: "Who wins?",
                      slug: "who-wins",
                      category: "politics",
                      negRisk: false,
                      clobTokenIds: '["a", "b"]',
                      description: "rules",
                      outcomes: '["Alice", "Bob"]',
                      umaResolutionStatus: "proposed",
                      closed: false,
                      resolved: false,
                      updatedAt: "2026-08-21T22:00:00.000Z",
                    },
                  ],
            ),
        })) as never,
    });

    await poller.pollPendingOnce();

    const insert = captured.find((query) =>
      query.text.includes("INSERT INTO polymarket_market_metadata_versions"),
    );
    // The row is still written (question/category/tokens are real observations)
    // but the affirmative token stays null: mapping the wrong one would invert
    // the price semantics of the whole RFC-012 graph.
    expect(insert).toBeDefined();
    expect(insert?.params).not.toContain("a");
    expect(insert?.params).not.toContain("b");
    expect(insert?.params).toContain(null);
  });

  it("follows only markets that left the universe without resolving", async () => {
    const captured: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      query<R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<{ rows: R[]; rowCount: number }> {
        captured.push({ text, params: [...(params ?? [])] });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const now = new Date("2026-08-21T23:00:00.000Z");
    await pendingResolutionIds(pool as never, now);

    const query = captured[0];
    expect(query?.text).toContain("action = 'exit'");
    // A market that already reached a terminal state is not followed again.
    expect(query?.text).toContain("t.condition_id IS NULL");
    expect(query?.text).toContain("'resolved', 'market_resolved'");
    // Bounded in both time and size, so the Gamma load stays predictable.
    expect(query?.params[0]).toBeInstanceOf(Date);
    expect((query?.params[0] as Date).getTime()).toBe(
      now.getTime() - PENDING_RESOLUTION_LOOKBACK_MS,
    );
    expect(query?.params[1]).toBe(PENDING_RESOLUTION_LIMIT);
  });
});
