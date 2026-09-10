---
id: DATA-02
rfc: RFC-041
depends_on: [DATA-01]
mode: code
---
# DATA-02 — Proteger evidência e criar seletor único de dry-run

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar seletor verificável e política versionada que proteja economia/datasets
contra o pruner legado e gere manifesto dry-run sem apagar nada.

## Leitura mínima

- `docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md` — proteções e manifesto.
- `apps/api/src/polymarket/retention.ts` — RETENTION_TABLES / createRetentionJob.
- `apps/api/src/polymarket/orchestrator.ts` — createRetentionSupervisor.
- `apps/api/test/polymarket/retention.test.ts` — proteção, coverage e quota.
- `migrations/0014_polymarket_portfolio_engine.sql` — versões e decisões.
- `migrations/0020_fast_strategy_registry.sql` — strategy_decisions / guard trigger.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Inventário DATA-01 define fecho de referências: ledger/orders/fills/position_entries,
configs/regras/labels/model provenance e datasets pinned. Alterar proteção também no
job existente para não podar entre inventário e execução. Quota não vence proteção
ou cobertura mínima. Escritores de pins/referências e pruner compartilham lock ou
serialização transacional até commit. Um seletor serve dry-run/execução. Manifesto fixa hash,
SHA/schema/policy, cutoff UTC, chave+watermark, allowlist/predicado exato, validade,
contagem vs estimativa, bytes e invariantes. Novos módulos/schema são propostos,
com migration numerada após inspeção. Regra central sintética exclui 0xsonda de
métricas auditoriamente; mantém registro/trigger. Consumidores ficam para RFC033/039.
Fora: executar poda, TRUNCATE, reescrever migrations ou inventar passado ausente.

## Aceite e verificação

- Quota extrema não remove protegido/pin no job antigo nem seletor novo.
- Dry-run é determinístico no mesmo snapshot e usa cutoff fixo.
- Referência lógica/posição aberta/coverage bloqueiam; pin concorrente é coordenado.
- Manifesto distingue estimativa e contagem exata, tem hash e expiração.
- Testar retenção e PostgreSQL real se mudar SQL/schema; typecheck passa.

## Fim e handoff

Registrar contrato mínimo do manifesto/pins e classificação sintética para
DATA-03/04 e métricas. Semântica nova protege evidência; aplicação em produção deve
preceder qualquer poda e fica explicitamente pendente até ser comprovada.
