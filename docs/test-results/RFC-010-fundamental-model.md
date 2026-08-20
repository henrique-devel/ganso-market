# Evidência de verificação — RFC-010 (modelo fundamental Polymarket)

- Data: 2026-08-19/20 (BRT)
- Branch: `claude/rfc-010-estruturacao-producao-3b21cf`
- Ambiente: macOS do proprietário, worktree durável em
  `.claude/worktrees/rfc-010-estruturacao-producao-3b21cf` (lição de
  2026-08-20: workspace de implementação nunca em diretório temporário);
  Docker 29.7.2 local para o PostgreSQL descartável usado nas verificações de
  schema e na suíte de integração.

Este documento registra **somente comandos realmente executados e seus
resultados reais**. Onde algo não foi executado, isso está dito
explicitamente na seção "Não verificado".

## 1. Migration 0006 contra PostgreSQL real

Container descartável `postgres:18.4-bookworm`, todas as migrations
`0001`–`0006` aplicadas em sequência com o mesmo protocolo do
`infra/migrations/apply.sh` (checksum real por arquivo, `--single-transaction`,
`ON_ERROR_STOP=1`):

```text
applied 0001_foundation
applied 0002_auth
applied 0003_domain_events
applied 0004_polymarket
applied 0005_polymarket_data_foundation
applied 0006_polymarket_fundamental_model
```

Constraints exercitadas por SQL direto no mesmo banco, com o resultado real de
cada tentativa:

| Tentativa                                                        | Resultado observado                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| Modelo com janela de treino cruzando 2026-04-28 sem `regime_mix`  | `ERROR: ... "fundamental_models_regime_boundary"` (recusado)   |
| `UPDATE ... SET status='active'` em modelo com `regime_mix=true`  | `ERROR: ... "fundamental_models_regime_mix_never_active"`      |
| `UPDATE` de coluna de identidade (`git_sha`) de um modelo         | `ERROR: fundamental_models identity columns are immutable`     |
| `DELETE` de um modelo                                             | `ERROR: fundamental_models rows are immutable and cannot be deleted` |
| Linha `source='MODEL'` sem `model_id`/`git_sha`/`data_refs`       | `ERROR: ... "fundamental_estimates_model_provenance"`          |
| Linha com `q_lo > q_hi`                                           | `ERROR: ... "fundamental_estimates_interval_ordered"`          |
| Modelo válido `shadow` → `active`                                 | aceito (`UPDATE 1`)                                            |

## 2. Suíte de integração contra PostgreSQL real

`apps/api/test/polymarket/fundamental/integration.test.ts` roda o estimador de
ponta a ponta contra o schema real. Ela é **pulada** quando
`GANSO_TEST_DATABASE_URL` não está definida — o gate de fonte do CI não tem
PostgreSQL, então lá ela aparece como `skipped`, e localmente ela roda de
verdade.

```text
GANSO_TEST_DATABASE_URL=postgres://…  npx vitest run
 Test Files  43 passed (43)
      Tests  513 passed (513)
```

O que a suíte de integração prova, com dados semeados nas tabelas da RFC-007
(mercado crypto no universo, âncora de livro, deltas, TWAP Chainlink, série de
1 minuto, regra versionada):

- para cada token com livro válido existe uma linha, com `source`,
  `status`, `q`, `q_lo`, `q_hi`, `market_prob`, `data_refs` e motivo de
  fallback preenchidos; `q` do baseline é exatamente o microprice executável;
- o rate limit por token (60 s) bloqueia um segundo ciclo dentro do mesmo
  minuto (`tokensRateLimited = 2`, nenhuma linha nova);
- registrar os modelos do catálogo cria versões em `shadow`; o consumidor
  continua lendo `MARKET_BASELINE` com motivo `MODEL_IN_SHADOW`, e as linhas
  `shadow` gravadas têm `model_id`, `model_version`, `feature_set_version`,
  `git_sha` e `data_refs` não nulos;
- promover um modelo sem gate PASS é recusado pelo registry;
- o job de calibração produz gate `NO_EVIDENCE_OF_ALPHA` com a falha
  `INSUFFICIENT_MARKETS`, grava o evento auditável e a promoção continua
  bloqueada com o relatório reprovado anexado;
- as constraints do banco continuam sendo a última linha de defesa: um
  `INSERT` direto de linha `MODEL` sem proveniência e um de intervalo
  invertido são recusados pelo PostgreSQL.

## 3. Gate de fonte completo

```text
make verify   # format-check, lint, test, build, secret-scan, compose-config
```

**verde (exit 0)**, com:

| Suíte                                       | Resultado real                    |
| ------------------------------------------- | --------------------------------- |
| vitest `@ganso-market/api`                  | 507 passed, 6 skipped (513)       |
| vitest `@ganso-market/web`                  | 15 passed                         |
| vitest `@ganso-market/contracts`            | 70 passed                         |
| `cargo test --workspace`                    | 14 passed, 0 failed               |
| `unittest` do model-worker                  | 9 tests, OK                       |
| `unittest` de `scripts/tests`               | 25 tests, OK                      |
| `scripts/scan_secrets.py`                   | passou, nenhum conteúdo impresso  |
| `scripts/check_compose_policy.py`           | passou, agregado 4.160.749.568 B  |

Os 6 `skipped` são exatamente os testes de integração da seção 2, que exigem
um PostgreSQL.

## 4. Testes obrigatórios da RFC-010

| Exigência da RFC                                    | Onde está coberto                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Anti-leakage automatizado em todo feature join      | `features.test.ts` — varre o SQL emitido por **todos** os loaders e falha se algum não tiver limite temporal explícito, e se algum parâmetro `Date` for posterior à decisão |
| `closedTime`/status UMA nunca como feature          | `features.test.ts` — a única coluna lida de `polymarket_resolution_events` é `event_type`, usada como veto; `payload_json` não é selecionado |
| Bucket de 1 min só quando inteiramente no passado    | `features.test.ts` — em 12:00:30 o limite superior é 11:59:00                                  |
| Determinismo (bytes idênticos)                       | `estimate.test.ts`, `microprice.test.ts`, `interval.test.ts`, `crypto-updown.test.ts`, `walkforward.test.ts` |
| Intervalo nunca mais estreito que meio spread        | `interval.test.ts`, `estimate.test.ts`                                                        |
| `q_lo ≤ q ≤ q_hi` sempre                             | `interval.test.ts` (varredura de entradas patológicas) + `CHECK` no banco                     |
| Fallback sempre mais largo que o baseline            | `interval.test.ts`, `estimate.test.ts`                                                        |
| Fallback: book stale, feed stale, exceção, shadow, disputa UMA | `estimate.test.ts` — matriz de 9 motivos, todos degradando sem lançar erro           |
| Book inválido ⇒ ausência de estimativa               | `estimate.test.ts` — `NO_BOOK`, `BOOK_STALE`, `SPREAD_TOO_WIDE`, `DEPTH_BELOW_SREF`, `BOOK_CROSSED` |
| Gate: modelo pior ⇒ `NO_EVIDENCE_OF_ALPHA` e 409     | `gate.test.ts`, `api.test.ts`, `integration.test.ts`                                          |
| Fronteira de regime 28/abr/2026                      | `registry.test.ts` + `CHECK` no banco (seção 1)                                               |
| `regime_mix=true` inelegível a promoção              | `registry.test.ts` + `CHECK` no banco (seção 1)                                               |
| Labels 0, 1, 0,5; disputado só após resolução final  | `labels.test.ts`                                                                              |
| Degenerados fora do headline                         | `walkforward.test.ts`, `labels.test.ts`                                                       |
| Parser macro: regra inequívoca vs ambígua            | `macro-scheduled.test.ts`                                                                     |
| Proveniência completa em toda linha `MODEL`          | `estimate.test.ts` + `CHECK` no banco + `integration.test.ts`                                 |
| Busca de código: sem auth de trading/wallet/ordem    | `scope.test.ts` — varre todo o módulo com comentários removidos, e verifica que ele só escreve nas próprias tabelas |
| Orçamento/volumetria                                 | `budget.test.ts` (ver seção 5)                                                                |

## 5. Volumetria medida (não estimada)

200.000 linhas representativas inseridas em `fundamental_estimates` no
PostgreSQL real, com os índices desta migration, seguidas de
`VACUUM ANALYZE`:

```text
  rows  | total_bytes | heap_bytes | index_bytes | bytes_per_row
 200000 |   204029952 |  109232128 |    94732288 |        1020.1
```

Consequência aritmética, asseverada em `budget.test.ts`:

- superfície do consumidor: 288.000 linhas/dia (200 tokens × 1 linha/token/
  minuto), dentro da faixa de 150–300 k/dia que a própria RFC projeta;
- **mais as linhas `shadow`**: um token pertence a exatamente uma categoria e
  cada categoria tem uma família de modelo, então cada token grava no máximo
  uma linha shadow por ciclo além da linha do consumidor ⇒ **576.000
  linhas/dia** com os dois modelos do catálogo em shadow;
- a 1.020 B/linha isso é ~588 MB/dia (~294 MB/dia enquanto não houver modelo
  registrado);
- **a quota de 3 GB (metade da reserva de 6 GB das RFCs 010–013) sustenta
  ~5,5 dias com shadow (≈11 dias só com baseline), não os 90 dias do TTL.** Na
  retenção, quota vence TTL: os dados ficam dentro do orçamento local e o que
  encolhe é a janela.
- Para uma janela real de 90 dias dentro de 3 GB, com shadow, seria preciso
  cadência de ~20 min (`min_estimate_gap_ms = 1_200_000`) ou ~52 GB de quota.
  **É decisão do proprietário**, registrada no handoff; o código entrega o
  default da RFC (60 s) e o botão está em `config/fundamental.json`.

Isso importa diretamente para o gate: a janela de retenção é o teto do que o
walk-forward pode enxergar. Com 5,5 dias de estimativas guardadas, acumular
100 mercados resolvidos numa categoria depende de os mercados resolverem
dentro dessa janela — mercados crypto de curta duração resolvem, macro
mensais não. O relatório de calibração passou a registrar a janela que os
dados realmente cobrem (`data_window.observed_from/observed_to`) exatamente
para que essa limitação apareça no relatório em vez de ficar implícita.

## 6. Proveniência (`git_sha`) verificada

O container não tem `.git` (o release é um `git archive`), então o SHA chega
por `export-subst`:

```text
git archive --format=tar HEAD deploy/release-sha | tar -xO deploy/release-sha
3ff38caae0b9b60ac6438f0c7c4fef37509b4b7a
git rev-parse HEAD
3ff38caae0b9b60ac6438f0c7c4fef37509b4b7a
```

Em um checkout comum o arquivo continua com o placeholder literal, e
`resolveGitSha` devolve `null` — o que **bloqueia toda linha `MODEL`** e mantém
o baseline, em vez de carimbar uma revisão falsa (`provenance.test.ts`).

## 7. Rotas registradas

`buildApi` carregado do build real, com as rotas da RFC-007 e da RFC-010
registradas juntas, sem colisão:

```text
├── /polymarket/models (GET, HEAD)
│   ├── /:modelId/calibration (GET, HEAD)
│   ├── /:modelId/promote (POST)
│   └── /:modelId/demote (POST)
└── /polymarket/estimates (GET, HEAD)
    └── /latest (GET, HEAD)
```

## 8. Revisão adversarial

Workflow de revisão com 6 lentes (leakage/as-of, SQL×schema, numérica,
fallback/crash, gate/registry, API/escopo) sobre o diff completo, com
refutação por achado. **A fase de refutação foi interrompida pelo limite de
uso da sessão** (28 de 120 agentes concluíram; 92 falharam com
`session limit`), então a separação automática entre "confirmado" e
"descartado" **não é confiável** e não foi usada como tal.

Os 32 achados brutos foram triados manualmente, um a um, contra o código. O
resultado está no commit `6d526e6` e no seguinte: 20 achados corrigidos
(microprice ponderado por notional limitado em vez de contagem de ações;
retornos só entre minutos contíguos; idade do feed alcançando o intervalo;
sigma envenenado recusado; cobertura do intervalo reimplementada como
frequência realizada; veto de disputa com precedência; instante conhecível
caindo para o `received_at` da proposta; falha de um token não descartando o
ciclo; INSERT fatiado; mercado não-binário no baseline; exceção de modelo
logada; teto explícito de observações; janela do relatório = janela dos dados;
taxa de fallback nula em janela vazia; promoção recusada sobre PASS anterior à
revalidação; UPDATE de promoção guardado pelo relatório lido; `runGate`
relendo o status vivo; `/estimates/latest` limitado por recência; 409
`NO_EVIDENCE_OF_ALPHA` para modelo nunca avaliado; SHA da release assado na
imagem). Cada correção tem teste.

Achados **não** corrigidos, com motivo:

- *"`macro_scheduled` nunca emite estimativa"* — verdadeiro e **intencional**:
  sem consenso/nowcast no calendário o modelo se abstém em vez de inventar
  insumo. É lacuna de dado, registrada como risco aberto no handoff.
- *"`MODEL_TIMEOUT` e `GATE_FAILED` sem emissor"* — declarados no contrato,
  documentados como sem emissor em
  `docs/architecture/fundamental-model-scope.md`. Não são bug.
- *"não existe caminho para `status='retired'`"* — correto; a coluna existe
  para o ciclo de vida futuro e o runbook não promete o contrário.
- *"label store não retrata `is_final` se uma disputa chegar depois da
  resolução"* — **risco residual aceito nesta RFC**, registrado abaixo.

## 9. Correção adjacente na RFC-007 (necessária para a RFC-010)

`createUmaStatusPoller` gravava a transição de status mas **não o desfecho**.
Sem `outcomePrices`/`outcomes` na linha imutável de resolução, o label store da
tarefa 7 não teria o que pontuar e nenhum gate poderia jamais ter evidência. O
poller já buscava o objeto completo do Gamma; passou a extrair e gravar os dois
campos (`samplers.test.ts` cobre). Nenhuma outra alteração de comportamento na
RFC-007.


## 10. Produção (2026-08-20)

PR #6 mergeado, CI/CD verde nos três jobs (`Verify source`, `Verify Compose
runtime`, `Deploy production`), revisão `c055da33` no servidor.

- Migration 0006 aplicada pelo container `migrate` durante o deploy:
  `schema_versions` tem as versões 1–6 e as 6 tabelas `fundamental_*` existem.
- `deploy/release-sha` no servidor contém exatamente
  `c055da33be9f42a9572ee3b224bd3c2b3a3430cd` — o `export-subst` do
  `git archive` funcionou no caminho real de deploy.
- `polymarket-estimator` ativado com
  `--profile polymarket up --build --detach`. Primeiro boot:
  `git_sha_known: true`, os dois modelos do catálogo registrados em `shadow`.
- Quatro ciclos observados, universo cheio (100 mercados, 200 tokens):
  130–158 linhas de consumidor e 25–26 linhas shadow por ciclo,
  `token_failures: 0`, ausências sempre com motivo explícito
  (`BOOK_STALE`, `NO_BOOK`, `DEPTH_BELOW_SREF`, `SPREAD_TOO_WIDE`).
- Estado no banco após 4 ciclos: 571 linhas `MARKET_BASELINE/active` — **todas**
  com `fallback_reason = MODEL_IN_SHADOW`, isto é, nenhum modelo servindo — e
  103 linhas `MODEL/shadow`, **todas** com proveniência completa. Único
  `git_sha` presente: `c055da33`.
- **Zero warnings** e **um erro** nos logs do estimador, no restart provocado
  pelo deploy seguinte: `MODEL_REGISTRATION_FAILED` para um modelo que **já
  estava registrado** (o INSERT usa `ON CONFLICT DO NOTHING`, então não devolve
  linha). Estado benigno relatado como falha — corrigido depois: o caminho
  passou a distinguir "já registrado" (info) de falha real, e o catálogo é
  reconferido na varredura periódica em vez de só no boot, para que uma falha
  transitória se cure sozinha. Zero erros no recorder no mesmo intervalo. Sete
  containers rodando.
- Memória: estimador em 39,4 MiB de 384 MiB; agregado dos sete containers
  ≈ 384 MiB, dentro do orçamento.
- Endpoints: verificados no container da API, os seis respondem **401 sem
  token** (registrados e protegidos). Eles **não** estão publicados pelo Nginx:
  o perímetro da RFC-002 (`location ^~ /api/ { return 404; }`) libera só health
  e auth, e isso vale igualmente para os endpoints de leitura da RFC-007 já
  existentes. Publicar essa superfície é decisão de perímetro do proprietário,
  não foi alterada aqui.

## 11. Riscos residuais

- **Disputa após resolução:** o label store marca `is_final` na resolução e não
  o retrata se uma disputa UMA chegar depois. Na prática a disputa precede a
  resolução final (liveness de 2 h), mas o caso invertido não é tratado; o
  mercado ficaria no headline com o desfecho contestado. Mitigação parcial: o
  flag `disputed` já exclui do headline todo mercado com evento de disputa em
  qualquer instante do timeline.
- **Cobertura macro zero** enquanto o calendário não tiver consenso/nowcast.
- **Janela de retenção** de ~5,5 dias no teto, contra TTL de 90 dias — decisão
  do proprietário.
- **Sem caminho de registro de modelo** além do catálogo no boot: treinar uma
  versão calibrada exigirá CLI ou endpoint novo.
- O soak de 24 h com universo cheio previsto na RFC **não foi executado**; o
  que existe é o smoke em container e a projeção de volumetria medida.
