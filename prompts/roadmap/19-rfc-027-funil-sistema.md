# RFC-027 — Decisões como funil das 24 h e Sistema com natureza do bloqueio

Execute a **RFC-027** ATÉ O FINAL, em **dois PRs**: re-medição → código → testes → merge →
CD → rebuild (só no caminho B) → verificação em produção → HANDOFF. A RFC é a fonte de verdade.
Tudo em SIMULAÇÃO: nenhum gate afrouxa, nenhum endpoint de escrita novo, nenhum disjuntor
contornado. Origem: diagnóstico de 02–03/09/2026 (relatório linkado no cabeçalho da RFC-027;
layout das telas Decisões e Sistema: canvas da RFC-026).

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-027-decisoes-como-funil-e-sistema.md` (fatos, D1–D6, P1–P4, aceite, parada)
2. `apps/api/src/polymarket/portfolio/api.ts` — `HISTORY_LIMIT` (l. 38); rotas `/portfolio/limits`, `/portfolio/state`, `/gates`, `/decisions` (~294–505; linhas na RFC)
3. `apps/api/src/polymarket/overview.ts` — gates (~409–412), montagem (~500–540)
4. `apps/api/src/polymarket/readapi.ts:944–1000` — única fonte da forma de `/data-quality` (`gaps_24h`, `ingest_lag_ms_last_hour`, `storage.tables[]`)
5. `apps/api/src/polymarket/portfolio/runner.ts` — só o `PORTFOLIO_CYCLE` (~1008–1019)
6. `apps/web/src/overview.ts` — parser do `/overview`; os blocos novos do PR 1 entram aqui
7. `apps/web/src/portfolio.ts` — parse dos gates (~412–430, 549)
8. `apps/web/src/Portfolio.tsx` — seção `decisoes` (~928–1010); `apps/web/src/Overview.tsx` — feed (~504–532)
9. `apps/web/src/dicionario.ts` — `grep -n "^export"`; `SITUACAO_GATE` (l. 65), `TIPO_DISJUNTOR` (l. 159)
10. Testes que você estende: `apps/api/test/polymarket/overview.test.ts`, `apps/web/test/overview.test.ts`, `apps/web/test/dicionario.test.ts`

Só se precisar: `portfolio/gatestore.ts:520–523` (SELECT de `portfolio_g2_clock`);
`portfolio/exitstore.ts:175–204` (`stale_marks`, D2 caminho A); no **caminho B**,
`migrations/0018_resolution_proposal_active.sql` (modelo) e `retention.ts:128`
(`RETENTION_TABLES`). Não leia `engine.ts`, `gates.ts` nem `breakers.ts`: códigos e chaves
estão na RFC; `BREAKER_EVENT_WINDOW_MS` (`breakers.ts:102`) você **importa, não lê**.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE no deploy. Nunca imprima secrets.
- Deploy em **TRÊS passos**: merge → CD → rebuild de profile. O CD (`make server-update`)
  recria `api`, `web`, `nginx`, **aplica as migrations** (serviço `migrate`) e reinicia os
  containers de profile **sem trocar a imagem**. Rebuild **só no caminho B**: serviço
  `polymarket-portfolio`, profile `polymarket` (`docker-compose.yml:343–344`):
  `cd /opt/ganso-market && docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-portfolio`.
  Evidência: `docker exec ganso-market-polymarket-portfolio-1 cat /etc/ganso/release-sha`
  = SHA do merge; nunca `compose ps`.
- Caminho B: antes do rebuild, confirme a migration nova (a próxima livre; 0019 em 03/09)
  aplicada — `SELECT max(version) FROM schema_versions WHERE component = 'foundation'`
  (ledger de `infra/migrations/apply.sh:86`). Só o worker escreve
  `portfolio_decision_hourly` e `portfolio_cycle_summary`.
- `make verify` verde antes de cada PR.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Ao final: `docs/HANDOFF.md` e a linha 19 da tabela "Ordem e status" de `prompts/roadmap/README.md` — ela **não existe** hoje: adicione-a.

## Estado medido (02–03/09/2026; re-verifique)

**Primeiro:** a RFC-026 está em `accepted` (04/09) e ainda não implementada. Se o PR 1 dela (teclas `3` Decisões e `6` Sistema, modo
engenheiro) não estiver mergeado — `grep -n "Sistema" apps/web/src/App.tsx` vazio — **PARE e
registre**. Nada abaixo se mede antes.

Consultas de re-medição: na RFC ("Fatos medidos", D1).

| Premissa | Se caiu |
| --- | --- |
| Log ~11 linhas/min; 500 linhas ≈ 45 min | aviso da tela usa o valor medido |
| Funil 24 h: 52 983 avaliadas, 29 `ACCEPTED`, 55,9 % disjuntor | registre; não é parada |
| Caminho A ≤ 500 ms (`EXPLAIN` quente e frio pós-CD) | > 500 ms → caminho B (exige P1) |
| "Quase": sem número no repositório | registre; a tela não o fixa |
| Seis gates `INSUFFICIENT_DATA`; `clock_start = 2026-08-28 20:38:47Z` | etiquetas e data são dado-dirigidas |
| Nada consome `/data-quality` nem `/limits`; feed com `JSON.stringify`; "234.549" fixo | pule o já feito |

## Escopo

**PR 1 — Decisões (D1–D4).** API, no `/overview`: `funnel_24h` (`window_from`, `window_to`,
`source`, contagens por `outcome × reason_code`), `last_cycle` e `near_misses_24h`. O "Quase" é
**agregado no servidor** (D3): `/decisions` não devolve `costs_total`/`safety_margin`; a folga
usa o `edgeLiqMin` da config carregada pela API; o frontend **não fixa 0,02** e lê o limite do
bloco `config` de `/portfolio/limits` (RFC-026 D6), não do `/overview`. `window_ms` por
disjuntor em `/portfolio/state`. Caminho A ou B **decidido pelo EXPLAIN** colado no PR; no B, a
migration cria `portfolio_decision_hourly` e `portfolio_cycle_summary`, escritas **só pelo
worker**, `protected: true` em `RETENTION_TABLES`. Web: Decisões abre com funil, último ciclo,
Quase e Congeladas; as 500 cruas atrás do filtro; **nunca funil de amostra**.

**PR 2 — Sistema fase 1 (D5, D6).** API: `/gates` ganha `g2_clock` (quatro colunas do D5).
Web: verbete `NATUREZA_BLOQUEIO` com as quatro etiquetas, dado-dirigido pelas chaves da
tabela da RFC; barras tem/precisa; seções "Qualidade de dados" (`/data-quality`; se a RFC-024
já publicar a cobertura do universo rápido, exibir, não recalcular) e "Limites"
(`/portfolio/limits`); semáforos por fonte (60 s / 5 min); `detail` do feed traduzido, JSON só
no modo engenheiro; texto fixo de `Overview.tsx:507` sai.

## Verificação

- `scripts/tests/test_nginx_perimeter.py` inalterado e verde.
- "Testes obrigatórios" da RFC nos três arquivos do item 10; no B, upsert idempotente das
  duas tabelas novas.
- Produção, após o CD (no B: `schema_versions` na versão nova, depois rebuild): `release-sha`
  = SHA do merge nos containers tocados; **os seis aceites da RFC, na ordem**.

## Entregável

Dois PRs mergeados e verificados; "Medido depois" da RFC preenchido (EXPLAIN quente/frio,
caminho, número do "Quase", `release-sha`, `curl` do aceite 2); HANDOFF e linha 19 do README
com os seis aceites e as premissas que caíram.

## Condições de parada

- PR 1 da RFC-026 ausente.
- Location novo, endpoint de escrita, gate, disjuntor, `config/portfolio.json`, `HISTORY_LIMIT`
  ou `BREAKER_EVENT_WINDOW_MS` tocados; biblioteca nova em `apps/web`; escrita da API nas
  tabelas do caminho B.
- Caminho A > 500 ms **e** P1 não aprovado: PR 1 entrega só Congeladas e D4; registre.
- Rebuild do worker antes de `schema_versions` mostrar a versão nova.
- Funil sobre amostra; número de produção fixado em texto; regressão que não falha no HEAD
  anterior; `make verify` vermelho.
