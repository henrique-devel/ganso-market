# Estado curto — blocos BTC

Atualizado em 10/09/2026: **pacote documental criado; novos blocos não executados**.
Validação documental: 49 prompts, 10 RFCs novas, links/IDs/dependências conferidos,
grafo sem ciclos e `git diff --check` sem erro. Código de aplicação e servidor intocados.
Ler só a linha selecionada e dependências do frontmatter. Código existente pode ser
verificado e aproveitado; recibo ausente não significa implementação ausente.

Estados: `pending`, `in-progress`, `code-verified`, `production-verified`, `blocked`,
`superseded`. Para documento/read-only, code-verified significa artefato verificado;
explicar no recibo. Plano pronto não é aplicado; production-verified requer observação
real de produção. Não inventar soak ou amostra prospectiva.

Atualizar uma linha por bloco e criar recibo em `docs/roadmap/receipts/<ID>.md` com
[o modelo](RECEIPT_TEMPLATE.md), até 25 linhas. Não linkar recibos inexistentes.
Não ampliar o HANDOFF histórico. Nenhum bloco inicia automaticamente.

| Bloco | Estado | SHA / evidência / bloqueio |
|---|---|---|
| [OPS-01](../../prompts/roadmap/btc/ops-01-inventario-saude.md) | pending | Ainda não executado |
| [OPS-02](../../prompts/roadmap/btc/ops-02-silencio-clob.md) | pending | Ainda não executado |
| [OPS-03](../../prompts/roadmap/btc/ops-03-kill-switch-condicionado.md) | pending | Ainda não executado |
| [OPS-04](../../prompts/roadmap/btc/ops-04-plano-recuperacao-soak.md) | pending | Ainda não executado |
| [OPS-05](../../prompts/roadmap/btc/ops-05-silencio-rtds.md) | pending | Ainda não executado |
| [OPS-06](../../prompts/roadmap/btc/ops-06-supervisor-externo-recorder.md) | pending | Ainda não executado |
| [OPS-07](../../prompts/roadmap/btc/ops-07-sweep-fechamento-monotonico.md) | pending | Ainda não executado |
| [DB-01](../../prompts/roadmap/btc/db-01-baseline-consultas.md) | pending | Ainda não executado |
| [DB-02](../../prompts/roadmap/btc/db-02-ultimo-trade-por-mercado.md) | pending | Ainda não executado |
| [DB-03](../../prompts/roadmap/btc/db-03-rtds-e-livro-asof.md) | pending | Ainda não executado |
| [DB-04](../../prompts/roadmap/btc/db-04-plano-recursos-e-validacao.md) | pending | Ainda não executado |
| [DATA-01](../../prompts/roadmap/btc/data-01-inventario-capacidade.md) | pending | Ainda não executado |
| [DATA-02](../../prompts/roadmap/btc/data-02-protecao-e-manifesto.md) | pending | Ainda não executado |
| [DATA-03](../../prompts/roadmap/btc/data-03-export-e-restore-isolado.md) | pending | Ainda não executado |
| [DATA-04](../../prompts/roadmap/btc/data-04-poda-idempotente-limitada.md) | pending | Ainda não executado |
| [DATA-05](../../prompts/roadmap/btc/data-05-politica-e-manutencao.md) | pending | Ainda não executado |
| [FIN-01](../../prompts/roadmap/btc/fin-01-contrato-financeiro.md) | pending | Ainda não executado |
| [FIN-02](../../prompts/roadmap/btc/fin-02-atribuicao-do-ledger.md) | pending | Ainda não executado |
| [FIN-03](../../prompts/roadmap/btc/fin-03-pnl-e-equity.md) | pending | Ainda não executado |
| [FIN-04](../../prompts/roadmap/btc/fin-04-exposicao-por-payoff.md) | pending | Ainda não executado |
| [FIN-05](../../prompts/roadmap/btc/fin-05-reservas-atomicas.md) | pending | Ainda não executado |
| [FIN-06](../../prompts/roadmap/btc/fin-06-tokens-reais.md) | pending | Ainda não executado |
| [FIN-07](../../prompts/roadmap/btc/fin-07-reconciliacao-financeira.md) | pending | Ainda não executado |
| [QA-01](../../prompts/roadmap/btc/qa-01-postgres-no-ci.md) | pending | Ainda não executado |
| [EXEC-01](../../prompts/roadmap/btc/exec-01-custos-sem-duplicacao.md) | pending | Ainda não executado |
| [EXEC-02](../../prompts/roadmap/btc/exec-02-ev-da-ordem-final.md) | pending | Ainda não executado |
| [EXEC-03](../../prompts/roadmap/btc/exec-03-fills-fees-e-cancelamento.md) | pending | Ainda não executado |
| [EXEC-04](../../prompts/roadmap/btc/exec-04-saidas-reduce-only.md) | pending | Ainda não executado |
| [EXEC-05](../../prompts/roadmap/btc/exec-05-prova-integrada.md) | pending | Ainda não executado |
| [FRESH-01](../../prompts/roadmap/btc/fresh-01-cadencia-estimador.md) | pending | Ainda não executado |
| [FRESH-02](../../prompts/roadmap/btc/fresh-02-evidencia-frescor-livro.md) | pending | Ainda não executado |
| [FRESH-03](../../prompts/roadmap/btc/fresh-03-validade-ordens.md) | pending | Ainda não executado |
| [BTC-01](../../prompts/roadmap/btc/btc-01-adaptador-contrato.md) | pending | Ainda não executado |
| [BTC-02](../../prompts/roadmap/btc/btc-02-benchmark-asof.md) | pending | Ainda não executado |
| [BTC-03](../../prompts/roadmap/btc/btc-03-worker-sombra.md) | pending | Ainda não executado |
| [BTC-04](../../prompts/roadmap/btc/btc-04-cobertura-valida.md) | pending | Ainda não executado |
| [BTC-05](../../prompts/roadmap/btc/btc-05-plano-ativacao-sombra.md) | pending | Ainda não executado |
| [BTC-06](../../prompts/roadmap/btc/btc-06-adaptador-intent-paper.md) | pending | Ainda não executado |
| [BTC-07](../../prompts/roadmap/btc/btc-07-plano-ativacao-paper.md) | pending | Ainda não executado |
| [REPLAY-01](../../prompts/roadmap/btc/replay-01-dataset-export.md) | pending | Ainda não executado |
| [REPLAY-02](../../prompts/roadmap/btc/replay-02-carteira-finita.md) | pending | Ainda não executado |
| [REPLAY-03](../../prompts/roadmap/btc/replay-03-stress-dedup.md) | pending | Ainda não executado |
| [REPLAY-04](../../prompts/roadmap/btc/replay-04-relatorio.md) | pending | Ainda não executado |
| [EXP-01](../../prompts/roadmap/btc/exp-01-manifesto-congelado.md) | pending | Ainda não executado |
| [EXP-02](../../prompts/roadmap/btc/exp-02-avaliacao-prospectiva.md) | pending | Ainda não executado |
| [EXP-03](../../prompts/roadmap/btc/exp-03-decisao-evidencia.md) | pending | Ainda não executado |
| [GATE-01](../../prompts/roadmap/btc/gate-01-mandato-e-criterios.md) | pending | Ainda não executado |
| [GATE-02](../../prompts/roadmap/btc/gate-02-relatorio-de-prontidao.md) | pending | Ainda não executado |
| [GATE-03](../../prompts/roadmap/btc/gate-03-plano-de-microcapital.md) | pending | Ainda não executado |

## Referências

[Baseline datada](BASELINE-2026-09-10.md) e
[roteiro](../../prompts/roadmap/btc/README.md).
RFC-021 D3 já aprovada; RFC-022 D1–D3 presentes; RFC-028 A presente/B ausente na
baseline. Verificar HEAD e contexto atual. Draft não é deploy; pedido posterior de
executar um prompt vale para seu escopo, sem confirmação duplicada de código solicitado.
