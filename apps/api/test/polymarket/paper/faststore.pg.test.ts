// RFC-028 PR 2: a migration 0020 contra PostgreSQL real.
//
// Pulado no portão de fonte; aponte `GANSO_TEST_DATABASE_URL` para um banco
// descartável já migrado (a receita está na RFC-025, §"Rodar os pg de verdade").
//
// POR QUE CONTRA BANCO REAL. Tudo o que esta migration promete é constraint e
// trigger, e nenhuma das duas existe num pool falso: um fake que casa substring
// devolveria `[]` para um INSERT que viola um CHECK e o teste "passaria". Em
// particular a equivalência `(source = 'fast') = (strategy_id IS NOT NULL)` só
// pode ser provada pedindo ao banco para recusar.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL: escreve só nas tabelas novas e numa
// `paper_orders` de banco descartável.

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const DATABASE_URL = process.env["GANSO_TEST_DATABASE_URL"];

const HASH = "a".repeat(64);
const STRATEGY = "fast_btc_updown";

let raw: pg.Pool | null = null;

function pool(): pg.Pool {
  if (raw === null) {
    throw new Error("pool not initialised");
  }
  return raw;
}

/** Uma decisão de recusa: o caso mais comum, e o que não tem plano. */
function skipDecision(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    strategy_id: STRATEGY,
    arm: "C",
    decision_ts: new Date("2026-09-09T01:50:00.000Z"),
    condition_id: "0xcondition",
    token_id: null,
    outcome: null,
    config_version: "0.1.0",
    config_hash: HASH,
    policy_version: "0.1.0",
    mode: "shadow",
    verdict: "skip",
    reason: "FAST_SKIPPED_KILL_SWITCH",
    best_bid: null,
    best_ask: null,
    spread: null,
    queue_ahead: null,
    s0: null,
    st: null,
    z: null,
    k_minutes: null,
    assumed_taker_fee_rate: "0.07",
    order_json: null,
    ...overrides,
  };
}

async function insertDecision(
  fields: Record<string, unknown>,
): Promise<number> {
  const keys = Object.keys(fields);
  const placeholders = keys.map((_unused, index) => `$${String(index + 1)}`);
  const result = await pool().query<{ decision_id: string }>(
    `INSERT INTO strategy_decisions (${keys.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING decision_id`,
    keys.map((key) => fields[key]),
  );
  return Number(result.rows[0]?.decision_id ?? 0);
}

describe.skipIf(DATABASE_URL === undefined)(
  "0020 — strategy_decisions é append-only",
  () => {
    beforeAll(() => {
      raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    });

    afterAll(async () => {
      await raw?.end();
      raw = null;
    });

    beforeEach(async () => {
      // TRUNCATE não passa pelo trigger de linha, então o setup consegue
      // limpar uma tabela que nenhum DELETE consegue esvaziar. É de propósito:
      // o trigger protege a história, não o banco de teste.
      await pool().query("TRUNCATE strategy_decisions");
    });

    it("aceita uma decisão de recusa sem plano", async () => {
      const id = await insertDecision(skipDecision());
      expect(id).toBeGreaterThan(0);
    });

    it("aceita uma decisão de ordem com plano e insumos as-of", async () => {
      const id = await insertDecision(
        skipDecision({
          verdict: "order",
          reason: "FAST_C_MAKER_JOIN",
          token_id: "tok-yes",
          outcome: "affirmative",
          best_bid: "0.840000",
          best_ask: "0.860000",
          spread: "0.020000",
          queue_ahead: "12.000000",
          s0: "78000",
          st: "78900",
          z: "7.255784",
          k_minutes: "10",
          order_json: JSON.stringify({ orderType: "GTD", ttlS: 360 }),
        }),
      );
      expect(id).toBeGreaterThan(0);
    });

    it("UPDATE lança", async () => {
      const id = await insertDecision(skipDecision());
      await expect(
        pool().query(
          "UPDATE strategy_decisions SET reason = $1 WHERE decision_id = $2",
          ["FAST_SKIPPED_WARMUP", id],
        ),
      ).rejects.toThrow(/append-only/);
    });

    it("DELETE lança", async () => {
      const id = await insertDecision(skipDecision());
      await expect(
        pool().query("DELETE FROM strategy_decisions WHERE decision_id = $1", [
          id,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it("um UPDATE que não casa linha nenhuma não lança", async () => {
      // O trigger é BEFORE ... FOR EACH ROW: sem linha, sem exceção. Vale
      // registrar para que ninguém leia a garantia como "a tabela recusa o
      // verbo" em vez de "a tabela recusa a mudança".
      await insertDecision(skipDecision());
      await expect(
        pool().query(
          "UPDATE strategy_decisions SET reason = 'FAST_X' WHERE decision_id = -1",
        ),
      ).resolves.toBeDefined();
    });

    it("veredito 'order' sem plano é recusado, e 'skip' com plano também", async () => {
      await expect(
        insertDecision(
          skipDecision({ verdict: "order", reason: "FAST_C_MAKER_JOIN" }),
        ),
      ).rejects.toThrow(/strategy_decisions_verdict_order_check/);
      await expect(
        insertDecision(skipDecision({ order_json: JSON.stringify({ a: 1 }) })),
      ).rejects.toThrow(/strategy_decisions_verdict_order_check/);
    });

    it("reason fora do padrão FAST_* é recusado", async () => {
      await expect(
        insertDecision(skipDecision({ reason: "KILL_SWITCH_ENGAGED" })),
      ).rejects.toThrow(/reason/);
    });

    it("braço desconhecido é recusado", async () => {
      await expect(insertDecision(skipDecision({ arm: "B" }))).rejects.toThrow(
        /arm/,
      );
    });

    it("hash que não é sha256 hex é recusado", async () => {
      await expect(
        insertDecision(skipDecision({ config_hash: "nao-e-hash" })),
      ).rejects.toThrow(/config_hash/);
    });

    it("z aceita sinal negativo; preço não", async () => {
      await expect(
        insertDecision(
          skipDecision({
            z: "-1.500000",
            k_minutes: "6",
            s0: "78000",
            st: "77000",
          }),
        ),
      ).resolves.toBeGreaterThan(0);
      await expect(
        insertDecision(skipDecision({ best_bid: "-0.840000" })),
      ).rejects.toThrow(/best_bid/);
    });

    it("preço fora das seis casas é recusado: o replay compara texto", async () => {
      await expect(
        insertDecision(skipDecision({ best_bid: "0.84" })),
      ).rejects.toThrow(/best_bid/);
    });

    it("o índice da D7 existe, na ordem que ela escreve", async () => {
      const result = await pool().query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'strategy_decisions'
            AND indexname = 'strategy_decisions_arm_ts_idx'`,
      );
      expect(result.rows[0]?.indexdef).toMatch(
        /\(strategy_id, arm, decision_ts\)/,
      );
    });
  },
);

describe.skipIf(DATABASE_URL === undefined)(
  "0020 — fast_config_versions é imutável",
  () => {
    beforeAll(() => {
      raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    });

    afterAll(async () => {
      await raw?.end();
      raw = null;
    });

    beforeEach(async () => {
      await pool().query("TRUNCATE fast_config_versions");
    });

    async function freeze(version: string, hash: string): Promise<void> {
      await pool().query(
        `INSERT INTO fast_config_versions (version, hash, config_json, frozen_at)
         VALUES ($1, $2, $3::jsonb, now())`,
        [version, hash, JSON.stringify({ version })],
      );
    }

    it("congela uma versão", async () => {
      await freeze("0.1.0", HASH);
      const result = await pool().query<{ count: string }>(
        "SELECT count(*) AS count FROM fast_config_versions",
      );
      expect(result.rows[0]?.count).toBe("1");
    });

    it("UPDATE lança: mudar a config é mintar versão nova", async () => {
      await freeze("0.1.0", HASH);
      await expect(
        pool().query(
          "UPDATE fast_config_versions SET hash = $1 WHERE version = $2",
          ["b".repeat(64), "0.1.0"],
        ),
      ).rejects.toThrow(/mint a new version/);
    });

    it("DELETE lança", async () => {
      await freeze("0.1.0", HASH);
      await expect(
        pool().query("DELETE FROM fast_config_versions WHERE version = $1", [
          "0.1.0",
        ]),
      ).rejects.toThrow(/mint a new version/);
    });

    it("a mesma versão duas vezes colide na chave primária", async () => {
      await freeze("0.1.0", HASH);
      await expect(freeze("0.1.0", "c".repeat(64))).rejects.toThrow(
        /fast_config_versions_pkey/,
      );
    });

    it("versão que não é semver é recusada", async () => {
      await expect(freeze("0.1", HASH)).rejects.toThrow(/version/);
    });
  },
);

describe.skipIf(DATABASE_URL === undefined)(
  "0020 — paper_orders ganha strategy_id e a fonte 'fast'",
  () => {
    beforeAll(() => {
      raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    });

    afterAll(async () => {
      await raw?.end();
      raw = null;
    });

    beforeEach(async () => {
      await pool().query("DELETE FROM paper_orders");
    });

    /** O mínimo que os CHECKs da 0008/0015 exigem de uma ordem. */
    async function insertOrder(
      overrides: Record<string, unknown> = {},
    ): Promise<void> {
      const fields: Record<string, unknown> = {
        order_id: `ord-${String(Math.random()).slice(2)}`,
        token_id: "tok-yes",
        side: "BUY",
        order_type: "GTD",
        limit_price: "0.840000",
        size: "5.000000",
        status: "open",
        source: "manual",
        decided_at: new Date("2026-09-09T01:50:00.000Z"),
        created_at: new Date("2026-09-09T01:50:00.000Z"),
        ...overrides,
      };
      const keys = Object.keys(fields);
      await pool().query(
        `INSERT INTO paper_orders (${keys.join(", ")})
         VALUES (${keys.map((_u, i) => `$${String(i + 1)}`).join(", ")})`,
        keys.map((key) => fields[key]),
      );
    }

    it("'fast' é uma fonte aceita — e é a REGRESSÃO desta migration", async () => {
      // Antes da 0020 este INSERT viola paper_orders_source_check. É o teste
      // que prova a migration, e o que reprova o HEAD anterior.
      await expect(
        insertOrder({ source: "fast", strategy_id: STRATEGY }),
      ).resolves.toBeUndefined();
    });

    it("'fast' SEM strategy_id é recusado", async () => {
      // Sem isto a ordem cairia no filtro `strategy_id IS NULL` e seria
      // contada como evidência da carteira principal: a contaminação que a D2
      // proíbe, medindo zero sem estar zero.
      await expect(insertOrder({ source: "fast" })).rejects.toThrow(
        /paper_orders_strategy_source_check/,
      );
    });

    it("strategy_id em fonte que não é 'fast' é recusado", async () => {
      for (const source of ["manual", "intent"]) {
        await expect(
          insertOrder({ source, strategy_id: STRATEGY }),
        ).rejects.toThrow(/paper_orders_strategy_source_check/);
      }
    });

    it("as fontes antigas seguem aceitas, e com strategy_id nulo", async () => {
      await insertOrder({ source: "manual" });
      await insertOrder({ source: "intent" });
      await insertOrder({ source: "portfolio", decision_id: 1 });
      const result = await pool().query<{ count: string }>(
        "SELECT count(*) AS count FROM paper_orders WHERE strategy_id IS NULL",
      );
      expect(result.rows[0]?.count).toBe("3");
    });

    it("uma fonte desconhecida segue recusada", async () => {
      await expect(insertOrder({ source: "live" })).rejects.toThrow(
        /paper_orders_source_check/,
      );
    });

    it("o CHECK de decision_id da 0015 continua valendo para 'fast'", async () => {
      // `(source = 'portfolio') = (decision_id IS NOT NULL)`: uma ordem 'fast'
      // não vem de uma decisão de portfólio e não pode nomear uma.
      await expect(
        insertOrder({ source: "fast", strategy_id: STRATEGY, decision_id: 1 }),
      ).rejects.toThrow(/paper_orders_decision_source_check/);
    });

    it("o filtro da carteira principal exclui a ordem da estratégia", async () => {
      await insertOrder({ source: "manual" });
      await insertOrder({ source: "fast", strategy_id: STRATEGY });
      const main = await pool().query<{ count: string }>(
        "SELECT count(*) AS count FROM paper_orders WHERE strategy_id IS NULL",
      );
      const excluded = await pool().query<{ count: string }>(
        "SELECT count(*) AS count FROM paper_orders WHERE strategy_id IS NOT NULL",
      );
      expect(main.rows[0]?.count).toBe("1");
      expect(excluded.rows[0]?.count).toBe("1");
    });
  },
);

describe.skipIf(DATABASE_URL === undefined)("0020 — fast_wallet_state", () => {
  beforeAll(() => {
    raw = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  });

  afterAll(async () => {
    await raw?.end();
    raw = null;
  });

  beforeEach(async () => {
    await pool().query("DELETE FROM fast_wallet_state");
  });

  it("aceita o estado inicial da sub-carteira", async () => {
    await pool().query(
      `INSERT INTO fast_wallet_state (strategy_id, bankroll_usd) VALUES ($1, $2)`,
      [STRATEGY, "100.000000"],
    );
    const result = await pool().query<{
      committed_usd: string;
      orders_today: number;
    }>("SELECT committed_usd, orders_today FROM fast_wallet_state");
    expect(result.rows[0]?.committed_usd).toBe("0.000000");
    expect(result.rows[0]?.orders_today).toBe(0);
  });

  it("dinheiro fora das seis casas é recusado", async () => {
    await expect(
      pool().query(
        `INSERT INTO fast_wallet_state (strategy_id, bankroll_usd) VALUES ($1, $2)`,
        [STRATEGY, "100"],
      ),
    ).rejects.toThrow(/bankroll_usd/);
  });

  it("PnL aceita negativo; bankroll e fees não", async () => {
    await expect(
      pool().query(
        `INSERT INTO fast_wallet_state (strategy_id, bankroll_usd, realized_pnl_usd, daily_pnl_usd)
           VALUES ($1, $2, $3, $4)`,
        [STRATEGY, "100.000000", "-3.500000", "-1.250000"],
      ),
    ).resolves.toBeDefined();
    await expect(
      pool().query(
        `INSERT INTO fast_wallet_state (strategy_id, bankroll_usd, fees_paid_usd)
           VALUES ($1, $2, $3)`,
        [`${STRATEGY}-2`, "100.000000", "-1.000000"],
      ),
    ).rejects.toThrow(/fees_paid_usd/);
  });

  it("ordens do dia não podem ser negativas", async () => {
    await expect(
      pool().query(
        `INSERT INTO fast_wallet_state (strategy_id, bankroll_usd, orders_today)
           VALUES ($1, $2, $3)`,
        [STRATEGY, "100.000000", -1],
      ),
    ).rejects.toThrow(/orders_today/);
  });
});
