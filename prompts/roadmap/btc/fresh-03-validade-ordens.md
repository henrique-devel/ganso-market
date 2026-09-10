---
id: FRESH-03
rfc: RFC-031
depends_on: [FRESH-02, EXEC-04]
mode: code
---
# FRESH-03 — Limitar ordem ao prazo executável antes do fim

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Adicionar prazo de ordem derivado de end_ts confiável e margem de cancelamento,
consumindo a mecânica de execução/saída entregue por EXEC-04.

## Leitura mínima

- `docs/rfcs/RFC-031-frescor-livro-e-validade-ordens.md` — contrato de validade.
- `apps/api/src/polymarket/paper/policy.ts` — PolicyContext / decideOrderType.
- `apps/api/src/polymarket/paper/bridge.ts` — bridgeTick.
- `apps/api/src/polymarket/paper/brokerstore.ts` — acceptPaperOrder / brokerTick.
- `apps/api/src/polymarket/paper/fastpolicy.ts` — decideFastStrategyOrder.
- `apps/api/test/polymarket/paper/policy.test.ts` — TTL e tipo de ordem.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Clamp de TTL passivo = menor TTL estratégia e tempo até fim menos margem medida;
sem janela viável, recusar nova entrada com motivo explícito. Verificar novamente
na aceitação e antes de permitir fill se metadados/tempo mudarem. Preservar FAK/FOK,
GTD, saldo parcial e idempotência definidos em EXEC-03/04; não reimplementar ledger,
fill ou ciclo de saídas. Definir comportamento de end_ts ausente/não confiável sem
inventar vencimento. Custos/EV continuam revalidados pela RFC034.
Fora: alterar risco máximo, permitir fill após fim ou enviar ordens live.

## Aceite e verificação

- Perto do fim TTL diminui; prazo inviável produz zero ordens novas.
- Atualização de end_ts anterior revoga elegibilidade do prazo antigo.
- Fill parcial seguido de expiração cancela só saldo; evento não duplica.
- Ticks repetidos e relógio na fronteira não geram fill após encerramento.
- Testar policy/bridge/broker afetados com relógio controlado e typecheck API.

## Fim e handoff

Registrar margem, origem da medição e contrato de expiração; apontar testes que
reusam EXEC-04. Não duplicar ownership da mecânica de cancelamento ou declarar
melhora de lucro por redução de GTCs.
