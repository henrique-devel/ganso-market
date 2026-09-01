# RFC-019 — Polymarket: variante updown (strike = abertura da janela) e cobertura por forma

**Status:** in-progress (escopo aprovado pelo proprietário em 2026-08-28 —
prompt 04 do roadmap, prioridade "alpha primeiro"; implementação iniciada em
2026-09-01)
**Dependências:** RFC-014 (variante de barreira — as duas entram na MESMA
versão `crypto_updown_gbm@1.1.0`), RFC-016 (instante real de fim, ativa),
RFC-010 (modelo fundamental, ativo)
**Habilita:** a cobertura da série "Up or Down" — a família de maior giro da
categoria (~39 mercados rotulados/dia medidos em 2026-09-01) — e a
estratificação por forma no relatório de calibração

## Objetivo

Os mercados "Up or Down" são terminais com um strike que não está na pergunta:
o preço de abertura da janela do próprio mercado. Esta RFC define de onde o
strike vem, o que acontece quando ele não é derivável, e como o relatório
diário passa a mostrar cobertura e métricas por forma de pergunta
(`terminal` / `barrier` / `updown`).

Nada muda no microprice, no intervalo, no fallback, no gate, no label store ou
na API. A variante nasce em `shadow` dentro de `crypto_updown_gbm@1.1.0` e só
serve com gate PASS + promoção manual — nenhuma exceção.

## O que foi medido antes do desenho (produção, 2026-09-01)

- **`event_start_ts` não existe.** O prompt do roadmap mandava ler o strike
  "no instante `event_start_ts` da RFC-016" — mas a D2 da RFC-016 mediu
  `eventStartTime: null` em 100/100 mercados e a coluna nunca nasceu. A
  adaptação fiel ao invariante (fonte gravada, as-of, fail-closed) é derivar o
  início da janela do FIM real (RFC-016) menos a duração declarada no título.
- **Famílias reais da série** (regras versionadas, verbatim):
  - horária ("Bitcoin Up or Down - August 31, 9PM ET"): "Up" se
    `close ≥ open` do candle Binance de **1 hora** que começa no instante do
    título; medido: `end_ts = início + 1 h` ⇒ `windowStart = deadline − 1 h`;
  - diária ("Ethereum Up or Down on September 1?"): compara o close do candle
    de 12:00 ET do dia com o do dia anterior; `end_ts` = meio-dia ET ⇒
    `windowStart = deadline − 24 h`; empate exato resolve 50/50. **Exceção
    fail-closed**: nas duas noites de DST do ano a janela real tem 23 h/25 h
    e `deadline − 24 h` NÃO é o meio-dia anterior — um strike do instante
    errado é insumo fabricado, então a família diária é **recusada** quando a
    janela cruza uma transição de DST dos EUA (instantes calculados
    deterministicamente pela regra fixa em lei desde 2007). A família horária
    é imune (candles alinhados a hora UTC, offsets inteiros);
  - por faixa ("4:00PM-8:00PM ET"): payoff **asiático** (TWAP Chainlink da
    faixa vs preço no início) — **recusada** nesta versão, registrada como
    variante candidata futura (ver E1 da RFC-014).
- **Ordem dos tokens:** `affirmative_token_id` = primeiro token em 267 de 271
  mercados updown recentes; 4 vêm nulos. O estimador precifica o token 0 com o
  `q` do modelo, então a variante **exige** afirmativo presente e igual ao
  primeiro token; caso contrário recusa (fail-closed).
- **Fonte de resolução:** Binance (candles), não Chainlink — ver E1 da
  RFC-014. O strike e o nível corrente saem do MESMO feed TWAP gravado
  (twap30/twap60), então o offset estrutural entre as fontes cancela na razão
  K/S; o resíduo (alisamento TWAP vs open/close de candle) fica registrado.

## Desenho

1. **Strike.** `K = preço do feed TWAP gravado, as-of `windowStart`` — a
   MESMA query as-of usada para o nível corrente (`loadFeedSamples`), avaliada
   no instante de abertura da janela. Exigências, todas fail-closed
   (⇒ abstenção `MODEL_ABSTAINED`):
   - `windowStart` derivável (família horária ou diária) e
     `windowStart ≤ decision_ts` (janela aberta — antes disso o strike ainda
     não existe);
   - amostra existente com `source_ts ≤ windowStart` e idade em relação a
     `windowStart` ≤ `crypto.max_strike_age_ms` (default 5 min) — um gap do
     RTDS na abertura da janela produz ausência, nunca um strike de outro
     instante;
   - amostra do MESMO feed (twap30/twap60) que o nível corrente e a série de
     volatilidade — nunca misturar feeds na mesma quantidade.
2. **Mapa.** Com o strike resolvido, updown é o mapa terminal existente com
   `direction = above` ("Up" = fechar em/acima da abertura): mesmo ensemble,
   mesma dispersão, mesmo piso de sigma. `P(close = open) = 0` no contínuo, e
   os dois desempates reais (horário: empate ⇒ Up; diário: empate ⇒ 50/50)
   são irrelevantes para um mapa contínuo — registrado.
3. **Proveniência.** `data_refs` da linha updown carrega `form: "updown"`,
   `windowStart`, o `source_ts` da amostra do strike, a idade do strike em
   relação à abertura e o próprio strike — a estimativa é reproduzível das
   refs, como manda a RFC-010.
4. **Relatório por forma.** `ScoredObservation` ganha a forma (lida de
   `data_refs->>'form'`; linhas anteriores ao carimbo são `terminal` por
   construção — a v1.0.0 e o modelo macro só precificaram payoffs terminais).
   O walk-forward ganha `formSlices` (mesma mecânica das fatias de horizonte,
   ordem canônica `terminal, barrier, updown`), descritivas no payload. O
   relatório diário ganha `coverage_by_form`: dos mercados crypto com
   estimativa nas últimas 24 h, quantos de cada forma e quantos com linha
   MODEL do modelo do relatório. **O gate não muda**: os critérios continuam
   N=100, não-inferioridade IC95 e fatias de horizonte.
5. **Contagem do gate.** A evidência é carregada por `model_id`
   (`calibration.ts`), então o N=100 da `@1.1.0` começa automaticamente quando
   ELA começa a estimar — nenhum código novo, só o fato registrado.

## Condições de parada (herdadas e próprias)

- Strike vindo de fonte não gravada, não as-of, ou de instante diferente da
  abertura derivada — parar.
- Qualquer variante nascendo fora de `shadow`, ou atalho no gate — parar.
- Família de título não derivável ⇒ abstenção/recusa, nunca "a duração mais
  provável".
- `make verify` vermelho — parar.

## Critérios de aceite

- Cobertura de mercados crypto com linha MODEL/shadow sobe de forma medida em
  produção (baseline re-medido em 2026-09-01: 36 de 113 mercados com
  estimativa em 24 h, 31,9% — barreira 0/23+28, updown 0/13).
- Zero regressão na v1.0.0: mesmos inputs terminais ⇒ mesmos `q`/`sigma`
  (teste golden pinado antes da mudança).
- Relatório de calibração seguinte com `formSlices` e `coverage_by_form`.
- RAM do estimator dentro de 192 MiB (medido em 2026-09-01: 29,8 MiB).
