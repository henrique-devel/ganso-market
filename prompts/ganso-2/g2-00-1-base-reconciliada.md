---
id: G2-00.1
macro: G2-00
rfc: RFC-042
section: S1
depends_on: []
mode: documentacao
requirements: [RF-16]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-00.1 — Reconciliar a base de desenvolvimento

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-042](../../docs/rfcs/RFC-042-ganso-2-base-e-passivo.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 4 e 10.2.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- AGENTS.md e docs/ops/DEVELOPMENT_AUTHORIZATION.md, emenda Ganso 2.0
- docs/ops/SERVER_ACCESS.md: identidade e checkout do host
- docs/PRD-GANSO-2.0.md, seção 4.1
- Git local, main remoto e versões dos serviços afetados

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Base de implementação identificada e mudanças locais preservadas; diferenças de versão explicadas.

Comparar HEAD, main e mudanças locais sem reset, checkout destrutivo ou stash indiscriminado. Preparar checkout isolado na main atual quando necessário; classificar diferenças em já integradas, trabalho a preservar e delta útil. Atualizar apenas a baseline curta do estado 2.0, incluindo a situação FIN-07/EXEC-05/issue 198. Publicar os documentos deste ciclo que ainda não estejam na main antes de iniciar dependentes, sem misturar alterações alheias.

## Validação e implantação

Conferir que cada mudança local continua acessível e que referências de versão existem. Para esta entrega documental, verificar links/diff e checks exigidos, sem executar suíte financeira sem motivo.

Publicar documentação por PR/merge; respeitar dispensa de deploy de texto. Não atualizar containers só para uniformizar SHAs.

## Encerramento curto

Atualize apenas a linha **G2-00.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
