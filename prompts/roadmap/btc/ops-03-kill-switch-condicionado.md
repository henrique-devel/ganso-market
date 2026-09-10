---
id: OPS-03
rfc: RFC-021
depends_on: [OPS-01]
mode: code
---
# OPS-03 — Concluir gatilho e rearme condicionado da RFC021

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar a lógica testada de engate por série e rearme automático condicionado
já autorizado; comparar primeiro código existente para não duplicar o mecanismo.

## Leitura mínima

- `docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md` — D2/D3 e aprovação de 15 ticks.
- `apps/api/src/polymarket/paper/brokerstore.ts` — killSwitchTriggersTick / rearmKillSwitch.
- `apps/api/src/polymarket/paper/runner.ts` — settlementTick e agendamento.
- `apps/api/test/polymarket/paper/brokerstore.test.ts` — kill switch.
- `migrations/0008_polymarket_paper_broker.sql` — paper_kill_switch / paper_ledger_events.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

O gatilho lê snapshots e deltas e preserva RECORDER_STALE_MS. Rearme automático
somente RECORDER_STALE, ambas frescas por 15 ticks consecutivos, sem stream_silent
aberta; registrar evento e mode:auto. Falha de consulta interrompe consecutividade;
tick atrasado/repetido não conta duas vezes. Reboot não fabrica 15 minutos saudáveis.
Preservar bloqueios manuais, perdas/disputa e endpoint manual. Não pedir novamente
a aprovação D3 existente. Este bloco muda código e testes; não rearma produção,
não altera limiar e não remove eventos antigos.

## Aceite e verificação

- Deltas velhos/snapshots novos e inverso engatam com série correta.
- 14 ticks não rearmam; 15 válidos rearmam uma vez com evento auditável.
- Gap aberto, erro, tick duplicado, feed velho e motivo diferente impedem rearme.
- Reboot/tick atrasado têm regra explícita e testada de consecutividade.
- Executar brokerstore/runner afetados e typecheck API; preservar ledger append-only.

## Fim e handoff

Anotar estado real de D2/D3, sem declarar deploy. Registrar teste e contrato dos
ticks para OPS-04 validar com evidência de produção dentro da autorização vigente.
