---
id: G2-10.2
macro: G2-10
rfc: RFC-052
section: S2
depends_on: [G2-10.1]
mode: codigo-condicional
requirements: [RF-15]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-10.2 — Preparar instalação, corte e rollback do destino

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-052](../../docs/rfcs/RFC-052-ganso-2-custo-hospedagem.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 11.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Decisão de destino de G2-10.1
- Scripts de deploy existentes e estados financeiros BTC
- Registro de acesso/perímetro atual
- Novo runbook proposto de migração do perfil BTC

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Procedimento executável e reversível; apenas eventual decisão externa restante identificada.

Se migração foi escolhida, preparar configuração mínima, compatibilidade de imagens/arquitetura, transferência direta dos dados, sincronização final e corte com um writer por conta. Definir rollback depois de novas escritas sem perder eventos e prazo de coexistência. Deixar proposta de contratação e custo extraordinário pronta quando ainda não autorizada; não inventar credencial/host.

## Validação e implantação

Ensaio em destino já disponível/autorizado ou ambiente isolado equivalente, declarando limites; transferência e sequência de corte coerentes. Plano contempla saldo/configuração/versões e acesso do operador.

PR/merge/deploy dos scripts necessários no escopo; provisionamento pago/perímetro somente se já houver autorização concreta vigente.

## Encerramento curto

Atualize apenas a linha **G2-10.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
