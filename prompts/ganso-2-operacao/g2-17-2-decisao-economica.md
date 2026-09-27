---
id: G2-17.2
macro: G2-17
rfc: RFC-053
section: S7
depends_on: [G2-17.1, G2-16.2]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-17.2 — Concluir o experimento e delimitar a próxima hipótese

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S7 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s7), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Decisão econômica clara: continuar, nova hipótese, rejeitar ou inconclusivo.

Avaliar resultado líquido de trading e após custos, drawdown, exposição, giro, funding, concentração e referência de risco compatível. Para Jev, separar veto, indisponibilidade, custo, diferença observacional e causalidade não demonstrada; operação vetada não é perda evitada sem contrafactual válido. Relatar incerteza e tentativas/versionamentos, inclusive negativos. Não otimizar limiares no mesmo conjunto nem selecionar só dias favoráveis. Registrar se produto está pronto operacionalmente, se IA está ativa e se hipótese tem suporte econômico como três conclusões diferentes. Se houver nova hipótese, delimitá-la para outro pedido, sem executar automaticamente.

## Contexto de código

- `docs/contracts/btc-metrics-v1.md`
- `apps/api/src/storage/metrics.ts`
- `docs/PRD-GANSO-2.0.md`
- `docs/roadmap/GANSO_2_EXECUTION_STATE.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Relatório curto reproduzível a partir dos datasets/versões e custos; todos os critérios aplicáveis conferidos. Sem atribuir alpha por lucro isolado ou por sete dias saudáveis. Falta de cobertura preserva inconclusivo e não vira aceite automático.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Fecho documental; nenhum capital novo, live, compra, backup ou promoção de modelo por consequência deste resultado. Atualizar somente novo ciclo no tracker, mantendo histórico e pendências anteriores vinculados.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-17.2** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
