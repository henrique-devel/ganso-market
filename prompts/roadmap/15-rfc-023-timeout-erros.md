# RFC-023 — orçamento da API por endpoint, erros com mensagem, `/live-volume` resolvido

Execute a RFC-023 ATÉ O FINAL: re-medição → 3 PRs → merge → CD → rebuild → verificação em
produção → HANDOFF. A RFC é a fonte de verdade (D1–D4, A1–A6, parada); este prompt só a
operacionaliza. Tudo em SIMULAÇÃO: nenhum gate, endpoint de escrita ou migration.
Origem: diagnóstico de 02–03/09/2026 (relatório linkado no cabeçalho da RFC-023).

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-023-orcamento-da-api-e-erros-mudos.md` (D1–D4, aceite, parada)
2. `apps/api/src/database.ts` (`DatabasePool` 12–22; fallback ~40–51; `transaction` = `BEGIN` puro, :90)
3. `apps/api/src/config.ts` (parse de `database` ~200–231 e `services` ~236–275)
4. `apps/api/src/server.ts` (`options.pool` 181–218; `routeOptions.url` :81; `setErrorHandler` 231–238)
5. `apps/api/src/polymarket/overview.ts` (`logOverviewError` 72–81; `Promise.all` 381–458; `app.get` :364, :558)
6. `apps/api/src/polymarket/samplers.ts` (`tryFetch` ~249–263; `/live-volume` ~299–321)
7. `infra/nginx/nginx.conf` (`proxy_read_timeout` :22; locations 88–223)
8. `apps/api/test/polymarket/overview.test.ts` (`fakePool`, teste de 500 ~298–315) e
   `apps/api/test/config.test.ts` (modelo dos testes de config)

Nada além disso, salvo o cabeçalho do `docs/HANDOFF.md` e `git log --oneline -20`. CLIs:
só `grep -n createDatabasePool apps/api/src/*-cli.ts apps/api/src/main.ts`. Sítios do PR 2:
`grep -rn "error_name:" apps/api/src`. Padrão `READ ONLY`: `portfolio/sweepstore.ts:71`.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE no deploy. Nunca imprima
  secrets.
- Deploy em **TRÊS passos**: merge → CD (recria os default; reinicia os de profile **sem
  trocar a imagem**) → rebuild de profile. PR 1: só `api`, o CD basta. PR 2: todos os
  workers — `docker compose --env-file deploy/server.env --profile polymarket up --build
  --detach polymarket-recorder polymarket-estimator polymarket-resolution polymarket-paper
  polymarket-portfolio` (`docker-compose.yml:182-344`). PR 3: mesmo comando, só
  `polymarket-recorder`. Evidência em **cada** container reconstruído:
  `cat /etc/ganso/release-sha` = SHA do merge.
- `make verify` verde antes de cada PR.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Ao final: `docs/HANDOFF.md` e a linha 15 da tabela "Ordem e status" de `prompts/roadmap/README.md` (atualize-a; crie-a se faltar).

## Estado medido (02–03/09; re-verifique)

| Premissa | Como re-medir | Se caiu |
| --- | --- | --- |
| PR-0 (a) mergeado (prompt 11, item a: `occurred_at` → `event_ts` em `overview.ts:466`) | `grep -n "occurred_at >" apps/api/src/polymarket/overview.ts` vazio. **Não** `grep occurred_at` puro: o alias do feed `/events` (`:157,297,600-627`) é legítimo e fica | **PARE** |
| `database.ts:40-41` usa `?? config.database.connectTimeoutMs`; `main.ts:13` sem override | `grep -n queryTimeoutMs apps/api/src/database.ts apps/api/src/main.ts` | adapte a D1 ou pare |
| `connect_timeout_ms = 1000` | `grep -n connect_timeout config/runtime.json` | registre o valor |
| `proxy_read_timeout 5s` | `grep -n proxy_read_timeout infra/nginx/nginx.conf` | teto de D1 = valor − 1 s |
| `SAMPLER_FETCH_FAILED` ~90/15 min | `docker logs ganso-market-polymarket-recorder-1 --since 2h 2>&1 \| grep -c SAMPLER_FETCH_FAILED` | registre o total |
| 549/551 deles com `path: /live-volume` | idem com `\| grep -c live-volume`; divida pelo total | `< 90 %`: outro path falha, registre |
| `live_volume` NULL em 100 % das linhas recentes | SQL de A5 da RFC | `> 0` preenchidos: PR 3 vira registro |
| `/overview` quente: coleta 212,7 ms, modelo 382 ms | `EXPLAIN (ANALYZE, BUFFERS)` em psql direto | insumo da D2, não parada |
| Postgres recriado a cada merge | `docker inspect ganso-market-postgres-1 --format '{{.State.StartedAt}}'` após o CD | frio via `restart postgres`, com o proprietário |

## Escopo

**PR 1 — orçamento (D1 + D2).** Chave `services.api.statement_timeout_ms` (`ceiling`,
`default`, `routes`) validada em `config.ts` (`100 ≤ ms ≤ ceiling ≤ 4000`); `database.ts` sem
fallback (`QUERY_TIMEOUT_UNDECLARED` no boot; apague o comentário defasado de `:31`); API
passa `ceiling`; CLIs declaram (60 s gates/models, 10 s account). Método novo
`DatabasePool.readOnly(ms, run)` sobre `transaction` (`SET TRANSACTION READ ONLY` + `SET LOCAL
statement_timeout`, padrão `sweepstore.ts:71`), usado por toda rota GET publicada com o `ms`
de `routeOptions.config` ou `default`; **cada `pool.query` do `Promise.all` do `/overview` é
sua própria transação orçada** (D1). Nenhum POST envolvido (teste). Teste que lê `nginx.conf`
e falha se rota sob prefixo publicado não declara orçamento. Preencha a tabela D2 (11 rotas, quente e **a frio nos 2 primeiros minutos após o CD**;
regra de orçamento da D1). Consulta que não cabe: reescrita; se exigir
índice novo (migration), registre e pare. Nunca se sobe o teto.

**PR 2 — mensagens (D3).** Helper `errorFields(error)` → `error_name`, `error_message`,
`pg_code`; aplicado aos ~105 sítios de `error_name:`, começando por `overview.ts` (migre o
`message` do PR-0 (a) para `error_message`; `message` volta a rótulo), `paper/api.ts`,
`server.ts:231-238`, `samplers.ts`, `bookpipe.ts`, `trades.ts`. Regressão capturando `stderr`
em `logOverviewError` (falhando antes) e varredura sobre `apps/api/src`. Nenhum payload,
senha ou token no log.

**PR 3 — `/live-volume` (D4).** Primeiro o `curl` real de dentro do servidor (mercado vivo e
resolvido), status + 300 bytes registrados na RFC. Depois **uma** das três saídas da tabela
D4 ("extinto": coluna fica, `LIVE_VOLUME_UNAVAILABLE` uma vez por boot, `live_volume: null`
documentado). Remover o campo da API só com decisão do proprietário.

## Verificação

- `make verify` verde em cada PR; `scripts/tests/test_nginx_perimeter.py` inalterado e verde.
- Após cada deploy: `release-sha` = SHA do merge em **todos** os containers reconstruídos.
  Após o PR 1: `EXPLAIN` a frio nos 2 primeiros minutos.
- Após 24 h do último PR: A1–A6 com os comandos da RFC, números no HANDOFF. A2: o
  proprietário abre todas as abas em ≤ 5 min após o restart; registre o horário.

## Entregável

Três PRs mergeados e verificados; RFC-023 com D2 e D4 preenchidas e status
`implemented (data, PRs)`; HANDOFF com A1–A6; linha 15 do README com o resultado e as premissas que caíram.

## Condições de parada

As da RFC-023, mais duas deste prompt:

- `release-sha` de algum container reconstruído ≠ SHA do merge: não meça A1; refaça o rebuild.
- Qualquer segredo aparecendo num log ao aplicar `error_message`: reverta o sítio.
