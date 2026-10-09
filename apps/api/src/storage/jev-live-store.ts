import { jevLiveAuthorityTx } from "./jev-promotion.js";
import type { DatabasePool, SqlExecutor } from "../database.js";
import type { JevScope } from "@ganso-market/contracts/trading";
import { jevHash } from "./jev-hash.js";
import { assertEvidenceJson } from "../trading/retention.js";
import {
  liveCheck,
  liveCloid,
  validateLiveIdentity,
  type LiveIdentity,
  type LiveGate,
  type LiveReservation,
} from "../venues/hyperliquid/live-contract.js";
import type { LiveSnapshot } from "../venues/hyperliquid/live-reconcile.js";
import { readJevEntriesTx } from "./jev-riskstore.js";
import {
  buildLiveAction,
  type LiveCommand,
} from "../venues/hyperliquid/live-execution.js";
import { commandJevPilot, readJevPilotTx } from "./jev-pilotstore.js";

type Pool = Pick<DatabasePool, "transaction">;
export interface LiveLease {
  process_id: string;
  generation: string;
  lease_until: number;
}
export type LiveEventKind =
  | "snapshot"
  | "fill"
  | "funding"
  | "receipt"
  | "gap"
  | "protection"
  | "balance";
export interface LiveBalanceProof {
  version: "hyperliquid.live-balance.v1";
  identity_hash: string;
  snapshot_id: string;
  opening_evidence_id: string | null;
  expected_trading_balance_raw: string | null;
  observed_trading_balance_raw: string;
  reconciled: boolean;
  reason: "RECONCILED" | "INITIAL_CAPITAL_UNKNOWN" | "BALANCE_UNEXPLAINED";
}
export interface LiveStore {
  identity: LiveIdentity;
  append(kind: LiveEventKind, key: string, payload: unknown): Promise<void>;
  save(snapshot: LiveSnapshot): Promise<void>;
  latest(): Promise<{ snapshot: LiveSnapshot | null; pending: boolean }>;
  reserve(input: {
    scope: JevScope;
    operation_id: string;
    kind: LiveReservation["kind"];
    action: (cloid: `0x${string}`) => Record<string, unknown>;
    request: unknown;
    lease: LiveLease;
  }): Promise<{ fresh: boolean; reservation: LiveReservation }>;
  gate(reservation: LiveReservation): Promise<LiveGate>;
  operations(): Promise<LiveReservation[]>;
  events<T>(kind: LiveEventKind): Promise<T[]>;
}
async function dbNow(tx: SqlExecutor) {
  return (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.getTime();
}
/** Account row is shared with risk/profile writers. The signer owns every nonce;
 * requests and external observations remain immutable across leases/restarts. */
export class PgLiveStore implements LiveStore {
  readonly identity: LiveIdentity;
  readonly identityHash: string;
  constructor(
    readonly pool: Pool,
    identity: LiveIdentity,
  ) {
    this.identity = Object.freeze(structuredClone(identity));
    this.identityHash = validateLiveIdentity(this.identity);
  }
  async register() {
    const i = this.identity;
    await this.pool.transaction(async (tx) => {
      const account = (
        await tx.query<{ instrument_id: string }>(
          "SELECT instrument_id FROM jev_accounts WHERE account_id=$1 AND owner_id=$2 AND mode='live' FOR UPDATE",
          [i.account_id, i.owner_id],
        )
      ).rows[0];
      liveCheck(
        account?.instrument_id === `hyperliquid:${i.environment}:BTC`,
        "ACCOUNT_ENVIRONMENT",
      );
      await tx.query(
        "INSERT INTO jev_live_identities(identity_hash,account_id,owner_id,environment,account_address,signer_address,identity) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING",
        [
          this.identityHash,
          i.account_id,
          i.owner_id,
          i.environment,
          i.account_address,
          i.signer_address,
          JSON.stringify(i),
        ],
      );
      const found = (
        await tx.query(
          "SELECT identity FROM jev_live_identities WHERE identity_hash=$1",
          [this.identityHash],
        )
      ).rows[0];
      liveCheck(
        found && jevHash(found.identity) === this.identityHash,
        "IDENTITY_COLLISION",
      );
    });
  }
  private async lock(tx: SqlExecutor) {
    const r = (
      await tx.query(
        "SELECT identity FROM jev_accounts WHERE account_id=$1 AND owner_id=$2 AND mode='live' FOR UPDATE",
        [this.identity.account_id, this.identity.owner_id],
      )
    ).rows[0];
    liveCheck(r, "ACCOUNT_OWNER");
    liveCheck(
      (
        await tx.query(
          "SELECT identity_hash FROM jev_live_identities WHERE identity_hash=$1",
          [this.identityHash],
        )
      ).rows.length === 1,
      "IDENTITY_UNREGISTERED",
    );
  }
  async claim(process_id: string, ttl = 6000): Promise<LiveLease> {
    liveCheck(
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(process_id) &&
        ttl >= 2000 &&
        ttl <= 10000,
      "LEASE_REQUEST",
    );
    return this.pool.transaction(async (tx) => {
      await this.lock(tx);
      const now = await dbNow(tx);
      const old = (
        await tx.query<{
          process_id: string;
          generation: string;
          lease_until: Date;
        }>(
          "SELECT process_id,generation::text,lease_until FROM jev_live_owners WHERE identity_hash=$1 FOR UPDATE",
          [this.identityHash],
        )
      ).rows[0];
      liveCheck(
        !old ||
          old.process_id === process_id ||
          old.lease_until.getTime() <= now,
        "OWNERSHIP_BUSY",
      );
      const generation =
        old && old.process_id === process_id && old.lease_until.getTime() > now
          ? old.generation
          : (BigInt(old?.generation ?? "0") + 1n).toString();
      await tx.query(
        old
          ? "UPDATE jev_live_owners SET process_id=$2,generation=$3,lease_until=$4 WHERE identity_hash=$1"
          : "INSERT INTO jev_live_owners(identity_hash,process_id,generation,lease_until) VALUES($1,$2,$3,$4)",
        [this.identityHash, process_id, generation, new Date(now + ttl)],
      );
      return { process_id, generation, lease_until: now + ttl };
    });
  }
  private async eventTx(
    tx: SqlExecutor,
    kind: LiveEventKind,
    key: string,
    payload: unknown,
  ) {
    assertEvidenceJson(payload);
    const hash = jevHash(payload);
    const previous = (
      await tx.query(
        "SELECT payload_hash,kind FROM jev_live_events WHERE identity_hash=$1 AND event_key=$2",
        [this.identityHash, key],
      )
    ).rows[0];
    if (previous) {
      liveCheck(
        previous.payload_hash === hash && previous.kind === kind,
        "SOURCE_COLLISION",
      );
      return;
    }
    await tx.query(
      "INSERT INTO jev_live_events(identity_hash,event_key,kind,payload_hash,payload) VALUES($1,$2,$3,$4,$5::jsonb)",
      [this.identityHash, key, kind, hash, JSON.stringify(payload)],
    );
  }
  async append(kind: LiveEventKind, key: string, payload: unknown) {
    await this.pool.transaction(async (tx) => {
      await this.lock(tx);
      await this.eventTx(tx, kind, key, payload);
    });
  }
  async save(snapshot: LiveSnapshot) {
    liveCheck(snapshot.identity_hash === this.identityHash, "SNAPSHOT_OWNER");
    await this.pool.transaction(async (tx) => {
      await this.lock(tx);
      const old = (
        await tx.query<{ payload: LiveSnapshot }>(
          "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='snapshot' ORDER BY recorded_at DESC,event_key DESC LIMIT 1",
          [this.identityHash],
        )
      ).rows[0]?.payload;
      liveCheck(
        !old || snapshot.received_at >= old.received_at,
        "SNAPSHOT_OUT_OF_ORDER",
      );
      for (const f of snapshot.fills) await this.eventTx(tx, "fill", f.key, f);
      for (const f of snapshot.funding)
        await this.eventTx(tx, "funding", f.key, f);
      await this.eventTx(
        tx,
        "snapshot",
        `snapshot:${snapshot.snapshot_id}`,
        snapshot,
      );
      await this.proveBalanceTx(tx, snapshot);
    });
  }
  private async balanceTx(tx: SqlExecutor, snapshot: LiveSnapshot | null) {
    if (!snapshot) return null;
    return (
      (
        await tx.query<{ payload: LiveBalanceProof }>(
          "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='balance' AND payload->>'snapshot_id'=$2 ORDER BY recorded_at DESC,event_key DESC LIMIT 1",
          [this.identityHash, snapshot.snapshot_id],
        )
      ).rows[0]?.payload ?? null
    );
  }
  /** Only the existing admission's actual flat cash can anchor the lifetime
   * proof. An unexplained deposit/withdrawal or absent source stays pending;
   * neither an invoice nor a configured capital is a trading-cash receipt. */
  private async proveBalanceTx(tx: SqlExecutor, snapshot: LiveSnapshot) {
    const opening = (
      await tx.query<{
        observation: import("./jev-pilotstore.js").JevPilotObservation;
      }>(
        "SELECT checkpoint->'observation' observation FROM jev_pilot_events WHERE account_id=$1 AND sequence=1",
        [this.identity.account_id],
      )
    ).rows[0]?.observation;
    const source = opening?.original as LiveSnapshot | undefined;
    const anchor = opening ? Date.parse(opening.observed_at) : NaN;
    const anchored =
      this.identity.environment === "mainnet" &&
      opening?.source === "hyperliquid:mainnet:reconciliation" &&
      opening.reconciled &&
      opening.flat &&
      opening.trading_balance_usd_raw === "250000000" &&
      opening.open_pnl_usd_raw === "0" &&
      source?.version === "hyperliquid.live.v1" &&
      source.identity_hash === this.identityHash &&
      source.snapshot_id === opening.evidence_id &&
      source.flat &&
      source.consistent &&
      source.history_complete &&
      source.position_raw === "0" &&
      source.trading_balance_raw === opening.trading_balance_usd_raw &&
      source.open_pnl_raw === "0" &&
      source.venue_at === anchor &&
      Number.isSafeInteger(anchor) &&
      anchor <= snapshot.venue_at;
    let expected: string | null = null;
    if (anchored) {
      const money = (
        await tx.query<{ change_raw: string }>(
          "SELECT COALESCE(sum(CASE WHEN kind='fill' THEN (payload->>'realized_pnl_raw')::numeric-(payload->>'fee_raw')::numeric ELSE (payload->>'amount_raw')::numeric END),0)::text change_raw FROM jev_live_events WHERE identity_hash=$1 AND kind IN ('fill','funding') AND (payload->>'time')::bigint >= $2 AND (payload->>'time')::bigint <= $3",
          [this.identityHash, anchor, snapshot.venue_at],
        )
      ).rows[0]!;
      expected = (
        BigInt(opening.trading_balance_usd_raw) + BigInt(money.change_raw)
      ).toString();
    }
    const reconciled =
      expected !== null &&
      expected === snapshot.trading_balance_raw &&
      snapshot.consistent &&
      snapshot.history_complete;
    const proof: LiveBalanceProof = {
      version: "hyperliquid.live-balance.v1",
      identity_hash: this.identityHash,
      snapshot_id: snapshot.snapshot_id,
      opening_evidence_id: anchored ? opening.evidence_id : null,
      expected_trading_balance_raw: expected,
      observed_trading_balance_raw: snapshot.trading_balance_raw,
      reconciled,
      reason: reconciled
        ? "RECONCILED"
        : expected === null
          ? "INITIAL_CAPITAL_UNKNOWN"
          : "BALANCE_UNEXPLAINED",
    };
    await this.eventTx(tx, "balance", `balance:${jevHash(proof)}`, proof);
  }
  async latest() {
    return this.pool.transaction(async (tx) => {
      const rows = (
        await tx.query<{
          kind: string;
          payload: LiveSnapshot;
          recorded_at: Date;
        }>(
          "SELECT DISTINCT ON(kind) kind,payload,recorded_at FROM jev_live_events WHERE identity_hash=$1 AND kind IN ('snapshot','gap') ORDER BY kind,recorded_at DESC,event_key DESC",
          [this.identityHash],
        )
      ).rows;
      const s = rows.find((r) => r.kind === "snapshot"),
        gap = rows.find((r) => r.kind === "gap");
      const balance = await this.balanceTx(tx, s?.payload ?? null);
      return {
        snapshot: s?.payload ?? null,
        pending:
          !s ||
          !s.payload.consistent ||
          !s.payload.history_complete ||
          !balance?.reconciled ||
          (!!gap && gap.recorded_at >= s.recorded_at),
      };
    });
  }
  async reserve(input: Parameters<LiveStore["reserve"]>[0]) {
    const cloid = liveCloid(this.identity, input.scope, input.operation_id),
      request_hash = jevHash({
        scope: input.scope,
        kind: input.kind,
        operation_id: input.operation_id,
        request: input.request,
      });
    return this.pool.transaction(async (tx) => {
      await this.lock(tx);
      const existing = (
        await tx.query<{ reservation: LiveReservation }>(
          "SELECT reservation FROM jev_live_requests WHERE identity_hash=$1 AND operation_id=$2",
          [this.identityHash, input.operation_id],
        )
      ).rows[0];
      if (existing) {
        liveCheck(
          existing.reservation.request_hash === request_hash,
          "IDEMPOTENCY_COLLISION",
        );
        return { fresh: false, reservation: existing.reservation };
      }
      const now = await dbNow(tx),
        o = (
          await tx.query<{
            process_id: string;
            generation: string;
            lease_until: Date;
          }>(
            "SELECT process_id,generation::text,lease_until FROM jev_live_owners WHERE identity_hash=$1 FOR UPDATE",
            [this.identityHash],
          )
        ).rows[0];
      liveCheck(
        o &&
          o.process_id === input.lease.process_id &&
          o.generation === input.lease.generation &&
          o.lease_until.getTime() > now,
        "FENCE",
      );
      const previous = (
        await tx.query<{ nonce: string | null }>(
          "SELECT MAX(nonce)::text AS nonce FROM jev_live_requests WHERE environment=$1 AND signer_address=$2",
          [this.identity.environment, this.identity.signer_address],
        )
      ).rows[0]!.nonce;
      const nonce = Math.max(now, Number(previous ?? 0) + 1);
      liveCheck(nonce <= now + 1000, "NONCE_CLOCK");
      const command = input.request as LiveCommand;
      liveCheck(
        command.version === "hyperliquid.live-command.v1" &&
          command.kind === input.kind &&
          command.operation_id === input.operation_id &&
          jevHash(command.scope) === jevHash(input.scope),
        "COMMAND_CONTRACT",
      );
      const action = buildLiveAction(this.identity, command, cloid, now);
      liveCheck(
        jevHash(action) === jevHash(input.action(cloid)),
        "ACTION_INTENT",
      );
      if (command.kind === "cancel") {
        const target = (
          await tx.query<{ reservation: LiveReservation }>(
            "SELECT reservation FROM jev_live_requests WHERE identity_hash=$1 AND operation_id=$2",
            [this.identityHash, command.target_operation_id],
          )
        ).rows[0]?.reservation;
        liveCheck(
          target?.kind === "entry" &&
            target.cloid === command.target_cloid &&
            jevHash(target.scope) === jevHash(input.scope),
          "CANCEL_OWNER",
        );
      }
      if (command.kind === "stop") {
        const anchor = (
          await tx.query<{
            payload: {
              protection: Extract<LiveCommand, { kind: "stop" }>["protection"];
            };
          }>(
            "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='protection' AND payload->>'position_id'=$2 AND payload->'protection' IS NOT NULL ORDER BY recorded_at DESC,event_key DESC LIMIT 1",
            [this.identityHash, command.protection.position_id],
          )
        ).rows[0]?.payload.protection;
        liveCheck(
          anchor &&
            jevHash({
              ...anchor,
              quantity_btc_raw: command.protection.quantity_btc_raw,
            }) === jevHash(command.protection),
          "STOP_ANCHOR",
        );
      }
      if (input.kind === "entry") {
        const c = input.request as LiveCommand;
        liveCheck(
          c.version === "hyperliquid.live-command.v1" && c.kind === "entry",
          "ENTRY_CONTRACT",
        );
        const entries = await readJevEntriesTx(tx, this.identity.account_id);
        const e = entries.find((e) => e.order_id === c.plan.input.order_id);
        const profile = (
          await tx.query<{ manifest_hash: string }>(
            "SELECT manifest_hash FROM jev_profiles WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3",
            [
              input.scope.owner_id,
              input.scope.profile_id,
              input.scope.profile_version,
            ],
          )
        ).rows[0];
        liveCheck(
          e?.status === "reserved" &&
            e.plan_hash === jevHash(c.plan) &&
            jevHash(e.plan) === e.plan_hash &&
            jevHash(e.plan.input.scope) === jevHash(input.scope) &&
            profile?.manifest_hash === c.plan.manifest_hash,
          "FINANCIAL_RESERVATION",
        );
        const sent = (
          await tx.query<{ reservation: LiveReservation }>(
            "SELECT reservation FROM jev_live_requests WHERE identity_hash=$1 AND reservation->>'kind'='entry'",
            [this.identityHash],
          )
        ).rows;
        liveCheck(
          !sent.some(
            (r) =>
              (
                r.reservation.request as LiveCommand & {
                  plan: { input: { order_id: string } };
                }
              ).plan.input.order_id === c.plan.input.order_id,
          ),
          "ENTRY_ALREADY_SENT",
        );
      }
      const reservation: LiveReservation = {
        identity: this.identity,
        scope: input.scope,
        operation_id: input.operation_id,
        kind: input.kind,
        generation: o.generation,
        nonce,
        expires_after: nonce + 1500,
        cloid,
        action,
        request: input.request,
        request_hash,
      };
      await tx.query(
        "INSERT INTO jev_live_requests(identity_hash,operation_id,request_hash,reservation,environment,signer_address,nonce,generation) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)",
        [
          this.identityHash,
          input.operation_id,
          request_hash,
          JSON.stringify(reservation),
          this.identity.environment,
          this.identity.signer_address,
          nonce,
          o.generation,
        ],
      );
      return { fresh: true, reservation };
    });
  }
  async gate(r: LiveReservation): Promise<LiveGate> {
    return this.pool.transaction(async (tx) => {
      await this.lock(tx);
      const o = (
        await tx.query<{ generation: string; lease_until: Date }>(
          "SELECT generation::text,lease_until FROM jev_live_owners WHERE identity_hash=$1",
          [this.identityHash],
        )
      ).rows[0];
      const stored = (
        await tx.query<{ reservation: LiveReservation }>(
          "SELECT reservation FROM jev_live_requests WHERE identity_hash=$1 AND operation_id=$2",
          [this.identityHash, r.operation_id],
        )
      ).rows[0];
      const pilot = (
        await tx.query(
          "SELECT checkpoint,request FROM jev_pilot_events WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1",
          [this.identity.account_id],
        )
      ).rows[0];
      const authority = await jevLiveAuthorityTx(
        tx,
        this.identity.owner_id,
        r.scope,
        r.kind === "entry",
      );
      const activated = authority.activation_id !== null;
      const entries =
        r.kind === "entry"
          ? await readJevEntriesTx(tx, this.identity.account_id)
          : [];
      const c = r.request as LiveCommand;
      const entryReady =
        c.kind === "entry" &&
        entries.some(
          (e) =>
            e.status === "reserved" &&
            e.order_id === c.plan.input.order_id &&
            e.plan_hash === jevHash(c.plan),
        );
      const observations = (
        await tx.query<{
          kind: string;
          payload: LiveSnapshot;
          recorded_at: Date;
        }>(
          "SELECT DISTINCT ON(kind) kind,payload,recorded_at FROM jev_live_events WHERE identity_hash=$1 AND kind IN ('snapshot','gap') ORDER BY kind,recorded_at DESC,event_key DESC",
          [this.identityHash],
        )
      ).rows;
      const snapshot = observations.find((e) => e.kind === "snapshot"),
        gap = observations.find((e) => e.kind === "gap");
      const balance = await this.balanceTx(tx, snapshot?.payload ?? null);
      const reconciled =
        c.kind === "entry" &&
        snapshot &&
        snapshot.payload.snapshot_id === c.snapshot.snapshot_id &&
        snapshot.payload.flat &&
        snapshot.payload.consistent &&
        snapshot.payload.history_complete &&
        balance?.reconciled &&
        pilot?.checkpoint.observation.evidence_id ===
          snapshot.payload.snapshot_id &&
        pilot?.checkpoint.observation.reconciled === true &&
        (!gap || gap.recorded_at < snapshot.recorded_at);
      return {
        identity_hash: this.identityHash,
        reservation_hash: stored ? jevHash(stored.reservation) : null,
        operator_activation_id: activated ? authority.activation_id : null,
        signer_enabled: activated,
        generation: o?.generation ?? "0",
        lease_until: o?.lease_until.getTime() ?? 0,
        entries_allowed:
          activated &&
          authority.entries_allowed &&
          pilot?.checkpoint.supervisor_authorized &&
          !pilot?.checkpoint.global_blocked &&
          !pilot?.checkpoint.risk.entries_paused &&
          pilot?.checkpoint.active_experiment_id === r.scope.experiment_id &&
          entryReady &&
          !!reconciled,
      };
    });
  }
  /** Exactly one signing attempt for a reserved intent, even across callers or
   * processes. A crash here burns the nonce and requires orderStatus recovery. */
  async claimSubmission(r: LiveReservation) {
    return this.pool.transaction(async (tx) => {
      await this.lock(tx);
      const now = await dbNow(tx);
      const gate = (
        await tx.query<{ generation: string; lease_until: Date }>(
          "SELECT generation::text,lease_until FROM jev_live_owners WHERE identity_hash=$1",
          [this.identityHash],
        )
      ).rows[0];
      const stored = (
        await tx.query<{ reservation: LiveReservation }>(
          "SELECT reservation FROM jev_live_requests WHERE identity_hash=$1 AND operation_id=$2",
          [this.identityHash, r.operation_id],
        )
      ).rows[0];
      liveCheck(
        gate &&
          gate.generation === r.generation &&
          gate.lease_until.getTime() > now &&
          r.expires_after > now &&
          stored &&
          jevHash(stored.reservation) === jevHash(r),
        "SEND_FENCE",
      );
      const key = `receipt:attempt:${r.operation_id}`;
      if (
        (
          await tx.query(
            "SELECT 1 FROM jev_live_events WHERE identity_hash=$1 AND event_key=$2",
            [this.identityHash, key],
          )
        ).rows.length
      )
        return false;
      await this.eventTx(tx, "receipt", key, {
        operation_id: r.operation_id,
        kind: r.kind,
        observed_at: now,
        state: "uncertain",
        oid: null,
        original: { reason: "SEND_RESERVED" },
      });
      return true;
    });
  }
  async operations() {
    return this.pool.transaction(async (tx) =>
      (
        await tx.query<{ reservation: LiveReservation }>(
          "SELECT reservation FROM jev_live_requests WHERE identity_hash=$1 ORDER BY nonce",
          [this.identityHash],
        )
      ).rows.map((r) => r.reservation),
    );
  }
  async events<T>(kind: LiveEventKind): Promise<T[]> {
    return this.pool.transaction(async (tx) =>
      (
        await tx.query<{ payload: T }>(
          "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind=$2 ORDER BY recorded_at,event_key",
          [this.identityHash, kind],
        )
      ).rows.map((r) => r.payload),
    );
  }
  /** Venue balances are authoritative; no hypothetical capital or JEV invoice
   * is inserted into trading cash. Journal aggregates explain observed changes. */
  async accountView(now = Date.now()) {
    return this.pool.transaction(async (tx) => {
      await this.lock(tx);
      const rows = (
        await tx.query<{
          kind: string;
          payload: LiveSnapshot;
          recorded_at: Date;
        }>(
          "SELECT DISTINCT ON(kind) kind,payload,recorded_at FROM jev_live_events WHERE identity_hash=$1 AND kind IN ('snapshot','gap') ORDER BY kind,recorded_at DESC,event_key DESC",
          [this.identityHash],
        )
      ).rows;
      const last = rows.find((r) => r.kind === "snapshot"),
        gap = rows.find((r) => r.kind === "gap"),
        s = last?.payload ?? null;
      const balance = await this.balanceTx(tx, s);
      const money = (
        await tx.query<{
          fees_raw: string;
          realized_pnl_raw: string;
          funding_raw: string;
        }>(
          "SELECT COALESCE(sum((payload->>'fee_raw')::numeric) FILTER(WHERE kind='fill'),0)::text fees_raw,COALESCE(sum((payload->>'realized_pnl_raw')::numeric) FILTER(WHERE kind='fill'),0)::text realized_pnl_raw,COALESCE(sum((payload->>'amount_raw')::numeric) FILTER(WHERE kind='funding'),0)::text funding_raw FROM jev_live_events WHERE identity_hash=$1 AND kind IN ('fill','funding')",
          [this.identityHash],
        )
      ).rows[0]!;
      return {
        snapshot: s,
        pending:
          !s ||
          !s.consistent ||
          !s.history_complete ||
          !balance?.reconciled ||
          s.received_at > now ||
          now - s.started_at > 2000 ||
          (!!gap && !!last && gap.recorded_at >= last.recorded_at),
        trading_balance_raw: s?.trading_balance_raw ?? null,
        equity_raw: s?.equity_raw ?? null,
        position_raw: s?.position_raw ?? null,
        balance_proof: balance,
        ...money,
      };
    });
  }
  /** Only feeds the already funded pilot seam. No observer may create funding,
   * arm the executor, change a profile or reset its financial high-water mark. */
  async observeExistingPilot(snapshot: LiveSnapshot) {
    liveCheck(
      snapshot.identity_hash === this.identityHash &&
        this.identity.environment === "mainnet",
      "PILOT_OBSERVATION_OWNER",
    );
    const previous = await this.pool.transaction(async (tx) => {
      await this.lock(tx);
      const pilot = await readJevPilotTx(tx, this.identity.account_id);
      if (!pilot) return null;
      const stored = (
        await tx.query<{ payload: LiveSnapshot }>(
          "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='snapshot' AND event_key=$2",
          [this.identityHash, `snapshot:${snapshot.snapshot_id}`],
        )
      ).rows[0]?.payload;
      liveCheck(
        stored && jevHash(stored) === jevHash(snapshot),
        "OBSERVATION_SOURCE",
      );
      const balance = await this.balanceTx(tx, snapshot);
      liveCheck(balance?.reconciled, "CASH_RECONCILIATION_REQUIRED");
      return pilot;
    });
    if (!previous) return null;
    const duplicate = await this.pool.transaction(
      async (tx) =>
        (
          await tx.query<{
            request: import("./jev-pilotstore.js").JevPilotCommand;
          }>(
            "SELECT request FROM jev_pilot_events WHERE account_id=$1 AND operation_id=$2",
            [this.identity.account_id, `live:${snapshot.snapshot_id}`],
          )
        ).rows[0],
    );
    if (duplicate) {
      liveCheck(
        jevHash(duplicate.request.observation.original) === jevHash(snapshot),
        "SOURCE_COLLISION",
      );
      return commandJevPilot(
        this.pool,
        this.identity.owner_id,
        this.identity.account_id,
        duplicate.request,
      );
    }
    return commandJevPilot(
      this.pool,
      this.identity.owner_id,
      this.identity.account_id,
      {
        operation_id: `live:${snapshot.snapshot_id}`,
        expected_sequence: previous.sequence,
        action: "observe",
        observation: {
          version: "btc.jev-pilot-reconciliation.v1",
          source: "hyperliquid:mainnet:reconciliation",
          evidence_id: snapshot.snapshot_id,
          observed_at: new Date(snapshot.venue_at).toISOString(),
          received_at: new Date(snapshot.received_at).toISOString(),
          funded_capital_usd_raw: previous.checkpoint.capital_admitted_usd_raw,
          trading_balance_usd_raw: snapshot.trading_balance_raw,
          open_pnl_usd_raw: snapshot.open_pnl_raw,
          flat: snapshot.flat,
          reconciled: snapshot.consistent && snapshot.history_complete,
          original: snapshot,
          utc_anchor: null,
        },
      },
    );
  }
}
