# Evidência de verificação — RFC-013 (motor de portfólio, entrada/saída e gates)

- Data: 2026-08-26 (BRT)
- Branch: `claude/rfc-013-portfolio-engine-f01fe2`, sobre a `main` em
  `2151950` (merge do PR [#38](https://github.com/henrique-devel/ganso-market/pull/38))
- Fases anteriores: PRs [#30](https://github.com/henrique-devel/ganso-market/pull/30)
  (A), [#33](https://github.com/henrique-devel/ganso-market/pull/33) (B),
  [#34](https://github.com/henrique-devel/ganso-market/pull/34) (C),
  [#36](https://github.com/henrique-devel/ganso-market/pull/36) (D), mais os
  fixes [#26](https://github.com/henrique-devel/ganso-market/pull/26),
  [#31](https://github.com/henrique-devel/ganso-market/pull/31),
  [#32](https://github.com/henrique-devel/ganso-market/pull/32) e
  [#35](https://github.com/henrique-devel/ganso-market/pull/35), que financiaram
  a quota de disco e destravaram a poda
- Ambiente: macOS (Darwin 25.3.0), Node 26.4.0, npm 11.17.0, Docker Desktop;
  PostgreSQL 18.4-bookworm descartável para as verificações de banco
- **SIMULAÇÃO — SEM EXECUÇÃO REAL.** Nenhuma ordem real, wallet, signer ou
  credencial de trading existe neste módulo, e nenhum gate passou.

Este documento registra somente comandos realmente executados e resultados
reais. Ele consolida a evidência das fases A–D (cujos números vivem nos corpos
dos PRs #26–#37) e acrescenta a verificação da fase E — medição contínua de
gates, ciclo de saída, replay determinístico e espaço de consulta.

## 1. Escopo desta sessão (fase E)

O handoff de 2026-08-26 declarava quatro pendências. Todas foram fechadas:

| Pendência declarada                                                              | Estado                                                                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Nenhum job gravando em `portfolio_gate_measurements` (tarefa 8)                  | job `gates` a cada 1 h + no boot; 6 medições por ciclo; relógio G2 por categoria                    |
| `exits.ts` implementado mas fora do ciclo do runner                              | job `exits` a cada 30 s sobre posições abertas, gravando `EXIT` no decision log quando o veredito muda |
| Replay determinístico do decision log e seu teste obrigatório (tarefa 7)         | `replay.ts` + `decisionrow.ts`; 14 testes; auditoria automática a cada ciclo de gates               |
| `docs/test-results/RFC-013-portfolio-engine.md` inexistente                      | este documento                                                                                      |

Três lacunas adicionais foram encontradas na leitura do código e fechadas, por
serem pré-requisito das três primeiras:

| Lacuna encontrada                                                                     | Consequência que tinha                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `breakerOpen: false` fixo no runner: os 5 circuit breakers da tarefa 4 nunca abriam    | G3 nunca poderia passar (exige cada breaker demonstrado) e a saída não congelava |
| `realizedPnlTotalScaled: 0n` fixo: a máquina de estados nunca podia disparar           | `perda_diaria_max`, `perda_semanal_max` e `drawdown_max` eram inertes; G2/G3 mediriam nada |
| `takerFeeRate`, `rulePrecisionMultiplier` fixos e campos 9/10/12 do painel nulos       | fee taker nunca cobrada; multiplicador de rule-precision sempre 1; painel incompleto |

## 2. Gate de fonte (`make verify`, partes executadas)

| Etapa                                        | Resultado                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run format:check` (prettier)            | OK — "All matched files use Prettier code style!"                            |
| `npm run lint` (tsc por workspace)           | OK — api, web e contracts sem erro                                          |
| `npm test` — @ganso-market/api               | **93 arquivos aprovados + 4 pulados; 1.325 testes aprovados, 49 pulados**    |
| `npm test` — @ganso-market/web               | **6 arquivos, 41 testes aprovados**                                          |
| `npm test` — contracts                       | 2 arquivos, 70 testes aprovados                                              |
| `npm run build`                              | OK (api tsc, web vite 251,02 kB / gzip 74,45 kB, contracts tsc)              |
| `scripts/scan_secrets.py`                    | OK — "secret scan passed; no matched content was printed"                    |
| `make compose-config`                        | OK — **agregado 4 261 412 864 bytes**, exatamente o mesmo de antes           |

O agregado de memória do Compose não mudou porque **nenhum serviço novo foi
criado**: a fase E acrescenta jobs ao `polymarket-portfolio` que já existia na
definição do Compose (192 MiB), não um processo novo.

`make resource-check` não pôde ser concluído localmente — a segunda metade
(`check_runtime_memory.py`) exige containers rodando e falhou com "no running
containers". A primeira metade (política estática do Compose) passou.

`cargo` e as suítes Python não foram tocados por esta RFC e não foram
reexecutados nesta sessão.

## 3. Módulo `portfolio`: 199 → 290 testes

| Suíte                    | Testes | O que cobre                                                                    |
| ------------------------ | ------ | ------------------------------------------------------------------------------ |
| `replay.test.ts`         | 14     | teste obrigatório da tarefa 7 (novo)                                           |
| `exitcycle.test.ts`      | 23     | fiação dos sete critérios sobre uma posição real (novo)                        |
| `breakers.test.ts`       | 16     | os 5 circuit breakers da tarefa 4 (novo)                                       |
| `measure.test.ts`        | 22     | montagem da medição de gates, incluindo o reset do G2 (novo)                   |
| `runner.test.ts`         | 11     | ciclos de saída e de gates pelo runner (novo)                                  |
| `api.test.ts`            | 18     | 13 → 18: +5 no endpoint paginado de medições                                    |
| demais (A–D)             | 186    | inalteradas                                                                    |
| **total (gate de fonte)**| **290**|                                                                                |
| `integration.pg.test.ts` | 19     | PostgreSQL real; pulados no gate de fonte (novo)                               |

Comando: `npx vitest run test/polymarket/portfolio` →
**16 arquivos, 290 aprovados, 19 pulados (309)**.

O guard de escopo (`scope.test.ts`, 7 testes) varre os **21** arquivos do
módulo — 14 antes desta fase, mais `breakers.ts`, `decisionrow.ts`,
`exitcycle.ts`, `exitstore.ts`, `gatestore.ts`, `measure.ts` e `replay.ts` — e
continua verde: nenhuma auth de trading, wallet,
signer, EIP-712, `POST /order`, stop-loss, trailing stop, leverage, martingale
ou forma de desabilitar um limitador; nenhum `fetch`; nenhum `WebSocket`;
nenhuma leitura de `closedTime`; escrita apenas nas tabelas `portfolio_*`.

## 4. PostgreSQL real: migrations e as consultas novas

Container descartável `postgres:18.4-bookworm`. As 14 migrations aplicaram
limpas em sequência com o protocolo do `apply.sh`
(`--single-transaction`, `ON_ERROR_STOP=1`, `migration_version` e
`migration_checksum` por psql vars). **A migration 0014 não foi alterada** —
esta fase não precisou de tabela nova.

`GANSO_TEST_DATABASE_URL` apontando para esse banco, a suíte API integral e
**serial** passou com **97/97 arquivos e 1.374/1.374 testes**.

> Nota de protocolo, confirmada nesta sessão: as suítes de integração
> compartilham um banco e **falham em paralelo** — não por causa desta fase.
> Rodando só `resolution/integration.test.ts` + `fundamental/integration.test.ts`
> + `versioning.pg.test.ts` (todas anteriores a esta RFC), em paralelo:
> **2 arquivos falham, 8 testes falham**. Com `--no-file-parallelism`, tudo
> passa. É a mesma exigência de serialização que a evidência da RFC-012 já
> registrava.

O novo `portfolio/integration.pg.test.ts` existe porque **SQL só tipa contra um
servidor**: um pool falso que responde por substring aceita `members_json ?|
$1::text[]` com o operando errado, um caminho `#>>` numa coluna que não é JSONB
ou um `count(*) FILTER` que o planner recusaria. Ele exercita, contra o schema
real:

| Verificação                                                              | Resultado                                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `loadEligibleMarkets` com texto de regra e fee schedule                   | OK; `resolution_source` resolve para o adapter via `COALESCE`                              |
| `loadOpenPositions`, `loadPaperPnl`                                       | OK; marca ausente/stale contribui o **custo**, nunca um ganho não realizado               |
| `loadMarketChangeStates`, `loadCorrelatedMarkets`, `loadMidsAsOf`         | OK; as três consultas em lote                                                             |
| `loadMidsAsOf` num instante anterior ao book gravado                      | **não retorna nada** — as-of é as-of                                                      |
| abrir, listar e fechar um circuit breaker                                 | OK; breaker de escopo `token` guarda também o `condition_id`                               |
| `insertDecision` + `loadRecentDecisions` (round-trip JSONB)               | OK; o bloco de replay volta íntegro                                                       |
| `insertDecision` com input mais novo que a decisão                        | **recusado** por `portfolio_decisions_no_lookahead`                                        |
| `entryProvenanceFor`                                                      | OK; lê a invalidação e o multiplicador de rule-precision do JSON da entrada                |
| todas as consultas de entrada dos gates (G1–G6)                           | executam sem erro de tipo                                                                  |
| `applyClockReset` duas vezes                                              | OK; **2** linhas em `portfolio_g2_clock_events` (um relógio de 60 dias e um resetado 3× não podem parecer iguais) |
| `UPDATE` numa medição de gate                                             | **recusado**: "portfolio_gate_measurements rows are immutable"                             |
| `ensureConfigVersion` com o mesmo nome e conteúdo diferente               | **recusado** com `PORTFOLIO_CONFIG_VERSION_CONTENT_MISMATCH`                                |
| ciclo `panel` completo                                                    | estado, 7+ dimensões de exposição com custo de unwind real, painel e decisão gravados      |
| ciclo `exits` completo                                                    | decisão `EXIT` gravada; **replay das linhas que passaram pelo PostgreSQL confere**          |
| ciclo `gates` completo                                                    | 6 medições imutáveis; **nenhuma `PASS`**                                                   |

### O que o ciclo `panel` decidiu, contra o banco real

Mercado semeado com `q_lo = 0.750000` e ask gravado em `0.62`:

| Campo                | Valor gravado                                                       |
| -------------------- | ------------------------------------------------------------------- |
| `exec_price`         | `0.620000` — book-walk sobre o ask gravado, nunca o mid             |
| `costs_total`        | `0.001000`                                                          |
| `edge_net`           | `0.129000`                                                          |
| `safety_margin`      | `0.032500` — `max($0,01; 25% do edge bruto no limite inferior)`      |
| `entry_reason`       | "limite inferior 0.750000 supera preço executável 0.620000 mais custos 0.001000 e margem 0.032500" |
| `outcome`            | `REJECTED`, `reason_code = CAP_EXHAUSTED`                            |
| `binding_constraint` | `CAP_MERCADO`, `size_shares = 0.000000`                              |

Vale ler os dois últimos: o critério de entrada **passou** e o tamanho ainda
saiu **zero**, porque a posição já aberta no mesmo mercado (custo US$ 50)
consome exatamente o `cap_mercado` de 5% da banca nocional de US$ 1.000. É o
`min()` dos limitadores funcionando sobre uma exposição calculada de verdade no
mesmo ciclo — e é a demonstração mais direta de que Kelly é teto e não alvo.

## 5. Tarefa 7 — replay determinístico

O que foi acrescentado ao decision log: `inputs_json.replay`, com **todo escalar
que o motor leu**, na escala de trabalho de **nove** dígitos e não nos seis que
as colunas exibem. Há teste para isso: um `cap_headroom` de `20.000000500`
volta como `20.000000500` e a decisão reproduz; a seis dígitos ele voltaria como
`20.000000` e o tamanho poderia andar uma share.

O construtor da linha de decisão (`decisionrow.ts`) é **único** e usado pelos
dois lados. Sem isso o teste compararia duas implementações do mesmo mapeamento
e passaria ou falharia no mapeamento, não no motor.

O replay lê **só** o decision log e `portfolio_config_versions.content_json` —
nunca `polymarket_book_snapshots`, `fundamental_estimates` ou
`resolution_market_state`. É o "replay independente do TTL dos dados crus" da
RFC.

Os 14 testes, com o round-trip por `JSON.parse(JSON.stringify(...))` que uma
coluna JSONB de fato faz:

- entrada aceita e dimensionada reproduz **bit a bit** (zero diferenças);
- `VETO` reproduz com o motivo; rejeição por limite inferior reproduz;
- alterar `size_shares` na linha persistida é detectado, **nomeando o campo**;
- alterar o **painel** é detectado (`inputs_json.panel`);
- config com hash diferente é recusada **antes** de comparar
  (`CONFIG_HASH_MISMATCH`) — comparar contra outro conjunto de parâmetros mediria
  a coisa errada;
- linha sem bloco de replay falha fechado (`NO_REPLAY_BLOCK`), nunca "confere";
- saída em hold e saída disparada reproduzem; alterar o conjunto de sinais é
  detectado;
- auditoria em lote conta acertos e nomeia os que não conferiram.

Em produção a auditoria roda junto com o ciclo de gates sobre as **50** decisões
mais recentes e loga `PORTFOLIO_REPLAY_OK` ou `PORTFOLIO_REPLAY_MISMATCH` com os
campos divergentes.

## 6. Tarefa 8 — medição contínua, sem relatório semanal

Por decisão do proprietário nesta sessão, o relatório semanal foi substituído
por um **espaço de consulta** no painel: `GET
/polymarket/gates/measurements?gate=&status=&from=&to=&limit=&cursor=`, aba
"Consulta". Paginação por **cursor (keyset)** sobre `measurement_id`, não por
`OFFSET`: a tabela é append-only e nunca podada, então uma página por `OFFSET`
ficaria mais lenta a cada semana e poderia repetir ou pular uma linha quando uma
medição nova entrasse no meio da listagem. Testes: página + cursor, avanço por
cursor (a consulta contém `measurement_id < $5` e **não** contém `OFFSET`),
última página sem cursor, filtros repassados, e 7 formas de entrada malformada
recusadas com código próprio em vez de silenciosamente responder outra pergunta.

`portfolio_gate_reports` continua no schema **sem uso**: o G6 é registrado
contra o id de um relatório, e apagar a tabela jogaria fora a única forma de
amarrar uma revisão escrita aos números que ela aprovou.

O reset do relógio G2 — teste obrigatório da RFC — passa: fingerprint estável
quando um mercado entra com os mesmos parâmetros; muda com fee schedule ou tick;
o reset joga os dias fora, grava o evento append-only e atinge **só a categoria
afetada**.

## 7. Achados de calibração para o proprietário

Nenhum destes é bug de código; são consequências dos parâmetros, medidas.

### 7.1 `custo_capital_anual` não tem efeito nenhuma decisão de entrada

O buffer de resolução da RFC-012 já cobra `capitalDailyHurdle × lockupDays`, e
este módulo cobra apenas o **excedente** para não cobrar o mesmo lockup duas
vezes. Com os defaults, o hurdle do buffer (US$ 0,0005/share/dia ≈ **18,3%
a.a.**) é maior que `custo_capital_anual` (**12% a.a.**) em **qualquer** preço e
**qualquer** lockup — porque `0,12/365 = 0,000329 < 0,0005` e o preço é ≤ 1. O
excedente é sempre negativo, logo `capital_cost` é sempre `0.000000` na
decomposição da entrada.

Isso é o `max(os dois)` funcionando como documentado, mas significa que o
parâmetro `custo_capital_anual` da RFC-013 hoje **não altera nenhuma decisão**.
Subir para acima de ~18,3% a.a. seria o que o tornaria vinculante.

O mesmo cálculo revelou um bug de fiação, corrigido: o critério 6 de saída
(capital bloqueado deixou de compensar o edge) cobrava o excedente sobre o
edge residual, que **não** subtrai buffer nenhum — então cobrava zero e o
critério **nunca poderia disparar**. Na saída passou a cobrar o custo integral
do lockup restante. Há fixture provando o critério disparando.

### 7.2 O decision log retém ~3 dias, não 180

Medido: a linha média de `portfolio_decisions` tem **2.038 bytes** (fixture com
book raso; um book real de 10 níveis por lado é maior). A um ciclo por minuto
sobre 98 mercados elegíveis são ~141 mil linhas/dia ≈ **288 MB/dia** contra a
quota de **0,9 GB** — a quota vence o TTL de 180 dias em cerca de **3 dias**.

Consequência que **precisou** de correção: o soak do G4 era medido por
`min(received_at)` do decision log, então nunca passaria de ~3 dias contra uma
exigência de 30, e o G4 seria **inmensurável para sempre**. O soak passou a ser
medido pelo mais antigo entre a primeira medição de gate (tabela `protected`,
nunca podada) e o decision log.

Decisão pendente do proprietário: aumentar a quota do decision log, ou reduzir a
cadência do painel, ou aceitar ~3 dias de histórico de decisões.

### 7.3 Cap de fonte de resolução (herdado da fase B, ainda aberto)

460 de 570 rule versions resolvem pelo mesmo adapter UMA, então o cap de 25% por
fonte efetivamente capeia o livro inteiro em 25% da banca. É o parâmetro fazendo
o que sua justificativa diz; afrouxar em silêncio seria a direção proibida.

## 8. Versão de config: 1.0.0 → 1.1.0

A fase E acrescentou um parâmetro versionado: `exits.unwindAlarmPctOpenPnl`
(default 0,25), que é o "X% do PnL aberto" do alarme de liquidez da tarefa 4 —
a RFC declara o controle e deixa o X para a config. Como o hash da config cobre
`exits`, o conteúdo mudou e a **versão foi cunhada de novo** (1.1.0), que é o
mecanismo que a própria RFC exige. `config/portfolio.json` foi atualizado
completo, e o teste de completude passa.

Isto é seguro porque a 1.0.0 **nunca foi cunhada em produção**: o serviço
`polymarket-portfolio` ainda não existe no servidor. Se já existisse, mudar o
conteúdo de 1.0.0 repetiria o incidente do `score_version` 1.1.0.

## 9. Não verificado / pendências

- **Ativação em produção**: o serviço `polymarket-portfolio` continua **não
  criado no servidor**, e o Nginx continua **não recarregado** com as rotas GET
  da RFC-013. Tudo nesta sessão foi verificado localmente (gate de fonte,
  PostgreSQL real descartável, política estática do Compose). O rebuild de
  profile descrito no handoff continua sendo o próximo passo.
- **Soak de 24 h** do motor em produção: não medido. Os jobs foram exercitados
  ciclo a ciclo contra PostgreSQL real, não por 24 h.
- **`make resource-check` completo**: a metade de runtime exige containers
  rodando.
- **Gates G1–G6**: todos medidos, **nenhum PASS**, e isso é o resultado correto —
  não há modelo promovido na RFC-010, não há posição fechada em paper, nenhum
  circuit breaker foi exercitado em produção e não há revisão escrita do
  proprietário. `rfc_009_status` permanece `BLOCKED`.
- **G4 na prática**: a reconciliação de fee compara o fill simulado com o
  `fee_rate_bps` do trade gravado mais próximo no tempo do mesmo token, e o viés
  de slippage compara o preço simulado com um book-walk do mesmo tamanho sobre o
  book gravado. Ambos foram testados como aritmética e as consultas rodam contra
  PostgreSQL real, mas **não existe nenhum fill de paper** para reconciliar
  ainda, então o gate responde `INSUFFICIENT_DATA` com zero amostras.
- **PnL realizado por janela**: o total é exato (é o do ledger da RFC-011), mas
  as janelas diária e semanal atribuem o realizado de cada posição ao seu
  `resolved_at`. Realização por fechamento **antecipado** (venda antes da
  resolução) só entra quando o token resolve, então os limites diário e semanal
  podem disparar **tarde** para um livro que sai das posições antes do
  settlement. Atribuir corretamente exigiria reprocessar o ledger evento a
  evento, que é papel do módulo da RFC-011. `updated_at` não serve de
  substituto: uma atualização de marca o move e reatribuiria uma perda antiga
  para hoje em todo ciclo.
- **Breaker de salto sem catalisador**: "catalisador conhecido" é o instante de
  resolução do próprio mercado ou um evento/release do calendário macro dentro
  da janela. É uma aproximação declarada — um catalisador que o calendário não
  conhece faz o breaker abrir, o que é a direção conservadora.
