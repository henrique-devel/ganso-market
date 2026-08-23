# RFC-014 — Polymarket: variante de primeira passagem (mercados de barreira)

**Status:** draft
**Dependências:** RFC-010 (modelo fundamental: microprice, intervalo, fallback, label store, walk-forward e gate já implementados e ativos)
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
