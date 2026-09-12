# DB-04 — Escrita RTDS/WAL e capacidade atual

Retomada autorizada em 12/09/2026. Base interna/main
`fb1e22a0672659976ff8cded13779d262edf26e3`, worktree
`/private/tmp/ganso-db04-write-capacity`, branch `codex/db-04-write-capacity`.
Somente DB-04; entregas DATA locais e worktree histórico DB-04 preservados.

## Protocolo registrado antes da coleta (commit `56d1ae2`)

A [autorização vigente](../../ops/DEVELOPMENT_AUTHORIZATION.md#retomada-das-recomendações-btc--12092026)
respondeu às recusas antigas do ensaio. Elas são histórico, não aprovação pendente.
O protocolo preparado no PR #164, [DB-03-write-preparation](DB-03-write-preparation.md),
será executado uma vez. As evidências históricas de leitura e a coleta única
DB-02 não serão repetidas. DB-02 mantém 3/8 agregados, 15/32 rodadas reprovadas e
0/8 cenários aprovados pela regra conjunta; dispersão não prova causalidade da
latência, e WAL adicional 768.212 B não dispensa os gates.

- Destino novo local: PostgreSQL18.4, imagem já existente fixada por digest,
  1 CPU/1 GiB, max_connections10, bind literal127.0.0.1 em porta dinâmica e banco
  exato `ganso_db03_write_disposable`, sem tabelas ou outros client backends.
  Durabilidade fsync/full_page_writes/synchronous_commit on. Nenhum volume produtivo.
- Uma conexão; 5 s statement/connect/idle transaction, lock500 ms, 120 s por
  cenário/setup e 600 s global incluindo cleanup. Sem retry de erro ou coleta
  concluída. Endurecimento prévio: watchdog encerra espera de cliente travada
  no teto global, emite JSON parcial e exit1 com cleanup incompleto explícito;
  disposição posterior do container exato não transforma falha em sucesso.
- Migrations reais1–23/checksums, HOLD e guards de escrita habilitados em ambos
  schemas UUID. Seed120k RTDS e1k agregados por variante. Quatro rodadas A/B;
  10k inserts RTDS e1k upserts por variante, braços autocommit principal e COMMIT
  explícito diagnóstico, SQL atual extraído do escritor. Nenhum EXPLAIN/leitura
  histórica dentro da medição. WAL por backend fora do cronômetro.
- Controle DELETE de até1.000 alvos por variante: exigir erro55000/HOLD e zero
  perda. Throughput de poda indisponível; não desabilitar guard. VACUUM comum com
  ANALYZE só nas tabelas raw/agregado dos schemas próprios, depois da escrita,
  fora das suas medidas. Sem FULL/repack e nenhuma poda em produção.
- 130k RTDS e1k agregados finais por variante, igualdade de todos os campos RTDS;
  agregados iguais exceto received_at, cujo CURRENT_TIMESTAMP deve estar na janela
  de relógio do servidor declarada. Guards intactos antes/depois e zero perda.
- Mesmos gates≤10% no agregado **e em cada rodada**, sem epsilon, remover outliers
  ou compensar piora de escrita com leitura. Relatar exit0/1/2 literalmente;
  `promotionAllowed=false` permanece mesmo se a escrita passar. Flush de2 linhas
  é sintético e não comprova comportamento de backlog/fila produtivo.
- Ruído/concorrência: não adicionar A/A ou conexões de escrita nesta coleta.
  Preservar os outros containers locais, registrar CPU/RAM/cgroup e IDs antes/
  depois; o host Docker não é exclusivo. Rodadas balanceadas e WAL por backend
  são os controles fixados. Dispersão residual será exposta, não eliminada por
  reexecução. No servidor existente, coletar atividade/conexões do cluster e
  CPU/memória/WAL/temp por duas amostras de30 s, sem induzir carga ou varrer dados.
- Capacidade: mapear data_directory, pg_wal/symlink e tablespaces às montagens
  Docker e filesystems reais, com bytes livres/total por filesystem. O filesystem
  do checkout só representa PG/WAL quando a identidade do mount comprovar isso.
  Sondas SQL read-only≤2 s/lock500 ms, janela externa≤120 s, sem instalação/tuning.
  Respeitar SSD livre≥25%, budgets Compose<4 GiB e total host<13 GB; não presumir
  memória de cache como folga. Não alterar pools/timeouts ou recursos por amostra
  curta, nem promover índices com gates falhos. Q4/DB-03B e compactação adiados.

Este registro é protocolo, não resultado. A seção seguinte receberá os dados
observados, incluindo falhas/limites. Fixture, publicação, aplicação e soak são
resultados distintos. Custo externo adicional zero, infraestrutura existente,
paper, sem capital/caps/live/signer/perímetro novo.

## Resultado da execução única

**Ensaio concluído com gates reprovados: exit2, completed=true,
allGatesPassed=false, promotionAllowed=false.** Execução em 12/09/2026,
15:50:17.268–15:50:37.276 UTC, 20.008,243167 ms incluindo setup/cleanup.
O texto de protocolo acima preserva a decisão anterior à coleta; a execução
prevista ali já ocorreu. Não houve nova recusa de aprovação, repetição ou retry.

Evidência completa: [12.000 amostras e gates](db04-rtds-write-result.json),
[identidade, recursos e disposição local](db04-write-local-resources.json),
[sonda passiva](db04-capacity-resume-probe.py) e
[observação do servidor](db04-capacity-resume-observation.json).
O runner executado foi o commit `56d1ae2aea152e72be8149e3af5585dfd7f4424b`,
SHA256 `0bf4c70296d92eefc0a6c5cf8a9262da85b213302f68e6d070941f95f90ee614`;
hashes do SQL, índice, método/protocolo e migrations1–23 constam no JSON.
O hash protocolSha256 dos recursos identifica a versão deste relatório **antes**
da inclusão dos resultados, recuperável naquele commit.

### Escrita, WAL e integridade

Valores baseline → candidato. N é número de operações **por variante**; cada
insert RTDS contém duas linhas. Throughput usa somente tempo ativo medido e não
representa cadência produtiva. Autocommit inclui persistência no tempo total,
sem cronometrar COMMIT separadamente. Os gates comparam tempo ativo, p95 total e,
quando disponível, p95 COMMIT, em inteiros, no agregado e em cada rodada.
A regressão de tempo ativo limita também a perda de throughput; não usar o
throughput agregado para ignorar uma rodada reprovada.

| Cenário              |     N | p95 total (ms)      | p95 COMMIT (ms)     | Operações/s           | Agregado | Rodadas reprovadas | Gate conjunto |
| -------------------- | ----: | ------------------- | ------------------- | --------------------- | -------- | ------------------ | ------------- |
| RTDS autocommit      | 2.500 | 2,016709 → 1,766500 | indisponível        | 1.168,969 → 1.329,619 | passa    | nenhuma            | passa         |
| RTDS explícito       | 2.500 | 2,883542 → 3,099250 | 1,397041 → 1,422042 | 660,914 → 612,678     | passa    | 1, 4               | reprova       |
| Agregados autocommit |   500 | 1,767459 → 1,811208 | indisponível        | 1.534,466 → 1.445,407 | passa    | 1, 2, 4            | reprova       |
| Agregados explícito  |   500 | 3,018209 → 3,015208 | 1,198958 → 1,651083 | 650,315 → 615,823     | reprova  | 1, 2, 4            | reprova       |

**1/4 agregados e 8/16 rodadas reprovados; somente 1/4 cenários passa pela regra
conjunta.** No agregado explícito dos upserts, p95 COMMIT +37,709828%; na rodada4,
+233,966494%. Percentis p50/p99, máximos e todas as amostras permanecem no JSON,
inclusive os máximos RTDS de99,981333 ms baseline/autocommit e101,240708 ms
candidato/explícito. Nenhum outlier removido.

| Rodada reprovada      | Δ tempo ativo | Δ p95 total | Δ p95 COMMIT |
| --------------------- | ------------: | ----------: | -----------: |
| RTDS explícito1       |   +20,272701% |  +5,029607% |  +45,855969% |
| RTDS explícito4       |   +13,384358% | +17,614375% |  +54,884872% |
| Agregados autocommit1 |   +13,209316% |  +6,401601% |            — |
| Agregados autocommit2 |    −0,592149% | +11,160905% |            — |
| Agregados autocommit4 |   +13,831541% | +22,441332% |            — |
| Agregados explícito1  |    +3,482772% |  +7,967521% |  +50,534138% |
| Agregados explícito2  |    −0,274906% |  −5,798121% |  +72,548823% |
| Agregados explícito4  |   +23,691194% | +27,181985% | +233,966494% |

| WAL medido por backend | Baseline (B) | Candidato (B) | Adicional (B) |
| ---------------------- | -----------: | ------------: | ------------: |
| RTDS autocommit        |    1.878.236 |     2.535.812 |       657.576 |
| RTDS explícito         |    1.870.689 |     2.516.441 |       645.752 |
| Agregados autocommit   |      118.652 |       118.652 |             0 |
| Agregados explícito    |      117.946 |       117.946 |             0 |
| Total                  |    3.985.523 |     5.288.851 |     1.303.328 |

O adicional vem dos inserts RTDS: +34,765379% no WAL raw, 130,3328 B por linha
raw adicionalmente gravada. FPI=0 nos dois braços de todos os cenários; não há
inferência para rajadas após checkpoint. Inclui commit/sequence/guard do backend;
exclui setup, build, warmup, DELETE/HOLD, VACUUM e cleanup.
Índice candidato5.988.352 → 6.864.896 B (+876.544 B); heap raw final12.107.776 B
em ambos, índices raw15.613.952 → 22.478.848 B. Não extrapolar linearmente tamanho,
WAL ou capacidade produtiva desta fixture.

Cada variante terminou com130.000 RTDS/1.000 agregados. Igualdade de todos os
campos raw e de agregados exceto received_at passou; todos1.000 upserts atualizados
com received_at dentro da janela do servidor (baseline15:50:33.446910–35.934379,
candidato15:50:33.451282–35.935331 UTC). DELETE limitado a até1.000 alvos retornou
55000/DATA02_EVIDENCE_HOLD em ambos, com zero perda; deletionThroughputGate=null.
VACUUM(ANALYZE) comum nas duas tabelas próprias:124,997834 ms baseline e110,832916 ms
candidato, fora das medidas de escrita/WAL, guards habilitados antes/depois.
Schemas UUID próprios removidos, cleanupErrors vazio. Zero perda/erro inesperado
não converte a regressão de desempenho em aprovação.

Os agregados têm dados econômicos/identidades (exceto received_at), índices,
tamanhos finais e WAL iguais nos dois braços.
A dispersão de latência até nesse controle é compatível com variação temporal
e do host compartilhado; a coleta não isola sua causa. Não atribuir toda a piora
ao índice raw, nem usar ruído como dispensa dos gates. Não houve A/A, carga
concorrente induzida ou repetição escolhida após conhecer o resultado.

### Destino local e descarte

PostgreSQL18.4 ARM64, imagem já local
`sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382`,
Docker29.7.2, Nodev26.4.0. Container dedicado `ganso-db04-write-pg-20260912`,
ID `0d861ad07ea206d1abb2613814892e3d24f8e278c2d2cafc1081ed36256b160f`,
1 CPU/1 GiB, max_connections10, bind127.0.0.1:55826, banco exato
`ganso_db03_write_disposable`. Preflight confirmou zero tabelas e outros clientes;
fsync/full_page_writes/synchronous_commit on. Volume anônimo próprio, nunca produção.

No par de recursos local de22,932782 s (inclui setup/cleanup), CPU+7.351.191 µs,
7/207 períodos throttled (3,38164%), +173.772 µs throttled; memória75,176 →264,855 MiB,
sem OOM/max/high. As duas pontas não são pico. Escritas de disco+332.210.176 B
incluem o ciclo inteiro, não representam WAL marginal. Os outros cinco containers
locais foram preservados, portanto não se reivindica exclusividade do host.

O watchdog de600 s foi corrigido **antes** da coleta: cobre query/client.end/cleanup
travados, grava JSON parcial sincronamente antes do exit1 e relata schemas
possivelmente remanescentes. Fallback externo de emergência610 s não foi usado.
Às15:53:34.224553 UTC foi verificada a remoção do container exato e de seu volume
anônimo; os cinco containers preexistentes continuaram em execução.

## Capacidade atual observada no servidor

Coleta única read-only em12/09/2026,15:52:55.661829–15:53:31.915463 UTC,
36,253674 s, complete=true/exit0. SSH com chave/host key já documentados, timeout
externo120 s; sonda interna115 s, sem retry; SQL2 s/lock500 ms via PGOPTIONS desta
conexão (não são timeouts globais do servidor). Catálogo/counters somente, sem
scan de dados, instalação, logs, texto de consultas, coleta de segredos ou tuning.

Host8 CPUs/15.608,457 MiB, MemAvailable13.821,777 MiB e swap0; PG18.4 x86_64,
Docker27.5.1/Compose2.32.4. Os dez containers mantiveram identidade ao final.
Checkout, API, portfolio e recorder em `8132cd357ffb47340e39af278a65dc06469edb0f`;
estimator/resolution `da6d56037604ade22182e40d2dd78256078be2b3`, paper
`dcfd52b7371dc426ebaa4fbce2391cf6e2f531ac`. Engine/nginx/web/PG não têm arquivo
release_sha: seus image IDs estão no JSON, sem atribuir SHA de aplicação.

### Memória, CPU, conexões e atividade

| Medida PG                              | A → B / delta                          | Interpretação limitada à janela                        |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| Limite                                 | 1 CPU / 1.024 MiB                      | sem alteração                                          |
| memory.current                         | 1.023,855 → 888,984 MiB                | folga0,145 →135,016 MiB; não sustentada                |
| anon cgroup                            | 266,508 →194,676 MiB                   | alocação anônima observada                             |
| soma Pss_Anon                          | 266,496 →194,665 MiB                   | 27 →25 processos, cobertura completa nas pontas        |
| file cache                             | 714,785 →652,301 MiB                   | inclui shmem149,109 →148,734 MiB; não somar duas vezes |
| inactive_file / kernel                 | 246,332 →191,621 /42,547 →41,863 MiB   | cache não é reserva garantida                          |
| memory.events max / OOM / OOM-kill     | +13.780 /0 /0                          | pressão no limite sem OOM observado                    |
| workingset_refault_file                | +812.008                               | atividade de cache, não headroom aceito                |
| CPU em30,695068 s                      | +30.632.064 µs ≈0,997947 núcleo        | praticamente o limite de1 CPU                          |
| Throttling                             | 307/307 períodos=100%; +140.151.662 µs | tempo cumulativo, não percentual de wall time          |
| Client backends no cluster             | 13 →15, inclui observador              | max_connections40; reservas3, reserved0                |
| Clientes app ativos / parallel workers | 5 →1 /6 →2                             | não é teste de concorrência induzida                   |
| Lock waits / builds ativos             | 0 →0 /0 →0                             | ausência só nas duas capturas                          |

Role ganso_market é superuser; reservas3 não isolam emergência da aplicação.
Pools máximos28 são referência no código, não leitura dos máximos dos processos
em execução; não foram instrumentados aqui. Diff da base histórica `e74c246` até
`fb1e22a` não muda Compose, entradas de pool/DB e validadores de recursos conferidos:
budget completo4064 MiB/6,5 CPUs, apenas32 MiB até4 GiB, e limites dos dez containers
ativos3840 MiB. Nenhuma redistribuição foi feita. O teto operacional proposto32
conexões permanece proposta, não configuração aplicada. Host disponível não
remove a saturação do cgroup PG nem demonstra uso agregado de pico abaixo13 GB.

Shared buffers128 MiB/shared memory145 MiB, WAL buffers4 MiB, work_mem4 MiB,
hash multiplier2, maintenance64 MiB e autovacuum3×64 MiB; max_parallel_workers8,
por gather2, max_parallel_maintenance_workers2; max_worker_processes8.
Checkpoint300 s/completion0,9; WAL min80/max1024 MB, slots ausentes; fsync,
full_page_writes e synchronous_commit on. track_io_timing/track_wal_io_timing off:
seus tempos zero não provam ausência de espera de I/O. Nenhum ajuste/restart.

No par SQL de30,398431 s, commits+17.762, rollback/deadlock0, temp files+9 e
temp bytes+1.653.858.304 (~51,886 MiB/s); WAL global+3.060.749 B,13.903 records,
113 FPI, sem delta de checkpointer. São contadores assíncronos e amostras
sequenciais, incluindo o observador; não são WAL marginal do índice ou latência
por SQL. Uma consulta portfolio estava ativa por24,68625 s na captura A, sem
latência de conclusão medida. INSERT: deltas+1.610, snapshots+256, trades+47,
RTDS raw/agregado0; UPDATE agregado0; DELETE0 nessas cinco tabelas. A janela
curta não permite concluir causa da ausência de RTDS, saúde de feed, lag ou gaps.
Catálogo HOLD `data-02-v1` intacto: seis triggers delete/write de RTDS raw,
agregados e trades habilitados O. Nenhuma escrita tentada em produção.

### Filesystem de dados, WAL e tablespaces

Mapeamento comprovado por SHOW data_directory, resolução real de caminhos,
pg_tablespace_location, mounts Docker, mountinfo host/container (device e caminho
interno), statvfs e df. Volume `ganso-market_postgres_data`:
`/var/lib/docker/volumes/ganso-market_postgres_data/_data` → `/var/lib/postgresql`.
PGDATA `/var/lib/postgresql/18/docker` corresponde a `_data/18/docker`; pg_wal
é seu subdiretório, não symlink. Só pg_default1663/base e pg_global1664/global;
nenhum tablespace customizado. Cobertura completa observada.

| Caminho observado                 | Device/filesystem real        |       Total (B) | Disponível (B, f_bavail) |      Livre |
| --------------------------------- | ----------------------------- | --------------: | -----------------------: | ---------: |
| Checkout / PGDATA (cada consulta) | 8:1, ext4, /dev/sda1, mount / | 322.302.373.888 |          201.754.750.976 | 62,597972% |
| pg_wal                            | mesmo filesystem              | 322.302.373.888 |          201.745.645.568 | 62,595147% |
| pg_default / base                 | mesmo filesystem              | 322.302.373.888 |          201.742.643.200 | 62,594216% |
| pg_global / global                | mesmo filesystem              | 322.302.373.888 |          201.736.740.864 | 62,592384% |

Não somar valores repetidos: há um único filesystem compartilhado, confirmado,
com mínimo observado62,592384% acima do piso25%. f_bavail exclui a reserva root;
a variação entre consultas não é previsão de crescimento nem prova de limpeza.
O mapeamento resolve a lacuna anterior de usar apenas disco do checkout, mas
não autoriza build: os gates de escrita e memória/CPU continuam reprovados ou
não comprovados. Série de crescimento/cobertura fica no handoff DATA-01.

## Verificação, decisão e limites

- 14 testes offline do runner passaram (dez herdados, quatro do watchdog): deadline,
  preservação de amostras/erro, cancelamento, falha de saída e subprocesso real
  com10.000 amostras antes do exit1. Comando: `node --test docs/test-results/btc/db03-write-benchmark.test.mjs`.
- Revisão independente recalculou todas as métricas/gates a partir das12.000
  amostras e conferiu hashes; 3/4 agregados e8/16 rodadas passam, mas só1/4 cenários
  satisfaz a regra conjunta. Não repetir testes PG históricos55/46 nem DB-02.
- Sonda final: AST e dez verificações offline passaram, sem rede/SQL:
  `python3 docs/test-results/btc/db04-capacity-resume-probe.test.py`. Revisão cruzada
  das fórmulas, mapeamento e limitações; evidência bruta preservada no repositório.
- Runbook alterado:12 verificações em memória passaram novamente às16:03 UTC,
  `node docs/test-results/btc/db04-assay-test.cjs docs/runbooks/btc-postgres-capacity.md`;
  seis contextos VM, sem rede/PG, preservando limite2200 e abortos.
- AST/JSON, sintaxe Node, links locais, varredura de segredos, formatação Markdown
  e `git diff --check` conferidos; os JSON de coleta não são reformatados.

DB-04 permanece code-verified: executou fixture autorizada e observou produção,
sem aceitar capacidade integrada. A melhoria aplicada é o limite efetivo do
runner e a medição passiva mais precisa. Índices de trades/RTDS continuam
suspensos; DB-02 PR163 mantém suas reprovações. Não há fundamento para tuning
ou redistribuição imediata por esta janela. Q4/DB-03B e compactação estão adiados
por decisão aprovada, não aguardando a autorização antiga.

O plano de seis abas, aplicação/cancelamento/rollback e budgets no
[runbook](../../runbooks/btc-postgres-capacity.md) segue condicionado aos gates.
Não houve ensaio integrado, nova carga no servidor, p95/p99 SQL produtivo,
throughput de poda, promoção, migration produtiva, tuning, recriação, soak ou
mudança de custos/capital/caps/live/signer/perímetro. Publicação documental segue
PR/checks/merge e RFC-020; resultado efetivo de CI/deploy será registrado no PR.
Somente DB-04 é atualizado; DATA-01 recebe handoff de crescimento/capacidade
independente. Nenhum outro prompt, tarefa ou automação foi iniciado.
