# OPS-05 — silêncio RTDS com transporte aberto

Data: 2026-09-11. Base: `c528d5b0d74cc5cf8894ee953dd335df5f1e1b03` + alterações locais deste bloco.
Prova local; produção não consultada. Alterações preexistentes de outros blocos foram preservadas.

## Dependência e decisão de limiar

Conferidos [recibo OPS-01](../../roadmap/receipts/OPS-01.md), sua evidência RTDS e o código de `createRtdsRecorder`/`parseRtdsFrame`.
Confirmado: não havia watchdog por série; ACK reconhecido podia conter zero amostras; gap com falha de INSERT era perdido.
OPS-01 não mediu cadência em produção e explicitamente não aprovou 120 s como limiar RTDS.
Este bloco escolhe **120.000 ms** como padrão conservador inicial, alinhado a D1 e ao cenário de contraprova de OPS-01.
É uma decisão configurável de detecção de chegada, não um SLA medido da venue nem prova de frescor da origem.
OPS-04 deverá observar intervalos reais e validar ou ajustar esse limiar por evidência.

| Configuração do processo e Compose | Padrão | Validação |
| --- | --- | --- |
| `GANSO_RTDS_SILENCE_MS` | `120000` | Inteiro entre `30000` e `3600000`; inválido impede criação do recorder |
| `GANSO_RTDS_MAX_RECONNECTS` | `3` | Inteiro entre `0` e `10`; zero desabilita a escalada de reconnect |

Watchdog a cada 1 s. O relógio começa na assinatura inicial, mesmo que nunca chegue um preço, e não reinicia com socket open/resubscribe.
Um episódio abre ao alcançar N desde a última amostra válida, ou desde a assinatura sem amostra; `gap_start` guarda esse início, `detected_at` a detecção.
Há escopo global e escopo por cada feed/símbolo assinado (`spot`, `twap30`, `twap60`); o universo BTC/ETH/SOL/XRP permanece igual.
Saúde usa símbolo canônico `btc/usd` e reconhece o alias spot `btcusdt`; as linhas raw mantêm o símbolo e timestamps recebidos.

## Persistência e recuperação

Gaps são `source='rtds'`, `cause='stream_silent'`, com `episode_id`, `scope`, `feed`/`symbol` quando aplicável,
`threshold_ms`, `detected_at`, `last_price_frame_ms`, `attempts` e motivo de fechamento em `details_json`.
Não se usa `token_id` de CLOB para representar um símbolo RTDS.
PONG, ACK, frame inválido, preço não positivo ou série não assinada não fecham gap.
Primeiro preço válido recebido fecha o global e somente sua própria série; repetição de preço pode ser observação legítima.
Remoção explícita de assinatura encerra cobertura com `closure_reason='subscription_removed'`, sem declarar retorno do preço.

Uma ação de socket atende todos os episódios simultâneos: um unsubscribe/subscribe ao detectar silêncio,
primeiro reconnect após mais N e tentativas seguintes com espera crescente, limitada a `max(N, 300 s)`.
O orçamento padrão é três reconnects; abertura do transporte, PONG e fluxo parcial não renovam esse orçamento.
O primeiro subscribe de cada socket ocorre uma vez. Callbacks de sockets aposentados são ignorados.
Identidades recentes de amostras com `source_ts` são mantidas por série (até 128) entre reconexões para não contar replay novamente no raw/bucket.
Não há geração de amostras a partir de cache, preenchimento de minutos vazios ou troca de TWAP por spot.

Migration nova [0022](../../../migrations/0022_polymarket_rtds_gap_idempotency.sql) garante unicidade de `episode_id` RTDS;
UPSERT mantém o primeiro fechamento, inclusive sob retry após perda de confirmação.
O journal preserva versões de abertura, tentativas e fechamento, com até 256 entradas; escrita é serializada.
Após oito falhas com backoff de 1–60 s, retém a pendência e faz sondagem a cada 5 min.
Overflow e exaustão ficam explícitos na saúde/log; registros pendentes existentes não são descartados para abrir espaço.
Falhas raw e de buckets também geram evidência no journal. Sucesso de socket não limpa contadores de falha de banco.
O log `RTDS_GAP_PERSISTED` só sai após confirmação do INSERT/UPSERT.
Ao iniciar, o recorder relê até 256 episódios RTDS abertos já persistidos, sem bloquear o detector durante falha dessa consulta.
Mantém início, identidade e tentativas anteriores; somente preço válido da série correspondente pode fechar um episódio restaurado.
Se o preço chegar durante a consulta, preserva a primeira recepção real para esse fechamento.
Scopes que deixaram de ser assinados continuam visíveis e não provocam reconexões destinadas a recuperar séries ausentes.
A parada cancela watchdog, PING e reconnect; drena todas as escritas finais elegíveis do journal com limite de 5 s.

## Campos de saúde para OPS-04

`STATUS.rtds` mantém diagnósticos separados de CLOB e do contador legado `rtds_unknown_frames`:

| Campo | Significado |
| --- | --- |
| `socketOpen`, `lastFrameMs` | Transporte e última mensagem recebida, inclusive controle |
| `thresholdMs`, `lastPriceFrameMs`, `openGaps` | Limiar, chegada válida global e número de lacunas abertas |
| `series[].feed/symbol/subscribedAtMs/lastPriceFrameMs/silent` | Cobertura e chegada por série, sem emprestar timestamp de outro feed |
| `series[].lastSourceTsMs/lastSourceAdvanceMs` | Maior timestamp da origem observado e recepção de seu último avanço |
| `series[].lastValueChangeMs` | Última recepção de representação de preço distinta |
| `series[].lastPersistedReceivedMs`, `lastPricePersistMs` | Recepção da última amostra salva e hora local da confirmação do lote |
| `pricePersistFailures/bucketPersistFailures` e respectivos `last*PersistErrorMs` | Contadores cumulativos e última falha de armazenamento |
| `pendingGapWrites/gapPersistFailures/lastGapPersistErrorMs` | Evidência ainda pendente e falhas cumulativas do journal |
| `gapJournalOverflow/gapRetryExhausted` | Limites atingidos; zero pendências isoladamente não apaga perdas anteriores |
| `recovery.resubscribes/reconnects/exhausted` | Consumo do orçamento de recuperação do episódio |
| `restorePending/restoreFailures/restoreOverflow` | Consulta de episódios de execução anterior pendente, suas falhas e limite de restauração atingido |

Chegada com `source_ts` repetido renova apenas chegada; não renova avanço da origem nem mudança de valor.
Preço válido com timestamp ausente mantém `source_ts=null`. Isso deve ser tratado por frescor/proveniência downstream.

## Fixtures e validação

- `rtds-silence.test.ts`: socket aberto sem preço, controles inválidos, silêncio parcial por feed/símbolo, fechamento único,
  erro simultâneo raw/gap com retorno do DB, relógios distintos, callbacks duplicados/tardios, replay, stop e budget.
- `rtdsgaps.test.ts`: falha e retry preservando início/fim/id, fechamento durante INSERT pendente, budget de retry,
  overflow explícito, parada limitada e concorrência/idempotência em PostgreSQL descartável.
- `orchestrator-silence.test.ts`: configuração RTDS encaminhada e snapshot de saúde separado de CLOB, preservando regressões OPS-02.
- `rtds-restart.test.ts`: retomada de episódios persistidos, chegada válida durante restauração e prevenção de mutação após stop.

Resultados finais de execução registrados no [recibo OPS-05](../../roadmap/receipts/OPS-05.md).

## Fontes e limites

Interfaces de assinatura consultadas em 2026-09-11: [documentação oficial RTDS](https://docs.polymarket.com/market-data/realtime-data)
(PING 5 s, filtros Binance e Chainlink) e [cliente oficial](https://github.com/Polymarket/real-time-data-client/blob/main/src/client.ts)
(`subscribe`/`unsubscribe` com o mesmo conjunto de subscriptions). Nenhum novo tópico ou benchmark foi introduzido.

O journal de pendências é memória até confirmação do banco; encerramento abrupto antes do INSERT pode perder evidência ainda não salva.
Overflow é limitação explícita de capacidade. Nenhuma fixture substitui observação operacional, deploy da migration ou soak.
A restauração presume um recorder ativo para este conjunto de assinaturas; excesso de 256 episódios antigos fica sinalizado para reconciliação operacional.
Próximo consumo: OPS-04 mede frescor real, lacunas e persistência; BTC benchmark usa origem, símbolo e timestamps sem redefinir este detector.
