# RFC-024 — descoberta por série e livro garantido para o universo rápido (BTC horário)

Leve a RFC-024 ATÉ O FINAL (re-medição → prova no fio → código → deploy → soak de 3 dias →
HANDOFF). Tudo em SIMULAÇÃO e somente leitura de mercado. Origem: diagnóstico de
02–03/09/2026 (relatório linkado no cabeçalho da RFC-024).
A RFC está em `accepted` (04/09): procure em `docs/HANDOFF.md` a aprovação de P1–P4 (grep `RFC-024`).
**Sem registro de aprovação de P1 e P3, PARE e devolva ao proprietário.** Depende de
RFC-020 (`docs/rfcs/RFC-020-deploy-sem-derrubar-o-banco.md`) e RFC-021
(`docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md`), ambas em `accepted` e ainda não
implementadas: sem elas o soak não é mensurável.

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-024-descoberta-por-serie-e-livro-dos-rapidos.md` — fonte de verdade.
2. `apps/api/src/polymarket/registry.ts` — `fetchGammaPages` (~360–370),
   `capPriority`/`selectUniverse` (~226–330), `insertDataGap` (~439).
3. `apps/api/src/polymarket/dualws.ts` — `resubscribe` (~58–62 e ~265–271).
4. `apps/api/src/polymarket/orchestrator.ts` — `gammaCycle`, `resubscribe` (~395),
   `schedule("gamma", …)` (~431), `gaps = createGapWriter(pool)` (~150).
5. `apps/api/src/polymarket/bookpipe.ts` — `seenTokens`, `reason = "subscribe"` (~562–568).
6. `apps/api/src/polymarket/quality.ts` — `createGapWriter` (~87–120); `metricsSnapshot`
   (~451) **não** é o handler.
7. `apps/api/src/polymarket/readapi.ts` — handler real de `GET /polymarket/data-quality`
   (~943–975); os campos novos entram aqui.
8. `docs/HANDOFF.md` — só a entrada mais recente e P1–P4.

Nada além disso. Testes a estender: `apps/api/test/polymarket/{registry,dualws,bookpipe,readapi}.test.ts`
(`quality.test.ts` se a agregação for ao recorder). `test_nginx_perimeter.py` não muda.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (`/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy. Nunca imprima secrets.
  Meça com psql direto (a API roda sob `statement_timeout` de 1 s).
- Deploy em TRÊS passos: merge → CD → rebuild do profile `polymarket` (o CD reinicia os
  containers **sem trocar a imagem**). Evidência: `cat /etc/ganso/release-sha` em
  `polymarket-recorder` **e** em `api` (o campo novo do `data-quality` vive na API).
- `make verify` verde antes de cada PR. Nesta RFC: sem migration, nenhum location novo,
  nenhuma escrita fora de tabelas de coleta `polymarket_*`.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Ao final: `docs/HANDOFF.md` e a linha 16 da tabela "Ordem e status" de `prompts/roadmap/README.md` (atualize-a; crie-a se faltar).

## Estado medido (02–03/09/2026; re-verifique)

| Fato | Valor | Origem |
| --- | --- | --- |
| `enter` antes do fim (horário BTC) | mediana 21,0 min (q1 10,0; q3 26,1) | `min(at)` de `polymarket_universe_log` vs `COALESCE(end_ts, rule_versions.end_date)` |
| Vencidos com livro nas 3 h finais | 19 de 240 (8 %) | `polymarket_book_snapshots` por token Up |
| `book_deltas` | **35,17 GiB vivos** (02/09); 313,67 B/linha; gatilho 0,9 × 52 GiB = 46,8 GiB, alvo 0,8; folga 11,6 GiB | `retention.ts:45-46,153-160`; HANDOFF #88 (~3555) |

Se a re-medição der mediana de `enter` ≥ 60 min **ou** livro a T−15 em ≥ 90 % nas últimas
72 h: registre no HANDOFF e PARE. Antes do soak, re-meça o "8 %" com a definição exata de
`com_livro_t15` (RFC D4), para não trocar de régua.

## Escopo

**PR 1 — prova no fio (D1).** `apps/api/src/wire-probe-cli.ts`, stdout só, protocolo da
RFC D1. No servidor: `docker compose run --rm --no-deps polymarket-recorder node
apps/api/dist/wire-probe-cli.js …` (mesma imagem, sem tocar a coleta). Resultado
**verbatim** na RFC, mais a volumetria em GB/dia para P2. Testes: o CLI não importa
`database.ts`/`pg` (estático ou de módulo) e roda igual com `GANSO_CONFIG_FILE`/
`GANSO_POSTGRES_PASSWORD_FILE` presentes ou ausentes; sem controle positivo sai `INVALID`.

**PR 2 — descoberta por série, lacuna e métrica (D2–D4).** Implemente e teste como a RFC
fecha ("Testes obrigatórios"). O que ela deixa para a sessão:
- Liste ao vivo (GET) os slugs `bitcoin-up-or-down-*` de um dia e fixe a regex **horária**
  (a `SHORT_SERIES_PATTERN` casa 5 min e 4 h; a nova não pode); registre na RFC a URL da
  consulta da série confirmada na doc da Gamma.
- Lacuna `subscribe_book_missing` só para tokens que **entram**, cancelada no `exit`,
  via o `gaps` do orchestrator.
- Campos novos em `readapi.ts`; log `FAST_COVERAGE` por ciclo; `emitidos = 0` ⇒ `null`;
  plano > 200 ms ⇒ agregue no recorder e a API só lê.

**PR 3 — condicional (D3).** Só se o PR 1 mostrar que o frame adicional **não** entrega
livro; se entrega, **não faça o PR 3** — pare e re-diagnostique os 19 "nunca".

## Verificação

- Pós-deploy: `release-sha` do recorder e da API = merge; log `FAST_COVERAGE` presente;
  próximo horário BTC com `enter` ≥ 60 min antes do fim e `book` em ≤ 60 s.
- Soak de 3 dias UTC: `com_livro_t15/emitidos ≥ 90 %` por dia; `lead_mediano_min ≥ 60`;
  bytes vivos de `polymarket_book_deltas` **≤ 52 GiB** (`measureTableSizes` em
  `data-quality`; cruzar 46,8 GiB é a poda normal 0,9 → 0,8); zero `RETENTION_QUOTA_UNMET` /
  `RETENTION_QUOTA_NO_PROGRESS` / `RETENTION_STEP_FAILED` para `polymarket_book_deltas` no
  log do recorder; `subscribe_book_missing` por dia.
- `test_nginx_perimeter.py` verde sem alteração; `git diff migrations/` vazio.

## Entregável

PRs mergeados e verificados em produção; RFC-024 com a prova verbatim e a URL da série;
HANDOFF com cobertura, lead, bytes vivos por dia e volumetria real; linha do prompt 16 no
README no formato das linhas 01–10 ("Depende de", status em negrito, PR, data Z, o que a
re-medição desmentiu).

## Condições de parada

- Sem aprovação registrada de P1 e P3; premissa caiu na re-medição.
- PR 1 sem controle positivo válido em 3 rodadas: não codar o PR 3.
- Escrita fora de tabelas de coleta; location, endpoint de escrita, gate, quota, TTL ou
  disjuntor alterados.
- Bytes vivos de `book_deltas` **> 52 GiB** ou qualquer log `RETENTION_*` acima para
  `polymarket_book_deltas` no soak: reverter o PR 2 e voltar ao proprietário com o número.
- Deploy que recrie o Postgres no meio do soak (RFC-020 não entregue): o soak reinicia.
