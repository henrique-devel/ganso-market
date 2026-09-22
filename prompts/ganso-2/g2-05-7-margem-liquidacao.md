---
id: G2-05.7
macro: G2-05
rfc: RFC-047
section: S7
depends_on: [G2-05.3, G2-05.6, G2-05.4]
mode: codigo
requirements: [RF-08]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.7 — Simular margem isolada e liquidação

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S7 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s7), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Ledger, valuation, reservas e broker BTC
- Metadados de manutenção G2-04.1
- Novo módulo proposto apps/api/src/trading/margin.ts
- Documentação oficial atual de margining/liquidations

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

1x tem manutenção e liquidação tratadas; patrimônio/reservas reconciliam.

Modelar margem isolada a1x com orçamento por posição, manutenção e gatilho por mark. Definir política conservadora de execução/custo da liquidação e déficit/gap; não equiparar stop a garantia. Bloquear abertura quando metadados ou marca não sustentarem o cálculo. Quantificar limitação do simulador sem fingir reproduzir detalhes não observados da venue.

## Validação e implantação

Long/short, aumento brusco de mark, funding que consome margem, parcial e gap além do nível. Liquidar não duplica fill/fee nem usa o caixa de outra conta; registrar saldo residual/deficit explicitamente.

PR/merge/deploy inativo até S10; nenhuma alavancagem escolhida pela IA.

## Encerramento curto

Atualize apenas a linha **G2-05.7** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
