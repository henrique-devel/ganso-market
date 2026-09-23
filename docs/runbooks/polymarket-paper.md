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

## G2-01.2 — quiescência operacional do legado

O perfil produtivo fica contido por configuração do host, preservada pelo CD.
Esta operação usa o broker existente; não troca imagens nem aplica migrations.
API, PostgreSQL, web, nginx, volumes e histórico permanecem. Os stubs
market-engine/model-worker foram retirados em G2-03.4; a cessão de memória
acima é histórica.
Não executar `down`, `rm`, `prune`, limpeza de dados ou rearm automático.

### Ordem e gate financeiro

1. Confirmar SSH conforme `docs/ops/SERVER_ACCESS.md`, saúde da API, espaço e
   serviços atuais. Consultas têm `statement_timeout=8s` e `lock_timeout=2s`.
2. Pela imagem **já implantada da API**, carregar `loadConfig`,
   `createDatabasePool` (max 1, queryTimeoutMs 8000) e chamar
   `engageKillSwitch(pool, 'G2_01_2_LEGACY_QUIESCENCE', new Date())` de
   `polymarket/paper/brokerstore.js`. Esse caminho serializa bloqueio,
   cancelamentos e ledger; os triggers FIN-05 liberam reservas. Em repetição,
   se o motivo já estiver aplicado e não houver ordens abertas, apenas conferir.
   Nunca substituir por UPDATE isolado de status/reserva. O motivo manual não
   é elegível ao rearm automático de `RECORDER_STALE`.
3. Conferir zero `paper_orders.status='open'`, zero reservas `state='active'`
   e zero reservas terminais com saldo remanescente. Reconciliar cada dono com
   `reconcileReservations` se necessário, sem alterar o ledger. Toda ordem
   cancelada exige `cancel_effective` correspondente; fills parciais permanecem.
4. Conferir posições por `loadFinancialState`/`financialPositionRows` e
   `paper_open_owner_tokens()`, incluindo donos opostos; não inferir ausência
   pelo cache vazio ou pelo saldo agregado. Conferir que todo fill/resolution
   aparece em `paper_attributed_ledger_v1`.
5. **Gate desta parada completa: zero posições abertas.** Se houver posição,
   manter os feeds e a gestão necessários e não executar a parada abaixo.
   Saída só pelo broker, reduce-only, com dado executável e custos. Sem saída
   executável, manter bloqueio e registrar por dono/token em
   `/var/lib/ganso/legacy-quiescence/pending-positions.json`: estado
   `frozen_pending_exit`, quantidade, motivo, watermark do ledger, source/receive
   timestamps e marca stale. Esse é estado operacional, não fill, settlement
   ou P&L realizado. Reconciliar antes de definir quais feeds ainda são necessários.

### Configuração persistente e parada seletiva

Após o gate, instalar como root:root 0644
`/etc/ganso/legacy-quiesced.compose.yml` com este conteúdo:

```yaml
# G2-01.2: contenção reversível; não rearmar estratégias ao retirar o overlay.
services:
  polymarket-recorder:
    restart: "no"
    scale: 0
  polymarket-estimator:
    restart: "no"
    scale: 0
  polymarket-resolution:
    restart: "no"
    scale: 0
  polymarket-paper:
    restart: "no"
    scale: 0
  polymarket-portfolio:
    restart: "no"
    scale: 0
```

Em `/opt/ganso-market/deploy/server.env`, preservar as outras variáveis e
fixar uma única linha (se já houver outro overlay, reconciliar antes):

```dotenv
COMPOSE_FILE=/opt/ganso-market/docker-compose.yml:/etc/ganso/legacy-quiesced.compose.yml
```

Validar `docker compose --env-file deploy/server.env --profile polymarket
config --format json`: somente os cinco serviços acima têm escala zero e
restart `no`. O arquivo externo e `server.env` sobrevivem ao sincronismo do CD.
Todo comando produtivo Compose deve usar esse env-file; um `-f` explícito pode
ignorá-lo. Não usar `--scale` para sobrepor a contenção. A preparação de perfis
novos pertence a G2-03.3.

Antes da parada do recorder, aplicar a inibição de timers do
[runbook do watchdog](recorder-watchdog.md#g2-012--supervisão-durante-a-quiescência).
Nos IDs obtidos por `compose ps --all --quiet` de cada um dos cinco serviços,
conferir labels `com.docker.compose.project=ganso-market` e o serviço exato;
aplicar `docker update --restart=no <IDs>` e `docker stop --time 30 <IDs>`.
Parar primeiro portfolio/paper/estimator/resolution, depois recorder. Não remover
containers. Repetir o gate financeiro após parar os consumidores; se divergir,
manter recorder e resolver a pendência antes de prosseguir.

### Verificação e reversão

Após mais de 35 s (um ciclo antigo do watchdog), conferir serviços ainda
`exited`, restart `no`, timers inativos, kill switch com o motivo manual e API
live/ready saudáveis. Comparar `n_tup_ins/n_tup_upd/n_tup_del` de
`pg_stat_user_tables` em duas fotografias curtas: nenhuma escrita nas tabelas
`polymarket_*`, `paper_*` e `portfolio_*`. Conferir ausência dos cinco writers
em `pg_stat_activity` e ordens/reservas/posições sem pendências ocultas.
Não chamar essa janela curta de soak nem presumir invariância de tamanho físico.

Reversão é deliberada e seletiva: manter o kill switch manual; retirar a linha
`COMPOSE_FILE` **somente se contiver exatamente o par acima**, deixando os
arquivos preservados. Recuperar primeiro apenas os feeds necessários com
`docker compose --env-file deploy/server.env up --no-deps --detach <serviço>`.
Reconciliar ledger/reservas e validar dados antes de iniciar consumidores.
Restaurar a supervisão conforme o outro runbook. Não chamar rearm como parte
do rollback: liberar novas entradas exige uma decisão operacional separada.
