# Runbook — paper broker Polymarket (RFC-011)

**SIMULAÇÃO — SEM EXECUÇÃO REAL.** Este serviço nunca ganha auth de trading,
wallet, signer ou caminho de ordem real; o guard automatizado é
`apps/api/test/polymarket/paper/scope.test.ts` (roda no `make verify` e no CI),
incluindo padrões EIP-712 que o guard da RFC-010 não cobria.

## O que o serviço faz

- **Features (Parte A)**: janelas 1s/10s/1m por token em
  `paper_feature_windows`, cadência por horizonte (1s só a <1h da resolução),
  anti look-ahead testado; direção de fluxo `UNAVAILABLE` até existir o
  pipeline onchain (CHECK no banco impede degradação silenciosa).
- **Validador + política (Parte B)**: funções puras; nenhuma ordem sem
  `limit_price`; FAK/FOK exigem `worst_price`; default passivo post-only;
  recuo defensivo perto de catalisador.
- **Broker pessimista (Parte C)**: fila passiva atrás de toda a profundidade
  visível; taker contra o book de `accept+250ms`; cancel com latência; GTD
  expira 1 min antes do declarado; degradação determinística de 30% dos fills
  passivos; fees do schedule versionado; resolução trinária (0,5 em negRisk =
  erro de dados, congela o mercado).
- **Ledger + P&L (Parte D)**: `paper_ledger_events` append-only e idempotente
  (replay reconstrói posições bit a bit); marcação a bid executável por
  book-walk do tamanho inteiro ou `STALE_MARK`; kill switch manual + gatilhos
  (staleness do recorder, perda diária, disputa UMA congela o mercado).
- **Calibração**: markouts +1s/+10s/+60s/+300s por fill; amostrador de
  P(fill) (fila hipotética vs volume observado) com labels walk-forward e
  relatório semanal com intervalo de Wilson.

### Endpoints (atrás da auth RFC-002; fora do Nginx como toda a superfície /api)

`GET /polymarket/microstructure/{token}` · `POST/GET/DELETE
/polymarket/paper/orders` · `GET /polymarket/paper/positions` ·
`GET /polymarket/paper/performance` (três colunas: otimista diagnóstica /
base conservadora / estresse) · `POST /polymarket/paper/intents` (integração
RFC-010) · `POST /polymarket/paper/kill-switch(/rearm)`.

### Logs

`service: "polymarket-paper"`; boot exige `execution_mode = "paper"`
(`EXECUTION_MODE_NOT_PAPER` caso contrário). Códigos principais: `PAPER_BOOT`
(com banner e `git_sha_known`), `PAPER_HEARTBEAT(_FAILED)`, `FEATURES_TICK`,
`FEATURES_BACKLOG_SKIPPED`, `PAPER_ORDER_TICK_FAILED`,
`PAPER_RESOLUTION_DATA_ERROR`, `PAPER_MARK_FAILED`,
`PAPER_KILL_SWITCH_ENGAGED`, `PAPER_MARKET_FROZEN_DISPUTE`,
`PAPER_FILL_REPORT_GENERATED`.

## Operação

```sh
make paper-up      # sobe (profile polymarket; requer migrate concluído)
make paper-logs    # acompanha os logs
make paper-down    # encerra
```

O deploy do CD **não troca a imagem dos containers de profile** (lição do
HANDOFF): após merge que altere este serviço, rodar no servidor

```sh
docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-paper
```

## Orçamento

- `mem_limit: 256m` (decisão do proprietário, 2026-08-23), com
  `--max-old-space-size=192`.
- O `model-worker` (stub) cedeu memória: 256 → **96 MiB**. Não 128: o cap do
  `check_compose_policy.py` é estrito (`< 4 GiB`) e com 128 o agregado
  cairia exatamente em 4 GiB. Agregado atual: 4064 MiB.
- Rede: somente `backend` (todo insumo já está no PostgreSQL); nenhuma porta
  publicada; endpoints futuros ficam atrás da auth da RFC-002 e fora do Nginx,
  como os das RFCs 007/010.
