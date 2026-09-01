# RFC-017 — Polymarket: shadow replay (varredura de config e replay de fonte)

**Status:** in-progress (2026-09-01)
**Dependências:** RFC-013 tarefa 7 (replay determinístico do decision log, ativo em produção), RFC-010 (estimativas e labels, ativos), RFC-012 (buffer de resolução, ativa)
**Habilita:** o número de `capitalCostAnnual` que cunharia a config 1.3.0; a leitura contrafactual "e se a fonte fosse o shadow?" que alimenta — sem substituir — a decisão de promoção da RFC-010

## Prompt a executar

Duas ferramentas de leitura sobre o decision log gravado, num único CLI que
**recusa escrita por construção**. O modo A varre valores candidatos de uma
chave de config e mede o que muda. O modo B troca a FONTE da estimativa pelas
linhas shadow e mede o mesmo, mais o PnL contrafactual contra os labels. Nenhuma
tabela nova, nenhum painel, nenhuma versão de config cunhada.

---

## Motivação, e as três premissas que a re-medição desmente

Os fatos do escopo de 2026-08-28 foram re-medidos em **2026-09-01, 13:30–13:35Z,
contra produção** (`release-sha c8327a8`, todos os containers de pé desde
12:14Z). Três premissas caem, e o desenho depende disso.

### O que continua de pé

| Premissa de 2026-08-28                                   | Medido em 2026-09-01                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| o replay determinístico existe e roda                    | **confirmado**: `PORTFOLIO_REPLAY_OK` 4× nas últimas 3 h, **zero** `PORTFOLIO_REPLAY_MISMATCH` |
| `loadRecentDecisions` não pagina                         | **confirmado** (`gatestore.ts:872`, `ORDER BY decision_id DESC LIMIT $1`) — e a janela cheia são **221 092 linhas / ~620 MB** de JSON num container de **384 MiB** (`mem_limit` da `api`) |
| entradas ACCEPTED são raras                              | **confirmado, e pior que o esperado**: **10** entradas ACCEPTED em 2,16 dias, em **2** mercados |
| `capitalCostAnnual = 0,12` na 1.2.0, cobra só o excedente | **confirmado** (`ev.ts:capitalCostPerShare`), e o excedente é **exatamente zero em 19 762 de 19 762** linhas que chegaram à conta |

Janela real do decision log, medida: **2026-08-30 09:44:16Z → 2026-09-01
13:32:43Z** (2,16 dias), 221 092 linhas, 317 mercados distintos, **uma única
versão de config (1.2.0)** em 100% das linhas. Densidade de escrita homogênea
(~55 linhas/mercado/hora, uma por minuto) nas 53 horas da janela: **a mudança de
cadência da RFC-018 não foi deployada**, então a janela é uma população só.

### Premissa desmentida 1 — o denominador honesto não é o log, são 8,9% dele

A varredura de uma chave de custo só pode mover uma decisão que **chegou à
conta**. `evaluateMarket` recusa em escada, e as recusas de cima são todas
decididas por escalares já persistidos, que nenhuma troca de config recomputa:

| Ordem | Recusa                                                          | Decidida por             | Alcançável por config? |
| ----- | --------------------------------------------------------------- | ------------------------ | ---------------------- |
| 1     | `PORTFOLIO_HALTED` / `PORTFOLIO_REDUCE_ONLY`                     | `portfolio_state`        | não                    |
| 2     | `PORTFOLIO_CIRCUIT_BREAKER`                                      | `breaker_open`           | não                    |
| 3     | `RESOLUTION_STATE_MISSING` / `_CIRCUIT_BREAKER` / `RESOLUTION_VETO` | `resolution_action`    | não                    |
| 4     | `BOOK_STALE` / `DATA_STALE`                                      | idades vs `staleness.*`  | **só por `staleness.*`** |
| 5     | `ESTIMATE_MISSING` / `NO_BOOK`                                   | dado persistido          | não                    |
| 6+    | banda de preço, critério de entrada, `edgeLiqMin`, sizing        | a conta                  | **sim**                |

Medido: **19 744 de 221 176** linhas de entrada chegaram ao passo 6 — **8,93%**
— e elas vivem em **65 dos 319** mercados. Metade do log (108 578 linhas,
49,1%) é `PORTFOLIO_CIRCUIT_BREAKER`, que nenhuma chave varrível toca.

Uma varredura que dividisse os flips por 221 092 reportaria um número
**11× menor que o real** e chamaria de "impacto zero" o que é "população
errada". O denominador é por chave: a ferramenta declara, para cada chave, qual
degrau ela move e quantas linhas chegaram lá.

### Premissa desmentida 2 — `capitalCostAnnual` não é "quase inerte", é inerte por 135×

O escopo diz que 18,3–20% torna o parâmetro vinculante no topo da banda e que
36,5% "reprecifica o livro inteiro". A álgebra do cruzamento (`r > 0,1825/p`)
está certa; o que faltava é a **magnitude**, e ela vem do lockup.

Os lockups do log inteiro são **dois valores**: `0,0264 d` (38 min) e `0,1528 d`
(3,67 h). Com o hurdle do buffer em `0,0005/dia` — medido em todas as linhas — a
carga de capital por ação, calculada com a própria `capitalCostPerShare`:

| lockup | preço | r=0,183   | r=0,20    | r=0,30    | r=0,40        |
| ------ | ----- | --------- | --------- | --------- | ------------- |
| 3,67 h | 0,45  | 0         | 0         | 0         | **0**         |
| 3,67 h | 0,95  | 0         | 0,0000031 | 0,0000429 | **0,0000827** |
| 38 min | 0,95  | 0         | 0,0000005 | 0,0000074 | **0,0000143** |

Contra `edgeLiqMin = 0,02`: a maior carga possível na maior taxa candidata é
**0,41% do limiar** — 1/242 dele. Abaixo de `p = 0,45` a carga é **exatamente
zero em toda a lista de candidatos, 0,40 incluído**.

Resolvendo pela mesma função qual taxa moveria alguma coisa:

| Alvo                                                     | lockup | preço | taxa necessária    |
| -------------------------------------------------------- | ------ | ----- | ------------------ |
| virar a entrada ACCEPTED mediana (consumir 0,0101/ação)   | 3,67 h | 0,45  | **5 404% a.a.**    |
| idem                                                      | 38 min | 0,45  | 31 085% a.a.       |
| alcançar `edgeLiqMin`                                     | 3,67 h | 0,95  | 5 050% a.a.        |
| alcançar `exits.edgeResidualMin` na SAÍDA (carga integral) | 3,67 h | 0,45  | **5 310% a.a.**    |

A lista candidata termina em **0,40**. Está **135× abaixo** da menor taxa capaz
de mover uma decisão. O parâmetro só começaria a pesar com lockup de **~30 dias**
(81% do `edgeLiqMin` a r=0,40 e p=0,95); o livro negocia horas.

Isso corrige também o registro do HANDOFF de que na saída "os 12% de hoje já são
vinculantes". O comentário de `exitcycle.ts:250` está certo sobre o *sinal* — com
hurdle zero a carga é positiva sempre — mas o critério 6 (`edgeAtBid <
remainingCapitalCost`) compara contra **0,000159/ação** no pior caso a r=0,40,
enquanto o critério 1 dispara em `edgeResidualMin = 0,01`. O critério 6 está
**63× dentro** do critério 1: ele só pode disparar em posição que o critério 1 já
tirou. Positivo não é vinculante.

**Consequência de desenho, não de opinião:** a varredura vai dar zero flips em
toda a lista, e "zero" aqui tem três leituras diferentes que a ferramenta é
obrigada a separar — nada era alcançável, o parâmetro é aritmeticamente incapaz
nesta população, ou o parâmetro genuinamente não morde. Daí as métricas de
margem serem o headline, e não um adendo.

### Premissa desmentida 3 — parte das decisões JÁ usa o shadow (defeito ativo)

O modo B pergunta "e se o `q` viesse do shadow em vez do baseline?". A medição
mostra que às vezes **já vem**.

`estimateAsOf` (`store.ts:178`) faz `WHERE token_id = $1 AND decision_ts <= $2
ORDER BY decision_ts DESC LIMIT 1` — **sem filtro de `status` e sem desempate**.
Em cada instante um token tem uma linha de consumidor (`status='active'`) e uma
linha por modelo shadow (`status='shadow'`), **todas com o mesmo `decision_ts`**
(`estimate.ts`; chave única `(token_id, decision_ts, COALESCE(model_id,''))`).
Qual delas o `LIMIT 1` devolve é indefinido.

Medido: **zero modelos promovidos** (as três linhas de `fundamental_models` estão
em `shadow`), e mesmo assim duas decisões de hoje carregam
`estimate_source='MODEL'` — `decision_id` 698296 (13:03:43Z) e 700076
(13:30:43Z). A 698296 gravou `q=0,999000 / q_lo=0,990385 / q_hi=0,999000`, que é
exatamente a linha shadow (`estimate_id` 837093, `crypto_updown_gbm@1.0.0`) e
**não** a linha ativa do mesmo instante (`estimate_id` 837092, `q=0,998500 /
q_lo=0,997632`). Há **80 397 instantes** com mais de uma linha; a colisão passou
a disparar depois que o PR #70 acrescentou um segundo modelo shadow.

Isso viola a invariante da RFC-010 ("shadow estimates exist for gating only and
are invisible to consumers", migration 0006) e deixa um modelo não promovido
influenciar decisão de paper sem gate PASS. **O conserto é de uma linha
(`AND status = 'active'` mais desempate determinístico) e fica FORA desta RFC** —
é área da RFC-010, não do replay, e o registro vai ao HANDOFF para decisão do
proprietário.

Para esta RFC a consequência é obrigatória e local: o modo B tem que **detectar e
excluir** a decisão cuja fonte já era shadow. Comparar shadow contra shadow e
chamar de contrafactual seria inventar um resultado.

---

## Objetivo

Uma ferramenta de leitura, em dois modos, que responda com número medido:

- **modo A:** trocando UMA chave da config gravada, quantas decisões mudam de
  veredito, de tamanho e de binding constraint — e, quando nada muda, **quão
  longe** ficou de mudar;
- **modo B:** trocando a FONTE do `q/q_lo/q_hi` pelas linhas shadow as-of o
  `decision_ts`, o mesmo — mais o PnL contrafactual das entradas que o shadow
  teria aceitado, contra os labels finais.

Não é objetivo: cunhar config, escrever em qualquer tabela, publicar endpoint,
tabela ou painel, ou substituir o gate da RFC-010.

## Restrições não negociáveis

1. **`replayDecision` e o `CONFIG_HASH_MISMATCH` não mudam.** O caminho
   contrafactual é novo e explícito ao lado deles. A auditoria horária continua
   idêntica, byte a byte.
2. **Nenhuma escrita.** O CLI abre o pool através de um envelope que recusa todo
   statement que não seja `SELECT`/`WITH … SELECT`, e a sessão roda com
   `default_transaction_read_only = on`. Duas barreiras independentes.
3. **Nunca gravar config candidata em `portfolio_config_versions`.** Cunhar
   versão é ato do proprietário.
4. **Nenhum terceiro construtor de linha.** O modo A e o modo B importam
   `entryDecisionRow`/`exitDecisionRow` de `decisionrow.ts`. Um construtor novo
   compararia duas implementações do mapeamento em vez do motor.
5. **Baseline obrigatório.** Toda decisão passa antes por `replayDecision` com a
   config gravada; `MATCHED` é condição de entrada na amostra. Drift de motor
   nunca vira sinal.
6. **Streaming.** Loader keyset por `decision_id ASC`; só agregados acumulam.

---

## Decisões de desenho (com o motivo medido)

### D1 — o conjunto de chaves varríveis é maior do que o escopo supunha, e o de recusadas também

O escopo manda recusar `breakers.jumpThreshold` e `lossLimits.*`. A leitura do
código mostra que o critério real é outro, e classifica mais chaves: **uma chave
é varrível se e somente se `evaluateMarket` ou `planExit` a lê da config**. Tudo
o mais chega ao replay como escalar já computado, e trocá-lo na config não
recomputa nada.

Varríveis (entrada): `costs.capitalCostAnnual`, `costs.safetyMarginMin`,
`costs.safetyMarginEdgeFraction`, `costs.edgeLiqMin`, `costs.slippageMaxPctEdge`,
`priceBand.minBuy`, `priceBand.maxBuy`, `kelly.lambda`,
`kelly.uncertaintyShrinkSlope`, `depth.takePct`, `staleness.bookMaxAgeMs`,
`staleness.estimateMaxAgeMs`, `staleness.resolutionMaxAgeMs`.
Varríveis (saída): `costs.capitalCostAnnual`, `exits.edgeResidualMin`,
`exits.modelMoveThreshold`, `exits.depthFloorShares`,
`exits.catalystBlackoutMin`.

Recusadas, com o motivo **por que o zero seria vazio**:

| Chave                          | Chega ao replay como       | Por que a varredura seria mentira        |
| ------------------------------ | -------------------------- | ---------------------------------------- |
| `breakers.*`                   | `breaker_open` (booleano)  | o salto foi detectado contra histórico de livro que o replay não tem |
| `lossLimits.*`                 | `portfolio_state`          | o estado foi decidido pelo ciclo, não pela linha |
| `caps.*`                       | `cap_headroom` (USD)       | a folga já vem calculada em dólares      |
| `bankrollUsd`                  | `bankroll` (escalar)       | idem                                     |
| `kelly.maxLambda`              | —                          | só os gates leem                          |
| `exits.unwindAlarmPctOpenPnl`  | —                          | é alarme, não entrada de decisão          |
| `gates.*`                      | —                          | limiar de gate, não de decisão            |
| `cadence.*`                    | —                          | fora do hash por desenho                  |

A recusa é **por lista explícita**, com o motivo impresso. Uma chave
desconhecida também é recusada: o clone passa por `parsePortfolioConfig`, que já
falha em chave desconhecida e em valor fora de faixa.

### D2 — o clone é validado, não montado

O candidato não é um objeto remendado em memória: a config gravada é serializada,
a chave é trocada no JSON, e o resultado volta por **`parsePortfolioConfig`**.
Isso dá de graça três coisas que um remendo não daria: recusa de chave
desconhecida, recusa de valor fora de faixa, e a invariante cruzada
(`kelly.lambda ≤ kelly.maxLambda`) que um sweep de `kelly.lambda` acima de 0,5
violaria em silêncio.

### D3 — margem, e as três leituras do zero

Para toda linha que chegou à conta, a distância assinada até a fronteira de
aceitação é bem definida e está em unidades de preço por ação:

```
accept_slack = edge_net − max(safety_margin, edgeLiqMin)
```

`clearsEntryCriterion` é `edge_net > safety_margin` e o degrau seguinte é
`edge_net ≥ edgeLiqMin`; o `max` dos dois é a fronteira que decide. A ferramenta
reporta, por candidato: a distribuição de `accept_slack` no baseline, o
`Δaccept_slack`, e a **fração da folga consumida** `|Δ| / |slack_baseline|`.

É isso que separa as três leituras do zero:

- nada alcançável → o denominador da chave é 0, e a linha da tabela diz isso;
- incapaz → folga consumida ~0,8%, com `accept_slack` intacto;
- não morde → folga consumida alta e mesmo assim sem cruzar.

Complemento explícito: o **valor de virada** por chave, achado por bisseção sobre
`accept_slack` dentro de um bracket declarado, e **re-derivado** no valor achado
para confirmar que o veredito de fato mudou ali. A limitação vai impressa: a
bisseção acha *uma* travessia no bracket, não prova que é a única.

### D4 — dupla ponderação, porque a concentração é real

Medido na população alcançável: 65 mercados, mediana ~304 linhas, o maior com
1 347 (6,8% do total) e o menor com 3. Um percentual por linha é dominado pelos
mercados longevos. Todo percentual sai **duas vezes**: por linha e por mercado
distinto (um mercado conta uma vez se qualquer linha dele mudou).

### D5 — modo B lê tabelas de mercado, e diz isso no próprio output

O modo A é auditoria: lê `portfolio_decisions` e `portfolio_config_versions`, e
nada mais — continua válido depois que o TTL dos dados crus podar tudo. O modo B
**não é**: lê `fundamental_estimates` e `fundamental_labels`. Ele imprime
`"analysis_mode": "offline"` e a janela de overlap efetivamente coberta.

Overlap medido: estimativas vão de **2026-08-20 05:03Z** a agora (12,3 dias) e o
decision log de **2026-08-30 09:44Z** — as estimativas cobrem o log inteiro. O
que limita é a cobertura shadow por token: **2 427 das 19 768** linhas
alcançáveis (12,3%) têm linha shadow as-of dentro do TTL de 300 s, em **22 dos 65**
mercados. Labels finais existem para **23 dos 65** tokens alcançáveis.

### D6 — honestidade do modo B

- **o denominador da D3 vale aqui também.** Um `VETO` recusado na camada de
  resolução replica, acha a linha shadow do instante e não muda — mas nenhuma
  estimativa do mundo o mudaria. Ele entra na amostra e **fica fora** do
  denominador da pergunta: o modo B publica `decisionsReachingEstimate` ao lado
  de `decisionsAdmitted`, pelo mesmo motivo que o modo A publica
  `decisionsReachingArithmetic`.
- **shadow ausente no instante → exclui e conta** (`shadow_missing`). Nunca
  interpolar, nunca cair para a linha anterior fora do TTL de `estimateMaxAgeMs`.
- **as-of estrito:** `decision_ts <= <o instante da decisão>`. Uma estimativa
  posterior nunca entra, e o teste prova isso com uma linha plantada depois.
- **fonte já contaminada → exclui e conta** (`baseline_already_shadow`), pelo
  defeito da premissa 3.
- **PnL contrafactual** usa os custos do próprio motor (fee, slippage, capital,
  buffer, tudo do `computeEv` da re-derivação) **mais** a degradação conservadora
  da coluna base do ledger (`BASE_SLIPPAGE_FALLBACK`, um tick por ação taker), e
  liquida contra `fundamental_labels.label` só quando `is_final`. Sai rotulado
  `hypothetical` e com a contagem de entradas que o compõem.
- o resultado **alimenta** a decisão de promoção; o gate da RFC-010 continua
  soberano.

---

## Tarefas

### T1 — loader keyset com streaming (`sweepstore.ts`)

`streamDecisions(pool, {from, to, kinds, batchSize}, onBatch)`: `WHERE decision_id
> $cursor` ordenado por `decision_id ASC`, `LIMIT $batch`, cursor = último id do
lote. Só agregados sobrevivem ao lote. `loadRecentDecisions` fica intocado — a
auditoria horária continua usando o dela.

### T2 — modo A (`sweep.ts`, funções puras)

`configWithKey(config, path, value)` (via D2), `sweepDecision({decision, config,
candidates})` devolvendo, por candidato, o veredito, o binding constraint, os Δ e
o `accept_slack`; `SweepAccumulator` com a dupla ponderação da D4;
`breakevenValue(...)` da D3.

### T3 — modo B (`sourcereplay.ts`, funções puras)

`substituteEstimate(replayBlock, shadow)` trocando **só** `q`, `q_lo`, `q_hi`,
`estimate_source` e `estimate_age_ms`; `counterfactualPnl({entries, labels})` com
os custos da D6.

### T4 — o CLI (`shadow-replay-cli.ts`)

`sweep <caminho.da.chave> --values a,b,c` e `source-replay`, ambos com
`--format table|json`, `--from`/`--to`, e um bloco de proveniência (janela,
versões, contagens, contadores de exclusão). O envelope read-only da restrição 2
mora aqui.

### T5 — documentação

RFC (este arquivo), `docs/RFC_INDEX.md`, HANDOFF com a rodada verbatim e o
defeito da premissa 3, e o status em `prompts/roadmap/README.md`.

---

## Testes obrigatórios

Modo A:

1. taxa acima do cruzamento **flipa** uma linha sintética ACCEPTED→REJECTED e
   muda o binding constraint (fixture com lockup longo, porque a produção não
   tem um);
2. a taxa gravada (0,12) dá **zero** mudanças — linha de controle;
3. `baseline_mismatch` exclui e conta (config hash divergente);
4. **determinismo byte a byte** entre duas rodadas sobre a mesma entrada;
5. ponderação por linha ≠ ponderação por mercado numa fixture desenhada para
   divergir;
6. chave recusada (`caps.mercado`, `breakers.jumpThreshold`) falha com o motivo;
7. chave inexistente e valor fora de faixa falham em `parsePortfolioConfig`.

Modo B:

8. shadow ausente exclui e conta;
9. **sem look-ahead**: estimativa posterior ao `decision_ts` não é usada;
10. fonte já shadow exclui e conta (premissa 3);
11. PnL contrafactual bate com conta feita à mão numa fixture pequena.

Transversais: `make verify` verde; nenhum teste toca tabela de produção.

## Critérios de aceite (verificados depois do deploy)

- `PORTFOLIO_REPLAY_OK` continua saindo, com a mesma amostra de 50;
- a rodada real dos dois modos sai com bloco de proveniência completo e vai
  verbatim ao HANDOFF;
- o modo A roda a janela cheia dentro do `mem_limit` de 384 MiB;
- toda tentativa de escrita pelo CLI é recusada (provado no teste do envelope).

## Condições de parada

Escrita em qualquer tabela; terceiro construtor de linha; `replayDecision` ou seu
check de hash tocados; `make verify` vermelho; varredura que atravesse o deploy
da RFC-018.
