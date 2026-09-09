// RFC-027 D1/D2, caminho B: os dois upserts do worker contra PostgreSQL real.
//
// Skipped no portão de fonte; aponte GANSO_TEST_DATABASE_URL para um banco
// descartável já migrado (a receita está no README do roadmap).
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: escreve só nas duas tabelas de agregado, que
// não participam de nenhuma decisão.
//
// POR QUE CONTRA BANCO REAL. O que estes testes verificam é aritmética de SQL
// e idempotência de `ON CONFLICT`, e nenhuma das duas existe num pool falso:
// um fake que casa substring devolveria `[]` para uma coluna inexistente e o
// upsert "passaria". A migration 0019 é nova e a única prova de que a chave
// primária e o `date_trunc` fazem o que o cabeçalho dela diz é esta.

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  NEAR_MISS_FLOOR,
  NEAR_MISS_UPPER,
  upsertCycleSummary,
  upsertDecisionHourly,
} from "../../../src/polymarket/portfolio/funnelstore.js";

type Row = Record<string, unknown>;

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;

/** 14:30Z: o balde da hora corrente é 14:00, o anterior é 13:00. */
const FIXED_NOW = new Date("2026-09-04T14:30:00.000Z");
const EDGE_LIQ_MIN = "0.020000";
const CONFIG_VERSION = "1.2.0";

let raw: pg.Pool | null = null;

function pool(): { query: SqlExecutor["query"] } {
  const instance = raw;
  if (instance === null) {
    throw new Error("pool not initialised");
  }
  return {
    async query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const result = await instance.query<R>(text, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  } as { query: SqlExecutor["query"] };
}

/**
 * Uma decisão de ENTRY com o mínimo que as constraints da 0014 exigem.
 *
 * Money em texto decimal com seis casas, que é o que os CHECKs da tabela
 * impõem — e é também o motivo pelo qual a folga pode ser calculada em
 * `numeric` sem passar por float em nenhum ponto.
 */
async function insertDecision(fields: {
  decisionTs: string;
  outcome: "ACCEPTED" | "REJECTED";
  reasonCode: string | null;
  conditionId: string;
  qLo?: string;
  execPrice?: string;
  costsTotal?: string;
  safetyMargin?: string;
  edgeNet?: string;
}): Promise<void> {
  const accepted = fields.outcome === "ACCEPTED";
  await pool().query(
    `INSERT INTO portfolio_decisions
       (decision_kind, condition_id, token_id, market_side, order_side,
        decision_ts, q, q_lo, q_hi, estimate_source, exec_price, costs_total,
        safety_margin, edge_gross, edge_net, size_shares, binding_constraint,
        limiters_json, config_version, config_hash, factor_map_version,
        oldest_input_ts, newest_input_ts, book_json, inputs_json,
        outcome, reason_code, portfolio_state)
     VALUES ('ENTRY', $1, $2, 'YES', 'BUY', $3::timestamptz,
             '0.600000', $4, '0.700000', 'MODEL', $5, $6, $7,
             '0.050000', $8, $9, $10, '{}'::jsonb, $11,
             repeat('a', 64), '1.0.0', $3::timestamptz, $3::timestamptz,
             '{}'::jsonb, '{}'::jsonb, $12, $13, 'NORMAL')`,
    [
      fields.conditionId,
      `${fields.conditionId}-token`,
      fields.decisionTs,
      fields.qLo ?? "0.600000",
      fields.execPrice ?? "0.500000",
      fields.costsTotal ?? "0.010000",
      fields.safetyMargin ?? "0.005000",
      fields.edgeNet ?? "0.030000",
      accepted ? "10.000000" : null,
      accepted ? "KELLY_CAP" : "NOT_SIZED",
      CONFIG_VERSION,
      fields.outcome,
      fields.reasonCode,
    ],
  );
}

async function hourly(): Promise<Row[]> {
  const result = await pool().query<Row>(
    `SELECT hour_start, reason_code, outcome, decisions, markets, near_misses,
            folga_min, config_version
       FROM portfolio_decision_hourly
      ORDER BY hour_start, reason_code, outcome`,
  );
  return result.rows;
}

beforeAll(() => {
  if (DATABASE_URL !== undefined) {
    raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  }
});

// Limpo ANTES de cada teste, não depois.
//
// As suítes pg compartilham um banco (é por isso que se roda com
// `--no-file-parallelism`), e o que este arquivo agrega é o conteúdo de
// `portfolio_decisions`. Limpar só no `afterEach` deixaria cada teste
// dependendo de o arquivo anterior ter limpado o seu — e a primeira vez que
// isso falhou foi aqui: `overview.pg.test.ts` grava decisões com um
// `decision_ts` na mesma janela de 2026-09-04, e o upsert as contou junto,
// devolvendo 6 baldes onde o teste esperava 3. O estado inicial é uma
// pré-condição deste arquivo, então é ele que a estabelece.
beforeEach(async () => {
  if (raw !== null) {
    await raw.query("TRUNCATE portfolio_decision_hourly");
    await raw.query("TRUNCATE portfolio_cycle_summary");
    await raw.query("DELETE FROM portfolio_decisions");
  }
});

afterAll(async () => {
  await raw?.end();
  raw = null;
});

describe.skipIf(DATABASE_URL === undefined)(
  "upsertDecisionHourly (RFC-027 D1, caminho B)",
  () => {
    it("agrupa por balde de hora, código e resultado", async () => {
      await insertDecision({
        decisionTs: "2026-09-04T13:10:00Z",
        outcome: "REJECTED",
        reasonCode: "DATA_STALE",
        conditionId: "0xaa",
      });
      await insertDecision({
        decisionTs: "2026-09-04T13:50:00Z",
        outcome: "REJECTED",
        reasonCode: "DATA_STALE",
        conditionId: "0xbb",
      });
      await insertDecision({
        decisionTs: "2026-09-04T14:05:00Z",
        outcome: "REJECTED",
        reasonCode: "DATA_STALE",
        conditionId: "0xaa",
      });
      await insertDecision({
        decisionTs: "2026-09-04T14:20:00Z",
        outcome: "ACCEPTED",
        reasonCode: null,
        conditionId: "0xcc",
      });

      await upsertDecisionHourly(
        pool(),
        FIXED_NOW,
        EDGE_LIQ_MIN,
        CONFIG_VERSION,
      );
      const rows = await hourly();
      expect(rows).toHaveLength(3);
      // 13:00 tem duas decisões em dois mercados distintos.
      expect(rows[0]).toMatchObject({
        reason_code: "DATA_STALE",
        outcome: "REJECTED",
        decisions: "2",
        markets: 2,
        config_version: CONFIG_VERSION,
      });
      expect((rows[0]?.hour_start as Date).toISOString()).toBe(
        "2026-09-04T13:00:00.000Z",
      );
      // Uma ACCEPTED não tem reason_code; a tabela grava '' porque a chave
      // primária não admite NULL.
      const aceita = rows.find((row) => row.outcome === "ACCEPTED");
      expect(aceita?.reason_code).toBe("");
      expect(aceita?.decisions).toBe("1");
    });

    it("é idempotente: duas execuções deixam uma linha por chave", async () => {
      await insertDecision({
        decisionTs: "2026-09-04T14:05:00Z",
        outcome: "REJECTED",
        reasonCode: "BOOK_STALE",
        conditionId: "0xaa",
      });

      await upsertDecisionHourly(
        pool(),
        FIXED_NOW,
        EDGE_LIQ_MIN,
        CONFIG_VERSION,
      );
      const primeira = await hourly();
      await upsertDecisionHourly(
        pool(),
        FIXED_NOW,
        EDGE_LIQ_MIN,
        CONFIG_VERSION,
      );
      const segunda = await hourly();

      // Uma linha, e o MESMO valor: o ON CONFLICT reescreve com o que o SELECT
      // contou, não soma. Um `decisions = decisions + EXCLUDED.decisions`
      // dobraria o funil a cada ciclo de um minuto — o erro exato que esta
      // asserção existe para pegar.
      expect(segunda).toHaveLength(1);
      expect(primeira).toHaveLength(1);
      expect(segunda[0]?.decisions).toBe("1");
      expect(segunda[0]?.decisions).toBe(primeira[0]?.decisions);
    });

    it("reprocessa a hora anterior, e não toca as mais antigas", async () => {
      // Uma decisão de duas horas atrás já agregada, com um valor ERRADO na
      // tabela. O ciclo das 14:30 reprocessa 13:00 e 14:00; 12:00 fica como
      // está. Se a janela do upsert escorregar, este é o teste que muda.
      await pool().query(
        `INSERT INTO portfolio_decision_hourly
           (hour_start, reason_code, outcome, decisions, markets, updated_at)
         VALUES ('2026-09-04T12:00:00Z', 'DATA_STALE', 'REJECTED', 999, 9, now())`,
      );
      await insertDecision({
        decisionTs: "2026-09-04T13:30:00Z",
        outcome: "REJECTED",
        reasonCode: "DATA_STALE",
        conditionId: "0xaa",
      });

      await upsertDecisionHourly(
        pool(),
        FIXED_NOW,
        EDGE_LIQ_MIN,
        CONFIG_VERSION,
      );
      const rows = await hourly();
      const antiga = rows.find(
        (row) =>
          (row.hour_start as Date).toISOString() === "2026-09-04T12:00:00.000Z",
      );
      expect(antiga?.decisions).toBe("999");
      const anterior = rows.find(
        (row) =>
          (row.hour_start as Date).toISOString() === "2026-09-04T13:00:00.000Z",
      );
      expect(anterior?.decisions).toBe("1");
    });

    it("conta o Quase na banda dos dois lados, com o piso vindo da config", async () => {
      // EDGE: folga = edge_net − edgeLiqMin.
      //   0.010100 − 0.02 = −0.009900  → dentro  (> −0,01 e <= 0)
      //   0.010000 − 0.02 = −0.010000  → FORA    (a borda inferior é aberta)
      //   0.030000 − 0.02 = +0.010000  → FORA    (folga positiva não é "quase")
      for (const [edge, condition] of [
        ["0.010100", "0xin"],
        ["0.010000", "0xborda"],
        ["0.030000", "0xpositiva"],
      ] as const) {
        await insertDecision({
          decisionTs: "2026-09-04T14:05:00Z",
          outcome: "REJECTED",
          reasonCode: "EDGE_BELOW_MIN",
          conditionId: condition,
          edgeNet: edge,
        });
      }

      await upsertDecisionHourly(
        pool(),
        FIXED_NOW,
        EDGE_LIQ_MIN,
        CONFIG_VERSION,
      );
      const rows = await hourly();
      const edgeRow = rows.find((row) => row.reason_code === "EDGE_BELOW_MIN");
      expect(edgeRow?.decisions).toBe("3");
      expect(edgeRow?.near_misses).toBe(1);
      // Texto decimal, não float: é o que a tela formata como "faltou 1,0 c".
      expect(String(edgeRow?.folga_min)).toBe("-0.009900");
    });

    it("usa o piso da config, não um 0,02 literal", async () => {
      // O mesmo edge_net contra dois pisos diferentes. Se o SQL tivesse 0.02
      // escrito nele, os dois resultados seriam iguais — e a tela mentiria no
      // dia em que o proprietário mudasse a config.
      await insertDecision({
        decisionTs: "2026-09-04T14:05:00Z",
        outcome: "REJECTED",
        reasonCode: "EDGE_BELOW_MIN",
        conditionId: "0xaa",
        edgeNet: "0.040000",
      });

      await upsertDecisionHourly(pool(), FIXED_NOW, "0.045000", CONFIG_VERSION);
      const comPisoAlto = await hourly();
      // 0.040000 − 0.045 = −0.005 → dentro da banda.
      expect(comPisoAlto[0]?.near_misses).toBe(1);
      expect(String(comPisoAlto[0]?.folga_min)).toBe("-0.005000");

      await upsertDecisionHourly(pool(), FIXED_NOW, EDGE_LIQ_MIN, "1.3.0");
      const comPisoBaixo = await hourly();
      // 0.040000 − 0.02 = +0.02 → fora, e a versão da config acompanha.
      expect(comPisoBaixo[0]?.near_misses).toBe(0);
      expect(comPisoBaixo[0]?.folga_min).toBeNull();
      expect(comPisoBaixo[0]?.config_version).toBe("1.3.0");
    });

    it("declara a banda que a RFC fixa", () => {
      expect(NEAR_MISS_FLOOR).toBe("-0.01");
      expect(NEAR_MISS_UPPER).toBe("0");
    });
  },
);

describe.skipIf(DATABASE_URL === undefined)(
  "upsertCycleSummary (RFC-027 D2, caminho B)",
  () => {
    const cycle = {
      evaluated: 62,
      entrable: 0,
      decisionsWritten: 7,
      state: "NORMAL",
      positions: 2,
      openBreakers: 54,
      staleMarks: 1,
    };

    it("é idempotente e guarda uma linha só", async () => {
      await upsertCycleSummary(pool(), FIXED_NOW, cycle);
      await upsertCycleSummary(pool(), new Date("2026-09-04T14:31:00Z"), {
        ...cycle,
        evaluated: 63,
      });
      const rows = await pool().query<Row>(
        `SELECT portfolio_id, cycle_at, evaluated, entrable, decisions_written,
                state, positions, open_breakers, stale_marks
           FROM portfolio_cycle_summary`,
      );
      // Uma linha: o painel pergunta "o último ciclo", e essa pergunta tem um
      // valor. A série já existe e é o log.
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        portfolio_id: 1,
        evaluated: 63,
        entrable: 0,
        decisions_written: 7,
        state: "NORMAL",
        positions: 2,
        open_breakers: 54,
        stale_marks: 1,
      });
      expect((rows.rows[0]?.cycle_at as Date).toISOString()).toBe(
        "2026-09-04T14:31:00.000Z",
      );
    });
  },
);
