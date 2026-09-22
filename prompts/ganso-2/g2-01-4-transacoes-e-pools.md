---
id: G2-01.4
macro: G2-01
rfc: RFC-043
section: S4
depends_on: [G2-00.1, G2-01.1]
mode: codigo
requirements: [RF-10]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-01.4 — Prevenir transações ociosas e vazamento de conexões

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S4 da RFC-043](../../docs/rfcs/RFC-043-ganso-2-contencao-operacional.md#s4), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 2, 4 e 10.2.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/api/src/database.ts: transações/pools
- Issue 198 e trecho de código ainda relevante na main
- apps/api/src/polymarket/registry.ts ou consumidor identificado pelo diagnóstico
- Testes PostgreSQL do componente que mantém a conexão

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Caminho de transação necessário libera recursos corretamente; causa residual explicitada.

Investigar a origem pendente da transação ociosa e corrigir release/rollback/cancelamento nos caminhos de erro efetivamente usados. Respeitar pools e ordem de locks; não ampliar timeouts globais. Se o produtor original foi desligado, conferir se o helper compartilhado ainda carrega o defeito; não confundir zero sessões na fotografia com prevenção.

## Validação e implantação

Teste PostgreSQL real de erro no meio da transação, cancelamento e liberação da conexão; conferir execução normal. Em produção, uma consulta curta de atividade é suficiente para validar o deploy, sem dossier.

PR/merge/deploy do consumidor afetado, preservando banco. Atualizar issue/estado com resumo se já fizer parte do fluxo GitHub do bloco.

## Encerramento curto

Atualize apenas a linha **G2-01.4** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
