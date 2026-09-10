---
id: OPS-02
rfc: RFC-021
depends_on: [OPS-01]
mode: code
---
# OPS-02 — Tornar o silêncio CLOB observável e recuperável

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Corrigir apenas o defeito comprovado de silêncio CLOB ou sua supervisão, com
lacuna persistida e recuperação limitada; preservar implementação já existente.

## Leitura mínima

- `docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md` — D1.
- `apps/api/src/polymarket/dualws.ts` — createDualMarketSocket / rollSlot.
- `apps/api/src/polymarket/orchestrator.ts` — handleWsFrame / resyncFromRest.
- `apps/api/src/polymarket/quality.ts` — createGapWriter / createFeedHealth.
- `apps/api/test/polymarket/orchestrator.test.ts` — fixtures de conexão e lacunas.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Implementar D1 ainda ausente: relógio do último frame válido, detector global e
tokens ativos, `stream_silent`, controle REST classificado e reconexão com backoff.
PING/PONG e cache não renovam a observação do livro. Respeitar limiares existentes,
budget REST, cancelamento no shutdown e idempotência de abertura/fechamento da lacuna.
Se D1 já funciona, corrigir somente causa reproduzida em OPS-01. Alteração de outra
causa vai para novo bloco registrado, sem refactor de todos os collectors.
Fora: kill switch, RTDS, política de ordem, tuning de banco e deploy.

## Aceite e verificação

- Fixture socket aberto/mudo abre uma lacuna; primeiro frame fecha uma vez.
- REST diferente/igual/falho registra blind/venue_quiet/unavailable.
- Token ativo mudo é distinto de token ilíquido; retries possuem limite/backoff.
- Timer/reconexão encerram no shutdown; fila de persistência não cresce sem limite.
- Rodar testes orchestrator/dualws/quality afetados e typecheck da API.

## Fim e handoff

Registrar contrato de observação, novos reason codes e teste reproduzível no
estado. Entregar patch e evidência; OPS-04 consumirá o resultado operacionalmente.
