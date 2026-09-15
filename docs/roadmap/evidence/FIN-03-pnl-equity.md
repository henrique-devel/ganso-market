# FIN-03 — PnL e equity por dono

Base pública: `c1976da867478cf42372669596cc544e3eb3c7d0` (FIN-02).
Escopo exclusivo: RFC-038, contrato financeiro e oráculos FIN-01. Sem migration.

## Contrato entregue

`financial.ts` seleciona ownership v1 e produz `financial-v2`, com nove casas,
por `(account_id, strategy_id, token_id)`. O resultado mantém R líquido, fees
informativas, cashflow, basis positivo e quantidade assinada. Agregados monetários
somam donos; equity de simulações diferentes não vira poder de compra conjunto.

Cada fill quantiza seu notional uma vez. Saída parcial remove a fração do basis
remanescente, arredondada half-away; saída final remove todo o resíduo. Fees são
debitadas uma vez, inclusive na resolução. `C = C0 + R - soma(sign(Q) B)`;
`U = M - sign(Q) B`; `E = C + soma(M) = C0 + R + soma(U)`.

Replay ordena por event_ts/chave e recusa duplicatas com conteúdo/dono divergente.
Resolução global de fee zero alcança todos os donos associados, inclusive net-zero.
Os buckets diários e semanais (segunda-feira) usam o instante econômico UTC;
received_at e resolução posterior não movem a realização de uma saída anterior.
Dados monetários inválidos e causalidade incompatível falham explicitamente.

`financialstore.ts` reconstrói um dono em transação REPEATABLE READ e atualiza o
cache `paper_owner_positions` existente. Lock por dono serializa escritores;
conflito de snapshot aborta tudo e pode ser repetido. O cache nunca alimenta R/basis.
Rebuild completo incorpora chegadas tardias sem usar event_id como cursor econômico.
Leitura anterior a evento financeiro conhecido ou marca já persistida é recusada;
o corte histórico fica disponível no replay puro, sem regredir a projeção atual.

Marcas são avaliações executáveis da quantidade individual: bids para long, asks para
short, profundidade completa e source/received timestamps comprovados dentro de
30 segundos. A soma dos produtos do book-walk é quantizada uma vez. Marcas globais
ledger-v1 são ignoradas. A última marca da mesma quantidade pode persistir stale;
U/equity frescos ficam NULL. Mudança de quantidade não reaproveita seu valor total.

Identidade não cria capital. `initial_cash_usd=NULL` conserva cash/equity absolutos
indisponíveis; cashflow, R e obrigações continuam mensuráveis. Não há seed, partição
ou top-up. Estabelecer capital exige origem/alocação auditada, fora desta entrega.

## Integração e compatibilidade

`loadPaperPnl(pool, { accountId, strategyId, now })` é a seleção explícita v2.
O runner usa somente `paper/main`; desconhecidos não são atribuídos ao bot.
O estado aceita os buckets já calculados pelo loader, inclusive na virada UTC.
Capital ou marca ausente impedem novas entradas via REDUCE_ONLY, sem liberar
HALTED ou relaxar limites. Campos numéricos legados de equity/HWM retêm o último
snapshot quando equity está indisponível; isso não comprova uma marca fresca.

A chamada sem seleção de dono conserva ledger-v1, assim como o replay antigo e
seu cache token-only. Outros leitores/gates/exposição/saídas/fast wallet continuam
na transição legada: esta entrega não declara reconciliação financeira integrada,
não ativa worker/estratégia, não muda política de execução, caps, live ou signer.
O carregador v2 exige pool transacional e não usa cache vazio como capital zero.

## Verificação

Oráculos constantes F1–F6 cobrem o contrato monetário (F5 somente invariância de
cash/PnL perante eventos sem fill; reservas permanecem fora do escopo). O teste
PostgreSQL usa schema próprio no banco descartável exclusivo indicado por
`GANSO_TEST_DATABASE_URL`, todas as migrations e guards ativos, sem apagar fixtures.

Cobertura SQL: F4 por dono/dia, fee única, short ask, global mark ignorada,
net-zero, capital desconhecido, profundidade/frescor, late/restart/cache alterado,
rollback de múltiplas posições e concorrência com retry de serialization failure.
Os testes verificam carregador → estado e igualdade dos valores persistidos.
Revisão independente identificou as duas regressões de cutoff corrigidas acima.
Contagens executadas, gates e entrega constam no recibo; skipped não é passed.
Produção e fixtures constituem evidências diferentes; nenhuma observação breve
comprova novos fills, reconciliação histórica, ganho de latência ou soak.
