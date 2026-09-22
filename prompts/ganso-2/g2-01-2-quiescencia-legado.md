---
id: G2-01.2
macro: G2-01
rfc: RFC-043
section: S2
depends_on: [G2-00.1, G2-01.1]
mode: operacao
requirements: [RF-15, RF-16]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-01.2 — Conter coleta e quiescer serviços dispensáveis

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-043](../../docs/rfcs/RFC-043-ganso-2-contencao-operacional.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 2, 4 e 10.2.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- docker-compose.yml e configurações dos serviços selecionados
- apps/api/src/polymarket/paper/reservations.ts e financialstore.ts na base reconciliada
- deploy/recorder_watchdog.py e deploy/systemd/: supervisão
- docs/runbooks/recorder-watchdog.md e docs/runbooks/polymarket-paper.md

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Crescimento dispensável interrompido e perfil legado controlado, sem perda de histórico.

Preparar e aplicar parada seletiva reversível dos produtores/estratégias legados dispensáveis. Suspender novas entradas, tratar ordens e reservas e manter gestão das posições que ainda precisem de dados; quando não houver saída executável, congelar com estado pendente explícito. Desabilitar somente timers/supervisores que reativariam os serviços selecionados. Preservar API de consulta, banco, volumes e histórico; registrar os nomes exatos na configuração/runbook de operação.

## Validação e implantação

Verificar que ordens/reservas não foram abandonadas sem estado, que os serviços escolhidos não ressurgem no próximo ciclo do supervisor e que a escrita não essencial foi contida. Checagem curta; não esperar sete dias aqui.

Código/configuração por PR/merge/deploy e ação operacional seletiva estão autorizados. Manter caminho reversível sem rearmar estratégias automaticamente.

## Encerramento curto

Atualize apenas a linha **G2-01.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
