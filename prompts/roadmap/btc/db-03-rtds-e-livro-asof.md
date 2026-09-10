---
id: DB-03
rfc: RFC-037
depends_on: [DB-01]
mode: code
---
# DB-03 — Otimizar consultas as-of sem olhar o futuro

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar o conjunto mínimo de acessos as-of prioritários do DB-01 com plano
limitado e exatamente a mesma semântica temporal.

## Leitura mínima

- `docs/rfcs/RFC-037-consultas-e-recursos-postgres.md` — decisões 2–5.
- `apps/api/src/polymarket/fundamental/features.ts` — loadFeedSamples.
- `apps/api/src/polymarket/portfolio/store.ts` — bookAsOf.
- `migrations/0005_polymarket_data_foundation.sql` — RTDS e snapshots full.
- `apps/api/test/polymarket/fundamental/features.test.ts` — features as-of.
- `apps/api/test/polymarket/portfolio/integration.pg.test.ts` — PostgreSQL real.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Começar por RTDS: preservar symbol/feed, COALESCE(source_ts,received_at), barreira
de received_at e desempate. Alterar bookAsOf somente se DB-01 comprovar segundo
gargalo e a mudança couber no mesmo contrato; caso contrário registrar um DB-03B
independente antes de ampliar escopo. Não mudar qual feed resolve BTC, TTL ou
estimador. Escolher índice/rewrite apoiado em plano e custo de persistência.
Migration nova e operação concorrente seguem restrição transacional da RFC037.
Não executar índice/repack no servidor neste prompt.

## Aceite e verificação

- Fixture inclui dados futuros recebidos depois, source_ts nulo e empates.
- Comparar seleção anterior/nova para vários instantes e tokens sem dados.
- Nenhuma leitura posterior à decisão; desempate determinístico e documentado.
- Plano reduz varredura/sort sem prejudicar inserção além do orçamento DB-01.
- Rodar teste PostgreSQL de SQL, features/portfolio afetados e typecheck API.

## Fim e handoff

Registrar consultas tocadas, evidência de equivalência e subbloco adicional se
necessário. DB-04 só fecha quando todos os acessos selecionados estiverem resolvidos
ou adiados por justificativa mensurável no estado.
