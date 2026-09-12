# FIN-01 — contrato financeiro e oráculos independentes

Especificação verificada em 12/09/2026 UTC; base inspecionada
`95f752b41249cd03219c2baff3dd027873b046b9`. Escopo read-only da
[RFC-038](../../rfcs/RFC-038-contabilidade-e-risco-por-payoff.md), seções Contrato
financeiro/Persistência. **Nada abaixo está implantado por esta entrega.**
Só três documentos mudam; sem migration, dependência, servidor ou custo externo.

## 1. Unidades, dono e identidades contábeis — `financial-v2`

- Dono da subcarteira: `(account_id, strategy_id)`; posição: dono + `token_id`.
  Conta é simulação identificada; estratégia separa dinheiro dentro dela. Uma
  ordem, seus fills, saídas, fees e reservas têm exatamente esse mesmo dono.
  YES e NO são tokens distintos, ligados a condition/outcome e livro próprios.
  BUY abre token real; SELL só reduz inventário positivo disponível desse dono.
  Short legado tem quantidade negativa e fecha por BUY reduce-only/resolução.
- USD de simulação; cotas em unidades do token; preço em USD/cota. Entradas
  decimais, contas inteiras com escala `10^9`, sem float. Novas projeções guardam
  TEXT decimal canônico com nove casas e validação de formato/sinal; o cache
  antigo de seis casas permanece com sua semântica. Tabelas abaixo abreviam zeros.
- Notional `N = quantidade × preço`: quantizar uma vez ao nano-USD, empate para
  longe de zero, reaproveitando o mesmo N no cash e no PnL. Fee de evento já
  quantizada não é recalculada. Custo removido na saída parcial = basis anterior
  × fração fechada, com a mesma regra; última saída remove **todo** o resíduo.
  Divisão por zero/precisão não representável na entrada é erro explícito.
  Reserva e limite de perda arredondam para cima ao nano-USD; exibição não
  realimenta contas. Novo formato/regra exige versão nova, sem reformatar eventos.
- `B >= 0` é basis bruto da posição aberta: custo pago no long, receita inicial
  recebida no short legado; fees ficam fora de B. `Q` é assinado; `s = sign(Q)`.
  `C` é cash liquidado, incluindo receita short e fees debitadas; receita short
  tem obrigação de liquidação e não constitui capital livre. `R` é PnL realizado
  **líquido**, acumulado por evento; `F` é fee acumulada, informativa: não subtrair
  F de R novamente. `C0` é capital inicial com origem documentada, sem top-up.
- BUY: `ΔC = -N - fee`; SELL: `ΔC = +N - fee`. Abrir exposição: `ΔR = -fee`;
  fechar long: `ΔR = receita - B_removido - fee`; fechar short:
  `ΔR = B_removido - recompra - fee`. Resolução: `ΔC = Q × payout - fee`,
  `ΔR = Q × payout - sB - fee`, depois `Q = B = 0`, só para saldo ainda aberto.
- Marca executável para toda a quantidade: long vende no bid, short recompra
  no ask; `M` é valor bruto assinado dessa execução. `U = M - sB` é PnL aberto;
  `E = C + ΣM = C0 + R + ΣU`. Também `C = C0 + R - Σ(sB)` sem funding adicional.
  Marca não debita cash nem realiza PnL. Sem livro/frescor, manter quantidade,
  basis e última marca com indicador stale; equity fresca/capacidade nova ficam
  indisponíveis, nunca usar zero ou custo como prova de preço executável.
- Perda inicial = `max(0, -min_s(cashflows_brutos + payoff_s - fees))`;
  cashflows brutos são anteriores às fees, diferentes de ΔC líquido acima.
  Long custa até B; short legado deve até `|Q| - B`, antes de fees. Para a
  carteira, avaliar cash e obrigações **restantes**, R/fees já debitados e reservas
  uma única vez: perda desde C0 = `max(0, C0 - min_s(E_final_s))`. Reportar à parte
  risco residual da posição e perdas já realizadas; não somar a fee a ambos.
  Eventos independentes somam perdas. Compensar só dentro do mesmo dono/contrato
  com todos os payoffs admissíveis comprovados, incluindo resultado não coberto.
  `negRisk`, categoria ou fator isolado não provam essa compensação.
- Capital não se replica por estratégia: partições de uma mesma carteira somam
  no máximo sua alocação já autorizada. Carteiras alternativas são simulações
  distintas, nunca poder de compra agregado. Os US$1.000 das fixtures não alteram
  bankroll/caps/config atuais nem redistribuem a subcarteira fast existente.

## 2. Tempo, duplicação e transição

`event_ts` é o instante econômico comprovado (fill, fee ou liquidação efetiva),
`received_at` é ingestão; nova evidência registra também source timestamp e sua
origem, sem substituir dado ausente pelo relógio atual. Buckets UTC são intervalos
`[00:00:00Z, próxima 00:00:00Z)`; semana começa segunda-feira 00:00Z. Saída parcial
pertence ao dia do fill, fee ao evento que a debita, resolução somente ao saldo
remanescente. Horário de fechamento do mercado não é liquidação efetiva.

Replay v2 ordena `(event_ts, idempotency_key)` como desempate estável, valida a
causalidade (aceite antes de fill, fechamento antes de resolução) e deduplica a
chave original por dono/versão. Chave repetida com conteúdo/dono divergente é erro,
nunca segundo pagamento. Chegada atrasada invalida/reconstrói projeção e buckets
afetados desde o evento econômico, sem reescrever ledger ou mover lucro para a
ingestão. Marca, retry, restart e pedidos de cancelamento não realizam nada.

Eventos legados conservam bytes e leitura `ledger-v1` (basis positivo para ambos
os sinais, saída de seis casas). `financial-v2` mede também shorts; divergência
v1/v2 é discriminada por dono, evento, precisão e regra, sem tolerância arbitrária.
Sem prova de atribuição, usar `(legacy_unattributed, unknown)`, nunca BTC/main por
omissão; capital inicial desconhecido fica NULL, bloqueando equity absoluta e
admissão, mas cashflows/PnL/obrigações continuam mensuráveis. `strategy_id IS NULL`
sozinho não prova dono. Prova forte inclui cadeia ordem/decisão/config imutável;
o `strategy_id` fast existente é evidência de estratégia, não de capital inicial.
Reconhecer atribuição depois exige nova versão auditada com referência à anterior;
não altera eventos, transfere dinheiro ou soma duas versões simultaneamente.

## 3. Menor esquema aditivo proposto (nomes ainda inexistentes)

Quatro tabelas em FIN-02; uma adicional só em FIN-05. Sem alterar 0008/0020 ou
numerar migration agora. Atribuições append-only evitam alterar ledger/ordens
históricos; cache novo impede que dois donos compartilhem a PK antiga por token.

| Tabela proposta | Colunas/constraints mínimas e papel |
| --- | --- |
| `paper_financial_owners` | PK `(account_id, strategy_id)`; `initial_cash_usd` (NULL só desconhecido), `capital_source_ref`, `created_at`, `ownership_version`. Origem/alocação imutáveis, sem seed automático de US$1.000 por linha; linha também serve de lock por dono. |
| `paper_order_owners` | PK `(order_id, ownership_version)`, FK ordem/dono; `account_id`, `strategy_id`, `attribution_status` (`verified`/`unknown`), `evidence_ref`, `supersedes_version`, `recorded_at`. Um dono por ordem na versão selecionada; token/condition/side/size vêm da ordem original e são validados, não copiados como nova autoridade. |
| `paper_ledger_owners` | PK `(event_id, ownership_version, account_id, strategy_id)`; FKs evento/dono; `attribution_status`, `evidence_ref`, `supersedes_version`, `recorded_at`. Evento de ordem: exatamente um dono igual ao de `paper_order_owners`; evento global de token: uma associação por dono afetado. Índice `(account_id, strategy_id, event_id)`; timestamps econômicos/token vêm do evento imutável. |
| `paper_owner_positions` | PK `(account_id, strategy_id, token_id, ownership_version, accounting_version)`; FK dono; `condition_id`, `outcome`, `shares`, `cost_basis_usd`, `realized_pnl_usd`, `fees_paid_usd`, `opened_at`, `resolved_at`, `mark_value_signed_usd`, `mark_stale`, `mark_source_ts`, `mark_received_at`, `last_event_id`, `updated_at`. Cache reconstruível, versões nunca agregadas entre si; posições zeradas conservam R/F. |
| `paper_order_reservations` (FIN-05) | PK `order_id` (uma encarnação; IDs não reutilizados), FK atribuição de ordem; dono/versão iguais; `reservation_version`, `cash_remaining_usd`, `risk_remaining_usd`, `shares_remaining`, `state`, `last_event_id`, `updated_at`. Projeção reconstruída de aceites/fills/cancelamentos/expirações imutáveis, sem segunda fonte monetária. |

Sem tabela duplicada de wallet/PnL diário no mínimo: derive cash de C0/R/basis e
buckets do fold dos eventos atribuídos. Um cache agregado futuro só se medição
justificar. `last_event_id` é watermark de ingestão, não ordenação econômica:
evento tardio força reconstrução. `accounting_version`, `ownership_version` e
versão de reserva são seleções explícitas dos leitores; não trocar runtime para
um cache vazio. Payload v2 de novos eventos identifica `financial_version`,
`source_event_ts`/origem, condição/outcome comprovados e cash/fee efetivos quando
não deriváveis sem ambiguidade; fills distinguem fee incluída e fee separada pelo
mesmo `fee_id` econômico. Uma fee separada exige evento financeiro dedicado sob
contrato aditivo futuro, nunca um segundo débito do fee já incluído no fill.

Aceite novo grava ordem + dono + evento + atribuição na mesma transação; fill
insere evento/atribuição e atualiza projeções só se evento novo. Resolução atual
é global por token e sem `order_id`: associar a todos os donos com saldo econômico
aberto naquele instante e aplicar payout ao saldo de cada um (inclusive legado).
Não exigir net token diferente de zero: long de A e short legado de B não somem.
Não repartir o mesmo fill nem multiplicar fee global pelo número de donos; fee
comum precisa atribuição monetária comprovada e soma exata, senão fica pendente.
Marcas também alcançam cada dono; eventos globais de kill switch são diagnóstico,
sem dono monetário inventado. Correção de versão aponta evidência/supersessão,
preserva a anterior e é selecionada atomicamente, nunca via UPDATE de atribuição.

Reserva futura trava o dono e o inventário da ordem, respeitando a ordem global
de locks já usada pelo broker (kill switch/token), sem inversão. Mesma transação
confere cash livre, caps/perda e inventário, grava aceite/reserva. Cash reservado
não é gasto nem PnL; risco/cash são restrições paralelas, não dois débitos.
Fill parcial converte só a fração executada em cash/posição e recalcula saldo
conservador; cancel_requested retém tudo até cancel_effective. Expiração efetiva
libera saldo; retry/restart não liberam nem recriam verba. Resolução liquida cada
dono e encerra reservas de ordens invalidadas na mesma fronteira transacional.

| Consumidor necessário (plano pela RFC; prompts posteriores não lidos) | Responsabilidade |
| --- | --- |
| FIN-02 — escrita do broker/ledger e registro de ordens | Migration aditiva; atribuição atômica de todos os produtores, backfill por associação comprovada, desconhecidos explícitos; manter leitores antigos compatíveis. |
| FIN-03 — `applyFill`/`replayLedger`, `refreshPosition`, `loadPaperPnl` | Fold/cash/equity por dono; cache v2 e PnL por tempo econômico. API paper, performance, gates, runner de saída e fast wallet precisam da mesma seleção de dono/versão; não usar cache token-only para novas decisões. |
| FIN-04 — `bucketWorstCase`/`computeExposures`, caps e sizing | Payoffs assinados e soma conservadora, risco residual/fees sem duplicação. |
| FIN-05 — aceite, cancelamento, fill, expiração, settlement/restart | Reserva atômica reconstruível; lock por dono e inventário, zero overspend/oversell. |
| FIN-06 — entrada/saída, fast policy, decisão→ordem→fill | BUY do token real e SELL limitado ao dono; conservar bloqueios existentes até todos os leitores estarem prontos. |
| FIN-07 / QA-01 — reconciliação e harness PostgreSQL | Consumir estes oráculos; provar isolamento, rollback, concorrência real e igualdade evento/cache/agregados na versão escolhida. Não executados por FIN-01. |

## 4. Fixtures manuais (oráculo; nenhum resultado extraído de `replayLedger`)

Cada cenário recomeça com seu C0 declarado. Datas e nomes são sintéticos; fees
são valores de fixture, não tabela atual de taxas da venue. Salvo menção, fee=0,
marcas executáveis com profundidade suficiente e recebimento = timestamp UTC.
Colunas C/B/R/U/E em USD, Q em cotas; F é fee acumulada. Fórmulas acima explicam
cada transição. Aceite/cancelamento sem fill só mudam reservas.

### F1 — short legado, C0=1.000; token YES-L, dono legado conhecido

| Evento UTC em 2026-09-12 | C | Q | B | R | U | E |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10:00:00Z estado inicial | 1000 | 0 | 0 | 0 | 0 | 1000 |
| 10:01:00Z SELL legado 10 × 0,40; ask=0,40 | 1004 | -10 | 4 | 0 | 0 | 1000 |
| 10:02:00Z ask=0,50 | 1004 | -10 | 4 | 0 | -1 | 999 |
| 10:03:00Z BUY reduce-only 4 × 0,50 | 1002 | -6 | 2,40 | -0,40 | -0,60 | 999 |
| 11:00:00Z resolução YES-L=1 | 996 | 0 | 0 | -4 | 0 | 996 |

Inicial: cashflow +4 e obrigação -10 ⇒ perda 6, não 4. Na marca, M=-5 e
U=-5-(-4)=-1. Após recompra, risco residual=6-2,40=3,60; perda desde C0 no pior
payoff=0,40+3,60=4. Não aceitar nova abertura short no contrato v2.

### F2 — token NO real, C0=1.000; dono N

| Evento UTC em 2026-09-12 | C | Q(NO) | B | R | U | E |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 12:00:00Z inicial | 1000 | 0 | 0 | 0 | 0 | 1000 |
| 12:01:00Z BUY 10 NO × 0,60; bid NO=0,60 | 994 | 10 | 6 | 0 | 0 | 1000 |
| 12:02:00Z bid NO=0,50 | 994 | 10 | 6 | 0 | -1 | 999 |
| 13:00:00Z resolução NO=0 | 994 | 0 | 0 | -6 | 0 | 994 |

Risco inicial 6; o cenário alternativo NO=1 pagaria 10 e terminaria C=1004/R=4.
Q(YES)=0 em todos os passos: comprar NO não registra SELL de YES.

### F3 — contratos independentes X/Y, C0=1.000; mesmo dono

| Evento UTC em 2026-09-12 | C | QX / QY | BX / BY | R | U | E |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| 14:00:00Z inicial | 1000 | 0 / 0 | 0 / 0 | 0 | 0 | 1000 |
| 14:01:00Z BUY X:100 × 0,30; bid=entrada | 970 | 100 / 0 | 30 / 0 | 0 | 0 | 1000 |
| 14:02:00Z BUY Y:100 × 0,40; bids=entradas | 930 | 100 / 100 | 30 / 40 | 0 | 0 | 1000 |
| 15:00:00Z X=0 resolvido; Y ainda bid=0,40 | 930 | 0 / 100 | 0 / 40 | -30 | 0 | 970 |
| 15:01:00Z Y=0 resolvido | 930 | 0 / 0 | 0 / 0 | -70 | 0 | 930 |

Payoffs admissíveis `(X,Y)`: `(0,0)`, `(1,0)`, `(0,1)`, `(1,1)` ⇒ PnL terminal
`-70, +30, +30, +130`. Perda máxima=70, inclusive sob categoria/fator iguais;
`max(30,40)=40` é incorreto. Mesmo conjunto incompleto de pernas exclusivas não
autoriza eliminar cenário em que vence uma perna não possuída.

### F4 — dois donos no mesmo token T; C0(A)=500 e C0(B)=500

Estado escrito como `C; Q; B; R; F`. A/B são subcarteiras de uma conta sintética;
sua soma inicial é 1.000. Para comparar E entre linhas, bid de T=0,50 após fills
(os fills têm sua evidência de execução própria); U(A/B) = `Q × 0,50 - B`.

| Evento econômico UTC | A: C; Q; B; R; F | B: C; Q; B; R; F | U(A/B); E total |
| --- | --- | --- | --- |
| 2026-09-12T23:57:00Z inicial | 500; 0; 0; 0; 0 | 500; 0; 0; 0; 0 | 0/0; 1000 |
| 2026-09-12T23:58:00Z a1 BUY10 × 0,40, fee 0,10 | 495,90; 10; 4; -0,10; 0,10 | 500; 0; 0; 0; 0 | 1/0; 1000,90 |
| 2026-09-12T23:58:30Z b1 BUY5 × 0,60, fee 0,05 | 495,90; 10; 4; -0,10; 0,10 | 496,95; 5; 3; -0,05; 0,05 | 1/-0,50; 1000,35 |
| 2026-09-12T23:59:59.900Z a2 SELL4 × 0,70, fee 0,04 | 498,66; 6; 2,40; 1,06; 0,14 | 496,95; 5; 3; -0,05; 0,05 | 0,60/-0,50; 1001,11 |
| 2026-09-13T00:00:00.200Z recebido retry idêntico a2 (mesmo event_ts) | 498,66; 6; 2,40; 1,06; 0,14 | 496,95; 5; 3; -0,05; 0,05 | 0,60/-0,50; 1001,11 |
| 2026-09-13T00:05:00Z r1 resolução T=1, fee 0 | 504,66; 0; 0; 4,66; 0,14 | 501,95; 0; 0; 1,95; 0,05 | 0/0; 1006,61 |
| 2026-09-13T00:06:00Z retry r1 + restart | 504,66; 0; 0; 4,66; 0,14 | 501,95; 0; 0; 1,95; 0,05 | 0/0; 1006,61 |

a2: receita 2,80, basis removido 1,60, lucro bruto 1,20; ΔR=1,16 e ΔC=2,76.
Dia 12: R(A)=1,06, R(B)=-0,05, agregado=1,01. Dia 13: somente 3,60+2=5,60.
Total R=6,61, F=0,19 (já dentro de R), cash=1006,61. Agregar antes de atribuir
misturaria bases de entrada e distribuiria o lucro incorretamente. Variante de
chegada: a2 é recebido pela primeira vez em 00:00:00.100Z; os mesmos deltas
pertencem ao dia 12, inclusive quando recebido depois de r1 e reconstruído.

### F5 — duas ordens simultâneas, C0=1.000 de um único dono W

O1 BUY1200 cotas de U a 0,50 exige reserva 600; O2 BUY1000 de V a 0,50 exige 500.
Fees=0, bids=0,50. As submissões têm `2026-09-12T16:00:00Z`; nesta execução O1
ganha o lock. Se O2 ganhar, reserva 500 e O1 é recusada (nunca aceitar ambas).
`H` = cash reservado; `L` = risco posição + risco reservado; `A = C - H` aqui,
onde não há short legado. R=U=0 e E=1000 em todas as linhas.

| Passo UTC em 2026-09-12 | C | Q(U/V) | B(U/V) | H | A | L |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| 15:59:59Z inicial | 1000 | 0/0 | 0/0 | 0 | 1000 | 0 |
| 16:00:00Z O1 aceita | 1000 | 0/0 | 0/0 | 600 | 400 | 600 |
| 16:00:00Z O2 rejeitada após lock | 1000 | 0/0 | 0/0 | 600 | 400 | 600 |
| 16:00:01Z retry aceite O1 | 1000 | 0/0 | 0/0 | 600 | 400 | 600 |
| 16:01:00Z f1 fill O1 400 × 0,50 | 800 | 400/0 | 200/0 | 400 | 400 | 600 |
| 16:01:01Z retry f1 + restart | 800 | 400/0 | 200/0 | 400 | 400 | 600 |
| 16:02:00Z cancel_requested O1 | 800 | 400/0 | 200/0 | 400 | 400 | 600 |
| 16:02:01Z cancel_effective O1 | 800 | 400/0 | 200/0 | 0 | 800 | 200 |
| 16:03:00Z O3 nova ordem BUY1000 V × 0,50 aceita | 800 | 400/0 | 200/0 | 500 | 300 | 700 |
| 16:04:00Z expiração efetiva O3, sem fill | 800 | 400/0 | 200/0 | 0 | 800 | 200 |
| 16:04:01Z retry expiração + restart | 800 | 400/0 | 200/0 | 0 | 800 | 200 |

Risco e cash reservados simultaneamente não reduzem E duas vezes. Com fee
máxima f, reservar `N+f`; no fill debitar fee efetiva uma vez e reter o teto da
parte não executada. Sem teto comprovado de fee, não admitir a ordem. Pedido de
cancelamento ou expiração apenas prevista não antecipa capacidade de O3.
Variante inventário no estado final: reservar SELL300 U deixa só 100 U livres;
SELL200 concorrente é recusada. Cash800/Q400/B200/R0/E1000 não mudam; pedido
de cancelamento mantém 300 reservadas, cancelamento efetivo libera as 300.

### F6 — resíduo de arredondamento e marca ausente

Em 2026-09-12T17:00:00Z, C0=10; BUY1 × 0,30 e BUY2 × 0,35, fee0, dão C=9,
Q=3, B=1, R=0. Bid=0,40 ⇒ U=0,20 e E=10,20. Três SELL1 × 0,40 em 17:01/02/03Z
removem B=`0,333333333; 0,333333334; 0,333333333`: a segunda remoção usa a fração
do basis **remanescente**, `0,666666667/2 = 0,3333333335`, arredondada para cima.
Estados sucessivos `C/Q/B/R`: `9,40/2/0,666666667/0,066666667`,
`9,80/1/0,333333333/0,133333333`, `10,20/0/0/0,20`.
Não arredondar a média uma vez e perder resíduo; E=10,20 nas três saídas.
No estado Q=3, retirar a marca preserva C9/Q3/B1/R0, mas U/E frescos são
indisponíveis; nenhuma nova capacidade é inferida. Empates: `±0,0000000005`
quantizam a `±0,000000001`; reserva positiva `0,0000000001` sobe para `0,000000001`.

## 5. Símbolos confirmados e divergências na base

| Local inspecionado | Fato observado e limite para continuidade |
| --- | --- |
| `paper/ledger.ts:117 applyFill` | Já distingue fechamento long/short e acumula fees; permite abrir/cross-zero sintético. Basis é magnitude positiva. Não atribui dono nem cash explícito. |
| `paper/ledger.ts:177 replayLedger` | Map por token; ordena event_ts/chave, deduplica, resolve short com sinal correto e subtrai fees uma vez na saída. Não produz buckets de realização; resultados de seis casas podem ocultar resíduo de nove. Não foi usado como oráculo. |
| `portfolio/exitstore.ts:176 loadPaperPnl` | Lê cache token-only, dia/semana por resolved_at; fallback de marca para custo. Posição Q=0 sem resolved_at pode ser excluída mesmo com saída/fee realizada. Contrato exige tempo do evento e pendência de marca explícita. |
| `portfolio/exposure.ts:114 bucketWorstCase` | Usa maxLeg quando qualquer perna é negRisk e count>1; acumula costScaled como risco, inclusive dimensões amplas. Não prova cenários e não mede obrigação do short. |
| `0008_polymarket_paper_broker.sql` | Ledger com trigger anti UPDATE/DELETE e chave idempotente; cache PK token; event_ts/received_at existentes. Não reescrever migration. |
| `0020_fast_strategy_registry.sql` | paper_orders.strategy_id associado estritamente à source fast; fast_wallet_state é por estratégia, não dono/token. NULL histórico preservado; não relaxar constraint para inventar atribuição. |

Leitura adicional indispensável: `fundamental/fixed.ts` confirma escala9,
mul/div half-away e saída truncada; `paper/brokerstore.ts` confirma aceite em
transação, refresh por token e resolução sem order_id com eventTs=now;
`paper/fastpolicy.ts` mantém veto de colisão com carteira principal. Esses fatos
são do código, não observações produtivas. Inventário por `rg` localizou ainda
API, performance, gatestore e portfolio runner como consumidores a migrar.

## 6. Verificação e entrega

Fixtures foram derivadas das fórmulas e submetidas a revisão aritmética
independente. Em 12/09/2026 UTC, `python3 /private/tmp/fin01-financial-check.py`
(auditor temporário, Python 3.9.6/Decimal, sem importar aplicação) passou seis
grupos F1–F6: identidades C/E das tabelas, risco, fees/buckets, invariantes de
reservas e quantização. Não são seis testes do runtime nem SQL; as equações e
estados acima são o oráculo permanente, independente desse auditor local.
Verificações de diff/segredos, PR/checks e dispensa de deploy são
registrados no [recibo](../receipts/FIN-01.md) e no PR; teste previsto não é teste
passado. SQL real/concorrência/runtime permanecem para seus blocos: estes exemplos
não provam execução. FIN-02 tem contrato e nomes propostos; QA-01 recebe os mesmos
oráculos sem ser executado aqui. Nenhuma decisão de capital/live foi reaberta.
