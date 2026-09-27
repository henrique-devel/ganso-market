---
id: G2-13.1
macro: G2-13
rfc: RFC-053
section: S3
depends_on: [G2-11.1, G2-12.3]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-13.1 — Expor prontidão operacional e telemetria útil

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S3 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s3), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Operador distingue API acessível de dados/contas realmente prontos.

Integrar status do coletor, última captura, frescor por canal, consumidor por conta, lease, reconciliação, CPU/RAM/disco e reinícios onde houver fonte confiável. Reaproveitar telemetria existente; não montar docker.sock na API nem expor segredos ou comandos administrativos na web. Fonte ausente/antiga vira indisponível/stale, nunca zero ou verde. Histórico mínimo deve permitir medir sete dias e interrupções com custo de retenção incluído em G2-12. Não criar automação Codex, enviar mensagens ou adicionar provedor de monitoramento; esta fatia é observabilidade do produto. Preservar health HTTP simples e acrescentar estado operacional explícito.

## Contexto de código

- `apps/api/src/experiments-api.ts`
- `apps/api/src/trading-readapi.ts`
- `apps/api/src/storage/desk-consumer.ts`
- `apps/api/src/btc/runtime-diagnostics.ts`
- `apps/web/src`
- `deploy/capacity_series.py`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Fixtures API saudável/coletor parado, lease expirado/status ready, conta em falha, dado stale, telemetria indisponível e restart. UI e API autenticadas mostram motivos corretos; leitura não escreve nem dispara reconciliação. Fonte produtiva conferida com snapshot curto.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Deploy seletivo da superfície afetada; produtor mínimo de telemetria no host somente se necessário e no orçamento existente. Nenhum reset de contadores históricos.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-13.1** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
