---
id: G2-12.2
macro: G2-12
rfc: RFC-053
section: S2
depends_on: [G2-11.2, G2-12.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-12.2 — Implementar persistência sustentável preservando evidências

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S2 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s2), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Volume de novos dados e custo de persistência compatíveis com o plano aprovado.

Implementar a alternativa escolhida: eliminar duplicação evitável, compartilhar evidências e agregar apenas dados futuros ainda não expostos, respeitando o contrato econômico. Manter trades, livro necessário ao fill, origem, timestamps, dependências e replay. Não remover pins nem reclassificar evidência antiga para liberar quota. Se mudar representação, versionar e manter leitura dos registros existentes; migration aditiva, aplicada imutável. Retenção destrutiva é ramo condicional: preparar dry-run com conjunto/corte/bytes, excluir histórico protegido e executar apenas com autorização específica vigente. Sem ela, entregar a parte não destrutiva e registrar capacidade ainda não resolvida, sem marcar coleta sustentável.

## Contexto de código

- `apps/api/src/storage/btc-marketstore.ts`
- `apps/api/src/storage/btc-retention.ts`
- `apps/api/src/trading/retention.ts`
- `apps/api/src/btc/collector.ts`
- `apps/api/src/storage/replaystore.ts`
- `docs/runbooks/ganso-2-btc-retention.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Paridade de ledger/replay antes e depois; referências transitivas, duplicatas, crash no commit, corpus com pins e HOLD. Medir bytes, WAL e latência em PostgreSQL descartável com carga representativa; resultado deve sustentar o plano, não só passar unitários.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Serviços afetados e migration compatível, preservando corpus e rollback. Não reativar a coleta nem aumentar tetos para esconder falha de economia; G2-12.3 admite operação.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-12.2** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
