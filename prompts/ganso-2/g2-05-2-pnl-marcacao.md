---
id: G2-05.2
macro: G2-05
rfc: RFC-047
section: S2
depends_on: [G2-05.1, G2-04.3]
mode: codigo
requirements: [RF-04, RF-08]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.2 — Calcular saldo, patrimônio e valor de encerramento

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Ledger BTC de G2-05.1
- Livro/mark do marketstore G2-04.3
- Novo módulo proposto apps/api/src/trading/valuation.ts
- Testes financeiros FIN-07 da main como referência, sem reaplicar payoff binário

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Visão financeira BTC correta por conta com qualidade da marca explícita.

Implementar custo-base/realizado long e short, não realizado e patrimônio. Separar mark/oracle de manutenção e valor executável de encerramento. Reserva não é taxa; slippage embutido no fill não é debitado de novo. Marca ausente/stale torna resultado indisponível ou degradado, nunca zero lucro ou patrimônio artificialmente seguro.

## Validação e implantação

Fixtures independentes long/short com ganho/perda, parcial, custos, marca ausente e sinais opostos entre donos. Replay e projeção concordam em unidade mínima; endpoint de leitura não altera cache.

PR/merge/deploy de leitura/cálculo, sem ativar ordens.

## Encerramento curto

Atualize apenas a linha **G2-05.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
