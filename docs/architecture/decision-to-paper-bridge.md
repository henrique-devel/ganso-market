# Onde mora a ponte decisão → ordem de paper (recomendação)

- Data: 2026-08-27
- Estado: **recomendação de desenho, não implementada**. Escrita a pedido do
  proprietário como decisão de projeto antes de virar código.
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

## Recomendação

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

## Estado

Recomendação escrita, **nenhuma linha implementada**. Implementar é um PR
pequeno (migration 0015, um job no runner do paper, um carimbo no ciclo do
portfolio, testes dos dois lados) e está fora do escopo do PR que fechou as
degenerações de G2/G3/G4 e o registro do G6.
