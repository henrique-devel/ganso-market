// RFC-026 D10 (PR 3): o SQL das duas leituras de série, contra o schema real.
// Pulado no portão só-fonte; aponte GANSO_TEST_DATABASE_URL para um banco
// descartável já migrado para rodar.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: aqui só se lê `polymarket_series_1m`.
//
// Por que um arquivo pg e não um pool falso: o pool falso devolve as linhas que
// o próprio teste entregou, então ele aprovaria alegremente um `SELECT` com
// nome de coluna errado, um `ANY($1::text[])` que o planejador recusa, ou um
// agrupamento por `token_id` sobre uma coluna que a consulta não seleciona. As
// asserções deste arquivo são todas sobre SQL, e só um banco de verdade pode
// reprová-las.

import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../src/database.js";
import { registerPolymarketReadRoutes } from "../../src/polymarket/readapi.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const RUN = `${String(process.pid)}-${String(Date.now())}`;

const TOKEN_A = `serie-a-${RUN}`;
const TOKEN_B = `serie-b-${RUN}`;
// Sem nenhum bucket: prova que a rota responde "vazio" e não "ausente".
const TOKEN_MUDO = `serie-mudo-${RUN}`;

const BASE = new Date("2026-09-08T12:00:00.000Z");
const AGORA = new Date(BASE.getTime() + 60 * 60 * 1000);

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
  registerPolymarketReadRoutes(app, {
    pool: pool() as DatabasePool,
    authService: authService as never,
    // Relógio fixo: o teto de janela é medido contra "agora", e um relógio real
    // faria este arquivo passar hoje e dar 400 amanhã.
    clock: () => AGORA,
  });
  await app.ready();
  return app;
}

async function limpar(): Promise<void> {
  await pool().query(
    `DELETE FROM polymarket_series_1m WHERE token_id LIKE $1`,
    [`serie-%-${RUN}`],
  );
}

async function seed(): Promise<void> {
  const linhas: unknown[][] = [];
  // 30 buckets de 1 min para A, 10 para B, dentro da última hora.
  for (let i = 0; i < 30; i += 1) {
    linhas.push([
      TOKEN_A,
      new Date(BASE.getTime() + (30 + i) * 60_000),
      `0.5${String(i % 10)}`,
      "0.60",
      "0.40",
      `0.5${String(i % 10)}`,
      i,
    ]);
  }
  for (let i = 0; i < 10; i += 1) {
    linhas.push([
      TOKEN_B,
      new Date(BASE.getTime() + (30 + i) * 60_000),
      "0.20",
      "0.21",
      "0.19",
      "0.20",
      1,
    ]);
  }
  // Um bucket velho de A, fora de qualquer janela pedida: prova que o `from`
  // realmente corta, em vez de a rota devolver tudo que existe do token.
  linhas.push([
    TOKEN_A,
    new Date(BASE.getTime() - 48 * 60 * 60 * 1000),
    "0.90",
    "0.90",
    "0.90",
    "0.90",
    1,
  ]);

  for (const linha of linhas) {
    await pool().query(
      `INSERT INTO polymarket_series_1m
         (token_id, bucket_start, mid_open, mid_high, mid_low, mid_close,
          updates_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      linha,
    );
  }
}

const DESDE = new Date(AGORA.getTime() - 60 * 60 * 1000).toISOString();

describe.skipIf(DATABASE_URL === undefined)(
  "RFC-026 D10 — as séries, contra o Postgres",
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

    it("metric=ohlc devolve as seis colunas e respeita o `from`", async () => {
      const servidor = await buildApp();
      const resposta = await servidor.inject({
        method: "GET",
        url: `/polymarket/series/${TOKEN_A}?metric=ohlc&from=${DESDE}`,
        headers: AUTH,
      });
      expect(resposta.statusCode).toBe(200);
      const corpo = resposta.json<{
        points: readonly Record<string, unknown>[];
      }>();
      // 30 dentro da janela; o bucket de 48 h atrás fica de fora.
      expect(corpo.points).toHaveLength(30);
      expect(Object.keys(corpo.points[0] ?? {}).sort()).toEqual([
        "bucket_start",
        "mid_close",
        "mid_high",
        "mid_low",
        "mid_open",
        "updates_count",
      ]);
      // Os mids voltam como TEXTO, que é o tipo da coluna e o invariante da
      // tela: um número aqui seria um arredondamento silencioso.
      expect(typeof corpo.points[0]?.["mid_close"]).toBe("string");
      expect(typeof corpo.points[0]?.["updates_count"]).toBe("number");
    });

    it("o lote agrupa por token e responde por todos os pedidos", async () => {
      const servidor = await buildApp();
      const resposta = await servidor.inject({
        method: "GET",
        url: `/polymarket/series?tokens=${TOKEN_A},${TOKEN_B},${TOKEN_MUDO}&metric=ohlc&from=${DESDE}`,
        headers: AUTH,
      });
      expect(resposta.statusCode).toBe(200);
      const corpo = resposta.json<{
        series: Record<string, readonly Record<string, unknown>[]>;
        truncated: boolean;
      }>();
      expect(corpo.series[TOKEN_A]).toHaveLength(30);
      expect(corpo.series[TOKEN_B]).toHaveLength(10);
      // Token sem uma linha sequer: chave presente, lista vazia. É o que a Mesa
      // desenha como "sem série" — e é diferente de a chave não existir.
      expect(corpo.series[TOKEN_MUDO]).toEqual([]);
      expect(corpo.truncated).toBe(false);
      // O `token_id` é a chave do agrupamento e não se repete dentro do ponto.
      expect(corpo.series[TOKEN_A]?.[0]).not.toHaveProperty("token_id");
    });

    it("uma janela larga demais é 400, e não uma varredura lenta", async () => {
      const servidor = await buildApp();
      // 20 dias: a chamada que mediu 14 699 ms em produção em 08/09.
      const antigo = new Date(
        AGORA.getTime() - 20 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const lote = await servidor.inject({
        method: "GET",
        url: `/polymarket/series?tokens=${TOKEN_A}&metric=ohlc&from=${antigo}`,
        headers: AUTH,
      });
      expect(lote.statusCode).toBe(400);
      expect(lote.json().reason_code).toBe("WINDOW_TOO_WIDE");

      const unico = await servidor.inject({
        method: "GET",
        url: `/polymarket/series/${TOKEN_A}?metric=ohlc&from=${antigo}`,
        headers: AUTH,
      });
      expect(unico.statusCode).toBe(400);
      expect(unico.json().reason_code).toBe("WINDOW_TOO_WIDE");
    });

    it("as quatro métricas antigas continuam respondendo", async () => {
      // `spread` lê a mesma tabela pelas colunas antigas: se a variante `ohlc`
      // tivesse encostado no caminho delas, é aqui que apareceria.
      const servidor = await buildApp();
      const resposta = await servidor.inject({
        method: "GET",
        url: `/polymarket/series/${TOKEN_A}?metric=spread`,
        headers: AUTH,
      });
      expect(resposta.statusCode).toBe(200);
      const corpo = resposta.json<{
        points: readonly Record<string, unknown>[];
      }>();
      // Sem `from`, e continua sendo assim: as antigas não ganharam janela
      // obrigatória, porque estreitá-las quebraria chamadores fora desta RFC.
      // São os 30 buckets da janela MAIS o de 48 h atrás — é justamente esse
      // 31.º que mostra que `spread` segue sem teto de janela.
      expect(corpo.points.length).toBe(31);
      expect(Object.keys(corpo.points[0] ?? {}).sort()).toEqual([
        "best_ask",
        "best_bid",
        "bucket_start",
        "mid_close",
        "spread",
      ]);
    });
  },
);
