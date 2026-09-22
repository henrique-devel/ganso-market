---
id: G2-05.9
macro: G2-05
rfc: RFC-047
section: S9
depends_on: [G2-05.5, G2-05.8]
mode: codigo
requirements: [RF-10]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.9 — Recuperar ordens e reservas após falha

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S9 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s9), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Ledger/projeções/ordens/reservas BTC
- Entry point de worker BTC entregue em G2-03.3
- apps/api/src/database.ts
- Novo módulo proposto de recuperação BTC

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Boot não duplica transações nem abre conta inconsistente.

Reconciliar ordens, posição, funding, reserva e estado de risco antes de aceitar novas intenções após boot. Persistir checkpoints necessários sem converter estado em memória em autoridade. Definir exclusão de dois workers para a mesma conta e replay de eventos atrasados. Falha na reconciliação mantém a conta fechada para aumento de risco.

## Validação e implantação

Queda antes/depois do commit de fill, funding, cancelamento e reserva; dois workers concorrentes; retry após resposta ambígua; projeção adulterada detectada/reconstruída. Usar PostgreSQL descartável.

PR/merge/deploy e teste breve de restart controlado quando seguro, sem rearmar estratégias desativadas.

## Encerramento curto

Atualize apenas a linha **G2-05.9** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
