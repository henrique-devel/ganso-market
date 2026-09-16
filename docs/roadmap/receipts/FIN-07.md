Bloco: FIN-07 | RFC: RFC-038 | Data UTC: 2026-09-16
Estado: blocked para aceite integral; artefatos verificados, financial-v2 reconciliado localmente.
Base SQL: e21e35afe1c5d51ceb4e7d0bd46b62a942852b4d, main com FIN-06/QA-01 integrados.
Evidência: [relatório](../evidence/FIN-07-reconciliation.md), [fixture](../evidence/FIN-07-reconciliation.pg.test.ts), [gate JSON](../evidence/FIN-07-pg-results.json).
Precisão: nano-USD/cotas; diferenças v2 zero, sem epsilon; legado seis casas separado.
Oráculos: FIN-01 F1–F6; PostgreSQL18.4/25 migrations, container/clones descartáveis QA-01.
SQL: GANSO_PG_RESULTS_DIR=/private/tmp/fin07-pg-confirmed make test-postgres => exit0.
Resultado: 24 arquivos/292 passed/0 failed/0 skipped; 261 SQL reais +31 unitários mistos.
Cobertura: cash/fees/R diário e semanal/Q/basis/marca/equity/risco por dono/token e somas explícitas.
Concorrência: F4 A500/B500 no mesmo token; recusa empréstimo/oversell; F5 disputa600+500/1000 e saídas.
Reconstrução: caches sintéticos adulterados, novo pool, replay/reservas exatos; ledger idêntico após retries.
Proteção: DELETE de cache recusado por HOLD; fixture adaptada para UPDATE, sem remover guard nem reparar runtime.
Divergência: evento F4/a2, R v2=1,010000000 vs v1=0,743333; diferença0,266667 explicada, pendente.
Correção mínima: [FIN-03/#187](https://github.com/henrique-devel/ganso-market/issues/187), consumidores/cache legado; não implementada aqui.
Aceite pendente: broker/cache/leitores legados por dono/versão, buckets1,01/5,60, total6,61; repetir FIN-07.
Checks: typecheck/SQL/make verify exit0; 2420JS+16Rust+220Python, 261 skips source-only separados; scan/Compose/diff passaram.
Publicação: PR documental autorizado; nenhum código runtime/migration/config alterado; dispensa RFC-020 aplicável.
Histórico/produção: não consultados; donos desconhecidos/marks históricos não quantificados; sem backfill/transferência.
Limites: sem prontidão global/produtiva/soak, worker/live/caps; EXEC-04 ainda entrega saídas.
Continuidade: parar aqui; somente correção pendente registrada, nenhum outro bloco iniciado.
