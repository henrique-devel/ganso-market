---
id: G2-11.2
macro: G2-11
rfc: RFC-053
section: S1
depends_on: [G2-11.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-11.2 — Corrigir contenção e falhas do consumidor baseline

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S1 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s1), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Ciclos de conta e persistência não se bloqueiam por trabalho evitável dentro de locks.

Reproduzir a causa efetivamente encontrada no consumidor/coletor: advisory lock de retenção, leitura de evidência, checkpoint, lease, pool ou consulta. Mapear duração e ordem dos locks; retirar trabalho pesado de regiões críticas sem perder revalidação, atomicidade, idempotência ou pins. Garantir rollback/liberação em timeout, cancelamento e resposta de COMMIT incerta. Corrigir somente caminhos necessários ao BTC. A issue 198 é histórico, não autorização para reativar o legado. Não resolver com aumento global de timeout, pool ou supressão da falha.

## Contexto de código

- `apps/api/src/storage/btc-retention.ts`
- `apps/api/src/storage/baseline-runtime.ts`
- `apps/api/src/storage/baseline-store.ts`
- `apps/api/src/storage/recoverystore.ts`
- `apps/api/src/storage/recovery-audit.ts`
- `apps/api/src/database.ts`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

PostgreSQL descartável com captura concorrente, decisão, reconciliação e cancelamento; reproduzir falha antes e mostrar correção depois. Cobrir lease expirado, worker antigo e COMMIT incerto. Comparar tempo/locks com corpus representativo limitado; zero divergência financeira.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

API/coletor afetados, preservando PostgreSQL compartilhado e dados BTC. Correção publicada pode ficar code-verified enquanto retomada do coletor depende de G2-12.3. Não exigir coleta produtiva insegura para encerrar código.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-11.2** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
