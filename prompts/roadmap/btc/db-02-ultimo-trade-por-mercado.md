---
id: DB-02
rfc: RFC-037
depends_on: [DB-01]
mode: code
---
# DB-02 — Otimizar procura do último trade por mercado

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar uma otimização comprovada do acesso lastRecordedTs mantendo a janela
de backfill e a identidade dos trades.

## Leitura mínima

- `docs/rfcs/RFC-037-consultas-e-recursos-postgres.md` — decisões 2–5.
- `apps/api/src/polymarket/trades.ts` — lastRecordedTs / createTradesBackfill.
- `migrations/0005_polymarket_data_foundation.sql` — polymarket_trades.
- `migrations/0013_retention_time_indexes.sql` — índices temporais e operação concorrente.
- `apps/api/test/polymarket/trades.test.ts` — backfill e timestamp.
- `infra/migrations/apply.sh` — single-transaction.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Usar SQL/plano do DB-01; escolher índice ou reescrita mínima por equivalência,
sem criar índices redundantes. Preservar filtros de mercado, source e timestamps.
Se necessário, propor migration nova com próximo número livre e plano separado
para índice concorrente em tabela existente: runner transacional não o executa
como SQL normal. Não editar migrations aplicadas. Adicionar teste PostgreSQL
real no padrão existente e fixture com muitos mercados/idades. Produção permanece
fora deste patch; o plano será consolidado por DB-04.

## Aceite e verificação

- Resultados iguais para mercado sem trades, timestamps empatados e fontes mistas.
- Plano antes/depois registra linhas lidas/buffers e parâmetros comparáveis.
- Avaliar espaço/custo de INSERT adicional ao benefício de leitura.
- SQL/migration testados em PostgreSQL; trades e typecheck API passam.
- Não elevar timeout para esconder regressão ou adicionar lock longo de deploy.

## Fim e handoff

Registrar índice/consulta escolhidos, custo e rollback. DB-04 recebe instruções
de aplicação precisas; DB-03 mantém ownership dos acessos as-of.
