Bloco: OPS-07 | RFC: RFC-021 D4 | Data UTC: 2026-09-11T21:41:57Z
Estado: code-verified
Código: base c528d5b0d74cc5cf8894ee953dd335df5f1e1b03 + mudanças locais não commitadas; alterações preexistentes de outros blocos preservadas.
Resultado: D4 estava ausente; processRows agora persiste closed=TRUE e updated_at somente no condition_id observado com boolean true e closed IS DISTINCT FROM TRUE.
Arquivos: apps/api/src/polymarket/samplers.ts; apps/api/test/polymarket/samplers.test.ts; apps/api/test/polymarket/samplers.pg.test.ts (novo); este recibo; somente linha OPS-07 do estado.
Dependências verificadas: OPS-01, recibo code-verified e contrato local de sweep/registry; produção não é premissa desta implementação.
Ordem/retry: fechamentos distintos do lote precedem todos os eventos, inclusive quando o mesmo ID vem nas respostas aberta e fechada; falha bloqueia eventos/cache desse ID e mantém a seleção de pendentes elegível.
Observabilidade: UMA_CLOSED_PERSIST_FAILED inclui condition_id/erro; falha posterior de INSERT mantém RESOLUTION_EVENT_PERSIST_FAILED e retry existente; outros mercados continuam.
Contratos: UPDATE estreito também no pollOnce compartilhado; nunca escreve false, nunca insere mercado ausente, não depende de mudança do status UMA; sem migration nova.
Leitores diretos (rg em apps/packages/scripts): fundamental/estimator.ts:126 exclui closed TRUE de loadUniverse; readapi.ts:365,455,739–741 expõe a flag e muda filtros ativo/fechado em lista/detalhe.
Leitores de resolução: fundamental/labels.ts:42–50,476,682 exige evento final e outcome; paper/brokerstore.ts:2754,2834 exige resolved/market_resolved para settlement, sem ler closed da tabela.
Outros consumidores: resolution/store.ts:104,439,468 mantém closed não terminal; resolution/recompute.ts:468 só termina em resolved; resolution/timeline.ts:164,182 ignora closed; pendingResolutionIds não o trata como terminal.
Propriedade: registry.ts:869 e recorder.ts:257 legado preservam upsert completo; registry.ts:185/gamma.ts:387 filtram record.closed recebido da venue, não a coluna persistida.
Teste unitário: npm run test --workspace @ganso-market/api -- test/polymarket/samplers.test.ts — 28 passed, incluindo true explícito, status hidratado constante e falha com respostas duplicadas por ID.
Testes consumidores: npm run test --workspace @ganso-market/api -- test/polymarket/{readapi,registry,recorder,fundamental/labels,resolution/timeline,paper/brokerstore}.test.ts — 269 passed (6 arquivos).
Teste SQL: GANSO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:59320/ops07_test npm run test --workspace @ganso-market/api -- test/polymarket/samplers.pg.test.ts — 5 passed, PostgreSQL 18.4 descartável em schemas próprios.
Schema real testado: DDL 0004/0005/0012 e pré-requisito do journal de 0011, sem recibos schema_versions; triggers reais de histórico habilitados e triggers locais injetando falhas UPDATE/INSERT.
Aceite SQL: efeito físico uma vez após repetição/restart; NULL vira TRUE; false/ausente/string não alteram flag; outro mercado/linha inteira/históricos preservados; falhas retomam e evento terminal não duplica.
Aceite econômico: fechado sem resolução permanece pendente, gera apenas evento closed, sai do estimador e syncLabels escreve zero labels; regressões dos consumidores impedem payout/label sem outcome.
Checks: npm run check --workspace @ganso-market/api; npx prettier --check nos três arquivos TypeScript; git diff --check — passed. Ambiente: Node v26.4.0, npm 11.17.0, Vitest 4.1.10, execução UTC 2026-09-11.
Produção: não consultada; sem deploy, liquidação ou backfill global. 302 testes passaram; prova local não atesta aplicação no servidor.
Limites: monotonicidade pertence ao sweep; upserts do registry mantêm autoridade para escrever false. Estimador usa a flag atual mesmo em consulta histórica, comportamento preexistente fora deste bloco.
Handoff OPS-04: validar fechamentos observados no servidor e release aplicada; COUNT(closed) mede fechamento, nunca prova resolução, vencedor conhecido ou label válida. Não executar o próximo bloco automaticamente.
