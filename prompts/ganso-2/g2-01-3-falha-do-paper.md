---
id: G2-01.3
macro: G2-01
rfc: RFC-043
section: S3
depends_on: [G2-01.2]
mode: codigo
requirements: [RF-10]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-01.3 — Resolver a causa de reinícios que ainda afeta o produto

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S3 da RFC-043](../../docs/rfcs/RFC-043-ganso-2-contencao-operacional.md#s3), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 2, 4 e 10.2.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/api/src/polymarket-paper.ts: loop/processo apontado pelo diagnóstico
- apps/api/src/polymarket/paper/: somente caminho da falha
- docker-compose.yml: limite/command do serviço afetado
- Teste de regressão correspondente, localizar na main

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Falha corrigida no caminho necessário ou retirada do escopo com motivo verificável.

Se o componente segue necessário, reproduzir a falha encontrada e corrigir sua causa em mudança mínima, com encerramento/erro controlado. Não aumentar memória ou timeout para esconder vazamento. Se foi aposentado e não compartilha a causa com o núcleo, fechar como superseded com justificativa curta, sem desenvolver funcionalidade morta.

## Validação e implantação

Regressão da causa e um restart controlado do serviço necessário após deploy. Ausência de falha em teste curto não comprova soak. Se não houver causa reproduzível, registrar bloqueio específico sem alegar correção.

PR/merge/deploy somente dos serviços afetados; rollback da release se o problema piorar. Aposentadoria verificada pode encerrar sem novo deploy.

## Encerramento curto

Atualize apenas a linha **G2-01.3** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
