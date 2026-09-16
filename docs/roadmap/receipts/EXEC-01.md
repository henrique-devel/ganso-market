Bloco: EXEC-01 | RFC: RFC-034 | Data UTC: 2026-09-16
Estado: code-verified; não equivale a validação da ordem final nem soak.
Código: d8cf2e7; base 95c0ddd; worktree isolado /private/tmp/ganso-exec01.
Resultado: EV conserva uma incidência por custo; slippage do walk permanece diagnóstico.
Fórmula (USD/cota, escala 1e9): edgeNet = payoff conservador − preço − fee − capital excedente − buffer − seleção adversa maker.
Margem (USD/cota) = max(piso, fração × gross conservador positivo); aceite exige edgeNet > margem, sem novo débito.
Capital excedente = max(0, preço × taxa anual × dias/365 − hurdle diário já coberto pelo buffer × dias).
Diagnóstico preservado: slippage = max(0, VWAP − melhor ask); unwind_cost = (melhor bid − VWAP) × cotas caminhadas, em USD total.
Unwind já não duplicava impacto: testes protegem residual bruto payoff − VWAP e capital restante integral; contexto não informa fee de saída.
Versões: ev-costs-v2 explicita costsTotal sem slippage; policy 1.0.1 distingue fee inválida/desconhecida; campos anteriores mantidos.
Contrato EXEC-02: chamar computeExecutionEv em apps/api/src/polymarket/portfolio/ev.ts; resultado ok/value ou ok:false/reason.
Taker: BUY do token real, walk completo/válido e fee conhecida; null/negativa não autoriza agressão. NO usa 1−qHi.
Maker: limite passivo, fee e seleção adversa explícitos; cálculo condicional a fill, sem prometer fill/rebate. Walk continua referência diagnóstica.
Compatibilidade: computeEv mantém proxy candidate-vwap e fee maker legada; não confundir com preço final validado.
EXEC-02 deve conferir procedência/idade de fee, dono/token/lado/tamanho/livro da ordem, e comparar margem via clearsEntryCriterion.
Dependência: recibo FIN-01 e contrato financial-v2 conferidos na base; unidades/fees únicas e fixtures manuais compatíveis.
Arquivos: ev.ts, exitcycle.ts, policy.ts; testes ev/exitcycle/policy e expectativa de versão fastpolicy; estado e recibo.
Testes focados: npm test --workspace @ganso-market/api -- test/polymarket/{portfolio/ev,portfolio/exitcycle,paper/policy,paper/fastpolicy}.test.ts; 124 passaram.
Regressão: reinserir só +slippageScaled no total anterior faz 6 fixtures novas falharem; restaurada a correção, 124 passam.
Aceite manual: ask .50/VWAP .55/payoff .65 => EV .10/slippage .05; fee .0099 => EV .0901; maker .165; NO .0901.
Checks: make verify passou (2443 JS, 257 PG skips no gate source; Rust/Python/build/lint/scan/Compose aprovados); git diff --check passou.
PostgreSQL: make test-postgres passou em banco local descartável; 23 arquivos/288 testes/zero falhas/zero skips.
Publicação/produção: CI, merge e deploy automático autorizados posteriormente nesta sessão; evidência de entrega acompanha o PR.
Limites: sem migration, sizing/bridge, ligação ao broker, alteração de thresholds/G2/G4/caps/live; não executar EXEC-02.
Próximo bloco: EXEC-02 consome o contrato puro e confere FIN-03/FIN-06; nenhuma prontidão econômica final inferida aqui.
