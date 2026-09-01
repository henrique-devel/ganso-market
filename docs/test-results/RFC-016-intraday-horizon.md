# Evidência de verificação — RFC-016 (horizonte intradia e universo rápido)

- Data: 2026-08-31 (noite, BRT) / 2026-08-31 23:00Z–2026-09-01 (UTC)
- Branch: `claude/rfc-016-horizonte-intradia-5c57a8`
- Ambiente: macOS do proprietário, worktree durável em
  `.claude/worktrees/rfc-016-horizonte-intradia-5c57a8`; PostgreSQL 18.4
  descartável em Docker para a migration e as suítes de integração; produção
  por SSH (`178.105.65.251`) para as medições e a verificação final.

Este documento registra **somente comandos realmente executados e seus
resultados reais**. Onde algo não foi executado, isso está dito explicitamente
na seção "Não verificado".

---

## 1. Re-medição: o diagnóstico de 2026-08-28 está errado

Antes de qualquer código, os fatos do prompt foram re-medidos contra a produção
e contra a API pública da Gamma. **Cinco das sete premissas não se sustentam.**

Consultas executadas em `ganso-market-postgres-1` em 2026-08-31 entre 23:00Z e
23:20Z.

| Premissa de 2026-08-28                       | Medido em 2026-08-31                                                                                          | Veredito     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| Gamma devolve `endDate` com instante cheio    | confirmado (`"2026-09-16T00:00:00Z"`, `"2026-08-31T23:00:00Z"`, …)                                              | **confirma** |
| Gamma devolve `eventStartTime`                | **`null` em 100 de 100** mercados crypto ativos; `gameStartTime` idem                                            | **refuta**   |
| "gravamos só `end_date_iso` (date-only)"      | `end_date_iso` é date-only em **1056/1056**, mas `polymarket_rule_versions.end_date` tem o instante em **1005/1046** versões abertas (41 são meia-noite real) | **refuta**   |
| 558 crypto ativos "vencidos"                  | reproduz como **703** — todas linhas obsoletas de mercados fora do universo. Membros com `end_date_iso` vencido: **0**. Membros com fim real no passado: **1 de 83** | **refuta**   |
| nenhum mercado com horizonte < 6 h            | **2** membros < 1 h, **29** < 6 h no instante da medição                                                        | **refuta**   |
| a cadência de 10 s nunca ativa                | **ativa**: 3 tokens com gap mediano **10,0 s** nos últimos 20 min; **6.164 de 20.471** estimativas de 24 h no bucket `lt_1h` | **refuta**   |
| gap nos updown vivos = 60 s                   | 60 s é a mediana da mistura; na última hora de vida é 10 s                                                       | **confirma o número, refuta a leitura** |
| cap rejeitou ~46 mercados/dia                 | última rejeição por cap **2026-08-29 09:59:00Z**; **0** nas últimas 24 h; universo 83/100 mercados, 142/200 tokens | **refuta**   |
| ~1.586 enter/exit por semana                  | **1.492 enter / 1.502 exit** em 7 dias                                                                          | **confirma** |

Saída real da medição da cadência (últimos 20 min, `status='active'`):

```text
   token    |                  question                  | rows | p50_gap_s
------------+--------------------------------------------+------+-----------
 5116090903 | Bitcoin Up or Down - August 31, 6PM ET     |   58 |      10.0
 4546944319 | Bitcoin Up or Down - August 31, 4:00PM-8:0 |   54 |      10.0
 2773962278 | Will USD be between 2.1M and 2.2M Iranian  |   28 |      10.0
 2768947953 | Will Bitcoin reach $80,000 on August 31?   |   19 |      60.0
```

E o log do estimador, que mostra o laço de 10 s servindo exatamente o bucket
curto:

```text
ESTIMATOR_CYCLE ... markets:83 tokens_considered:4  tokens_rate_limited:162
ESTIMATOR_CYCLE ... markets:83 tokens_considered:46 tokens_rate_limited:120
```

## 2. O defeito real: a evidência do gate é descartada

`fundamental/labels.ts` lia `end_date_iso` e alimentava
`publiclyKnowableInstant`, que toma o **mínimo** entre esse valor e a proposta
UMA. `calibration.ts` filtra a evidência com
`AND e.decision_ts < l.publicly_knowable_ts`.

```text
== labels com knowable_ts à meia-noite exata ==
 knowable_meia_noite | total
---------------------+-------
                1572 |  1670

== adiantamento em relação ao end_date real da regra ==
 comparaveis | adiantados | p50_h | p90_h |  max_h
-------------+------------+-------+-------+---------
        1670 |       1616 | 16.00 | 20.00 | 3195.34

== evidência pontuável, hoje vs com o instante real ==
 estimativas_model_com_label | pontuaveis_hoje | pontuaveis_com_end_real
-----------------------------+-----------------+-------------------------
                       74412 |           36212 |                   74412

== o mesmo corte, só na ÚLTIMA HORA de vida do mercado ==
 na_ultima_hora | pontuaveis_hoje
----------------+-----------------
           8063 |               0

== lane baseline (status='active') ==
 total_active_com_label | pontuaveis_hoje | pontuaveis_com_end_real
------------------------+-----------------+-------------------------
                 265483 |          159341 |                  265480
```

**Zero de 8.063.** A cadência de 10 s funciona e cem por cento do que ela
produz é descartado antes de virar evidência. Este é o mecanismo por trás do
bloqueio "o gate da RFC-010 ainda não tem como acumular evidência" que o
HANDOFF carrega desde 2026-08-20.

Defeito secundário, em `paper/runner.ts` + `windowKindsForHorizon`: o horizonte
date-only fica **negativo** durante quase todo o dia e um número negativo
satisfaz o teste `<= 1 h`, então o token recebia o conjunto de janelas mais
caro em vez do mais barato.

```text
== janelas 1s/10s das últimas 6 h, por horizonte real do mercado ==
 window_kind | total | horizonte_real_maior_6h
-------------+-------+-------------------------
 10s         | 84772 |                   63951      (75%)
 1s          | 10481 |                    3936      (38%)

== tamanho da tabela contra a quota ==
 paper_feature_windows | 1095 MB   (quota declarada: 0,6 GB)
```

## 3. Auditoria dos leitores de horizonte (grep, um a um)

`grep -rn "end_date_iso\|end_date\b" apps/api/src` → **onze** leitores.

| Leitor                                     | Lia                   | Decisão      | Motivo                                                              |
| ------------------------------------------ | --------------------- | ------------ | ------------------------------------------------------------------- |
| `fundamental/features.ts:348`              | `rule.end_date` → iso | **mudou**    | `end_ts` inserido entre os dois; a regra as-of continua ganhando     |
| `fundamental/labels.ts:472`                | `end_date_iso`        | **mudou**    | defeito A                                                            |
| `paper/runner.ts:66`                       | `end_date_iso`        | **mudou**    | defeito B                                                            |
| `readapi.ts:282,373`                       | `end_date_iso`        | **mudou**    | expõe `end_ts`; `end_date_iso` fica (é o que a Gamma devolveu)       |
| `resolution/api.ts:152`                    | —                     | **mudou**    | `m.end_ts` no SELECT que já dava LEFT JOIN em markets                |
| `portfolio/api.ts:159`                     | —                     | **mudou**    | `end_ts` por LEFT JOIN, para a futura aba "Rápidos"                  |
| `paper/featurestore.ts:74`                 | `rule.end_date`       | não mudou    | já é a fonte certa e é as-of por natureza                            |
| `portfolio/store.ts:80`, `exitstore.ts:76` | `rule.end_date`       | não mudou    | as-of, correto                                                       |
| `resolution/store.ts:343,393`, `ladder.ts` | `rule.end_date`       | não mudou    | as-of; a `ladder` documenta que a chave temporal vem da regra        |
| `resolution/clarify.ts:145`                | `rule.end_date`       | não mudou    | detecta mudança de regra, não horizonte                              |
| `recorder.ts:236`                          | `end_date_iso`        | não mudou    | caminho morto: `runRecorder`/`createPostgresRecorderStore` sem chamador desde a migração do orquestrador para `runGammaCycle` |

## 4. Migration 0017 contra PostgreSQL real

Container descartável `postgres:18.4-bookworm`, migrations `0001`–`0017`
aplicadas em sequência com o mesmo protocolo do `infra/migrations/apply.sh`
(checksum sha256 real por arquivo, `--single-transaction`, `ON_ERROR_STOP=1`):

```text
applied 0001_foundation.sql
...
applied 0016_portfolio_panel_snapshots_decision_id_index.sql
applied 0017_polymarket_market_end_ts.sql
```

| Verificação                                            | Resultado observado                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `schema_versions` do componente `foundation`           | **17**                                                                                |
| Tipo e nulabilidade de `end_ts`                        | `timestamp with time zone`, `is_nullable = YES`, sem default                          |
| Índice parcial                                         | `CREATE INDEX polymarket_markets_end_ts_idx ON public.polymarket_markets USING btree (end_ts) WHERE (end_ts IS NOT NULL)` |
| INSERT sem `end_ts`                                    | aceito, `end_ts_null = t` (o estado prospectivo)                                      |
| Dois UPDATEs sucessivos de `end_ts`                    | aceitos; valor final `2026-08-31 23:30:00+00` (identidade corrente, não histórico)    |
| **Versões de metadata após dois UPDATEs de `end_ts`**  | **1** — o gatilho `market_metadata_version_capture_trg` da 0012 NÃO dispara           |
| Versões de metadata após mudar `question`              | **2** — o gatilho continua funcionando para as colunas que ele vigia                  |
| Checksums 15/16 inalterados, 17 novo                   | `b45302a8…`, `3e564f9076…`, `3309b9a13c…`                                             |

A penúltima linha é a que torna a decisão D1 segura: a escrita estreita da
varredura de pendentes não pode injetar histórico as-of espúrio, porque o
gatilho da 0012 está escopado em `question, category, clob_token_ids,
affirmative_token_id` e o `SET end_ts` não toca nenhuma delas.

## 5. Suíte de testes

### 5.1 Gate de fonte (`make verify`)

```text
format-check  OK (prettier, cargo fmt, ruff)
lint          OK (eslint/tsc, clippy -D warnings, ruff, sh -n)
test          Test Files 96 passed | 5 skipped (101)
              Tests    1426 passed | 57 skipped (1483)
              + web 51 passed, contracts 70 passed
build         OK (tsc, vite, cargo, compileall)
secret-scan   passed
compose-config passed
```

### 5.2 Suítes contra PostgreSQL real

Cada suíte contra o **seu próprio** banco descartável recém-migrado (elas
recriam schema e se destroem mutuamente num banco compartilhado — propriedade
pré-existente do harness, não desta RFC):

| Suíte                                        | Resultado          |
| -------------------------------------------- | ------------------ |
| `test/polymarket/intraday-horizon.pg.test.ts` | **4 passed** (novo) |
| `test/polymarket/versioning.pg.test.ts`       | 2 passed           |
| `test/polymarket/paper/bridge.pg.test.ts`     | 4 passed           |
| `test/polymarket/portfolio/integration.pg.test.ts` | 23 passed     |
| `test/polymarket/fundamental/integration.test.ts` | 7 passed       |
| `test/polymarket/resolution/integration.test.ts`  | 21 passed      |

### 5.3 Regressão verificada falhando no código anterior

Protocolo: as fontes revertidas para `HEAD` com `git checkout --`, os testes
novos mantidos, suíte executada. **Onze** asserções falharam sem a correção:

```text
× scores the last hour of life instead of discarding it            (defeito A)
× repairs the archive from the rule version when end_ts is absent  (defeito A)
× gives the coarse cadence to a negative horizon, not the finest   (defeito B)
× is defended twice over: the right instant, and a safe elapsed horizon
× records the same end_ts from the registry cycle and the pending sweep
× never erases a known end_ts when the payload omits endDate
× does not create a registry row from the sweep
× lifts a short series inside the window and leaves a distant one down
× reserves exactly the short block when short markets are plentiful
× gives unused reserved slots back to the general queue
× labels the horizon bucket on the membership log
```

Duas asserções do arquivo passam **também** no código anterior, e isso é
proposital: `still lets an early UMA proposal win over the end instant` e
`falls back to the date-only column only when nothing else is known` existem
para provar que a correção **não** mudou o comportamento nesses dois casos.

## 6. Volumetria: o teto recalibrado, o piso intacto

Distribuição de tokens do universo por bucket de horizonte, medida em produção
(48 h, amostra horária, horizonte as-of pela versão de regra em vigor naquela
hora, ponderada por tokens):

```text
  bucket  | token_horas |  pct
----------+-------------+-------
 a_lt_1h  |         430 |  6.32
 b_1h_6h  |         650 |  9.55
 c_6h_24h |        2174 | 31.95
 d_1d_7d  |        2116 | 31.10
 e_gt_7d  |        1434 | 21.08
(tokens médios no universo por hora: 141,8)
```

| Grandeza                                        | Modelo de 2026-08-22 | Medido 2026-08-31 |
| ----------------------------------------------- | -------------------- | ----------------- |
| Share `gt_7d`                                   | 75,0%                | **21,08%**        |
| Share `lt_1h`                                   | 0,3%                 | **6,32%**         |
| Teto modelado (200 tokens, consumer + shadow)   | ~47 k linhas/dia     | **~170 k/dia**    |
| Dias que a quota de 2 GB compra **no teto**     | ~24                  | **6,2**           |
| Taxa REAL escrita em 24 h                       | —                    | **20.396 linhas** |
| Dias que a quota compra **na taxa real**        | ~87                  | **~103**          |

Decisão do proprietário, consultado em 2026-08-31 com os dois números: **manter
a quota em 2 GB** e tornar o teste honesto. O `budget.test.ts` passou a:

- assertar a **INVARIANTE** (`horizonte + 27 h` = 1,125 dia) sobre o **teto**,
  o número mais pessimista disponível, que a clareia por **5,5×**;
- assertar a margem de **7×** sobre a **taxa medida em produção**, que é onde a
  decisão de quota de 2026-08-24 sempre a mediu (o próprio comentário do
  arquivo já dizia isso);
- substituir a asserção "corta 4× versus a cadência plana", que não vale mais
  (o corte real é ~1,7×, porque o universo migrou para horizontes curtos), pela
  asserção que de fato importa: **mais de 75% das linhas caem nos buckets
  `lt_1h`/`1h_6h`**, onde uma estimativa ainda pode virar evidência, e menos de
  5% na cauda `gt_7d`.

`RETENTION_TABLES` não foi tocada: quota 2 GB, TTL 90 dias, `protected: false`.

## 7. Verificação em produção

Deploy em três passos: merge do PR #66 → CD verde (que aplicou a migration
sozinho: `schema_versions` foi a **17** sem ninguém rodar nada à mão) → rebuild
de profile em `polymarket-recorder`, `-estimator`, `-paper`, `-portfolio` e
`-resolution` às **2026-08-31 23:57:35Z**.

Revisão confirmada em `/etc/ganso/release-sha` dentro de cada container (não no
`docker compose ps`, que mostra uptime e não idade de imagem):

```text
api                        4bae1b92a1ffb8d9a2910470ccee3a8e1881161d
polymarket-recorder        4bae1b92a1ffb8d9a2910470ccee3a8e1881161d
polymarket-estimator       4bae1b92a1ffb8d9a2910470ccee3a8e1881161d
polymarket-paper           4bae1b92a1ffb8d9a2910470ccee3a8e1881161d
polymarket-portfolio       4bae1b92a1ffb8d9a2910470ccee3a8e1881161d
polymarket-resolution      4bae1b92a1ffb8d9a2910470ccee3a8e1881161d
```

E o schema no banco de produção:

```text
 end_date_iso         | text                     |  (permanece — é o que a Gamma devolveu)
 end_ts               | timestamp with time zone |
    "polymarket_markets_end_ts_idx" btree (end_ts) WHERE end_ts IS NOT NULL
```

### Critérios de aceite

| Critério                                                | Antes                       | Medido em produção após o deploy |
| --------------------------------------------------------- | --------------------------- | -------------------------------- |
| `end_ts` nos membros do universo                        | —                           | **87 de 87 (100%)**, 81 com hora intradia |
| Linhas obsoletas (fora do universo) com `end_ts`        | —                           | **973 seguem NULL** — o desenho prospectivo, sem backfill inventado |
| Membros com fim real no passado                         | 1 de 83                     | **2 de 87** (os que acabaram de vencer, antes do ciclo de saída) |
| Distribuição de horizonte por `end_ts`                  | ilegível na tabela plana    | 3 em `<1 h`, 29 em `1h–6h`, 17 em `6h–24h`, 27 em `1d–7d`, 16 em `>7d` |
| Bucket de horizonte carimbado no `enter`                | não existia                 | **`priority_2_crypto_1d_7d`** às 00:27:46Z |
| Labels com `publicly_knowable_ts` à meia-noite          | **1.572 de 1.670 (94%)**    | **48 de 1.672 (2,9%)**           |
| Estimativas `MODEL` pontuáveis                          | **36.212 de 74.412**        | **74.412 de 74.412 (100%)**      |
| Estimativas da última hora de vida, pontuáveis          | **0 de 8.063**              | **8.063 de 8.063 (100%)**        |
| Gap de estimativa na última hora de vida                | 10 s (já funcionava)        | **10,0 s** (mercado das 00:00Z)  |
| Janelas `10s` em mercado com horizonte real > 6 h       | **63.951 de 84.772 (75%)**  | **0 de 14**                      |
| Janelas `1s` idem                                       | **3.936 de 10.481 (38%)**   | **0 de 2**                       |
| Erros novos (6 serviços)                                | —                           | **0 em todos**, acumulado em 37 min |
| RAM                                                     | —                           | recorder 155/832 MiB, resolution 44/192, estimator 33/192, paper 32/256, portfolio 30/192 |

Os 48 labels que sobraram à meia-noite foram conferidos um a um por amostragem
e são **meia-noite de verdade**: "Bitcoin Up or Down - August 21,
4:00PM-8:00PM ET" termina às `2026-08-22T00:00:00Z`. O número bate com as 41
versões de regra genuinamente à meia-noite medidas na seção 1.

Mudança da mistura de janelas do paper, 6 h antes do deploy contra o período
depois dele:

```text
    periodo    | window_kind | count
---------------+-------------+-------
 pre-deploy 6h | 10s         | 86509
 pre-deploy 6h | 1m          | 44170
 pre-deploy 6h | 1s          | 12980
 pos-deploy    | 1m          |  1710
 pos-deploy    | 10s         |    14
 pos-deploy    | 1s          |     2
```

Normalizado por hora, a taxa de janelas `10s` cai de ~14.400/h para ~38/h.

### Taxa de volume — medida curta, a re-medir em 48 h

Nos primeiros **21,6 min** pós-deploy: **443 linhas**, que projetam
~**29,5 k/dia**, contra **20.818** nas 24 h anteriores ao deploy. **A janela é
curta e enviesada**: contém o vencimento das 00:00Z de vários updown horários,
que é exatamente o pico do bucket de 10 s. Mesmo tomando a projeção pelo valor
de face, a quota de 2 GB compraria ~71 dias — 63× o piso de 27 h — e
`fundamental_estimates` está em **911 MB (44,5% da quota)**.

**Ação para a próxima sessão:** re-medir a taxa em 48 h e comparar com o modelo
do `budget.test.ts`.

### Pendências abertas desta sessão

- ~~O carimbo do bucket no `enter` não foi observado em produção.~~
  **CONFIRMADO às 00:27:46Z**, no primeiro `enter` posterior ao rebuild (a
  Gamma levou meia hora para publicar mercado novo):

  ```text
      at     |         reason
  -----------+-------------------------
   00:27:46Z | enter  | priority_2_crypto_1d_7d
   00:27:46Z | enter  | priority_2_crypto_1d_7d
  ```

  O motivo passou a carregar o bucket de horizonte, então o giro por bucket é
  legível direto do log de membresia, sem join com uma cadeia de regras que já
  andou quando alguém for perguntar.
- **`paper_feature_windows` continua em 1095 MB contra 0,6 GB de quota (178%)**,
  e a poda por quota bate no piso (`RETENTION_QUOTA_NO_PROGRESS`, cutoff =
  floor). É **anterior** a esta RFC; o que ela fez foi fechar a torneira. A
  expectativa é que a tabela desça abaixo da quota conforme o acervo envelhece —
  **verificar em 48 h**; se não descer, é decisão de quota do proprietário.


## 8. Não verificado

- **`event_start_ts` não existe** e não foi criado (decisão D2): a Gamma devolve
  `eventStartTime` nulo em 100/100 mercados crypto medidos. Não há dado para
  capturar hoje.
- **`polymarket_market_metadata_versions` não ganhou coluna de fim** (decisão
  D1): o histórico as-of do instante de fim continua sendo
  `polymarket_rule_versions.end_date`, fonte única.
- O caminho V1 do recorder (`runRecorder`, `createPostgresRecorderStore`)
  continua lendo `end_date_iso` e **não foi alterado**: é código sem chamador.
  Se algum dia voltar a ser usado, precisa da mesma correção.
- A suíte completa rodando contra **um** banco PostgreSQL compartilhado
  continua falhando por destruição mútua de schema entre as suítes de
  integração. É pré-existente e não foi corrigido aqui.
