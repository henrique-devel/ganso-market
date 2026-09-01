# Evidência de verificação — RFC-014 + RFC-019 (barreira e updown, `crypto_updown_gbm@1.1.0`)

- Data: 2026-08-31/09-01 (BRT) — 2026-09-01 (UTC)
- Branch: `claude/rfc-019-barreira-updown-c66ffd`
- Ambiente: macOS (Darwin 25.3.0), Node/vitest do repo, PostgreSQL 18.4
  descartável em Docker para o recorte PG; produção lida por SSH
  (`/opt/ganso-market`), somente leitura até o deploy
- Este documento registra **somente comandos realmente executados e seus
  resultados reais**. O que não foi executado está em "Não verificado".

## 1. Re-medição antes de codar (produção, 2026-09-01 02:00–02:40Z)

O prompt do roadmap (04) carrega fatos de 2026-08-28. A re-medição confirmou o
essencial (a cobertura é limitada pelas formas de pergunta recusadas) e
**refutou três premissas de desenho**:

| Premissa do prompt | Medido em produção | Consequência |
| ------------------- | ------------------- | ------------- |
| "strike do updown no instante `event_start_ts` da RFC-016" | `event_start_ts` **não existe** — a D2 da RFC-016 mediu `eventStartTime: null` em 100/100 e a coluna nunca nasceu | o início da janela é derivado do FIM real (`rule_versions.end_date`/`end_ts`) menos a duração declarada no título; não derivável ⇒ abstém (RFC-019) |
| "o feed RTDS/Chainlink é o MESMO dado que resolve o mercado (zero basis risk)" | as regras reais resolvem por **candle Binance** (updown horário: open/close do candle de 1 h; barreira: High/Low do candle de 1 min; até os terminais: Close do candle de 12:00 ET). Única exceção: updown por faixa, que resolve por TWAP Chainlink **da faixa** — payoff asiático | o insumo continua sendo o feed gravado (twap30/twap60); o viés é REGISTRADO: no updown o offset cancela na razão K/S (strike e nível do mesmo feed); na barreira o TWAP alisa os pavios que o candle resolve (subestima) enquanto o monitoramento contínuo da 2·Φ superestima — o walk-forward julga o líquido |
| cobertura implícita dos 4 ativos | o RTDS de produção só contém **BTC** (twap30/twap60 `btc/usd`; zero linhas de eth/sol/xrp e zero do feed `spot` no histórico inteiro) | teto de cobertura é a população BTC (58 de 82 membros crypto em 2026-09-01); investigação do recorder registrada fora deste escopo |

Números re-medidos que substituem os de 28/08:

- Cobertura (24 h): **36 de 113** mercados crypto com linha MODEL (31,9%) —
  por forma: terminal 36/47, barreira **0/51** (23 hit/reach/touch + 28 dip
  to), updown **0/13**, range 0/2.
- Universo crypto no instante da medição: 82 membros — 58 BTC, 16 ETH, 4 SOL.
- Ritmo de labels (7 dias): updown **270** mercados, barreira **92** —
  ~52/dia para as formas novas (o N=100 da variante é alcançável em dias).
- Ordem dos tokens updown: `affirmative_token_id` = primeiro token em 267/271;
  4 nulos (a variante recusa esses 4, fail-closed).
- Janelas medidas nas regras verbatim: updown horário = candle de 1 h que
  começa no instante do título e `end_ts = início + 1 h` (verificado:
  "9PM ET" ⇒ end 02:00Z); updown diário = noon-ET vs noon-ET do dia anterior
  (`end_ts` = meio-dia ET); barreira "on <date>" = 12:00 AM–11:59 PM ET;
  faixa de datas = N dias; "in <month>" = mês inteiro; "by <date>" = aberta.
- RTDS na abertura da última hora fechada: gap 0 s (twap30 e twap60); 23 gaps
  RTDS registrados em 48 h.
- RAM do estimator: **29,81 MiB / 192 MiB**.
- Modelos registrados: `crypto_updown_gbm@1.0.0` e
  `macro_scheduled_consensus@1.0.0`, ambos `shadow` — nenhum promovido.

## 2. O que foi implementado

Uma única versão nova da MESMA família — `crypto_updown_gbm@1.1.0`
(feature-set `1.1.0`) — com as formas declaradas no hyperparam imutável
`forms: ["terminal","barrier","updown"]`. A 1.0.0 continua em shadow,
intocada (hyperparams sem `forms` ⇒ `["terminal"]`). Motivo de ser UMA
versão: a promoção é one-active-per-category e o gate avalia o modelo
inteiro (RFC-014 E5). Detalhe completo nas RFCs:
[RFC-014 (emendas E1–E5)](../rfcs/RFC-014-polymarket-first-passage.md) e
[RFC-019](../rfcs/RFC-019-polymarket-updown-strike.md).

- Parser: classifica terminal/barrier/updown; janelas derivadas do fim real;
  recusas mantidas (between, ATH, dois strikes, ativo desconhecido, formas
  não deriváveis, updown por faixa, afirmativo ≠ primeiro token).
- Mapa de barreira: `min(1, 2·Φ(−|ln(B/S)|/(σ√τ)))` por membro do ensemble
  (student_t com a mesma escala de variância), toque em curso (nível já além
  da barreira) e toque histórico (varredura high/low da série 1 min, limitada
  a `[touchScanFrom, último bucket fechado]`) ⇒ q = 1 (clampado a 1−ε).
- Updown: mapa terminal com strike = amostra do feed gravado as-of a abertura
  da janela (mesma feed do nível e da série; idade vs abertura ≤
  `max_strike_age_ms` = 5 min; qualquer falha ⇒ abstenção).
- Relatório: `formSlices` no walk-forward (descritivo; gate INTOCADO) e
  `coverage_by_form` (janela de 24 h) no payload diário dos modelos crypto.
- Sem migration: zero mudança de schema (data_refs já é JSONB;
  `affirmative_token_id` existe desde a 0012; `end_ts` desde a 0017).

**Defeitos encontrados durante a implementação (todos com teste):**

1. `STRIKE_PATTERN` lia o "b" de "**b**y" como sufixo de bilhões — "dip to
   $45,000 **by** December 31" virava strike de 45 trilhões. Corrigido com
   fronteira de palavra após o sufixo. A revisão apontou que o fix também
   mudaria o parse de perguntas **terminais** do tipo "$X **by** <data>", que
   a 1.0.0 serve — o que seria regressão na versão pinada. **Medido, não
   suposto:** essa população é de **0 mercados** no histórico crypto inteiro e
   **0 linhas MODEL** gravadas, então nenhuma evidência da 1.0.0 muda. Na
   1.1.0 o caminho é alcançável (a família "by" passou a ser aceita), que é
   por onde o defeito apareceu.
2. A derivação `deadline − N·24h` da abertura de janela de barreira fica 1 h
   **adiantada** no spring-forward de março (a janela ET é 1 h mais curta) —
   anticonservador: a varredura contaria toque fora da janela. Corrigido com
   **pad de +1 h** em toda família fechada: a abertura derivada nunca
   antecede a real, ao custo de ≤1 h de varredura/serviço.
3. O updown **diário** (janela noon-ET→noon-ET) tem janela de 23 h/25 h nas
   duas noites de DST do ano — `deadline − 24h` leria o strike do instante
   errado. Corrigido com **recusa fail-closed** quando a janela cruza uma
   transição de DST dos EUA (regra de lei fixa desde 2007, cálculo
   determinístico); a família horária é imune (candles UTC).
4. Toque observado (fato) não passa mais pela correção logística da
   calibração — uma correção estatística não pode rebaixar uma certeza
   observada. Latente (calibration é null em toda versão registrada), fechado
   agora com teste. (Achado da lente matemática da revisão adversarial.)

## 3. Testes

- `make verify` **verde** (exit 0, re-rodado após a revisão adversarial):
  vitest API **1467 passed | 62 skipped**;
  workers/contracts 51 + 70; cargo 14; python 9 + 32; secret-scan e
  compose-policy ok (agregado 4064 MiB).
- Suíte fundamental: **353 passed | 8 skipped** (inclui os 39 testes novos de
  `crypto-barrier-updown.test.ts` e as fatias por forma em
  `walkforward.test.ts`).
- **Golden de zero-regressão da 1.0.0**: capturado ANTES de qualquer mudança
  no modelo (mesmo fixture, código de HEAD):
  `above 120000 → q=0.000001, σ=0.005`;
  `below 95000 → q=0.0697352762303845, σ=0.010183624047246917` — pinado em
  teste; o caminho terminal reproduz os quatro números ao último bit.
- Anti-leakage: série com bucket pós-decisão (carregando o toque) dispara
  `LeakageError` antes de qualquer varredura; amostra de strike posterior à
  abertura ⇒ abstenção; varredura ignora toque anterior a `touchScanFrom`.
- Recorte PG real (PostgreSQL 18.4 descartável, **17 migrations pelo
  protocolo do `apply.sh`** com checksum, 0001–0017 aplicadas em sequência):
  `integration.test.ts` **8/8**, incluindo o teste novo de ponta a ponta —
  ciclo às 14:00Z com mercados updown e barreira reais: **4 linhas shadow,
  todas `1.1.0`** (updown com `form=updown`, `strike=100500` = o feed na
  abertura, `direction=up`; barreira com `form=barrier`,
  `direction=touch_up`, `strike=102000`), **zero linhas da 1.0.0 nas formas
  novas** (abstenção não grava linha), consumidor em `MARKET_BASELINE` com
  `MODEL_IN_SHADOW` nos 4 tokens, e os três modelos do catálogo (1.0.0,
  1.1.0, macro) registrados em `shadow` no boot com veredito
  `NO_EVIDENCE_OF_ALPHA` por modelo no job de calibração.
- Volumetria: o teto do `budget.test.ts` passou a modelar **3 linhas por
  token** (consumer + os DOIS shadows crypto) — o teto honesto cai para ~4,1
  dias na quota de 2 GB e **ainda clareia o piso `horizonte + 27 h` por
  >3×**; o piso em si não mudou; TTL e quota intocados.

## 4. Revisão adversarial (6 lentes independentes + refutação)

Rodada em duas etapas (a primeira foi cortada pelo limite de uso da sessão;
a segunda completou as seis lentes: matemática, as-of/leakage, zero-regressão,
fail-closed, parser, wiring). **24 achados brutos**; os verificadores
adversariais confirmaram 3 e refutaram 6, e os 15 restantes ficaram sem
verificador (limite de uso) — **julguei cada um deles contra o código e contra
uma medição em produção**, em vez de descartá-los. Sete viraram correção.

| # | Achado | Estado | O que foi feito |
| - | ------ | ------ | ---------------- |
| A | `$1 million` virava strike de **$1** — e numa barreira isso é "toque" instantâneo com q≈1 num mercado de centavos | **confirmado** (2 lentes) | magnitudes por extenso (`thousand/million/billion/trillion`) entram no `STRIKE_PATTERN`. Regressão que EU introduzi ao consertar o "by"; a 1.0.0 acertava por acidente |
| B | dias do range contados no ano UTC do **deadline**: um deadline de 31/dez rola para janeiro e, se o ano seguinte for bissexto, a abertura derivada fica ~23 h ANTES da real | **confirmado** | o ano vem do **ancoradouro do dia final** (`deadline − 12 h`), como o `in <month>` já fazia |
| C | derivação confia só na aritmética do deadline: um deadline fora de família transforma a varredura em inventora de toque | julgado real | **cross-check**: a data final do título tem de bater com o ancoradouro, senão recusa |
| D | título updown casando família diária E horária escolhia a diária em silêncio (dois instantes de strike, 23 h de distância) | julgado real (0 casos hoje) | recusa explícita |
| E | "dip **below** X" é verbo de caminho com preposição terminal | julgado **ambíguo** | medido: **zero** ocorrências em produção; nenhuma regra decide a família ⇒ **recusa**, conforme a condição de parada ("não se escolhe a mais provável"). Não vira barreira nem terminal |
| F | "all time high" sem hífen escapava da recusa | julgado real (2 casos) | `all[- ]time high` |
| G | direção neutra ("hit"/"touch") era re-derivada do nível a cada ciclo e **invertia** após um cruzamento — o mercado que tocou passaria a ser precificado como "dip" e responderia "não tocou" | julgado real | a direção neutra permanece neutra; o teste de toque vira **containment** (`low ≤ B ≤ high`), estável e sem inversão. O mapa só precisa de `\|ln(B/S)\|` |
| — | varredura limitada a 24 h; DST no updown diário; calibração sobre toque observado | refutados | já estavam tratados no diff (E2b da RFC-014, recusa de DST, bypass) |
| — | "by" incidental alargando janela fechada; provenance do deadline | julgados | "by" passou a ser testado **por último**; formas novas exigem `rule_version` em vigor (terminal **não** — a 1.0.0 não muda) |

Duas medições fecharam decisões acima, em vez de suposição: `dip/fall/drop
below` = **0** mercados, magnitude por extenso = **0**, updown de família
dupla = **0**, "all time high" sem hífen = **2** (histórico crypto inteiro).

**Cobertura re-medida com o parser REAL contra o universo vivo** (54 membros
crypto, 2026-09-01, todos os endurecimentos acima aplicados):

| | hoje (1.0.0) | com a 1.1.0 |
| - | - | - |
| perguntas que o parser aceita | 26/54 (terminal) | **51/54** (terminal 26/26, barreira 22/23, updown 3/4) |
| servível de fato (só BTC tem feed) | 20/54 (37%) | **41/54 (76%)** — 2,05× |

As três recusas restantes estão certas: `STRC` (ativo sem feed gravado), o
updown de faixa 4–8 AM (payoff asiático) e um `between`.

## 5. Verificação em produção (2026-09-01, deploy em três passos)

1. **Merge** do PR #70 (`c8327a86`), CI verde nos dois gates
   (`Verify source`, `Verify Compose runtime`).
2. **CD** verde em `c8327a86`; `deploy/release-sha` no servidor =
   `c8327a86bb280351afaccc39938c1bb094d740a9`.
3. **Rebuild do `polymarket-estimator`** (obrigatório — o modelo roda nele):
   `docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-estimator`.
   Evidência de revisão **dentro do container** (nunca `compose ps`):
   `/etc/ganso/release-sha` = `c8327a86…` (era `4bae1b92…`, a imagem da
   RFC-016).

**Boot (12:15:51Z):** `MODEL_REGISTERED` de `crypto_updown_gbm@1.1.0` com
`status: shadow` — e só ela; a 1.0.0 e a macro seguem registradas e
inalteradas (`git_sha` `c055da33` de 2026-08-20; `promoted_at` nulo nas três).

**Cobertura por forma, medida SOMENTE no período pós-restart** (membros do
universo crypto; "com livro válido" = recebeu alguma linha, já que estimativa
ausente não grava linha por desenho):

| Forma | Ativo | Membros | Com livro válido | Cobertos pela 1.0.0 | Cobertos pela 1.1.0 |
| ----- | ----- | ------- | ---------------- | ------------------- | ------------------- |
| barreira | BTC | 19 | 18 | **0** | **18** |
| barreira | não-BTC | 5 | 4 | 0 | 0 |
| terminal | BTC | 21 | 14 | 14 | **14** |
| terminal | não-BTC | 6 | 5 | 0 | 0 |
| updown | BTC | 2 | 1 | **0** | **1** |
| updown | não-BTC | 1 | 1 | 0 | 0 |
| recusada | BTC | 1 | 1 | 0 | 0 |

**Todo mercado BTC com livro válido e forma reconhecida está coberto.** Os
descobertos são exatamente os previstos: não-BTC (o RTDS não entrega o feed) e
as recusas deliberadas (`between`; o updown de faixa 4–8 AM é o membro sem
livro válido da linha updown/BTC). Cobertura do universo: **14 → 33 mercados
(2,36×)**.

**Zero regressão medida em produção, não só em teste:** no mesmo período a
1.0.0 escreveu **627 linhas em 14 mercados** e a 1.1.0 escreveu **627 linhas
nos mesmos 14 mercados** terminais — contagens idênticas —, mais 203 linhas de
barreira (19 mercados) e 134 de updown (1 mercado).

**Amostras com a proveniência que a RFC exige** (`data_refs`):

| Forma | Pergunta | Strike | Direção | Toque | Buckets varridos | Idade do strike | q | mercado |
| ----- | -------- | ------ | ------- | ----- | ---------------- | --------------- | - | ------- |
| updown | Bitcoin Up or Down on September 1? | **78552,4886** (feed na abertura) | up | — | — | **2000 ms** | 0,0859 | 0,1145 |
| barreira | dip to $74,000 August 31–Sept 6 | 74000 | touch_down | false | 1187 | — | 0,6723 | 0,7750 |
| barreira | reach $80,000 August 31–Sept 6 | 80000 | touch_up | false | 1187 | — | 0,4163 | 0,5350 |
| barreira | dip to $75,000 on September 1 | 75000 | touch_down | false | **415** | — | 0,9705 | 0,9652 |
| barreira | reach $85,000 in September | 85000 | touch_up | false | 415 | — | 0,4505 | 0,3798 |
| barreira | dip to $35,000 by December 31 | 35000 | touch_down | false | 1187 | — | 0,0010 | 0,0450 |

O strike do updown é o feed **2 s antes da abertura da janela** — as-of, dentro
do teto de 5 min, e é o número que a RFC-019 exige que seja reproduzível das
refs. As varreduras de 1187 buckets (janelas de vários dias) e 415 (famílias
"on <data>"/"in <mês>") mostram o piso por família funcionando. Os pares
complementares somam 1 exatamente (0,6723/0,3277; 0,4163/0,5837;
0,0010/0,9990), confirmando o complemento do segundo token nas formas novas.

**Invariantes conferidas em produção:**

- Consumidor: **1.603 linhas, todas `MARKET_BASELINE` com
  `MODEL_IN_SHADOW`** — nenhuma promoção acidental, nenhum modelo servindo.
- **Zero erros** nos seis serviços na hora seguinte ao rebuild (estimator,
  recorder, resolution, paper, portfolio, api).
- **142 ciclos** do estimator, zero falha de token.
- **RAM do estimator: 37,45 MiB de 192 MiB (19,5%)** — dentro do limite, já
  com a segunda versão em shadow rodando a cada ciclo (eram 29,81 MiB com uma
  só).

**O que ainda não aconteceu, e por quê:** o próximo relatório de calibração
(job diário) é que vai materializar `formSlices` e `coverage_by_form` com as
formas novas, e o N=100 da 1.1.0 começa a contar agora que ela estima —
labels das formas novas resolvem a ~52 mercados/dia. O primeiro veredito com
dados dela pode perfeitamente ser `NO_EVIDENCE_OF_ALPHA`; isso é o desenho do
projeto funcionando, não falha da entrega.

## Não verificado

- Promoção de modelo (deliberado: exige gate PASS + ação manual do
  proprietário; nada aqui mexe no gate).
- Comportamento com feeds de eth/sol/xrp (o RTDS de produção não os entrega;
  investigação registrada fora deste escopo).
- A qualidade preditiva das formas novas — é exatamente o que o shadow +
  walk-forward vão medir; `NO_EVIDENCE_OF_ALPHA` é um desfecho possível e
  aceitável do desenho.
