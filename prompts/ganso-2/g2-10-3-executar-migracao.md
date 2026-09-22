---
id: G2-10.3
macro: G2-10
rfc: RFC-052
section: S3
depends_on: [G2-10.2, G2-05.10, G2-09.4]
mode: operacao-condicional
requirements: [RF-15]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-10.3 — Migrar o ambiente aprovado e verificar o custo final

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S3 da RFC-052](../../docs/rfcs/RFC-052-ganso-2-custo-hospedagem.md#s3), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 11.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Destino autorizado e runbook G2-10.2
- Procedimento de transferência e estados financeiros BTC
- Configuração de writer único e deploy
- Registro de SSH/perímetro do destino validado

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Migração aceita dentro do orçamento, ou rollback aplicado com estado financeiro preservado.

Aplicar cópia inicial, validar, suspender escritas na origem, copiar delta final, reconciliar e cortar. Impedir duas instâncias escrevendo/operando a mesma conta. Manter rollback até critérios do plano; não apagar origem para provar economia. Se destino ou custo ainda não foi autorizado, parar somente essa ação depois de deixar plano pronto.

## Validação e implantação

Nenhuma transação confirmada perdida no corte; saldos/ordens/versões iguais, acesso/health e orçamento real. Encerramento do recurso antigo somente no escopo específico já autorizado e após validação. Registrar evento operacional no experimento.

PR/merge de ajustes e deploy no destino aprovado; acompanhamento curto. Não contornar identidade SSH nem geoblock.

## Encerramento curto

Atualize apenas a linha **G2-10.3** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
