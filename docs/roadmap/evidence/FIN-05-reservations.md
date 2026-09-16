# FIN-05 — reservas atômicas por dono

Base integrada: `ae33084e1242fbb649b38341e875bf7b0ecca6a4` (FIN-04 e recibo).
Migration conferida em main: **0025_paper_order_reservations.sql**, única migration
aditiva deste bloco. Tabela proposta em FIN-01: `paper_order_reservations`.
Não aloca capital, altera caps, reescreve ledger nem modifica prazos de validade.

## Contrato para EXEC-03/04

- `reserveOrder(tx, orderId, now)` retorna o contrato `reservation-v1` após
  verificar a ordem e sua atribuição ownership-v1, reconstruir financial-v2 e
  comparar cash disponível, risco payoff-v1 e inventário do mesmo dono.
  O chamador deve usar a transação de aceite; o broker faz INSERT da ordem,
  reserva e append do aceite antes de COMMIT. Falha desfaz todos esses efeitos.
- O contrato é gravado no payload imutável `order_accepted.reservation`:
  dono, versões, preço máximo/mínimo, fee máxima por cota, cash/risco por cota,
  lado do inventário e hashes de config/fatores/léxico. A tabela é projeção.
- **Consume:** `appendLedgerEvent(tx, fill)` valida preço, quantidade, fee,
  tempo econômico e saldo restante. O trigger transfere somente as cotas
  executadas; o restante é arredondado para cima em nano-USD. Cashflows usam
  a mesma quantização de FIN-03; uma checagem SQL final impede consumir cash
  necessário à reserva restante, inclusive em frações de nano-USD.
- **Release:** append de `cancel_effective` ou `expired` libera somente o
  restante. `cancel_requested` não libera nada. O broker continua processando
  trades até seu limite efetivo existente; este bloco não redefine esse limite.
  Resolução libera reservas da condição invalidada e liquida por dono/token.
- Fill e cancelamento concorrentes obedecem o lock transacional: fill que
  vence é consumido antes do release; cancelamento efetivo que vence impede
  novo fill, inclusive retrodatado. Retry idêntico do fill original é no-op.
  Resolução anterior a um fill reservado já registrado é recusada.
- `reconcileReservations(tx, {accountId,strategyId})` chama
  `paper_reconcile_reservations`: reconstrói de aceites/fills/eventos efetivos,
  sem confiar em `status`, `filled_size`, processo vivo ou passagem do relógio.
  A admissão também reconcilia sob lock. Repetição mantém valores e watermark.
- O retry do aceite compara o pedido JSON imutável completo, conserva o
  `acceptedAt` original e não cria nova ordem nem estende GTD. O conflito de
  INSERT concorrente consulta o vencedor. Pedido divergente é recusado.

## Locks, dinheiro e compatibilidade

Ordem do broker: journal → runtime → policy → kill → ordem → token → dono.
O dono usa `FOR NO KEY UPDATE` em `paper_financial_owners`: serializa mudanças
financeiras sem disputar os locks KEY SHARE dos FKs de atribuição. Cancelamento
em lote/settlement obtêm todos os tokens antes do primeiro dono. Resoluções
travam os donos em ordem determinística. Escritores financeiros do ledger,
inclusive legados, participam do lock pelo trigger após os locks de FIN-02.

`C = C0 + cashflows`; `disponível = C − H`; para longs,
`disponível + H + basis = C0 + R líquido`. Para shorts legados, usar basis
assinado nessa identidade; risco residual continua uma restrição separada.
Reserva não é despesa/PnL e cash e risco não são dois débitos.
BUY reserva preço-limite efetivo + teto de fee. Para taker, o contrato paper
existente `rate × p × (1−p)` é limitado por `rate/4`; fee desconhecida recusa.
Maker paper declara zero. Fee efetiva entra uma vez no cash/R; a projeção retém
apenas o teto das cotas restantes. Risco já transferido à posição não duplica.

Caps conservam valores e dimensão de FIN-04; denominador `C0 + R líquido`.
API/paper recebem os mesmos arquivos somente leitura usados pelo portfolio.
Não há prova nova de compensação entre cenários, nem novo cap total.
SELL reserva inventário positivo; BUY que fecha short legado reserva o
inventário negativo redutível, sem atravessar zero. Identidade/versão de dono
é conferida por FK e trigger; outro dono nunca fornece esse inventário.

Capital NULL não vira US$1.000 por inferência: nova admissão é recusada.
Ordens históricas sem contrato não ganham reservas fabricadas. Se uma delas
estiver aberta, nova admissão desse dono recusa `FIN05_UNRESERVED_OPEN_ORDER`.
O caminho de ledger legado permanece compatível; a garantia de nova admissão
vale para o broker FIN-05. Operar simultaneamente produtores antigos de aceite
não constitui aceite financeiro integrado. Reinícios não liberam reservas.

## Evidência local

PostgreSQL **18.4**, banco descartável exclusivo `fin05_test`, schemas isolados,
migrations 0001–0025 reais e guards ativos; nenhum banco produtivo usado.
Com `GANSO_TEST_DATABASE_URL` apontando para esse banco:

```sh
npm test --workspace @ganso-market/api -- \
  test/polymarket/paper/reservations.pg.test.ts \
  test/polymarket/paper/financial.pg.test.ts \
  test/polymarket/paper/ownership.pg.test.ts \
  test/polymarket/paper/brokerstore.test.ts \
  test/polymarket/paper/api.test.ts \
  test/polymarket/paper/enforcement.test.ts \
  test/polymarket/portfolio/exposure.test.ts --no-file-parallelism
```

**237 passed / zero skipped**, incluindo **45 PostgreSQL** (19 FIN-05).
US$600 + US$500 contra US$1.000: duas conexões, vencedor retido antes do COMMIT,
segundo backend observado em `pg_stat_activity.wait_event_type='Lock'`;
uma recusa e somente US$600 ou US$500 reservados, nas duas ordens de chegada.
Oráculos incluem risco compartilhado, duas saídas, donos distintos no mesmo
token, BUY de short legado, conflito de conta, fee, rollback de aceite/fill,
retry concorrente do broker real, fill/cancel nas duas ordens, GTD, resolução,
reconstrução da projeção alterada, nanos e transferência sem duplicar exposição.
As suítes unitárias de broker/rotas isolam `reserveOrder`; não provam SQL.

Gates, SHA e publicação: [recibo FIN-05](../receipts/FIN-05.md).
Sem benchmark de throughput, reconciliação produtiva, soak ou ativação live.
EXEC-03/04 recebem o contrato acima; nenhum próximo bloco foi executado.

## Limite de revisão automática

Uma guarda adicional para recusar aceites de binários antigos após a migration
foi recusada pela revisão automática por impacto não autorizado em rolling
deploy. Ela **não foi aplicada**. O caminho compatível descrito acima foi
mantido e testado; nenhuma alternativa foi usada para impor essa guarda.
