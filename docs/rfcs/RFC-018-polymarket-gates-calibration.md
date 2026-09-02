# RFC-018 — Gates mensuráveis e calibração: as decisões de 27/08 viram código

**Status:** in-progress (2026-09-02)
**Dependências:** RFC-013 (motor de portfólio e gates, código completo), RFC-012 (léxico de cláusula e `rule_version`, ativa em produção), RFC-010 (registro de versões de modelo, ativo)
**Habilita:** um decision log cuja janela retida serve ao `entryProvenanceFor`; um cap de fonte de resolução que diversifica em vez de ser teto global; o G3 exercitando o breaker que a RFC-013 exige e o código não conseguia disparar; o caminho operacional de registro de versão calibrada

## Prompt a executar

As três decisões de calibração do proprietário (2026-08-27, registradas no
HANDOFF) viram código, mais as lacunas mecânicas dos gates. Um PR por item.
**Nenhum número de gate afrouxa**: `caps.fonteResolucao` fica em 0,25, os
limiares do G1–G6 ficam onde estão, e a única mudança de config versionada é
nenhuma — o TTL mora em `retention.ts`, não em `config/`.

---

## O que a re-medição de 2026-09-01/02 desmente

Fatos re-medidos contra produção em **2026-09-01 23:50Z – 2026-09-02 00:15Z**
(`release-sha` da API `4f04f23`, do portfolio `18000c1`; todos os containers de
pé desde 23:46Z). Três premissas do escopo caem.

| Premissa do escopo (2026-08-27/28)                             | Medido em 2026-09-01/02                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `DATA_STALENESS` nunca foi exercitado                          | **falso**: 58 aberturas desde 2026-08-28 20:54:48Z (1 ainda aberta). Faltam **dois** breakers, não três       |
| com (b), o TTL de 90 dias "passa a ser o limite que vale"       | **falso**: 8,6× de redução leva a janela de 2,2 → ~19 dias. A quota de 0,9 GB continua vencendo o TTL          |
| os breakers que faltam nunca coincidiram com posição aberta     | **falso para o UMA**: em 2026-09-01 16:04:52Z houve proposta UMA num mercado com posição aberta. Não disparou |

### O fator de redução, medido (item 1)

Janela retida do `portfolio_decisions` na hora da medição: **2026-08-30
20:02:31Z → 2026-09-01 23:58:02Z** (2,17 dias), **226 953** linhas de entrada
(`decision_kind = 'ENTRY'`; zero linhas `VETO`), **330** tokens distintos.

Assinatura, exatamente como a decisão a define — veredito, `reason_code`,
binding constraint:

| Métrica                                    | Valor                        |
| ------------------------------------------ | ---------------------------- |
| Linhas de entrada na janela                | 226 953                      |
| Linhas que a regra "grava quando muda" escreveria | **26 256**            |
| **Fator de redução medido**                | **8,6×**                     |
| Por dia: 31/08                             | 105 350 → 12 711 (**8,3×**)  |
| Por dia: 01/09                             | 106 093 → 10 817 (**9,8×**)  |
| Linhas/token/dia hoje                      | 487 – 515                    |
| Trocas de assinatura/token/dia             | 52 – 59                      |

**O que sobra depois da redução, e por quê.** 53% das 26 256 escritas restantes
são **um par de vetos de staleness trocando de lugar**:

| Transição                                    | n     |
| -------------------------------------------- | ----- |
| `BOOK_STALE` → `DATA_STALE`                  | 7 080 |
| `DATA_STALE` → `BOOK_STALE`                  | 6 965 |
| `DATA_STALE` ↔ `LOWER_BOUND_BELOW_COSTS`     | 3 456 |
| `DATA_STALE` ↔ `PRICE_OUT_OF_BAND`           | 2 612 |

Os dois primeiros são a mesma recusa — "o dado está velho" — decidida por uma
corrida entre a idade do livro e a idade da estimativa, que se alternam de
minuto a minuto. Uma assinatura que os unificasse daria um fator perto de 18×,
mas isso seria **outra** assinatura, e a decisão do proprietário nomeia esta.
Fica registrado como fato medido, não aplicado: colapsar dois códigos de recusa
distintos num só é decisão de quem lê o log, não do implementador.

### A aritmética que o TTL de 90 dias não fecha (item 1)

| Tabela                      | Linhas  | Janela retida | `pg_column_size` médio | Linhas/dia | Físico  | Quota    | TTL declarado | **Janela que a quota entrega** |
| --------------------------- | ------- | ------------- | ---------------------- | ---------- | ------- | -------- | ------------- | ------------------------------ |
| `portfolio_decisions`       | 228 383 | 2,17 d        | 3 634 B                | 106 402    | 2 448 MB | 0,9 GB   | 180 d         | ~2,4 d                         |
| `portfolio_panel_snapshots` | 216 656 | 2,05 d        | 2 031 B                | 106 201    | 759 MB  | 0,54 GB  | 30 d          | ~2,5 d                         |

As duas tabelas são podadas por `quota` em **todas** as rodadas registradas em
`polymarket_retention_log` — nenhuma por TTL. Com o fator de 8,6×, o decision
log passa a escrever ~12,4 mil linhas/dia (~45 MB/dia) e a quota de 0,9 GB
entrega **~19 dias**. É "semanas", como a decisão previu, e é muito mais do que
o `entryProvenanceFor` precisa — mas **não são 90 dias**, e o TTL continua sem
morder. O 90 é registrado como intenção declarada e o texto do código passa a
dizer qual é o limite que realmente vale.

### O breaker que não conseguia disparar (item 3)

`portfolio_circuit_breakers` em produção:

| Kind                      | Aberturas | Abertas | Primeira            | Última              |
| ------------------------- | --------- | ------- | ------------------- | ------------------- |
| `PRICE_JUMP_NO_CATALYST`  | 8 802     | 6       | 2026-08-26 19:58Z   | 2026-09-02 00:03Z   |
| `PARAM_CHANGE`            | 845       | 59      | 2026-08-26 19:53Z   | 2026-09-01 23:57Z   |
| `DATA_STALENESS`          | 58        | 1       | 2026-08-28 20:54Z   | 2026-09-01 22:44Z   |
| `UMA_PROPOSED_OR_DISPUTED`| **0**     | —       | —                   | —                   |
| `RULE_CLARIFICATION`      | **0**     | —       | —                   | —                   |

**`UMA_PROPOSED_OR_DISPUTED` é defeito, não falta de oportunidade.** A RFC-013
item 4(i) pede o breaker em "`umaResolutionStatus` = **proposed/disputed** em
qualquer posição", e o comentário do próprio código diz "A UMA request proposed
or disputed on a market we hold". A condição implementada
(`breakers.ts:122`) é

```ts
o.holdsPosition && (o.disputeActive || o.resolutionAction === "CIRCUIT_BREAKER")
```

e o estado `proposed` **não chega ao módulo**: `resolutionStateFor`
(`store.ts:217`) lê `resolution_market_state`, que carrega `dispute_active` e
`effective_action` e não tem coluna alguma para a proposta. Medido: `resolution_uma_timeline`
tem **482 mercados com `proposed`** e 340 com `settled`; `dispute_active` é
`false` em **781 de 781** mercados e nenhum tem `effective_action =
'CIRCUIT_BREAKER'`. A metade "proposed" do nome do breaker é inalcançável nesta
população — é exatamente a lente de degeneração dos gates (2026-08-27) aplicada
a um controle: ele não falha, ele só não pode disparar.

**A prova real, datada.** Posição `0x71b5721c…` aberta em 2026-09-01
11:59:06Z; proposta UMA no mesmo mercado em **16:04:52Z** (bond 250, liveness
600 s), `settled` P1 em 16:14:48Z. Foram ~10 ciclos de painel com posição aberta
sob proposta ativa e **zero** breaker. O dado real para exercitar o breaker já
existiu; o código não o enxergava.

**`RULE_CLARIFICATION` não é defeito.** A lógica está correta e o gate é o que a
RFC pede ("diff de `description` em mercado **com posição**"). Ele só nunca
coincidiu: 4 clarificações materiais em ~8 dias (24/08, 26/08 ×2, 29/08), todas
em mercados que estavam no universo, contra **2** posições abertas de ~200
mercados. Taxa natural de coincidência hoje ≈ 0,5%/dia → espera ≈ 200 dias.

---

## Decisões desta RFC

### D1 — "toda intenção persiste" = toda intenção DISTINTA (item 1c)

A tarefa 7 da RFC-013 exige que toda intenção persista. O ciclo de **saída** já
foi aprovado lendo isso como toda intenção **distinta**: um hold é registrado
uma vez, não reescrito a cada 30 s (`runner.ts:1023`). Esta RFC estende a mesma
leitura ao ciclo de **entrada** e registra a interpretação explicitamente, porque
sem esse registro escrever menos leria como afrouxamento silencioso da tarefa 7,
que é a direção proibida.

O que "distinta" quer dizer, em código: a assinatura de entrada é
`kind | outcome | reason_code | binding_constraint`. Duas avaliações com a mesma
assinatura são a mesma intenção observada duas vezes, e o log guarda a primeira.
A assinatura inclui `decision_kind` (`ENTRY` vs `VETO`) além da tripla decidida —
um superconjunto, na direção segura: nunca escreve menos do que a decisão manda.

**A prova "o motor olhou" continua existindo, e fora do log:**
`portfolio_gate_measurements` (tabela `protected`, horária) e a linha
`PORTFOLIO_CYCLE` de cada ciclo, que segue reportando `evaluated` sobre o
universo inteiro. Nenhum heartbeat novo é adicionado ao decision log: seria
1 linha/mercado/hora ≈ 4,8 mil linhas/dia para reprovar um fato que já tem duas
testemunhas.

**O painel não perde cadência.** `portfolio_panel_snapshots` continua recebendo
uma linha por mercado por ciclo — é a vista viva que a API lê. Quando a decisão
não é reescrita, a linha do painel aponta para a decisão **em vigor** (a última
com a mesma assinatura) em vez de `NULL`: é a decisão que de fato explica aquele
estado, e o elo com a evidência não se perde.

### D2 — a chave do cap é a família de cláusula (item 2)

`caps.fonteResolucao` **fica em 0,25**. Muda a chave do bucket, de adapter para
família de cláusula de regra, derivada do léxico da RFC-012
(`config/resolution-lexicon.json`) sobre a `rule_version` em vigor as-of a
decisão. A família tem quatro formas, nesta ordem de precedência — a mesma
escada de `scoreRulePrecision`, para que as duas leituras não divirjam:

| Família                       | Quando                                          | Por que é um cluster de risco                                   |
| ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `SUBJETIVA`                   | o texto casa um termo subjetivo                 | falham juntas por disputa (bucket de 3–5%), qualquer que seja o termo |
| `OBJETIVA_UNICA:<fonte>`      | casa termo(s) de fonte objetiva única           | falham juntas quando **aquela** fonte falha; a fonte entra no nome |
| `OBJETIVA_MULTIPLA`           | casa termo de múltiplas fontes aceitáveis       | o fallback entre fontes é a cláusula compartilhada                |
| `CLAUSULA_NAO_CLASSIFICADA`   | nenhuma das anteriores, ou não há texto de regra | **fallback nomeado**, obrigatório: um `unknown` silencioso recriaria o bucket gigante com outro nome |

`OBJETIVA_UNICA` carrega a fonte casada no nome (`OBJETIVA_UNICA:binance`,
`OBJETIVA_UNICA:chainlink`) porque dois mercados que resolvem pelo mesmo feed
**são uma aposta**, e dois que resolvem por feeds diferentes não são — é a coisa
que o cap existe para dizer. Quando mais de um termo casa, o nome leva todos,
ordenados e unidos por `+`, para ser determinístico.

A dimensão gravada em `portfolio_exposures` continua se chamando
`resolution_source`: **muda de valor, não de nome**. `CLAUSULA_NAO_CLASSIFICADA`
é uma família como as outras e consome o cap como as outras — ele é nomeado para
ser **visível**, não para ser isento.

**MEDIDO DEPOIS DE ESCREVER A CHAVE, e desmente o benefício esperado.** A
classificação foi rodada sobre os 92 mercados do universo vivo (texto de regra
da `rule_version` em vigor, `config/resolution-lexicon.json`, 2026-09-02):

| Chave de HOJE (adapter)                      | n  | %     |
| -------------------------------------------- | -- | ----- |
| `0x65070BE9…` (adapter)                       | 74 | 80,4% |
| `0x69c47De9…` (adapter)                       | 9  | 9,8%  |
| `0x2F5e3684…` (adapter)                       | 5  | 5,4%  |
| 4 URLs de `resolution_source`                 | 4  | 4,3%  |

| Chave NOVA (família de cláusula)   | n  | %     |
| ---------------------------------- | -- | ----- |
| `OBJETIVA_UNICA:binance`           | 75 | 81,5% |
| `OBJETIVA_UNICA:federal_reserve`   | 11 | 12,0% |
| `CLAUSULA_NAO_CLASSIFICADA`        | 5  | 5,4%  |
| `OBJETIVA_UNICA:chainlink+twap`    | 1  | 1,1%  |

**O bucket gigante não some — porque ele é verdade.** 81,5% do universo vivo é
mesmo decidido pelo candle da Binance (o mesmo fato que a RFC-019 mediu quando
descobriu que a resolução real é candle Binance, não Chainlink). A chave nova
não devolve teto ao livro: com 0,25 de US$ 1.000, o livro continua limitado a
~US$ 250 enquanto a concentração for essa. A diferença é **de que o bucket
fala**: antes ele dizia "estes 74 mercados usam o mesmo adapter" — um fato sobre
o encanamento da venue; agora diz "estes 75 mercados morrem juntos se o feed da
Binance mentir" — um fato sobre risco. E os 11 mercados de taxa do Fed, que o
adapter jogava no mesmo balde, passam a ter o seu.

O que a decisão temia **não** aconteceu: o fallback nomeado ficou em **5,4%**,
não virou o bucket gigante com outro nome.

**Achado lateral registrado, não corrigido:** os 5 de
`CLAUSULA_NAO_CLASSIFICADA` não são cláusulas inclassificáveis — são **quatro
fontes reais que o léxico não nomeia**: Banco Central Europeu, U.S. Energy
Information Administration, Bank of Japan (2 mercados) e IMF Portwatch.
Acrescentá-las a `objective_single_terms` é mudança de `config/resolution-lexicon.json`,
que é **conteúdo endereçado pelo `score_version` da RFC-012**: derrubaria o
`sourceRisk` de 0,6 para 0 nesses mercados, mudaria a precisão de regra e
exigiria cunhar uma versão de score nova e re-pontuar. É mudança da RFC-012, não
desta. Enquanto isso as quatro fontes dividem um bucket, o que **super**concentra
— a direção segura.

Direção proibida, registrada: subir `fonteResolucao` para perto de 0,6 tornaria
o cap inerte e continua fora da mesa.

### D3 — o UMA vê a proposta; o `RULE_CLARIFICATION` espera dado real (item 3)

**Aprovado pelo proprietário (2026-09-02).**

1. O defeito do `UMA_PROPOSED_OR_DISPUTED` é corrigido: o estado de proposta UMA
   passa a chegar ao módulo de portfólio e o breaker passa a disparar com posição
   aberta sob proposta ativa. Não é mudança do que conta como evidência — é fazer
   o dado real alcançar um controle que a RFC já especificava.
2. **Nenhum mecanismo de injeção é construído para o `RULE_CLARIFICATION`.** O G3
   devolve `INSUFFICIENT_DATA` de qualquer forma enquanto a base de evidência do
   G2 não existir (≥ 100 posições fechadas em ≥ 30 mercados). Com 30–100 mercados
   sob posição, a taxa medida de ~0,5 clarificação/dia dá espera de ~13 dias —
   praticamente certa dentro da janela de 60 dias do G2. Construir o caminho
   injetado hoje seria criar um bypass para um gate travado por outro motivo.
3. `DATA_STALENESS` já está exercitado com dado real (58 aberturas). Registrado.

### D4 — o registro de versão de modelo é CLI, não endpoint (item 4)

Mesma razão do `gates-cli`: o perímetro HTTP da RFC-013/RFC-010 publica leitura,
e o que muda o que o sistema pode fazer fica fechado na borda. Registrar uma
versão de modelo cria a linhagem de que toda estimativa futura vai depender, e
`registerModel` já garante imutabilidade por conteúdo (id imutável,
`ON CONFLICT DO NOTHING` + `MODEL_VERSION_EXISTS`, nascimento sempre em
`shadow`, fronteira de regime verificada antes do INSERT). O CLI **reusa** essa
função — não reimplementa nenhuma garantia.

### D5 — o TTL do painel é redeclarado, não inventado (item 5)

`portfolio_panel_snapshots` promete 30 dias e a quota entrega ~2,5. Medido
`pg_column_size` = 2 031 B/linha (p50 2 000, p95 2 408) sobre 20 mil linhas, a
106 201 linhas/dia. O TTL declarado passa a **2 dias** — a janela que a quota
de 0,54 GB sustenta com folga no pior caso. Nenhuma quota nova é inventada; o
consumidor único é a API, que lê `DISTINCT ON (token_id) … ORDER BY computed_at
DESC` e o detalhe com `LIMIT 1`.

---

## Escopo, em PRs

| # | Item                                                        | Muda comportamento? | Config versionada? |
| - | ----------------------------------------------------------- | ------------------- | ------------------ |
| 1 | decision log grava quando a assinatura muda; TTL 180 → 90     | sim (cadência de escrita) | não (`retention.ts`) |
| 2 | chave do cap `fonteResolucao` = família de cláusula           | sim (sizing)        | não (0,25 intocado)  |
| 3 | o estado `proposed` da UMA chega ao breaker                   | sim (breaker novo dispara) | não           |
| 4 | CLI de registro de versão de modelo                           | não (caminho novo)  | não                  |
| 5 | `FEATURES_WINDOW_FAILED` com mensagem; TTL do painel 30 → 2   | não                 | não                  |

## Testes obrigatórios

- Entrada com assinatura repetida **não** escreve; assinatura diferente escreve;
  primeira avaliação do token escreve. A linha do painel é escrita nos três casos.
- `entryProvenanceFor` continua íntegro com a decisão de entrada podada — a
  provenance mora em `portfolio_position_entries` (`protected`).
- Duas cláusulas diferentes **deixam** de compartilhar bucket; duas iguais
  **continuam** compartilhando; cláusula não classificável cai num bucket
  nomeado e consome o cap.
- `UMA_PROPOSED_OR_DISPUTED` dispara com posição aberta e proposta ativa, e
  **não** dispara sem posição.
- Registro de versão de modelo pelo CLI cria `shadow`; segunda tentativa com o
  mesmo id é recusada com `MODEL_VERSION_EXISTS`.
- Cada teste de regressão verificado **falhando no código anterior**.

## Condições de parada

- Qualquer afrouxamento de gate ou de config sem cunhagem de versão.
- `make verify` vermelho.
- Varredura do shadow replay (RFC-017) atravessando o deploy do item 1 numa
  mesma janela de análise: a população muda de cadência no meio e o denominador
  deixa de ser um só.
