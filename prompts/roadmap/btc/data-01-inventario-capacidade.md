---
id: DATA-01
rfc: RFC-041
depends_on: []
mode: read-only
---
# DATA-01 — Inventariar capacidade e consumidores de dados

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Produzir inventário read-only com oportunidades de capacidade e preservação
necessária, sem classificar tabela antiga como lixo só pelo nome.

## Leitura mínima

- `docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md` — inventário e proteções.
- `apps/api/src/polymarket/retention.ts` — RETENTION_TABLES / measureTableSizes.
- `migrations/0005_polymarket_data_foundation.sql` — tabelas de mercado/retention_log.
- `migrations/0003_domain_events.sql` — domain_events e estado legado Solana.
- `migrations/0008_polymarket_paper_broker.sql` — ledger / orders / positions.
- `docker-compose.yml` — volumes e logging.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Mapear catálogo/estatísticas/FKs, índices, TOAST, físico vs bytes vivos estimados,
dead tuples, janela e crescimento. Rastrear consumidores/referências lógicas com rg
somente para candidatos; proteger cadeias econômicas, versões e datasets. Identificar
riscos da quota atual sobre ledger/orders e janela restante antes de qualquer ação.
Inventariar artefatos específicos/logs/exports/rollback images e dados Solana; schemas,
migrations e código legado permanecem. Usar consultas limitadas, sem COUNT gigante,
ANALYZE pesado, DELETE, VACUUM ou prune. Lacunas existentes são registradas.
Resultado novo: `docs/test-results/btc/DATA-01.md`.

## Aceite e verificação

- Tabela por candidato: classe, idade, consumidor, referência, GiB/dia e confiança.
- Separar pg_total_relation_size, estimativa viva e filesystem livre.
- Estimativa não vira contagem exata; ausência de stats não vira desuso provado.
- Lista protegida inclui vínculos lógicos não expressos por FK.
- Projetar 7/30/90 dias e indicar primeiro risco de capacidade sem inventar medições.

## Fim e handoff

Registrar candidatos concretos e dados a preservar para DATA-02. Não prometer
recuperação de espaço físico apenas calculando linhas elegíveis a DELETE.
