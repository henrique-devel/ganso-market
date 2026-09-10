---
id: BTC-01
rfc: RFC-039
depends_on: []
mode: code
---

# BTC-01 — Normalizar o contrato BTC horário

Implemente somente o adaptador puro de contrato e suas fixtures.
Siga `00-protocolo.md`; registre resultado em `docs/roadmap/BTC_EXECUTION_STATE.md`.

## Contexto mínimo

- `docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md`: decisões 1–2.
- `apps/api/src/polymarket/paper/fastconfig.ts`: `FastUniverseConfig`.
- `apps/api/src/polymarket/fundamental/catalog.ts`: `planMarket`, `openPriceKey`.
- `apps/api/src/fast-backtest-cli.ts`: `loadMarkets` e cálculo de abertura.
- `apps/api/test/polymarket/paper/fastconfig.test.ts`: convenções de fixtures.

## Escopo fechado

1. Proponha módulo de contrato; não suponha que já exista.
2. Normalize ID, tokens Up/Down, início/fim UTC, fonte Binance BTC/USDT,
   intervalo 1h, empate Up, hash/versão da regra e captura dos metadados.
3. Valide regras e metadados; título serve apenas para descobrir candidatos.
   Data sem horário, fonte incompatível e tokens ambíguos recusam com motivo.
4. Preserve contrato normalizado e origem necessários ao benchmark/replay.
5. Mantenha parser e configuração 0.1.0 existentes intactos.

## Verificação necessária

- Teste um horário válido e empate; compare timestamps UTC esperados.
- Teste DST, datas sem instante, tokens invertidos, duração/fonte incompatíveis.
- Entrada idêntica produz o mesmo hash; mudança de regra muda identidade.
- Execute teste novo e testes existentes diretamente afetados.

## Entrega

- Adaptador, fixtures e exemplos dos motivos de recusa.
- Estado com paths/símbolos novos e contrato para `BTC-02`/`EXP-01`.
- Informe testes executados e limitações reais.

## Limite do bloco

Sem worker, rede em teste, backfill, migração aplicada, ordem ou deploy.
Se o payload atual não comprovar a regra, preserve-o como inelegível e
documente o dado faltante; não invente a regra pelo nome do mercado.
