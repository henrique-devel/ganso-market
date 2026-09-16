Bloco: FIN-04 | RFC: RFC-038 | Data UTC: 2026-09-16
Estado: code-verified; release implantada/verificada, sem aceite financeiro integrado/soak.
Base: 1954c1cc92e8440366a9cf8b85abbc510a88b2fb (FIN-03 integrado).
Código: b68e6de01876bb507feb90933b3cfc28f3cc3322; três commits originais preservados.
Publicação: [PR #177](https://github.com/henrique-devel/ganso-market/pull/177), merge ff81cf5f9056896f6311426f110cc2ba2e5cf726.
Resultado: exposição residual por payoff/dono; short inclui obrigação, negRisk não reduz buckets.
Semântica: payoff-v1/nano-USD; soma conservadora ou matriz completa confiável por dono/contrato/bucket.
Fees: pagas ficam em R líquido; limites de fees pendentes entram no risco uma vez.
Runtime: entrada usa o replay financial-v2 paper/main do PnL, sem net-token cache; soma rotulada no log.
Sizing: preço-limite + fee explícita, cotas para baixo; riskScaled para cima separado do notional.
Dependências: contrato/fixtures FIN-01 e código/recibo FIN-03 conferidos; ownership-v1/schema0024.
Arquivos: exposure/exitstore/runner/sizing/engine, quatro arquivos de testes e documentação FIN-04.
Aceite: F3 30+40=70/negRisk misto; short10@0,40=6; fees, evento incompleto/provado, zero e dois donos.
Oráculos: payoffs enumerados/expectativas constantes; prova parcial/inválida não reduz risco; nanos conservadores.
Testes: 116 passed/zero skipped, nove PostgreSQL reais; exposure,sizing,runner,engine,financial.pg.
Comando: GANSO_TEST_DATABASE_URL=<descartável> npm test --workspace @ganso-market/api -- test/polymarket/portfolio/{exposure,sizing,runner,engine}.test.ts test/polymarket/paper/financial.pg.test.ts --no-file-parallelism.
Gate: make verify passou; 2402 JS passed/237 skipped, 16 Rust e 220 Python; build/scan/Compose aprovados.
CI: source/Compose passaram no [PR](https://github.com/henrique-devel/ganso-market/actions/runs/35043884996) e [main](https://github.com/henrique-devel/ganso-market/actions/runs/35044205688); Deploy production aprovado.
Produção: API/portfolio no merge; healthcheck e ciclo payoff-v1/conservative_sum observados; hashes de configuração/PG preservados.
Limites: sem consulta financeira produtiva/reconciliação/soak; runtime sem produtor de provas; sem reservas/migration/live/cap/capital novo.
Autorização: proprietário aprovou diretamente a publicação dos três commits; entrega concluída sob autorização contínua.
Fecho documental adicional: somente local; push recusado pela revisão automática por exceder a aprovação específica dos três commits.
Contrato FIN-05: dono/versões, risco por dimensão/headroom, cash separado, fees/rounding e transferência de reservas.
Evidência e contrato completo: [FIN-04](../evidence/FIN-04-payoff-exposure.md).
Próximo bloco elegível: FIN-05; não iniciado.
