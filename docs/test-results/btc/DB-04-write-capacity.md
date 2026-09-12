# DB-04 — Escrita RTDS/WAL e capacidade atual

Retomada autorizada em 12/09/2026. Base interna/main
`fb1e22a0672659976ff8cded13779d262edf26e3`, worktree
`/private/tmp/ganso-db04-write-capacity`, branch `codex/db-04-write-capacity`.
Somente DB-04; entregas DATA locais e worktree histórico DB-04 preservados.

## Protocolo registrado antes da coleta

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
