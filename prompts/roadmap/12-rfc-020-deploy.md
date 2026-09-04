# RFC-020 — deploy que não derruba o banco

Faça o merge em `main` parar de recriar o Postgres e de matar os workers, ATÉ O FINAL:
re-medição → 4 PRs → merge → CD → rebuild de profile → verificação → HANDOFF. Tudo em
SIMULAÇÃO. Origem: diagnóstico de 02–03/09/2026 (relatório linkado no cabeçalho da RFC-020).

## Contexto mínimo: leia só

1. `docs/rfcs/RFC-020-deploy-sem-derrubar-o-banco.md` — fonte de verdade.
2. `Makefile` (linhas 7–8, 73–77, 161–178).
3. `.github/workflows/ci-cd.yml` (gatilho `:3-8`, job `deploy` `:77-152`, checkout raso `:94-97`).
4. `deploy/remote-deploy.sh` (`:64-66` rollback, `:159-162` `apply_release`).
5. `scripts/tests/test_validate_release.py:11-15` — como um teste importa módulo de `deploy/` (`spec_from_file_location`); copie em `test_deploy_paths.py`.
6. `apps/api/src/database.ts:36-60` (`createDatabasePool`) e `apps/api/test/database.test.ts`.
7. `apps/api/src/polymarket-recorder.ts` (boot, 68 linhas).
8. `apps/api/src/polymarket/bookpipe.ts` (`:12-20`, `:247`, `:329-378`) e `apps/api/test/polymarket/bookpipe.test.ts`.
9. `apps/api/src/polymarket/orchestrator.ts` (`:106-140`, `:221-238`, `:467-474`) e `apps/api/test/polymarket/orchestrator.test.ts`.

Só no PR 4: `polymarket/quality.ts:87-127`, `polymarket/retention.ts:617-625` e
`retention.test.ts`. `docker-compose.yml` só `:10`, `:37-57`, `:88-106`, `:182-205`.
`prompts/roadmap/README.md` só a tabela "Ordem e status"; `docs/HANDOFF.md` só o fim
(~200 linhas) e `:2840-2846`.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (`/opt/ganso-market`). Escrita SOMENTE nos passos de deploy. Nunca imprima secrets.
- Fim do HANDOFF e `git log -n 20` antes: parte já entregue → adapte ou pare.
- Deploy em **três passos**: merge → CD → rebuild de profile no servidor, comando literal
  (`make recorder-up` NÃO serve: `Makefile:115-116` roda `init-secrets` e ignora `deploy/server.env`):
  `cd /opt/ganso-market && docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-recorder polymarket-estimator polymarket-resolution polymarket-paper polymarket-portfolio`.
  O PR 3 muda `database.ts`, imagem dos **cinco** workers: rebuild dos cinco, ou o aceite de
  `RestartCount`/"Unhandled" não vale. Evidência é `/etc/ganso/release-sha` **dentro** de
  cada container; `compose ps` mente.
- `make verify` verde antes de cada PR. Prova da regressão: `git stash` do fix, rode, mostre a
  saída (no PR 1 é o assert de `test_server_update_target.py` sobre `--force-recreate` sem lista
  de serviços).
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Ao final: `docs/HANDOFF.md` e a linha 12 da tabela "Ordem e status" de `prompts/roadmap/README.md` (atualize-a; crie-a se faltar).

## Estado medido (02/09/2026; re-verifique)

Re-meça as 10 linhas de "Fatos medidos" da RFC. Decisivas:

| Premissa | Como re-medir |
| --- | --- |
| Postgres recriado a cada deploy | `docker inspect --format '{{.Created}}' ganso-market-postgres-1` vs `ls .deploy/backups` |
| 19 deploys/24 h; só texto: 6 (`docs/**`) / 10 (critério de D2); o recorte disse 7, sem critério | `gh run list --workflow CI/CD --branch main`; `git log --first-parent -n 19 --name-only` |
| Pool sem `on("error")` | `grep -rn '\.on("error"' apps/api/src` (só `recorder.ts:175`; sem o `\.` casa todo `logJson("error"`) |
| Workers morrem com o banco (`RestartCount` 31/30/9/8/3) | `docker logs --since 24h ganso-market-polymarket-<nome>-1 \| grep -c Unhandled` nos cinco; `docker inspect` |

`Created` do postgres já **não** muda → PR 1 é no-op: registre e siga.

## Escopo (um PR por linha; detalhes na RFC)

1. **D1 — `Makefile`:** `server-update` sobe `postgres` sem `--force-recreate`, roda
   `run --rm migrate` literal, depois
   `up --detach --force-recreate --no-deps --remove-orphans --wait --wait-timeout 180 api web nginx market-engine`.
   Teste `scripts/tests/test_server_update_target.py` sobre `make -n server-update`. Prova
   local: dois `make server-update`, `Created` do postgres igual.
2. **D2 — `ci-cd.yml` + `deploy/deploy_paths.py`:** passo `paths` no job `deploy`, checkout
   com `fetch-depth: 0`; pula quando todos os arquivos alterados casam `docs/**`, `prompts/**`,
   `*.md` raiz, `.claude/**`. **Fail-safe:** `before` zerado, `git diff` com erro ou lista
   vazia ⇒ deploya. Passos seguintes com `if: steps.paths.outputs.deploy == 'true'`.
   `workflow_dispatch` nunca pula; `on.push` intocado. Teste `scripts/tests/test_deploy_paths.py`
   (casos da RFC, inclusive erro do git).
3. **D3 — `database.ts`:** `pool.on("error", …)` com log `DB_POOL_CLIENT_ERROR`. Sem
   reconexão manual. Teste com `vi.mock("pg")`. Rebuild dos cinco.
4. **D4 — recorder:** os quatro itens de D4 da RFC (espera do banco, lote com 1 retry,
   lacuna com retry, retenção reagendada). Testes em `bookpipe.test.ts`, `orchestrator.test.ts`,
   `retention.test.ts`. Se crescer: 4a/4b como na RFC.

Fora do escopo: DP3 (workers no CD); lacunas de snapshots/registry/RTDS.

## Verificação em produção

Critérios e comandos: "Critérios de aceite" da RFC. Ordem:

- **PR 1:** colha `Created` do postgres e `pg_postmaster_start_time()` ANTES do merge. O deploy
  do PR 1 já roda o Makefile novo (`apply_release` sincroniza antes do `make server-update`,
  `remote-deploy.sh:159-162`): compare logo após; o merge de código seguinte confirma.
- **PR 2:** merge docs-only → `Deploy production` em sucesso com "deploy pulado: só texto";
  sem login da chave restrita; `.deploy/current-sha` inalterado.
- **PR 3:** rebuild dos cinco, `release-sha` conferido em cada um; `RestartCount` e "Unhandled"
  por container iguais antes/depois do merge seguinte.
- **PR 4:** teste controlado da RFC (`stop postgres` 5 s com o recorder vivo): recorder não
  reinicia; lacuna `internal/delta_persist_failed` com `dropped`; retenção reagendada no log.

## Entregável

- 4 PRs mergeados (ou 5), cada um com teste verificado falhando.
- Números reais de produção no HANDOFF; linha 12 do README com status e premissas caídas.
- RFC-020 com Status `implemented (data, PRs)`.

## Condições de parada

- DP1 e DP2 não aprovadas por escrito no HANDOFF: não abra PR 1 nem PR 2.
- Nenhuma forma do `server-update` mantém o `Created` do postgres em Compose local.
- Classificador pula deploy com arquivo fora das listas ou por erro de ferramenta.
- Reconexão manual, `catch` que engole erro de query, gate tocado.
- `make verify` vermelho; teste que não falha no código anterior; premissa caiu.
