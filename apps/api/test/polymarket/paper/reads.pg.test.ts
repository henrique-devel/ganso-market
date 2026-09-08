// RFC-026 D8: the JOINs that GET /polymarket/paper/positions and
// GET /polymarket/paper/orders gained, and
// the `pending_settlement` flag they exist to compute. Skipped in the
// source-only gate; point GANSO_TEST_DATABASE_URL at a migrated throwaway
// database to run it.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: every row here is a row in paper_positions.
//
// Why a pg file and not a fake pool: both claims this file makes are claims
// about SQL. A fake pool returns the rows the test handed it, so it would
// happily "prove" that a JOIN which duplicates every position does not
// duplicate anything. The duplication is the specific accident D8 was written
// to prevent — `fundamental_labels` has a NON-unique index on condition_id and
// a market has two tokens, so joining the labels on condition_id instead of
// token_id returns each position twice, and the panel would print a portfolio
// twice its real size with every number silently doubled. Only a real planner
// against real rows can fail that.

import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../../src/database.js";
import { registerPaperRoutes } from "../../../src/polymarket/paper/api.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const RUN = `${String(process.pid)}-${String(Date.now())}`;

// ONE market, TWO tokens. This is the fixture the RFC names: if the label join
// ever moves to condition_id, these two rows become four.
const CONDITION = `0xpos-${RUN}`;
const TOKEN_SIM = `tok-sim-${RUN}`;
const TOKEN_ZERO = `tok-zero-${RUN}`;
// A second market, for the cases that do not need a shared condition.
const CONDITION_ABERTO = `0xpos-aberto-${RUN}`;
const TOKEN_NAO_FINAL = `tok-naofinal-${RUN}`;
const TOKEN_SEM_ROTULO = `tok-semrotulo-${RUN}`;
const TOKEN_VENDIDO = `tok-vendido-${RUN}`;

const TOKENS = [
  TOKEN_SIM,
  TOKEN_ZERO,
  TOKEN_NAO_FINAL,
  TOKEN_SEM_ROTULO,
  TOKEN_VENDIDO,
];

const PERGUNTA = "Will ETH be above $4,000?";

let raw: pg.Pool | null = null;
let app: FastifyInstance | null = null;

function instance(): pg.Pool {
  if (raw === null) {
    throw new Error("pool not initialised");
  }
  return raw;
}

function wrap(client: pg.Pool): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const result = await client.query<R>(text, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

function pool(): Pick<DatabasePool, "query" | "transaction"> {
  const base = wrap(instance());
  return {
    query: base.query.bind(base),
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return run(base);
    },
  };
}

const authService = {
  session(token: string): Promise<{ status: string }> {
    return Promise.resolve(
      token === "good-token" ? { status: "ok" } : { status: "unauthenticated" },
    );
  },
};

const AUTH = { authorization: "Bearer good-token" };

async function buildApp(): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  registerPaperRoutes(app, { pool: pool(), authService });
  await app.ready();
  return app;
}

interface PositionRow {
  readonly token_id: string;
  readonly question: string | null;
  readonly is_final: boolean | null;
  readonly pending_settlement: boolean;
  readonly end_ts: string | null;
  readonly shares: string;
}

// The versioned rule's end instant, and a DIFFERENT one on the flat registry
// row, so the test can tell which of the two the query actually read.
const FIM_VERSIONADO = new Date("2026-12-31T23:00:00.000Z");
const FIM_ACHATADO = new Date("2026-11-01T00:00:00.000Z");

async function positions(): Promise<readonly PositionRow[]> {
  const instancia = await buildApp();
  const response = await instancia.inject({
    method: "GET",
    url: "/polymarket/paper/positions",
    headers: AUTH,
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ positions: readonly PositionRow[] }>();
  // Other suites share this database, so scope every assertion to this run's
  // tokens rather than to whatever else happens to be in the table.
  return body.positions.filter((row) => TOKENS.includes(row.token_id));
}

interface OrderRow {
  readonly order_id: string;
  readonly question: string | null;
  readonly queue_ahead: string | null;
  readonly status: string;
}

async function orders(status?: string): Promise<readonly OrderRow[]> {
  const instancia = await buildApp();
  const response = await instancia.inject({
    method: "GET",
    url:
      status === undefined
        ? "/polymarket/paper/orders"
        : `/polymarket/paper/orders?status=${status}`,
    headers: AUTH,
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ orders: readonly OrderRow[] }>();
  return body.orders.filter((row) => row.order_id.endsWith(RUN));
}

async function seed(): Promise<void> {
  const p = pool();
  await p.query(
    `INSERT INTO polymarket_markets
       (condition_id, question, category, clob_token_ids, end_ts)
     VALUES ($1, $2, 'crypto', $3::jsonb, $7), ($4, $5, 'crypto', $6::jsonb, NULL)`,
    [
      CONDITION,
      PERGUNTA,
      JSON.stringify([TOKEN_SIM, TOKEN_ZERO]),
      CONDITION_ABERTO,
      "Will BTC be above $100,000?",
      JSON.stringify([TOKEN_NAO_FINAL, TOKEN_VENDIDO]),
      FIM_ACHATADO,
    ],
  );

  // Only CONDITION has a versioned rule. CONDITION_ABERTO has none, so it can
  // only fall back — and it has no `end_ts` either, so it must come out null
  // rather than come out wrong.
  await p.query(
    `INSERT INTO polymarket_rule_versions
       (condition_id, version, content_hash, description, resolution_source,
        resolved_by, end_date, valid_from)
     VALUES ($1, 1, $2, 'Resolves YES above $4,000.', NULL, 'UMA:0xadapter',
             $3, now() - interval '1 day')`,
    [CONDITION, "c".repeat(64), FIM_VERSIONADO],
  );

  // Both tokens of CONDITION carry a label, which is what makes a
  // condition_id join duplicate. TOKEN_SEM_ROTULO deliberately has none.
  await p.query(
    `INSERT INTO fundamental_labels
       (token_id, condition_id, category, label, is_final, provenance)
     VALUES ($1, $2, 'crypto', '1', TRUE,  'resolution_events'),
            ($3, $2, 'crypto', '0', TRUE,  'resolution_events'),
            ($4, $5, 'crypto', '1', FALSE, 'resolution_events'),
            ($6, $5, 'crypto', '1', TRUE,  'resolution_events')`,
    [
      TOKEN_SIM,
      CONDITION,
      TOKEN_ZERO,
      TOKEN_NAO_FINAL,
      CONDITION_ABERTO,
      TOKEN_VENDIDO,
    ],
  );

  await p.query(
    `INSERT INTO paper_orders
       (order_id, token_id, condition_id, side, order_type, limit_price, size,
        queue_ahead, status, decided_at)
     VALUES ($1, $2, $3, 'BUY', 'GTC', '0.610000', '20.000000', '150.000000',
             'open', now()),
            ($4, $5, NULL, 'SELL', 'GTC', '0.700000', '5.000000', NULL,
             'filled', now())`,
    [
      `ord-nomeada-${RUN}`,
      TOKEN_SIM,
      CONDITION,
      `ord-sem-mercado-${RUN}`,
      TOKEN_SEM_ROTULO,
    ],
  );

  await p.query(
    `INSERT INTO paper_positions (token_id, condition_id, shares, cost_usd)
     VALUES ($1, $2, '12.090000', '7.200000'),
            ($3, $2, '0.000000',  '0.000000'),
            ($4, $5, '5.000000',  '3.000000'),
            ($6, $5, '5.000000',  '3.000000'),
            ($7, $5, '-9.250000', '4.100000')`,
    [
      TOKEN_SIM,
      CONDITION,
      TOKEN_ZERO,
      TOKEN_NAO_FINAL,
      CONDITION_ABERTO,
      TOKEN_SEM_ROTULO,
      TOKEN_VENDIDO,
    ],
  );
}

async function limpar(): Promise<void> {
  const p = pool();
  await p.query("DELETE FROM paper_orders WHERE order_id LIKE $1", [`%${RUN}`]);
  await p.query("DELETE FROM paper_positions WHERE token_id = ANY($1)", [
    TOKENS,
  ]);
  await p.query("DELETE FROM fundamental_labels WHERE token_id = ANY($1)", [
    TOKENS,
  ]);
  await p.query(
    "DELETE FROM polymarket_rule_versions WHERE condition_id = ANY($1)",
    [[CONDITION, CONDITION_ABERTO]],
  );
  await p.query("DELETE FROM polymarket_markets WHERE condition_id = ANY($1)", [
    [CONDITION, CONDITION_ABERTO],
  ]);
}

describe.skipIf(DATABASE_URL === undefined)(
  "GET /polymarket/paper/positions against real PostgreSQL",
  () => {
    beforeAll(async () => {
      raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
      await limpar();
      await seed();
    });

    afterEach(async () => {
      if (app !== null) {
        await app.close();
        app = null;
      }
    });

    afterAll(async () => {
      if (raw !== null) {
        await limpar();
        await raw.end();
        raw = null;
      }
    });

    it("returns exactly one row per position, JOINs and all", async () => {
      // The invariant the RFC states outright: the JOINs add columns, never
      // rows. TOKEN_SIM and TOKEN_ZERO share a condition_id and BOTH have a
      // fundamental_labels row, so a label join on condition_id would return
      // each of them twice and this count would read 7, not 5.
      const linhas = await positions();
      const semJoin = await pool().query<{ n: string }>(
        "SELECT count(*)::text AS n FROM paper_positions WHERE token_id = ANY($1)",
        [TOKENS],
      );

      expect(linhas).toHaveLength(Number(semJoin.rows[0]?.n));
      expect(linhas).toHaveLength(5);
      expect(new Set(linhas.map((row) => row.token_id)).size).toBe(5);
    });

    it("flags pending settlement only where the label is final AND shares are positive", async () => {
      const porToken = new Map(
        (await positions()).map((row) => [row.token_id, row]),
      );

      // is_final AND shares > 0 — the one true case.
      expect(porToken.get(TOKEN_SIM)?.pending_settlement).toBe(true);

      // Resolved on the venue, but the position is already flat. Nothing is
      // owed, so nothing is pending.
      expect(porToken.get(TOKEN_ZERO)?.pending_settlement).toBe(false);

      // Held, but the outcome is not knowable yet: this is an open position,
      // not an unsettled one.
      expect(porToken.get(TOKEN_NAO_FINAL)?.pending_settlement).toBe(false);

      // No label row at all. `is_final` is NULL and the flag must be false,
      // not NULL and not true — absence is never evidence of resolution.
      expect(porToken.get(TOKEN_SEM_ROTULO)?.is_final ?? null).toBeNull();
      expect(porToken.get(TOKEN_SEM_ROTULO)?.pending_settlement).toBe(false);

      // Short. `shares > 0` is what D8 says, and a negative balance is not a
      // holding waiting to be paid out.
      expect(porToken.get(TOKEN_VENDIDO)?.pending_settlement).toBe(false);
    });

    it("takes the end instant from the versioned rule, not the flat column", async () => {
      // RFC-016: `polymarket_markets.end_ts` is the fallback, never the first
      // read. Both exist for CONDITION and they differ, so whichever instant
      // comes back names the column the query trusted.
      const porToken = new Map(
        (await positions()).map((row) => [row.token_id, row]),
      );

      expect(new Date(porToken.get(TOKEN_SIM)?.end_ts ?? 0).toISOString()).toBe(
        FIM_VERSIONADO.toISOString(),
      );

      // No versioned rule and no flat instant: null, which the screen reads as
      // "sem vencimento registrado" — not as "expires now".
      expect(porToken.get(TOKEN_NAO_FINAL)?.end_ts ?? null).toBeNull();
    });

    it("carries the market's name, and says nothing when there is no registry row", async () => {
      const porToken = new Map(
        (await positions()).map((row) => [row.token_id, row]),
      );

      expect(porToken.get(TOKEN_SIM)?.question).toBe(PERGUNTA);

      // A position whose market left the registry keeps its row and loses its
      // name. `null` is the honest answer; the screen prints "sem nome".
      await pool().query(
        "UPDATE paper_positions SET condition_id = NULL WHERE token_id = $1",
        [TOKEN_SEM_ROTULO],
      );
      const depois = new Map(
        (await positions()).map((row) => [row.token_id, row]),
      );
      expect(depois.get(TOKEN_SEM_ROTULO)?.question ?? null).toBeNull();
      expect(depois.size).toBe(5);

      await pool().query(
        "UPDATE paper_positions SET condition_id = $2 WHERE token_id = $1",
        [TOKEN_SEM_ROTULO, CONDITION_ABERTO],
      );
    });
  },
);

describe.skipIf(DATABASE_URL === undefined)(
  "GET /polymarket/paper/orders against real PostgreSQL",
  () => {
    beforeAll(async () => {
      raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
      await limpar();
      await seed();
    });

    afterEach(async () => {
      if (app !== null) {
        await app.close();
        app = null;
      }
    });

    afterAll(async () => {
      if (raw !== null) {
        await limpar();
        await raw.end();
        raw = null;
      }
    });

    it("names the market and keeps the queue position it already published", async () => {
      const linhas = await orders();
      const porId = new Map(linhas.map((row) => [row.order_id, row]));

      expect(linhas).toHaveLength(2);
      expect(porId.get(`ord-nomeada-${RUN}`)?.question).toBe(PERGUNTA);
      // `queue_ahead` is the column the RFC keeps pointing at: the pipeline
      // view drops it, this route does not, and the JOIN must not change that.
      expect(porId.get(`ord-nomeada-${RUN}`)?.queue_ahead).toBe("150.000000");

      // An order with no condition_id keeps its row and gets no name. It must
      // not vanish: a LEFT JOIN is what makes that true, and an inner one
      // would silently drop orders from the screen.
      expect(porId.get(`ord-sem-mercado-${RUN}`)?.question ?? null).toBeNull();
    });

    it("still filters by status, and still refuses a status outside the domain", async () => {
      const abertas = await orders("open");
      expect(abertas.map((row) => row.order_id)).toEqual([
        `ord-nomeada-${RUN}`,
      ]);

      const instancia = await buildApp();
      const resposta = await instancia.inject({
        method: "GET",
        url: "/polymarket/paper/orders?status=nao-existe",
        headers: AUTH,
      });
      expect(resposta.statusCode).toBe(400);
    });
  },
);
