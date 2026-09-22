---
id: G2-09.4
macro: G2-09
rfc: RFC-051
section: S4
depends_on: [G2-09.3]
mode: validacao
requirements: [RF-10]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-09.4 — Conferir retomada e janela operacional

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S4 da RFC-051](../../docs/rfcs/RFC-051-ganso-2-avaliacao-maturidade.md#s4), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.3, 9.1 e 15.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Métricas operacionais do worker/DB
- Rotina de recuperação BTC e runbook de deploy
- Estado das janelas do experimento
- Critérios operacionais do PRD seção 9.1

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Prontidão operacional aprovada ou observação pendente com data e motivo precisos.

Fazer ensaio limitado de desconexão/restart no ambiente apropriado e consultar histórico de sete dias quando já disponível. Verificar reconciliação, reinícios inesperados e orçamento, sem esperar em loop ou criar automação Codex não solicitada. Se faltarem dias, registrar desde quando observa e data mínima de retorno; código entregue permanece separado do aceite temporal.

## Validação e implantação

Eventos confirmados preservados, reconciliação antes de entradas e ausência de divergência na janela efetivamente disponível. Sete dias incompletos recebem observacao, não aprovado nem falha fictícia.

Publicar correções mínimas por PR/merge/deploy quando necessárias; uma leitura sem mudança não exige PR vazio. Registro só na linha do estado.

## Encerramento curto

Atualize apenas a linha **G2-09.4** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
