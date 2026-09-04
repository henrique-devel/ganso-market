# RFC-026 · PR 1 — Mesa: nome do mercado, duas colunas, escada do motor, cartão PRD, livro L2

Você vai executar o **PR 1 da RFC-026** ATÉ O FINAL: re-medição → código → testes → merge →
CD → verificação em produção → HANDOFF. A RFC é a fonte de verdade (D1–D7, D11); este
prompt só a operacionaliza. Tudo em SIMULAÇÃO: zero endpoint novo, zero location, zero
migration, nenhum gate. Origem: diagnóstico de 02–03/09/2026 (relatório e canvas linkados no
cabeçalho da RFC).

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-026-painel-home-broker.md` (fatos, D1–D7, D11, aceite, parada)
2. `apps/api/src/polymarket/portfolio/api.ts` — `/opportunities` (~l. 164–232, JOIN em ~215) e `/decisions` (~l. 487–505)
3. `apps/web/src/portfolio.ts` — `parsePanel` (~l. 190–244) e os tipos acima dele
4. `apps/web/src/Portfolio.tsx` — inteiro, 1 179 linhas. `Resolution.tsx` (1 628) **não** se lê: a tela `5` é só embrulho de layout no `App.tsx`
5. `apps/web/src/Overview.tsx` — `Badge` (~l. 101–132) e a faixa (~l. 138–248)
6. `apps/web/src/App.tsx` — abas (~l. 203–330)
7. `apps/web/src/dicionario.ts` — só as assinaturas exportadas (`grep -n "^export"`)
8. `apps/web/src/styles.css` — `.shell--wide` (~l. 210) e as classes `badge`, `grid`, `tabs`

Nada além disso, salvo o índice `18-rfc-026-painel-home-broker.md`, o topo de `docs/HANDOFF.md` e `git log --oneline -15`. Chaves do
`panel_json`: RFC D6, não `engine.ts`. Mockups: canvas da RFC, só para layout.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy. Sem secrets.
- Deploy em três passos: seção "O que vale para as três sessões" do índice
  `18-rfc-026-painel-home-broker.md` (nesta RFC nenhum worker muda; o terceiro passo não se aplica).
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.

## Estado medido (02–03/09; re-verifique)

| Premissa | Como re-medir | Se caiu |
| --- | --- | --- |
| PR-0 (a) mergeado | `grep -n "AND occurred_at" apps/api/src/polymarket/overview.ts` vazio (03/09: `:466`); `grep -c OVERVIEW_API_FAILED` nos logs da `api` desde o deploy = 0 | **PARE** |
| Nenhuma rota expõe `edgeLiqMin`/`bookMaxAgeMs` | `grep -rn 'edgeLiqMin\|bookMaxAgeMs' apps/api/src/polymarket/portfolio/api.ts apps/web/src` → 0 | já expõe → só consuma |
| `/opportunities` não seleciona `m.question`/`m.category` | `grep -n "m.question" apps/api/src/polymarket/portfolio/api.ts` vazio | só o JOIN de `/decisions` |
| `/decisions` não devolve `paper_order_id` | `grep -n paper_order_id` no mesmo arquivo vazio | registre |
| `slice(0, 12)` em 3 células | `grep -n "slice(0, 12)" apps/web/src/Portfolio.tsx` → 3 | registre a contagem |
| `parsePanel` lê só `book.spread` | `grep -n '"book"' apps/web/src/portfolio.ts` → 1 linha | se já lê `bids/asks`, pule o parser |
| `<Badge` 9× sem `compacto` | `grep -c "<Badge" apps/web/src/Portfolio.tsx`; `grep -c compacto` → 0 | registre |
| `.shell--wide` = 72 rem | `grep -n "72rem" apps/web/src/styles.css` | registre |
| 110/110 mercados têm `question` | SQL da RFC (claim C1), psql read-only | < 100 % → "sem nome" em cinza, nunca vazia |

## Escopo (D1–D7, D11)

**API (2 SELECTs + 1 bloco de leitura, mesmas rotas e locations):** `m.question, m.category`
no SELECT de `/opportunities`; em `/decisions`, `LEFT JOIN polymarket_markets m ON
m.condition_id = d.condition_id` com as mesmas colunas e mais `paper_order_id` (coluna de
`migrations/0014_polymarket_portfolio_engine.sql:143`; hoje não sai). Em `/portfolio/limits`
(`portfolio/api.ts:294-296`, já publicado por `nginx.conf:120`), bloco `config` com
`edgeLiqMin`, `safetyMarginMin`, `bookMaxAgeMs`, `estimateMaxAgeMs`, `config_version` (D6).
`EXPLAIN (ANALYZE, BUFFERS)` dos dois SELECTs, a quente e a frio, colado no PR e na RFC;
`/decisions` > 500 ms a frio → **sem JOIN**, nome cruzado no cliente com `/opportunities`.

**Web:** `.shell--wide` → `min(100rem, calc(100% - 2rem))`, duas colunas colapsando abaixo
de 1 100 px. Teclas `1`–`6` conforme D5 (`4` reservada; `5` em duas colunas com aviso "200
de N"; `6` casca com os cards atuais). Faixa fixa. `Badge` compacto e modo engenheiro (D4). Mesa esquerda: tabela ordenável, filtro texto/categoria,
chips Todos/Rápidos/Com posição, 25 por página, `↑↓`/`Enter`. Mesa direita: escada do motor
com folga (`edge.net − max(costs.safety_margin, edgeLiqMin)`, D6 — `safety_margin` mora em
`costs`), cartão das 8 respostas do PRD, livro L2 de 10 níveis (parser lê `book.bids/asks`),
últimas 10 decisões do mercado (filtro cliente). Bloco "O que eu faço agora?" no topo (D7):
kill switch (`overview.kill_switch.engaged`) com o botão de rearme existente; aceites com
`paper_order_id` nulo ("amostra das últimas 500"); posição não liquidada só no PR 2. Cor
conforme D3; "não medido"/"sem dado" em cinza, nunca zero. Textos com número fixo
(`Overview.tsx:507`, `Portfolio.tsx:933`) saem. Limites só do bloco `config` — nenhum `0.02`
ou `30000` no front.

## Verificação

- `make verify` verde; `scripts/tests/test_nginx_perimeter.py` inalterado e verde.
- Testes web novos (`apps/web/test`): `question` em toda linha e hash só em `title`; texto do
  `Badge` sem código com modo engenheiro desligado; `parsePanel` devolve 10 níveis de um
  `panel_json` real; folga nos três casos (positiva, negativa, "não medido"). Teste API:
  `/portfolio/limits` devolve `config` com as 5 chaves.
- Produção após o CD: A2 (`release-sha` no container = SHA do merge), A3, A4, A5 (SQL
  `question IS NULL` = 0; nenhum "Normal NORMAL"; ≤ 20 req/min no access log, Mesa aberta
  60 s), A7 (zero `canceling statement` em 24 h).

## Entregável

PR mergeado e verificado; linha "PR 1" de "Medido depois" da RFC-026 (SHA, EXPLAIN, A3–A5, A7,
premissas caídas); HANDOFF; linha 18 do README (modelo no índice).

## Condições de parada

- PR-0 (a) ausente.
- Location, endpoint, migration, índice, gate, disjuntor, config ou `replayDecision` tocados;
  biblioteca nova em `apps/web`.
- EXPLAIN a frio > 500 ms no JOIN de `/decisions`: cai para o cliente, não sobe orçamento.
- Número fixo de produção num texto da tela.
- Teste de regressão que não falha no código anterior; `make verify` vermelho.
