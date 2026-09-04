# RFC-029 — Tela Sombra: shadow replay por job diário + JSON em volume só-leitura

Leve a RFC-029 ATÉ O FINAL: código → testes → merge → CD → rebuild → verificação no servidor
e no navegador → HANDOFF. **Nenhuma escrita no banco por nenhum caminho novo.** Tudo em
SIMULAÇÃO. A RFC é a fonte de verdade (D1–D5, testes, aceite, paradas); este prompt só a executa.
Origem: diagnóstico de 02–03/09/2026 (relatório linkado no cabeçalho da RFC-029; layout: canvas da RFC-026).

## Contexto mínimo: leia só…

Núcleo (antes de tudo):

1. `docs/rfcs/RFC-029-tela-sombra-shadow-replay.md`.
2. `docs/rfcs/RFC-017-polymarket-shadow-replay.md` linhas 150–176 — o que é emendado e o que não.
3. `docs/HANDOFF.md` primeiras 60 linhas e `git log --oneline -15`.

Só ao começar cada PR:

- PR 1: `apps/api/src/shadow-replay-cli.ts` linhas 697–828; `docker-compose.yml` linhas 88–125.
- PR 2: `apps/api/src/polymarket/portfolio/api.ts` (`app.get` + `preHandler: guard`);
  `apps/api/src/config.ts` linhas 1–40; `infra/nginx/nginx.conf` linhas 120–140 e 186–230;
  `scripts/tests/test_nginx_perimeter.py`.
- PR 3: `apps/web/src/App.tsx` linhas 200–300; `apps/web/src/portfolio.ts` linhas 270–330
  (cliente HTTP: sessão, `AbortSignal`, 401); `apps/web/src/dicionario.ts` linhas 182–226;
  `apps/web/test/portfolio.test.ts`.

Nada além disso. Se precisar de outro arquivo, anote o motivo no HANDOFF.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE no deploy e na
  instalação do timer (após P2). Nunca imprima secrets.
- Deploy em TRÊS passos: merge → CD (`deploy/remote-deploy.sh`; reinicia containers de
  profile **sem trocar a imagem**) → `make server-update` (recria `api` **e** `nginx`; a
  location nova só vale aqui). Evidência de revisão: `/etc/ganso/release-sha` no container.
- `make verify` verde antes de cada PR.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Ao final: `docs/HANDOFF.md` e **adicionar a linha do prompt 21** na tabela "Ordem e status" de `prompts/roadmap/README.md` (hoje não existe — mesma convenção dos prompts 19 e 20b).

## Estado medido (03/09/2026 — re-verifique)

| Premissa | Medido | Como re-medir |
| --- | --- | --- |
| CLI read-only, dois modos, `--format json`, só stdout; sem rota nem tela | `sweepstore.ts:61–75`; `shadow-replay-cli.ts:697–703`, `:780–795` | `grep -rn shadow-replay` em `api.ts`, `readapi.ts`, `nginx.conf` vazio |
| Falha do CLI: `exitCode = 1` e `message: "shadow_replay_failed"` fixos; `reason_code` **varia** (`USAGE`, `SweepError`, `ConfigError`, fallback `SHADOW_REPLAY_FAILED`) | `shadow-replay-cli.ts:809–815`, `:823`, `:827` | `sed -n 805,828p` |
| `api` monta só `runtime.json:ro`; `environment:` só tem `GANSO_CONFIG_FILE` e `GANSO_POSTGRES_PASSWORD_FILE` | `docker-compose.yml:93–98` | `sed -n 88,100p` |
| `make server-update` recria tudo | `Makefile:174–177` (`--force-recreate`) | `grep -n force-recreate Makefile` |
| Modo B por SSH sem keepalive morre | exit 255 aos 1.646 s / 1.268 s; destacado: 710 s | não repita por SSH; `nohup setsid` |
| Modo B janela cheia | 258.805 → 33.113 → 10.058 → 2.706 → 2.672 → 511; +US$ 401,25; 38 mercados | `latest-B.json` da primeira rodada |
| Modo A `costs.edgeLiqMin` | 0,01 → +64/10; 0,015 → +37/6; 0,03 → −35/8; 13 viradas 0,0201–0,0232 | `latest-A.json` |
| `BASELINE_ALREADY_SHADOW` | 159 (vazamento `store.ts:179–190`; fora do escopo) | `exclusions` no JSON |
| Nginx `proxy_read_timeout 5s`; `^~ /api/polymarket/gates` GET-only | `nginx.conf:22`, `:129–136` | `grep -n` |
| RFC-026 em produção? | `accepted` em 04/09, ainda não implementada (tecla `4`, `RFC-026:88`) | `git log --oneline \| grep -i 026` — decide P5 |

Antes do PR 1, confirme no HANDOFF que **P1, P2 e P3 estão aprovados**.

## Escopo (3 PRs, cada um com seus testes; detalhe em D1–D4 da RFC)

**PR 1 — job no host + volume (D1, D2).** `deploy/systemd/ganso-shadow-replay.{service,timer}`
(`OnCalendar` 03:30Z ou P4) e `deploy/install-shadow-replay-timer.sh` idempotente com
`--dry-run`; tudo como a D2 (o `.error.json` nasce do **exit status ≠ 0**, não do stderr).
No serviço `api` do compose: volume `:ro` **e** env `GANSO_SHADOW_REPLAY_DIR` com o caminho
de montagem. Teste `scripts/tests/test_shadow_replay_job.py` (RFC, "Testes obrigatórios";
`make test` já descobre `scripts/tests`, `Makefile:77`). Runbook `docs/ops/SHADOW_REPLAY_JOB.md`.
Instale no host **só depois** do merge; `systemctl start` uma vez; confira os dois arquivos.

**PR 2 — endpoints de disco + perímetro (D3).** `GET /polymarket/shadow-replay/latest?mode=A|B`
e `/runs` em `portfolio/api.ts`, `preHandler: guard`, allowlist, env (padrão `config.ts:4`)
e códigos da D3 — sem a env tudo é 404, e o teste cobre isso. Nginx: `location ^~`
GET-only no padrão de `/gates`; `test_nginx_perimeter.py` ganha a asserção. Testes em
`api.test.ts` com diretório temporário.

**PR 3 — tela Sombra (D4).** Só com P5 resolvido. `apps/web/src/Sombra.tsx` + `sombra.ts`
(parser tipado; nada de `any`). Tudo como a D4; `.error.json` → "rodada de hoje falhou".
**Sem botão** algum. Polling 60 s com `AbortController`. Testes em `apps/web/test/Sombra.test.tsx`; a fixture é o **arquivo real** `latest-B.json` da primeira
rodada, em `apps/web/test/fixtures/`.

## Verificação

- A tabela "Critérios de aceite" da RFC, comando a comando: `ExecMainStatus` = 0 e
  `journalctl` sem `shadow_replay_failed`; 401/200/404 de dentro do servidor (mais `mode=C`
  → 400 e `POST /paper/intents` segue 404); `docker stats` e `PORTFOLIO_CYCLE` na janela.
- Navegador: números do `latest-B.json` do dia, proveniência e ressalvas; release-sha no rodapé.
- Grep de `INSERT|UPDATE|DELETE` no diff de cada PR (fora de `test/`) vazio. Zero migration.

## Entregável

Três PRs verificados em produção; timer instalado com uma rodada completa; runbook; HANDOFF
com os números da primeira rodada (inclusive durações dos `PORTFOLIO_CYCLE` na janela),
premissas que caíram e o que ficou para a RFC-030; linha do prompt 21 no README.

## Condições de parada

As da RFC-029 ("Condições de parada"), sem exceção, mais: premissa da tabela acima
desmentida sem registro no HANDOFF.
