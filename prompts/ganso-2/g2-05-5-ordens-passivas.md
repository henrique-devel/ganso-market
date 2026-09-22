---
id: G2-05.5
macro: G2-05
rfc: RFC-047
section: S5
depends_on: [G2-05.4]
mode: codigo
requirements: [RF-07]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.5 — Adicionar ordem passiva com fill conservador

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S5 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s5), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Broker BTC de G2-05.4
- Feed trades/livro G2-04.2/3
- Novo módulo proposto de política maker dentro do broker
- Modelo de execução versionado nos contratos BTC

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Ordens passivas funcionam com limitação conservadora e auditável.

Implementar ordem post-only, validade e fila conservadora com hipóteses declaradas. Recusar ordem que cruzaria e exigir evidência posterior de execução, sem tratar toque no preço como fill garantido. Atualizações/cancelamento mantêm prioridade conforme modelo definido. Preservar dados mínimos que sustentam cada fill.

## Validação e implantação

Toque sem negociação não preenche; negociação insuficiente gera parcial ou zero conforme fila; cancelamento tardio, gap e restart não duplicam fill. Versionar modelo e identificar baixa fidelidade; comparar contra IOC apenas como cenário.

PR/merge/deploy ainda sem ativar o fluxo manual. Não prometer posição de fila real da venue.

## Encerramento curto

Atualize apenas a linha **G2-05.5** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
