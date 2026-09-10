---
id: DB-04
rfc: RFC-037
depends_on: [DB-01, DB-02, DB-03]
mode: operation-plan
---
# DB-04 — Dimensionar recursos e validar operação integrada

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Produzir plano concreto de aplicação dos acessos SQL e recursos necessários,
com um ensaio integrado que caiba no servidor atual.

## Leitura mínima

- `docs/rfcs/RFC-037-consultas-e-recursos-postgres.md` — DB-04 e aceite.
- `docker-compose.yml` — postgres / pools por serviço.
- `apps/api/src/database.ts` — DatabasePoolOverrides.
- `scripts/check_runtime_memory.py` — validação de orçamento runtime.
- `scripts/check_compose_policy.py` — política Compose.
- `docs/runbooks/single-server.md` — operação do servidor atual.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Usar resultados DB-01/02/03; budget de CPU, shared_buffers, work_mem por operação
multiplicado por simultaneidade, pools, manutenção e reserva OS. Não presumir 2–4
CPUs ou RAM livre ilimitada. Separar reload/restart e índices concorrentes; validar
compatibilidade do migrator. Definir janela, headroom, rollback, catálogo dos
índices e verificação de índice inválido. Ensaio inclui workers ativos e seis abas,
requisições limitadas e métricas p95/p99/timeouts/lag. Sem migração para máquina local.
Gerar plano; operação somente quando concreta e coberta pela autorização vigente.

## Aceite e verificação

- Orçamento total contém memória de operações paralelas e conexões reservadas.
- Comandos de aplicação e rollback têm alvo, pré-condição e tempo máximo.
- Critério: zero timeout no ensaio datado, abaixo do budget, sem OOM/gaps novos.
- Ganho de leitura não esconde regressão de ingestão; medir ambos.
- Não declarar ensaio executado ou soak concluído ao apenas escrever plano.

## Fim e handoff

Salvar `docs/runbooks/btc-postgres-capacity.md` (novo) e resultado/progresso no
estado. FRESH-01 recebe capacidade efetivamente medida; pendência operacional fica
explícita e não é confundida com patch aceito.
