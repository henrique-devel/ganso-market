// RFC-012 task 1, part 2: the onchain UMA Adapter collector. READ-ONLY
// eth_getLogs polling over public Polygon RPC with native fetch — the one
// deliberately allowed network surface of this module (the scope test pins
// it to this file). Addresses and event signatures were verified against
// Polymarket/uma-ctf-adapter (v2.0.0 and main) at development start; the
// decoder refuses anything it cannot prove well-formed. State-changing RPC
// methods do not exist here.

import { adapterTopicMap, decodeAdapterLog, type RpcLog } from "./abi.js";
import type { OnchainConfig } from "./config.js";
import type { ResolutionPool, UmaResult } from "./types.js";

const SERVICE = "polymarket-resolution";

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      ...extra,
    })}\n`,
  );
}

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface OnchainDeps {
  readonly pool: ResolutionPool;
  readonly config: OnchainConfig;
  readonly fetchFn?: FetchLike;
  readonly clock?: () => Date;
}

interface RpcResponse {
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string };
}

/** JSON-RPC call with URL failover; throws when every URL failed. */
async function rpcCall(
  deps: OnchainDeps,
  method: string,
  params: readonly unknown[],
): Promise<unknown> {
  const fetchFn = deps.fetchFn ?? (fetch as unknown as FetchLike);
  let lastError: unknown = new Error("no rpc url configured");
  for (const url of deps.config.rpcUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        deps.config.requestTimeoutMs,
      );
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`rpc ${method} returned http ${response.status}`);
      }
      const body = (await response.json()) as RpcResponse;
      if (body.error !== undefined) {
        throw new Error(`rpc ${method} error ${body.error.code ?? ""}`);
      }
      return body.result;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw lastError;
}

function hexQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

function toRpcLog(value: unknown): RpcLog | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.address !== "string" ||
    !Array.isArray(record.topics) ||
    typeof record.data !== "string" ||
    typeof record.blockNumber !== "string" ||
    typeof record.transactionHash !== "string" ||
    typeof record.logIndex !== "string"
  ) {
    return null;
  }
  return {
    address: record.address,
    topics: record.topics.filter(
      (item): item is string => typeof item === "string",
    ),
    data: record.data,
    blockNumber: record.blockNumber,
    transactionHash: record.transactionHash,
    logIndex: record.logIndex,
  };
}

export interface OnchainPollSummary {
  readonly adapters: number;
  readonly inserted: number;
  readonly decodedUnknown: number;
  /** Decoded fine but for a questionID no recorded market names: not stored. */
  readonly skippedUnmapped: number;
  readonly toBlock: bigint | null;
}

/**
 * One collector pass: for each adapter, scan forward from its cursor in
 * bounded chunks, staying `confirmations` blocks behind the head. Inserts are
 * idempotent (tx_hash, log_index); the cursor only advances after a chunk is
 * fully persisted, so a crash re-reads at most one chunk.
 */
export async function pollOnchainOnce(
  deps: OnchainDeps,
): Promise<OnchainPollSummary | null> {
  if (!deps.config.enabled) {
    return null;
  }
  const headRaw = await rpcCall(deps, "eth_blockNumber", []);
  const head = hexQuantity(headRaw);
  if (head === null) {
    throw new Error("rpc head is not a quantity");
  }
  const target = head - BigInt(deps.config.confirmations);
  if (target <= 0n) {
    return {
      adapters: 0,
      inserted: 0,
      decodedUnknown: 0,
      skippedUnmapped: 0,
      toBlock: null,
    };
  }
  // Budget guard: the adapters carry EVERY Polymarket market (measured live:
  // thousands of logs per 10k blocks). Only events whose questionID names a
  // market this recorder has ever seen are stored — the module's dispute
  // history is prospective over the recorded universe, not venue-wide.
  const known = await deps.pool.query<Record<string, unknown>>(
    `SELECT question_id FROM polymarket_markets WHERE question_id IS NOT NULL`,
  );
  const knownQuestionIds = new Set<string>(
    known.rows
      .map((row) => row.question_id)
      .filter((value): value is string => typeof value === "string"),
  );
  const topics = [...adapterTopicMap().keys()];
  let inserted = 0;
  let decodedUnknown = 0;
  let skippedUnmapped = 0;
  let lastScanned: bigint | null = null;

  for (const adapter of deps.config.adapters) {
    const cursorRow = await deps.pool.query<Record<string, unknown>>(
      `SELECT last_block FROM resolution_onchain_cursor WHERE adapter_address = $1`,
      [adapter],
    );
    const cursor =
      cursorRow.rows.length > 0
        ? BigInt(String(cursorRow.rows[0]?.last_block ?? 0))
        : target - BigInt(deps.config.lookbackBlocks) > 0n
          ? target - BigInt(deps.config.lookbackBlocks)
          : 0n;

    let from = cursor + 1n;
    for (
      let chunk = 0;
      chunk < deps.config.maxChunksPerPoll && from <= target;
      chunk += 1
    ) {
      const to =
        from + BigInt(deps.config.chunkBlocks) - 1n < target
          ? from + BigInt(deps.config.chunkBlocks) - 1n
          : target;
      const logsRaw = await rpcCall(deps, "eth_getLogs", [
        {
          address: adapter,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: [topics],
        },
      ]);
      const logs = Array.isArray(logsRaw) ? logsRaw : [];
      const blockTimestamps = new Map<string, Date | null>();
      for (const rawLog of logs) {
        const log = toRpcLog(rawLog);
        if (log === null) {
          decodedUnknown += 1;
          continue;
        }
        const decoded = decodeAdapterLog(log);
        if (decoded === null) {
          decodedUnknown += 1;
          continue;
        }
        if (!knownQuestionIds.has(decoded.questionId)) {
          skippedUnmapped += 1;
          continue;
        }
        const blockKey = log.blockNumber;
        if (!blockTimestamps.has(blockKey)) {
          blockTimestamps.set(blockKey, await blockTimestamp(deps, blockKey));
        }
        const result = await deps.pool.query(
          `INSERT INTO resolution_onchain_events
             (adapter_address, event_name, question_id, args_json,
              block_number, block_ts, tx_hash, log_index)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
           ON CONFLICT ON CONSTRAINT resolution_onchain_events_dedupe DO NOTHING`,
          [
            adapter,
            decoded.eventName,
            decoded.questionId,
            JSON.stringify(decoded.args),
            decoded.blockNumber.toString(),
            blockTimestamps.get(blockKey) ?? null,
            decoded.txHash,
            decoded.logIndex,
          ],
        );
        inserted += result.rowCount;
      }
      await deps.pool.query(
        `INSERT INTO resolution_onchain_cursor (adapter_address, last_block, updated_at)
         VALUES ($1,$2,CURRENT_TIMESTAMP)
         ON CONFLICT (adapter_address) DO UPDATE SET
           last_block = EXCLUDED.last_block,
           updated_at = CURRENT_TIMESTAMP`,
        [adapter, to.toString()],
      );
      lastScanned = to;
      from = to + 1n;
    }
  }

  if (inserted > 0) {
    await applyOnchainTimeline(deps.pool);
  }
  return {
    adapters: deps.config.adapters.length,
    inserted,
    decodedUnknown,
    skippedUnmapped,
    toBlock: lastScanned,
  };
}

async function blockTimestamp(
  deps: OnchainDeps,
  blockNumberHex: string,
): Promise<Date | null> {
  try {
    const block = await rpcCall(deps, "eth_getBlockByNumber", [
      blockNumberHex,
      false,
    ]);
    if (typeof block !== "object" || block === null) {
      return null;
    }
    const ts = hexQuantity((block as Record<string, unknown>).timestamp);
    return ts === null ? null : new Date(Number(ts) * 1_000);
  } catch {
    return null;
  }
}

/** payouts -> P1/P2/P3; [1,1] means 50/50 (payout numerators). */
export function resultFromPayouts(
  payouts: readonly string[] | null,
  tooEarly: boolean,
): UmaResult | null {
  if (tooEarly) {
    return "P4";
  }
  if (payouts === null || payouts.length < 2) {
    return null;
  }
  const yes = payouts[0];
  const no = payouts[1];
  if (yes === no) {
    return "P3";
  }
  if (yes === "1" && no === "0") {
    return "P2";
  }
  if (yes === "0" && no === "1") {
    return "P1";
  }
  return null;
}

/**
 * Fold raw adapter events into the request timeline (source 'onchain'). The
 * adapter's own semantics: QuestionReset is the reaction to the FIRST dispute
 * (new request, clock restarts); after the second dispute only the DVM or a
 * manual path settles. Markets are mapped by the registry-captured
 * questionID; unmapped events stay raw until the registry observes the id.
 * A 50/50 settlement on a negRisk market is recorded as IMPOSSIBLE (the
 * NegRiskAdapter reverts on [1,1]) — result stays null and the anomaly is
 * flagged instead of normalized.
 */
export async function applyOnchainTimeline(
  pool: ResolutionPool,
): Promise<number> {
  const rows = await pool.query<Record<string, unknown>>(
    `SELECT e.onchain_event_id, e.event_name, e.question_id, e.args_json,
            e.block_ts, e.received_at, e.tx_hash, e.log_index,
            m.condition_id, m.neg_risk
       FROM resolution_onchain_events e
       JOIN polymarket_markets m ON m.question_id = e.question_id
      ORDER BY e.question_id, e.block_number ASC, e.log_index ASC`,
  );
  let written = 0;
  let currentQuestion: string | null = null;
  let requestIndex: 1 | 2 = 1;
  for (const row of rows.rows) {
    const questionId = String(row.question_id);
    if (questionId !== currentQuestion) {
      currentQuestion = questionId;
      requestIndex = 1;
    }
    const conditionId = String(row.condition_id);
    const eventName = String(row.event_name);
    const occurredAt =
      row.block_ts instanceof Date
        ? row.block_ts
        : row.received_at instanceof Date
          ? row.received_at
          : new Date(String(row.received_at));
    const sourceRef = `${String(row.tx_hash)}:${String(row.log_index)}`;
    const args =
      typeof row.args_json === "object" && row.args_json !== null
        ? (row.args_json as Record<string, unknown>)
        : {};

    let state: string | null = null;
    let result: UmaResult | null = null;
    let payouts: readonly string[] | null = null;
    let impossible = false;
    switch (eventName) {
      case "QuestionInitialized":
        state = "proposed";
        break;
      case "QuestionReset":
        state = "reset";
        break;
      case "QuestionFlagged":
        state = "flagged";
        break;
      case "QuestionPaused":
        state = "paused";
        break;
      case "QuestionUnpaused":
        state = "unpaused";
        break;
      case "QuestionResolved":
      case "QuestionEmergencyResolved":
      case "QuestionManuallyResolved": {
        state = "settled";
        payouts = Array.isArray(args.payouts)
          ? (args.payouts as unknown[]).filter(
              (item): item is string => typeof item === "string",
            )
          : null;
        result = resultFromPayouts(payouts, args.tooEarly === true);
        if (result === "P3" && row.neg_risk === true) {
          // Structurally impossible: the NegRiskAdapter reverts on [1, 1].
          impossible = true;
          result = null;
        }
        break;
      }
      default:
        break;
    }
    if (state === null) {
      continue;
    }
    const inserted = await pool.query(
      `INSERT INTO resolution_uma_timeline
         (condition_id, question_id, request_index, state, result,
          payouts_json, bond, custom_liveness, source, source_ref, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,NULL,'onchain',$8,$9)
       ON CONFLICT ON CONSTRAINT resolution_uma_timeline_dedupe DO NOTHING`,
      [
        conditionId,
        questionId,
        requestIndex,
        state,
        result,
        payouts === null ? null : JSON.stringify(payouts),
        typeof args.proposalBond === "string" ? args.proposalBond : null,
        sourceRef,
        occurredAt,
      ],
    );
    written += inserted.rowCount;
    if (impossible) {
      logJson("error", "NEGRISK_5050_IMPOSSIBLE", {
        condition_id: conditionId,
        question_id: questionId,
        source_ref: sourceRef,
      });
    }
    if (state === "reset") {
      requestIndex = 2;
    }
  }
  return written;
}
