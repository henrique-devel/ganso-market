Bloco: FIN-07 | RFC: RFC-038 | Data UTC: 2026-09-17T14:01:25+00:00
Estado: code-verified; desbloqueado, prontidão financeira local integral aprovada.
Base: ea15dea40ea065e29867f71d68f3e4f1a5bac2e3; código: a03490ccf07b05d927d045d937da699e4d962873.
Escopo: pedido posterior autorizou correção integral FIN-03/#187 e ampliação de arquivos; PR→merge→produção autorizado.
Evidência: [relatório](../evidence/FIN-07-reconciliation.md), [gate nominal](../evidence/FIN-07-pg-results.json); regressões permanentes reconciliation*.pg.test.ts.
Dependências: FIN-01..06/QA-01 conferidas; EXEC-04 integrado e usado no cenário broker.
Correção: cache v2 na transação do broker; leituras/APIs/G2/telas/limitador por dono; v1 explicitamente diagnóstico.
Contrato: ownership-v1/financial-v2/payoff-v1/reservation-v1, nano-USD/cotas, sem tolerância monetária.
Migration0026: âncoras diárias por dono, aditiva; sem capital/backfill/reescrita de histórico.
SQL: GANSO_PG_RESULTS_DIR=/private/tmp/fin07-repair-pg7 make test-postgres => exit0.
Resultado: PG18.4/26 migrations/26 arquivos, 318 passed/0 failed/0 unexecuted (287SQL+31unitários mistos).
F4: cache físico A R1,060000000/B−0,050000000; somas1,01 antes/5,60 dia seguinte/6,61 total.
Broker: 18 checkpoints; saída main R0,180000000/B0; settlement main2,18/B2; cache lido antes de reconstrução.
Leitores: APIs reais preservam duas linhas/donos e não modificam cache; G2/performance sem mistura de basis.
Reservas: disputa600+500/1000, oversell e empréstimo entre donos recusados; retries/restart/rebuild exatos.
Falhas: cache recusa fill => rollback, cancelamento auditado/liberação; nova ordem válida executa.
Isolamento: A−100/B+120 engata limite; âncoras persistem; netzero sem marca não esconde risco.
Checks: make verify exit0; 2478JS/16Rust/220Python, 287 skips source-only separados; typechecks API/web/diff OK.
Entrega: publicação/CI/deploy em andamento; resultado efetivo será registrado no fecho.
Produção: pré-check de versão/saúde13:57:48Z OK, release1f49f47; nenhuma leitura financeira histórica.
Limites: donos/marcas históricos desconhecidos não quantificados; sem soak, lucro, capital/caps/live ou worker novo.
Continuidade: FIN-07 para aqui; não antecipar o aceite de EXEC-05.
