Bloco: EXEC-04 / RFC-022 D4-A | RFC: RFC-034 | Data UTC: 2026-09-17
Estado: code-verified; PR195 integrado, CI/CD aprovado e aplicação paper/portfolio verificada.
Código: 3673bca; merge1f49f47; [PR195](https://github.com/henrique-devel/ganso-market/pull/195); seis arquivos/sem migration.
Resultado: EXIT long YES/NO vende token real; short legado atribuído compra cobertura sem cruzar zero.
Dependências: EXEC-03/PR193 e FIN-07 financial-v2 conferidos; aceite global FIN-07/#187 continua bloqueado.
Identidade: exit_contract_version1 e exit-reduce-only-v1; runtime paper/main; outro dono recusado.
Reserva: saldo v2 menos reservas; locks ordem/token/dono, uma intenção ativa, ID da decisão deduplica.
Economia: bid/ask pelo lado correto; passiva GTC post-only, fee maker explícita; sem gate de lucro de entrada.
Proteções: kill/resolução/reduce-only preservados; HOLD mantém ordem; terminal libera nova avaliação.
Vínculo: decision_id imediato; portfolio carimba paper_order_id; recusas persistem com reason/decision_id.
Focados: 250 passaram; regressão de quatro casos novos falha na base anterior.
SQL: make test-postgres, PG18.4/25migrations, 24arquivos/310passaram/zero falhas/skips; 15casos D4 novos.
Aceite: ±8,11; parcial2→restante6,11; donos opostos, duplicata/disputa/cancelamento/livro/veto/kill/resolução.
Cobertura: cada caso exige EXIT elegível não vazio e 100% ordem vinculada ou recusa persistida.
Checks: make verify passou; 2478JS/16Rust/220Python, 279skips source-only separados; tipos/build/scan/Compose/diff OK.
Evidência: [contrato e testes](../evidence/EXEC-04-exits.md), [gate PostgreSQL](../evidence/EXEC-04-pg-results.json).
Entrega: [CI/CD35174412739](https://github.com/henrique-devel/ganso-market/actions/runs/35174412739) aprovado; paper/portfolio SHA1f49f47 às02:31:30Z, zero restarts.
Operação: healthcheck OK; banco preservado desde07/09 22:59:17Z/zero restarts; boot paper; portfolio REDUCE_ONLY.
Amostra produtiva: ciclo02:32:14Z avaliou0 posições do dono; sem EXIT novo/fill/aceite prospectivo/soak.
Limites: passiva sem garantia de fill; mínimos/precisão vigentes; legado sem dono não atribuído; FIN-07 integral pendente.
Autorização: desenvolvimento/entrega contínua; sem live/caps/TTL/frescor novos.
Continuidade: contrato entregue a FRESH-03/EXEC-05; parar após EXEC-04.
