---
id: OPS-07
rfc: RFC-021
depends_on: [OPS-01]
mode: code
---
# OPS-07 — Persistir fechamento observado pelo sweep

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar escrita estreita e idempotente de closed=true quando observada pelo
sweep, com impacto dos leitores auditado e sem confundir fechamento com resultado.

## Leitura mínima

- `docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md` — D4.
- `apps/api/src/polymarket/samplers.ts` — createUmaStatusPoller / processRows.
- `apps/api/src/polymarket/registry.ts` — upsert e coluna closed.
- `apps/api/src/polymarket/fundamental/labels.ts` — leitores de resolução.
- `migrations/0004_polymarket.sql` — polymarket_markets.
- `apps/api/test/polymarket/samplers.test.ts` — sweep de pendentes.

Abra os símbolos/seções indicados; paths novos são propostos.

## Escopo e limites

Comparar D4 com código existente: se já implementada, verificar regressão sem
reescrever. Buscar leitores da coluna closed com rg e registrar comportamento
relevante no estado. No sweep, atualizar somente condition_id retornado com
closed:true e ainda distinto de true; nunca escrever false nem substituir a linha
inteira. Preservar propriedade do upsert do registry. closed não significa resolved,
vencedor conhecido ou label válida: não criar liquidação/label só por fechar.
Manter evento de resolução e atualização coerentes no fluxo já existente;
falha de persistência precisa ser visível e retomável. Nenhuma migration prevista.
Fora: liquidar posições, rever semântica de labels, deploy e backfill de toda tabela.

## Aceite e verificação

- Linha closed:true atualiza uma vez; repetição não duplica efeito/evento.
- closed:false/ausente não desfaz true nem altera outro mercado.
- Falha de UPDATE é observável; retry converge sem substituir metadados.
- Mercado fechado sem resolução não gera payout, vencedor ou label fictícia.
- Testes samplers e consumidores afetados passam; SQL validado contra schema.

## Fim e handoff

Registrar mapa curto de leitores, teste e situação real da D4. OPS-04 valida
fechamentos observados no servidor sem usar COUNT(closed) como prova de resolução.
