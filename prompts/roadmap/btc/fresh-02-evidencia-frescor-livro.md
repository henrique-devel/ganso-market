---
id: FRESH-02
rfc: RFC-031
depends_on: [OPS-02, DB-04]
mode: code
---
# FRESH-02 — Confirmar livro inalterado com evidência externa

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar representação de frescor que confirme livros quietos sem promover
cache congelado a observação atual.

## Leitura mínima

- `docs/rfcs/RFC-031-frescor-livro-e-validade-ordens.md` — contrato de frescor.
- `apps/api/src/polymarket/bookpipe.ts` — anchorIfDue / insertTopSnapshot.
- `apps/api/src/polymarket/orchestrator.ts` — resyncFromRest / handleWsFrame.
- `apps/api/src/polymarket/quality.ts` — CachedBook / createReconciler.
- `apps/api/src/polymarket/portfolio/store.ts` — BookAsOf / bookAsOf.
- `apps/api/test/polymarket/bookpipe.test.ts` — âncoras e mensagens.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Distinguir horário da última mudança, última mensagem/confirmacão externa e
persistência. Permitir heartbeat de livro idêntico só após WS válido do token ou
REST /book recente com origem/tempo conhecidos; reutilizar cliente/budget/backoff.
Proposta 20 s apenas para tokens elegíveis e dentro da capacidade medida. Consumir
frescor usando prova externa; nunca PONG ou escrita da âncora. Persistir contrato
mínimo se necessário, por migration nova explicitamente proposta. Não mudar
limiar de risco, TTL ordem, kill switch ou simular dados nas lacunas.

## Aceite e verificação

- Cache/PONG regravado permanece stale; REST idêntico confirmado pode ficar fresco.
- REST falho/atrasado preserva lacuna e não avança timestamp de confirmação.
- Fixture as-of exclui confirmações posteriores ao instante da decisão.
- Carga REST é limitada e stop cancela work; idade da mudança continua disponível.
- Rodar bookpipe/orchestrator/quality/store afetados e SQL real se alterar schema.

## Fim e handoff

Registrar esquema e semântica dos timestamps para consumidores; informar taxa de
confirmação e carga observada/estimada. FRESH-03 herda evidência sem reinterpretar
persistência como observação.
