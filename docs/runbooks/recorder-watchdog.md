# Recorder watchdog — OPS-06 / handoff OPS-04

Implementação local; **não instalado/ativado no servidor, sem saúde ou soak atestado**.
Base: c528d5b0d74cc5cf8894ee953dd335df5f1e1b03 + patch OPS-06. O recibo
[OPS-06](../roadmap/receipts/OPS-06.md) registra a verificação efetivamente executada.

## Sinais e decisão

O timer do host chama `deploy/recorder_watchdog.py` em processo Python separado.
Ele encontra exatamente um container pelas labels Compose `ganso-market` /
`polymarket-recorder`, valida checkout `/opt/ganso-market` e comando Node exato.
Observa estado/StartedAt/RestartCount/imagem, sem exportar env, secrets ou inspect
integral. Container parado, pausado ou em restart é observado; não é iniciado.
`restart: unless-stopped` existente continua responsável por saídas do processo.

O entrypoint publica `/tmp/ganso-recorder-heartbeat.json` atômico, 0600, <1 KiB,
a cada 10 s: versão 1, PID, sequência, UTC, uptime e fase starting/running/stopping.
É progresso do event loop, não recepção de feed nem confirmação de escrita. Um
novo `docker exec ... node` lê esse arquivo, verifica que o PID existe e consulta
PostgreSQL sem usar o pool ou event loop do recorder. SHA vem de
`/etc/ganso/release-sha` **da imagem**; SHA desconhecido impede recuperação.

| Sinal | Limiar / resultado |
| --- | --- |
| Processo recém-iniciado | Carência de 180 s por StartedAt; recreate reinicia só essa carência |
| Heartbeat ausente, de execução anterior, >90 s ou sequência parada >90 s | `heartbeat_stalled`; duas observações do mesmo motivo/geração separadas por >=30 s |
| Starting ainda fresco após carência | `startup_stalled`, mesma confirmação |
| Stopping fresco | Inibe; stopping que envelhece também vira stalled |
| DB não conecta / SELECT 1 falha | `db_unavailable`; nenhuma tentativa de restart |
| Consulta de persistência falha | `persistence_unavailable`; inibe mesmo com heartbeat stale |
| Últimos received_at de snapshots CLOB / preços RTDS >300 s ou ausentes | `persistence_stale`; observa, sem reiniciar por esse sinal isolado |
| Heartbeat e persistência passam | `healthy`; não significa BTC/todas as séries/source_ts frescos |

Persistência usa dois `ORDER BY received_at DESC LIMIT 1` com índices da migration
0013, em uma consulta; não faz COUNT ou scan voluntário, e não escreve. É chegada
global de dados, não prova por token, avanço de preço ou ausência de gap. Feed
silencioso com loop vivo permanece sob OPS-02/05 e avaliação OPS-04.

## Orçamentos e proteção

Uma conexão adicional: connect 1 s, statement 1 s, lock 500 ms, query 1,5 s;
sessão read-only desde abertura, idle-in-transaction 2 s. Probe Node: heap máximo
32 MiB, deadline próprio 6,5 s e cliente Docker 8 s. O deadline interno importa:
encerrar cliente `docker exec` não encerra por si só o processo do daemon.

Antes do probe, `docker stats --no-stream` exige >=96 MiB disponíveis no limite
do recorder (CLI desconta cache recuperável; há corrida normal entre medições).
Host exige >=128 MiB MemAvailable e >=64 MiB disco livre; ausência de medição ou
folga inibe ação. Não se aumenta memória/pids do Compose. Unit host: MemoryMax
128 MiB, CPUQuota 10%, TasksMax 32, nice 10, IO idle. O Node adicional pertence ao
cgroup do recorder e consome essa folga; verificar pressão real antes de ativar.

Comandos Docker de inspeção/stats/logs: 3 s cada, saída <=128 KiB, filhos locais
encerrados como grupo no timeout. Restart: **apenas ID revalidado do recorder**,
SIGTERM e até 10 s antes SIGKILL pelo Docker; cliente limitado a 20 s.
Após salvar logs/revalidar alvo, nova sondagem confirma heartbeat e DB; retomada,
falha de persistência ou mudança de SHA cancela a ação antes de consumir tentativa. Timeout é
`restart_unconfirmed`, não comprovação de restart nem convite a repetição imediata.
Unit oneshot: 70 s, stop 5 s, KillMode=control-group. Timer: 30–35 s após cada
rodada; detecção é limiar mais cadência/tempo das sondagens, não SLA de 90 s.

`flock` não bloqueante cobre sondagem, evidência, reserva e ação. CLI exige um
único diretório canônico de estado; reserva atômica/fsync vem **antes** do pedido
Docker. Crash/timeout consomem tentativa. Cooldown/backoff: 300/600/1200/1800 s,
máximo 3 tentativas em janela móvel de 3600 s, preservados após restart/recreate
ou reinício do supervisor. Uma hora de observações saudáveis, sem hiato >120 s, zera expoente; não limpa
janela. Relógio do host voltando no tempo ou estado corrompido inibe recuperação.

## Evidência e acesso

`/var/lib/ganso/recorder-watchdog` é externo a containers, root:root 0700. Arquivos
0600: `state.json` (orçamento), `status.json` (última rodada concluída),
`event-<UTC-epoch-us>-<uuid>.json`, `instance.lock`; temporário único `.pending`.
Cada evento/status/estado <=64 KiB; retém 32 eventos, removendo só nomes próprios
regulares e sem seguir symlinks. Teto produzido: <=2 MiB em eventos + até 192 KiB
para estado/status/temporário. Conteúdo é atômico e sincronizado antes da ação;
falha de armazenamento inibe restart. Nenhum mount novo é necessário.

Eventos contêm UTC, SHA da imagem (ou null), ID/imagem, razão, observações e ação.
Logs têm janela de 10 min, corte antes da ação e últimas 100 linhas. stdout e
stderr passam por allowlist: códigos fixos, nível, timestamp e três contadores
numéricos. Texto livre, stack, URLs, env, headers, tokens e códigos desconhecidos
são descartados; nunca há arquivo bruto intermediário. Isso reduz detalhes para
proteger credenciais. Overflow/timeout de logs vira marcador, sem coleta ilimitada.
Journal recebe só resumo/códigos estáticos, rate limit 5/min. Erros de alvo/probe/
headroom podem aparecer só no journal; conferir UTC de status antes de interpretá-lo.
A retenção é por quota, não garantia de duração: falha contínua pode girar a janela
em cerca de 16–30 min. Exportar eventos relevantes antes do soak longo.

## Instalação reversível — executar somente no passo autorizado de OPS-04

Pré-condições: resolver identidade SSH pendente em OPS-01; integrar e implantar a
imagem com heartbeat e SHA válido; verificar migrations/índices, contratos OPS-02/05
e folga de host/recorder. Checkout/código/ancestrais devem ser root, sem escrita
group/other nem symlinks. O instalador valida alvo e contrato sem reiniciar antes
de escrever units/ativar timer. Não muda donos do checkout automaticamente.

```sh
sudo /opt/ganso-market/deploy/install-recorder-watchdog-timer.sh --dry-run
sudo /opt/ganso-market/deploy/install-recorder-watchdog-timer.sh
sudo systemctl status ganso-recorder-watchdog.timer
sudo journalctl -u ganso-recorder-watchdog.service --since '-10 min' --no-pager
sudo cat /var/lib/ganso/recorder-watchdog/status.json
```

Manutenção sincronizada antes de deploy/recreate ou parada planejada:

```sh
sudo systemctl disable --now ganso-recorder-watchdog.timer
sudo systemctl stop ganso-recorder-watchdog.service
sudo touch /var/lib/ganso/recorder-watchdog/maintenance
```

O marker inibe no início e imediatamente antes da reserva, inclusive execução
manual. Criá-lo sozinho não cancela um pedido Docker já enviado. Parar a unit não
reverte restart já aceito pelo daemon; esperar a operação terminar antes do deploy.
Após a manutenção e validação OPS-04, remover só o marker e habilitar novamente:

```sh
sudo rm /var/lib/ganso/recorder-watchdog/maintenance
sudo systemctl enable --now ganso-recorder-watchdog.timer
sudo /opt/ganso-market/deploy/install-recorder-watchdog-timer.sh --uninstall --dry-run
sudo /opt/ganso-market/deploy/install-recorder-watchdog-timer.sh --uninstall
```

Uninstall desabilita/para timer, para service/cgroup e só então remove as duas
units; preserva estado, evidência e manutenção. Falha ao parar impede remoção.
Nada aqui reinicia DB, rearma paper, altera gates ou supervisiona outros serviços.
OPS-04 deve confirmar timer ativo, UTC recente do observador, evidência de incidente
e avanço real por série após recuperação; sucesso do comando não atesta coleta.

Interfaces verificadas em 2026-09-11: [Docker exec](https://docs.docker.com/reference/cli/docker/container/exec/),
[restart e timeout](https://docs.docker.com/reference/cli/docker/container/restart/),
[stats e memória](https://docs.docker.com/reference/cli/docker/container/stats/),
[políticas de restart](https://docs.docker.com/engine/containers/start-containers-automatically/),
[pg.Client](https://node-postgres.com/apis/client) e
[systemd KillMode](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).
`unhealthy` isolado não substitui o mecanismo ativo de recuperação implementado.
