// RFC-027 D1/D2, caminho B: o agregado que o painel lê no lugar do log.
//
// Só o worker de portfólio chama estas duas funções, e é isso que torna o
// caminho B viável: o pool do worker sobrescreve o `statement_timeout` de 1 s
// que a API herda (`database.ts:40–51`), então um agregado de duas horas cabe
// aqui e não caberia lá. A medição que mandou o caminho B está no cabeçalho da
// migration 0019.
//
// A API NUNCA escreve nestas tabelas. Não há uma função de escrita exportada
// que ela pudesse chamar, e o teste de regressão varre o módulo de rotas para
// provar que nenhuma das duas aparece num INSERT/UPDATE/DELETE de lá.

import type { PortfolioPool } from "./types.js";

/**
 * A banda do "Quase" (D3), em texto decimal.
 *
 * `folga > -0,01` é o piso que a RFC fixa: uma decisão que passou a menos de um
 * centavo do critério. O TETO em zero é desta sessão, e é uma correção medida,
 * não um enfeite — ver `NEAR_MISS_UPPER` abaixo.
 */
export const NEAR_MISS_FLOOR = "-0.01";

/**
 * O teto da banda do "Quase". Uma linha RECUSADA com folga positiva não é um
 * "quase": é uma linha em que a fórmula publicada não reproduz o veredito do
 * motor, e contá-la seria inventar.
 *
 * Medido em produção 2026-09-09 01:36Z sobre as 24 h de
 * `LOWER_BOUND_BELOW_COSTS` (3392 linhas), abrindo por lado:
 *
 *   market_side | order_side |    n | folga > 0 | min      | max
 *   YES         | BUY        | 2372 |         0 | -0,1758  | -0,0025
 *   NO          | SELL       | 1022 |       370 | -0,9573  | +0,7615
 *
 * Em YES/BUY a fórmula da RFC (`q_lo − exec_price − costs_total −
 * safety_margin`) é coerente com o veredito: nenhuma das 2372 recusas tem folga
 * positiva. Em NO/SELL, 370 de 1022 têm — a orientação da desigualdade se
 * inverte na venda e a fórmula, escrita para a compra, muda de sinal. Sem o
 * teto, o "Quase" das 24 h seria 390 em vez de 20 nesse código, com folga
 * mediana de +0,151: um número que diria "quase entrou" sobre linhas que
 * passaram longe. Com o teto: 20 (LOWER_BOUND) e 71 (EDGE).
 *
 * O motor não é tocado, e o `reason_code` continua sendo dele. O que esta
 * constante faz é impedir que o PAINEL afirme mais do que a fórmula publicada
 * sustenta.
 */
export const NEAR_MISS_UPPER = "0";

/**
 * Reagrega as duas últimas horas do funil de entrada.
 *
 * Idempotente por construção: a chave primária é
 * `(hour_start, reason_code, outcome)` e o `ON CONFLICT` reescreve as
 * contagens com o que o SELECT acabou de contar, em vez de somar. Rodar duas
 * vezes seguidas deixa exatamente as mesmas linhas com os mesmos valores —
 * que é o que o teste de idempotência verifica.
 *
 * `edgeLiqMin` chega como o TEXTO decimal que o motor gravou na config, e
 * atravessa a consulta como `numeric`. Nenhum ponto flutuante toca a folga.
 */
export async function upsertDecisionHourly(
  pool: PortfolioPool,
  now: Date,
  edgeLiqMin: string,
  configVersion: string,
): Promise<{ buckets: number }> {
  const result = await pool.query(
    `INSERT INTO portfolio_decision_hourly
           (hour_start, reason_code, outcome, decisions, markets,
            near_misses, folga_min, config_version, updated_at)
     SELECT t.hour_start,
            COALESCE(t.reason_code, ''),
            t.outcome,
            count(*),
            count(DISTINCT t.condition_id),
            count(*) FILTER (WHERE t.folga > $1::numeric
                               AND t.folga <= $2::numeric),
            min(t.folga) FILTER (WHERE t.folga > $1::numeric
                                   AND t.folga <= $2::numeric),
            $3::text,
            $4::timestamptz
       FROM (
         SELECT date_trunc('hour', d.decision_ts) AS hour_start,
                d.reason_code,
                d.outcome,
                d.condition_id,
                CASE d.reason_code
                  WHEN 'LOWER_BOUND_BELOW_COSTS'
                    THEN d.q_lo::numeric - d.exec_price::numeric
                         - d.costs_total::numeric - d.safety_margin::numeric
                  WHEN 'EDGE_BELOW_MIN'
                    THEN d.edge_net::numeric - $5::numeric
                END AS folga
           FROM portfolio_decisions d
          WHERE d.decision_kind = 'ENTRY'
            AND d.decision_ts >= date_trunc('hour', $4::timestamptz)
                                 - INTERVAL '1 hour'
            AND d.decision_ts < date_trunc('hour', $4::timestamptz)
                                 + INTERVAL '1 hour'
       ) t
      GROUP BY t.hour_start, COALESCE(t.reason_code, ''), t.outcome
     ON CONFLICT (hour_start, reason_code, outcome) DO UPDATE
        SET decisions      = EXCLUDED.decisions,
            markets        = EXCLUDED.markets,
            near_misses    = EXCLUDED.near_misses,
            folga_min      = EXCLUDED.folga_min,
            config_version = EXCLUDED.config_version,
            updated_at     = EXCLUDED.updated_at`,
    [NEAR_MISS_FLOOR, NEAR_MISS_UPPER, configVersion, now, edgeLiqMin],
  );
  return { buckets: result.rowCount };
}

/** Os sete campos do `PORTFOLIO_CYCLE`, numa linha só. Upsert por chave. */
export async function upsertCycleSummary(
  pool: PortfolioPool,
  now: Date,
  cycle: {
    readonly evaluated: number;
    readonly entrable: number;
    readonly decisionsWritten: number;
    readonly state: string;
    readonly positions: number;
    readonly openBreakers: number;
    readonly staleMarks: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO portfolio_cycle_summary
           (portfolio_id, cycle_at, evaluated, entrable, decisions_written,
            state, positions, open_breakers, stale_marks, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $1)
     ON CONFLICT (portfolio_id) DO UPDATE
        SET cycle_at          = EXCLUDED.cycle_at,
            evaluated         = EXCLUDED.evaluated,
            entrable          = EXCLUDED.entrable,
            decisions_written = EXCLUDED.decisions_written,
            state             = EXCLUDED.state,
            positions         = EXCLUDED.positions,
            open_breakers     = EXCLUDED.open_breakers,
            stale_marks       = EXCLUDED.stale_marks,
            updated_at        = EXCLUDED.updated_at`,
    [
      now,
      cycle.evaluated,
      cycle.entrable,
      cycle.decisionsWritten,
      cycle.state,
      cycle.positions,
      cycle.openBreakers,
      cycle.staleMarks,
    ],
  );
}
