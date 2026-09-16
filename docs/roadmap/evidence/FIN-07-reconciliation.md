# FIN-07 — Reconciliação financeira

Corte da inspeção: **2026-09-16T21:23:23Z**. Base executada:
`e21e35afe1c5d51ceb4e7d0bd46b62a942852b4d` (main com FIN-06 e QA-01/PR186).
Modo read-only: somente fixtures em PostgreSQL descartável, artefatos e estado.

**Resultado: financial-v2 reconciliado localmente; prontidão financeira global
não declarada.** A projeção legada por token diverge no evento F4/a2; correção
mínima aberta em [FIN-03/#187](https://github.com/henrique-devel/ganso-market/issues/187).
Não houve reparo de runtime neste bloco. FIN-07 fica bloqueado para o aceite
integral até a segregação/verificação dos consumidores legados e nova medição.

## Fonte, precisão e infraestrutura

Oráculo: [FIN-01, §4/F1–F6](FIN-01-financial-contract.md), calculado manualmente,
não valores produzidos pelo fold. Conferidos os recibos FIN-01..06 e
[QA-01](../receipts/QA-01.md), além de ledger/brokerstore/financialstore,
exitstore/state/exposure e da suíte portfolio/integration.pg.test.ts.
O checkout inicial d04875a estava antigo e tinha trabalho alheio; foi preservado.
A execução ocorreu em checkout isolado de main com as dependências integradas.

USD/cotas em fixed-point de nove casas (`10^-9`); igualdade exata de bigint ou
TEXT canônico, sem `toBeCloseTo`, epsilon ou tolerância. Basis residual usa a
regra FIN-01; fees entram uma vez. Versões: ownership-v1, financial-v2,
payoff-v1, reservation-v1. Legado ledger-v1 é medido separadamente a seis casas.
Capital exclusivamente sintético: F4 particiona 1.000 em A=500/B=500.
Marcas são livros sintéticos, com profundidade e source/received timestamps UTC.
Datas econômicas são as de fixtures; não representam trades ou preços observados.

QA-01 executou PostgreSQL **18.4**, Docker local arm64, **25 migrations reais**,
clones descartáveis por arquivo, proteção de ledger e HOLD preservadas. Nenhuma
conexão produtiva, leitura histórica, backfill, realocação, worker, ordem live,
alteração de limites/configuração ou escrita em cache operacional.

## Resultados exatos

Números abaixo omitem zeros finais por legibilidade; as asserções usam nove casas.
C=cash, B=basis bruto, R=realizado líquido, F=fees, M=marca assinada, E=equity;
risco é perda residual da posição, separado das reservas e do realizado.

| Fixture/checkpoint | C | Q / B | R / F | M / E | Risco |
|---|---:|---|---|---|---:|
| F1 short10@0,40, ask0,50 | 1004 | -10 / 4 | 0 / 0 | -5 / 999 | 6 |
| F1 recompra4@0,50 | 1002 | -6 / 2,4 | -0,4 / 0 | -3 / 999 | 3,6 |
| F1 resolve1 restante | 996 | 0 / 0 | -4 / 0 | fechado / 996 | 0 |
| F2 BUY10 NO@0,60, bid0,50 | 994 | 10 / 6 | 0 / 0 | 5 / 999 | 6 |
| F2 NO resolve0 | 994 | 0 / 0 | -6 / 0 | fechado / 994 | 0 |
| F3 X/Y abertos | 930 | 100+100 / 30+40 | 0 / 0 | 70 / 1000 | 70 |
| F3 X/Y resolvidos0 | 930 | 0 / 0 | -70 / 0 | fechado / 930 | 0 |
| F6 sem marca | 9 | 3 / 1 | 0 / 0 | indisponível | 1 |
| F6 primeira venda1@0,40 | 9,4 | 2 / 0,666666667 | 0,066666667 / 0 | 0,8 / 10,2 | 0,666666667 |
| F6 segunda venda | 9,8 | 1 / 0,333333333 | 0,133333333 / 0 | 0,4 / 10,2 | 0,333333333 |
| F6 terceira venda | 10,2 | 0 / 0 | 0,2 / 0 | fechado / 10,2 | 0 |

Cada checkpoint compara estado derivado dos eventos, linhas de
`paper_owner_positions`, `loadPaperPnl`, `evaluateState` e `computeExposures`.
São checkpoints selecionados dos oráculos, não alegação de execução de cada
linha narrativa de FIN-01. F1/F2/F3/F6 têm cronologia sintética crescente no dia12;
resolução dia13. A suíte financial.pg existente cobre também eventos tardios,
marcas inválidas, desconhecidos e donos opostos sem netting.

### F4 — mesmo token, duas estratégias simultâneas

Aceites concorrentes A BUY10@0,40 e B BUY5@0,60; fee máxima sintética0,01/cota
(400bps no contrato de teste), reservas4,10/3,05. Ambos os fills também são
submetidos concorrentemente. A tentativa de A reservar510 além de4,10 falha por
cash; o dinheiro livre de B não é emprestado. B tem5 cotas e não pode vender6.
A reserva4 cotas para a2 e0,04 de cash/risco para fee; o fill consome ambos.

| Corte econômico | Dono | C | Q | B | R total | F | M | E | R diário / semanal | Risco |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 12/09 23:59:59.950Z, após a2 | A | 498,66 | 6 | 2,4 | 1,06 | 0,14 | 3 | 501,66 | 1,06 / 1,06 | 2,4 |
| mesmo corte | B | 496,95 | 5 | 3 | -0,05 | 0,05 | 2,5 | 499,45 | -0,05 / -0,05 | 3 |
| agregado | A+B | 995,61 | 11 | 5,4 | 1,01 | 0,19 | 5,5 | 1001,11 | 1,01 / 1,01 | 5,4 |
| 13/09 00:06Z, resolução1 | A | 504,66 | 0 | 0 | 4,66 | 0,14 | 0 | 504,66 | 3,60 / 4,66 | 0 |
| mesmo corte | B | 501,95 | 0 | 0 | 1,95 | 0,05 | 0 | 501,95 | 2 / 1,95 | 0 |
| agregado | A+B | 1006,61 | 0 | 0 | 6,61 | 0,19 | 0 | 1006,61 | 5,60 / 6,61 | 0 |

Caixa/inventário reservados zeram após os fills e após resolução. Entre a2 e
resolução, o teste abre reservas adicionais: A BUY2 exige cash/risco0,82; B SELL3
exige cash/risco0,03 e inventário3. Agregado reservado0,85/inventário3; disponível
A497,84/B496,92, agregado994,76. Essas reservas não alteram R/E; risco de posição
mais reserva é6,25. Valores agregados nesta tabela são somas das subcarteiras,
não netting de basis nem alocação do saldo de uma à outra.

Dia12 recebe a2 em 23:59:59.900Z; dia13 recebe somente o remanescente liquidado.
Na segunda-feira14/09, dia e semana de A voltam a0, total permanece4,66.
A suíte financeira existente executa a chegada de a2 depois da resolução e
reconstrói o dia12. Caso existente de long/short de donos opostos no mesmo token
prova risco4+6=10 mesmo com quantidade líquida0; ganhos não compensam donos.

### F5 — concorrência e reservas

`reservations.pg.test.ts` executou20 casos reais. Disputa600+500 contra caixa1000,
nas duas ordens de chegada: backend bloqueado observado em PostgreSQL, um aceite
apenas, perdedora revertida. Fill400@0,50 da ordem1200 deixa C800/B200/H400,
disponível400 e risco total600. Cancel_requested retém; cancel_effective libera.
Duas saídas300/200 contra400 cotas: só uma vence. Expiração efetiva, resolução,
rollback, retry, limites de fee e resíduo de nano também executaram. Não contamos
somente a aritmética pura como prova de concorrência.

## Reconstrução, retries e integridade

O caso F4 captura todas as colunas dos caches v2/reservas (exceto `updated_at`,
relógio de projeção sem valor econômico), além das linhas completas do ledger.
Adultera somente os caches sintéticos: Q/basis/R no cache de posições e
cash/risco/quantidade restante nas reservas. Fecha o pool e abre novas conexões;
`reconcileReservations` e `loadPaperPnl` reconstroem usando eventos e livros.

Resultado: **zero diferença** em todas as colunas capturadas antes/depois;
cash, fees, PnL diário/semanal, Q, basis, marca, equity e risco voltam aos valores
constantes do oráculo. Retry de aceites/fills/a2 retorna false e deixa ledger e
reservas idênticos; retry de resolução não duplica dinheiro. É reinício de
conexões/estado do consumidor, não reinício de servidor/worker produtivo.

A primeira tentativa de remover a linha de cache foi corretamente recusada por
`DATA02_EVIDENCE_HOLD: paper_owner_positions DELETE`: 291 passed/1 failed.
A fixture passou a adulterar projeção via UPDATE permitido, sem desabilitar
trigger ou alterar runtime. Duas execuções seguintes passaram; a última também
adulterou inventário reservado. Falha de preparação Docker sem permissão e
`.venv` ausente foram resolvidas no ambiente local, sem alterar o projeto.

## Divergência pendente FIN03-LEGACY-F4

| Após evento a2, antes da resolução | financial-v2 por dono (soma) | ledger-v1 por token | Diferença v2−v1 |
|---|---:|---:|---:|
| Q | 11 | 11 | 0 |
| Fees | 0,190000000 | 0,190000 | 0 |
| Basis | 5,400000000 | 5,133333 | 0,266667 |
| R líquido | 1,010000000 | 0,743333 | 0,266667 |

Teste lê eventos do SQL e chama ambos os caminhos. O v1 mistura os custos a1/b1:
a2 retira4×(7/15), enquanto v2 retira4×0,40 do dono A. A diferença monetária é
atribuída ao evento e às versões; **não é tolerada como reconciliação**.
`brokerstore::refreshPosition` grava a saída v1 em `paper_positions`; leitores
sem seleção em exitstore e consumidores em paper/performance/API continuam
presentes. A comparação física desse cache através dos ticks reais e a revisão
dos consumidores são pendências, não provas obtidas pela simples chamada ao fold.

[Correção mínima FIN-03/#187](https://github.com/henrique-devel/ganso-market/issues/187):
preservar ledger/compatibilidade v1 e selecionar/segregar dono/versão nos
consumidores monetários. Aceite mensurável: reproduzir pelo broker/cache/leitores
R(A)=1,06/R(B)=-0,05/agregado1,01; buckets1,01/5,60 e total6,61; verificar donos
opostos sem compensação e reexecutar FIN-07. Nenhuma correção implementada aqui.
Não declarar equivalência global dos caches nem prontidão produtiva neste estado.

Histórico de produção: **não consultado**; número de eventos/donos desconhecidos
e marcas históricas inválidas não medido. Fixtures de capital desconhecido
mantêm NULL e bloqueiam capacidade; isso não fornece um inventário produtivo.
A ausência de histórico não impediu os testes locais e não substituiu fixtures.

## Reprodução e comandos observados

O [artefato executável](FIN-07-reconciliation.pg.test.ts) fica em docs para não
alterar runtime ou disparar recriação de serviços por um bloco read-only.
Ele usa caminhos relativos ao destino temporário abaixo; não execute em produção.
Em checkout descartável da base acima, com dependências do projeto e Docker:

```sh
test ! -e apps/api/test/polymarket/paper/reconciliation.pg.test.ts
cp docs/roadmap/evidence/FIN-07-reconciliation.pg.test.ts apps/api/test/polymarket/paper/reconciliation.pg.test.ts
trap 'rm -f apps/api/test/polymarket/paper/reconciliation.pg.test.ts' EXIT
GANSO_PG_RESULTS_DIR=/tmp/fin07-pg make test-postgres
npm run check --workspace @ganso-market/api
```

O harness QA-01 cria o banco e define `GANSO_TEST_DATABASE_URL`; não apontar uma
URL operacional. Descobre24 arquivos, rejeita skip/falha/relatório ausente, descarta
os bancos/container. Novas versões de main podem ampliar esse inventário.

Execução final: `GANSO_PG_RESULTS_DIR=/private/tmp/fin07-pg-confirmed make test-postgres`.
**292 passed / 0 failed / 0 unexecuted, 24 arquivos**: 261 casos PostgreSQL e31
unitários de arquivos mistos. Inclui4 casos novos FIN-07,10 financial.pg,
20 reservations.pg,17 ownership.pg e34 portfolio/integration.pg.
[Resumo nominal do gate](FIN-07-pg-results.json). Suíte source-only ignorada não
é contada como SQL; typecheck passou com o artefato instalado no destino.

`make verify` final: exit0; 2.420 JavaScript passed/261 skipped (source-only,
separados dos261 casos SQL acima),16 Rust e13+207 Python; formatação, lint,
build, secret scan e Compose config/policy passaram. A primeira tentativa em
sandbox não podia abrir sockets de teste; a execução local autorizada passou.
SHA256 da fixture executada/publicada:
`84ccbf39ec10b80f1941575fae3c1b8197bb25d7f9035d19e646f6c5a1d818ec`.

Entrega: relatório, fixture reproduzível, resumo do gate, recibo e somente linha
FIN-07 do estado. PR/checks/merge referenciados no recibo/PR. Produção segue a
dispensa documental da RFC-020, sem forçar deploy. **Parar no FIN-07**; EXEC-04
continua responsável pelas saídas e nenhum outro bloco foi executado.
