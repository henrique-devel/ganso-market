---
id: G2-05.8
macro: G2-05
rfc: RFC-047
section: S8
depends_on: [G2-05.7]
mode: codigo
requirements: [RF-09]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.8 — Aplicar limites e estados operacionais às ordens

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S8 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s8), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Valuation, reservas, margem e broker BTC
- Novo módulo proposto apps/api/src/trading/risk.ts
- Configuração versionada dos limites do PRD
- Contrato de estados NORMAL/REDUCE_ONLY/HALTED

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Risco determinístico domina as intenções e permanece independente de Jev.

Implementar exposição 25%, risco planejado 0,25%, pausa diária 1,5% e drawdown 5% por conta, incluindo não realizado/fees/funding e reservas. Definir permissões de cancelamento/saída por estado e impedir inversão. Rearme exige condições e ação explícita, sem resetar âncoras. Manual e automático passam pela mesma avaliação.

## Validação e implantação

Limite atingido por marca/funding, duas entradas concorrentes, capital externo ajustando âncora, dados stale e saída durante pausa. Stop/slippage não são apresentados como perda máxima garantida.

PR/merge/deploy de limites com broker ainda protegido pelo gate integrado; caps não são relaxados para gerar trades.

## Encerramento curto

Atualize apenas a linha **G2-05.8** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
