# DATA-01 — Inventário de capacidade e consumidores

**12/09/2026 UTC; inventário observado em produção, somente leitura.** Base interna
e `origin/main`: `e74c246a2a4298f53cf58f5a9eb69135c332c702`; branch isolada
`codex/data-01-inventory`. Entrega documental da RFC-041, sem aplicar proteção,
exportação, poda, índices, tuning ou política nova. Preservados paper/caps/perímetro
e infraestrutura existente; custo externo adicional zero.

## Evidência e orçamento da coleta

- [Coletor executado](data01-observe.py), [JSON sanitizado](data01-observation.json).
  O JSON contém observação original, `supplement.source_python`/`result` com o
  complemento exato executado e `derived`, explicitamente calculado localmente.
- Janela principal **04:36:23.789646–04:37:09.779648 UTC**. Catálogo de 79 tabelas,
  200 índices, 11 FKs, 28 triggers e schema foundation 1–22. Duas capturas de
  estatísticas, separadas por aproximadamente 39,31 s; espera passiva de 30 s.
- 24 consultas principais: 23 concluíram; endpoint ASC de `book_deltas` cancelado
  pelo timeout de 2 s, sem retry. Complemento às **04:39:56–04:39:57 UTC**: três
  consultas concluíram. Tempos externos incluem `docker exec` e conexão, não são
  latências SQL isoladas; máximo principal 2,400 s, no timeout.
- Todas as conexões com `default_transaction_read_only=on`, statement 2 s,
  lock 500 ms, paralelismo por gather 0, `application_name=data01-observer`.
  Sem COUNT integral grande, ANALYZE, EXPLAIN ANALYZE, DELETE, VACUUM, prune,
  carga, mudança de configuração ou arquivos remotos. COUNT do complemento opera
  apenas sobre subconsulta com LIMIT 200 em orders. Produção não foi fixture.
- SSH usa identidade existente e `StrictHostKeyChecking=yes`, conforme
  [registro reconciliado](../../ops/SERVER_ACCESS.md). Comando principal real:

```sh
ssh -T -i /Users/kovi/.ssh/id_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o ConnectTimeout=10 root@178.105.65.251 \
  'python3 -' < /private/tmp/ganso-data-01/docs/test-results/btc/data01-observe.py \
  > /private/tmp/ganso-data-01/docs/test-results/btc/data01-observation.json
```

O complemento foi executado pelo mesmo SSH, com entrada
`/private/tmp/data01-supplement.py` e saída `/private/tmp/data01-supplement.json`;
ambos foram incorporados sob `supplement`, sem substituir a observação original.
Todas as consultas estão registradas em `queries`, inclusive a falha. Sua execução
é evidência de inspeção; não é ensaio de capacidade nem recomendação de recoleta.

## Capacidade física, estimativas e pressão

| Medida | Valor observado / interpretação |
| --- | --- |
| Banco no fim | `pg_database_size` 99.039.819.455 B = 92,238 GiB; inclui outros objetos além das tabelas públicas |
| Tabelas públicas | `pg_total_relation_size` somado: 99.027.017.728 B = **92,226 GiB** |
| Componentes | Heap principal 45,346 GiB; `pg_table_size` 46,941 GiB; índices 45,286 GiB; TOAST total 1,581 GiB, **já incluído** em table/total |
| Estimativa viva | **67,991 GiB** pela fórmula atual de `measureTableSizes`; diferença físico−estimado 24,235 GiB não é espaço recuperável comprovado |
| Filesystem | Total 300,167 GiB; disponível final 200.215.982.080 B = **186,466 GiB (62,121%)**; piso 25% = 75,042 GiB; margem até piso 111,424 GiB |
| Variação curta | Banco +114.688 B; filesystem disponível +102.002.688 B. Reuso, retenção e temporários concorrem; nenhuma taxa líquida sustentável foi demonstrada |
| CPU PG | +39.081.617 µs / ~39,507 s ≈ 0,989 CPU; 390/395 períodos com throttling = **98,734%** |
| Memória PG | 1.023,742→1.023,992 MiB no cgroup limitado a 1.024 MiB; eventos max +28.965; oom/oom_kill sem incremento |
| Temporários | +1.704.607.744 B em ~39,214 s (~41,46 MiB/s); contador acumulado de bytes escritos, não ocupação simultânea nem custo atribuível a uma consulta |

`table + indexes = total` confere por tabela. Soma de `pg_relation_size` dos
índices é 45,276 GiB; a diferença de 10.518.528 B para `pg_indexes_size` não foi
atribuída a bloat: métodos/forks e instantes distintos não são equivalentes.
Catálogo mostra todos os 200 índices valid/ready; nenhum índice foi alterado.
Deltas concentram 37,977 GiB de índices contra 27,973 GiB de heap; isso identifica
custo físico, não prova que um índice seja dispensável. Candidatos DB-02/03
continuam sujeitos aos gates registrados em [DB-04](DB-04.md).

O cálculo vivo reproduz [retention.ts](../../../apps/api/src/polymarket/retention.ts):
`liveRows × (heap_width + 28 + (index_key_width + index_count×16)/0,9)
+ toast_live_tup×2048`. Usa `n_live_tup` positivo, senão `reltuples`; sem largura,
aplica os mesmos fallbacks físicos por fração viva, ou físico sem stats. São
estimativas, inclusive índices parciais/expressões, TOAST e estatísticas defasadas.
O estimador supera o físico em OI/holders (0,908 vs 0,786 GiB), gaps (0,050 vs
0,036) e circuit breakers (0,012 vs 0,009), reforçando a incerteza. Não executado
pgstattuple, varredura de páginas ou prova de compactação.

O checkout remoto/API ainda informa `1878bf2`; recorder/paper `dcfd52b`;
portfolio `ffa091e`; estimator/resolution `da6d560`. Demais serviços sem arquivo
de release: image IDs estão no JSON; SHA não inferido. Portanto política auditada
no checkout local não prova, sozinha, configuração efetiva recarregada em cada
serviço. A retenção real é corroborada pelos contadores/auditoria abaixo.
Limites DB-04 (PG 1 CPU/1 GiB, Compose 4.064 MiB e só 32 MiB até teto 4 GiB)
continuam contexto herdado, não autorização para aumentar recursos. Container Up
e validator exit 0 não demonstram folga nem saúde funcional.

## Candidatos: classe, janela, consumidores e crescimento

Valores em GiB (2³⁰ B). `R` é entrada bruta **estimada**, extrapolada dos inserts
em ~39,31 s × custo vivo médio; não mede expansão do arquivo. Confiança do tamanho
físico é alta no instante; confiança de R é baixa pelo intervalo e batching.
`0 amostra` não significa desuso, silêncio diagnosticado ou taxa futura zero.
`H` = extremos do histograma histórico, não MIN/MAX atuais; `P` = timestamps das
linhas com menor/maior PK, não prova ausência de buracos nem monotonicidade temporal.
Datas/horas abaixo são UTC, 2026; o JSON preserva precisão e todos os timestamps.

| Candidato / classe | Físico / vivo estimado | Idade/janela observada | Consumidor/referência a preservar | R GiB/d / confiança |
| --- | ---: | --- | --- | --- |
| `polymarket_book_deltas` — raw L2 | 65.957268 / 46.275321 | H 29/08 01:47–12/09 01:59; mínimo atual indisponível | Replay/features; token+âncora+delta ID | 4.1374; baixa |
| `polymarket_book_snapshots` — book top10 | 10.082558 / 7.821056 | P 06/09 04:21–12/09 04:36 | Features/calibração; token+as-of | 1.8065; baixa |
| `polymarket_book_snapshots_full` — âncoras L2 | 4.570503 / 3.912644 | P 01/09 01:05–12/09 04:36 | Replay/features; cadeia com deltas | 0.3960; baixa |
| `polymarket_trades` — raw execução | 2.950142 / 2.751616 | P 28/08 07:51–12/09 04:36 | Features/fill labels/fees; token+tempo efetivo | 0.0164; baixa |
| `polymarket_series_1m` — agregado | 1.915009 / 1.484859 | H 20/08–11/09 (received_at) | UI/features/backtest; token+bucket; não substitui L2 | 0.0114; baixa |
| `fundamental_estimates` — derivado/modelo | 1.408707 / 1.289820 | H 20/08–12/09 | Calibração/gates; model_id+labels+observações | 0.0113; baixa |
| `portfolio_decisions` — decisão econômica | 1.222725 / 0.974616 | H 05/09–12/09 | Orders/entries/saídas/gates; IDs+versões | 0.6731; baixa |
| `paper_feature_windows` — derivado | 1.053436 / 0.840506 | H window_start 08/09 21:08–12/09 03:02 | Paper/calibração; token+janela+raw | 0.0983; baixa |
| `portfolio_panel_snapshots` — derivado/UI | 0.974739 / 0.676610 | H 09/09 19:31–12/09 02:49 | Painel; decision_id FK SET NULL | 0.4707; baixa |
| `polymarket_oi_holders` — raw amostrado | 0.786301 / 0.907556 | H 26/08–11/09 | Resolução; condition/token+received | 0 amostra; baixa |
| `polymarket_rtds_prices` — raw preço | 0.588631 / 0.553985 | P 20/08 01:13–12/09 03:37 | Features as-of; feed/symbol+source/received | 0 amostra; baixa |
| `resolution_scores` — derivado versionado | 0.406044 / 0.278336 | H 30/08–11/09 | Resolução/portfolio; score version+evidência | 0.4957; baixa |
| `paper_fill_samples` — dataset calibração | 0.177956 / 0.092243 | H 28/08–11/09 | Labels de fill; book/trades+sample_id | 0 amostra; baixa |
| `paper_ledger_events` — econômico protegido | 0.024277 / 0.018768 | P 26/08 05:28–12/09 04:36 | Reconciliação/replay/gates; order/token+idempotency | 0 amostra; baixa |
| `paper_orders` — econômico protegido | 0.001175 / 0.000099 | amostra completa133:28/08–11/09 | Ledger/entries/saídas; order/decision/strategy | 0 amostra; baixa |
| `domain_events`, `event_quarantine`, `bonding_curve_state`, `pumpswap_pool_state` — Solana residual | 0,0001068125 físico conjunto; fallback físico, não bytes de dados vivos | EXISTS false em04:39; idade de linhas não aplicável | Nenhum consumidor encontrado fora migrations0003; preservar schema | 0 inserts amostra; existência vazia confirmada só no instante |

Não existem tabelas `market_context` ou `fundamental_predictions` neste catálogo;
busca por esses identificadores no código também não encontrou consumidor.
Isso não autoriza classificar outro objeto por similaridade de nome.
As quatro tabelas Solana foram verificadas por `EXISTS(... LIMIT 1)` e não tinham
linhas naquele snapshot, além de contadores zerados. `domain_events` soma 56 KiB
físicos; event_quarantine 24 KiB e as duas projeções 16 KiB cada: ganho de dados residuais não demonstrado.
O primeiro coletor pulou endpoint de domain_events porque sua allowlist tinha
`event_id`, enquanto a PK real é `domain_event_id`; o complemento EXISTS resolve
somente existência. Schemas/migrations/código legado permanecem.

| Candidato | Heap / índices / TOAST GiB | Vivas estimadas / dead tuples estimadas |
| --- | --- | --- |
| `polymarket_book_deltas` | 27.9729 / 37.9766 / 0.0000 | 158,409,396 / 18,641,738 |
| `polymarket_book_snapshots` | 8.1102 / 1.9700 / 0.0000 | 7,317,277 / 6,484 |
| `polymarket_book_snapshots_full` | 3.7746 / 0.7566 / 0.0382 | 2,975,018 / 0 |
| `polymarket_trades` | 1.2732 / 1.6766 / 0.0000 | 2,587,150 / 351,185 |
| `polymarket_series_1m` | 0.9769 / 0.9378 / 0.0000 | 4,594,684 / 174,098 |
| `fundamental_estimates` | 0.7743 / 0.6342 / 0.0000 | 1,254,090 / 0 |
| `portfolio_decisions` | 0.3308 / 0.2491 / 0.6427 | 159,130 / 0 |
| `paper_feature_windows` | 0.7391 / 0.3142 / 0.0000 | 1,108,252 / 0 |
| `portfolio_panel_snapshots` | 0.5281 / 0.1797 / 0.2668 | 315,935 / 0 |
| `polymarket_oi_holders` | 0.0928 / 0.0611 / 0.6323 | 245,989 / 0 |
| `polymarket_rtds_prices` | 0.2961 / 0.2924 / 0.0000 | 3,103,498 / 0 |
| `resolution_scores` | 0.3417 / 0.0642 / 0.0000 | 227,887 / 0 |
| `paper_fill_samples` | 0.0525 / 0.1254 / 0.0000 | 260,189 / 34,491 |

As três maiores relações representam ~87,4% do físico público. Histograma de
deltas foi autoanalisado 01:59:25 e já registra ~15,95 milhões de modificações
desde então; a menor PK não foi obtida no orçamento. Não inferir sua janela real
a partir do histograma ou do corte de quota. Full snapshots e snapshots têm
extremos por PK observados; isso não prova replay completo entre eles.

Para quatro tabelas há também comparação passiva com `b.tables` do
[JSON DB-04](db04-observation.json), cerca de 2.165,804 s até DATA-01 `b.tables`:
deltas +312.646 inserts / +3.339.625 deletes (3,643 GiB/d brutos), snapshots
+33.411 inserts (1,425 GiB/d), trades +1.382 (0,0586 GiB/d), RTDS +0.
Counters monotônicos nos recortes e `pg_stat_database.stats_reset` nulo em ambos
(nenhum reset global informado); reset individual não foi auditado. A comparação
é mais longa, ainda não é uma média diária. RTDS tem última PK recebida às
03:37:17, cerca de 59 minutos antes da coleta; causa/frescor não investigados aqui.

Consumidores conferidos por símbolos, além do mapeamento da tabela:

- L2: `polymarket/replay.ts:80–143` e `fundamental/features.ts:140–203` usam
  snapshot full anterior + deltas do mesmo token, ordenados por ID/tempo.
  `retention.ts:964–980` exige bucket 1m para deltas; não garante âncora ou L2
  completo. Nenhuma regeneração equivalente foi testada nesta sessão.
- Snapshots/trades/série: `paper/featurestore.ts:30–67`; trades também
  `paper/calibration.ts:395` e `portfolio/gatestore.ts:330–339`; série também
  `polymarket/readapi.ts:1045`, `resolution/store.ts:610`, `fast-backtest-cli.ts:212`.
- RTDS: `fundamental/features.ts:420–442` requer feed/símbolo e as-of duplo
  source/received; agregado 1m não recupera necessariamente o instante observável.
- OI: `resolution/store.ts:491`; scores: `resolution/store.ts:916` e consumidores
  de resolução/portfolio. Panel: `portfolio/runner.ts:995`, `portfolio/api.ts:268–351`.
  Fill samples: `paper/calibration.ts:331–481`. Esses objetos têm consumidores;
  são candidatos a recortes condicionados, não tabelas descartáveis por inteiro.

## Primeiro risco: quota e perda de cobertura antes de falta de SSD

A política local aplica gatilho **90%**, alvo **80%**, quota prevalecendo sobre
TTL. Já acima do gatilho vivo estimado: snapshots 7,821/7,2 GiB; full snapshots
3,913/3,6; trades 2,752/2,7; OI 0,908/0,9; feature windows 0,841/0,54;
decisions 0,975/0,81; panel 0,677/0,477; fill samples 0,0922/0,09. Logo janela
restante até pressão nesses gatilhos é **zero**, sem prometer quando o job vai
processá-los. Deltas ficam 0,525 GiB abaixo de 46,8: ~3,46 h ao ritmo longo
sem poda, hipótese contrariada pela poda concorrente observada.

Na amostra, deltas receberam 6.444 inserts e 50.000 deletes. O inventário não
disparou esses deletes. Há 167 registros no recorte LIMIT 200 do retention_log,
de 23/08 a 12/09. Exemplos de lacunas históricas reais:

| Objeto | Ação registrada | Corte UTC | Linhas excluídas registradas |
| --- | --- | --- | ---: |
| deltas | quota, 11/09 07:42 | 03/09 02:48:58.696 | 26.703.049 |
| snapshots | quota, 11/09 10:39 | 06/09 04:21:09.952 | 946.229 |
| trades | quota, 11/09 07:45 | 28/08 07:51:57.710 | 347.358 |
| feature windows | quota, 11/09 07:45 | 08/09 21:08:02 | 369.244 |
| portfolio decisions | quota, 11/09 07:46 | 05/09 06:30:59.797 | 50.131 |
| panel snapshots | quota, 11/09 07:46 | 09/09 19:31:52.526 | 146.321 |

Log registra ações agregadas, não identidade de todas as linhas, completude do
corte ou restaurabilidade. O corte de deltas não significa que todas as linhas
anteriores sumiram (o guard de cobertura pode retê-las). A cauda menor observada
em snapshots tem ~6 dias contra TTL nominal 90; full tem ~11,15 dias contra30;
trades ~14,86 contra365; features no histograma ~3,25 dias contra30. Nenhuma
reconstrução histórica foi feita ou apresentada como observação preservada.

**Ledger/orders:** `retention.ts:245–259` marca ambos `protected:false`, TTL nulo,
quota 0,25/0,035 GiB. Ledger vivo ~0,018768 GiB (gatilho0,225; margem0,206232);
orders ~0,000098873 GiB (gatilho0,0315; margem0,031401). Zero inserts no curto
intervalo: **prazo em dias indeterminado**, não infinito. O endpoint do ledger
cobre 26/08 05:28 até 12/09 04:36; orders retornaram 133 linhas dentro do cap200,
26 filled/107 canceled, criadas entre 28/08 e 11/09. Não havia open nesse snapshot;
isso não protege ordens futuras. O seletor genérico de quota não filtra status.

Catálogo confirma `paper_ledger_events_guard_trg` e
`strategy_decisions_guard_trg` habilitados (`O`); migrations 0008/0020 contêm
funções que recusam UPDATE/DELETE. Não testado DELETE para provar o guard.
Não há trigger equivalente em orders nem FK ledger→orders. Nenhum registro de
poda ledger/orders apareceu nas 167 ações retornadas; não afirmar perda consumada
nessas duas tabelas. A tentativa de quota no ledger conflita com sua imutabilidade
e pode falhar; remover o guard para fazê-la passar seria perda de proteção.

## Projeções condicionais de 7 / 30 / 90 dias

Soma R da amostra: **8,116813 GiB/d** de entradas compactas estimadas nas tabelas,
sem subtrair deletes, sem cobrar updates/WAL/temp/log/build/export. Estimativa não
é forecast físico. Cenário de sensibilidade: se cada byte compacto adicional
consumisse um byte livre novo, sem reuso/liberação e à mesma taxa:

| Horizonte | Entradas adicionais GiB | Estoque compacto sem expiração GiB | Livre hipotético GiB |
| --- | ---: | ---: | ---: |
| 7 dias | 56,818 | 124,808 | 129,648 |
| 30 dias | 243,504 | 311,495 | piso e capacidade já ultrapassados |
| 90 dias | 730,513 | 798,504 | piso e capacidade já ultrapassados |

Neste cenário o piso25% seria cruzado em **13,73 dias**, e livre zero em22,97.
Não são datas prometidas: taxas curtas variam por lote, DELETE não encolhe todos
os arquivos, páginas podem ser reutilizadas e custos omitidos podem antecipar o
limite. No cenário em que ingestão/expiração e reuso se equilibrassem, o estoque
poderia estabilizar, mas as duas capturas não o demonstram. Não extrapolar o ganho
momentâneo de espaço livre como capacidade infinita. Primeiros riscos **já
presentes** são pressão CPU/memória e cobertura sob quota; não faltam só13,73 dias
para um primeiro risco. Nenhuma reserva para export/build foi alocada.

## Arquivos, logs, imagens e rollback

Inventário finito: mounts/IDs dos 11 containers existentes do projeto (10 rodando,
migrator encerrado), metadados de imagens do host, logs desses containers, raízes
explicitadas no JSON. Não houve busca global de conteúdo nem leitura de secrets.

| Candidato/artefato | Medida / idade | Consumidor e preservação | GiB/d / confiança |
| --- | --- | --- | --- |
| Volume `ganso-market_postgres_data` | Mount PG em `/var/lib/postgresql`; relações acima; filesystem compartilhado | Banco, ledger, replay; nunca tratar volume como candidato genérico | Taxa física não estabelecida; R acima não é taxa do volume |
| Logs json-file dos11 containers | 28,629 MiB lógicos; nomes exatos/mtime no JSON; todos10m×3 | Diagnóstico/recibos; rotação configurada, sem remoção manual | Não medida; limite nominal agregado330 MiB, não previsão |
| Journal do host | `749.8M` conforme journalctl, sem converter precisão da ferramenta | Evidência operacional; não podado | Não medida; retenção efetiva não auditada |
| 228 imagens por ID | Soma lógica40,727 GiB; 218 sem referência dos containers do projeto, soma lógica38,762 GiB | Proteger10 IDs usados e reconciliar rollback antes de qualquer remoção | Não medida; camadas compartilhadas impedem tratar soma como recuperável |
| Cinco backups de código `.deploy/backups` | 45.002.752 B alocados; nomes09/09 e12/09, releases no JSON | Rollback; política atual guarda5 (`deploy/remote-deploy.sh:68`); preservar5 | Não medida; não são backup do banco |
| `.deploy/incoming` | Diretório presente, lista vazia | Recepção do deploy | Nenhum candidato observado |
| `/var/lib/ganso/shadow-replay` | 10 JSONs,71.052 B lógicos/81.920 B alocados;09–12/09 | UI/latest A/B e evidência; preservar resultados. Job prevê30 datados por modo | Não medida; resultados pequenos não são export L2 restaurável |
| `/var/lib/ganso/recorder-watchdog` | 35 entradas,33.241 B lógicos/139.264 B alocados; eventos recentes | Watchdog/diagnóstico; estado e lock não são lixo | Não medida; conteúdo não analisado, nenhuma saúde inferida |
| exports/backups/artifacts/logs na raiz do checkout; dois paths históricos Solana | Seis caminhos inexistentes na consulta; nomes completos no JSON | Não há artefato a remover nesses locais | Não aplicável; não prova ausência de backup/export em todo host |

Três candidatos concretos à **revisão de referências**, por ID completo (não
aprovados para remoção): `sha256:6d7a513406111b0ff7bcdee4ab21283a076cc231867ba86449e2a837ae195b01`
(19/08;76.986.168 B), `sha256:43705ea2b7c6a87d1c01d77ee4e6e257a47246a185d8f8ae11c7bc648f98c420`
(26/08;243.609.836 B), `sha256:47507f0d493f52ffb5a454e97023504aa64ef4338fbf6ffd9ff9b1cb4c7a7aa4`
(27/08;62.581.094 B). Não referenciados pelos containers do projeto no snapshot;
referências de outros projetos e equivalência com rollback **não verificadas**.
Não somar tamanho lógico como ganho físico nem usar prune global. Os cinco backups
guardam releases42210f9/e4a1b32/3ba2663/dcfd52b/a6c5303; não foram restaurados.
O JSON permite identificar cada caminho/ID de uma proposta futura limitada.

## Fecho de preservação para DATA-02

As 11 FKs não expressam a cadeia econômica. O catálogo inclui modelos↔gate reports,
estimates→models, graph→edges, membership→events, scores→score versions e
panel→decision com **ON DELETE SET NULL**; três FKs restantes são de autenticação.
Não há FK ledger→orders, orders→decisions ou raw→dataset. Preservar também:

1. **Paper:** `paper_ledger_events`, `paper_orders`, `paper_positions`,
   `paper_kill_switch`, fills/marks/resolutions e idempotency keys; `order_id`,
   `token_id`, `condition_id`, conta/estratégia e payloads da origem econômica.
   `paper/ledger.ts:267–273`/`performance.ts:104–106` usam ledger completo;
   `brokerstore.ts:1031–1061,1164–1175` reconstrói posição e override pelo evento.
2. **Entrada/saída:** `portfolio_position_entries.paper_order_id/decision_id`,
   `paper_orders.decision_id`, `portfolio_decisions` e versões de config/factor map.
   `portfolio/store.ts:600–617` faz JOIN lógico; `exitstore.ts:263–310` depende da
   proveniência. Priorizar posições abertas e todo seu fecho, sem presumir que
   decisão antiga ou fechada seja irrelevante para auditoria/calibração.
3. **Calibração/modelos:** `paper_markouts.fill_key`↔ledger.idempotency_key,
   orders/token e `paper_fill_samples`, reports e feature windows;
   `fundamental_models`, `fundamental_estimates`, `fundamental_labels`,
   `fundamental_model_events`, gate/calibration reports e observações referidas.
   `paper/calibration.ts:185–191`, `fundamental/calibration.ts:74–95` e
   `portfolio/gatestore.ts:77–89` evidenciam vínculos. Modelo/relatório com janela,
   SHA, seed e versão não preserva sozinho seu dataset de treino/avaliação.
4. **Metadados/resolução:** mercados/tokens/eventos/membership, rule/param/metadata
   versions, `polymarket_resolution_input_changes`, eventos e timelines UMA/onchain,
   `resolution_score_versions`, labels/resoluções e timestamps de conhecimento
   público/source/received. Guardar gaps, universe/retention logs, graph e relatórios
   usados em gates; estado atual não substitui versão histórica.
5. **Portfolio/fast:** config/factor map versions, gate measurements/reports,
   g2 clocks/events, state/events, exposições, circuit breakers e entries;
   `fast_config_versions`, `strategy_decisions`, `fast_wallet_state`, incluindo
   versão **e hash**, ordens por estratégia e estado da subcarteira. Fast config e
   wallet não constam RETENTION_TABLES; ausência de quota não significa dispensável.
6. **Raw/datasets:** preservar âncoras L2 + deltas, trades/RTDS e versões necessárias
   por token/condição/feed/símbolo e intervalo exato, inclusive margem anterior ao
   início do replay. Não foi encontrado pin transacional de dataset nesta base.
   Preservar fontes até comprovar regeneração equivalente de cada derivado.
7. **0xsonda:** consulta por PK `polymarket_markets.condition_id='0xsonda'` retornou
   vazio. Não generalizar para toda coluna/tabela histórica. Nenhuma regra central
   de exclusão foi encontrada no runtime consultado; registrar para classificação
   auditável futura. Nenhuma linha/trigger foi removida nem contagem sintética usada.

## Decisões pendentes e encerramento

| Opção concreta para revisão posterior | Impacto/custo | Recomendação deste inventário |
| --- | --- | --- |
| Proteger fecho econômico e datasets antes de qualquer nova poda | Evita perda de evidência; pode elevar ocupação/alertas; custo externo0, horizonte a dimensionar | Prioridade para DATA-02; decidir horizonte/pins exatos, sem implementar aqui |
| Revisar somente IDs antigos de imagem contra containers e5 rollbacks | Pode liberar camadas exclusivas; ganho ainda desconhecido; custo externo0 | Oportunidade secundária, sem remover rollback nem usar prune global |
| Demonstrar regeneração de recorte derivado (panel/features), com fonte preservada | Reduz duplicação apenas se equivalência demonstrada; exige capacidade temporária limitada | Depois das proteções; não presumir regenerável pelo nome |
| Compactar/reindexar grandes relações | Potencial físico não medido, requer espaço temporário/I/O e plano operacional | Não priorizar sob pressão atual; manter pendente, sem executar |

Não há decisão crítica nova necessária para concluir este inventário. Não foram
executados/reencaminhados os ensaios de escrita/WAL DB-03 rejeitados pela revisão
automática. Gate DB-02, escrita DB-03, Q4/DB-03B e headroom de DB-04 permanecem.
Não aumentar orçamento, contratar serviço, promover live/signer ou ativar poda.

Verificações locais: sintaxe AST dos dois coletores; parse JSON, reconciliação
total=table+indexes, recomputação da fórmula viva e projeções; revisão independente
de consumidores e números; diff/secret scan. Sem suíte runtime ou banco descartável
necessários para este diff documental. Checks/merge e classificação RFC-020 são
registrados no PR; deploy deve ser pulado por somente texto.

O estado e os quatro artefatos locais DB-01/BTC-04 foram preservados por hashes;
no estado só DATA-01 muda. Não foi incorporado trabalho alheio ao PR nem operado
o Git externo antigo. Recibo em [DATA-01](../../roadmap/receipts/DATA-01.md).
**DATA-02 pode começar** com este inventário e suas lacunas; não há autorização
de limpeza implícita e não se iniciou outro bloco.
