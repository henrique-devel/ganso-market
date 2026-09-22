---
id: G2-03.4
macro: G2-03
rfc: RFC-045
section: S4
depends_on: [G2-00.2, G2-03.3]
mode: codigo
requirements: [RF-16]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-03.4 — Retirar stubs e dependências sem consumidor

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S4 da RFC-045](../../docs/rfcs/RFC-045-ganso-2-nucleo-perfis.md#s4), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 4.2 e 9.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- services/market-engine/ e workers/model-worker/
- docker-compose.yml, Makefile e .github/workflows/ci-cd.yml
- apps/api/src/runtime.ts e health consumers, localizar
- docs/runbooks/single-server.md e README.md

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Perfil padrão e cadeia de desenvolvimento usam apenas componentes necessários.

Remover do perfil padrão engine/worker sem função de negócio e seus acoplamentos de build/health. Apagar código e dependências somente quando inventário confirmar ausência de consumidores; preservar histórico Git e contratos reutilizados. Atualizar rotas documentais, scripts e CI para não deixar comandos órfãos. Não apagar migrations ou dados dormentes junto do código.

## Validação e implantação

Referências dos componentes retirados têm destino; aplicação sobe sem eles, auth/ready continuam corretos, checks de toolchain não exigem runtime retirado. Não escrever testes triviais só de nomes de arquivo.

PR/merge/deploy seletivo e parada dos containers aposentados; volumes e histórico preservados.

## Encerramento curto

Atualize apenas a linha **G2-03.4** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
