Bloco: OPS-06 | RFC: RFC-021 | Data UTC: 2026-09-11T21:15:30Z
Estado: code-verified
Código: c528d5b0d74cc5cf8894ee953dd335df5f1e1b03 + patch local não commitado; mudanças preexistentes preservadas.
Resultado: supervisor externo detecta loop bloqueado, preserva evidência no host e recupera somente recorder, com confirmação imediatamente antes da ação.
Arquivos de execução: polymarket-recorder.ts; deploy/recorder_watchdog.py; install-recorder-watchdog-timer.sh; systemd/ganso-recorder-watchdog.{service,timer} (cinco arquivos).
Testes novos: apps/api/test/polymarket-recorder.test.ts; scripts/tests/test_recorder_watchdog{,_probe,_install}.py.
Dependências: recibos OPS-01/02/05 + run/shutdown, orchestrator STATUS e contratos CLOB/RTDS conferidos; índices received_at da migration 0013; nenhuma migration nova.
Sinais: processo/geração, heartbeat v1 10 s (PID/seq/UTC/uptime/fase), DB e persistência global por consultas limitadas em outro Node; SHA embutido na imagem.
Recuperação: carência 180 s; stale 90 s e confirmação >=30 s; DB/persistência indisponível inibe; dados stale isolados não reiniciam; nova sondagem cancela se houve retomada/falha DB.
Orçamento: flock canônico, reserva fsync anterior ao Docker, restart somente ID validado; 10 s stop/20 s cliente; cooldown 300 s, backoff até 1800 s, máximo 3/h preservado em crash/recreate.
Evidência: /var/lib/ganso/recorder-watchdog root:root 0700, arquivos 0600; UTC/SHA/motivo; 32 eventos <=64 KiB, estado/status atômicos, logs 10 min/100 linhas apenas campos permitidos.
Proteção: maintenance, estado inválido/clock rollback/baixa folga inibem; host >=128 MiB/64 MiB disco, recorder >=96 MiB; budgets Node/SQL/CLI/systemd explícitos.
Teste consolidado: python3 -m unittest discover -s scripts/tests -p 'test_recorder_watchdog*.py' -v — 50 passed em 56.973 s, zero skipped.
Revalidação após confirmação final: python3 -m unittest discover -s scripts/tests -p 'test_recorder_watchdog.py' -v — 35 passed em 53.915 s (inclui duas novas regressões); total único Python 52.
Heartbeat: npm run test --workspace @ganso-market/api -- test/polymarket-recorder.test.ts — 4 passed; total único do bloco 56 testes.
Checks: build/typecheck API, Prettier TS, Ruff check/format dos quatro Python, sh -n, dry-run install/uninstall, compose policy, secret scan e git diff --check passaram.
Ambiente: macOS, Python 3.9.6, Node 26.4.0, Vitest 4.1.10; subprocessos reais e fixtures; pg real contra sockets locais recusado/silencioso (127.0.0.1), sem PostgreSQL externo.
Aceite local: Node Up em while(true) não bloqueia observador; crash/concorrência/backoff/quota/segredos/manutenção e ordem validar-instalar/parar-remover exercitados.
Produção: não consultada; nenhum deploy, instalação/ativação systemd, restart real, escrita DB ou rearme paper; execução systemd nativa/SQL bem-sucedido em PostgreSQL/soak não verificados aqui.
Handoff OPS-04: [runbook](../../runbooks/recorder-watchdog.md) com sinais, limites, rotação, manutenção sincronizada e comandos reversíveis; resolver identidade SSH/integração antes da ativação.
Limites: heartbeat comprova loop, persistência é global (não BTC/source_ts/todas séries); restart_requested não comprova recuperação/coleta saudável; interrupção Docker já aceita não é revertida pelo marker.
