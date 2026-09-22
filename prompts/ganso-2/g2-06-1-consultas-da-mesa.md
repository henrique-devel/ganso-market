---
id: G2-06.1
macro: G2-06
rfc: RFC-048
section: S1
depends_on: [G2-05.2, G2-03.3]
mode: codigo
requirements: [RF-14]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-06.1 — Publicar leitura de contas, posições e ordens

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-048](../../docs/rfcs/RFC-048-ganso-2-mesa-operador.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 6 e 7.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/api/src/server.ts e rotas autenticadas existentes
- Projeções BTC de G2-05.1/2
- packages/contracts/src/trading/: DTOs
- Novas rotas propostas /trading/accounts e /trading/orders

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Backend de consulta pronto para a interface.

Adicionar consultas autenticadas e paginadas da conta selecionada, posição, ordens, saldo/margem, marca e frescor. Expor motivos estruturados sem transformar ausência em zero. Usar projeções eficientes, sem reconstruir todo ledger em cada refresh nem misturar patrimônio dos cenários.

## Validação e implantação

Conta sem marca, conta inexistente, acesso não autenticado, paginação e ausência de side effect financeiro. Contrato permite estado indisponível.

PR/merge/deploy de leitura; perfis financeiros incompletos continuam sem rotas de transação ativas.

## Encerramento curto

Atualize apenas a linha **G2-06.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
