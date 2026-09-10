---
id: BTC-02
rfc: RFC-039
depends_on: [BTC-01]
mode: code
---

# BTC-02 — Benchmark Binance com disponibilidade temporal

Implemente coleta/adaptação e seleção as-of do benchmark, sem ativar serviço.
Siga `00-protocolo.md`; consulte o contrato entregue por `BTC-01` no estado.

## Contexto mínimo

- `docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md`: decisões 2–3.
- `apps/api/src/polymarket/rtds.ts`: frames, `source_ts`, `received_at`.
- `apps/api/src/polymarket/paper/fastpolicy.ts`: `FastRtdsInputs`.
- `apps/api/src/polymarket/paper/fastbacktest.ts`: `s0Of`, `stAtOrBefore`.
- `apps/api/test/polymarket/rtds.test.ts`: fixtures de ingestão.

## Escopo fechado

1. Registre abertura e preço corrente Binance BTC/USDT do contrato validado.
   Defina adapter/fonte verificável; TWAP permanece feature com origem própria.
2. Preserve evento, recebimento, intervalo, origem e hash; timestamps ausentes
   impedem evidência operacional. Não substitua fonte silenciosamente.
3. Se persistência exigir DDL, reserve migration nova; não aplique em servidor.
4. Selecione somente informação conhecida até o cutoff. Candle final baixado
   depois não prova disponibilidade anterior; backfill recebe classe retrospectiva.
5. Separe fechamento final/rótulo de features e mantenha 0.1.0 congelada.

## Verificação necessária

- Evento antigo recebido tarde nunca altera decisão passada.
- Abertura conhecida durante candle pode entrar; fechamento futuro não entra.
- Fonte errada, atraso, gap ou regra desconhecida produzem motivo explícito.
- Teste disponibilidade temporal e integração do adapter usando fixtures.

## Entrega

- Adapter/contrato persistido, testes e procedência documentada.
- Estado com leitura mínima dos símbolos novos para `BTC-03`/`REPLAY-01`.
- Liste limites do dataset histórico sem falsificar `received_at`.

## Limite do bloco

Sem alteração de policy global, reconstrução fictícia de histórico ou deploy.
Se houver mais de um feed plausível, implemente seleção explícita por contrato;
não trate Binance, Chainlink e TWAP como valores intercambiáveis.
