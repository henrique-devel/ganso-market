# RFC-021 — entrega integrada OPS-01 a OPS-07

Data: 12/09/2026 UTC. Base: `c528d5b0d74cc5cf8894ee953dd335df5f1e1b03`.
Branch: `codex/rfc-021-ops-01-07`. O proprietário solicitou PR, merge e produção.

## Escopo

- OPS-01: inventário e evidência da base; identidade SSH reconciliada pelo console
  independente do proprietário conforme [SERVER_ACCESS](../../ops/SERVER_ACCESS.md).
- OPS-02: silêncio CLOB global/token, controle REST, recuperação limitada e
  persistência idempotente. A revisão de integração encontrou lacunas CLOB que
  sobreviviam ao restart no banco, mas não no monitor; a release inclui restauração.
- OPS-03: gatilho por snapshots e deltas e rearme após 15 ticks/900 s observados,
  somente para engate elegível `RECORDER_STALE`, ambas as séries frescas e sem gap.
- OPS-04: [procedimento operacional](../../runbooks/btc-recovery.md) reconciliado
  com as entregas OPS-05/06/07 e com o bootstrap real do watchdog.
- OPS-05: silêncio RTDS por série/global, gaps duráveis e recuperação limitada.
- OPS-06: heartbeat do recorder, supervisor systemd externo, orçamento persistente
  de restarts e instalação reversível.
- OPS-07: fechamento monotônico no sweep, sem inferir resolução/outcome de `closed`.
  Os upserts preexistentes do registry mantêm sua autoridade.

Migrations novas: `0021_polymarket_silence_gap_idempotency.sql` e
`0022_polymarket_rtds_gap_idempotency.sql`. Migrations anteriores preservadas.
Trabalho documental BTC-04 não integra esta entrega.

## Verificação local

A primeira execução de `make verify` passou: API 2.004 testes, web 249, contratos
70, Rust 16, Python 157; formatação, lint, build, secret scan e política Compose.
Após a correção CLOB, a verificação final de TypeScript passou: API 2.012, web 249,
contratos 70, lint/build/formatação e secret scan. A suíte API sem DSN deixou
141 testes PostgreSQL ignorados; não contam como aprovados.
PostgreSQL 18.4 descartável: 48 testes passaram sem skips (kill-switch 8,
rtdsgaps 9, samplers 5, quality 26), incluindo restauração de gap CLOB no mesmo UUID.
O runner real aplicou as migrations 0001–0022 e reconheceu os 22 checksums na
reaplicação; container/tmpfs removidos ao final.

`make integration` passou em projeto Compose isolado, com porta 18087 e nome
`rfc021-release-check`: runtime, migrations/reaplicação, readiness, indisponibilidade
e retomada do PostgreSQL, ausência de query secreta nos logs e shutdown. Nenhum
container de desenvolvimento preexistente foi utilizado.

## Preparação de produção

SSH autenticado com host key confirmada no console Hetzner pelo proprietário.
Pré-inspeção: host `ubuntu-16gb-fsn1-2-bot`, usuário `root`, release default
`3ba26633a64e57780a1e79a84400e828ca6197a1`, dez serviços em execução,
PostgreSQL/API/web saudáveis e watchdog ainda não instalado.
Postmaster iniciado em `2026-09-07T22:59:17.372734Z`; schema foundation 20 antes
da entrega. Em `2026-09-12T01:08:40Z`, snapshots/deltas/RTDS recebiam dados no
segundo corrente. Kill switch `RECORDER_STALE`, engatado desde `2026-09-11T16:29:38.622Z`.
Nenhum rearme manual foi executado.
GitHub: `DEPLOY_ENABLED=true`; environment `production` sem regra de espera.

O CI/CD aplica migrations e runtime default após merge. Recorder/paper e instalação
do watchdog exigem a etapa operacional explícita do runbook. A versão em produção
deve ser conferida dentro de cada container, além de `.deploy/current-sha`.
Deploy concluído, aceite operacional e soak são evidências diferentes; nenhum
resultado futuro deve ser inferido dos testes locais.
