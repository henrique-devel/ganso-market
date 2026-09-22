---
id: G2-07.1
macro: G2-07
rfc: RFC-049
section: S1
depends_on: [G2-05.10]
mode: contrato
requirements: [RF-11, RF-13]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-07.1 — Fechar a regra e o manifesto do primeiro experimento

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-049](../../docs/rfcs/RFC-049-ganso-2-estrategia-base.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.1 e 8.3.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- docs/PRD-GANSO-2.0.md: seção 8.1
- Barras/qualidade G2-04.3 e risco G2-05.8
- Novo arquivo proposto config/trading/baseline.json
- Contrato proposto de versão/manifesto de experimento

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Uma política-base explícita e congelável, suficiente para implementação sem inventar regras depois.

Escolher e especificar uma regra simples e reproduzível para tendência, entrada, stop por volatilidade, saída e warmup. Fixar parâmetros, fontes, custo e regras de avaliação antes da observação prospectiva. Definir referência BTC/caixa e variante Jev como filtro da mesma entrada. Versionar manifesto, sem otimizar usando o futuro nem alegar alpha validado.

## Validação e implantação

Exemplos manuais de sinal comprado, vendido, neutro, warmup e saída por 6 h; validação impede parâmetros contraditórios com risco. Sem backtest massivo nesta sessão.

PR/merge da configuração/contrato; automação fica desligada. Não pedir confirmação de cada escolha rotineira dentro da hipótese aprovada.

## Encerramento curto

Atualize apenas a linha **G2-07.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
