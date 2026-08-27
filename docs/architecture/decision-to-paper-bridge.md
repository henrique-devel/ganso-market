# Onde mora a ponte decisão → ordem de paper

- Data: 2026-08-27
- Estado: **implementada em 2026-08-27** (migration 0015, job `bridge` no runner
  do paper, carimbo no ciclo do portfolio). O desenho abaixo é o que foi
  construído; as duas adições que ele não previa estão na seção "O que a
  implementação acrescentou". Escrita antes como decisão de projeto, a pedido do
  proprietário.
- **SIMULAÇÃO — SEM EXECUÇÃO REAL.** Nada aqui cria ordem real, wallet, signer
  ou credencial de trading. A ponte descrita liga um motor de decisão a um
  simulador; a execução real continua sendo escopo exclusivo da RFC-009, atrás
  dos gates G1–G6.

## O problema, em uma frase

O motor de portfólio grava decisões `ENTRY`/`ACCEPTED` em
`portfolio_decisions`; o paper broker cria posições a partir de um endpoint
HTTP que **ninguém chama**. A coluna `paper_order_id` da migration 0014 existe
para amarrar as duas coisas — "set once the paper broker accepted an order for
this decision" — e nunca é preenchida.

Consequência medida em produção (2026-08-26): **2 entradas ACEITAS, 0 posições
criadas**. Sem essa ponte, `paper_positions` nunca ganha linha, nenhuma posição
fecha, e **G2, G3 e G4 ficam em `INSUFFICIENT_DATA` para sempre** — não por
falta de tempo, e sim por falta de caminho. É um gargalo maior que a ausência
de modelo promovido na RFC-010: mesmo com um modelo promovido, sem a ponte nada
chega ao paper.

## O desenho

**O decision log é o outbox. O consumidor mora no módulo `paper`. Nenhum dos
dois módulos escreve na tabela do outro.**

```
portfolio (decide)            paper (executa a simulação)
──────────────────            ───────────────────────────
portfolio_decisions  ──lê──▶  job `bridge` (30 s)
  ENTRY / ACCEPTED               ├─ revalida frescor
  paper_order_id NULL            ├─ decideOrderType(...)   ← mesma política
       ▲                         └─ acceptPaperOrder(...)  ← mesmo broker
       │                                    │
       │                                    ▼
       └──── job `panel` carimba ──── paper_orders.decision_id
             paper_order_id                 (a chave viaja com a ordem)
```

Quatro pontos, e o terceiro é o que faz o desenho funcionar:

1. **Nada muda no módulo `portfolio`.** A decisão `ACCEPTED` já carrega tudo o
   que a ordem precisa — token, lado, tamanho, `q`, `q_lo`, versão de config e
   o instante exato. Ela **é** o outbox, durável e imutável, e o guard de
   escopo do módulo continua proibindo qualquer caminho de ordem.
2. **O consumidor é um job novo no `paper/runner.ts`**, a cada 30 s: lê
   `portfolio_decisions` (somente leitura numa tabela `portfolio_*`),
   revalida o frescor por conta própria — uma decisão mais velha que o limite
   de staleness do book é descartada com motivo logado, nunca ressuscitada — e
   chama **em processo** o mesmo par `decideOrderType` + `acceptPaperOrder` que
   o `POST /polymarket/paper/intents` já usa.
3. **A chave de junção viaja com a ordem**: `paper_orders.decision_id`. O
   carimbo de volta em `portfolio_decisions.paper_order_id` é feito pelo
   **próprio módulo portfolio**, no ciclo seguinte, lendo `paper_orders` (só
   leitura) e atualizando a sua própria tabela. Assim nenhum módulo escreve
   fora do seu namespace e os dois guards de escopo continuam exatamente tão
   estritos quanto são hoje — nenhuma exceção precisa ser aberta em nenhum dos
   dois.
4. **Idempotência pela chave do ledger**: a ordem entra com chave derivada da
   decisão (`portfolio:<decision_id>`), então uma queda entre aceitar e
   carimbar não duplica ordem. O carimbo é reconciliação pura e pode rodar
   quantas vezes for.

### O que isso custa

- **Migration 0015** (a 0014 não é tocada): `paper_orders.source` ganha
  `'portfolio'` no CHECK — hoje é `('manual','intent')` — e a coluna
  `decision_id BIGINT` com índice. Nada mais.
- **Zero container novo**, zero RAM nova, zero superfície nova no perímetro: o
  job entra no `polymarket-paper`, que já existe e já roda.
- Um job supervisionado a mais no runner do paper, com o mesmo padrão de
  `JOB_STILL_RUNNING` / `JOB_FAILED` dos outros.

### Por que não as alternativas

| Alternativa                            | Por que não                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dentro do módulo `portfolio`           | O guard de escopo proíbe escrever fora de `portfolio_*` **e** proíbe qualquer caminho de ordem. Afrouxar o guard para construir a ponte apaga exatamente a invariante que a RFC protege.                  |
| Um terceiro serviço "bridge"           | Mais um container e mais uma fatia de um orçamento de memória do Compose que já está inteiramente alocado, mais um boot e mais um modo de falha — para um job que é uma consulta e uma chamada de função. |
| Chamada HTTP do portfolio para o paper | Exige `fetch` num módulo cujo guard proíbe rede de saída, e um token de auth dentro do processo do portfolio. Duas invariantes quebradas para evitar uma chamada em processo.                             |
| Portfolio escrevendo `paper_orders`    | Fila passiva, latência, degradação de fill e ledger vivem atrás de `acceptPaperOrder`. Um segundo escritor seria um segundo simulador, menos conservador que o primeiro.                                  |

### O que a ponte NÃO faz

- Não afrouxa gate nenhum. Ela produz **dado**; os gates continuam medindo o
  que sempre mediram, e G2 continua exigindo 60 dias, 100 posições fechadas,
  30 mercados, 2 categorias, dispersão e um intervalo que sobrevive ao haircut
  de 50%.
- Não cria ordem real. `execution_mode` continua `paper` e o banner continua em
  toda superfície.
- Não muda o veredito de hoje: no primeiro dia depois da ponte, G2 sai de
  "nenhuma posição jamais" para "posições demais de menos", que é o mesmo
  `INSUFFICIENT_DATA` com números diferentes. A diferença é que a partir daí
  ele **anda**.

### Detalhe que precisa ficar escrito

A quota do decision log (~3 dias medidos, contra um TTL de 180) não ameaça a
ponte, que consome em 30 s. Mas ela é a razão de a chave viajar com a **ordem**
e não só com a decisão: `paper_orders` não está nessa quota, então o registro
de o que foi enviado sobrevive à poda do que foi decidido.

## O que a implementação acrescentou (2026-08-27)

Duas coisas que o desenho não previa, e uma correção de detalhe.

**1. A provenance da entrada, carimbada na tabela `portfolio_position_entries`.**
Decisão do proprietário do mesmo dia (item 1 da seção de calibração no handoff):
o ciclo de saída lê a decisão de **entrada** para comparar hoje contra o que a
entrada se comprometeu a acreditar, e o decision log é podado pela quota em ~3
dias. Toda posição segurada mais que isso perdia a própria tese, e quatro dos
sete critérios de saída ficavam inertes em silêncio. A ponte é o único lugar onde
a posição nasce, então é onde o carimbo custa menos: `stampBridgedOrders` grava a
tese numa tabela `protected`, nunca podada, e `entryProvenanceFor` lê dela
primeiro e cai para o log só para entradas anteriores à ponte. Há teste contra
PostgreSQL real que **apaga a linha de decisão** — o que a quota faz — e exige
que a provenance continue completa.

**2. O limite conservador troca de ponta com a perna.** O motor modela a perna NO
como **venda** do token afirmativo, então toda decisão nomeia o token afirmativo
e `order_side` carrega a perna. A ponte passa `q_lo` para uma compra e `q_hi`
para uma venda: na venda o caso pessimista é a probabilidade ser **alta**, e
passar `q_lo` ali seria entregar à política o limite otimista com o nome do
conservador — o ramo taker (`edge = worst − qLo`) leria lucro que o intervalo não
sustenta. Verificado contra PostgreSQL real: a mesma perna YES vira FAK
(`TAKER_EDGE_EXCEEDS_FEE`) e a perna NO, no mesmo livro, **não** vira taker.

**3. Decisão velha é descartada, não enfileirada.** A janela de frescor (30 s, o
mesmo limite que o endpoint de intents aplica ao livro) entra na **consulta**: a
ponte só vê decisões dentro dela. As que passaram são contadas e logadas
(`aged_out` no `BRIDGE_TICK`, em `warn`) em vez de executadas tarde contra um
livro que já andou. Um `aged_out` diferente de zero é falha operacional — ciclo
travado, tick lento —, não condição de mercado.

## Estado

Implementada. Migration 0015 acrescenta `paper_orders.decision_id` (com índice
único parcial, que é a idempotência da ponte no banco), `'portfolio'` no CHECK de
`source`, um CHECK que exige decisão **se e somente se** a fonte é `portfolio`,
o índice parcial da fila de trabalho e a tabela `portfolio_position_entries`
(imutável por trigger). A 0014 não foi tocada. Evidência de verificação em
[`docs/test-results/RFC-013-portfolio-engine.md`](../test-results/RFC-013-portfolio-engine.md).
