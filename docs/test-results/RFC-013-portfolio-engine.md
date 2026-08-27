# Evidência de verificação — RFC-013 (motor de portfólio, entrada/saída e gates)

- Data: 2026-08-26 (fases A–E, seções 1–9), com adendo de **2026-08-27**
  (seção 10: auditoria de G2–G6 contra o modo de falha do G1, e registro da
  aprovação do G6)
- Branch: `claude/rfc-013-portfolio-engine-f01fe2`, sobre a `main` em
  `2151950` (merge do PR [#38](https://github.com/henrique-devel/ganso-market/pull/38));
  o adendo veio de `claude/degeneracoes-g2-g3-g4-merge-376055`, sobre `4a037a3`
  (merge do PR [#41](https://github.com/henrique-devel/ganso-market/pull/41))
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
  credencial de trading existe neste módulo.
- **Nenhum gate passa hoje** — mas o G1 passou indevidamente por ~4 h em
  produção antes de ser corrigido. A seção 9 registra o incidente inteiro, e a
  seção 10 registra a auditoria dos outros cinco contra o mesmo modo de falha:
  **G2, G3 e G4 tinham o defeito, e o G6 tinha uma variante mais silenciosa**.

Este documento registra somente comandos realmente executados e resultados
reais. Ele consolida a evidência das fases A–D (cujos números vivem nos corpos
dos PRs #26–#37), acrescenta a verificação da fase E — medição contínua de
gates, ciclo de saída, replay determinístico e espaço de consulta — e, na
seção 10, a auditoria que fechou as degenerações restantes.

## 1. Escopo desta sessão (fase E)

O handoff de 2026-08-26 declarava quatro pendências. Todas foram fechadas:

| Pendência declarada                                                      | Estado                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Nenhum job gravando em `portfolio_gate_measurements` (tarefa 8)          | job `gates` a cada 1 h + no boot; 6 medições por ciclo; relógio G2 por categoria                       |
| `exits.ts` implementado mas fora do ciclo do runner                      | job `exits` a cada 30 s sobre posições abertas, gravando `EXIT` no decision log quando o veredito muda |
| Replay determinístico do decision log e seu teste obrigatório (tarefa 7) | `replay.ts` + `decisionrow.ts`; 14 testes; auditoria automática a cada ciclo de gates                  |
| `docs/test-results/RFC-013-portfolio-engine.md` inexistente              | este documento                                                                                         |

Três lacunas adicionais foram encontradas na leitura do código e fechadas, por
serem pré-requisito das três primeiras:

| Lacuna encontrada                                                                   | Consequência que tinha                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `breakerOpen: false` fixo no runner: os 5 circuit breakers da tarefa 4 nunca abriam | G3 nunca poderia passar (exige cada breaker demonstrado) e a saída não congelava           |
| `realizedPnlTotalScaled: 0n` fixo: a máquina de estados nunca podia disparar        | `perda_diaria_max`, `perda_semanal_max` e `drawdown_max` eram inertes; G2/G3 mediriam nada |
| `takerFeeRate`, `rulePrecisionMultiplier` fixos e campos 9/10/12 do painel nulos    | fee taker nunca cobrada; multiplicador de rule-precision sempre 1; painel incompleto       |

## 2. Gate de fonte (`make verify`, partes executadas)

| Etapa                              | Resultado                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `npm run format:check` (prettier)  | OK — "All matched files use Prettier code style!"                         |
| `npm run lint` (tsc por workspace) | OK — api, web e contracts sem erro                                        |
| `npm test` — @ganso-market/api     | **93 arquivos aprovados + 4 pulados; 1.327 testes aprovados, 49 pulados** |
| `npm test` — @ganso-market/web     | **6 arquivos, 41 testes aprovados**                                       |
| `npm test` — contracts             | 2 arquivos, 70 testes aprovados                                           |
| `npm run build`                    | OK (api tsc, web vite 251,02 kB / gzip 74,45 kB, contracts tsc)           |
| `scripts/scan_secrets.py`          | OK — "secret scan passed; no matched content was printed"                 |
| `make compose-config`              | OK — **agregado 4 261 412 864 bytes**, exatamente o mesmo de antes        |

O agregado de memória do Compose não mudou porque **nenhum serviço novo foi
criado**: a fase E acrescenta jobs ao `polymarket-portfolio` que já existia na
definição do Compose (192 MiB), não um processo novo.

`make resource-check` não pôde ser concluído localmente — a segunda metade
(`check_runtime_memory.py`) exige containers rodando e falhou com "no running
containers". A primeira metade (política estática do Compose) passou.

`cargo` e as suítes Python não foram tocados por esta RFC e não foram
reexecutados nesta sessão.

## 3. Módulo `portfolio`: 199 → 292 testes

| Suíte                     | Testes  | O que cobre                                                    |
| ------------------------- | ------- | -------------------------------------------------------------- |
| `replay.test.ts`          | 14      | teste obrigatório da tarefa 7 (novo)                           |
| `exitcycle.test.ts`       | 23      | fiação dos sete critérios sobre uma posição real (novo)        |
| `breakers.test.ts`        | 16      | os 5 circuit breakers da tarefa 4 (novo)                       |
| `measure.test.ts`         | 22      | montagem da medição de gates, incluindo o reset do G2 (novo)   |
| `gates.test.ts`           | 37      | 35 → 37: +2 travando o G1 contra baseline de mercado (seção 9) |
| `runner.test.ts`          | 11      | ciclos de saída e de gates pelo runner (novo)                  |
| `api.test.ts`             | 18      | 13 → 18: +5 no endpoint paginado de medições                   |
| demais (A–D)              | 151     | inalteradas                                                    |
| **total (gate de fonte)** | **292** |                                                                |
| `integration.pg.test.ts`  | 19      | PostgreSQL real; pulados no gate de fonte (novo)               |

Comando: `npx vitest run test/polymarket/portfolio` →
**16 arquivos, 292 aprovados, 19 pulados (311)**.

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
**serial** passou com **97/97 arquivos e 1.376/1.376 testes**.

> Nota de protocolo, confirmada nesta sessão: as suítes de integração
> compartilham um banco e **falham em paralelo** — não por causa desta fase.
> Rodando só `resolution/integration.test.ts` + `fundamental/integration.test.ts`
>
> - `versioning.pg.test.ts` (todas anteriores a esta RFC), em paralelo:
>   **2 arquivos falham, 8 testes falham**. Com `--no-file-parallelism`, tudo
>   passa. É a mesma exigência de serialização que a evidência da RFC-012 já
>   registrava.

O novo `portfolio/integration.pg.test.ts` existe porque **SQL só tipa contra um
servidor**: um pool falso que responde por substring aceita `members_json ?|
$1::text[]` com o operando errado, um caminho `#>>` numa coluna que não é JSONB
ou um `count(*) FILTER` que o planner recusaria. Ele exercita, contra o schema
real:

| Verificação                                                       | Resultado                                                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `loadEligibleMarkets` com texto de regra e fee schedule           | OK; `resolution_source` resolve para o adapter via `COALESCE`                                                     |
| `loadOpenPositions`, `loadPaperPnl`                               | OK; marca ausente/stale contribui o **custo**, nunca um ganho não realizado                                       |
| `loadMarketChangeStates`, `loadCorrelatedMarkets`, `loadMidsAsOf` | OK; as três consultas em lote                                                                                     |
| `loadMidsAsOf` num instante anterior ao book gravado              | **não retorna nada** — as-of é as-of                                                                              |
| abrir, listar e fechar um circuit breaker                         | OK; breaker de escopo `token` guarda também o `condition_id`                                                      |
| `insertDecision` + `loadRecentDecisions` (round-trip JSONB)       | OK; o bloco de replay volta íntegro                                                                               |
| `insertDecision` com input mais novo que a decisão                | **recusado** por `portfolio_decisions_no_lookahead`                                                               |
| `entryProvenanceFor`                                              | OK; lê a invalidação e o multiplicador de rule-precision do JSON da entrada                                       |
| todas as consultas de entrada dos gates (G1–G6)                   | executam sem erro de tipo                                                                                         |
| `applyClockReset` duas vezes                                      | OK; **2** linhas em `portfolio_g2_clock_events` (um relógio de 60 dias e um resetado 3× não podem parecer iguais) |
| `UPDATE` numa medição de gate                                     | **recusado**: "portfolio_gate_measurements rows are immutable"                                                    |
| `ensureConfigVersion` com o mesmo nome e conteúdo diferente       | **recusado** com `PORTFOLIO_CONFIG_VERSION_CONTENT_MISMATCH`                                                      |
| ciclo `panel` completo                                            | estado, 7+ dimensões de exposição com custo de unwind real, painel e decisão gravados                             |
| ciclo `exits` completo                                            | decisão `EXIT` gravada; **replay das linhas que passaram pelo PostgreSQL confere**                                |
| ciclo `gates` completo                                            | 6 medições imutáveis; nenhuma `PASS` **nestas fixtures** (ver seção 9 para o que aconteceu em produção)           |

### O que o ciclo `panel` decidiu, contra o banco real

Mercado semeado com `q_lo = 0.750000` e ask gravado em `0.62`:

| Campo                | Valor gravado                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `exec_price`         | `0.620000` — book-walk sobre o ask gravado, nunca o mid                                            |
| `costs_total`        | `0.001000`                                                                                         |
| `edge_net`           | `0.129000`                                                                                         |
| `safety_margin`      | `0.032500` — `max($0,01; 25% do edge bruto no limite inferior)`                                    |
| `entry_reason`       | "limite inferior 0.750000 supera preço executável 0.620000 mais custos 0.001000 e margem 0.032500" |
| `outcome`            | `REJECTED`, `reason_code = CAP_EXHAUSTED`                                                          |
| `binding_constraint` | `CAP_MERCADO`, `size_shares = 0.000000`                                                            |

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

## 9. Incidente em produção: o G1 passou sem evidência nenhuma

Este é o achado mais importante da sessão, e ele só apareceu porque a checagem
foi feita **contra produção** depois da ativação. Nenhum teste local o pegaria:
o dado que o produziu não existe em fixture.

### O que aconteceu

| Instante (UTC)      | Evento                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------- |
| 2026-08-26 19:53:02 | `PORTFOLIO_BOOT` com `config_version 1.1.0` — fase E ativa                                  |
| 19:53:19            | primeiro `PORTFOLIO_GATES_MEASURED`: **`{"gate":"G1","status":"PASS","reason_code":null}`** |
| 23:48:13            | última medição com o veredito errado ainda de pé                                            |
| 23:49:19            | após rebuild com a correção: `INSUFFICIENT_DATA` / `G1_CALIBRATION_NOT_MET`                 |

O falso verde ficou de pé por **~4 horas**, em um dos seis sinais que
destravariam a RFC-009.

### O mecanismo

`loadForecastRows` filtrava `status = 'active'` mas **não** filtrava `source`.
Sem modelo promovido na RFC-010, o estimador cai para baseline de mercado — e aí
o `q` da estimativa é derivado do MESMO book gravado que o `market_prob` com que
ele seria comparado. Em cadeia:

- `modelBrier ≈ marketBrier`, e a barra da RFC é "não piora": **empate satisfaz**;
- `modelLogLoss ≈ marketLogLoss`: idem;
- `modelBrier < 0,20`: verdadeiro, porque o **preço** é bem calibrado.

Todas as condições passaram e nada foi medido.

### A confirmação empírica

A medição corrigida reporta a barra (b) separadamente, e o número fecha o
diagnóstico sem depender de leitura de código:

```
brier_do_sinal_usado | 0.07451024201319072
```

A RFC-013 cita, como referência, _"barra: preço tem Brier ~0,074"_. O sinal
usado nas entradas mediu **0,07451** — exatamente o que a RFC diz que o preço
mede, porque era o preço.

### A correção

As duas barras que a RFC de fato enuncia foram separadas:

- **(a)** "o modelo promovido não piora Brier/log-loss vs o próprio preço" —
  tomada SOMENTE sobre `source = 'MODEL'`;
- **(b)** "o sinal usado nas entradas tem Brier < 0,20" — tomada sobre o sinal
  em uso, qualquer que seja a fonte.

Sem modelo promovido, (a) é **immensurável**, e o gate responde
`INSUFFICIENT_DATA` com o motivo em `metrics.detail`:

> `no promoted model: the used signal is a market baseline, and scoring it`
> `against the price would compare the price to itself`

Ao corrigir, um segundo defeito apareceu: a guarda de leakage passou a varrer os
dois conjuntos e contava cada linha **duas vezes** (o conjunto do modelo é
normalmente subconjunto do usado) — 120 linhas vazando reportavam 240. O
veredito estava certo, o número não. Deduplicado por identidade.

Teste de regressão: 120 mercados, preço bem calibrado, baseline copiando o preço
exatamente, `modelForecasts: []` → obrigado a responder `INSUFFICIENT_DATA`.
Módulo `portfolio`: 290 → **292** testes.

### O que este incidente ensina, além do bug

Um gate que responde `PASS` sem dado é **pior** que um que falha: um `FAIL` é
lido como problema e investigado, um `PASS` é lido como progresso e acumulado.
`INSUFFICIENT_DATA` existe exatamente para esse caso, e colapsá-lo com `PASS`
foi o erro.

Consequência prática: os outros quatro gates em `INSUFFICIENT_DATA` estão nesse
estado por falta de dado, então nenhum deles chegou perto de uma barra. Mas
**nenhum deles foi verificado contra o modo de falha "passa por degeneração"** —
o G4, em particular, depende de contagens que podem estar vazias de um jeito
parecido. Está declarado como pendência.

A linha `PASS` de 19:53 permanece em `portfolio_gate_measurements`, imutável por
trigger. Isso é correto: é a trilha de evidência de que o falso verde existiu.

## 10. Auditoria de G2–G6 contra o modo de falha do G1 (2026-08-27)

A seção 9 fecha com uma pendência: _"nenhum dos outros quatro gates foi
reauditado sob a lente 'passa por degeneração'"_. Esta seção é essa auditoria,
feita a pedido do proprietário. **Três dos quatro tinham o defeito**, e o
quarto — o G6 — tinha uma variante do mesmo, mais silenciosa.

O padrão é sempre o mesmo: uma condição que se satisfaz porque não havia nada
contra o que comparar.

### 10.1 G2 passava sobre um PnL constante

`blockBootstrapMean` sobre uma série constante devolve o **mesmo** número em
todo reamostragem: `ciLow = ciHigh = média`, e `aboveZero` (que é `ciLow > 0`)
vira aritmética sobre esse ponto. Cem posições fechadas de mercado binário que
realizaram exatamente o mesmo PnL não são um track record — são um artefato de
como o número foi produzido.

Mais três formas do mesmo problema, todas satisfazendo cada contagem da RFC:

| Forma                               | Por que a medição não tinha conteúdo                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Rajada**: tudo fechado numa tarde | Os 60 dias descrevem o **relógio**, não a evidência; o block bootstrap reamostra um único episódio de mercado |
| **Poucos blocos independentes**     | Um block bootstrap sobre 3 blocos é a amostra reorganizada de três jeitos                                     |
| **Uma posição dominando**           | 149 posições de US$ 0,01 e uma de US$ 10: "100 posições fechadas" vira ficção                                 |

E uma quarta, que é a consequência direta da regra de reset do G5: **as
posições fechadas antes do início do relógio continuavam entrando na amostra**.
Um reset que joga os dias fora e mantém o sample é cosmético — a mesma amostra,
vestida com um relógio mais curto.

Fechado com: largura de intervalo estritamente positiva (uma faixa tem que ser
uma faixa), `g2MinBootstrapBlocks`, `g2MinDistinctCloseDays`,
`g2MaxSinglePositionPnlShare`, e o corte da amostra pela janela do relógio.
Nenhum deles é `FAIL` — são ausência de medição, logo `INSUFFICIENT_DATA`.

### 10.2 G3 passava sobre um livro vazio

Zero posições produzem **zero** breaches não bloqueados e **zero** drawdown.
Com os cinco circuit breakers demonstrados em cenário injetado, as três
condições do gate liam perfeitas e o veredito era `PASS` — sobre um livro que
nunca existiu. "Nada quebrou" só é evidência quando alguma coisa esteve em
risco.

Fechado com: G3 passa a receber **o mesmo objeto de base de evidência** que o
G2 (`paperEvidenceBase`), não uma base própria parecida. Um livro curto demais
para o G2 é curto demais para o G3 por construção. As demonstrações de breaker
continuam sendo reportadas quando a base é curta — um cenário injetado é um
teste deliberado, não algo que o livro tenha que produzir sozinho — elas apenas
deixam de bastar.

### 10.3 G4 comparava o simulador com ele mesmo

Duas coisas, e a segunda é literalmente o G1 de novo:

1. **Sem mínimo de amostra.** Uma mediana sobre uma amostra é aquela amostra; um
   viés médio sobre uma amostra é o sinal daquela amostra. Ambos limpavam as
   barras.
2. **Referência auto-referente.** O viés de slippage comparava o preço do fill
   simulado com um book-walk sobre **o mesmo snapshot gravado que o simulador
   consumiu** — `bookAsOf(pool, token, execTs)` no gate e `bookAtOrBefore(pool,
token, fill)` no broker são a mesma consulta, na mesma tabela, pelos mesmos
   níveis. O viés é zero por construção e `bias >= 0` **não podia falhar**. O
   comentário no código chamava isso de "caminho independente"; não era.

   Havia ainda um terceiro defeito somado: o ledger grava **um evento de fill
   por nível consumido**, então a comparação punha o preço de um nível contra um
   walk daquele tamanho a partir do topo do livro — duas quantidades diferentes,
   e um número sem significado em qualquer direção.

Fechado com: `g4MinReconciledFills` (100, exigido em **cada** perna — cem
amostras de fee não dizem nada sobre slippage); proveniência declarada em cada
amostra (`VENUE_TRADE_FEED` / `SIMULATOR_OWN_RATE`, `DECISION_BOOK` /
`EXECUTION_BOOK`), com as auto-referentes **excluídas da aritmética e contadas**
— "zero amostras" e "zero amostras honestas" são situações diferentes para quem
lê o gate; reconciliação agregada **por ordem**, não por evento de fill; e a
referência de preço passou a ser o book do **instante da decisão**, que é uma
observação diferente da que o fill consumiu e é exatamente o conservadorismo
que o simulador afirma ter (ele executa contra t + latência). Quando o livro não
se moveu entre os dois instantes, as duas observações **são** a mesma linha
gravada — a amostra diz isso e é excluída.

A perna de fee já era independente por acaso (o simulador cobra com
`taker_fee_bps` de `polymarket_param_versions`; o gate compara com
`fee_rate_bps` de `polymarket_trades`, outro feed). Agora é independente **por
declaração**, e uma regressão futura que ligue a referência errada é pega pela
aritmética e por teste.

### 10.4 G6 aceitava uma aprovação de coisa nenhuma

`currentReportId === null` significava "confere". Como **nada no sistema jamais
cunhou um relatório** — `portfolio_gate_reports` estava no schema, vazia, por
desenho —, `currentReportId` era null em produção **sempre**. Uma aprovação
gravada à mão na tabela teria casado com qualquer coisa. É a mesma forma do G1:
uma condição satisfeita por falta de termo de comparação.

Fechado com as duas metades que faltavam:

- **o relatório passou a existir**. O ciclo de gates cunha um
  `portfolio_gate_reports` quando — e só quando — **um veredito muda**
  (fingerprint sobre gate/status/reason_code, deliberadamente **não** sobre as
  métricas: um dia de soak a mais move um número em todo ciclo, e um relatório
  por hora invalidaria a revisão do proprietário continuamente). Assim uma
  aprovação vale exatamente enquanto valerem as respostas que ela aprovou;
- **o registro da aprovação passou a ter caminho**: `dist/gates-cli.js`, dentro
  do container, com a revisão por stdin. Não é endpoint de propósito — o
  perímetro publica o portfólio só em GET, e as duas coisas que ficam fechadas
  na borda são as que mudam o que o sistema pode fazer: sair de `HALTED`, e
  esta. A CLI recusa com código próprio: relatório inexistente, não corrente, já
  aprovado, gates ainda não todos `PASS`, revisor inválido, registro escrito com
  menos de 40 caracteres, e expectativa calibrada não reconhecida
  explicitamente. A mesma guarda está repetida **dentro** do `UPDATE`, então
  perder uma corrida recusa em vez de sobrescrever.

Procedimento operacional em
[`docs/runbooks/polymarket-portfolio.md`](../runbooks/polymarket-portfolio.md).

### 10.5 Config 1.1.0 → 1.2.0

Quatro parâmetros novos (`g2MinDistinctCloseDays`, `g2MinBootstrapBlocks`,
`g2MaxSinglePositionPnlShare`, `g4MinReconciledFills`) mudam o conteúdo
hasheado, então a versão foi **cunhada de novo**. A 1.1.0 **está cunhada em
produção** desde 19:53Z de 2026-08-26 — editá-la repetiria o incidente do
`score_version`. O parser continua recusando afrouxamento: cada um dos quatro
entra na lista que dispara `PORTFOLIO_CONFIG_GATE_LOOSENED`.

**Consequência de deploy:** `config/portfolio.json` chega pelo CD e o binário
que o lê só muda no rebuild de profile. Os dois têm que sair na mesma janela —
é a mesma lição de sempre, e desta vez ela é sobre 1.2.0.

### 10.6 Testes de regressão, no formato do G1

Cada degeneração ganhou um teste que **teria pego** o defeito, e todos afirmam
`not.toBe("PASS")` explicitamente:

| Teste                                                                    | O que trava                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| "NEVER passes on a constant PnL series, however positive"                | intervalo degenerado; o teste ainda afirma `aboveZero === true` |
| "NEVER passes on a burst: every close inside one afternoon"              | dispersão temporal                                              |
| "NEVER passes when one position is most of the money the book moved"     | concentração                                                    |
| "NEVER passes when the sample supports too few independent blocks"       | blocos independentes                                            |
| "drops closed positions from BEFORE the clock start"                     | 170 fechadas nos livros, 50 na janela                           |
| "NEVER passes over an empty book, however clean it reads" (G3)           | sobrevivência sem exposição                                     |
| "is taken over the SAME base G2 requires, shortfall for shortfall" (G3)  | que a base é a mesma, não uma parecida                          |
| "NEVER passes on a handful of samples, however good they look" (G4)      | mínimo de amostra                                               |
| "requires the minimum on EACH leg" (G4)                                  | fee e slippage separados                                        |
| "NEVER passes when every reference was the simulator's own input" (G4)   | auto-referência                                                 |
| "EXCLUDES a reference re-derived from the observation the fill consumed" | a exclusão em `reconcile`, com a contagem do que foi excluído   |
| "NEVER passes an approval with no report to have been written against"   | o `currentReportId === null` que valia em produção              |
| "NEVER passes a signature with no written record behind it" (G6)         | registro escrito                                                |

Módulo `portfolio`: **292 → 322** testes (`gates` 37 → 50, `measure` 22 → 25,
`runner` 11 → 13, `approval` 12 novos), mais `integration.pg` 19 → 20.
`make verify` verde; suíte serial contra PostgreSQL 18.4 recém-migrado:
**1.407/1.407**.

O veredito medido **não muda**: os seis gates seguem sem nenhum `PASS` e
`rfc_009_status` segue `BLOCKED`. O que muda é que agora eles seguem assim
pelos motivos certos.

## 11. Não verificado / pendências

- **Ativação em produção**: o serviço `polymarket-portfolio` continua **não
  criado no servidor**, e o Nginx continua **não recarregado** com as rotas GET
  da RFC-013. Tudo nesta sessão foi verificado localmente (gate de fonte,
  PostgreSQL real descartável, política estática do Compose). O rebuild de
  profile descrito no handoff continua sendo o próximo passo.
- **Soak de 24 h** do motor em produção: não medido. Os jobs foram exercitados
  ciclo a ciclo contra PostgreSQL real, não por 24 h.
- **`make resource-check` completo**: a metade de runtime exige containers
  rodando.
- **Gates G1–G6**: todos medidos, **nenhum PASS** depois da correção da seção 9, e isso é o resultado correto —
  não há modelo promovido na RFC-010, não há posição fechada em paper, nenhum
  circuit breaker foi exercitado em produção e não há revisão escrita do
  proprietário. `rfc_009_status` permanece `BLOCKED`.
- **G4 na prática**: depois da seção 10.3, a perna de fee compara o fill
  simulado com o `fee_rate_bps` do trade gravado mais próximo no tempo (outro
  feed) e a perna de slippage compara a VWAP da ordem com um book-walk sobre o
  book do **instante da decisão**, com as amostras auto-referentes excluídas e
  contadas. Ambas foram testadas como aritmética e as consultas rodam contra
  PostgreSQL real, mas **não existe nenhum fill de paper** para reconciliar
  ainda, então o gate responde `INSUFFICIENT_DATA` com zero amostras — e agora
  também com zero amostras auto-referentes, porque não há fill de espécie
  alguma.
- **PnL realizado por janela**: o total é exato (é o do ledger da RFC-011), mas
  as janelas diária e semanal atribuem o realizado de cada posição ao seu
  `resolved_at`. Realização por fechamento **antecipado** (venda antes da
  resolução) só entra quando o token resolve, então os limites diário e semanal
  podem disparar **tarde** para um livro que sai das posições antes do
  settlement. Atribuir corretamente exigiria reprocessar o ledger evento a
  evento, que é papel do módulo da RFC-011. `updated_at` não serve de
  substituto: uma atualização de marca o move e reatribuiria uma perda antiga
  para hoje em todo ciclo.
- ~~Os gates G2–G6 contra o modo de falha "passa por degeneração"~~ —
  **fechado na seção 10**. Três dos quatro tinham o defeito; o G4 era mesmo o
  mais suspeito, e por dois motivos somados em vez de um. Nenhum gate ficou sem
  teste de regressão. O que **não** foi reauditado sob essa lente é o G5, cuja
  única condição não medida sobre livro é o fingerprint de regime — ele já
  compara duas coisas de origens diferentes (o parâmetro gravado da venue e o
  relógio persistido) e não tem o formato do defeito.
- **Ponte decisão → ordem de paper NÃO existe**: verificado por busca de código —
  fora do próprio módulo, o único código que toca `portfolio_decisions` é o
  worker de retenção. A coluna `paper_order_id` da migration nunca é preenchida.
  Em produção já houve **2 entradas ACEITAS** que não geraram posição nenhuma.
  Sem essa ponte, o G2 nunca acumula posição fechada e fica em
  `INSUFFICIENT_DATA` para sempre — é o gargalo real do gate, maior que a
  ausência de modelo promovido na RFC-010. **Recomendação de desenho escrita**
  em
  [`docs/architecture/decision-to-paper-bridge.md`](../architecture/decision-to-paper-bridge.md)
  (2026-08-27): o decision log é o outbox, o consumidor mora no módulo `paper`,
  e nenhum dos dois módulos escreve na tabela do outro. Não implementada.
- **Breaker de salto sem catalisador**: "catalisador conhecido" é o instante de
  resolução do próprio mercado ou um evento/release do calendário macro dentro
  da janela. É uma aproximação declarada — um catalisador que o calendário não
  conhece faz o breaker abrir, o que é a direção conservadora.
