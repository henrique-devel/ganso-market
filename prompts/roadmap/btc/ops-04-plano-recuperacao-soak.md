---
id: OPS-04
rfc: RFC-021
depends_on: [OPS-01, OPS-02, OPS-03, OPS-05, OPS-06, OPS-07]
mode: operation-plan
---
# OPS-04 — Preparar recuperação verificável e ensaio de coleta

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Produzir um plano operacional executável e pequeno de recuperação/validação,
com critérios que distingam processo vivo de coleta persistida.

## Leitura mínima

- `docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md` — emenda, D1–D4 e aceite.
- `docs/runbooks/single-server.md` — procedimentos do servidor.
- `docs/runbooks/polymarket-recorder.md` — observabilidade do recorder.
- `deploy/remote-deploy.sh` — sequência de deploy.
- `deploy/healthcheck.sh` — probes existentes.
- `docker-compose.yml` — recorder / logging / postgres.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Resolver SHAs/artefatos dos predecessores e pré-requisitos reais da RFC020.
Listar serviços afetados, comando por ação, medição prévia, duração, rollback e
consulta de aceite. Incluir ativação reversível do supervisor OPS-06 e sua evidência
externa limitada antes de recreates; validar D4 sem confundir closed com resolved. Não reiniciar banco para atualizar worker. Prever validação
após deploy, 15 ticks para rearme condicionado e janela contínua de coleta; meta
posterior de sete dias não equivale a tarefa concluída antes da observação.
Este prompt prepara o plano; aplicar somente operação concreta coberta pela
autorização vigente de execução. A tarefa de criação de RFCs não o executa.

## Aceite e verificação

- Plano contém comando, alvo, impacto, reversão e consulta pós-ação por etapa.
- Evidência exige avanço de snapshots, deltas e RTDS, gaps e ausência de backlog.
- Critérios de abortar/voltar incluem loop de restart, persistência falha e lag.
- D3 sem rearme forçado; supervisor externo e closed monotônico comprovados.
- Separar plano pronto, aplicado, janela observada e soak ainda pendente.

## Fim e handoff

Salvar plano em `docs/runbooks/btc-recovery.md` (novo) e registrar o ponto exato
no estado. Não declarar saúde nem execução com base somente em container Up.
