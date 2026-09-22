---
id: G2-06.4
macro: G2-06
rfc: RFC-048
section: S4
depends_on: [G2-06.3]
mode: codigo
requirements: [RF-14]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-06.4 — Organizar operações, motivos e acervo legado

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S4 da RFC-048](../../docs/rfcs/RFC-048-ganso-2-mesa-operador.md#s4), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 6 e 7.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/web/src/App.tsx, Decisoes.tsx e Sistema.tsx
- APIs BTC de leitura e motivos
- Telas Polymarket ainda utilizadas
- Contrato de vínculo decisão/ordem/fill/saída

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Mesa compreensível e histórico acessível sem misturar mercados e cenários.

Organizar Mesa/Operações/Experimentos/Sistema, deixando acervo Polymarket identificado fora do fluxo BTC padrão. Mostrar ficha da operação com inputs, motivos, custos e execução efetiva. Diferenciar falta de sinal, veto, falha e coleta em warmup. Não preencher explicação causal com texto inventado após o resultado.

## Validação e implantação

Navegação, seleção de conta, dado ausente, motivo de recusa e drilldown até fill. Checagem de leitura sem mutações e sem painel que some as três contas.

PR/merge/deploy da interface; preservar acesso ao histórico necessário e retirar controles mortos.

## Encerramento curto

Atualize apenas a linha **G2-06.4** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
