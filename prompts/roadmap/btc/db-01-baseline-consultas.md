---
id: DB-01
rfc: RFC-037
depends_on: []
mode: read-only
---
# DB-01 — Medir gargalos e orçamento PostgreSQL

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Produzir baseline read-only de consultas e recursos que selecione o próximo
acesso a otimizar, sem escolher índice ou mais CPU por suposição.

## Leitura mínima

- `docs/rfcs/RFC-037-consultas-e-recursos-postgres.md` — baseline e restrições.
- `apps/api/src/database.ts` — createDatabasePool / readOnly.
- `apps/api/src/polymarket/trades.ts` — lastRecordedTs.
- `apps/api/src/polymarket/fundamental/features.ts` — loadFeedSamples.
- `apps/api/src/polymarket/portfolio/store.ts` — bookAsOf.
- `docker-compose.yml` — postgres e limites dos workers.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Usar catálogo, pg_stat_activity e pg_stat_statements se já instalado; identificar
SHA, parâmetros efetivos, somatório pools, espera por lock, CPU throttling e RAM.
Listar SQL normalizado, frequência, p95/p99 se disponível e timeouts. Diferenciar
métrica inexistente de zero. Começar por EXPLAIN sem ANALYZE; execução só para
SELECT estreito, limite e statement_timeout conhecidos. Não instalar extensão,
criar índice, rodar contagem integral, limpar dados ou alterar configurações.
Salvar resultado breve em `docs/test-results/btc/DB-01.md` (novo).

## Aceite e verificação

- Baseline contém parâmetros/valores datados e fonte, sem segredos.
- Três candidatos trades/RTDS/snapshots têm plano ou justificativa de indisponibilidade.
- Custo de escrita e conexão do recorder integra o orçamento, não só painel.
- Consulta cara tem hipótese e fixture/medição limitada para comprovar melhora.
- Deixar prioridade e orçamento numéricos para DB-02/03/04.

## Fim e handoff

Registrar recortes do SQL e planos necessários; handoff não exige reler todas as
consultas do sistema. Servidor inacessível limita baseline a código, sem inventar
latências atuais ou aplicar tuning.
