Bloco: DATA-01 | RFC: RFC-041 | Retomada: 2026-09-12 UTC.
Estado: code-verified da série diária; instalação e primeira captura ainda pendentes nesta revisão.
Base: c8b73677f863cb491c902e606c2dcc0ce2aaf5bf; branch codex/data-01-growth-series; entrega registrada no PR desta revisão.
Histórico preservado: [inventário PR #160](../../test-results/btc/DATA-01.md), medido04:36–04:39 UTC; não representa o instante atual.
Complemento: [série de capacidade](../../test-results/btc/DATA-01-growth-series.md), contrato SQL e verificações operacionais.
Implementação: capacity_series.py, hook opcional no watchdog existente e instalador host com hashes/backup.
Cadência: baseline +7 intervalos diários,8 slots,carência1h; --start fixa calendário e não reinicia série existente.
Erro/interrupção: reserva durável antes da tentativa; status error/partial/reserved/missed consome slot, sem repetição/backfill.
Budgets:10s coleta,12s hook,1cliente SQL,statement1500ms/lock250ms/connect1s/read-only; stdout64KiB/comando.
Persistência:8 amostras de até16KiB + manifesto4KiB e lock; encerramento finito, sem apagar evidências.
Filesystem: revalida PGDATA/WAL/pg_default/pg_global contra volume Docker, namespace/mount/device e statvfs do host real.
Deduplicação: um registro por filesystem físico; checkout nunca substitui a medição do volume PostgreSQL.
Métricas: tamanho físico da base, filesystem disponível e segmentos WAL; WAL gerado somente com stats_reset comparável.
Deltas: pares adjacentes completos com identidade/versão iguais; resets, gaps e rollback de relógio não viram taxa.
Verificação:59 testes watchdog +56 série/instalador passaram; Ruff/formatação, secret scan e diff check aprovados.
Contrato: consulta exata validada em PostgreSQL18.4 descartável vazio; container removido; não foi ensaio de escrita/carga.
Entrega prevista: checks obrigatórios e merge; CD automático em manutenção para evitar poda de backups; instalar só dois arquivos host.
Operação: timer/unit/cotas existentes preservados; instalador salva watchdog anterior e inicia janela sem forçar execução do supervisor.
Rollback: restaurar watchdog anterior com hash verificado; reter coletor, série e backup; sem restart/prune/recriação da aplicação.
Limites: instalação não comprova7dias/crescimento sustentado/soak; piso25% inibe SQL e fica evidência parcial.
Herança atual: migration23/HOLD DATA-02 já existente; gates DB-02/03 reprovados na retomada, índices suspensos; sem repetir ensaio.
Preservação: imagens, cinco backups, rollback, dados/HOLD e trabalho local de outros blocos; custo externo adicional0.
Escopo: somente DATA-01; sem política/catálogo/rotação DATA-05, compactação, tuning, caps/live/signer/perímetro ou novas automações.
