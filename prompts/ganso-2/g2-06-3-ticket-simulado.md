---
id: G2-06.3
macro: G2-06
rfc: RFC-048
section: S3
depends_on: [G2-06.2, G2-04.4]
mode: codigo-operacao
requirements: [RF-01, RF-06]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-06.3 — Entregar ticket e primeira operação manual completa

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S3 da RFC-048](../../docs/rfcs/RFC-048-ganso-2-mesa-operador.md#s3), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 6 e 7.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/web/src/App.tsx, Mesa.tsx e auth.ts
- DTOs/comandos G2-06.1/2
- Novos componentes propostos de ticket BTC no web
- Configuração da conta manual e simulador

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Operador realiza e entende uma transação simulada de ponta a ponta.

Criar ticket BTC para compra/venda, quantidade/nocional, tipo, validade e proteção de preço, exibindo custo/reserva/risco. Integrar estados de parcial, cancelamento solicitado/efetivo e saída. Ativar somente a conta manual paper com gênese idempotente US$ 1.000; manual não contorna limites. Manter indicador de fonte real, saldo fictício e marca stale.

## Validação e implantação

Percorrer no ambiente apropriado abertura, parcial/cancelamento e fechamento; verificar retorno do saldo/posição no extrato. Testes do fluxo crítico e uma checagem de UI responsiva; sem exigir screenshots/relatório formal.

PR/merge/deploy e ativação do ticket manual estão autorizados após dependências técnicas. Estratégias automáticas continuam desativadas.

## Encerramento curto

Atualize apenas a linha **G2-06.3** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
