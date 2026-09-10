---
id: DATA-05
rfc: RFC-041
depends_on: [DATA-04, DB-04]
mode: operation-plan
---
# DATA-05 — Preparar limpeza atual e política contínua sustentável

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar plano concreto de limpeza e manutenção, com política contínua que
reserve capacidade para novos experimentos sem apagar evidência necessária.

## Leitura mínima

- `docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md` — espaço e política contínua.
- `apps/api/src/polymarket/retention.ts` — RETENTION_TABLES / orçamento.
- `apps/api/src/polymarket/orchestrator.ts` — createRetentionSupervisor.
- `docker-compose.yml` — volumes / logging / limites.
- `docs/runbooks/single-server.md` — manutenção do servidor.
- `deploy/shadow_replay_job.py` — artefatos do replay.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Consolidar inventário, manifesto, proteção aplicada e restore verificado quando
necessário. Listar objetos/cutoffs, ganho estimado, comandos, batch budget, stop,
rollback/restore e autorização que cobre o escopo. Se ainda não coberto, apresentar
somente essa ação concreta para aprovação; não reabrir permissões rotineiras.
Distinguir VACUUM reutilizável de VACUUM FULL/repack/reindex e espaço OS. Estimar
rewrite/temp/WAL/locks e reserva antes de manutenção; não presumir extensão instalada.
Artefatos/logs/imagens via lista exata preservam release rollback; sem prune global.
Propor TTL/quota por classe, pins L2/benchmark/replay, quota/expiração de backups,
headroom e projeção 7/30/90 dias. Padrão: plano. Aplicar somente com autorização
explícita vigente para o manifesto concreto; este pedido continua só documentação.

## Aceite e verificação

- Plano não habilita poda antes de proteção efetiva/certificado necessário.
- Medição separa vivo/físico/reutilizável/livre OS antes/depois.
- Rotina incremental tem limite por rodada e alerta de quota sem violar pins.
- Sem espaço temporário suficiente, manutenção física não inicia.
- Aceite preserva reconciliação econômica e datasets; ganhos estimados são rotulados.

## Fim e handoff

Salvar `docs/runbooks/btc-data-lifecycle.md` (novo) com manifesto referenciado e
rotina sustentável. Atualizar estado distinguindo preparado/aplicado/verificado;
a criação destes documentos não é autorização implícita para perda irreversível.
