---
id: G2-09.2
macro: G2-09
rfc: RFC-051
section: S2
depends_on: [G2-09.1]
mode: codigo
requirements: [RF-13]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-09.2 — Calcular resultado líquido e contribuição do filtro

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-051](../../docs/rfcs/RFC-051-ganso-2-avaliacao-maturidade.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.3, 9.1 e 15.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Ledger/valuation/custos e manifestos BTC
- Novas projeções propostas de métricas por experimento
- Decisões-base/challenger, quando existentes
- Contrato das referências BTC/caixa

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Desempenho explicado por risco, exposição e custos, sem somar cenários.

Implementar retorno líquido, drawdown, tempo exposto, giro, custos/IA/funding e operações vetadas. Mostrar trading líquido e resultado após custo operacional alocado sem dupla incidência. Referências normalizadas distinguem 25%/100% de exposição e spot/perpétuo. Métricas aceitam challenger ausente; não esperar integração Jev para tornar baseline avaliável.

## Validação e implantação

Casos manuais verificam fórmulas, patrimônio zero/negativo, funding atrasado, datas UTC, custo compartilhado e comparações com risco diferente. Eventos correlacionados não contam como observações independentes.

PR/merge/deploy de métricas de leitura; nenhum parâmetro de estratégia é alterado.

## Encerramento curto

Atualize apenas a linha **G2-09.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
