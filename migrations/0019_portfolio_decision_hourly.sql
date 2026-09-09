-- RFC-027 D1/D2, caminho B: o agregado horário do funil e o resumo do último
-- ciclo, escritos SÓ pelo worker de portfólio.
--
-- POR QUE UMA MIGRATION, e não a leitura direta do log (caminho A).
--
-- O caminho A da D1 é `SELECT outcome, reason_code, count(*) FROM
-- portfolio_decisions WHERE decision_kind = 'ENTRY' AND decision_ts > now() -
-- interval '24 hours' GROUP BY 1, 2`, e a RFC só o autoriza se
-- `max(3 × quente p95, 1,5 × frio) <= 500 ms`. Medido em produção
-- 2026-09-09 01:34Z, EXPLAIN (ANALYZE, BUFFERS), 22 670 linhas na janela:
--
--   * o índice CASA — Index Scan em portfolio_decisions_kind_idx, sem seq scan;
--   * frio (primeira execução, read=4404 blocos de disco): 1603 ms na consulta
--     simples, 706 ms no EXPLAIN. 1,5 × frio = 2405 ms;
--   * quente, 10 execuções: 3508,0 199,7 1396,5 94,6 187,7 194,8 186,7 27,9
--     23,7 24,0 ms. p95 ~= 3508 ms; 3 × p95 = 10 524 ms.
--
--   max(10 524, 2405) = 10 524 ms, contra um teto de 500 ms. REPROVA por vinte
--   vezes, e não por pouco: o índice acha as linhas, mas são 22 mil delas e a
--   tabela não cabe em shared_buffers, então cada execução volta ao disco.
--
-- O que decide não é a média e sim o pior caso: 3,5 s está acima do
-- `statement_timeout` de 1 s do pool da API (database.ts:40–51), de modo que o
-- caminho A não daria um `/overview` lento — daria 57014 no `/overview`, que é
-- exatamente o erro que o aceite 6 da RFC exige em zero. P1 aprovada no default
-- B em 2026-09-05; a medição confirma o default.
--
-- QUEM ESCREVE. Só `polymarket-portfolio`. A API não tem caminho de escrita
-- para nenhuma das duas tabelas e o teste de regressão prova isso varrendo o
-- módulo de rotas. O worker sobrescreve o statement_timeout do pool, então o
-- agregado de duas horas cabe nele sem risco de cancelamento.
--
-- POR QUE DUAS HORAS POR CICLO, e não só a corrente. Uma decisão gravada às
-- 13:59:59,8 pode ser agregada por um ciclo que começou às 13:59:59,5 e
-- terminou às 14:00:00,2: sem reprocessar a hora anterior, essa linha ficaria
-- fora do balde para sempre. Reprocessar as duas últimas horas custa o mesmo
-- índice e fecha a janela.

CREATE TABLE IF NOT EXISTS portfolio_decision_hourly (
    -- Balde de hora UTC, `date_trunc('hour', decision_ts)`.
    hour_start   TIMESTAMPTZ NOT NULL,
    -- '' (string vazia) é a codificação de "sem reason_code", que é o que o log
    -- grava numa decisão ACCEPTED. NOT NULL porque a coluna é parte da chave
    -- primária e uma PK não admite NULL; a API traduz '' de volta para `null`
    -- ao publicar, de modo que a forma do `/overview` é a mesma do log cru.
    reason_code  TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    decisions    BIGINT NOT NULL,
    markets      INTEGER NOT NULL,
    -- D3, "Quase": quantas decisões dessa hora caíram na banda
    -- `-0,01 < folga <= 0`, e a menor folga entre elas. `folga_min` é NUMERIC
    -- para atravessar como texto decimal — a aritmética de dinheiro nunca vira
    -- float. NULL quando não houve nenhuma na banda.
    near_misses  INTEGER NOT NULL DEFAULT 0,
    folga_min    NUMERIC,
    -- Versão da config de onde saiu o `edgeLiqMin` que calculou a folga desta
    -- hora. Sem ela, um balde antigo calculado com outro piso ficaria
    -- indistinguível de um novo, e o número mudaria de significado sem aviso.
    config_version TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hour_start, reason_code, outcome)
);

-- A API lê sempre "as últimas 24 horas", nunca uma hora solta.
CREATE INDEX IF NOT EXISTS portfolio_decision_hourly_window_idx
    ON portfolio_decision_hourly (hour_start DESC);

-- D2: os sete campos do PORTFOLIO_CYCLE (runner.ts:1016–1027) fora do log.
--
-- Uma linha, não uma série: o painel pergunta "o que o motor achou no ciclo que
-- acabou de rodar", e a resposta a essa pergunta tem exatamente um valor. A
-- série já existe — é o log — e guardá-la duas vezes só criaria uma segunda
-- fonte de verdade que envelhece diferente.
CREATE TABLE IF NOT EXISTS portfolio_cycle_summary (
    portfolio_id      INTEGER PRIMARY KEY,
    cycle_at          TIMESTAMPTZ NOT NULL,
    evaluated         INTEGER NOT NULL,
    entrable          INTEGER NOT NULL,
    decisions_written INTEGER NOT NULL,
    state             TEXT NOT NULL,
    positions         INTEGER NOT NULL,
    open_breakers     INTEGER NOT NULL,
    stale_marks       INTEGER NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
