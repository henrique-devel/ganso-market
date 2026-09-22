---
id: G2-03.1
macro: G2-03
rfc: RFC-045
section: S1
depends_on: [G2-00.1]
mode: codigo
requirements: [RF-01, RF-04]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-03.1 — Definir tipos e fronteiras do núcleo BTC

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-045](../../docs/rfcs/RFC-045-ganso-2-nucleo-perfis.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 4.2 e 9.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- packages/contracts/src/money-amount.ts e types.ts
- apps/api/src/polymarket/fundamental/fixed.ts
- apps/api/src/polymarket/paper/ownership.ts na main
- Novo namespace proposto packages/contracts/src/trading/

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Contrato neutro exportado com fronteiras explícitas para próximos prompts.

Definir instrumento, conta, experimento, intenção, ordem, execução e origem de dados/decisão em tipos/validação. Separar BTC, USD, preço, taxa e probabilidade; declarar escala/arredondamento/UTC e IDs idempotentes. Fixar forma de ledger perpétuo sem implementar banco ou broker. Manter contratos Polymarket existentes.

## Validação e implantação

Validar unidades trocadas, quantização, dados sem identidade e modos inválidos. Nenhum valor de private key altera modo. Pequenas fixtures de contratos, sem simular uma corretora inteira.

PR/merge; biblioteca pode ser implantada sem consumidor ativo. Não ligar worker neste bloco.

## Encerramento curto

Atualize apenas a linha **G2-03.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
