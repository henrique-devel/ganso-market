---
id: G2-03.3
macro: G2-03
rfc: RFC-045
section: S3
depends_on: [G2-03.2, G2-01.2]
mode: codigo
requirements: [RF-01, RF-16]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-03.3 — Preparar perfil BTC, CI e deploy seletivo

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S3 da RFC-045](../../docs/rfcs/RFC-045-ganso-2-nucleo-perfis.md#s3), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 4.2 e 9.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- docker-compose.yml e deploy/deploy_paths.py
- scripts/check_compose_policy.py e check_runtime_memory.py
- .github/workflows/ci-cd.yml e Makefile
- apps/api/src/runtime.ts e server.ts: health/dependências

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Caminho de entrega BTC preparado sem processo de negócio incompleto ativo.

Criar perfil/configuração BTC ainda inativo, entrada de worker e isolamento do legado; não usar stub ativo como serviço pronto. Atualizar classificador de deploy e verificações para os serviços que realmente rodam. Preservar PostgreSQL no deploy, orçamento combinado de recursos e reserva de conexões. Engine Rust deixa de ser dependência de readiness quando não houver consumidor.

## Validação e implantação

Smoke Compose do perfil efetivo, deploy de texto dispensado, mudança de worker atinge worker, banco não é recriado indevidamente. Limites continuam verificáveis; remover cap 4 GiB só com matriz coerente ao PRD e ensaio correspondente.

PR/merge/deploy do perfil desativado e health compatível; não habilitar coleta até G2-04.4.

## Encerramento curto

Atualize apenas a linha **G2-03.3** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
