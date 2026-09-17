# Estado curto — blocos BTC

Atualizado em 12/09/2026 UTC: **RFC-021 OPS-01 a OPS-07 reunidas para entrega**.
Implementação e evidências locais conforme linhas abaixo; OPS-04 é plano operacional.
O PR e a validação da release não substituem observação de produção nem soak.
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
| [OPS-01](../../prompts/roadmap/btc/ops-01-inventario-saude.md) | code-verified | [Recibo](receipts/OPS-01.md): mapa local em c528d5b; D1–D3 ausentes naquela base. Identidade SSH reconciliada pelo console do proprietário em 12/09 UTC; [entrega integrada](../test-results/btc/RFC-021-release.md) |
| [OPS-02](../../prompts/roadmap/btc/ops-02-silencio-clob.md) | code-verified | [Recibo](receipts/OPS-02.md): patch local sobre c528d5b; silêncio CLOB/controle REST/recovery limitada + migration0021; 127 testes e typecheck passaram; reason codes e contrato na evidência; sem deploy |
| [OPS-03](../../prompts/roadmap/btc/ops-03-kill-switch-condicionado.md) | code-verified | [Recibo](receipts/OPS-03.md): D2/D3 implementadas; 15 ticks/900s com resets, auditoria e proteções; 168 testes + 8 PostgreSQL e typecheck passaram; sem deploy |
| [OPS-04](../../prompts/roadmap/btc/ops-04-plano-recuperacao-soak.md) | code-verified | [Recibo](receipts/OPS-04.md): [plano pronto](../runbooks/btc-recovery.md), não aplicado; Q1–Q4 verificadas em PostgreSQL descartável; retomar gate §1: entregar release integrada OPS-02/03/05/06/07 e verificar telemetria; identidade SSH reconciliada em 12/09 UTC; sem janela/soak observado |
| [OPS-05](../../prompts/roadmap/btc/ops-05-silencio-rtds.md) | code-verified | [Recibo](receipts/OPS-05.md): silêncio RTDS global/por série, 120 s configurável, gaps idempotentes e retomados após restart, recovery limitado; 66 testes verificados incluindo PG descartável + typecheck; sem deploy/soak |
| [OPS-06](../../prompts/roadmap/btc/ops-06-supervisor-externo-recorder.md) | code-verified | [Recibo](receipts/OPS-06.md): heartbeat + supervisor externo com DB distinto, evidência no host, lock/backoff/3 tentativas por hora e instalador reversível; 56 testes verificados; [handoff OPS-04](../runbooks/recorder-watchdog.md); não instalado/ativado, sem saúde/soak atestado |
| [OPS-07](../../prompts/roadmap/btc/ops-07-sweep-fechamento-monotonico.md) | code-verified | [Recibo](receipts/OPS-07.md): D4 ausente na base, implementada com UPDATE monotônico antes dos eventos e retry observável; 302 testes (5 PostgreSQL). Leitores: API expõe/filtra closed; estimador exclui; labels/settlement exigem resolução e outcome. Upserts preservados; sem deploy. OPS-04 valida servidor, sem inferir resolução de COUNT(closed) |
| [DB-01](../../prompts/roadmap/btc/db-01-baseline-consultas.md) | pending | Ainda não executado |
| [DB-02](../../prompts/roadmap/btc/db-02-ultimo-trade-por-mercado.md) | code-verified | [Recibo](receipts/DB-02.md): retomada PR #163, workload individual com guards 0023; 40k amostras/58,857 s e 8 testes; 3/8 agregados e 15/32 rodadas reprovados, WAL +768.212 B; histórico #157 preservado; índice suspenso, promoção/ensaio DB-04 pendentes; autorização atual registrada, sem aplicação produtiva |
| [DB-03](../../prompts/roadmap/btc/db-03-rtds-e-livro-asof.md) | code-verified | [Recibo](receipts/DB-03.md): PR #164, retomada autorizada de escrita/WAL; runner exclusivo/protocolo com SQL real, HOLD 0023, identidade/limites e dez testes offline; ensaio definitivo atribuído a DB-04, não executado aqui; recusas antigas sem aprovação pendente; leitura PR #158/55 testes históricos intactos, runtime preservado por buffers até 4,70× sem índice; Q3/Q4 intactos e adiamento Q4/DB-03B aprovado; promoção pendente |
| [DB-04](../../prompts/roadmap/btc/db-04-plano-recursos-e-validacao.md) | code-verified | [Recibo](receipts/DB-04.md): retomada PR #165; escrita autorizada única12k amostras/20,008s,1/4 agregados e8/16 rodadas reprovados,só1/4 cenários passa,WAL+1.303.328B,HOLD/zero perda;14+10+12 verificações offline;PG1CPU/1GiB throttling100%,reserva sustentada não comprovada;PGDATA/WAL/tablespaces no volume real62,592384%livre;recusas antigas respondidas,Q4/DB03B/compactação adiados;índices suspensos,sem aplicação/aceite integrado/soak;DATA-01 independente |
| [DATA-01](../../prompts/roadmap/btc/data-01-inventario-capacidade.md) | production-verified | [Recibo](receipts/DATA-01.md): PR #166/merge97c2787, série finita8slots via watchdog instalada manualmente,CD skipped/manutenção restaurada;1ªamostra12/09 17:03:55 UTC em1,392s,DB91,770GiB/FS real62,670993%disponível/WAL128MiB;115testes+CI PR/main passam;último slot19/09 17:03:34 UTC,fecha18:03:34;zero intervalos/sem7dias/crescimento sustentado/saúde/soak;HOLD/230imagens/11containers/5backups preservados;histórico #160 intacto |
| [DATA-02](../../prompts/roadmap/btc/data-02-protecao-e-manifesto.md) | production-verified | [Recibo](receipts/DATA-02.md): PR #161 integrado8132cd3; checks PR/main/deploy passaram; schema23/146guards +ledger/strategy/pins habilitados; recorder/portfolio no SHA,3panel/5exit cycles e persistência limitada observada; manifesto produção HOLD orders/deltas0candidatos;2313 source passed/191 skipped e26 PG reais; sem poda/export/soak/saúde dos feeds; horizontes/pins finos e gates herdados pendentes; DATA-03 elegível; decisão aprovada manter HOLD; novos dados/experimentos exigem orçamento+fecho protegido/preservado; delta documental, sem nova admissão/limpeza/certificação produtiva; arquivos/admissão DATA-05 |
| [DATA-03](../../prompts/roadmap/btc/data-03-export-e-restore-isolado.md) | code-verified | [Recibo](receipts/DATA-03.md): [PR #169](https://github.com/henrique-devel/ganso-market/pull/169) integrado em 95f752b; Verify source e Verify Compose runtime aprovados no PR e na main; Deploy production: skipped. HOLD mantido; certificados de fixture não autorizam exclusão real |
| [DATA-04](../../prompts/roadmap/btc/data-04-poda-idempotente-limitada.md) | pending | Ainda não executado |
| [DATA-05](../../prompts/roadmap/btc/data-05-politica-e-manutencao.md) | pending | Ainda não executado |
| [FIN-01](../../prompts/roadmap/btc/fin-01-contrato-financeiro.md) | code-verified | [Recibo](receipts/FIN-01.md): especificação financial-v2 e seis fixtures manuais conferidas; dono/legado/precisão/UTC/reservas e esquema aditivo proposto; sem runtime/migration/SQL/aceite produtivo; FIN-02 elegível |
| [FIN-02](../../prompts/roadmap/btc/fin-02-atribuicao-do-ledger.md) | implemented | [Recibo](receipts/FIN-02.md): migration 0024 e atribuição v1 atômica por dono/token; 163 testes focados (16 PG reais), PR #172 integrado; verificação operacional detalhada entregue localmente; sem novo consumidor financeiro; FIN-03 elegível |
| [FIN-03](../../prompts/roadmap/btc/fin-03-pnl-e-equity.md) | code-verified | [Recibo](receipts/FIN-03.md): PR #175/merge9a9461c, financial-v2 por dono, C=C0+R−ΣsB/E=C0+R+ΣU, bid-ask/fees únicas/buckets UTC/cache0024; 95 testes focados (8 PG reais), CI/CD aprovado e versão/proteções verificadas; consulta financeira produtiva recusada antes de executar, autorização específica pendente; sem aceite integrado/soak |
| [FIN-04](../../prompts/roadmap/btc/fin-04-exposicao-por-payoff.md) | code-verified | [Recibo](receipts/FIN-04.md): PR #177/merge ff81cf5; payoff/dono, short/fees e soma conservadora sem max-negRisk; 116 testes (9 PG), make verify e CI/CD aprovados; API/portfolio no SHA, ciclo payoff-v1 observado; caps/configurações preservados, sem reservas/soak; contrato FIN-05 documentado; fecho adicional local (publicação recusada) |
| [FIN-05](../../prompts/roadmap/btc/fin-05-reservas-atomicas.md) | code-verified | [Recibo](receipts/FIN-05.md): PR #179/merge f381ceb, reservation-v1/0025 e dono atômico; 237 testes (45 PG reais), disputa US$600+US$500/US$1.000 com lock observado; make verify e CI/CD aprovados; API/paper/portfolio no SHA, schema/checksum/5 triggers verificados; sem reconciliação produtiva/soak/caps/validade/live novos; contrato EXEC-03/04 entregue |
| [FIN-06](../../prompts/roadmap/btc/fin-06-tokens-reais.md) | code-verified | [Recibo](receipts/FIN-06.md): PR181 e reparos182–184 integrados; decisão/ordem v2, BUY YES/NO com livro/bound reais; 479 focados/46 PG, regressões20PG/23runner e make verify/CI/CD aprovados; reparo SQL de mids integrado; evidência operacional final preservada localmente; replay v1/short legado intactos; sem migration/caps/worker/EV final/D4 novos ou reconciliação produtiva/soak |
| [FIN-07](../../prompts/roadmap/btc/fin-07-reconciliacao-financeira.md) | blocked | [Recibo](receipts/FIN-07.md): base e21e35a; QA-01/PG18.4/25migrations, 292 passed/zero skips (261SQL+31unit); F1–F6 e quatro casos integrados, caches v2/reservas/retry/restart exatos; F4/a2 legado R0,743333 vs v2 1,010000000, diferença0,266667 pendente [FIN-03/#187](https://github.com/henrique-devel/ganso-market/issues/187); sem prontidão global/histórico produtivo/runtime/worker; artefatos e reprodução no relatório |
| [QA-01](../../prompts/roadmap/btc/qa-01-postgres-no-ci.md) | code-verified | [Recibo](receipts/QA-01.md): gate PG obrigatório; PostgreSQL 18.4/25 migrations; 23 arquivos, 288 passaram (257 PG + 31 unitários), zero skips; falha deliberada/skip/banco ausente reprovam; make verify passou; [CI remoto source/PG/Compose aprovado](https://github.com/henrique-devel/ganso-market/actions/runs/35143383470); publicação acompanhada no [PR #186](https://github.com/henrique-devel/ganso-market/pull/186) |
| [EXEC-01](../../prompts/roadmap/btc/exec-01-custos-sem-duplicacao.md) | code-verified | [Recibo](receipts/EXEC-01.md): d8cf2e7, ev-costs-v2; EV=payoff conservador−preço−fee−capital excedente−buffer−seleção maker; slippage/unwind diagnósticos preservados; 124 focados/6 regressões negativas, make verify e 288 PG passaram; EXEC-02 chama computeExecutionEv, sem conexão final ao broker |
| [EXEC-02](../../prompts/roadmap/btc/exec-02-ev-da-ordem-final.md) | code-verified | [Recibo](receipts/EXEC-02.md): PR190/191, merge18a6c20, final-entry-v1/ordem v3; EV comum após normalização e antes da reserva, dono/token/livro/fee e auditoria append-only; 297 focados/294 PG reais, make verify passou; livro raso, recotação, fee null e EV insuficiente recusam; sem expiry/D4/caps/live; CI PR/main/deploy aprovados; API/paper no SHA e fixture pura conferida17/09 00:21Z; disputa de lock provada, sem amostra econômica/soak |
| [EXEC-03](../../prompts/roadmap/btc/exec-03-fills-fees-e-cancelamento.md) | code-verified | [Recibo](receipts/EXEC-03.md): paper-fill-v2, parcial/cancel efetivo, fees verificáveis e profundidade compartilhada; 215 focados/295 PG reais e make verify passaram; cobertura maker/taker; PR193/merge e3ce391, CI PR/main e deploy API aprovados; paper preservado em18a6c20 sem reinício, aplicação nele pendente; sem G4/live/worker novos |
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
