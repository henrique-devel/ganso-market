# Runbook — job diário do shadow replay (RFC-029)

O que o job é: uma vez por dia, às **03:30 UTC**, o servidor roda o CLI
`shadow-replay` nos dois modos e grava o JSON de cada um em disco. Nada mais.
O CLI é read-only por duas travas independentes (`sweepstore.ts:61–75`), o job
só redireciona o stdout dele para um arquivo, e o container da API monta esse
diretório **`:ro`** — nem o job nem a API têm caminho novo de escrita no banco.

Por que existe: em 03/09/2026 o modo B levou **710 s** quando foi destacado com
`nohup setsid`, e **morreu em silêncio** (exit 255, aos 1.646 s e aos 1.268 s)
quando foi rodado direto por `ssh … docker compose exec -T`. O problema não era
o processo; era estar preso a um socket que fecha. Quem manda no processo agora
é o systemd.

## Peças

| Peça | Caminho | Quem atualiza |
| --- | --- | --- |
| Script da rodada | `/opt/ganso-market/deploy/shadow-replay-run.sh` | o CD (rsync do checkout) |
| Auxiliar (JSON de erro, plano de retenção) | `/opt/ganso-market/deploy/shadow_replay_job.py` | o CD |
| Unidades | `/etc/systemd/system/ganso-shadow-replay.{service,timer}` | `deploy/install-shadow-replay-timer.sh` |
| Saída | `/var/lib/ganso/shadow-replay/` | o job, como root, `0755` |
| Leitura pela API | mesmo caminho, montado `:ro` no serviço `api` | `docker-compose.yml` |

O `ExecStart` aponta para o **checkout**, não para uma cópia em `/usr/local`.
Consequência boa: mudar o script é um deploy normal, sem reinstalar nada.
Consequência a lembrar: se o checkout sumir, o job não roda (o
`ConditionPathIsDirectory` faz a unidade ficar inativa em vez de falhar).

## Instalar (uma vez, e depois sempre que as unidades mudarem)

Primeiro leia o que ele faria — o `--dry-run` não cria arquivo, não recarrega o
systemd e não habilita nada:

```bash
ssh -i ~/.ssh/id_ed25519 root@178.105.65.251 'cd /opt/ganso-market && sh deploy/install-shadow-replay-timer.sh --dry-run'
```

Depois, para valer:

```bash
ssh -i ~/.ssh/id_ed25519 root@178.105.65.251 'cd /opt/ganso-market && sh deploy/install-shadow-replay-timer.sh'
```

É idempotente: rodar de novo deixa exatamente os mesmos dois arquivos, o mesmo
diretório e o mesmo timer habilitado.

**O instalador não roda uma rodada.** A primeira é manual, de propósito, para
que quem instala escolha o minuto em que o primeiro as-of bate no postgres:

```bash
ssh -i ~/.ssh/id_ed25519 root@178.105.65.251 'systemctl start ganso-shadow-replay.service'
```

Ela leva da ordem de 15 minutos (710 s de modo B + 118 s de modo A, medidos).
`systemctl start` de um `oneshot` só volta quando termina; para não segurar o
SSH, use `systemctl start --no-block` e acompanhe pelo `journalctl`.

## Conferir uma rodada

```bash
systemctl list-timers 'ganso-shadow-replay*'
systemctl show ganso-shadow-replay -p ExecMainStatus
journalctl -u ganso-shadow-replay --since today --no-pager
ls -l /var/lib/ganso/shadow-replay/
```

O que tem de ser verdade:

- `ExecMainStatus` = **0**;
- nenhuma linha com `shadow_replay_failed` no `journalctl`;
- `{hoje}-A.json`, `{hoje}-B.json`, `latest-A.json` e `latest-B.json` presentes,
  com mtime de menos de 36 h (acima disso a API marca `stale: true`);
- nenhum `latest-*.error.json`.

## Quando falha

Falha é lida pelo **exit status**, nunca pelo texto: `message` é fixo
(`shadow_replay_failed`) e o `reason_code` varia (`USAGE`, códigos de
`SweepError`/`ConfigError`, ou o fallback `SHADOW_REPLAY_FAILED`) —
`shadow-replay-cli.ts:809–815`.

O modo que falhou grava `latest-{modo}.error.json` com o `reason_code`, o exit
status e o stderr capturado, e **não encosta** no `latest-{modo}.json` bom. A
tela mostra "rodada de hoje falhou: <reason_code>" em vez de mostrar o número de
ontem como se fosse de hoje. Uma rodada boa apaga o arquivo de erro.

Os dois modos são sempre tentados: o modo B falhar não cancela o modo A.

Ver a falha:

```bash
cat /var/lib/ganso/shadow-replay/latest-B.error.json
journalctl -u ganso-shadow-replay -n 50 --no-pager
```

## Retenção

30 arquivos datados por modo (~60 JSONs pequenos no total). Os `latest-*` nunca
entram na conta. A remoção **nomeia um arquivo por vez** e só aceita nomes que
casam `YYYY-MM-DD-{A|B}.json` sendo arquivos regulares — nunca um glob, nunca o
diretório pai, nunca um symlink com nome parecido. Quem monta a lista é
`deploy/shadow_replay_job.py retention-plan`; quem apaga é o `rm -f --` do
script, uma linha por nome.

## Mexer no horário ou na janela

O horário é o `OnCalendar` do timer, e a janela do modo B é
`GANSO_SHADOW_REPLAY_WINDOW_HOURS` (padrão 72). Ambos foram **decisão do
proprietário (P4)**; mudar é assunto dele, não de operação. O timer tem
`Persistent=false` de propósito: uma rodada de recuperação depois de um reboot
cairia numa hora qualquer, e a hora é justamente o que protege o postgres.

Parar o timer sem desinstalar nada:

```bash
systemctl disable --now ganso-shadow-replay.timer
```

**Pare o timer** se a rodada coincidir com ciclo de portfólio acima de 60 s ou
com o disjuntor `DATA_STALENESS` abrindo na janela do job, e leve a medição ao
proprietário — é condição de parada da RFC-029.

## Em desenvolvimento

O compose aceita `GANSO_SHADOW_REPLAY_HOST_DIR` para apontar o volume a um
diretório gravável na máquina de quem desenvolve; produção usa o padrão
`/var/lib/ganso/shadow-replay`. Sem o diretório, o Docker cria um vazio e a API
responde `404 RUN_NOT_FOUND` a tudo — que é o comportamento certo, não um erro.

Ver o que a rodada faria, sem docker e sem servidor:

```bash
sh deploy/shadow-replay-run.sh --dry-run
```
