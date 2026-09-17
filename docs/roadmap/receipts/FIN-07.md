Bloco: FIN-07 | RFC: RFC-038 | Fecho UTC: 2026-09-17T14:39:45Z
Estado: code-verified; desbloqueado, prontidão financeira local integral aprovada e entrega operacional verificada.
Código: a03490c (financeiro), eb84c7b (reparo de inicialização); merges6279457/f2f5528 em main.
Escopo: pedido posterior autorizou correção integral FIN-03/#187 e ampliação de arquivos; PR→merge→produção autorizado.
Evidência: [relatório](../evidence/FIN-07-reconciliation.md), [gate nominal](../evidence/FIN-07-pg-results.json); regressões permanentes reconciliation*.pg.test.ts.
Dependências: FIN-01..06/QA-01 conferidas; EXEC-04 integrado e usado no cenário broker.
Correção: cache v2 na transação do broker; APIs/G2/telas/limitador por dono; v1 explicitamente diagnóstico.
Contrato: ownership-v1/financial-v2/payoff-v1/reservation-v1, nano-USD/cotas, sem tolerância monetária.
Migration0026: âncoras diárias por dono, aditiva; sem capital/backfill/reescrita de histórico.
SQL final: GANSO_PG_RESULTS_DIR=/private/tmp/fin07-resolution-pg make test-postgres => exit0.
Resultado: PG18.4/26 migrations/26 arquivos,319 passed/0 failed/0 unexecuted (288SQL+31unitários mistos).
F4: cache físico A R1,060000000/B−0,050000000; somas1,01 antes/5,60 dia seguinte/6,61 total.
Broker:18 checkpoints; saída main R0,180000000/B0; settlement main2,18/B2; cache lido antes de reconstrução.
Leitores: APIs reais preservam dono e não modificam cache; G2/performance sem mistura de basis.
Reservas: disputa600+500/1000, oversell/financiamento entre donos recusados; retry/restart/rebuild exatos.
Falhas: cache recusa fill => rollback/cancelamento auditado; A−100/B+120 engata limite; marca ausente bloqueia.
Checks: make verify exit0;2478JS/16Rust/220Python;288 skips source-only executados no gate SQL;39 focados resolução.
Entrega: [PR197](https://github.com/henrique-devel/ganso-market/pull/197) e [PR199](https://github.com/henrique-devel/ganso-market/pull/199) integrados; CI/CD35231573111/35234388076 aprovados.
Produção: API/resolution f2f5528, paper/portfolio6279457; healthcheck/ready/schema26 OK; banco/configs preservados.
Incidente: sessão ociosa liberada; rollback reproduziu falha de grupo; PR199 recomputa irmãos sem estado com inputs válidos, sem relaxar vetos.
Pendências: [OPS/RISK198](https://github.com/henrique-devel/ganso-market/issues/198) investiga origem da sessão; histórico financeiro/donos/marcas não quantificados; sem soak/live/caps novos.
Continuidade: parar no FIN-07; não antecipar aceite EXEC-05 nem G4 operacional.
