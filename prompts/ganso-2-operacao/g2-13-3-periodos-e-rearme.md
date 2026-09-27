---
id: G2-13.3
macro: G2-13
rfc: RFC-053
section: S3
depends_on: [G2-11.2, G2-12.3]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-13.3 — Tratar horizonte do experimento e rearme controlado

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S3 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s3), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Procedimento explícito e auditável para retomar a baseline e avaliar novos períodos sem reset de patrimônio.

Conferir registro original, horizonte de entradas de 30 dias, pausas, funding e guarda de recuperação. Entregar comando protegido/idempotente de rearme que chame o contrato de risco e revalide dados, dono e fence; não atualizar checkpoint diretamente. Verificar se o período original ainda comporta a avaliação futura. Se precisar de continuidade/novo período, definir registro append-only com início futuro, versão e vínculo ao histórico; implementar o delta mínimo de seleção/horizonte sem mudar política financeira ou reescrever gênese, saldo e decisões. Separar piloto operacional de avaliação econômica. Não estender retrospectivamente uma janela para retirar perdas/gaps nem criar novos US$ 1.000 para ocultá-los. Nova conta/capital ou mudança de caps exigem decisão específica; as saídas antigas sempre continuam.

## Contexto de código

- `apps/api/src/storage/riskstore.ts`
- `apps/api/src/storage/baseline-runtime.ts`
- `apps/api/src/storage/baseline-manifest.ts`
- `apps/api/src/baseline-activate-cli.ts`
- `config/trading/baseline.json`
- `docs/runbooks/btc-baseline-runtime.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

PG: rearmar com feed/funding inválido é recusado; concorrência, lease antigo e repetição não alteram âncoras. Expiração bloqueia somente entradas do período correspondente, preserva saídas e histórico. Registro futuro não executa cedo; seleção de períodos não duplica sinais.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Entregar mecanismo e runbook; não efetuar rearme nesta fatia. G2-13.4 aplica o procedimento após gate atual. Se o delta exigir mais de uma entrega coerente, criar subblocos no mesmo estado antes de ampliar escopo.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-13.3** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
