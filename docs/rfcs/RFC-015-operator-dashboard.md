# RFC-015 — Painel do operador: PnL no topo, visão geral, português

- Status: `in-progress` (2026-09-01)
- Dependências: RFC-002 (perímetro), RFC-011, RFC-012, RFC-013, RFC-016
- Escopo aprovado pelo proprietário em 2026-08-28, reposicionado **depois** da
  cobertura de modelo por decisão dele.
- Sem migration. Nenhum endpoint de escrita novo.

## 1. O problema

O painel de hoje é um **navegador de tabelas**, não um painel de operação. Três
abas (Status, Resolução com ~10 seções empilhadas, Portfólio com 6 sub-abas),
listas de 200–500 linhas sem paginação, e o número que o operador mais precisa
— **quanto a operação ganhou ou perdeu** — não aparece em lugar nenhum.

Isso não é falta de dado. É dado publicado e não renderizado:

| Fato                                          | Onde está                                                 | Onde aparece |
| --------------------------------------------- | ---------------------------------------------------------- | ------------ |
| `realized_pnl_day_usd`, `realized_pnl_week_usd` | `GET /polymarket/portfolio/state`, **parseado** em `portfolio.ts` | em lugar nenhum |
| banca, equity, HWM, drawdown                  | idem, idem                                                 | uma linha de texto corrido, só na aba Portfólio |
| não-realizado, fees, três colunas de custo    | `GET /polymarket/paper/performance`                        | **fechado no Nginx** |
| `invalidation`, `scenarios`, `limiters`, idade dos dados | `panel_json`, parseado em `portfolio.ts`         | em lugar nenhum |

E o que aparece, aparece em inglês cru de máquina: `NORMAL`, `HALTED`,
`INSUFFICIENT_DATA`, `CIRCUIT_BREAKER`, `LOWER_BOUND_BELOW_COSTS`,
`CAP_CATALISADOR_JANELA`, e um `unknown` que o operador não tem como
interpretar.

## 2. Estado medido (2026-09-01, produção, `release-sha` `5bb1caa…`)

O escopo de 28/08 foi re-verificado antes de qualquer linha de código. O que
mudou:

| Premissa de 28/08                            | Medido em 01/09 |
| --------------------------------------------- | ---------------- |
| "`unknown` visível vem do relatório por categoria" | **confirmado, e o bucket tem 308 terminais** — todos entre `2026-08-22 01:38Z` e `2026-08-25 01:33Z`, ou seja **todos anteriores** ao primeiro `valid_from` de `polymarket_market_metadata_versions` (`2026-08-25 01:42:43Z`). O rótulo "anterior a 25/08" é medido, não estimado. |
| "categorias: crypto, macro, weather"         | **confirmado**: 1294 crypto, 55 macro, 1 weather, 34 sem categoria no histórico de metadata |
| "listas de 200–500 sem paginação"            | confirmado: `LIST_LIMIT = 200`, `HISTORY_LIMIT = 500` |
| "o 500 de `GET /polymarket/decisions` não foi investigado" | **causa-raiz encontrada, e é uma bomba-relógio** — seção 3 |
| "RFC-016 em produção → aba Rápidos entra"    | RFC-016 está em produção, **e o universo tem 0 mercados com horizonte < 6 h neste instante** — seção 8 |

Estado vivo no instante da medição: portfólio `NORMAL`, banca $1000,00, equity
$998,79, HWM $1001,47, drawdown 0,267%, PnL dia/semana $0,00; kill switch
desarmado (engatado 31/08 23:53Z, rearmado 01/09 01:46Z); **41 disjuntores
abertos**; G1–G6 todos `INSUFFICIENT_DATA` → `rfc_009_status = BLOCKED`;
`portfolio_state_events` **vazia** (nenhuma transição de estado até hoje).

## 3. A carona que virou o achado principal: o 500 é um `statement_timeout`

`GET /polymarket/decisions` respondeu 500 em 31/08 18:21Z e o handoff registrou
"não reproduzível — o container foi recriado e o log não existe mais". A causa
não precisa do log. Está no plano de consulta e na configuração:

```
Limit  (actual time=710.738..714.966 rows=500)
  -> Gather Merge
       -> Sort  (Sort Key: decision_ts DESC, top-N heapsort)
            -> Parallel Seq Scan on portfolio_decisions
               (actual rows=78210 loops=3)  Buffers: shared read=92199
Execution Time: 715.150 ms
```

Não existe índice em `decision_ts` sozinho — os três que existem são compostos
(`decision_kind`, `condition_id`, `token_id` + `decision_ts DESC`) e nenhum
serve a um `ORDER BY decision_ts DESC` global. A consulta **varre a tabela
inteira**, hoje 234 mil linhas e ~720 MB de leitura.

E o orçamento é de **1 segundo**:

```ts
// database.ts
const queryTimeoutMs = overrides.queryTimeoutMs ?? config.database.connectTimeoutMs;
//                                                  ^ config/runtime.json: 1000
poolConfig.statement_timeout = queryTimeoutMs;
```

Todo worker sobrescreve isso (estimator/portfolio/resolution 60 s, paper e
recorder 30 s, shadow-replay 120 s). **A API — a única que serve o painel — não
sobrescreve.** Ela roda com `statement_timeout = 1000 ms`.

Medido em sequência na mesma sessão: **715 ms com cache frio, 57 ms e 12 ms
quentes**. É exatamente o formato de um 500 intermitente que "não reproduz": o
custo depende do cache, e a tabela crescia ~545 MB/dia sem poda até a migration
0016. Em 31/08 18:21Z, antes da poda de 449 mil linhas, a mesma varredura era
múltiplos de 715 ms.

**Correção sem migration:** trocar a ordenação por `decision_id DESC`. É a
chave primária, é monotônica com a inserção, e é uma ordem **total** — enquanto
`decision_ts DESC` é ambígua entre empates (um ciclo grava várias decisões com
o mesmo instante), o que já era um defeito latente de paginação.

| ordenação            | plano                      | buffers | tempo |
| --------------------- | -------------------------- | ------- | ------ |
| `decision_ts DESC`   | Parallel Seq Scan + sort   | 92.199 lidos | **715 ms** |
| `decision_id DESC`   | Index Only Scan Backward   | 104 acertos | **0,17 ms** |

4.200× mais rápido, zero leitura de disco. As duas listas coincidem em 490 das
500 linhas; as 10 que diferem são empates de instante na borda da página.

**E ele não estava sozinho.** `GET /polymarket/opportunities` tem o mesmo
defeito um passo atrás: `DISTINCT ON (token_id)` que não usa o índice
`(token_id, computed_at DESC)`, medido em **786 ms** com sort externo em disco.
Estava fora do escopo desta RFC até a aba Rápidos precisar da consulta; ficou
dentro. Detalhe e números na seção 10.

## 4. Faixa de PnL persistente

Um componente fixo acima das abas, visível em **todas** elas:

- PnL do dia e da semana (`realized_pnl_day_usd` / `_week_usd`);
- não-realizado e fees (`/paper/performance`, publicado nesta RFC);
- banca, equity, HWM;
- drawdown com barra até o limite de 10%, com o limite desenhado;
- estado do portfólio e do kill switch como badges com consequência escrita;
- banner **SIMULAÇÃO — SEM EXECUÇÃO REAL**, não removível.

O não-realizado pode vir `null` (posição sem marca executável — o
`buildPerformanceReport` devolve `null` quando há posição `unmarked`). `null`
renderiza como "—" com a explicação, **nunca como zero**.

## 5. Aba "Visão geral" (default)

Cards por domínio — coleta, modelo/shadow, resolução, broker paper, gates
G1–G6 + `rfc_009_status`, dados/disco — e um feed de eventos.

**`GET /polymarket/overview`** substitui ~11 chamadas por ciclo por uma. Só
agregados baratos; nenhuma consulta do agregador pode encostar no orçamento de
1 s da seção 3. Custos medidos em produção, um a um: último delta 1,8 ms; gaps
27 ms; universo 74 ms; estimativas da última hora 2,8 ms; **bytes vivos de
todas as 74 tabelas em uma consulta só, 16 ms**.

**`GET /polymarket/events?after=<cursor>`** — feed keyset sobre tabelas que já
existem, **sem migration**: transições de estado, decisões que mudaram alguma
coisa (`outcome = 'ACCEPTED'` — 262 de 234.571 linhas; o resto é
`ENTRY/REJECTED` e é ruído), ordens e fills do paper, disjuntores, violações de
grafo, divergências de camada e o kill switch.

O cursor é **por fonte**, não global: cada fonte tem um id monotônico próprio e
o cursor carrega o último id visto de cada uma (`fonte:id,fonte:id,…`). Um
cursor de instante único sobre tabelas heterogêneas pularia linhas quando duas
fontes gravassem no mesmo milissegundo; um cursor por fonte não pode pular nem
repetir, porque cada fonte é append-only com identidade crescente.

SSE fica **explicitamente fora**. O `proxy_read_timeout 5s` é global no edge e
mataria o stream; abrir exceção exige location dedicado e é fase 2. O feed usa
poll de 5 s.

## 6. Dicionário PT

Módulo de código→rótulo→consequência. O rótulo diz o que é; a frase de
consequência diz o que o operador faz com isso:

> `HALTED` → **Parado** — não sai sozinho; exige ação sua.

O **código original fica visível** em `<code>` ou no `title`, sempre. Traduzir
sem mostrar o código transformaria o painel em uma segunda fonte de verdade
divergente do log e do banco.

Categorias: `crypto` → Cripto, `macro` → Macro, `weather` → Clima (legado),
`unknown` → **"Sem categoria (anterior a 25/08)"**.

O literal `'unknown'` **fica no wire**. Trocá-lo em `report.ts` partiria o
histórico: `resolution_reports` já tem 7 relatórios gravados com `'unknown'`, e
o painel teria de tratar os dois códigos de qualquer forma. O rótulo é
responsabilidade da UI; o código é evidência.

## 7. Publicações no perímetro

Todas **exatas** (`location =`), GET-only, com teste de perímetro atualizado no
mesmo commit:

| location                                  | por quê |
| ----------------------------------------- | -------- |
| `= /api/polymarket/paper/performance`     | aprovado pelo proprietário em 28/08 — é a fonte de não-realizado e fees |
| `= /api/polymarket/overview`              | novo; agrega o que já é publicado |
| `= /api/polymarket/events`                | novo; feed |
| `= /api/polymarket/data-quality`          | **só depois** de corrigir `budget_used_pct` (seção 9) |

Prefixo sob `/paper` é condição de parada: `^~ /api/polymarket/paper`
publicaria `POST /paper/intents`, que cria ordens. O teste falha se aparecer.

## 8. Aba "Rápidos" — a condição está satisfeita, e o universo está vazio

O prompt condiciona esta aba à RFC-016 estar em produção. **Está** (migration
0017, `end_ts`, ativa desde 31/08). A aba entra: painel ordenado por horizonte
real, com spread e custo de ida-e-volta.

O que a medição obriga a dizer junto: no instante da verificação **o universo
não tem nenhum mercado com horizonte < 6 h** — nem pela coluna `end_ts` nem
pela cadeia versionada `polymarket_rule_versions.end_date`, que é a fonte
autoritativa (1121 versões abertas, 1121 com instante cheio, **0** vencendo em
6 h, próxima em `2026-09-02 04:00Z`). Não é defeito: 142 mercados venceram
**hoje** e as janelas de 10 s e 1 s rodaram o dia inteiro até ~16:00Z. É um
vale entre lotes diários.

**E a fonte do instante estava errada.** O endpoint devolvia
`polymarket_markets.end_ts`. Medido sobre os 372 tokens do painel: `end_ts` tem
instante para **219**; a cadeia versionada, para **372**; e onde os dois
existem discordam em **0**. Ranquear por `end_ts` descartaria em silêncio 41%
do universo — e descartaria como `—`, que se lê como "não tem prazo" e não
como "juntamos a tabela errada". A consulta passa a ler
`COALESCE(cadeia_versionada, end_ts)`.

Consequência honesta: a fatia "< 6 h" da aba é verificada **vazia contra o
universo de produção**, e isso é registrado como tal em vez de ser apresentado
como "aba funciona". A ordenação, a janela e o custo de ida-e-volta foram
verificados no navegador contra dados com a forma da produção; o custo é
`spread + 2 × (fee + slippage)`, e como em produção hoje fee e slippage são
`0.000000` em toda linha do painel, o custo de ida-e-volta **é** o spread — os
componentes ficam na tela ao lado do total para que isso não seja uma
suposição invisível.

## 9. `budget_used_pct` — a definição, antes da publicação

Débito conhecido, e é pré-requisito de publicar `data-quality`. Hoje o endpoint
soma `pg_total_relation_size` (**físico**) das tabelas `polymarket\_%`
(**subconjunto**) contra o orçamento inteiro de 110 GiB. O alarme
`QUOTA_GLOBAL_ALARM` soma **bytes vivos** da **lista inteira de retenção**
(que inclui `paper_*`, `resolution_*`, `portfolio_*`) contra o mesmo orçamento.

Dois erros somados: base errada e população errada. O número do painel nunca
foi o número do alarme.

Correção: o endpoint passa a medir `RETENTION_TABLES` em **bytes vivos**, com
**o mesmo código** que o alarme usa — a função de medição sai do fecho de
`createRetentionJob` e vira exportada. Um segundo estimador seria repetir o
defeito com outro nome. A resposta publica `live_bytes`, `physical_bytes` e a
diferença (`bloat_bytes`), porque as duas perguntas são diferentes e o painel
precisa das duas.

## 10. Caronas

- `AbortController` + timeout no polling do Portfólio (as outras abas têm; ela
  não tinha e podia empilhar requisições pendentes).
- Key estável nas decisões — hoje `Math.random()`, que força o React a
  recriar toda linha a cada render.
- `release-sha` no rodapé, e aviso **"recarregue"** quando a revisão que a API
  informa não bate com a do bundle. É a lição de 31/08: o botão de rearme
  "não funcionava" porque o SPA em memória era antigo; o login in-app não
  recarrega o bundle e `index.html` é `no-store`.
- `GET /polymarket/decisions` ordenado por `decision_id DESC` (seção 3).
- Campos de risco já publicados e invisíveis passam a renderizar:
  `invalidation`, `scenarios`, `limiters`, idade de livro/estimativa/resolução.

- `GET /polymarket/opportunities` **entrou no escopo durante a implementação.**
  Estava registrado como "fica para depois" a ~505 ms; ao medir o plano para a
  aba Rápidos ele apareceu a **786 ms** — parallel seq scan sobre 273 mil
  linhas mais um sort externo derramando ~9,5 MB por worker em disco, 79% do
  orçamento de 1 s, na seção que o operador deixa aberta com poll de 30 s. É o
  mesmo defeito do decision log, um passo atrás dele, e a aba Rápidos depende
  dessa consulta. Reescrita como **loose index scan** (um lookup por token no
  índice `(token_id, computed_at DESC)` mais um lateral pela linha mais nova):
  **36 ms medidos**, 22× mais rápido, e agora carregando também o instante de
  fim versionado.

## 11. Verificação

- Perímetro: cada location novo responde **401 sem sessão** e **404 no método
  errado**, de dentro do servidor; `scripts/tests/test_nginx_perimeter.py`
  verde; `POST /api/polymarket/paper/intents` segue 404.
- Navegador: PnL visível em todas as abas; visão geral carrega com 1–2
  requisições; textos em português; zero `unknown` cru.
- `make verify` verde antes de cada PR.

**O login do proprietário não é meu.** A verificação de navegador roda contra
um stub local que serve os valores **medidos no banco de produção** neste dia,
com a forma exata que os endpoints devolvem. Isso verifica a RENDERIZAÇÃO de
números reais; não verifica o fio. O fio é verificado à parte, no servidor,
pelo perímetro e por consulta direta ao banco.

**Controles positivos** — cada verificação que "passa" foi testada contra uma
versão quebrada de si mesma, para não passar por falta do que comparar:

| verificação | controle |
| ------------ | --------- |
| perímetro exato sob `/paper` | trocar `location =` por `^~` na performance → o teste falha com 2 erros |
| trava de método nos locations novos | remover o `if ($request_method != GET)` de `/events` → o teste falha |
| aviso de "recarregue" | escrever um sha diferente em `deploy/release-sha` e recarregar → o aviso aparece na tela com os dois shas |
| `budget_used_pct` em bytes vivos | a fixture do teste dá `live_tup`/`dead_tup` de forma que vivo ≠ físico, e inclui `portfolio_decisions`, que a definição antiga não enxergava |

## 12. Condições de parada

- Qualquer prefixo sob `/paper` no edge.
- Qualquer endpoint de escrita novo.
- Publicar `budget_used_pct` sem corrigir a definição.
- Qualquer migration.
