---
id: G2-08.3
macro: G2-08
rfc: RFC-050
section: S3
depends_on: [G2-08.2, G2-06.4]
mode: codigo-operacao
requirements: [RF-12, RF-15]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-08.3 — Ativar comparação Jev dentro do orçamento

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S3 da RFC-050](../../docs/rfcs/RFC-050-ganso-2-jev-challenger.md#s3), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.2 e 8.3.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Adaptador/filtro Jev e configuração de orçamento
- Mesa/Experimentos e motivos
- Conta challenger e manifesto congelado
- Credencial existente do provedor, sem ler/exibir valor

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Challenger real identificado e medido, ou integração pronta sem simular uma ativação que não aconteceu.

Expor origem real/mock, custo, latência, veto e indisponibilidade. Ativar challenger apenas se a credencial e o orçamento de consumo estiverem explicitamente disponíveis; do contrário entregar controle pronto, desativado, e registrar o único impedimento. Congelar comparabilidade e data de início; não retrofabricar respostas para alcançar o baseline.

## Validação e implantação

Uma chamada real limitada quando autorizada, bloqueio no orçamento e continuidade de saídas; UI distingue saldo fictício de gasto real. Não contratar plano, cobrar cartão ou aumentar teto implicitamente.

PR/merge/deploy e ativação no orçamento já autorizado; ausência de API não bloqueia baseline nem avaliação sem Jev.

## Encerramento curto

Atualize apenas a linha **G2-08.3** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
