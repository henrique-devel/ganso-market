---
id: G2-03.2
macro: G2-03
rfc: RFC-045
section: S2
depends_on: [G2-03.1, G2-00.2]
mode: codigo
requirements: [RF-04]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-03.2 — Extrair primitivas financeiras reutilizáveis

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-045](../../docs/rfcs/RFC-045-ganso-2-nucleo-perfis.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 4.2 e 9.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/api/src/polymarket/paper/financial.ts e financialstore.ts da main
- apps/api/src/polymarket/fundamental/fixed.ts
- packages/contracts/src/trading/: resultado G2-03.1
- apps/api/src/trading/: diretório proposto para núcleo

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Primitivas compartilhadas pequenas e dependências de domínio separadas.

Extrair helpers realmente neutros de dinheiro, identidade, fingerprints e ordenação/replay; preservar regras binárias dentro do legado. Adaptar consumidores necessários sem copiar um segundo financeiro divergente. Não transportar q−preço, Kelly binário, token YES/NO nem funding fictício de stub.

## Validação e implantação

Fixtures financeiras existentes permanecem iguais depois da extração; nenhum consumidor legado muda PnL. Testes focados de fronteiras/imports e checks obrigatórios; não retestar todo o histórico manualmente.

PR/merge/deploy dos consumidores afetados, com regressão de compatibilidade. Fluxo BTC ainda desativado.

## Encerramento curto

Atualize apenas a linha **G2-03.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
