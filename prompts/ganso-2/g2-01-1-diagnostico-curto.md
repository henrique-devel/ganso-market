---
id: G2-01.1
macro: G2-01
rfc: RFC-043
section: S1
depends_on: []
mode: diagnostico
requirements: [RF-10, RF-15]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-01.1 — Diagnosticar capacidade e reinícios atuais

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-043](../../docs/rfcs/RFC-043-ganso-2-contencao-operacional.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 2, 4 e 10.2.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- docs/ops/SERVER_ACCESS.md
- docs/research/ganso-2-infraestrutura-2026-09-22.md: resumo histórico
- docker-compose.yml: limites dos serviços afetados
- apps/api/src/polymarket-paper.ts e apps/api/src/database.ts: localizar falha

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Causa localizada ou hipótese explicitamente limitada; capacidade atual e prioridade da contenção conhecidas.

Consultar o host somente para leitura com timeouts: espaço realmente disponível no volume, crescimento já coletado, reinícios, causa imediata nos logs filtrados e transações ociosas. Não imprimir segredos nem varrer corpus inteiro. Diferenciar falha de heap, OOM, SQL e watchdog sem pressupor uma delas. Registrar diagnóstico resumido e ação seletiva recomendada na linha do estado.

## Validação e implantação

Confirmar identidade SSH e observar métricas atuais. Se uma consulta falhar, registrar limite sem retentar indefinidamente. Não criar benchmark, dump JSON ou relatório separado obrigatório.

Publicar apenas correções documentais necessárias; nenhuma escrita produtiva neste diagnóstico. G2-01.2 é a ação de contenção.

## Encerramento curto

Atualize apenas a linha **G2-01.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
