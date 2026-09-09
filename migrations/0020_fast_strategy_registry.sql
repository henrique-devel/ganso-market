-- RFC-028 D7 / P4: o registro da estratégia `fast_btc_updown` — decisões
-- append-only, versões de config imutáveis, contabilidade da sub-carteira, e
-- `paper_orders` ganhando `strategy_id` e a fonte `'fast'`.
--
-- DDL puramente ADITIVO. Nenhuma tabela existente perde coluna ou constraint,
-- nenhuma linha existente muda, nenhuma migration já aplicada é reescrita, e
-- nada nesta migration faz um worker decidir algo novo: a estratégia só roda em
-- SOMBRA a partir do PR 3, e nesta fase nenhuma ordem nasce.
--
-- A migration é a **0020** e não a 0019: a RFC-027 seguiu o caminho B e gastou
-- a 0019 (`schema_versions.foundation = 19` em produção, verificado
-- 2026-09-09). A P4 previa exatamente esta bifurcação.
--
-- POR QUE `strategy_id` EM `paper_orders`, e não uma tabela de ordens própria.
-- A D2 reserva US$ 100 imaginários dentro dos US$ 1.000 e manda a carteira
-- principal, o G1–G6 e `buildPerformanceReport` lerem só `strategy_id IS NULL`.
-- Uma tabela separada exigiria que cada um desses consumidores soubesse da
-- existência da segunda tabela para NÃO a ler — o oposto de fail-closed, porque
-- um consumidor esquecido passaria a contar a sub-carteira em vez de deixá-la
-- de fora. Com uma coluna nula na tabela que todos já leem, o filtro é uma
-- cláusula que se escreve uma vez por consumidor e cuja ausência é visível.
--
-- SIMULAÇÃO — SEM EXECUÇÃO REAL.

-- ---------------------------------------------------------------------------
-- 1. Decisões da estratégia: append-only.
-- ---------------------------------------------------------------------------
--
-- Append-only por TRIGGER, no padrão de `portfolio_config_versions_guard`
-- (0014:25-34), e não por permissão de role: o módulo paper conecta com o mesmo
-- usuário de todo o resto, então uma GRANT não separaria nada. O trigger vale
-- para qualquer conexão, inclusive a de quem "só ia corrigir uma linha".
--
-- É o registro que o replay tem de reproduzir (D7): braço, versão e hash da
-- config em vigor, os insumos as-of do instante, o veredito e o reason code.
-- Reescrever uma linha destas é apagar a prova de que a decisão foi aquela.
CREATE TABLE IF NOT EXISTS strategy_decisions (
    decision_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    strategy_id       TEXT NOT NULL CHECK (char_length(strategy_id) BETWEEN 1 AND 64),
    arm               TEXT NOT NULL CHECK (arm IN ('A', 'C', 'D', 'E')),
    decision_ts       TIMESTAMPTZ NOT NULL,
    condition_id      TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    -- Nulo quando a decisão recusou antes de escolher um lado (toda recusa de
    -- pré-condição). Uma decisão sem token é informação, não defeito.
    token_id          TEXT CHECK (token_id IS NULL OR char_length(token_id) BETWEEN 1 AND 128),
    outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('affirmative', 'complement')),
    -- Config em vigor. As duas juntas, e não só a versão: a versão é o nome, o
    -- hash é a identidade, e é o hash que prova que o arquivo não mudou por
    -- baixo de uma versão que ficou com o mesmo nome.
    config_version    TEXT NOT NULL CHECK (char_length(config_version) BETWEEN 1 AND 32),
    config_hash       TEXT NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
    policy_version    TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 32),
    mode              TEXT NOT NULL CHECK (mode IN ('shadow', 'paper')),
    verdict           TEXT NOT NULL CHECK (verdict IN ('order', 'skip')),
    reason            TEXT NOT NULL CHECK (reason ~ '^FAST_[A-Z0-9_]+$'),
    -- Insumos as-of da D7, todos em TEXTO decimal. `numeric` seria tentador,
    -- mas o resto do módulo carrega preço e dinheiro em texto de seis casas
    -- (0008, 0014) e o replay compara texto com texto: uma coluna `numeric`
    -- aqui normalizaria '0.840000' para '0.84' e o replay passaria a divergir
    -- por formatação.
    best_bid          TEXT CHECK (best_bid IS NULL OR best_bid ~ '^[0-9]+\.[0-9]{6}$'),
    best_ask          TEXT CHECK (best_ask IS NULL OR best_ask ~ '^[0-9]+\.[0-9]{6}$'),
    spread            TEXT CHECK (spread IS NULL OR spread ~ '^[0-9]+\.[0-9]{6}$'),
    queue_ahead       TEXT CHECK (queue_ahead IS NULL OR queue_ahead ~ '^[0-9]+\.[0-9]{6}$'),
    s0                TEXT CHECK (s0 IS NULL OR s0 ~ '^[0-9]+(\.[0-9]+)?$'),
    st                TEXT CHECK (st IS NULL OR st ~ '^[0-9]+(\.[0-9]+)?$'),
    -- z é ESCORE, com sinal: pode ser negativo, e é o sinal que diz o lado.
    z                 TEXT CHECK (z IS NULL OR z ~ '^-?[0-9]+\.[0-9]{6}$'),
    -- k em minutos até o fim, fracionário (o braço A quer T-10 +/- 30 s).
    k_minutes         TEXT CHECK (k_minutes IS NULL OR k_minutes ~ '^-?[0-9]+(\.[0-9]+)?$'),
    assumed_taker_fee_rate TEXT NOT NULL CHECK (assumed_taker_fee_rate ~ '^[0-9]+(\.[0-9]+)?$'),
    -- O plano, quando houve. Um veredito 'order' sem plano seria inauditável e
    -- um 'skip' com plano seria um falso rastro — daí a equivalência estrita.
    order_json        JSONB,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT strategy_decisions_verdict_order_check CHECK (
        (verdict = 'order') = (order_json IS NOT NULL)
    )
);

-- O índice que a D7 pede, na ordem que ela escreve: as consultas do painel e do
-- replay são sempre "este braço desta estratégia, nesta janela".
CREATE INDEX IF NOT EXISTS strategy_decisions_arm_ts_idx
    ON strategy_decisions (strategy_id, arm, decision_ts);
-- E o mercado, para o aceite "4 braços gravando em >= 90 % dos horários".
CREATE INDEX IF NOT EXISTS strategy_decisions_condition_idx
    ON strategy_decisions (condition_id, decision_ts);
-- `received_at` é a coluna de tempo da retenção (TTL 180 d): sem índice, a poda
-- varreria a tabela inteira a cada passada.
CREATE INDEX IF NOT EXISTS strategy_decisions_received_at_idx
    ON strategy_decisions (received_at);

CREATE OR REPLACE FUNCTION strategy_decisions_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'strategy_decisions rows are append-only: a decision is what it was';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS strategy_decisions_guard_trg ON strategy_decisions;
CREATE TRIGGER strategy_decisions_guard_trg
    BEFORE UPDATE OR DELETE ON strategy_decisions
    FOR EACH ROW EXECUTE FUNCTION strategy_decisions_guard();

-- ---------------------------------------------------------------------------
-- 2. Versões da config: imutáveis.
-- ---------------------------------------------------------------------------
--
-- Mesmo contrato de `portfolio_config_versions` (0014:14-34): a linha é o
-- congelamento. Qualquer mudança em `config/fast.json` é uma versão NOVA, nunca
-- um UPDATE — e a condição de parada da RFC-028 é literalmente "`fast.json`
-- alterado depois de congelado sem versão nova". Sem o trigger, essa condição
-- dependeria de disciplina; com ele, o banco recusa.
CREATE TABLE IF NOT EXISTS fast_config_versions (
    version      TEXT PRIMARY KEY CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    hash         TEXT NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    config_json  JSONB NOT NULL,
    frozen_at    TIMESTAMPTZ NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION fast_config_versions_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'fast_config_versions rows are immutable: mint a new version';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fast_config_versions_guard_trg ON fast_config_versions;
CREATE TRIGGER fast_config_versions_guard_trg
    BEFORE UPDATE OR DELETE ON fast_config_versions
    FOR EACH ROW EXECUTE FUNCTION fast_config_versions_guard();

-- ---------------------------------------------------------------------------
-- 3. Contabilidade da sub-carteira imaginária.
-- ---------------------------------------------------------------------------
--
-- Estado CORRENTE, uma linha por estratégia: quanto dos US$ 100 imaginários
-- está comprometido, e o acumulado do dia para os stops da D6. Dinheiro em
-- texto decimal de seis casas, como em `paper_positions` (0008).
--
-- Em sombra nada disto se move: nenhuma ordem nasce, então os valores ficam no
-- que a linha inicial disser. A tabela existe agora para que o PR 3 não precise
-- de uma migration nova só para ligar o worker.
CREATE TABLE IF NOT EXISTS fast_wallet_state (
    strategy_id        TEXT PRIMARY KEY CHECK (char_length(strategy_id) BETWEEN 1 AND 64),
    bankroll_usd       TEXT NOT NULL CHECK (bankroll_usd ~ '^[0-9]+\.[0-9]{6}$'),
    committed_usd      TEXT NOT NULL DEFAULT '0.000000' CHECK (committed_usd ~ '^[0-9]+\.[0-9]{6}$'),
    realized_pnl_usd   TEXT NOT NULL DEFAULT '0.000000' CHECK (realized_pnl_usd ~ '^-?[0-9]+\.[0-9]{6}$'),
    fees_paid_usd      TEXT NOT NULL DEFAULT '0.000000' CHECK (fees_paid_usd ~ '^[0-9]+\.[0-9]{6}$'),
    daily_anchor_date  DATE,
    daily_pnl_usd      TEXT NOT NULL DEFAULT '0.000000' CHECK (daily_pnl_usd ~ '^-?[0-9]+\.[0-9]{6}$'),
    orders_today       INTEGER NOT NULL DEFAULT 0 CHECK (orders_today >= 0),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 4. `paper_orders`: `strategy_id` e a fonte `'fast'`.
-- ---------------------------------------------------------------------------
--
-- Nula por omissão, e nula é o que TODAS as 99 ordens existentes continuam
-- sendo: `strategy_id IS NULL` é a carteira principal, e é essa a cláusula que
-- os gates e o relatório de performance passam a usar (D2, PR 3).
ALTER TABLE paper_orders
    ADD COLUMN IF NOT EXISTS strategy_id TEXT
        CHECK (strategy_id IS NULL OR char_length(strategy_id) BETWEEN 1 AND 64);

-- `'fast'` entra na lista de fontes. O CHECK original foi declarado inline na
-- coluna, então o PostgreSQL o nomeou `paper_orders_source_check`; a 0015 já o
-- derrubou por esse nome e o re-adicionou nomeado. Aqui é o mesmo caminho, pelo
-- nome explícito que a 0015 deixou.
ALTER TABLE paper_orders
    DROP CONSTRAINT IF EXISTS paper_orders_source_check;
ALTER TABLE paper_orders
    ADD CONSTRAINT paper_orders_source_check
    CHECK (source IN ('manual', 'intent', 'portfolio', 'fast'));

-- Uma ordem `'fast'` DEVE nomear a estratégia, e nenhuma outra fonte pode
-- nomeá-la. Sem isto, a coluna seria só uma sugestão: uma ordem `'fast'` sem
-- `strategy_id` cairia no filtro `strategy_id IS NULL` e passaria a ser contada
-- como evidência da carteira principal — exatamente a contaminação que a D2
-- proíbe, e o aceite "zero contaminação" mediria zero sem estar zero.
ALTER TABLE paper_orders
    DROP CONSTRAINT IF EXISTS paper_orders_strategy_source_check;
ALTER TABLE paper_orders
    ADD CONSTRAINT paper_orders_strategy_source_check
    CHECK ((source = 'fast') = (strategy_id IS NOT NULL));

-- O filtro dos gates e do relatório é `strategy_id IS NULL` sobre a tabela
-- inteira; o índice parcial serve a consulta simétrica (as ordens DA
-- estratégia), que é a do painel e a da contabilidade da sub-carteira.
CREATE INDEX IF NOT EXISTS paper_orders_strategy_idx
    ON paper_orders (strategy_id, created_at)
    WHERE strategy_id IS NOT NULL;

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
