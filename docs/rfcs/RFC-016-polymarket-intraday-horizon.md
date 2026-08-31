# RFC-016 — Polymarket: horizonte intradia e universo rápido

**Status:** accepted
**Dependências:** RFC-007 (registro de universo e versionamento de regras, ativos), RFC-010 (modelo fundamental, label store e gate, ativos), RFC-011 (paper features, código completo), RFC-012 (risco de resolução, ativa)
**Habilita:** a evidência que o gate da RFC-010 nunca conseguiu acumular; a aba "Rápidos" da RFC-015 (só o dado, sem UI)

## Prompt a executar

Tornar o **instante real de fim de mercado** legível por todos os consumidores,
em vez de só pelos que já leem a cadeia versionada de regras. Não é uma RFC de
modelo: nenhuma fórmula muda, nenhum gate afrouxa, nenhuma tabela nova nasce.
Uma coluna aditiva, dois call sites de captura, quatro consumidores auditados e
uma prioridade de horizonte no cap do universo.

---

## Motivação (medida em produção, e ela corrige o diagnóstico de 2026-08-28)

O escopo aprovado pelo proprietário em 2026-08-28 partia de um diagnóstico que a
re-medição de **2026-08-31 (23:00–23:20Z, produção)** desmente em quase todos os
pontos. O registro honesto vem primeiro, porque o desenho depende dele.

### O que foi desmentido

| Premissa de 2026-08-28                                | Medido em 2026-08-31                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| "gravamos só `end_date_iso` (date-only)"              | `polymarket_rule_versions.end_date` é `TIMESTAMPTZ` e **já carrega o instante cheio da Gamma**: 1005 de 1046 versões abertas têm hora intradia; as 41 restantes são meia-noite de verdade (mercados do Fed, fim de ano) |
| "558 mercados crypto ativos constam vencidos"         | reproduz como **703** hoje — e **todos** são linhas de registro obsoletas de mercados que já saíram do universo. Membros do universo com `end_date_iso` vencido: **0**. Membros cujo fim REAL já passou: **1 de 83** (o mercado que venceu 6 min antes da medição) |
| "nenhum mercado aparece com horizonte < 6 h"          | **2** membros com < 1 h e **29** com < 6 h no instante da medição                                                          |
| "a cadência de 10 s nunca ativa"                      | **ativa**. Três tokens com gap mediano de **10,0 s** nos últimos 20 min; **6.164 das 20.471** estimativas de 24 h estão no bucket `lt_1h` — é o maior bucket do dia |
| "gap medido nos updown vivos: 60 s"                   | o número está certo e a leitura errada: 60 s é a **mediana da mistura**. Na última hora de vida do mercado o gap é 10 s     |
| "o cap rejeitou ~46 mercados/dia"                     | última rejeição por cap: **2026-08-29 09:59Z**. Zero nas últimas 24 h. Universo em 83/100 mercados e 142/200 tokens          |
| "~1.586 enter/exit por semana"                        | **1.492 enter / 1.502 exit** em 7 dias — confirmado                                                                        |

O `end_date_iso` **é** date-only (1056 de 1056 linhas), e a Gamma **devolve** o
instante cheio em `endDate`. As duas coisas são verdade. O que não é verdade é
que ninguém grave o instante: `registry.ts` já o passa para
`applyRuleObservation`, que o grava em `polymarket_rule_versions.end_date`
desde a RFC-007. O horizonte das features (`features.ts:348`) lê essa coluna
primeiro. Por isso a cadência funciona.

### O defeito real — mesma causa raiz, consequência muito maior

O `end_date_iso` é uma cópia **com perda** de um dado que já temos completo, e
está na tabela plana, que é o lugar óbvio para ler. Dos consumidores que
precisam do horizonte, quatro leem a cadeia versionada e acertam; **dois leem a
coluna plana e erram**. Um deles é o label store.

**Defeito A — `labels.ts:472`: a evidência do gate é descartada.**

`loadMarketRows` lê `end_date_iso` e `publiclyKnowableInstant` toma o
**mínimo** entre esse valor e o instante da proposta UMA. Com um date-only, o
mínimo é a meia-noite do dia do vencimento:

- **1.572 de 1.670** labels (94%) têm `publicly_knowable_ts` às 00:00:00 exatas;
- **1.616 de 1.670** (97%) estão mais de meia hora adiantados em relação ao fim
  real da regra — mediana **16,00 h**, p90 **20,00 h**.

E `calibration.ts` filtra a evidência com `AND e.decision_ts <
l.publicly_knowable_ts`. Logo, tudo que foi estimado depois da meia-noite do
dia do vencimento **é silenciosamente descartado da pontuação**:

| Conjunto                                                    | Pontuável hoje  | Pontuável com o instante real |
| ------------------------------------------------------------ | ---------------- | ------------------------------ |
| Estimativas `MODEL` com label final                          | 36.212 (48,7%)  | **74.412 (100%)**              |
| Estimativas `active` (baseline) com label final              | 159.341 (60,0%) | **265.480 (100%)**             |
| Estimativas na **última hora de vida** do mercado            | **0 de 8.063**  | **8.063 (100%)**               |

A última linha é a RFC inteira. A cadência de 10 s, decidida pelo proprietário
em 2026-08-22 e ativa desde 2026-08-23, existe para produzir exatamente essas
8.063 estimativas — as do intervalo em que o modelo tem alguma chance de bater
o mercado. **Cem por cento delas são jogadas fora antes de virarem evidência.**
Isto é a explicação mecânica do bloqueio que o HANDOFF carrega desde 20/08: "o
gate da RFC-010 ainda não tem como acumular evidência".

**Defeito B — `paper/runner.ts:204`: horizonte negativo pede a janela mais fina.**

`ACTIVE_TOKENS_SQL` lê `MAX(m.end_date_iso)` e o runner calcula
`endDate - now`. Para um mercado que fecha às 23:00Z, às 10:00Z esse cálculo dá
**−10 h**. E `windowKindsForHorizon` testa `msToEnd <= 60 * 60_000`, que um
número negativo satisfaz: o token recebe o conjunto mais caro,
`["1s", "10s", "1m"]`, o dia inteiro.

Nas últimas 6 h de produção: **63.951 de 84.772** janelas `10s` (75%) e **3.936
de 10.481** janelas `1s` (38%) foram computadas para mercados cujo horizonte
real passava de 6 h. `paper_feature_windows` está em **1095 MB contra uma quota
de 0,6 GB** (182% — a poda por quota vem trabalhando contra este desperdício).

### Conclusão do diagnóstico

O trabalho a fazer é o mesmo que o proprietário aprovou — tornar o horizonte
intradia real e legível — mas o alvo muda: não é ligar uma cadência que já está
ligada, é **parar de jogar fora o que ela produz**, e fechar a armadilha da
coluna date-only para que o terceiro consumidor não repita o erro.

---

## Objetivo

1. Uma coluna `end_ts TIMESTAMPTZ` em `polymarket_markets`, preenchida
   prospectivamente nos **dois** call sites que observam a Gamma.
2. Os dois consumidores quebrados passam a resolver o horizonte pela mesma
   ordem que os outros quatro já usam, com fallback que conserta o acervo
   histórico sem nenhum UPDATE retroativo.
3. Prioridade explícita por horizonte no cap do universo, com reserva de slots.
4. O horizonte real exposto nos payloads de leitura já publicados.
5. O modelo de volumetria do `budget.test.ts` recalibrado com a distribuição
   medida, **sem afrouxar o piso `horizonte + 27 h`**.

## Restrições não negociáveis

- **Migrations aplicadas não mudam.** A 0016 (índice da FK de
  `portfolio_panel_snapshots`) está aplicada e é intocável; esta RFC é a
  **0017**. Mudança de banco retrocompatível: o rollback do CD não desfaz
  migration.
- **Nenhum UPDATE retroativo em histórico imutável.** `end_ts` nasce `NULL` e é
  preenchida conforme a Gamma re-observa cada mercado — o mesmo padrão do
  `questionID` da RFC-012. O acervo histórico é consertado por **ordem de
  leitura**, não por reescrita.
- **A INVARIANTE DE EVIDÊNCIA da RFC-010 fica.** Uma estimativa precisa
  sobreviver `horizonte + ~27 h` para virar evidência. `budget.test.ts` segura
  esse piso; ele não pode ser afrouxado, nem por baixo (encurtar a janela) nem
  por cima (aceitar um teto que não o clareia).
- **Fail-closed.** Um `end_ts` ausente nunca vira "horizonte zero" nem
  "horizonte infinito": cai para a próxima fonte da ordem, e na falta de todas
  o consumidor se comporta como hoje com `endDate === null`.
- **Uma fonte de verdade as-of.** O histórico as-of do fim de mercado continua
  sendo `polymarket_rule_versions.end_date` — ver a decisão de desenho abaixo.

## Decisões de desenho (com o motivo medido)

### D1 — `end_ts` só em `polymarket_markets`, não no histórico as-of

O escopo aprovado pedia a coluna também em
`polymarket_market_metadata_versions`. **Não vamos fazer isso**, e o motivo é
que o histórico as-of do fim de mercado **já existe e está correto**:
`polymarket_rule_versions.end_date` é `TIMESTAMPTZ`, é versionada com
`[valid_from, valid_to)`, entra no `content_hash` normativo (logo uma mudança
de `endDate` pela Gamma abre versão nova por construção) e é onde o `endDate`
semanticamente mora — ele faz parte das regras de resolução, junto de
`uma_end_date`, `uma_bond` e `custom_liveness`.

Duplicá-lo em `polymarket_market_metadata_versions` criaria **duas cadeias
as-of para o mesmo fato**, com dois triggers append-only distintos e nenhuma
garantia de que concordem. O custo do erro é assimétrico: um backtest que lesse
a cadeia errada produziria um horizonte divergente do que o estimador usou no
mesmo instante, e não haveria como saber qual estava certo.

`polymarket_markets.end_ts` é, deliberadamente, uma coluna **mutável in place**,
como todo o resto daquela tabela — é a identidade corrente, não o histórico.
Por isso ela nunca pode ganhar precedência sobre a versão as-of (ver D3).

Decisão registrada e aprovada pelo proprietário em 2026-08-31.

### D2 — sem `event_start_ts` nesta RFC

O escopo previa capturar `eventStartTime`. Medição contra a API pública da
Gamma em 2026-08-31: **`eventStartTime` vem `null` em 100 de 100** mercados
crypto ativos, e `gameStartTime` também. Não há dado para capturar. Uma coluna
que a fonte nunca preenche é peso morto, e o padrão prospectivo do
`questionID` só funciona porque a API de fato devolve o campo. Fica registrado
para quando a Gamma passar a mandar. Decisão aprovada pelo proprietário em
2026-08-31.

### D3 — a ordem de resolução do horizonte, e por que ela é essa

```
horizonte as-of   :  rule_versions.end_date  →  markets.end_ts  →  markets.end_date_iso
horizonte corrente:  markets.end_ts          →  rule_versions.end_date  →  markets.end_date_iso
```

Duas ordens, porque as duas perguntas são diferentes:

- **As-of** (features da RFC-010, portfólio, resolução): a pergunta é "qual era
  o fim em vigor no instante da decisão". A cadeia versionada é a única resposta
  honesta, e `end_ts` — mutável — entra só como fallback à frente do date-only.
- **Corrente** (label store, paper features, payloads de leitura): a pergunta é
  "qual é o fim deste mercado agora". A tabela plana é a resposta natural, e a
  versão aberta mais recente é o fallback.

O fallback para `rule_versions.end_date` no caminho corrente é o que **conserta
o acervo histórico sem UPDATE retroativo**: os mercados já resolvidos, que
saíram do universo e nunca mais serão re-observados pela Gamma, jamais terão
`end_ts`, mas todos têm uma versão de regra com o instante correto. É por isso
que os 74.412 da tabela acima viram evidência no dia do deploy, e não daqui a
três meses.

`end_date_iso` permanece como último recurso, e permanece na tabela: é uma
coluna aplicada desde a migration 0004, o registro do que a Gamma devolveu em
`endDateIso`, e apagá-la seria reescrever histórico.

### D4 — prioridade por horizonte no cap, com reserva de slots

O `capPriority` atual devolve **3** (penúltima prioridade) para a série curta —
o padrão `SHORT_SERIES_PATTERN` classifica exatamente os updown de 5–15 min e
1 h como os primeiros a serem cortados. Enquanto o cap não morde isso é inócuo
(zero rejeições por cap desde 29/08), mas é uma bomba-relógio: no dia em que o
universo voltar a encostar em 100 mercados, os mercados de horizonte curto —
a razão de existir da cadência de 10 s — são os primeiros a sair.

O desenho é **reserva de slots por bucket, aplicada antes da ordenação por
prioridade**:

- `SHORT_HORIZON_RESERVED_MARKETS = 25` slots dos 100 são reservados a mercados
  com horizonte real ≤ 6 h;
- a reserva é **oportunista**: se houver menos de 25 mercados curtos elegíveis,
  os slots sobrando voltam para a fila geral. Nunca se desperdiça slot;
- dentro da reserva a ordem é por horizonte crescente (o que vence antes entra
  antes), e não pela ordem de volume da Gamma;
- fora da reserva, a prioridade atual é preservada **inteira**, incluindo o
  macro agendado em priority 1;
- o `capPriority` passa a considerar o horizonte real para a série curta:
  um updown com ≤ 6 h de vida sobe para prioridade **2** (junto do crypto
  diário/semanal); um "up or down" com semanas pela frente continua em 3.

**Efeito declarado no que é gravado.** O giro medido é de 1.492 enter e 1.502
exit por semana. A reserva não altera o giro enquanto o cap não morder — e ele
não morde há dois dias. Quando morder, ela troca até 25 mercados de horizonte
longo por até 25 de horizonte curto, o que **aumenta** a taxa de escrita em
`fundamental_estimates` (mercado curto é amostrado a 10 s, longo a 10 min) e
**aumenta** o giro, porque mercado curto entra e sai em horas. O teto desse
aumento é o próprio cap, que não muda, e está modelado no `budget.test.ts`
reescrito.

### D5 — volumetria: o teto honesto, com o piso intacto

O `MEASURED_ROW_SHARE` do `budget.test.ts` é de 2026-08-22 e está muito
defasado. Medição de 2026-08-31 (48 h, amostra horária, membros do universo
naquele instante, horizonte as-of pela versão de regra em vigor):

| Bucket   | Modelo de 2026-08-22 | Medido em 2026-08-31 |
| -------- | -------------------- | -------------------- |
| `lt_1h`  | 0,3%                 | **6,32%**            |
| `1h_6h`  | 2,8%                 | **9,55%**            |
| `6h_24h` | 7,4%                 | **31,95%**           |
| `1d_7d`  | 14,5%                | **31,10%**           |
| `gt_7d`  | 75,0%                | **21,08%**           |

Com a distribuição real, o **teto modelado** (200 tokens, todo token rendendo
linha a cada período de cadência, mais uma linha shadow) sobe de ~47 k para
**~170 k linhas/dia**, e a quota de 2 GB compra **6,2 dias** em vez dos 24 que
o modelo antigo prometia. A **taxa realmente escrita** em produção é de 20.396
linhas em 24 h — 8,3× abaixo do teto, porque estimativa ausente não grava linha
(`NO_BOOK`, `DEPTH_BELOW_SREF`, `BOOK_STALE` dominam os ciclos) — e nessa taxa
a mesma quota compra **~100 dias**.

O teto apertou. **O piso não se move.** Decisão do proprietário em 2026-08-31,
consultado com estes números: manter a quota em 2 GB e tornar o teste honesto —
a asserção de piso passa a ser a **invariante em si** (`horizonte + 27 h` =
1,125 dia) medida sobre o **teto**, que a clareia por **5,5×**; e a margem de
7× que o teste exigia continua exigida, mas sobre a **taxa medida em produção**,
que é o número em que a decisão de quota de 2026-08-24 sempre se baseou (o
comentário do próprio arquivo já dizia isso: "at the rate actually measured in
production (~23 MB/day) it buys ~87 days — the number the owner's 2026-08-24
rebalancing decision was based on"). O que muda é a admissão de que a margem de
7× estava sendo cobrada de um teto calculado sobre uma distribuição errada.

Nada disto encurta a janela de retenção nem afrouxa o piso: `RETENTION_TABLES`
não é tocada, a quota segue em 2 GB e o TTL em 90 dias.

## Tarefas

### T1 — migration 0017 (aditiva)

```sql
ALTER TABLE polymarket_markets ADD COLUMN IF NOT EXISTS end_ts TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS polymarket_markets_end_ts_idx
    ON polymarket_markets (end_ts) WHERE end_ts IS NOT NULL;
```

Nullable, sem default, sem backfill. Índice parcial porque toda consulta nova
filtra por `end_ts IS NOT NULL` (as "próximas a vencer" da futura aba
"Rápidos"). Nenhuma outra tabela é tocada.

### T2 — captura nos dois call sites

A lição do PR #49 é que `registry.ts` e `samplers.ts` consultam a Gamma com
parâmetros diferentes e que a assimetria entre eles foi a causa raiz do bug das
categorias. Os dois caminhos passam a gravar `end_ts`:

- **`registry.ts`** (`upsertMarket`, ciclo de 10 min do universo): acrescenta
  `end_ts` ao INSERT e ao `DO UPDATE`, com o valor de
  `parseIsoDate(record.endDate)` — o mesmo que já alimenta a versão de regra,
  para que as duas não possam divergir na origem.
- **`samplers.ts`** (varredura de pendentes, que fetcha com `closed=true` os
  mercados que já saíram do universo): a varredura hoje só grava versão de
  metadata e nunca toca `polymarket_markets`. Passa a gravar `end_ts` por uma
  escrita **aditiva e mínima** — `applyMarketEndTsObservation` —, que só
  atualiza essa coluna e **nunca a apaga**: uma observação sem `endDate` deixa o
  valor anterior de pé, pela mesma razão que `categoryToRecord` nunca apaga
  categoria (null significa "não observado", não "não tem").

Escrever a linha inteira do registro a partir da varredura seria uma mudança
maior e de risco maior; a escrita mínima entrega a simetria que a lição do #49
pede sem trazer o resto junto.

### T3 — auditoria dos consumidores, um a um

O grep de `end_date_iso` e `end_date` sobre `apps/api/src` dá **onze** leitores.
A decisão de cada um, com o motivo, entra no PR:

| Leitor                                      | Lê hoje              | Decisão                                                                 |
| ------------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `fundamental/features.ts:348` (as-of)       | `rule.end_date` → iso | **muda**: insere `end_ts` entre os dois. A regra versionada continua ganhando — é a resposta as-of |
| `fundamental/labels.ts:472` (corrente)      | `end_date_iso`        | **muda — é o defeito A**: `COALESCE(end_ts, rule.end_date, end_date_iso)` |
| `paper/runner.ts:66` (corrente)             | `end_date_iso`        | **muda — é o defeito B**: mesma ordem corrente                            |
| `readapi.ts:282,373` (leitura pública)      | `end_date_iso`        | **muda**: acrescenta `end_ts` ao payload; `end_date_iso` fica, é o que a Gamma devolveu |
| `resolution/api.ts:152` (leitura pública)   | —                     | **muda**: acrescenta `m.end_ts` ao SELECT que já dá `LEFT JOIN` em markets |
| `portfolio/api.ts:159` (leitura pública)    | —                     | **muda**: acrescenta `end_ts` por `LEFT JOIN` para a aba "Rápidos"        |
| `paper/featurestore.ts:74`                  | `rule.end_date`       | **não muda** — já é a fonte certa, e é as-of por natureza                 |
| `portfolio/store.ts:80`, `exitstore.ts:76`  | `rule.end_date`       | **não muda** — as-of, correto                                             |
| `resolution/store.ts:343,393`, `ladder.ts`  | `rule.end_date`       | **não muda** — as-of, e a `ladder` documenta explicitamente que a chave temporal vem da regra versionada, nunca de parsing |
| `resolution/clarify.ts:145`                 | `rule.end_date`       | **não muda** — detecta mudança de regra, não horizonte                    |
| `recorder.ts:236` (upsert V1)               | `end_date_iso`        | **não muda** — caminho morto: `runRecorder`/`createPostgresRecorderStore` não têm chamador fora do próprio arquivo desde que o orquestrador migrou para `runGammaCycle`. Mexer nele seria manutenção de código morto |

### T4 — prioridade por horizonte no cap (D4)

Em `registry.ts`: `capPriority` passa a receber o horizonte real; `selectUniverse`
ganha a reserva oportunista de 25 slots. O motivo do `enter` no
`polymarket_universe_log` passa a carregar o bucket, para que o giro por
horizonte seja medível depois do deploy sem query nova.

### T5 — `budget.test.ts` recalibrado (D5)

Distribuição medida, teto honesto, piso intacto, e um teste novo que trava a
relação: o teto tem de clarear a invariante `horizonte + 27 h`, e a taxa medida
tem de clarear a margem de 7×.

## Testes obrigatórios

- **Migration 0017 contra PostgreSQL real** (`postgres:18.4-bookworm`, as 17
  migrations em sequência, protocolo do `apply.sh` com checksum): a coluna e o
  índice parcial existem; `end_ts` aceita `NULL`; a coluna é gravável e
  regravável (é identidade corrente, não histórico).
- **Simetria dos dois call sites** (a lição do #49): um teste que roda o ciclo
  do registro e a varredura de pendentes contra o mesmo `conditionId` e exige
  que os dois gravem o mesmo `end_ts` a partir do mesmo payload da Gamma; e um
  segundo que prova que a varredura **não apaga** um `end_ts` conhecido quando o
  payload vem sem `endDate`.
- **Regressão do defeito A**, verificada falhando no código anterior: um
  mercado que fecha às 23:00Z com estimativa às 22:30Z produz label cujo
  `publicly_knowable_ts` é 23:00Z (hoje seria 00:00Z) e a estimativa entra na
  janela de pontuação da calibração (hoje é descartada).
- **Regressão do defeito B**, verificada falhando no código anterior: um token
  cujo fim real está a 13 h recebe `["1m"]`; hoje, com o date-only, recebe
  `["1s","10s","1m"]`. Mais um teste direto em `windowKindsForHorizon` para
  horizonte negativo, que deve devolver a janela mais grossa e não a mais fina.
- **Ordem de resolução do horizonte**: as duas ordens (as-of e corrente)
  cobertas em tabela, incluindo o caso que conserta o acervo (`end_ts` nulo,
  `rule.end_date` presente) e o caso em que a coluna mutável não pode vencer a
  as-of.
- **Reserva de slots**: com 100 mercados longos e 30 curtos elegíveis e cap de
  100, exatamente 25 curtos entram; com 5 curtos elegíveis, os 95 slots restantes
  vão para os longos (reserva oportunista, zero desperdício); o macro agendado
  em priority 1 continua entrando.
- **Volumetria**: o teto modelado com a distribuição medida clareia
  `horizonte + 27 h`; a taxa medida clareia a margem de 7×; a cadência continua
  não-crescente em resolução e `estimateIntervalMs <= cadence.lt_1h`.
- `make verify` verde.

## Critérios de aceite (verificados em produção depois do deploy completo)

1. `end_ts` preenchida para os membros do universo dentro de dois ciclos de
   registro (20 min), e para os pendentes dentro de um ciclo da varredura.
2. Distribuição de horizonte sã: ~0 membros do universo com fim real no passado;
   updown de 1 h aparecendo no bucket `< 1 h`.
3. **`publicly_knowable_ts` deixa de ser meia-noite**: a proporção de labels
   novos com `::time = '00:00:00'` cai de 94% para perto de zero, e as
   estimativas da última hora de vida passam a ser pontuáveis (de 0 para > 0).
4. Gap de ~10 s nos updown vivos na última hora de vida — confirmação de que a
   cadência que já funcionava continua funcionando.
5. Janelas `1s`/`10s` do paper caem: a fração computada para mercados com
   horizonte real > 6 h vai de 75% para ~0.
6. Volume de `fundamental_estimates` nas primeiras 48 h dentro da quota, com a
   taxa nova medida e comparada ao modelo do `budget.test.ts`.
7. Zero erros novos em recorder, estimator e paper.

## Condições de parada

- Afrouxar o piso `horizonte + ~27 h` do `budget.test.ts`.
- Qualquer UPDATE retroativo em histórico imutável (versões de regra, versões de
  metadata, labels já gravados).
- Quota de `fundamental_estimates` estourando sem decisão do proprietário.
- `make verify` vermelho.
- Descobrir que a cadeia `polymarket_rule_versions.end_date` diverge do que a
  Gamma devolve — nesse caso o desenho inteiro (D1, D3) precisa ser refeito
  antes de qualquer código.
