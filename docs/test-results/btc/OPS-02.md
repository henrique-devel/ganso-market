# OPS-02 — silêncio CLOB observável e recuperação limitada

Fecho UTC: **2026-09-11T05:55:56Z**. Estado: **code-verified**.
Base `c528d5b0d74cc5cf8894ee953dd335df5f1e1b03` + patch local ainda não commitado.
Dependência: [OPS-01](../../roadmap/receipts/OPS-01.md), mapa local de D1 ausente.
Arquivos e evidências preexistentes de OPS-01 preservados. Produção não consultada.

## Contrato entregue

- `clobsilence.ts` concentra o detector e o journal; `orchestrator.ts` integra a
  observação, o timer de 1 s e o cliente REST existente; `dualws.ts` recupera sockets;
  `quality.ts` persiste cada episódio por UUID. Quatro arquivos de lógica e uma migration.
- Apenas `book`/`price_change` válidos de tokens inscritos renovam a recepção WS.
  PING/PONG, ACK, JSON inválido, trade, tick-size, REST e cache não renovam esse relógio.
  A observação ocorre antes de esperar o banco e inclui duplicatas recebidas;
  apenas a primeira cópia incrementa os contadores de deltas.
- Silêncio global com universo e conexão aberta abre `clob_ws/stream_silent`, sem
  token, desde a última observação (ou início da assinatura). `DEFAULT_STREAM_SILENCE_MS`
  é 120 s; `GANSO_CLOB_SILENCE_MS` pode sobrescrever, com piso de 30 s.
- Por token, somente os cinco mais ativos nos 15 min anteriores ao onset são elegíveis.
  A seleção fica congelada; tokens só com snapshots não entram. Contadores usam buckets
  de 1 s no padrão, adaptativos para N maior, até 2.048 por token. Há 60 s de margem
  para atraso do detector; uma janela histórica incompleta não promove um token antigo.
- Abertura pede resubscribe. Silêncio continuado pede reconexão dos dois sockets em
  2N, 4N e 8N desde a última observação; máximo três por episódio, com o backoff de
  transporte preservado. Tentativas ficam em `details_json.attempts`.
- Controle usa o token de referência congelado, duas respostas REST efetivas separadas
  por pelo menos 30 s e timeout de 10 s, compartilhando o throttle de `resyncFromRest`.
  Sem deltas, desempate determinístico entre tokens inscritos permite o controle global.
  `blind` = níveis diferentes; `venue_quiet` = iguais; `unavailable` = falha/invalidez,
  prazo esgotado ou controle interrompido. A classificação nunca suprime a lacuna.
  O controle não chama `seedBook`; compara níveis completos normalizados, sem float,
  ignorando ordem dos níveis, escala decimal e hash/timestamp do envelope.
- Journal de até 64 episódios, uma gravação e um controle em voo. Persistência faz
  oito tentativas com backoff, depois uma sonda por episódio a cada cinco minutos;
  banco recuperado consegue salvar abertura ou fechamento sem novo frame WS.
  Fila cheia emite alarme e recusa novas entradas até liberar espaço.
- Migration [0021](../../../migrations/0021_polymarket_silence_gap_idempotency.sql)
  cria índice único parcial por `episode_id`. UPSERT repetido não duplica nem reabre
  uma lacuna fechada. Shutdown cancela recuperação/HTTP e tenta drenar até cinco
  segundos, incluindo fechamento observado enquanto o INSERT inicial estava pendente.

## Códigos e leitura operacional

| Código | Significado |
|---|---|
| `WS_STREAM_SILENT` | Episódio aberto, com UUID, token/escopo e limiar |
| `WS_SILENCE_CONTROL` | Classificação REST concluída |
| `WS_SILENCE_RECONNECT` | Tentativa de reconexão por silêncio |
| `WS_SILENCE_RECOVERY_EXHAUSTED` | Terceira tentativa consumida; não comprova recuperação |
| `WS_SILENCE_JOURNAL_FULL` | Capacidade pendente esgotada; pode faltar evidência nova |
| `WS_SILENCE_PERSIST_EXHAUSTED` | Oito tentativas falharam; entra em sondagem lenta |
| `WS_SILENCE_SHUTDOWN_UNFLUSHED` | Shutdown terminou com gravações pendentes |
| `WS_SILENCE_RESTORE_FAILED` | Leitura de episódios anteriores falhou; retry com backoff, sem renovar orçamento |
| `WS_SILENCE_RESTORE_OVERFLOW` | Mais episódios que a capacidade; linhas omitidas continuam abertas no banco |

`GAP_PERSIST_FAILED` continua indicando falha de gravação. STATUS acrescenta
`clob_silence.lastBookFrameMs`, `openGaps` e `pendingWrites`; são observações em memória,
não prova de commit. `gap_end` fecha uma vez por frame válido ou saída do universo,
distintos por `details_json.closed_by`. Shutdown não inventa recuperação do feed.

## Verificação executada

Em **2026-09-10T21:34:02Z**, Node v26.4.0 / Vitest 4.1.10:

```sh
GANSO_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:51602/ganso_ops02_test npm run test --workspace @ganso-market/api -- test/polymarket/orchestrator.test.ts test/polymarket/orchestrator-silence.test.ts test/polymarket/dualws.test.ts test/polymarket/quality.test.ts test/polymarket/clobsilence.test.ts test/polymarket/bookpipe.test.ts
npm run check --workspace @ganso-market/api
python3 scripts/scan_secrets.py
git diff --check
```

**127 testes passaram, seis arquivos, zero skipped**, incluindo dois testes reais
de UPSERT no PostgreSQL 18.4: gravação concorrente gera uma linha, replay não reabre,
fechamento antes do primeiro INSERT e episódios distintos são preservados.
Todas as migrations 0001–0021 e a reaplicação de 0021 passaram no banco descartável.
Typecheck, Prettier dos oito arquivos TypeScript alterados e scan de segredos passaram.
As fixtures também cobrem controles REST, top cinco versus ilíquido, callbacks antigos,
limites de reconexão/fila, recuperação após falha prolongada do DB e corridas no shutdown.
O container exclusivo `ganso-ops02-gap-pg`, com dados em tmpfs, foi removido no fecho.

Revisão de integração em **2026-09-12T01:09Z** reproduziu uma lacuna CLOB persistida
que continuava aberta após restart + frame saudável, embora o novo monitor reportasse
zero gaps. Corrigido com leitura limitada dos UUIDs anteriores ao boot, retry de leitura,
fechamento pelo primeiro frame válido do próprio scope (inclusive recebido durante a
leitura), e saída confirmada do universo com motivo distinto. Controles concluídos e
orçamento de reconexões permanecem; controle pendente vira `unavailable` por restart.
Múltiplos UUIDs do mesmo scope são fechados individualmente, sem apagar histórico.
STATUS inclui `restorePending`, `restoreFailures` e `restoreOverflow`.
Validação final: quatro arquivos de testes CLOB/quality/orchestrator, **79 passed e
3 PG skipped** nessa rodada; `quality.test.ts` separadamente no PostgreSQL 18.4 com
migrations reais 0001–0022: **26 passed, zero skipped**, incluindo filtro pre-boot e
fechamento da mesma linha. Typecheck, Prettier e `git diff --check` passaram.

## Limites e handoff para OPS-04

Não houve deploy, alteração no kill switch/RTDS nem observação atual do servidor.
A migration 0021 precisa preceder o recorder novo. Aplicação e soak pertencem a OPS-04,
que ainda depende dos outros blocos OPS; OPS-06 trata supervisão fora do event loop.
O journal é limitado em memória: crash, DB indisponível durante o drain ou fila cheia
podem impedir persistência. Até 64 lacunas já gravadas são retomadas por UUID no boot;
excesso exige reconciliação com evidência e mantém o bloqueio D3 no banco. Episódio
que nunca chegou ao banco ainda pode se perder em crash. Nenhum fechamento é inferido
de restart, conexão aberta ou resposta REST; a restauração presume um recorder ativo.
O detector interno não comprova saúde se o event loop inteiro parar. `venue_quiet`
descreve somente as duas observações REST; não autoriza rearmar o bot ou operar.

Interface externa consultada em 10/09/2026: a documentação oficial distingue os frames
[do market stream e seu heartbeat](https://docs.polymarket.com/market-data/realtime-data)
e apresenta `asset_id`, bids/asks e o endpoint
[`GET /book`](https://docs.polymarket.com/market-data/prices-order-books).
