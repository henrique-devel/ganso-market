---
id: G2-05.3
macro: G2-05
rfc: RFC-047
section: S3
depends_on: [G2-05.2]
mode: codigo
requirements: [RF-05]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.3 — Reservar margem e capacidade sem concorrência indevida

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S3 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s3), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Ledger/valuation BTC de G2-05.1/2
- apps/api/src/polymarket/paper/reservations.ts: padrão de atomicidade, leitura dirigida
- Novo módulo proposto apps/api/src/trading/reservations.ts
- apps/api/src/database.ts e migration de ordens/reservas proposta

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Contrato reserve/consume/release atômico, compartilhável por manual e estratégia.

Implementar aceitação+reserva na mesma transação e lock por dono, contabilizando ordens pendentes, taxas estimadas e margem. Separar redução de posição de abertura; reservas não expiram apenas pelo relógio sem transição efetiva. Não emprestar capital entre contas experimentais.

## Validação e implantação

PostgreSQL real com duas ordens que somam mais que disponível, duas saídas sobre mesmo inventário, rollback, retry e troca parcial de reserva por posição. Ordem de locks evita deadlock previsível.

PR/merge/migration aditiva e deploy inativo para novas ordens; risco completo ainda depende de S8.

## Encerramento curto

Atualize apenas a linha **G2-05.3** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
