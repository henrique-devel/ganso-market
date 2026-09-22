---
id: G2-07.2
macro: G2-07
rfc: RFC-049
section: S2
depends_on: [G2-07.1, G2-04.3]
mode: codigo
requirements: [RF-11]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-07.2 — Implementar sinal, tamanho e saídas da regra congelada

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-049](../../docs/rfcs/RFC-049-ganso-2-estrategia-base.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.1 e 8.3.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Manifesto baseline de G2-07.1
- Barras fechadas e cálculo financeiro/risco BTC
- Novo módulo proposto apps/api/src/trading/strategies/baseline.ts
- Contrato de intenção e decisão neutra

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Mesmos inputs/versionamento geram a mesma intenção e motivo.

Implementar exatamente o manifesto, com candidato e motivos determinísticos e tamanho limitado por volatilidade/custos/risco. Entrada e saída usam timestamps as-of; risco planejado inclui custos. Nenhum caminho gera sinal durante gap/warmup incompleto. Não adicionar Jev ou retocar limiares para aumentar trades.

## Validação e implantação

Fixtures independentes para tendência long/short, neutralidade, cost veto, stop, saída temporal e impossibilidade de olhar barra em formação. Saída continua possível quando novas entradas estão pausadas.

PR/merge/deploy de código ainda inativo para ordens automáticas.

## Encerramento curto

Atualize apenas a linha **G2-07.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
