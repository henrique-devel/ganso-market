---
id: G2-12.3
macro: G2-12
rfc: RFC-053
section: S2
depends_on: [G2-11.2, G2-11.3, G2-12.2]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-12.3 — Admitir capacidade e retomar o coletor

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S2 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s2), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Coletor retomado sob capacidade comprovada e runtime seletivamente configurado.

Conferir plano versus medição final, margem para WAL/temporários/novas métricas, HOLD/pins e ausência de causa terminal. Orçar CPU/RAM/pools de todos os consumidores; host folgado não prova que cgroups estão adequados. Ajustes de distribuição no mesmo host exigem justificativa, testes e atualização dos validadores, sem novo custo nem aumento de caps de coleta/risco por conveniência. Se descarte, expansão ou mudança de critério forem indispensáveis, só prosseguir com a decisão concreta já registrada em G2-12.1. Retomar seletivamente o coletor, verificar captura por canal e que timers não reativam legado. Não rearmar baseline aqui.

## Contexto de código

- `docker-compose.yml`
- `scripts/check_compose_policy.py`
- `config/runtime.json`
- `docs/runbooks/btc-collector.md`
- `deploy/remote-deploy.sh`
- `docs/runbooks/single-server.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Preflight e comparação de IDs/inícios de PG e serviços não afetados; captura real, idade do livro/contexto, gaps, taxa de bytes e limite de recurso dentro do plano. Interromper coleta se capacidade ou integridade forem insuficientes, mantendo registro da falha. Checagem breve não certifica sete dias.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Configuração/restart seletivo autorizados pela sessão selecionada e pelas decisões aplicáveis; não recriar banco. Registrar instante real de retomada e projeção restante, sem iniciar relógio fictício de maturidade.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-12.3** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
