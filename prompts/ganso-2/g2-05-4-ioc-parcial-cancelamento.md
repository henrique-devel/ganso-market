---
id: G2-05.4
macro: G2-05
rfc: RFC-047
section: S4
depends_on: [G2-05.3, G2-04.3]
mode: codigo
requirements: [RF-05, RF-07]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.4 — Executar IOC, parcial e cancelamento com custos

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S4 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s4), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Reservas BTC de G2-05.3 e marketstore G2-04.3
- Novo módulo proposto apps/api/src/trading/broker.ts
- apps/api/src/polymarket/paper/bookwalk.ts ou equivalente, localizar padrão
- Contrato de ordem/fee metadata G2-04.1

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Fluxo imediato e cancelamento preservam saldo, reserva e evidência de execução.

Implementar intenção executável com limite de preço, latência configurada, consumo de profundidade compartilhado e parcial IOC. Validar frescor e expiração antes do fill, aplicar fee uma vez e cancelar restante. Resolver corrida fill/cancelamento com estado efetivo; reduce-only nunca inverte posição. Não usar preços anteriores à decisão para preencher.

## Validação e implantação

Livro insuficiente, slippage limite, atraso, expiry durante processamento, fill/cancelamento concorrentes e profundidade disputada por ordens da mesma conta. SQL real para atomicidade; cenários alternativos usam mercados contrafactuais identificados.

PR/merge/deploy do broker inativo para o operador até S10; sem ordens reais.

## Encerramento curto

Atualize apenas a linha **G2-05.4** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
