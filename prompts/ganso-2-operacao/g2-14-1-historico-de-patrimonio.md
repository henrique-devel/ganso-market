---
id: G2-14.1
macro: G2-14
rfc: RFC-053
section: S4
depends_on: [G2-12.2, G2-13.3]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-14.1 — Persistir patrimônio com marcação temporal verificável

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S4 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s4), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Histórico de equity utilizável durante posições abertas e reproduzível no corte temporal.

Definir contrato versionado de observações de patrimônio por conta/período: preço e seu fundamento temporal, ledger conhecido naquele instante, realizado/não realizado, taxas, funding, reservas e fluxos externos. Implementar amostragem limitada com idempotência, cutoffs e evidência pinada. Distinguir instante econômico e disponibilidade; funding tardio não altera o que era conhecido num corte anterior. Mark ausente/gap produz amostra indisponível, sem interpolação ou preço futuro. Preservar a limitação do contexto HTTP e funding paper. Orçar escrita/retensão antes de ativar; histórico ausente não pode ser reconstruído silenciosamente com preços atuais.

## Contexto de código

- `apps/api/src/trading/valuation.ts`
- `apps/api/src/storage/valuationstore.ts`
- `apps/api/src/storage/ledgerstore.ts`
- `apps/api/src/storage/metrics.ts`
- `apps/api/src/storage/btc-retention.ts`
- `docs/contracts/btc-metrics-v1.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

PG/fixtures independentes: posição aberta lucrativa/perdedora, redução, fee/funding tardio, capital transferido, gap, amostra duplicada e crash. Provar vínculo as-of e ausência de dupla contabilização. Medir bytes/cadência contra o orçamento de G2-12.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Migration aditiva se necessária e ativação seletiva do produtor no runtime existente. Sem serviço extra ou mudança de risco. Atualizar compatibilidade de replay antes de descartar qualquer dado.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-14.1** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
