---
id: G2-05.6
macro: G2-05
rfc: RFC-047
section: S6
depends_on: [G2-05.2, G2-04.3]
mode: codigo
requirements: [RF-08]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.6 — Contabilizar funding com tempo e idempotência

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S6 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s6), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Ledger/valuation BTC
- Feed de funding e metadados da venue
- Novo módulo proposto apps/api/src/trading/funding.ts
- Documentação oficial atual de funding Hyperliquid

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Funding registrado uma vez e reconciliado por tempo econômico.

Aplicar funding observado no horário econômico e sobre a posição elegível naquele instante, com sinal correto long/short. Tratar chegada atrasada e reconciliação sem atribuir funding a posição aberta depois. Taxa ausente produz estado pendente, não custo zero silencioso. O funding altera saldo e métricas sem dupla incidência.

## Validação e implantação

Funding positivo/negativo, posição aberta/fechada junto ao corte, duplicata, atraso e restart. Replay chega ao mesmo saldo e risco diário inclui o efeito.

PR/merge/deploy de componente ainda subordinado ao gate S10; sem consultas pagas.

## Encerramento curto

Atualize apenas a linha **G2-05.6** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
