Bloco: EXEC-02 | RFC: RFC-034 | Data UTC: 2026-09-17
Estado: code-verified; PRs [190](https://github.com/henrique-devel/ganso-market/pull/190)/[191](https://github.com/henrique-devel/ganso-market/pull/191) integrados, CI PR/main e deploy aprovados.
Código: aa9e448/merge768d3fa; reparo236538a/merge18a6c20; worktree /private/tmp/ganso-exec02; fecho codex/exec-02-delivery-receipt.
Resultado: entradas portfolio BUY YES/NO são normalizadas e reavaliadas dentro da transação, antes da reserva.
Dependências: EXEC-01/ev-costs-v2, FIN-03/financial-v2 e FIN-06/entry-v2 conferidos por código/recibos; FIN-05/0025 preservado.
Arquivos de lógica: bridge, brokerstore, policy, fastpolicy; novos finalorder.ts e finalorderstore.ts; nenhuma migration.
Contrato: evaluateFinalEntry(FinalOrderInput) => ok/reason/evidence; final-entry-v1, ordem v3, policies 1.0.2/fast 0.1.1.
Identidade: conta/estratégia, condition/token/outcome, BUY, teto de cotas; dono atribuído pela 0024 conferido antes de reserveOrder.
Economia: computeExecutionEv/clearsEntryCriterion de EXEC-01; VWAP no tamanho normalizado, bound NO=1−qHi; pisos/margens/caps originais.
Fonte: decisão/config imutáveis com hash conferido; custos/bounds ausentes recusam, sem substituição por defaults atuais.
Maker: limite passivo e premissas explícitas zero fee/seleção não modelada, condicional a fill; sem promessa de fill/rebate.
Taker: fee registrada em polymarket_param_versions, versão/source/received/valid_from/idade da revisão; null ou procedência ausente recusam.
Recotação: snapshot e parâmetros relidos na transação; journal 0011/0012 impede commit de parâmetros/mapeamento até reserva; nenhuma mutação da ordem após avaliação.
Auditoria: ledger order_accepted/order_rejected.payload_json.final_entry_evaluation contém SHA256 da avaliação, inputs, walk, breakdown e razão.
Cotação anterior: intent.quote; vínculo por order_id/decision_id; decisões append-only intactas, recusa não cria ordem/reserva.
Fast: mesmo avaliador no modo paper exige bound/custos/fee verificável; shadow mantém hipóteses identificadas; não existe runner/broker fast ativo nesta base.
Aceite numérico: .65−.55=.10, slippage diagnóstico .05; taker .04×.55×.45=.0099 => EV .0901; maker .16; NO .10.
Recusas SQL: 100 cotas/livro de uma; livro .50→.50/.60 fora do limite; fee 700bps→null; EV .014888 abaixo do piso .02.
Nova avaliação SQL: ask .62→.61, tamanho 5.019→5.01, fee/cota .016653, EV .122347, reserva US$3.193875; livro/ordem/breakdown conferidos.
Testes: oito arquivos focados (bridge/finalorder/finalorderstore/policy/fastpolicy/broker/brokerstore/ev), 297 passaram; typecheck/diff passaram.
Checks: make verify passou na revisão reparada (2459 JS, 263 PG skips separados; 16 Rust, 220 Python, build/lint/scan/Compose).
SQL: make test-postgres passou, PostgreSQL18.4 descartável/25 migrations, 23 arquivos/294 testes/zero falhas/zero skips; disputa de lock observada sem deadlock, fee/reserva .0175 iguais.
Integração EXEC-03: consumir ordem normalizada + final_entry_evaluation + reservation no ledger; alteração econômica exige avaliar novamente.
Integração EXEC-04: EXIT desvia deste gate (teste explícito); nenhuma saída D4 implementada. FRESH-03: evaluatedAt/book/fee timestamps e ponto pré-reserva.
Produção 17/09 00:21Z: API/paper no SHA18a6c20, healthchecks/fixture pura passaram, zero reinícios/erros observados; sem amostra econômica/soak, expiry/D4/caps/G4/live/capital novos; parar aqui.
