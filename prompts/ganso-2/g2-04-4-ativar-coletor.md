---
id: G2-04.4
macro: G2-04
rfc: RFC-046
section: S4
depends_on: [G2-04.3, G2-03.3, G2-01.2]
mode: operacao
requirements: [RF-03, RF-15]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-04.4 — Ativar coleta BTC com limites no servidor

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S4 da RFC-046](../../docs/rfcs/RFC-046-ganso-2-dados-hyperliquid.md#s4), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7.3, 9 e 10.1.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Perfil BTC G2-03.3 e coletor G2-04.3
- Política de retenção e quota G2-02.4
- docs/ops/SERVER_ACCESS.md
- Configuração do limite de raw/frescor e health

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Coleta BTC limitada em operação; maturidade/observação longa ficam em G2-09.

Revalidar espaço disponível, limites de retenção e orçamento combinado; ativar apenas coleta BTC com limites. Confirmar health por canal, escrita limitada, reconexão e contador de crescimento. Nenhuma estratégia/ordem é ligada. Se o host estiver abaixo do piso de 25%, não adicionar persistência: registrar a dependência exata e manter trabalho local pronto.

## Validação e implantação

Checagem breve de eventos reais, metadados e barras quando houver período fechado; diferenciar warmup pendente de falha. Não aguardar dias nesta sessão nem atribuir ausência de gaps futuros.

PR/merge/configuração e ativação produtiva do coletor estão autorizados, usando host existente e sem compras.

## Encerramento curto

Atualize apenas a linha **G2-04.4** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
