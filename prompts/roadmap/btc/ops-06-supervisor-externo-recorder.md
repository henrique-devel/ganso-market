---
id: OPS-06
rfc: RFC-021
depends_on: [OPS-01, OPS-02, OPS-05]
mode: code
---
# OPS-06 — Supervisionar recorder fora do event loop

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Entregar supervisor externo testado que detecte recorder vivo porém travado,
preserve evidência fora do container e recupere somente esse serviço.

## Leitura mínima

- `docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md` — emenda OPS-06.
- `apps/api/src/polymarket-recorder.ts` — run / shutdown.
- `deploy/healthcheck.sh` — probes e orçamentos.
- `deploy/install-shadow-replay-timer.sh` — padrão de instalação systemd.
- `docker-compose.yml` — recorder / logging / restart.
- `scripts/tests/test_shadow_replay_job.py` — subprocesso controlado em testes.

Abra os símbolos/seções indicados; paths novos são propostos.

## Escopo e limites

Propor `deploy/recorder_watchdog.py`, unit/timer e teste dedicado. Observar processo,
heartbeat de progresso e persistência via consultas limitadas em processo separado;
event loop bloqueado não pode bloquear o observador. Registrar UTC/SHA/motivo e
logs delimitados antes da ação, com quota/rotação externa que sobreviva a recreate.
DB indisponível é estado distinto: não entrar em ciclo de reinício por falha comum.
Restart só recorder, com lock de instância, timeout, cooldown/backoff, máximo por
janela e inibição explícita durante manutenção. Exigir mecanismo ativo: Docker
`unhealthy` sozinho não reinicia container. Proteger permissões/segredos e headroom.
Fora: instalar/ativar no servidor, reiniciar banco, rearmar paper ou supervisão geral.

## Aceite e verificação

- Processo Up/event loop bloqueado é detectado externamente e não bloqueia probe.
- DB indisponível não causa tempestade; processos saudáveis não reiniciam.
- Repetição/crash/instâncias concorrentes respeitam lock, backoff e máximo.
- Evidência sobrevive ao recreate, é limitada e não inclui credenciais.
- Testes usam subprocessos/fixtures; instalação systemd valida alvo e desligamento.

## Fim e handoff

Registrar sinais, limites, armazenamento/rotação e comando de instalação reversível
para OPS-04. Código/teste pronto não significa supervisor ativo ou coleta saudável.
