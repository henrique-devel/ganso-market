# RFC-026 · PR 2 — Carteira: posições e ordens publicadas por `location =`, filtros em Decisões

Você vai executar o **PR 2 da RFC-026** ATÉ O FINAL: re-medição → código → testes → merge →
CD → verificação em produção → HANDOFF. A RFC é a fonte de verdade (D7–D9). Tudo em
SIMULAÇÃO: publica **duas rotas GET que já existem**; zero escrita, migration, índice ou gate.
Origem: diagnóstico de 02–03/09/2026 (relatório e canvas linkados no cabeçalho da RFC).

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-026-painel-home-broker.md` — D3, D7, D8, D9, P1, A1–A7. **P1 aprovado** = `grep -n 'RFC-026' docs/HANDOFF.md` traz "P1 aprovado em DD/MM" (03/09: 0 linhas). Sem isso, só a parte web e os filtros de `/decisions`.
2. `apps/api/src/polymarket/paper/api.ts` — `/paper/orders` (~l. 373–407) e `/paper/positions` (~l. 410–455)
3. `apps/api/src/polymarket/portfolio/api.ts` — `/decisions` (~l. 487–505, já com JOIN e `paper_order_id` do PR 1) e `/portfolio/limits` (~l. 295)
4. `infra/nginx/nginx.conf` — `= /api/polymarket/paper/performance` (~l. 193–200, padrão a copiar), `^~ /api/` (~l. 229)
5. `scripts/tests/test_nginx_perimeter.py` — `PAPER_ALLOWLIST` (`:36`), `test_the_rfc_015_read_surfaces_are_exact_and_get_only` (`:96-111`), `test_the_order_creating_surfaces_stay_closed` (`:113-123`)
6. `apps/web/src/Portfolio.tsx` — só as cascas Carteira e Decisões criadas no PR 1
7. `apps/web/src/portfolio.ts` — tipos e parsers
8. `migrations/0006_polymarket_fundamental_model.sql:170-185` — `fundamental_labels` (leitura; PK `token_id` `:172`, `is_final` `:179`)

Nada além disso, salvo o índice `18-rfc-026-painel-home-broker.md`, o topo de `docs/HANDOFF.md` e `git log --oneline -15`. Não leia
`brokerstore.ts`, `broker.ts`, `engine.ts`: a tela **rotula**, não liquida.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy. Sem secrets.
- Deploy em três passos: seção "O que vale para as três sessões" do índice
  `18-rfc-026-painel-home-broker.md` (nesta RFC nenhum worker muda; o terceiro passo não se aplica).
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- **Sob `/paper` só `location =` exato, GET-only**; prefixo publicaria `POST /paper/intents`.

## Estado medido (02–03/09; re-verifique)

| Premissa | Como re-medir | Se caiu |
| --- | --- | --- |
| PR 1 mergeado | `grep -n "m.question" apps/api/src/polymarket/portfolio/api.ts` → 2 rotas | **PARE** |
| `/paper/positions` e `/paper/orders` fechados | de dentro do servidor: `curl -s -o /dev/null -w '%{http_code}' https://…/api/polymarket/paper/positions` → 404 | 401/200 → outra sessão publicou: adapte |
| `PAPER_ALLOWLIST` com 2 entradas; `orders` e `positions` na lista **fechada** | `sed -n 36p scripts/tests/test_nginx_perimeter.py`; `sed -n 113,123p` idem | já movidos → outra sessão publicou: adapte |
| `queue_ahead` em 18/18 ordens | `SELECT count(*), count(queue_ahead) FROM paper_orders` | < 100 % → "não medido" em cinza |
| `outcome` sem índice | `\d portfolio_decisions` | registre e meça mesmo assim |
| 94 `ACCEPTED` × 52 868 `REJECTED` em 24 h | `SELECT outcome, count(*) FROM portfolio_decisions WHERE decision_ts > now() - interval '24 hours' GROUP BY 1` | registre |
| `is_final` existe | `grep -n is_final migrations/0006_polymarket_fundamental_model.sql` | sem ela o selo sai |

## Escopo (D7–D9)

**API:** `/paper/positions` (`SELECT * FROM paper_positions`, `paper/api.ts:416`) ganha
`LEFT JOIN polymarket_markets` (`question`) e `LEFT JOIN fundamental_labels fl ON fl.token_id
= paper_positions.token_id` (`is_final`; PK `token_id` — **nunca** por `condition_id`, que tem
2 tokens por mercado e duplicaria cada posição) e devolve `pending_settlement = is_final AND
shares > 0`;
nenhuma heurística por `mark_stale`/`end_ts`. `/paper/orders` só ganha `question`.
`/decisions` aceita `?outcome=` (400 fora do domínio) e `?condition_id=`; `EXPLAIN
(ANALYZE, BUFFERS)` a quente e a frio de cada filtro, colado no PR e na RFC. p95 a frio
> 500 ms → **fallback**: `LIMIT 500` e filtro no cliente com aviso "das últimas 500". Sem
índice novo.

**Nginx:** `location = /api/polymarket/paper/positions` e `= /api/polymarket/paper/orders`
copiando o bloco de `performance` (`$request_method != GET → 404`). Nenhum prefixo.

**Teste de perímetro:** `test_the_order_creating_surfaces_stay_closed` (`:113-123`) **quebra**
ao publicar os dois paths. (a) Mova `paper/orders` e `paper/positions` dessa lista fechada
para `PAPER_ALLOWLIST` (`:36`, 4 entradas); `intents`, `kill-switch`, `portfolio/halt` e
`portfolio/resume` ficam fechados. (b) Estenda `test_the_rfc_015_read_surfaces_are_exact_and_get_only`
(`:96-111`) aos dois novos. O caso "prefixo sob `/paper`" continua falhando.

**Web (teclas `2` e `3`):** cartões de posição (pergunta, lado, quantidade, custo, marca com
idade, PnL não realizado do servidor, fees, lockup, vencimento; selos "marca envelhecida"
âmbar e "resolvido na venue, não liquidado" vermelho); ordens com "fila à frente" e filtro
Abertas/Encerradas; barras de uso dos caps (`/portfolio/exposure`, `/portfolio/limits`); estado. Decisões: filtros Resultado
(padrão **Aceitas**) e Mercado; detalhe via `/decisions/:id`. Terceira frase de "O que eu
faço agora?" (`pending_settlement`). `unrealized` `null` → "— (N marcas envelhecidas)", nunca zero.

## Verificação

- `make verify` e `test_nginx_perimeter.py` verdes; testes API: `pending_settlement` só com
  `is_final` e `shares > 0`; número de linhas de `/paper/positions` **igual** com e sem o
  JOIN (fixture com 2 tokens do mesmo `condition_id`); `?outcome=X` inválido → 400. Teste de
  perímetro: `intents` segue na lista fechada.
- **A1**, de dentro do servidor: `curl -s -o /dev/null -w '%{http_code}'` em
  `/paper/positions`, `/paper/orders`, `/paper/intents` × GET/POST/DELETE — 401 no GET dos
  dois novos sem sessão, 404 em escrita, `/paper/intents` 404 sempre.
- **A2** `release-sha` no container = SHA do merge. **A6** EXPLAIN a frio < 500 ms ou
  fallback registrado. **A7** zero `canceling statement` da API em 24 h.

## Entregável

PR mergeado e verificado; linha "PR 2" de "Medido depois" da RFC-026 (SHA, EXPLAIN,
A1/A2/A6/A7, testes de perímetro alterados, premissas caídas); HANDOFF; linha 18 do README.

## Condições de parada

- PR 1 ausente; P1 não aprovado (executa só a parte sem location).
- Qualquer `^~` sob `/api/polymarket/paper`; método além de GET; escrita nova; migration;
  índice.
- EXPLAIN a frio > 500 ms: fallback cliente; sem subir orçamento ou criar índice.
- Heurística de "resolvido" sem `is_final`.
- Teste de regressão que não falha no código anterior; `make verify` vermelho.
