# RFC-029 — Tela Sombra: shadow replay publicado por job diário e JSON em volume só-leitura

**Status:** draft — aguardando aprovação do proprietário (2026-09-03)
**Dependências:** RFC-017 (CLI `shadow-replay`, em produção desde PRs #72/#73) **com emenda de escopo leve aprovada** (P1); RFC-015 (dicionário PT em `apps/web/src/dicionario.ts`, em produção); RFC-026 (aba nova e tecla `4` reservada à Sombra — `docs/rfcs/RFC-026-painel-home-broker.md:88`, draft); aprovação do job no host e do volume no compose (P2, P3)
**Habilita:** os números do shadow replay deixam de existir só no stdout em inglês de uma sessão SSH e passam a ser lidos em português, todo dia, com as ressalvas fixas na tela; base de leitura para a decisão sobre a config 1.3.0 e para a RFC-030 (cortes por mercado/forma/modelo, persistência)
**Origem:** diagnóstico operacional de 02–03/09/2026 — https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6 (leitor do shadow replay, claims C1–C9; síntese de UI, seção 5 "Tela Sombra"). Layout: canvas da RFC-026 (link no cabeçalho dela), só para layout

## Prompt a executar

`prompts/roadmap/21-rfc-029-tela-sombra.md`. Tudo em SIMULAÇÃO. **Nenhuma escrita no
banco por nenhum caminho novo.** Nenhum gate afrouxa, nenhuma migration, nenhum endpoint
de escrita novo, nenhum botão de promoção de modelo.

---

## Fatos medidos (03/09/2026 — RE-MEDIR antes de codar)

### O que o CLI é hoje

| Fato | Valor | Origem (conferida em 03/09) |
| --- | --- | --- |
| Read-only por construção: allowlist de statement (`READ_PREFIX`/`WRITE_ANYWHERE`) + `SET TRANSACTION READ ONLY` por statement | duas barreiras independentes | `apps/api/src/polymarket/portfolio/sweepstore.ts:42–43`, `:61–75` (`readOnlyPool`) |
| Dois modos: `sweep <chave> --values a,b,c` (A) e `source-replay` (B); `--from/--to` ISO; `--format table\|json` | — | `apps/api/src/shadow-replay-cli.ts:697–703` (USAGE), `:728–730`, `:738–739` |
| Saída **só em stdout**; não persiste, não expõe endpoint nem tela; texto em inglês | — | `shadow-replay-cli.ts:780–795`; nenhuma rota em `portfolio/api.ts` nem `readapi.ts`; nenhuma `location` em `infra/nginx/nginx.conf` |
| Falha sai com `exitCode = 1` e `message: "shadow_replay_failed"` fixos; o `reason_code` **varia** (`USAGE`, códigos de `SweepError`/`ConfigError`, fallback `SHADOW_REPLAY_FAILED`) | o job lê o exit status, não o texto | `shadow-replay-cli.ts:809–815`, `:823`, `:827`; `:729` (`USAGE`) |
| Proveniência já no JSON: `decision_log_window`, `closed_at_decision_id`, versões/hashes de config, `model_ids` | — | `shadow-replay-cli.ts:572–583` |
| RFC-017 "Não é objetivo": publicar endpoint, tabela ou painel | 2 linhas | `docs/rfcs/RFC-017-polymarket-shadow-replay.md:154–155` |
| RFC-017 restrições não negociáveis 1–6 (replay intocado, nenhuma escrita, nunca cunhar config, um construtor de linha, baseline `MATCHED`, streaming) | 6 itens | `RFC-017:156–173` |

### Rodadas de 03/09 (produção, read-only; o que a tela vai mostrar)

| Modo B, janela cheia (`--to 2026-09-03T10:08:58Z`, 710 s) | Valor |
| --- | --- |
| Funil: vistas → admitidas → alcançam a estimativa → agiriam diferente → aceitas só pela sombra → liquidadas | 258.805 → 33.113 → 10.058 → 2.706 → 2.672 → 511 |
| Mercados em que a sombra agiria diferente | 38 de 63 (60,3 %) |
| Transições dominantes | `LOWER_BOUND_BELOW_COSTS → ACCEPTED` 2.022; `PRICE_OUT_OF_BAND → ACCEPTED` 557 |
| PnL contrafactual (HIPOTÉTICO) | 414 V / 97 D; líquido **+US$ 401,25** |
| Exclusão `BASELINE_ALREADY_SHADOW` | **159** (vazamento do `estimateAsOf`, `portfolio/store.ts:179–190`, sem filtro de `status`) |
| Janela de 01/09 re-rodada (`--to 2026-09-01T14:25:00Z`) | 353 de 515 liquidadas, 300 V / 53 D, **+US$ 324,55** — em **≤ 9 mercados** |

| Modo A `costs.edgeLiqMin` (`--to 2026-09-03T09:41:29Z`, 118 s) | AÇÃO (linhas/mercados) |
| --- | --- |
| 0,010 | +64 / 10 (29 nascem `SIZE_BELOW_MIN_ORDER`) |
| 0,015 | +37 / 6 |
| 0,020 (gravado) | 0 / 0 |
| 0,030 | −35 / 8 |
| Valores de virada de AÇÃO | 13, entre 0,0200926 e 0,0231811 (`sweep.ts:841` `breakevenValue`) |

### Ressalvas que a tela imprime sempre (medidas, não opinião)

- O PnL soma **linhas** (uma por minuto por mercado), não posições: sem dedup, sem `caps.*`
  (`sourcereplay.ts:192` `counterfactualPnl` itera entradas sem agrupar). 353 liquidadas em
  ≤ 9 mercados; 511 em ≤ 38.
- O as-of mistura as sombras `1.0.0` e `1.1.0` (`model_ids` com 2 itens): "modelos misturados — não usar para promoção".
- Zero decisões alcançáveis nas famílias "sobe ou desce" horária/diária: o modo B mede terminal e barreira.
- Modo B lê `fundamental_estimates`/`fundamental_labels`, tabelas com TTL/quota: **não é auditoria**.

### Operacional

| Fato | Valor | Origem |
| --- | --- | --- |
| Modo B via `ssh … docker compose exec -T` sem keepalive morre em silêncio | exit 255 aos 1.646 s e 1.268 s; `oom_kill 0`; pico 218 MB de 384 MiB | leitor §2.4; `docker-compose.yml:121` (`mem_limit: 384m`) |
| Rodada destacada (`nohup setsid`) termina | 710 s | leitor §2.4 |
| Postgres durante o as-of | ~100 % de um core; consulta de livro do portfólio vista a 22 s (contenção plausível, não provada) | leitor §1, claim C9 |
| Serviço `api` só monta `config/runtime.json:ro` | 1 volume | `docker-compose.yml:97–98` |
| `make server-update` recria todos os containers (`up --force-recreate`) | volume fora do compose versionado some no rebuild | `Makefile:174–177` |
| Nginx: `proxy_read_timeout 5s`; padrão GET-only de prefixo | `location ^~ /api/polymarket/gates` | `infra/nginx/nginx.conf:22`, `:129–136` |
| API roda toda query sob `statement_timeout = 1000 ms` | ler disco evita o problema | `apps/api/src/database.ts:51`; memória "timeout de 1 s" |
| Nenhuma unidade systemd versionada hoje | `deploy/` tem só scripts de instalação/CD | `ls deploy/` |

---

## Decisões desta RFC

### D1 — publicar por ARQUIVO, não por tabela

O CLI continua a única coisa que lê o banco, e continua read-only. O resultado vai para
`/var/lib/ganso/shadow-replay/{YYYY-MM-DD}-{A|B}.json` e `latest-{A|B}.json`, gravados de
forma atômica (arquivo temporário no mesmo diretório + `rename`). A API monta o diretório
`:ro` e serve o conteúdo. **Nenhuma das seis restrições da RFC-017 muda**: a 2 ("nenhuma
escrita") fica intacta porque o banco não recebe uma linha. O que esta RFC emenda é só o
"Não é objetivo" das linhas 154–155 — endpoint e painel passam a ser objetivo; **tabela
continua não sendo** (fica para a RFC-030, e só por decisão do proprietário).

Ler de disco também tira o endpoint do alcance do `statement_timeout` de 1 s e do
`proxy_read_timeout` de 5 s: o JSON do modo B é um arquivo pequeno (tamanho: `verificar` com
`wc -c` na primeira rodada), servido em milissegundos.

### D2 — job destacado do SSH, no host, em horário de baixa carga

Unidade `systemd` timer + service em `deploy/systemd/` (versionados), instalados por script
em `deploy/`. O service roda, em sequência: `source-replay --format json --from <agora−72h>`
e `sweep costs.edgeLiqMin --values 0.01,0.015,0.02,0.03 --format json`, via
`docker compose --env-file deploy/server.env exec -T api node apps/api/dist/shadow-replay-cli.js …`
(`Makefile:8` define o mesmo `SERVER_COMPOSE`; o `--env-file` é relativo, então a unidade
leva `WorkingDirectory=/opt/ganso-market`), com a saída redirecionada para o arquivo do
dia. Horário proposto: **03:30Z** (P4; `verificar` com `docker stats` que é vale de carga).
Retenção: mantém os últimos 30 arquivos por modo, apagando **por nome exato**, um por vez —
nunca glob nem diretório pai. Falha do CLI é detectada pelo **exit status ≠ 0** (o
`reason_code` do stderr varia; só `message: "shadow_replay_failed"` é fixo, `:823`) e vira
linha no `journalctl` **e** um arquivo `latest-{modo}.error.json` (com o stderr capturado)
que a tela mostra como "rodada de hoje falhou: <reason_code>" em vez de exibir o JSON de
ontem como se fosse novo.

Janela de 72 h do modo B: cabe no TTL de `fundamental_estimates` e no que a quota de
`portfolio_decisions` retém (~4 dias medidos no leitor §2.2 em 03/09; `apps/api/src/polymarket/retention.ts:418–425` prevê
~19 dias em regime — re-medir). Consequência aceita: menos entradas liquidadas por rodada; o
histórico de rodadas compensa. O modo A varre a janela cheia (≤ 2 min).

### D3 — endpoints GET-only que só leem disco

`GET /polymarket/shadow-replay/latest?mode=A|B` e `GET /polymarket/shadow-replay/runs`
(lista `{run_date, mode, bytes, mtime}` dos arquivos presentes), registrados em
`portfolio/api.ts` com o mesmo `preHandler: guard` das rotas vizinhas (`api.ts:164–166`).
O caminho do arquivo é montado **só** a partir de `mode ∈ {A, B}` e de `run_date` validado
por regex `^\d{4}-\d{2}-\d{2}$`; qualquer outro valor é 400. Arquivo ausente é 404 com
`reason_code: RUN_NOT_FOUND`. O diretório vem de env (`GANSO_SHADOW_REPLAY_DIR`), no padrão
de `API_CONFIG_FILE_ENV` (`config.ts:4`), **declarada no bloco `environment:` do serviço
`api` em `docker-compose.yml` (:93–95, hoje só `GANSO_CONFIG_FILE` e
`GANSO_POSTGRES_PASSWORD_FILE`) apontando para o caminho de montagem do volume** — sem ela a
API sobe e responde 404 para tudo. A resposta embrulha o JSON do CLI sem reformatar:
`{mode, run_date, generated_at (mtime), stale (mtime > 36 h), payload}`. Nginx:
`location ^~ /api/polymarket/shadow-replay` GET-only, no padrão de `/gates`
(`nginx.conf:129–136`); `scripts/tests/test_nginx_perimeter.py` ganha a asserção junto.

### D4 — a tela é leitura com ressalvas fixas; sem promoção

Tela "Sombra" (tecla `4` quando a RFC-026 estiver em produção). Blocos: proveniência
sempre visível (janela coberta, `closed_at_decision_id`, config, `model_ids`, "modo B lê
tabelas com TTL: não é auditoria"); funil da população; cartão de PnL contrafactual em
roxo tracejado com selo HIPOTÉTICO, sufixo "(paper)" e a ressalva fixa "soma de linhas,
não posições; N liquidadas em ≤ M mercados"; matriz de transições traduzida por
`MOTIVO_DECISAO`/`RESULTADO_DECISAO` (`dicionario.ts:189–225`) com o código cru em
tooltip; varredura com barras de flips por valor, linha no valor gravado, marcadores nos
valores de virada e sub-barra "abaixo da ordem mínima"; histórico de rodadas lendo
`/runs`; aviso "modelos misturados — não usar para promoção" quando `model_ids` tem mais
de um item. **Nenhum botão** de promoção, de cunhagem ou de rodar o job.

### D5 — fora do escopo (RFC-030 futura)

Persistência em tabela, cortes por mercado/forma/horizonte/modelo/braço, curva de PnL com
IC por mercado, dedup por posição e caps. O acumulador guarda só `Set<string>` de mercados
para contagem (`sourcereplay.ts:301–306`), não a lista; expor isso é mudança do CLI e
emenda da restrição 6 da RFC-017 ("só agregados acumulam", `RFC-017:173`). O conserto do
`estimateAsOf` é o PR-0 (c) (`prompts/roadmap/11-hotfixes-pr0-overview-settlement-sombra.md`, item c; área da RFC-010).

---

## Decisões do proprietário que esta RFC exige

| # | Decisão | Padrão se não houver resposta |
| --- | --- | --- |
| P1 | Aprovar a emenda de escopo leve da RFC-017 (linhas 154–155): endpoint e painel passam a ser objetivo; tabela não | **Não aprovada**: nada desta RFC começa |
| P2 | Aprovar o job no host (unidade systemd rodando `docker compose exec` como root no host; dentro do container o CLI é `node`, `apps/api/Dockerfile:27`; os JSONs são gravados por root em `/var/lib/ganso/shadow-replay` e lidos pelo uid `node` via `:ro` — `umask 022`, diretório 0755) | Recusado: o CLI segue manual |
| P3 | Aprovar o volume `:ro` novo no serviço `api` do `docker-compose.yml` versionado | Recusado: sem volume não há PR 2 nem 3 |
| P4 | Horário do timer (proposta 03:30Z) e janela do modo B (proposta 72 h) | 03:30Z / 72 h |
| P5 | PR 3 espera a RFC-026 em produção, ou entra como 5.ª aba do `TABS` atual (`App.tsx:205`) sem tecla | **Esperar** a RFC-026 |

---

## Escopo, em PRs

| # | Item | Arquivos | Muda comportamento? | Migration |
| --- | --- | --- | --- | --- |
| 1 | Unidade systemd timer+service, script de instalação, runbook; volume `:ro` **e** env `GANSO_SHADOW_REPLAY_DIR` no `api`; gravação atômica, retenção por nome, `latest-*.error.json` (D1, D2) | `deploy/systemd/*`, `deploy/install-shadow-replay-timer.sh`, `docker-compose.yml`, `docs/ops/SHADOW_REPLAY_JOB.md` | não (nada no motor) | não |
| 2 | `GET …/shadow-replay/latest` e `/runs` lendo disco; `location ^~` GET-only; teste de perímetro (D3) | `portfolio/api.ts`, `infra/nginx/nginx.conf`, `scripts/tests/test_nginx_perimeter.py`, `apps/api/test/polymarket/portfolio/api.test.ts` | não | não |
| 3 | Tela Sombra com os blocos da D4 e o aviso de modelos misturados; sem botões | `apps/web/src/Sombra.tsx`, `apps/web/src/sombra.ts`, `App.tsx`, `dicionario.ts` (só verbetes que faltarem), `apps/web/test/Sombra.test.tsx` | não | não |

## Testes obrigatórios

- PR 1: script do job com `--dry-run` imprime os comandos e não toca nada; teste
  (`scripts/tests/test_shadow_replay_job.py`, com o script apontado para um diretório
  temporário e um CLI falso) prova gravação atômica (nunca existe `latest-B.json`
  truncado), retenção apaga só o 31.º mais antigo **por nome**, e falha do CLI gera
  `latest-B.error.json` sem sobrescrever o `latest-B.json` bom.
- PR 2: `mode=C` → 400; `run_date=../x` → 400; arquivo ausente ou env não definida → 404 `RUN_NOT_FOUND`;
  arquivo presente → 200 com `payload` byte-idêntico ao disco; `stale: true` com mtime
  de 40 h; sem sessão → 401. `test_nginx_perimeter.py`: a location existe, é GET-only,
  e nenhum prefixo novo sob `/paper`.
- PR 3: com fixture sendo o **arquivo real** gravado pelo job (não objeto montado à mão), a tela imprime 258.805 → 511, +401,25 com selo
  HIPOTÉTICO, "≤ 38 mercados", e o aviso de modelos misturados; com `model_ids` de 1
  item o aviso não aparece; com `latest-B.error.json` mostra a falha, não o dado velho.
- Grep no diff de cada PR: **zero** `INSERT`/`UPDATE`/`DELETE` fora de `test/`.
- Cada teste de regressão verificado **falhando no código anterior**.

## Critérios de aceite (em produção)

| Critério | Como verificar |
| --- | --- |
| Job rodou hoje, destacado do SSH | `systemctl list-timers 'ganso-shadow-replay*'`; `ls -l /var/lib/ganso/shadow-replay/` mostra `{hoje}-A.json`, `{hoje}-B.json`, `latest-*.json` com mtime < 36 h; `systemctl show ganso-shadow-replay -p ExecMainStatus` = 0; `journalctl -u ganso-shadow-replay` sem `shadow_replay_failed` |
| Perímetro | de dentro do servidor: `GET /api/polymarket/shadow-replay/latest?mode=B` → 401 sem sessão, 200 com; `POST` → 404; `test_nginx_perimeter.py` verde |
| Tela | mostra os números do `latest-B.json` do dia com proveniência e ressalvas; `/runs` lista ≥ 2 rodadas após 48 h |
| Nenhuma escrita nova | `grep -nE 'INSERT|UPDATE|DELETE' $(git diff --name-only <base>..HEAD \| grep -v test)` vazio; `pg_stat_user_tables` sem tabela nova |
| Carga | `docker stats` durante a rodada: `postgres` ≤ 1 core; nenhum `PORTFOLIO_CYCLE` do worker (`portfolio/runner.ts`) com duração > 60 s no `journalctl` da janela do job; a primeira rodada do timer é a medição da contenção — durações no HANDOFF, com número |

## Condições de parada

- Qualquer caminho novo que escreva no banco, cunhe config ou toque `replayDecision`.
- Caminho de arquivo montado a partir de entrada do usuário sem passar pela allowlist da D3.
- `location` de prefixo sob `/api/polymarket/paper`; qualquer método além de GET.
- P1, P2 ou P3 não aprovados.
- Rodada do job coincidindo com ciclo de portfólio > 60 s ou disjuntor `DATA_STALENESS`
  (`portfolio/breakers.ts`) abrindo na janela do job: parar o timer e trazer a medição
  ao proprietário (P4).
- `make verify` vermelho.
