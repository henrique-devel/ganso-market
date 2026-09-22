---
id: G2-00.2
macro: G2-00
rfc: RFC-042
section: S2
depends_on: [G2-00.1]
mode: documentacao
requirements: [RF-16]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-00.2 — Dar destino ao código e backlog herdados

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-042](../../docs/rfcs/RFC-042-ganso-2-base-e-passivo.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 4 e 10.2.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- docs/roadmap/BTC_EXECUTION_STATE.md: somente famílias citadas no PRD
- docker-compose.yml e deploy/systemd/: serviços e timers
- services/market-engine/src/http.rs e workers/model-worker/src/ganso_model_worker/server.py
- apps/api/src/polymarket/ e apps/web/src/: localizar consumidores por símbolo

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Nenhuma família de pendência fica sem destino; dependências de remoção explicitadas.

Mapear componentes e blocos antigos para manter, adaptar, corrigir, arquivar ou remover. Identificar consumidores, dados protegidos e alvo 2.0 de cada item. Usar uma tabela compacta no próprio estado, seção Destino do legado; ampliar somente com achados úteis. Não corrigir todo o backlog nem marcar trabalho substituído como implementado.

## Validação e implantação

Para candidatos a remoção, conferir referências de código, Compose, CI, health e timers. Conferir transferência de OPS/DB/DATA/FIN/EXEC/FRESH/BTC/REPLAY/EXP/GATE; pendência real recebe destino e responsável lógico.

PR documental sem recriação de serviços; remoções e quiescência pertencem aos prompts próprios.

## Encerramento curto

Atualize apenas a linha **G2-00.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
