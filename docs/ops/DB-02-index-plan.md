# DB-02 — Índice do último trade por mercado

**Candidato testado em PostgreSQL descartável; aplicação operacional pertence ao
DB-04.** O SQL de `lastRecordedTs` e o backfill permanecem inalterados. A entrega
não instala índice em produção nem adiciona migration automática.

## Escolha e contrato

[SQL executável](sql/db02-trades-last-recorded-index.sql): B-tree não único
`(condition_id, trade_ts DESC) WHERE provenance = 'data_api' AND trade_ts IS NOT NULL`.
O `MAX(trade_ts)` existente ignora NULL; mercado vazio/somente NULL retorna NULL.
Não usar `received_at`, COALESCE, filtro de token, corte em `now()` ou desempate por
trade_id: o cursor continua sendo o maior timestamp de todos os tokens do mercado
na fonte `data_api`, inclusive futuro. Empates não escolhem uma identidade de trade.
A janela, sobreposição de 1 s e índices únicos de dedupe não mudam.

Os seis índices existentes cobrem PK, identidades por fonte/WS, token/tempo e
retenção por received_at. Nenhum começa por condition_id: não remover ou duplicar
esses índices. O parcial evita entradas de WS e timestamps nulos; tamanho, WAL e
custo de INSERT medidos constam em [DB-02](../test-results/btc/DB-02.md).

## Sequência para DB-04

1. Confirmar a identidade SSH atual de [SERVER_ACCESS](SERVER_ACCESS.md), o SHA,
   PostgreSQL, schema real, índices, tamanho e headroom. Revalidar RAM <13 GB total,
   SSD livre ≥25%, pressão de coleta e retenção. Dimensionar o espaço pelo tamanho
   **medido** do índice e chaves reais, incluindo espaço temporário/WAL da construção;
   a fixture não é orçamento de produção. Não criar infraestrutura ou elevar caps.
2. Registrar janela de manutenção, conexões, orçamento de construção e critérios
   de interrupção. Construir só este índice por vez; não disputar com outro build,
   retenção pesada ou transações antigas. Resolver o gate de escrita com o ensaio
   DB-04 antes de promover o candidato.
3. Inspecionar existência/definição/validade com a consulta abaixo. Se houver índice
   equivalente válido, reutilizá-lo e reconciliar nome/migration; não criar redundante.
   Mesmo nome com definição distinta ou `indisvalid=false` é erro a investigar,
   não sucesso de `IF NOT EXISTS`.
4. Usar psql `-X -v ON_ERROR_STOP=1`, search_path explícito do schema conferido,
   `lock_timeout=500ms` e orçamento de manutenção finito documentado pelo DB-04
   (proposta inicial: `statement_timeout=10min`, exclusivo da sessão de build).
   Executar o arquivo SQL isoladamente, em autocommit, **sem `-1`/BEGIN e fora do
   runner**. Os timeouts das consultas de aplicação não mudam. Acompanhar
   `pg_stat_progress_create_index`, locks, CPU/RAM, disco e lacunas de coleta.
5. Se houver cancelamento/erro, consultar novamente o catálogo: build concorrente
   pode deixar índice inválido que ainda custa escrita. Registrar erro/definição;
   remover somente esse objeto por `DROP INDEX CONCURRENTLY schema.nome` quando
   conferido como o candidato desta operação, sem CASCADE; nunca repetir cegamente.
6. Depois do sucesso, exigir `indisvalid=true`, `indisready=true`, `indislive=true`,
   `indisunique=false`, método btree, chaves e predicado exatos. Medir tamanho e
   EXPLAIN de Q1 com binds comparáveis ao DB-01; só executar ANALYZE da consulta
   estreita após confirmar Limit/Index Scan e usar o orçamento original. Conferir
   resultado, buffers, gravação/dedupe e ensaio DB-04, sem alegar soak por build.
7. Só então preparar migration numerada pelo próximo slot realmente livre
   (`0023` estava livre em 12/09/2026; **não reservado** por este bloco). Para banco
   vazio pode usar CREATE INDEX transacional. Em banco populado, exigir prebuild
   concorrente e validar definição/validade **antes** do IF NOT EXISTS; abortar se
   faltar o índice. Não deixar uma migration disparar build bloqueante no deploy.
   Não editar 0005/0013 nem inventar uma linha de schema_versions agora.

```sql
SELECT c.relname, am.amname, i.indisvalid, i.indisready, i.indislive,
       i.indisunique, pg_get_indexdef(i.indexrelid) AS definition,
       pg_get_expr(i.indpred, i.indrelid) AS predicate,
       pg_relation_size(i.indexrelid) AS index_bytes
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_am am ON am.oid = c.relam
WHERE i.indrelid = 'public.polymarket_trades'::regclass;
```

Substituir `public` somente pelo schema conferido, mantendo a identidade da tabela.
O arquivo SQL não contém IF NOT EXISTS de propósito: colisão deve falhar visivelmente.

## Rollback e limite do aceite

A consulta não precisa de rollback de código. Se o índice degradar a escrita,
interromper a promoção e remover **somente** o candidato validado, fora de transação:
`DROP INDEX CONCURRENTLY public.polymarket_trades_data_api_condition_ts_idx;`.
Isso preserva linhas, timestamps, dedupe e ledger; a leitura volta ao custo anterior.
Se uma migration futura já registrar o índice, o DB-04 deverá documentar também a
reconciliação forward-only desse estado, sem editar migration aplicada.

Construção, cancelamento sob carga, WAL/latência em produção e ensaio com seis abas
não foram executados pelo DB-02. Não há decisão de custo, capital/live, limpeza de
dados ou infraestrutura nesta entrega.

Referências conferidas em 12/09/2026: [CREATE INDEX no PostgreSQL 18](https://www.postgresql.org/docs/18/sql-createindex.html)
(construção concorrente fora de transação e índice inválido após falha) e
[índices parciais](https://www.postgresql.org/docs/18/indexes-partial.html).
