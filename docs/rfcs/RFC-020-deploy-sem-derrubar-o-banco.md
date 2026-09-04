# RFC-020 — Deploy que não derruba o banco: o merge deixa de recriar o Postgres e de matar os workers

**Status:** draft — aguardando aprovação do proprietário (2026-09-03)
**Dependências:** RFC-001 (runtime e Compose), RFC-007 (recorder, `polymarket_data_gaps`, retenção), RFC-010 (`release-sha` na imagem, provenance); convenção de deploy em três passos em `prompts/roadmap/README.md`
**Habilita:** um merge em `main` que não custa ~1,5–12,7 s de banco fora, ~4,4–5,6 mil deltas perdidos e um crash-loop dos workers; um `polymarket_data_gaps` que registra a lacuna que ele mesmo hoje perde; docs que não disparam deploy
**Origem:** diagnóstico operacional de 2026-09-02 (relatório publicado: <https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6>; leitor de ops, seções 1 e 6; céticos 21, 23–28)

## Prompt a executar

`prompts/roadmap/12-rfc-020-deploy.md`. Quatro PRs pequenos, cada um com seu teste de
regressão verificado falhando no código anterior. Tudo em SIMULAÇÃO: nenhum gate muda,
nenhum endpoint de escrita nasce, nenhuma migration aplicada muda.

---

## Fatos medidos (2026-09-02; RE-MEDIR antes de codar)

| Fato | Medido | Origem |
| --- | --- | --- |
| `server-update` recria os 6 serviços default, Postgres incluído | `up --detach --force-recreate --remove-orphans --wait` sem `--profile`; `docker compose config --services` = 6 em produção | `Makefile:174-178`, `Makefile:8`; `docker inspect postgres-1` `Created=14:51:45.97Z` |
| O Postgres não mudou de config e ainda assim foi recriado | `config --hash postgres` = label `com.docker.compose.config-hash` do container atual | cético 25; imagem por digest em `docker-compose.yml:11` |
| Janela sem banco por deploy | 1,55 / 8,38 / 3,35 / 12,67 / 11,42 s nos 5 deploys de 02/09 (maior buraco em `received_at` de `polymarket_book_deltas`, controle 1,80 s); o "~11,5 s" do recorte é o deploy das 14:51, não divergência | cético 25; log do postgres "shut down at 14:51:46", `pg_postmaster_start_time()` 14:51:57.5Z |
| Deploys em 24 h | **19** (19 runs `Deploy production`, 19 logins da chave restrita, 19 rajadas no `docker.service`). Só texto, recontado em `git log --first-parent -n 19 --name-only` (07db041→ef7ca2d, 01/09 12:03 → 02/09 11:44 −03; 04/09): **6** tocam só `docs/**`; **10** casam o critério de D2 (`docs/**`, `prompts/**`, `.claude/**`, `*.md`) — os 4 a mais tocam `prompts/roadmap/README.md`. O "7 docs-only" do recorte (02/09) não registra critério; premissa de D2 é o **10** | cético 24; `.deploy/backups` guarda só 5 (`remote-deploy.sh:79`) |
| CD sem filtro de caminho | `on.push.branches: [main]`, sem `paths`/`paths-ignore` | `.github/workflows/ci-cd.yml:3-8`, job `deploy` `:77-88` |
| Pool do pg sem `on("error")` | o único `.on("error")` em `apps/api/src` é o do WebSocket (`polymarket/recorder.ts:175`) | `apps/api/src/database.ts:36-60` |
| Efeito: "Unhandled 'error' event" a cada queda do banco | portfolio 8, resolution 9, paper 9, estimator 8, recorder 3 (02/09); `RestartCount` 31 / 30 / 9 / 8 / 3 | cético 28; `docker inspect` |
| Deltas perdidos por deploy | ~4,4 mil (14:47, 12,7 s × ~350/s) e ~5,6 mil (14:51, 11,4 s × ~490/s); 32 lotes de deltas com INSERT falho por janela, sem retry | cético 26; `bookpipe.ts:329-378` (`flushDeltaBatch`), `DEFAULT_DELTA_FLUSH_MS = 250` (`bookpipe.ts:16`) |
| A lacuna não é gravada | 63 `GAP_PERSIST_FAILED` contra **1** linha `internal/delta_persist_failed` (gap 100512, `dropped: 86`); o log não carrega `dropped` | `orchestrator.ts:221-238`, `quality.ts:111-127` (mesmo pool); `orchestrator.ts:234` |
| Retenção roda no boot e a rodada se perde | `runAtBoot: true`; nos boots de 14:47 e 14:51, 100 `RETENTION_STEP_FAILED` (`EAI_AGAIN postgres`); próxima tentativa só em 24 h | `orchestrator.ts:106-118`, `:467-474`; `retention.ts:1646` (`runOnce`) |
| `release-sha` está dentro da imagem | `COPY deploy/release-sha /etc/ganso/release-sha`; `git archive` reescreve via `export-subst` | `apps/api/Dockerfile:26`, `.gitattributes` |

Registrado em HANDOFF desde 23/08 (`docs/HANDOFF.md:3511-3517`, rajada `EAI_AGAIN` de
01:59Z) e nunca corrigido. Não é rede nem venue: é a flag no Makefile e um handler que
falta.

---

## Decisões do proprietário que esta RFC exige

| # | Decisão | O que muda para o proprietário |
| --- | --- | --- |
| DP1 | O Postgres **não** é recriado no deploy | "Todo merge reinicia tudo" deixa de valer. Trocar a imagem do Postgres passa a ser ato deliberado: mudar o digest em `docker-compose.yml:11` e rodar `make server-update` (o `up` sem `--force-recreate` recria só o que mudou) |
| DP2 | Merge que toca só texto **não** gera deploy | O checkout em `/opt/ganso-market` fica com docs defasadas até o próximo merge de código; `workflow_dispatch` continua deployando sempre. `verify` e `integration` continuam rodando em todo push |
| DP3 (futura, não nesta RFC) | Pôr os workers de profile no CD | Exige tirar o `release-sha` da imagem (`Dockerfile:26`), senão todo merge recria os 5 workers. Fica registrada; o "terceiro passo" manual continua |

Sem DP1 e DP2 aprovadas, o prompt não roda.

---

## Decisões desta RFC

### D1 — `server-update` recria só o que o merge muda

O alvo passa a três `up` em ordem, cada um com `--wait`:

1. `postgres` — `up --detach --wait` **sem** `--force-recreate`. Com imagem por digest e
   config estável, o Compose não o toca (config-hash igual, medido).
2. `migrate` — `run --rm migrate`, literal (não `up`: `migrate` tem `restart: "no"` e
   termina, `docker-compose.yml:57`; `up --wait` sobre container que sai varia com a versão
   do Compose; `run` propaga o exit code e o `make` para). Antes de qualquer serviço de
   código. O CD **continua** aplicando migrations.
3. `api web nginx market-engine` — `up --detach --force-recreate --no-deps --remove-orphans --wait --wait-timeout 180`.
   `--no-deps` existe porque `api`, `market-engine` e os workers têm `depends_on: migrate:
   service_completed_successfully` (`docker-compose.yml:104-106`) e `--force-recreate` com
   lista arrastaria `migrate` e `postgres`; o passo 1 e o 2 já garantem banco e schema.

`deploy/healthcheck.sh` fecha como hoje. O rollback (`remote-deploy.sh:65`, `make server-up`)
já não usa `--force-recreate` e não muda. A forma exata é a que o teste prova: um
`make -n server-update` cujo único `--force-recreate` lista serviços e não inclui `postgres`,
com a linha literal `run --rm migrate` antes dele, mais uma rodada local do Compose em que `docker inspect --format '{{.Created}}' postgres`
não muda entre dois `make server-update`.

### D2 — filtro de caminho no job `deploy`, não no gatilho

Um passo `paths` no job `deploy` lista os arquivos alterados entre `github.event.before` e
`github.sha` e classifica: se **todos** casam `docs/**`, `prompts/**`, `*.md` na raiz ou
`.claude/**`, o deploy é pulado com uma linha explícita no log ("deploy pulado: só texto").
Pré-condições que o PR 2 fixa:

- O checkout do job `deploy` (`ci-cd.yml:94-97`) é raso e só tem `github.sha`; `git diff
  before..sha` falha. O passo ganha `fetch-depth: 0` (mesma action, mesmo SHA pinado).
- **Fail-safe:** `before` ausente ou `0000000…` (first/force push), `git diff` com erro,
  lista vazia ou qualquer exceção do script ⇒ `deploy=true`. Só uma lista não vazia e 100 %
  texto pula. Um falso "só texto" é pior que 19 deploys.
- Os passos seguintes do job levam `if: steps.paths.outputs.deploy == 'true'`; o job termina
  em sucesso com a linha no log, nunca como falha nem `skipped` mudo.

`workflow_dispatch` nunca é pulado. O classificador é um script Python em `deploy/`
(testável por `python -m unittest discover -s scripts/tests`), não uma action de terceiro —
o workflow só pina actions por SHA e não ganha dependência nova. O gatilho `on.push` fica
como está: `verify` e `integration` rodam em todo push (o recorte exige manter `verify`).

### D3 — `pool.on("error")` em `createDatabasePool`

`apps/api/src/database.ts` registra o handler no `Pool`: log estruturado
(`reason_code: DB_POOL_CLIENT_ERROR`, `error_name`, `detail`, `application_name`) e nada
mais. O `pg` remove o cliente com erro do pool sozinho; a próxima `query()` abre conexão
nova. **Nenhuma reconexão manual é escrita**: o que falta é o handler, não a lógica. Vale
para api e todos os workers, que já passam pelo mesmo `createDatabasePool`. Falha de
**boot** (`run().catch` dos entrypoints, `process.exitCode = 1`) continua fatal: fail-closed.

### D4 — o recorder espera o banco, guarda a lacuna e reagenda a retenção

1. **Boot:** antes de `orchestrator.start()` o recorder espera `SELECT 1` no pool com
   backoff limitado (≤ 60 s). Esgotado, sai com `reason_code` próprio e o Docker reinicia
   (`restart: unless-stopped`, `docker-compose.yml:205`): banco fora vira loop de restart
   com backoff do Docker, aceitável porque nenhum WS é assinado antes do banco responder.
2. **Lote de deltas com INSERT falho:** volta **uma** vez à cabeça da fila (sob o
   `deltaQueueMax` já existente, que segue gerando `delta_queue_overflow`); segunda falha
   é perda definitiva e chama `onPersistFailure` como hoje. `BOOKPIPE_PERSIST_FAILED`
   passa a carregar `count`.
3. **Lacuna:** `onPersistFailure` enfileira a lacuna em memória (fila limitada, janelas
   coalescidas) e um job de retry a grava quando o pool voltar (intervalo ~1 s, ≤ 120
   tentativas). Esgotado, `GAP_PERSIST_FAILED` **carrega `dropped`, `window_start`,
   `window_end`** — o número deixa de ser irrecuperável.
4. **Retenção:** se a rodada de boot falhar em algum passo (a `RetentionRunReport`
   ganha `failedSteps`; hoje `retention.ts:617-625` não expõe falha), o scheduler agenda
   **uma** nova tentativa em 10 min, em vez de esperar o intervalo de 24 h.

Fora do escopo, registrado: snapshots, `universe_log`, registry e RTDS perdidos na mesma
janela não geram lacuna (`bookpipe.ts:247` conta e segue). Com D1 a janela deixa de existir
no deploy; abrir lacunas para essas tabelas é RFC própria.

---

## Escopo, em PRs

| # | Item | Arquivos | Teste obrigatório |
| --- | --- | --- | --- |
| 1 | D1 — `server-update` sem recriar o Postgres | `Makefile` | `scripts/tests/test_server_update_target.py`: `make -n server-update` tem exatamente um `--force-recreate`, com lista de serviços, sem `postgres`, precedido por `migrate`; falha no Makefile atual |
| 2 | D2 — filtro de caminho no job `deploy` | `.github/workflows/ci-cd.yml`, `deploy/deploy_paths.py` (novo) | `scripts/tests/test_deploy_paths.py` (importa o módulo como `test_validate_release.py:11-15`): lista só-texto → pula; lista com `apps/api/src/x.ts` → deploya; `docs/` + `Makefile` → deploya; vazia, `before` zerado ou `git diff` com erro → deploya |
| 3 | D3 — `pool.on("error")` | `apps/api/src/database.ts` | `apps/api/test/database.test.ts`: `vi.mock("pg")` com `Pool` = `EventEmitter`; `emit("error")` não lança e loga `DB_POOL_CLIENT_ERROR`; no código anterior lança |
| 4 | D4 — recorder: espera, retry do lote, lacuna com retry, retenção reagendada | `apps/api/src/polymarket-recorder.ts`, `polymarket/bookpipe.ts`, `polymarket/orchestrator.ts`, `polymarket/retention.ts` | `bookpipe.test.ts`: INSERT falha 1× → lote regravado, `deltasFlushed` conta; 2× → `onPersistFailure`. `orchestrator.test.ts`: `recordInstantGap` rejeita 3× e resolve → 1 linha com `dropped` igual; esgotado → log com `dropped`. `retention.test.ts`: passo falho → `failedSteps > 0`; scheduler agenda retry |

PR 1 e 2 não tocam código de aplicação. PR 3 é uma linha e um teste, mas `database.ts`
entra na imagem dos **cinco** workers de profile: o terceiro passo do PR 3 é o rebuild dos
cinco (`docs/HANDOFF.md:2843-2846`), não só do recorder. PR 4 é o único com lógica; se
estourar, dividir em 4a (boot + lacuna) e 4b (lote + retenção).

## Critérios de aceite (em produção, após merge + CD + rebuild dos 5 workers de profile)

| Critério | Como verificar |
| --- | --- |
| Merge docs-only não gera deploy | run do CD com `Deploy production` em sucesso e a linha "deploy pulado: só texto" no log do passo `paths`; `journalctl _COMM=sshd` sem login da chave restrita naquele minuto; `.deploy/current-sha` inalterado |
| Merge de código não recria o Postgres | `docker inspect --format '{{.Created}}' ganso-market-postgres-1` igual antes e depois; `pg_postmaster_start_time()` inalterado; api/web/nginx/market-engine com `Created` novo |
| Migration continua aplicada pelo CD | `migrate` aparece no log do deploy; `SELECT max(version) FROM schema_versions WHERE component = 'foundation'` = última migration do repositório (`infra/migrations/apply.sh:85`) |
| Zero erro no minuto do deploy | `docker logs --since` do recorder no minuto: `RETENTION_STEP_FAILED` = 0, `BOOKPIPE_PERSIST_FAILED` = 0, `GAP_PERSIST_FAILED` = 0 |
| Workers não caem no deploy | só vale com `/etc/ganso/release-sha` do PR 3 nos 5 containers; `RestartCount` dos 5 igual antes e depois; zero "Unhandled 'error' event" por container (`ganso-market-polymarket-portfolio-1` etc.) |
| Lacuna registrada quando houver perda | teste controlado fora do deploy (parar o postgres 5 s com o recorder vivo): soma de `dropped` em `polymarket_data_gaps` (`internal/delta_persist_failed`) ≥ lotes falhos × 1, e `GAP_PERSIST_FAILED` esgotado sempre com `dropped` |

## Condições de parada

- DP1 ou DP2 não aprovadas por escrito no HANDOFF.
- Nenhuma forma do `server-update` prova, em Compose local, que o `Created` do postgres não
  muda entre duas rodadas: parar e trazer o `docker compose` observado, não uma teoria.
- O filtro de caminho pular um deploy com mudança fora das listas (qualquer arquivo não
  Markdown fora de `docs/`, `prompts/`, `.claude/`) ou por erro de ferramenta (`before`
  nulo, diff falho): parar; um falso "só texto" é pior que 19 deploys.
- Qualquer tentação de "reconectar" manualmente no `database.ts` ou de engolir erro de
  query: só o handler de cliente ocioso entra.
- Re-medição mostrar que o `Created` do postgres já não muda no deploy (alguém consertou
  antes): PR 1 vira no-op, registrar e seguir para o 2.
- `make verify` vermelho; teste de regressão que não falha no código anterior.
