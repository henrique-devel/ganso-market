---
id: G2-06.2
macro: G2-06
rfc: RFC-048
section: S2
depends_on: [G2-05.10, G2-06.1]
mode: codigo
requirements: [RF-06]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-06.2 — Publicar comandos simulados idempotentes

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-048](../../docs/rfcs/RFC-048-ganso-2-mesa-operador.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 6 e 7.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/api/src/server.ts e proteção auth/CSRF existente
- Broker/reservas/risco BTC concluídos
- infra/nginx/nginx.conf: rotas exatas necessárias
- Contratos de comandos/erros BTC

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

API transacional paper segura e com recusas úteis.

Expor prévia de custo/reserva e comandos de enviar, cancelar, solicitar fechamento e pausar entradas. Intenções assinadas pela sessão lógica do owner e chaves de idempotência; o backend revalida preço, frescor e risco no aceite. Permitir somente rotas paper no perímetro atual, sem ampliar origem/rede.

## Validação e implantação

Duplo clique/retry não duplica ordem; CSRF/auth recusam; payload inválido, saldo insuficiente e corrida de fechamento mantêm contratos. Prévia não garante fill nem substitui revalidação.

PR/merge/deploy com controles de ativação e cliente ainda a conectar; alteração de rota autenticada necessária ao PRD está no escopo.

## Encerramento curto

Atualize apenas a linha **G2-06.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
