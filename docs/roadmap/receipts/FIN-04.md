Bloco: FIN-04 | RFC: RFC-038 | Data UTC: 2026-09-16
Estado: code-verified; prova financeira local, sem aceite integrado/soak.
Base: 1954c1cc92e8440366a9cf8b85abbc510a88b2fb (FIN-03 integrado).
Código: b68e6de01876bb507feb90933b3cfc28f3cc3322; branch codex/fin-04-payoff-exposure.
Resultado: exposição residual por payoff/dono; short inclui obrigação, negRisk não reduz buckets.
Semântica: payoff-v1/nano-USD; soma conservadora ou matriz completa confiável por dono/contrato.
Fees: pagas ficam em R líquido; limites de fees pendentes entram no risco uma vez.
Dimensões: mesmas chaves/caps; compensação usa só as posições do próprio bucket.
Runtime: entrada usa o replay financial-v2 paper/main do PnL, sem net-token cache; soma rotulada no log.
Sizing: preço-limite + fee explícita, cotas arredondadas para baixo; riskScaled separado do notional.
Dependências: contrato/fixtures FIN-01 e código/recibo FIN-03 conferidos; ownership-v1/schema0024.
Arquivos: exposure/exitstore/runner/sizing/engine, quatro arquivos de testes e documentação FIN-04.
Aceite: F3 30+40=70/negRisk misto; short10@0,40=6; fees, evento incompleto/provado, zero e dois donos.
Oráculos: payoffs enumerados/expectativas constantes; prova parcial/inválida não reduz risco; nanos conservadores.
Testes: 116 passed/zero skipped em exposure,sizing,runner,engine,financial.pg; nove PostgreSQL reais.
Comando: GANSO_TEST_DATABASE_URL=<descartável> npm test --workspace @ganso-market/api -- test/polymarket/portfolio/{exposure,sizing,runner,engine}.test.ts test/polymarket/paper/financial.pg.test.ts --no-file-parallelism.
Gate: make verify passou; 2402 JS passed/237 skipped discriminados, 16 Rust e 220 Python, build/scan/Compose aprovados.
Ambiente: PostgreSQL18.4 local descartável exclusivo; nenhuma consulta/dado financeiro produtivo.
Publicação: push recusado antes de executar pela revisão automática; sem PR/merge/deploy.
Recusa: interpretou “somente este bloco/pare aqui” como limite à exportação para repo público; confirmação explícita pendente.
Limites: runtime sem produtor de provas; nenhuma reserva atômica, ativação live, mudança de cap/capital ou histórico.
Contrato FIN-05: dono/versões, risco por dimensão/headroom, cash separado, fees/rounding e transferência de reservas.
Evidência e contrato completo: [FIN-04](../evidence/FIN-04-payoff-exposure.md).
Próximo bloco elegível: FIN-05; não iniciado.
