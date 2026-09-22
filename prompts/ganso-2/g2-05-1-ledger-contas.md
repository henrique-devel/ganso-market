---
id: G2-05.1
macro: G2-05
rfc: RFC-047
section: S1
depends_on: [G2-03.2, G2-04.1]
mode: codigo
requirements: [RF-04]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.1 — Persistir contas e eventos do perpétuo

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Contrato neutro e helpers de G2-03.1/2
- apps/api/src/database.ts
- Novos módulos propostos apps/api/src/trading/ledger.ts e ledgerstore.ts
- migrations/: conferir numeração na base atual

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Ledger e identidade das contas persistidos; contrato consumível pelos próximos módulos.

Implementar conta/experimento/instrumento e ledger append-only para capital, fill, fee, funding e liquidação como eventos tipados. Criar projeção inicial de saldo e posição e chaves idempotentes. A gênese de cada cenário vale US$ 1.000; reiniciar experimento cria outro ID. Não converter histórico Polymarket nem presumir migração de saldo legado.

## Validação e implantação

SQL real de duplicata com mesmo conteúdo, colisão com conteúdo diferente, dois donos e replay ordenado. Eventos inválidos não deixam projeção parcial. Nenhuma escrita de teste em produção.

PR/merge/migration aditiva e deploy com conta/ordens BTC ainda não ativadas.

## Encerramento curto

Atualize apenas a linha **G2-05.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
