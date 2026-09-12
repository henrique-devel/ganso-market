# DB-04 — Capacidade PostgreSQL e aplicação condicionada

**RFC-037; plano verificado em 12/09/2026, sem aplicação de índice/tuning ou
aceite integrado.** Base `1878bf2`; observação passiva 04:00:25–04:01:05 UTC,
[relatório e limites](../test-results/btc/DB-04.md). Manter CPX42 existente,
paper, custos, capital, pools, timeouts e perímetro. Este documento não executa
DB-03B, FRESH-01 ou limpeza da RFC-041.

## 1. Decisão de entrada e dependências

| Dependência                | Evidência herdada                                                                                           | Consequência operacional                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| DB-01                      | Baseline local production-verified; quatro planos; pools 28/40; throttling 96,1%; hashes no relatório DB-04 | Evidência local conferida, não incorporada a este PR. Frequência/p95/p99 SQL continuam incompletos.                                             |
| DB-02, PR #157 / `a6c5303` | 100 mil → 1 linha; p95 COMMIT conflitos +173,56% (+1,769 ms), gate ≤10% reprovado                           | Não promover o índice de trades nem aceitar a regressão por ser pequena em ms.                                                                  |
| DB-03, PR #158 / `1878bf2` | RTDS 120 mil → 2–4 linhas; p95 ≤1,42 ms na fixture com índice; sem índice buffers até 4,70×                 | Runtime preservado. Escrita/WAL indisponíveis; não promover índice ou rewrite.                                                                  |
| Q4 / DB-03B                | 31,299 s **ativo**, 68.333 linhas estimadas; received-only/empates pendentes                                | Contrato pode mudar mid/jump breaker. Manter Q3/Q4; opções em [DB-03](../ops/DB-03-asof-plan.md#db-03b-snapshots-em-lote-adiados-por-contrato). |

**Bloqueio herdado:** a revisão automática rejeitou duas vezes o ensaio descartável
DB-03 de 10 mil inserts, mil upserts/deletes e VACUUM, por entendê-lo como DB-04,
mesmo com prova do destino local. A aprovação adicional solicitada não chegou.
Não repetir nesta sessão, nem sob outro nome/destino. O trabalho independente
foi concluído; requisitos concretos para revisão posterior estão na seção 7.

O estado do bloco é `code-verified` **somente para a especificação**. Aplicação,
ensaio com seis abas e soak permanecem pendentes. Nem checks verdes nem uma
janela sem menções de timeout substituem esses aceites.

## 2. Capacidade real e orçamento completo

Host medido: 8 CPUs, 15.608,46 MiB RAM, 13.783,43 MiB disponíveis, swap 0;
SSD livre 200.373.207.040 B / 322.302.373.888 B = 62,17%.
PostgreSQL: 1 CPU / 1.024 MiB, shared memory 145 MiB (inclui shared_buffers
128 MiB e WAL buffers 4 MiB), work_mem 4 MiB, hash multiplier 2, autovacuum
3 × 64 MiB, workers paralelos globais 8 / por gather 2. Todos sem pending_restart.

| Serviço                               |                              Pool máximo |                  Query/statement ms |     Limite MiB / CPU |
| ------------------------------------- | ---------------------------------------: | ----------------------------------: | -------------------: |
| API                                   |                                        4 | 4.000; rota 500–4.000, padrão 2.000 |           384 / 0,75 |
| Recorder (coleta, backfill, retenção) |                        10 compartilhados |                              30.000 |            832 / 0,5 |
| Estimator / resolution / portfolio    |                                   4 cada |                         60.000 cada |       192 / 0,5 cada |
| Paper                                 |                                        2 |                              30.000 |            256 / 0,5 |
| PostgreSQL                            |                           40 no servidor |                          por sessão |            1.024 / 1 |
| Engine                                | conexão por readiness, sem teto agregado |                       connect 1.000 |              512 / 1 |
| Web / nginx                           |                                        0 |                                   — |      128 / 0,25 cada |
| Model / migrate (inativos na captura) |               não reservar job adicional |                                   — | 96 / 0,5; 128 / 0,25 |

Fontes: [Compose](../../docker-compose.yml), [DatabasePoolOverrides e readOnly](../../apps/api/src/database.ts),
entradas dos seis processos. Connect 1 s, idle 30 s; `readOnly` retém uma conexão
e limita **cada statement**, não a soma do request. O pool não oferece override
de work_mem: não inventar variável de ambiente ou ajuste efetivo por config.

Conexões: 40 − 3 superuser − 0 reserved = 37 ordinárias. Pools persistentes
somam 28; teto **operacional** 32 client backends em todo o cluster (inclusive
sondas/admin), deixando 5 ordinárias e 3 de emergência. Alocar os quatro slots
transitórios a observador + build + engine readiness + watchdog; readiness
concorrente pode exceder essa hipótese. Não executar replay/backtest (+2 cada),
models/gates/account (+4 cada), migrate ou builds concorrentes durante a janela.
Não há admission control automático a 32: medir e abortar carga nova se exceder.
Parallel workers não consomem os slots de client backend, mas usam CPU/RAM.
**Limite da reserva:** consulta adicional às04:08:28 UTC confirmou
`ganso_market.rolsuper=true`. O mesmo papel usado pela aplicação pode consumir
as três conexões reservadas; elas não são emergência protegida contra esses pools.
Manter32 como teto operacional conservador; separar papéis seria mudança própria
de permissões, não executada neste plano.

### Dois tetos diferentes, ambos obrigatórios

`check_compose_policy.py` soma **4.064 MiB = 4.261.412.864 B** com ambos profiles;
exige `<4 GiB`, portanto só 32 MiB até a igualdade que já reprova. Dez containers
ativos somam 3.840 MiB / 5,75 CPUs; completo 4.064 MiB / 6,5 CPUs. Isso é soma de
limites, não RSS nem CPU utilizada. Aumentar PG em 128 MiB levaria 4.192 MiB e
reprovaria o gate; não alterar o validador apenas para caber.

Orçamento host conservador: containers completos 4.064 MiB + OS/Docker/agentes
2.048 MiB + reserva operacional livre 2.048 MiB = **8.160 MiB = 8,56 GB**,
abaixo de **13.000.000.000 B** (limite do projeto; unidade decimal explícita).
Inclui a manutenção dentro do cgroup PG; não somar work_mem novamente no host.
Reserva de OS é proposta, a confirmar na janela, não uso medido. Exigir
MemAvailable ≥2 GiB e ausência de swap/OOM; crescimento de uso host não explicado
impede entrada. Não transformar RAM livre do host em RAM disponível ao cgroup.

### Memória PostgreSQL por operação e simultaneidade

Modelo em MiB:

```text
145 + (C + P) × (S × 4 + H × 4 × 2) + A × 64 + M × 64 + B + R
```

Onde C=clientes pesados simultâneos, P=workers de planos (máximo global8),
S/H=nós sort/hash simultâneos por participante, A≤3 autovacuums, M≤1 build manual,
B=memória privada de backends/background e R=cache/temp buffers/outros.
Não multiplicar cada sessão por três ignorando teto global8; manutenção paralela
usa o orçamento por comando, sem multiplicar seus 64 MiB por worker.

| Cenário proposto, não garantia                                      | Conta MiB                          | Resultado                                                                  |
| ------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Pior cenário explícito do ensaio: C32/P8/H2/S0/A3/M1; B160+64, R256 | 145+640+192+64+224+256 = **1.521** | Não cabe em 1.024. Nós adicionais e temp tables podem aumentar ainda mais. |
| Hipótese após redução de trabalho: C8/P0/H2/S0/A3/M1; mesmos B/R    | 145+128+192+64+224+256 = **1.009** | Só 15 MiB restantes: insuficiente como margem de promoção.                 |
| Mesma hipótese, sem build manual M0                                 | **945**                            | Só cenário a medir; C8 não está imposto no runtime atual.                  |

B e R são reservas propostas, não valores medidos. O cenário simplificado DB-01
de 544 MiB omitia hash/parallel/backends; não é teto. `effective_cache_size=4 GiB`
é estimativa do planner, não alocação. A amostra DB-04 mede memory.current
1.022,76→1.023,26 MiB, eventos max +22.828 e throttling 91,72%; **não há headroom
comprovado para adicionar build/carga**. Não aumentar work_mem global.
Sem reduzir trabalho/concorrência com prova ou redistribuir recursos validada,
o aceite de capacidade permanece indisponível.

## 3. Observação segura e pré-condições de janela

Alvo único: `/opt/ganso-market`, `root@178.105.65.251`; host key conforme
[SERVER_ACCESS](../ops/SERVER_ACCESS.md). Executar do checkout local correto:

```sh
ssh -T -i ~/.ssh/id_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o ConnectTimeout=10 root@178.105.65.251 \
  'timeout 120s python3 -' < docs/test-results/btc/db04-observe.py \
  > /tmp/db04-observation-new.json
```

O coletor só lê metadata/contadores/logs, espera 30 s e executa os dois validadores
existentes. Cada statement da sonda: read-only/2 s, lock 500 ms; não executa SQL
de aplicação, ANALYZE, escrita, extensão ou limpeza. `application_name` pode ser
sobrescrito pelo cliente psql; na amostra apareceu `psql`. O JSON guarda somente
campos selecionados; não publicar inspect/env/log bruto/credenciais.
Os contadores não são uma fotografia atômica: usar UTC de cada par para taxas.

`check_runtime_memory.py` solicita só profile model; no host retornou dez
containers, mas conferir a lista de IDs com `--profile polymarket --profile model
ps --quiet` a cada janela. Seu agregado ~1,323 GiB desconta cache de modo diferente
de memory.current. Resultado verde isolado não prova folga do PG.

Janela futura: reservar **50 min**, sem deploy/build/retention manual concorrente:
15 min baseline passivo + até10 min um build + até5 min verificação/rollback +
15 min seis abas em janela separada se o build passar, mais5 min de margem para
wrappers/cancelamento. Teto duro50 min: não iniciar fase que não caiba no saldo;
remarcar, sem estender o build. Workload natural e retenção existente permanecem;
se manutenção pesada estiver ativa, adiar a entrada, não matar workers ou desligar
autovacuum. Registrar início/fim UTC, responsável, SHA por serviço, config hashes,
catálogo/OIDs e baseline imediatamente anterior; escolher horário pelos dados,
não presumir madrugada ociosa.

Antes de qualquer carga/build exigir: gates de escrita aprovados; cenário RAM
medido com **≥128 MiB de headroom PG não dependente de expulsão de cache**;
host dentro dos budgets; ≤32 clientes; nenhum outro build; ausência de lock wait
persistente/transaction ou snapshot antigo >30 s; zero novos erros de persistência,
overflow/gaps e fila recuperada no baseline. Capturar memory.stat (anon, file,
inactive_file, shmem) para separar cache; a coleta atual não mede essa reserva.
A janela DB-04 atual **não satisfaz** essas condições; nenhuma operação foi iniciada.

## 4. Índices: catálogo, espaço, aplicação e rollback

| Objeto exato em public                              | Estado real DB-04             | Ordem condicional                                                                            |
| --------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| polymarket_trades_data_api_condition_ts_idx         | Ausente; 6 existentes válidos | Depois de resolver gate DB-02; SQL/backfill atual já usa o índice se escolhido pelo planner. |
| polymarket_rtds_prices_asof_idx                     | Ausente; 3 existentes válidos | Prioridade técnica RTDS; só depois do gate DB-03 e release de query coordenada.              |
| snapshots (PK, received_at, token/received_at DESC) | 3 existentes válidos          | Controle Q3 e Q4 preservados; nenhum índice novo/removido.                                   |

O [JSON real](../test-results/btc/db04-observation.json) contém todas as definições,
validade e bytes desses 12 índices. Repetir antes/depois; índices de retenção,
dedupe/PK e causalidade existentes permanecem. Não inferir redundância/bloat só
por tamanho. Catalogar também usage, constraint e progresso, em sessão read-only:

```sql
SELECT n.nspname, c.relname, c.oid, t.relname AS table_name, am.amname,
       i.indisvalid, i.indisready, i.indislive, i.indisunique,
       pg_get_indexdef(c.oid) AS definition,
       pg_get_expr(i.indpred,i.indrelid) AS predicate,
       pg_relation_size(c.oid) AS bytes, s.idx_scan,
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid=c.oid) AS constraint_backed
FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_am am ON am.oid=c.relam
LEFT JOIN pg_stat_user_indexes s ON s.indexrelid=c.oid
WHERE i.indrelid IN ('public.polymarket_trades'::regclass,
 'public.polymarket_rtds_prices'::regclass,'public.polymarket_book_snapshots'::regclass);
SELECT pid,relid::regclass,index_relid::regclass,command,phase,
       blocks_total,blocks_done,tuples_total,tuples_done
FROM pg_stat_progress_create_index;
SELECT pid,backend_type,application_name,state,wait_event_type,
       clock_timestamp()-xact_start AS transaction_age,pg_blocking_pids(pid)
FROM pg_stat_activity WHERE backend_type='client backend';
```

**Espaço provisório, sem autorizar aplicação:** fixture trades 7,85 MB/100k
(11,75 MB/110k após inserts); RTDS 5,99 MB/120k. Extrapolar os maiores bytes/linha
para reltuples reais dá ~252 MB trades e ~155 MB RTDS, **estimativas**, pois
distribuição/fragmentação/predicado e estatísticas diferem. Planejar inicialmente
I=512 MiB trades e I=384 MiB RTDS, um de cada vez; validar com fixture de chaves
representativa antes de fixar orçamento. Reservar `I + 2I temporários + 4I WAL
marginal + 2 × taxa WAL basal × 600 s + 2 GiB de margem`.
Com a taxa DB-04 (~0,733 MiB/s), ambos ficam abaixo de **8 GiB por operação**.
Exigir antes `livre − 8 GiB ≥25% do filesystem`; abortar ao crescimento de disco
≥8 GiB ou livre<25%. Medir WAL/temps a cada30 s; fatores são reservas de triagem,
não limites garantidos. Medir espaço efetivo/WAL/duração e reconciliar após cada
build; WAL global com workers ativos não é custo marginal do candidato.

**Comando de aplicação preparado, não executado.** Após gates, catálogo sem
homônimo/equivalente, orçamento e autorização concreta registrados, no host:

```sh
cd /opt/ganso-market
DB04_PG=$(docker compose --env-file deploy/server.env ps --quiet postgres)
test -n "$DB04_PG"
# Escolher EXATAMENTE um destes arquivos após o gate do respectivo candidato.
DB04_SQL=docs/ops/sql/db03-rtds-asof-index.sql
# Alternativa trades: docs/ops/sql/db02-trades-last-recorded-index.sql
timeout 630s docker exec -i \
  -e PGAPPNAME=db04-index-build \
  -e 'PGOPTIONS=-c search_path=public,pg_catalog -c statement_timeout=600000 -c lock_timeout=500 -c maintenance_work_mem=65536 -c work_mem=4096 -c max_parallel_maintenance_workers=0' \
  "$DB04_PG" psql -X -v ON_ERROR_STOP=1 -U ganso_market -d ganso_market \
  < "$DB04_SQL"
```

Cada build tem timeout SQL10 min e invólucro630 s; não usar BEGIN, `-1`, migrator,
IF NOT EXISTS, elevação de timeout de aplicação ou retries automáticos. A sessão
usa manutenção serial e 64 MiB; não é tuning global. Catálogo/progresso/recursos
a cada5 s durante build, disco/WAL30 s. Em falha, bloquear promoção e registrar
OID/nome/definição/SQLSTATE antes de qualquer remoção. Cancelar **somente** a sessão
identificada por application_name, início e PID desta operação:

```sql
-- Confirmar PID e backend_start no catálogo; comando só cancela este build.
SELECT pg_cancel_backend(pid) FROM pg_stat_activity
WHERE pid = :db04_pid AND backend_start = :'db04_backend_start'::timestamptz
  AND application_name='db04-index-build';
```

Dar até30 s para saída; timeout do cliente Docker não prova cancelamento no banco.
Não matar o container ou outra sessão. Conferir de novo índice inválido; build
falho pode deixar objeto com custo de escrita. Se não sair, escalar com PID/progresso
concretos; não usar terminate indiscriminado.

Rollback, após provar que o objeto é exatamente o criado por esta operação,
sem constraint e sem dependência nova: restaurar **primeiro** query RTDS anterior
por release revisada caso já promovida, verificar seleção, depois escolher um nome.
Antes de promover a query exigir SHA/imagem anterior, artefato e comando de rollback
já preparados e validados no descarte, com teto5 min; não depender de escrever/abrir
outro PR durante a falha. Como o patch runtime ainda não foi selecionado, esses
identificadores não existem e bloqueiam sua promoção. Para índice com SQL atual
preservado, não há rollback de query:

```sh
timeout 150s docker exec -i -e PGAPPNAME=db04-index-rollback \
  -e 'PGOPTIONS=-c statement_timeout=120000 -c lock_timeout=500' \
  "$DB04_PG" psql -X -v ON_ERROR_STOP=1 -U ganso_market -d ganso_market \
  -c 'DROP INDEX CONCURRENTLY public.polymarket_rtds_prices_asof_idx;'
# Para rollback exclusivo do candidato trades, substituir apenas o nome por:
# public.polymarket_trades_data_api_condition_ts_idx
```

Máximo120 s SQL/150 s cliente, autocommit, sem CASCADE. Falha de DROP não é rollback
concluído: registrar objeto remanescente, custo e decisão pendente; não repetir
cegamente. Sem apagar linhas/ledger. Após sucesso do build exigir valid/ready/live
true, unique false, B-tree e definição/predicado exatos; confirmar EXPLAIN antes
de ANALYZE estreito nos budgets DB-01. Usage delta0 em janela curta não prova
inutilidade. Registrar tamanho e equivalência funcional antes da carga integrada.

**Migrator:** [apply.sh](../../infra/migrations/apply.sh) executa cada arquivo com
`psql --single-transaction`, incompatível com CREATE/DROP INDEX CONCURRENTLY.
Nenhuma migration foi adicionada/numerada. Release futura deve exigir prebuild
válido/exato em banco populado; banco vazio pode criar transacionalmente.
Validar esse preflight em PG descartável antes de merge; não deixar `IF NOT EXISTS`
ocultar índice inválido/divergente nem registrar schema_versions manualmente.
Depois de eventual migration aplicada, reconciliar retirada em nova migration
forward-only, sem editar checksum/histórico. O rewrite RTDS ainda não existe no
runtime: seu futuro patch e rollback precisam de PR/checks próprios coordenados
com índice válido; build isolado não prova o ganho medido do rewrite.

## 5. Tuning: o que recarrega e o que reinicia

| Mudança                                                                     | Aplicação futura / rollback                                                                                                   | Condição e máximo                                                                                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| work_mem, hash multiplier, parallel gather, maintenance por sessão          | SET/SET LOCAL em conexão própria; fechar sessão restaura default                                                              | Preferir escopo do statement/build; não muda pool existente. 2 s para SET/SHOW; budget de operação separado.                          |
| Parâmetro `context=user/superuser/sighup` em arquivo                        | Só após diff concreto aprovado: SELECT pg_reload_conf(); reconferir setting/source/pending_restart em nova sessão e no caller | 30 s para reload+verificação; se não efetivar, restaurar apenas o diff desta operação e recarregar. Command line/sessão prevalecem.   |
| shared_buffers/max_connections/reservas/max_worker_processes (`postmaster`) | Compose/config versionada, janela de restart; rollback do diff e recriação só PG                                              | Não fazer nesta entrega. Até120 s de saúde após cada restart; aceitar impacto/gaps antes da janela, não chamar restart de reload.     |
| CPU/RAM Docker                                                              | Alteração de Compose e recriação do serviço, não pg_reload_conf                                                               | Não escolhida: precisa novo budget completo e ambos validadores; rollback do Compose anterior. Não usar docker update deixando drift. |

Não há patch de tuning selecionado que justifique executar essas operações hoje.
Para futuro diff concreto de PG, após conferir imagem/Compose e persistência do
mesmo volume, aplicação/rollback com recriação é
`timeout 150s docker compose --env-file deploy/server.env up --detach --no-deps --force-recreate --wait --wait-timeout 120 postgres`.
Para mudança somente no arquivo existente de configuração, usar
`timeout 45s docker compose --env-file deploy/server.env restart --timeout 30 postgres`,
seguido de health em até120 s com `timeout 120s ./deploy/healthcheck.sh` e SELECT
de setting/source/pending_restart em sessão nova. `up` simples não garante restart
por alteração do conteúdo de um bind/volume. Não usar down/volumes/prune.
Rollback repõe o diff anterior conhecido; não restaura snapshot nem desfaz dados.

Recomendação atual: resolver trabalho SQL/gates e medir primeiro, mantendo1 CPU,
1 GiB, pools28, shared128/work4. Se continuar saturado depois, comparar **uma**
variável por janela: paralelismo por query (0 versus efetivo), ou redistribuição
de RAM já existente demonstrada por pico dos demais serviços. Não pressupor
2–4 CPUs melhores, reduzir recorder por uma amostra de196 MiB, nem elevar o teto
4 GiB/13 GB. Tuning sem prova fica proposta para revisão posterior, custo externo0.

## 6. Validação integrada

Este roteiro não supera os gates herdados: DB-02 reprovou o gate de p95 COMMIT
de conflitos (+173,56%); DB-03 não dispõe do ensaio de escrita/WAL, rejeitado pela
revisão automática; Q4 continua adiado para DB-03B. Nenhum deles pode ser contado
como aprovado por observação passiva ou pelo teste do limitador abaixo. A amostra
passiva DB-04 com RTDS ΔINSERT=0 e OOM=0 não demonstra continuidade de ingestão nem
aceite de carga. A aplicação de índices e tuning permanece condicionada aos gates
e decisões especificados no restante deste plano.

### Carga e contagem

As seis abas são seis páginas do navegador, cada uma autenticada na mesma origem
existente e com uma tela selecionada: Mesa, Carteira, Decisões, Sombra, Resolução e
Sistema. Não são seis cliques alternados na mesma página. Todas as telas repetem
`/polymarket/overview` e `/polymarket/paper/performance` a cada 15 s, totalizando
8 GETs/minuto por aba. As URLs externas acrescentam `/api` ao caminho abaixo.

| Tela      | GETs próprios e cadência                                                                                                               | Total nominal/min, incluindo faixa | Quota local de GETs |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------: | ------------------: |
| Mesa      | opportunities, decisions, portfolio/exposure, paper/positions e series em lote, 30 s; limits na montagem/mudança de versão             |                                 18 |                 320 |
| Carteira  | portfolio/exposure, portfolio/state, paper/positions, paper/orders e portfolio/limits, 30 s                                            |                                 18 |                 320 |
| Decisões  | portfolio/state e portfolio/limits, 30 s; sem decisions no carregamento padrão                                                         |                                 12 |                 220 |
| Sombra    | shadow-replay/latest?mode=B, latest?mode=A e runs, 60 s                                                                                |                                 11 |                 200 |
| Resolução | resolution-risk, resolution-risk/divergences, resolution-risk/reports, resolution-risk/pipeline, graph/violations e graph/vetoes, 15 s |                                 32 |                 550 |
| Sistema   | health/live e health/ready, 15 s; events, 5 s; data-quality, portfolio/limits, gates e portfolio/exposure, 30 s                        |                                 36 |                 590 |
| Total     | Mesmas cadências nativas                                                                                                               |                                127 |               2.200 |

Previsão estacionária: aproximadamente 1.905 GETs em 15 minutos. Séries vazias
reduzem chamadas; montagem, mudança de tokens visíveis e navegação deliberada
podem acrescentá-las. O total efetivamente iniciado prevalece. Não clicar em
detalhes, filtros, recarga, rearme ou outra ação durante a janela. A autenticação
é concluída antes dela. O cliente `authorizedGet` faz fetch único, sem retry
automático; não há SSE/WebSocket nos clientes dessas telas. Qualquer retry ou
recarga observado deve entrar na contagem e ser explicado.

A proposta DB-01 de 360 requests em 15 minutos pode ser mantida apenas como
**triagem opcional de seis clientes**, com 60 GETs por cliente, sem chamá-la de
ensaio das seis telas nativas. Não é etapa obrigatória, não foi executada e não
substitui este ensaio.

### Preparação e execução limitada no navegador

1. Escolher janela de 15 minutos com workers existentes ativos, após resolver as
   condições de promoção aplicáveis. Não disparar retenção, build, VACUUM ou jobs
   extraordinários. Registrar SHA efetivo por processo, início/fim UTC, catálogo,
   limites e baseline imediatamente anterior, da mesma duração. Manter observador
   operacional para conexões, OOM, disco, filas/gaps e erros de persistência.
2. Abrir as seis páginas autenticadas na origem já permitida e selecionar uma
   tela por página. Não exportar cookies, tokens ou HAR bruto. Manter o computador
   acordado. O navegador pode reduzir timers de páginas em segundo plano: publicar
   a cadência e N observados; não alterar flags do navegador para ocultar isso.
3. Escolher um único `startUtc`, em ISO UTC, pelo menos cinco minutos no futuro.
   Executar o snippet abaixo no Console de DevTools de cada página, mudando só
   `role` e repetindo exatamente o mesmo `startUtc`. Não recarregar as páginas
   após instalar. O snippet mede fetches API da página; não altera arquivos do
   aplicativo nem dispara requests próprios. A soma das quotas é 2.200, inclusive
   tentativas de fetch que terminam em erro. Chamadas de início anterior ao horário
   comum pertencem ao baseline, não à amostra.
4. Conferir em cada página `__db04Assay.snapshot().readyRoles`: as seis funções
   devem aparecer antes do início. Ausência de uma função ou duplicidade aborta a
   carga antes do primeiro fetch medido. Autenticação/401 durante a janela aborta;
   o wrapper bloqueia novos POSTs de refresh/rearme depois do início.
   `readyRoles` é somente inventário inicial: não há heartbeat, e fechar/suspender
   uma aba não remove seu nome dos peers. O operador deve manter e conferir as seis
   páginas durante toda a janela. Uma aba encerrada, suspensa ou sem cadência
   observável invalida o ensaio das seis abas, mesmo se continuar listada; N real
   por função/rota é obrigatório e nenhuma ausência vira sucesso silencioso.
5. Observar os limites operacionais abaixo. Para abortar as seis páginas,
   executar `__db04Assay.stop("operator_abort")` em qualquer uma. O aviso usa
   BroadcastChannel na mesma origem; propagação não é instantânea, e o operador
   deve fechar as seis páginas caso uma não receba o aviso. Cada página mantém
   independentemente o prazo, quota e timeout de 5 s por fetch.
6. No fim, aguardar até cinco segundos para os fetches que já estavam em voo
   concluírem. Novos fetches ficam bloqueados pelo wrapper. Salvar em cada Console
   `copy(JSON.stringify(__db04Assay.snapshot(), null, 2))` em um arquivo local por
   função; não copiar os objetos Request/Response ou headers. Fechar exclusivamente
   as seis páginas do ensaio depois de salvar. Não restaurar fetch com as páginas
   ainda abertas, pois os polls retomariam carga sem limitador.

O observador de corpo usa `Response.clone()` e consome a cópia em paralelo com o
cliente; registra a duração até o corpo completo, sem guardar seu conteúdo. Não
inclui parsing/renderização da UI nem identifica latência de SQL. Esse observador
tem custo local de memória/CPU; registrar versão do navegador e não comparar seu
tempo com uma medição de headers apenas. O timeout de 5 s e o sinal original do
cliente são preservados. Erro HTTP/fetch/corpo, função ausente, quota ou aborto
operacional interrompem a carga; não há retry do observador.

```javascript
// Repetir o mesmo horário UTC nas seis páginas; mudar somente role.
(() => {
  const cfg = { role: "mesa", startUtc: "SUBSTITUIR_POR_ISO_UTC_FUTURO" };
  const quotas = {
    mesa: 320,
    carteira: 320,
    decisoes: 220,
    sombra: 200,
    resolucao: 550,
    sistema: 590,
  };
  if (window.__db04Assay)
    throw new Error("Limitador já instalado nesta página");
  const start = Date.parse(cfg.startUtc),
    end = start + 15 * 60_000;
  if (!(cfg.role in quotas) || !Number.isFinite(start) || start <= Date.now())
    throw new Error("Conferir role e startUtc futuro antes de instalar");
  const originalFetch = window.fetch.bind(window);
  const channel = new BroadcastChannel(
    "ganso-db04-" + new Date(start).toISOString(),
  );
  const instance = crypto.randomUUID();
  const peers = new Map([[cfg.role, instance]]),
    rows = [],
    active = new Map();
  let stopped = null,
    initiated = 0,
    blocked = 0;
  const utc = () => new Date().toISOString();
  const reject = () =>
    Promise.reject(new DOMException("DB04 stopped", "AbortError"));
  function stop(reason, publish = true, abortActive = true) {
    // Uma falha de fetch ainda em voo prevalece sobre o fim normal da janela.
    if (
      stopped &&
      (stopped.reason !== "window_complete" || reason === "window_complete")
    )
      return;
    stopped = { reason, utc: utc() };
    if (abortActive) for (const c of active.values()) c.abort();
    if (publish) channel.postMessage({ type: "stop", reason });
  }
  function hello(type) {
    channel.postMessage({ type, role: cfg.role, instance });
  }
  channel.onmessage = ({ data }) => {
    if (data.type === "stop") return stop(data.reason, false);
    if (!(data.role in quotas)) return;
    if (peers.has(data.role) && peers.get(data.role) !== data.instance)
      return stop("duplicate_role");
    peers.set(data.role, data.instance);
    if (data.type === "hello") hello("ready");
  };
  hello("hello");
  // Fim normal bloqueia novos fetches; dá até 5 s aos que já começaram.
  setTimeout(() => stop("window_complete", false, false), end - Date.now());
  function routeOf(url) {
    let path = url.pathname.replace(/^\/api/, "");
    path = path.replace(
      /^(\/polymarket\/(?:opportunities|series|decisions))\/[^/]+$/,
      "$1/:id",
    );
    path = path.replace(
      /^(\/polymarket\/resolution-risk)\/(?!divergences$|reports$|pipeline$)[^/]+(\/history)?$/,
      "$1/:id$2",
    );
    if (path === "/polymarket/shadow-replay/latest") {
      const mode = url.searchParams.get("mode");
      if (mode === "A" || mode === "B") path += "?mode=" + mode;
    }
    return path;
  }
  window.fetch = function (input, init) {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url,
      location.href,
    );
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/"))
      return originalFetch(input, init);
    if (stopped) {
      blocked++;
      return reject();
    }
    if (Date.now() < start) return originalFetch(input, init);
    if (Date.now() >= end) {
      stop("window_complete", false, false);
      blocked++;
      return reject();
    }
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "GET") {
      stop("unexpected_method");
      blocked++;
      return reject();
    }
    if (peers.size !== 6) {
      stop("missing_role");
      blocked++;
      return reject();
    }
    if (initiated >= quotas[cfg.role]) {
      stop("request_quota");
      blocked++;
      return reject();
    }
    const id = ++initiated,
      at = performance.now(),
      controller = new AbortController();
    const sourceSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const forwardAbort = () => controller.abort();
    if (sourceSignal?.aborted) controller.abort();
    else sourceSignal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 5_000);
    const row = {
      id,
      role: cfg.role,
      route: routeOf(url),
      startedUtc: utc(),
      status: null,
      bodyCompleteMs: null,
      finishedUtc: null,
      outcome: "inflight",
    };
    rows.push(row);
    active.set(id, controller);
    let done = false;
    function finish(outcome) {
      if (done) return;
      done = true;
      row.outcome = outcome;
      row.finishedUtc = utc();
      row.bodyCompleteMs = Math.round((performance.now() - at) * 1_000) / 1_000;
      active.delete(id);
      clearTimeout(timer);
      sourceSignal?.removeEventListener("abort", forwardAbort);
      if (outcome !== "ok") stop(outcome);
    }
    return originalFetch(input, { ...init, signal: controller.signal }).then(
      (response) => {
        row.status = response.status;
        if (!response.ok) {
          finish("http_error");
          return response;
        }
        // Retornar a resposta original imediatamente preserva consumo pelo app.
        try {
          void response
            .clone()
            .arrayBuffer()
            .then(
              () => finish("ok"),
              () => finish("body_error"),
            );
        } catch {
          finish("body_error");
        }
        return response;
      },
      (error) => {
        finish("fetch_error");
        throw error;
      },
    );
  };
  window.__db04Assay = {
    stop: (reason) => stop(reason || "operator_abort"),
    snapshot: () => ({
      schemaVersion: 1,
      role: cfg.role,
      startUtc: new Date(start).toISOString(),
      endUtc: new Date(end).toISOString(),
      quota: quotas[cfg.role],
      readyRoles: [...peers.keys()].sort(),
      initiated,
      blocked,
      active: active.size,
      stopped,
      samples: rows.map((row) => ({ ...row })),
    }),
  };
})();
```

Antes de carga real, exigir o teste local do mesmo snippet com fetch substituído
por respostas em memória: seis funções se descobrem, duplicidade/ausência abortam,
quota bloqueia a próxima chamada, prazo bloqueia novos fetches, 500/falha de corpo
e timeout propagam stop, método POST não alcança fetch e os snapshots não contêm
headers/tokens/corpos. Resultado do teste deve ser registrado; não é PostgreSQL,
não escreve dados e não habilita os gates herdados de escrita/WAL. O limitador
atua em fetch, mecanismo usado pelas telas auditadas; se o código do release
passar a usar XHR/SSE/WebSocket, parar e adaptar o contador antes do ensaio.

O [harness entregue](../test-results/btc/db04-assay-test.cjs) passou em
[12 verificações offline](../test-results/btc/db04-assay-test-result.json) do
snippet exato deste runbook; comando local
`node docs/test-results/btc/db04-assay-test.cjs docs/runbooks/btc-postgres-capacity.md`.
Isso verifica o limitador em memória; compatibilidade/cadência do navegador real
continua pré-condição operacional não atestada.

Verificação de preparação efetivamente observada em 12/09/2026, 04:09 UTC:
**12 cenários locais passaram** em Node VM com seis páginas simuladas e fetch
em memória. Incluíram quotas das seis funções, descoberta/duplicidade/ausência,
bloqueio de POST, HTTP 500, falha de corpo, timeout 5 s, aborto manual, fim normal,
falha em voo após o prazo, privacidade e medição até o corpo completo. Nenhuma
rede ou operação PostgreSQL foi utilizada. Esse resultado verifica o mecanismo
local do snippet; não verifica timers/BroadcastChannel de um navegador real,
rotas, recursos, ingestão ou aceite do servidor.

### Percentis, métricas e critérios de interrupção

| Budget SQL atual por rota | Meta HTTP p95 | Meta HTTP p99 | Rotas do ensaio                                                                                          |
| ------------------------: | ------------: | ------------: | -------------------------------------------------------------------------------------------------------- |
|                    500 ms |        400 ms |        450 ms | performance, positions, orders, events, decisions, exposure, state, gates, series, rotas Resolução/graph |
|                  1.000 ms |        800 ms |        900 ms | opportunities, portfolio/limits                                                                          |
|                  1.500 ms |      1.200 ms |      1.350 ms | overview                                                                                                 |
|          2.000 ms, padrão |      1.600 ms |      1.800 ms | shadow-replay e health; revalidar config efetiva                                                         |
|                  4.000 ms |      3.200 ms |      3.600 ms | data-quality                                                                                             |

Essas metas HTTP são o gate proposto DB-01 (80%/90% do budget), não o significado
do GUC: `statement_timeout` vale por statement, não pelo request inteiro. Pool API
tem teto 4 s; conexão 1 s; nginx/navegador 5 s. Não elevar budgets para acomodar a
carga. API `request_completed` registra status/rota/correlation ID, **não duração**;
logging automático de requests está desabilitado. O snippet fornece duração de
HTTP até corpo completo; percentis SQL continuam indisponíveis sem fonte própria.

Calcular nearest-rank em cada rota/cenário: ordenar as durações, p95 na posição
`ceil(0,95 × N)` e p99 em `ceil(0,99 × N)`, índices humanos começando em um.
Publicar N iniciado, sucesso, falha, aborto e status antes dos percentis. Qualquer
falha reprova, mesmo quando os percentis das respostas boas passam. Com **N<100**,
marcar percentis de aceite indisponíveis; máximo/amostras ainda podem ser publicados
como triagem. Em 15 minutos, Resolução terá nominalmente 60 amostras/rota, rotas
de 30 s terão 30 e Sombra terá 15 por modo. Somente a faixa compartilhada chega a
360 por rota. Logo a janela inicial não assegura todos os percentis requeridos.

Uma extensão de até 120 minutos pode aumentar N sem acelerar os ticks; manter
seis abas abertas é **carga adicional**, não observação passiva. Esta configuração
do limitador termina em 15 minutos e não autoriza extensão implícita. Preparar e
revisar previamente outro horário final e quotas proporcionais (nominal 15.240 GETs
em 120 min, total limitado a 17.600), repetir o teste local do limitador e registrar
o orçamento adicional antes de executá-la. Tráfego natural só fornece percentis
HTTP se continuar instrumentado; logs sem duração não completam N de latência.
Nenhuma dessas janelas demonstra estabilidade por sete dias.

Gates de aceite: zero timeout/5xx/OOM/erros de persistência/perda, ≤32 client
backends, RAM planejada total <13 GB e SSD livre ≥25%; nenhum crescimento de
lacunas novas na janela; throughput/lag/fila/flush sem regressão superior a
10% contra baseline comparável, com N/unidade/denominador publicados. Nulo ou
ausência de operações não significa zero custo ou gate aprovado. WAL global
não demonstra WAL marginal de um índice e taxa por tempo não prova p95 COMMIT.

Abortar carga nova imediatamente no primeiro timeout/5xx/401, OOM, limite de
conexões/disco/requests excedido, novo erro de persistência/perda ou crescimento
de fila sem recuperação. Parar também na primeira evidência de regressão que
impeça o aceite; não aguardar a janela acabar para obter um número melhor.
Encerrar somente clientes do ensaio e preservar workers/dados. Registrar a causa,
UTC, requests ativos e falhas; não reiniciar, limpar nem retentar automaticamente.

Correlacionar a mesma janela com:

- `/overview`: último delta/idade, open_gaps/gaps_24h; `/data-quality`: gaps por
  fonte/24 h e ingest lag p50/p99/1 h. São janelas móveis: diminuição pode ser
  envelhecimento e não prova ausência de novos gaps. Exigir zero gaps novos;
  atribuição presumida à venue não dispensa o gate. Distinguir silêncio existente,
  novas lacunas e persistência para diagnóstico. Se contagem ou causalidade forem
  incompletas, o gate fica indisponível, não aprovado.
- `STATUS` do recorder, a cada 300 s por padrão: insertFailures, overflowDropped,
  deltasFlushed, deltasQueued, snapshots, minuteUpserts e saúde RTDS/feed. Comparar
  deltas sem restart. Três amostras em 15 min não capturam picos intermediários.
- Logs BOOKPIPE_PERSIST_FAILED, RTDS_PERSIST_FAILED, RTDS_1M_PERSIST_FAILED,
  TRADE_PERSIST_FAILED, WS_TRADE_PERSIST_FAILED, GAP_PERSIST_FAILED, overflows,
  JOB_STILL_RUNNING e pg_code=57014. Capturar separadamente API e cada worker.
- Contadores PG por intervalo: INSERT/UPDATE/DELETE por tabela, WAL, temp files/
  bytes, transações, locks e conexões; cgroup CPU/throttling, RAM e OOM; SSD livre.
  Não normalizar por zero operações nem atribuir WAL global apenas ao recorder.

Fontes de implementação: `config/runtime.json:15`, `apps/api/src/server.ts:65,135`,
`apps/api/src/database.ts:179`, `apps/web/src/App.tsx:243`, `Mesa.tsx:1546`,
`Portfolio.tsx:709`, `Resolution.tsx:65`, `resolution.ts:252`,
`apps/api/src/polymarket/readapi.ts:1256` e `orchestrator.ts:832,937`.

## 7. Decisões concretas para revisão posterior e handoff

| Decisão / dado faltante | Opções, impacto/custo e recomendação                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ensaio rejeitado DB-03  | Autorizar explicitamente o ensaio isolado e limitado abaixo, ou manter candidato sem promoção. Sem nova infra/custo; recomendação é revisão explícita antes de qualquer nova tentativa. A nova sessão não vale como aprovação. |
| DB-02 escrita +173,56%  | Repetir avaliação representativa e concorrente dentro do escopo realmente autorizado, ou abandonar/retrabalhar o candidato. Manter ≤10%; não aceitar piora por soma de ganho de leitura.                                       |
| Q4 DB-03B               | Manter comportamento atual, ou decidir regra source/received e empate antes de rewrite. Impacto no mid/jump breaker; recomendação segundo caminho em bloco separado decidido pelo coordenador.                                 |
| Recursos                | Manter existentes agora; depois avaliar redução de trabalho/paralelismo e redistribuição interna com picos medidos. Não contratar serviço, aumentar orçamento/caps ou enfraquecer policy.                                      |
| Observabilidade         | Obter latência por SQL/commit, contadores de gaps recebidos e lag/fila durante carga. Browser mede HTTP; pg_stat/logs atuais não preenchem os campos ausentes. Sem extensão automática.                                        |

Proposta **não executada** para a aprovação pendente: PostgreSQL18.4 descartável,
1 CPU/1 GiB, armazenamento efêmero separado e `GANSO_TEST_DATABASE_URL` apontando
somente ao destino local confirmado; fixture sintética, nenhum dado/volume de
produção. Um candidato por vez, baseline/variante alternados; 10k inserts RTDS,
1k upserts agregados e 1k deletes; VACUUM apenas se incluído na aprovação explícita
do mesmo conjunto. A variante trades deve reproduzir também 10k conflitos; snapshots
10k apenas para baseline de persistência, sem reescrever Q4. Teto30 min total,
5 s/statement e120 s por cenário; batches e concorrências1/4/8 usando o mesmo
conjunto e seed. Não omitir fase bloqueada para converter gate null em passed.
Registrar N≥100 commits por tipo/cenário/variante, throughput, p95, erros/perdas,
WAL marginal, tamanho antes/depois, build e cancelamento; cada tipo deve cumprir
regressão≤10%, zero erros/perdas, bytes declarados e equivalência. Separar inserts,
conflitos e upserts; não mascarar pior caso com percentil agregado. p99 só com
N≥100 e tamanho da amostra explícito. Fixture não substitui operação real.

FRESH-01 recebe capacidade **medida** (1 CPU/1 GiB, saturação, pools28/40), sem
promessa de cadência/p95/saúde. DATA-01 pode iniciar inventário independente;
isto não aprova limpeza nem desbloqueia os gates operacionais DB-04. Nenhum outro
prompt, tarefa ou automação é executado aqui.

Semântica conferida em 12/09/2026: [recursos PG18](https://www.postgresql.org/docs/18/runtime-config-resource.html),
[context/source de settings](https://www.postgresql.org/docs/18/view-pg-settings.html),
[CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html) e
[DROP INDEX](https://www.postgresql.org/docs/18/sql-dropindex.html). As fontes explicam
os parâmetros; medições e gates são os registros deste repositório.
