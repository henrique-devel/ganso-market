---
id: G2-11.1
macro: G2-11
rfc: RFC-053
section: S1
depends_on: []
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-11.1 — Revalidar a operação e tornar falhas diagnosticáveis

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S1 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s1), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Diagnóstico atual e erros sanitizados que identifiquem componente, etapa e causa.

Revalidar main, imagens, schema, coleta, liveness das contas, lease, última decisão e capacidade. A coleta de 27/09 é histórica: não atribuir o 55P03 à baseline sem correlação. Examinar o catch que reduz falhas a BTC_DESK_CONSUMER_FAILED. Implementar apenas o diagnóstico ausente: conta/etapa, SQLSTATE, duração e correlação, sem SQL com parâmetros, payloads, headers ou segredos. Separar saúde HTTP, banco, consumidor, lease e frescor. Medir por consultas limitadas; não varrer todo o corpus nem ativar logging de todas as queries. Registrar hipótese, fato observado e próxima reprodução na própria linha do estado.

## Contexto de código

- `apps/api/src/storage/desk-consumer.ts`
- `apps/api/src/btc/runtime-diagnostics.ts`
- `apps/api/src/database.ts`
- `apps/api/src/logger.ts`
- `docs/runbooks/btc-collector.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Fixtures de erro SQL, timeout e erro desconhecido preservam diagnóstico útil e removem dados sensíveis; rate limit de logs impede inundação. Em produção, leitura curta demonstra versão e campos disponíveis. Sem afirmar causa raiz apenas por coincidência temporal.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Deploy seletivo da API somente se houver alteração de código. Coletor permanece contido; nenhum rearme ou restart do banco. Uma leitura sem mudança não exige PR vazio.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-11.1** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
