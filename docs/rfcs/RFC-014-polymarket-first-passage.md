# RFC-014 — Polymarket: variante de primeira passagem (mercados de barreira)

**Status:** in-progress (aceita em 2026-08-28 pela decisão do proprietário "alpha primeiro" — prompt 04 do roadmap; implementação iniciada em 2026-09-01 junto da RFC-019, como a MESMA versão de modelo `crypto_updown_gbm@1.1.0`)
**Dependências:** RFC-010 (modelo fundamental: microprice, intervalo, fallback, label store, walk-forward e gate já implementados e ativos); RFC-016 (instante real de fim, ativa — o horizonte e as janelas derivam dele)
**Habilita:** nada novo — amplia a cobertura da categoria `crypto_updown` para que o gate da própria RFC-010 tenha como acumular evidência

## Prompt a executar

Você deve implementar a RFC-014 do Ganso Market: uma **variante versionada** do
modelo `crypto_updown` para mercados de **barreira** (o preço *tocar* um nível
em algum momento da janela), ao lado da variante terminal que já existe (o
preço estar acima/abaixo de K *no vencimento*). Nenhuma tabela nova, nenhum
endpoint novo, nenhuma mudança no gate, no fallback ou no intervalo. A saída
continua sendo linhas em `fundamental_estimates`.

### Motivação (medida, não suposta)

Em 2026-08-23, com a RFC-010 ativa em produção:

- dos **80** mercados `crypto_updown` com estimativa nas últimas 6 h, o modelo
  atendia **7** e ficava silencioso em **73**;
- o primeiro gate com dados reais cobriu **8** mercados, contra **60** mercados
  pontuáveis disponíveis;
- as perguntas recusadas são de barreira ("Will Bitcoin **reach** $82,500 in
  August?", "Will Ethereum **dip to** $1,250 by December 31?"); as atendidas são
  terminais ("Will the price of Bitcoin **be above** $68,000 on August 25?").

**A recusa está correta e deve continuar existindo:** um mapa de distribuição
terminal, `P(S_T > K)`, subestima sistematicamente um payoff que paga se o
preço tocar a barreira em qualquer instante. O problema não é o modelo mentir —
é ele calar. No ritmo medido, os 100 mercados resolvidos que o gate da RFC-010
exige levariam ~660 mercados resolvidos para se acumular.

### Objetivo

Cobrir a maior parte da categoria `crypto_updown` sem afrouxar nada: uma
variante com mapa base próprio, versionada, que nasce em `shadow` como
qualquer outra e só serve depois de um gate PASS e promoção manual.

### Mapa base

Para log-preço sem drift (a mesma premissa que a variante terminal já faz),
pelo princípio da reflexão, a probabilidade de **tocar** uma barreira `B` acima
do nível atual `S` dentro de `τ` é exatamente o dobro da probabilidade
terminal, limitada a 1:

```
m = ln(B / S)
P(tocar B)  =  2 · Φ( −m / (σ√τ) )        para B > S
P(tocar B)  =  2 · Φ(  m / (σ√τ) )        para B < S   (simetria)
```

Casos de borda que a implementação precisa tratar explicitamente:

- se o preço **já tocou** a barreira dentro da janela do mercado, `q = 1`;
- `τ ≤ 0` ⇒ abstenção, como na variante terminal;
- o resultado é truncado em 1 antes de qualquer outra etapa.

**ASSUNÇÃO a registrar no código e no relatório:** a fórmula assume
monitoramento **contínuo**, enquanto a resolução real observa o feed Chainlink
em granularidade discreta. Isso **superestima** a probabilidade de toque. A
correção de discretização (Broadie–Glasserman–Kou) é uma variante candidata,
não um requisito desta RFC — quem decide se ela ajuda é o walk-forward, não
nós.

### Restrições não negociáveis

- **Não é um modelo novo de categoria.** É uma variante da família
  `crypto_updown`, com `version` própria (semver) e registro imutável, como
  qualquer outro treino. Continua valendo: um modelo pertence a exatamente uma
  categoria.
- **O parser não pode confundir as duas formas.** Um mercado terminal jamais
  pode ser precificado pelo mapa de barreira, nem o contrário. Ambiguidade
  entre as formas ⇒ o mercado fica no baseline, como hoje.
- Nada muda no microprice, no intervalo de incerteza, no fallback determinístico,
  no gate, no label store ou na API. Se a implementação precisar tocar em algum
  deles, **pare** e reavalie o desenho.
- A variante nasce em `shadow` e só passa a servir com gate PASS + promoção
  manual do operador. Nenhuma exceção "porque a cobertura é urgente".
- Validação somente walk-forward temporal, com a fronteira de regime de
  28/abr/2026 valendo igual.
- Nenhuma promessa de lucro em código, doc ou UI. Cobrir mais mercados **não é**
  edge; é só ter o que medir.

### Tarefas

1. **Parser.** Estender `parseCryptoMarket` para classificar a forma do mercado
   em `terminal` ou `barrier`, com a direção (`above`/`below` para terminal;
   `touch_up`/`touch_down` para barreira). Vocabulário de barreira observado em
   produção: `reach`, `dip to`, `hit`, `touch`, `ever`, `anytime`. Manter as
   recusas atuais para tudo que continuar ambíguo (dois strikes, ativo
   desconhecido, faixa `between`, sem data-limite).

2. **Mapa base de barreira** com os casos de borda acima, atrás de um
   `variant` versionado nos hiperparâmetros, exatamente como `normal` e
   `student_t` já são hoje.

3. **Detecção de toque já ocorrido.** Verificar, as-of `decision_ts` e apenas
   com dados anteriores a ele, se o TWAP resolutor já cruzou a barreira desde o
   início da janela do mercado. Usa a série de 1 min que a RFC-010 já carrega;
   **nenhum dado posterior à decisão**, e a regra anti-leakage já existente
   continua valendo sem exceção.

4. **Dispersão.** O ensemble passa a incluir a variante de barreira quando a
   forma do mercado for essa; `sigma` continua vindo da dispersão do ensemble,
   com o mesmo piso.

5. **Registro da variante** como nova versão da família `crypto_updown` no
   catálogo, nascendo em `shadow`.

6. **Estratificação no relatório.** O relatório de calibração passa a separar
   as métricas por forma de mercado (`terminal` vs `barrier`), porque uma
   variante boa numa forma e ruim na outra precisa ser visível — e o gate
   avalia o modelo inteiro.

### Testes obrigatórios

- Parser: cada frase de barreira observada em produção classifica como
  `barrier`; cada frase terminal continua `terminal`; frases ambíguas
  continuam recusadas. Fixtures com as perguntas reais colhidas do banco.
- Mapa: `P(tocar) = 2 · P(terminal)` enquanto o dobro for < 1, e satura em 1;
  barreira acima e abaixo são espelhos; `P(tocar) ≥ P(terminal)` **sempre**.
- Toque já ocorrido ⇒ `q = 1`, e o teste prova que a detecção só olhou dados
  anteriores a `decision_ts`.
- Anti-leakage: a varredura existente continua verde com a série de toque no
  caminho.
- Determinismo: mesma entrada + mesma versão ⇒ bytes idênticos.
- Cobertura: fixture com a distribuição real de perguntas mostra a fração de
  mercados atendidos subindo, e **nenhum** mercado terminal passa a ser
  precificado pelo mapa de barreira.

### Critérios de aceite

- A fração de mercados `crypto_updown` atendidos pelo modelo sobe de forma
  mensurável (medida em produção, não estimada), sem que nenhum mercado mude de
  forma classificada.
- A variante está em `shadow`, com gate avaliado e registrado; nenhuma promoção
  automática.
- O relatório de calibração mostra as métricas separadas por forma de mercado.
- Nada fora do modelo `crypto_updown` foi alterado.

### Condições de parada

Pare se:

- a implementação precisar mudar o microprice, o intervalo, o fallback, o gate,
  o label store ou a API;
- o parser não conseguir separar as duas formas sem ambiguidade — nesse caso o
  mercado fica no baseline, e não se "escolhe a mais provável";
- surgir a proposta de promover a variante sem gate PASS porque a cobertura é
  baixa;
- a correção de discretização for tratada como obrigatória em vez de variante
  candidata a ser julgada pelo walk-forward.

---

## Estado verificado das dependências e emendas de implementação (2026-09-01)

Re-medição em produção (leitura por SSH, 2026-09-01 02:00–02:40Z) antes de
qualquer código, como o processo exige. Três premissas do texto acima mudaram
de estado; nenhuma muda o objetivo, todas mudam detalhes do desenho.

### E1 — a fonte de resolução é a Binance, não o Chainlink TWAP (premissa REFUTADA)

O texto da RFC-010 (e o cabeçalho de `crypto-updown.ts`) diz que o Chainlink
TWAP "é o feed que resolve os mercados crypto". Medido nas regras versionadas
da população atual, isso **não vale mais para nenhuma das formas dominantes**:

| Forma | Regra medida (verbatim das rule_versions) |
| ----- | ------------------------------------------ |
| terminal ("be above K on D") | "the **Binance** 1 minute candle for BTC/USDT 12:00 ET ... final **Close**" |
| barreira ("dip to K") | "any **Binance** 1 minute candle ... has a final '**Low**' price equal to or lower than" |
| updown horário ("Up or Down - 9PM ET") | "close ≥ open for the BTC/USDT **1 hour candle**" (fonte: Binance) |
| updown por faixa ("4:00PM-8:00PM ET") | **TWAP Chainlink da faixa** ≥ preço no início da faixa (único caso Chainlink — e é payoff asiático, não terminal) |

O que o recorder grava continua sendo o RTDS (twap30/twap60 Chainlink) — o
feed `spot` (Binance) está subscrito no código mas **nunca produziu uma linha**
em produção. Consequência registrada, não escondida:

- **O insumo do modelo continua sendo twap30/twap60** — é a única fonte
  gravada e as-of. "Zero basis risk" deixa de ser verdade literal; o viés vira
  parte da assunção registrada.
- Para **barreira**, a detecção de toque lê o **high/low** dos buckets de 1 min
  da série TWAP; a resolução real usa o high/low do candle Binance. O TWAP
  alisa pavios ⇒ o toque detectado/precificado é **subestimado** nas pontas,
  enquanto o monitoramento contínuo da fórmula 2·Φ **superestima**. Os dois
  vieses são registrados; quem decide se o líquido presta é o walk-forward.
- Para **updown**, strike e nível corrente saem do MESMO feed TWAP, então o
  offset estrutural Binance↔Chainlink **cancela na razão K/S**; o resíduo é o
  alisamento do TWAP contra o open/close de candle, registrado.
- A forma "updown por faixa" (TWAP da faixa vs início — payoff asiático) é
  **recusada** nesta versão e registrada como variante candidata futura.

### E2 — janelas de barreira medidas, e a derivação sem `event_start_ts`

A RFC-016 (D2) mediu que `eventStartTime` vem `null` em 100/100 mercados — não
existe coluna de início de janela. As janelas reais, medidas nas regras:

| Família de título | Janela (regra verbatim) | Derivação usada |
| ----------------- | ----------------------- | ---------------- |
| "on August 31" | "from 12:00 AM ET ... to 11:59 PM ET" (1 dia) | `windowOpens = deadline − 24 h` |
| "August 31-September 6" | idem, N dias | `windowOpens = deadline − N·24 h` |
| "in August" | o mês inteiro | `windowOpens = deadline − diasDoMês·24 h` |
| "by December 31, 2026" | aberta desde a listagem | `windowOpens = null` (aberta) |

O `deadline` vem da cadeia as-of da RFC-016 (`rule_versions.end_date`). A
subtração por dias de calendário NÃO é conservadora sozinha: na virada de
março (spring-forward) a janela ET é 1 h mais curta que N dias, e
`deadline − N·24h` cairia 1 h ANTES da abertura real — uma hora em que um
toque contaria sem pagar. Por isso toda família fechada carrega um **pad de
+1 h em direção ao deadline**: a abertura derivada nunca antecede a real, ao
custo de no máximo a primeira hora da janela em varredura e serviço. O
mercado só é servido com `decision_ts ≥ windowOpens`, e a varredura de toque
começa em `windowOpens` (janela fechada) ou no primeiro avistamento do
mercado (`polymarket_markets.received_at`, janela aberta) — nunca antes.
Título que não casa com nenhuma família ⇒ recusa (baseline), como manda a
condição de parada.

### E2b — limites registrados da varredura de toque e da calibração

- **A varredura é limitada à série carregada** (1.440 min, a mesma da
  RFC-010, como o texto original desta RFC exige). Um toque mais antigo que
  isso em mercado ainda aberto é perdido e o mercado volta ao mapa de difusão
  — direção **conservadora** (subestima q; nunca fabrica um toque). O
  resíduo é pequeno porque as regras destes mercados resolvem
  "immediately" no toque; `data_refs.touchScanBuckets` registra o que foi
  efetivamente varrido.
- **Toque observado não passa pela calibração logística.** Um toque é fato,
  não previsão; a correção da walk-forward existe para recalibrar o mapa de
  difusão e não pode rebaixar uma certeza observada. Com `calibration`
  presente, o bypass vale apenas para o caso `touchDetected`.

### E2c — o que a revisão adversarial mudou no desenho

- **Direção neutra permanece neutra.** "hit"/"touch" não ganha lado derivado
  do nível corrente: um lado re-derivado a cada ciclo **inverte** depois de um
  cruzamento (o mercado que tocou passaria a ser lido como "dip" e responderia
  "não tocou" sobre a travessia que o liquidou). O mapa precisa apenas de
  `|ln(B/S)|`; o teste de toque neutro vira **containment** do bucket
  (`low ≤ B ≤ high`), estável e sem inversão.
- **Cross-check título × deadline.** Toda família fechada confere a data final
  do título contra o ancoradouro `deadline − 12 h`; divergência ⇒ recusa. Sem
  isso, um deadline fora de família (mudança de regra, fallback date-only)
  faria a varredura inventar toque fora da janela.
- **"by" é testado por último.** Um "by" incidental num título fechado não
  pode alargar a janela para "aberta desde a listagem".
- **Formas novas exigem `rule_version` em vigor.** A aritmética da janela e o
  piso da varredura dependem do deadline as-of. O **terminal não** é gateado
  por isso — a população servida pela 1.0.0 não muda.
- **Família ambígua recusa.** "dip **below** X" (verbo de caminho, preposição
  terminal) não existe na população medida e nenhuma regra decide sua família:
  fica no baseline, conforme a condição de parada desta RFC.

### E3 — direção do toque

`reach` ⇒ `touch_up`; `dip to` ⇒ `touch_down`; `hit`/`touch` (neutros) são
resolvidos no instante da estimativa contra o nível corrente (B > S ⇒ para
cima; B < S ⇒ para baixo; B no nível ⇒ toque agora, q = 1), com a direção
resolvida gravada em `data_refs`. Preço corrente já além da barreira na
direção do payoff ⇒ toque em curso ⇒ q = 1 (janela aberta por construção,
pois o instante corrente pertence a ela).

### E4 — teto de cobertura: o RTDS só entrega BTC

Medido sobre TODA a tabela `polymarket_rtds_prices` (7 dias e histórico
integral): só existem linhas `twap30`/`twap60` de `btc/usd`. As subscrições de
eth/sol/xrp e do tópico spot estão no código do recorder e nunca renderam uma
linha. TODO mercado não-BTC continua abstendo por feed ausente — dos 82
membros crypto do universo em 2026-09-01, 58 são BTC. O teto desta RFC é a
população BTC; destravar eth/sol/xrp é investigação do recorder (RFC-007),
registrada no HANDOFF, fora deste escopo.

### E5 — entrega como versão única com a RFC-019

A variante updown (strike = preço de abertura da janela, lido do feed gravado)
é especificada pela **RFC-019** e entra na MESMA versão nova
`crypto_updown_gbm@1.1.0`, com as formas suportadas declaradas no hyperparam
imutável `forms`. Motivo: a promoção é one-active-per-category — promover um
modelo só-barreira tiraria terminal e updown do consumidor; e esta RFC já diz
que "o gate avalia o modelo inteiro". A v1.0.0 (terminal-only, `forms`
ausente ⇒ `["terminal"]`) continua em shadow, intocada, e as duas coexistem.
