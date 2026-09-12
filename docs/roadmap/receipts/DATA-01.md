Bloco: DATA-01 | RFC: RFC-041 | Retomada: 12/09/2026 UTC.
Estado: production-verified da instalação e primeira amostra; série de sete dias ainda em andamento.
Código: branch codex/data-01-growth-series, head99d1275; [PR #166](https://github.com/henrique-devel/ganso-market/pull/166), merge97c2787 sobre basec8b7367.
Evidência operacional: branch codex/data-01-growth-evidence; complemento documental publicado no PR desta revisão.
Histórico preservado: [inventário PR #160](../../test-results/btc/DATA-01.md), janela04:36–04:39 UTC; sem reescrever suas medidas.
Entrega: [relatório suplementar](../../test-results/btc/DATA-01-growth-series.md), [operação](../../test-results/btc/data01-growth-operation.json) e amostra byte-idêntica ao host.
CI: PR/run34706586883 e main/run34706830333 com source/Compose aprovados; deploy do merge skipped em manutenção, não “só texto”.
Instalação: só capacity_series.py e recorder_watchdog.py do merge aprovado; hashes conferidos, watchdog anterior salvo; DEPLOY_ENABLED restaurado true.
Cadência: timer watchdog existente,8 slots/7 intervalos,carência1h; reserva durável,erro/interrupção consomem slot,sem retry/backfill/reinício.
Budgets:10s coleta/12s hook,uma consulta read-only1500ms/lock250ms/connect1s;8 amostras até16KiB + manifesto4KiB,sem rotação.
Primeira amostra:12/09 17:03:55.666555 UTC,slot0 ok/complete em1,392270s;5.160B,sem delta anterior;nenhuma coleta manual.
Janela:início12/09 17:03:34.182494 UTC;última tentativa19/09 17:03:34.182494;encerra19/09 18:03:34.182494 UTC.
Filesystem real:PGDATA/WAL/pg_default/pg_global no volume ganso-market_postgres_data,8:1/ext4/dev/sda1,deduplicado uma vez.
Disponível:201.990.098.944B/188,117939GiB/62,670993%;total322.302.373.888B;piso25% atendido,sem admissão de export.
Banco:98.537.690.815B/91,770376GiB;WAL presente128MiB;contador WAL só produzirá delta com reset/identidade comparáveis.
Observação:uma amostra/zero intervalos;sete dias,crescimento sustentado,saúde dos feeds e soak não demonstrados.
Verificação:59 testes watchdog +56 série/instalador,Ruff,formatação,secret scan e diff check;contrato SQL real PG18.4 descartável removido.
Pós-check17:05:14 UTC:230 imagens,11 containers/imagens/inícios,5 backups e hashes das units iguais;timer ativo,exit0,128MiB/10%CPU/70s mantidos.
Watchdog:captured e depois not_due;reason persistence_stale/action observe preservados;sucesso do coletor não é saúde do feed.
Acompanhamento:python3 -I /opt/ganso-market/deploy/capacity_series.py --status;estado em /var/lib/ganso/recorder-watchdog/capacity-series;sem SQL.
Rollback preparado:restaurar watchdog salvo com hash validado,reter série/coletor/backup;nenhum rollback/restart/prune executado.
Herança:migration23/HOLD existente preservado;gates DB-02/03 reprovados,índices suspensos;sem novo ensaio/poda/compactação/recursos/caps/live/perímetro.
Preservação:custo externo adicional0,trabalho local alheio intacto;somente DATA-01,sem executar outros blocos nem criar tarefas/automações.
