# Blocos BTC — roteiro de implementação e evidência

Pacote solicitado em **10/09/2026**. Novas RFCs são especificações; nenhuma mudança
na aplicação, deploy ou limpeza foi executada na criação destes documentos.

## Comece aqui

Uma sessão por prompt. Exemplo de pedido:

> Execute somente `prompts/roadmap/btc/ops-01-inventario-saude.md`.
> Siga o protocolo, confira código/dependências e entregue o recibo do bloco.
> Não avance automaticamente para outro bloco.

Para duas IAs, comece **OPS-01** e **FIN-01** em paralelo. DATA-01, DB-01 e BTC-01
são independentes; coordene consultas ao servidor para não somar scans pesados.
Leia [protocolo](00-protocolo.md), a seção da RFC e os 3–6 arquivos do prompt.
[Estado curto](../../../docs/roadmap/BTC_EXECUTION_STATE.md) registra progresso;
[recibo](../../../docs/roadmap/RECEIPT_TEMPLATE.md) carrega evidência de até 25 linhas.
[Baseline histórica](../../../docs/roadmap/BASELINE-2026-09-10.md) é leitura sob demanda.
Não carregar o HANDOFF antigo nem todos os prompts em cada sessão.

## Frentes e marcos

| Frente | Blocos | Resultado |
|---|---|---|
| Coleta | OPS | Detector, supervisor externo e recuperação observada |
| Capacidade | DB + DATA + FRESH | Consultas, retenção, limpeza e frescor sustentáveis |
| Dinheiro | FIN + QA → EXEC | Tokens, equity, exposição, reservas e saídas conciliados |
| BTC1h | BTC | Benchmark correto, sombra e paper com carteira própria |
| Evidência | REPLAY + EXP | Carteira finita e teste em dados novos, com controle |
| Progressão | GATE | Técnica, experimento e escala com critérios separados |

## Escolha um bloco

Dependências no frontmatter são a fonte da ordem. Esta tabela agrupa por frente,
não autoriza saltar pré-requisitos. Em uma mesma frente, os números também podem
ter dependências cruzadas: conferir antes de começar.

| Bloco / resultado | RFC | Depende de | Modo |
|---|---|---|---|
| [OPS-01 — Inventariar a falha atual sem alterar o servidor](ops-01-inventario-saude.md) | [RFC-021](../../../docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md) | — | read-only |
| [OPS-02 — Tornar o silêncio CLOB observável e recuperável](ops-02-silencio-clob.md) | [RFC-021](../../../docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md) | OPS-01 | code |
| [OPS-03 — Concluir gatilho e rearme condicionado da RFC021](ops-03-kill-switch-condicionado.md) | [RFC-021](../../../docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md) | OPS-01 | code |
| [OPS-04 — Preparar recuperação verificável e ensaio de coleta](ops-04-plano-recuperacao-soak.md) | [RFC-021](../../../docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md) | OPS-01, OPS-02, OPS-03, OPS-05, OPS-06, OPS-07 | operation-plan |
| [OPS-05 — Detectar silêncio RTDS com socket aberto](ops-05-silencio-rtds.md) | [RFC-021](../../../docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md) | OPS-01 | code |
| [OPS-06 — Supervisionar recorder fora do event loop](ops-06-supervisor-externo-recorder.md) | [RFC-021](../../../docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md) | OPS-01, OPS-02, OPS-05 | code |
| [OPS-07 — Persistir fechamento observado pelo sweep](ops-07-sweep-fechamento-monotonico.md) | [RFC-021](../../../docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md) | OPS-01 | code |
| [DB-01 — Medir gargalos e orçamento PostgreSQL](db-01-baseline-consultas.md) | [RFC-037](../../../docs/rfcs/RFC-037-consultas-e-recursos-postgres.md) | — | read-only |
| [DB-02 — Otimizar procura do último trade por mercado](db-02-ultimo-trade-por-mercado.md) | [RFC-037](../../../docs/rfcs/RFC-037-consultas-e-recursos-postgres.md) | DB-01 | code |
| [DB-03 — Otimizar consultas as-of sem olhar o futuro](db-03-rtds-e-livro-asof.md) | [RFC-037](../../../docs/rfcs/RFC-037-consultas-e-recursos-postgres.md) | DB-01 | code |
| [DB-04 — Dimensionar recursos e validar operação integrada](db-04-plano-recursos-e-validacao.md) | [RFC-037](../../../docs/rfcs/RFC-037-consultas-e-recursos-postgres.md) | DB-01, DB-02, DB-03 | operation-plan |
| [DATA-01 — Inventariar capacidade e consumidores de dados](data-01-inventario-capacidade.md) | [RFC-041](../../../docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md) | — | read-only |
| [DATA-02 — Proteger evidência e criar seletor único de dry-run](data-02-protecao-e-manifesto.md) | [RFC-041](../../../docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md) | DATA-01 | code |
| [DATA-03 — Verificar preservação antes de remover dados necessários](data-03-export-e-restore-isolado.md) | [RFC-041](../../../docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md) | DATA-02 | code |
| [DATA-04 — Implementar executor limitado com retomada e drift](data-04-poda-idempotente-limitada.md) | [RFC-041](../../../docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md) | DATA-03 | code |
| [DATA-05 — Preparar limpeza atual e política contínua sustentável](data-05-politica-e-manutencao.md) | [RFC-041](../../../docs/rfcs/RFC-041-limpeza-retencao-e-capacidade.md) | DATA-04, DB-04 | operation-plan |
| [FIN-01 — Fechar o contrato financeiro e suas fixtures](fin-01-contrato-financeiro.md) | [RFC-038](../../../docs/rfcs/RFC-038-contabilidade-e-risco-por-payoff.md) | — | read-only |
| [FIN-02 — Persistir o dono de cada evento financeiro](fin-02-atribuicao-do-ledger.md) | [RFC-038](../../../docs/rfcs/RFC-038-contabilidade-e-risco-por-payoff.md) | FIN-01 | code |
| [FIN-03 — Reconciliar PnL e equity por dono](fin-03-pnl-e-equity.md) | [RFC-038](../../../docs/rfcs/RFC-038-contabilidade-e-risco-por-payoff.md) | FIN-02 | code |
| [FIN-04 — Medir exposição por perda possível](fin-04-exposicao-por-payoff.md) | [RFC-038](../../../docs/rfcs/RFC-038-contabilidade-e-risco-por-payoff.md) | FIN-03 | code |
| [FIN-05 — Reservar dinheiro e inventário atomicamente](fin-05-reservas-atomicas.md) | [RFC-038](../../../docs/rfcs/RFC-038-contabilidade-e-risco-por-payoff.md) | FIN-04 | code |
| [FIN-06 — Entrar em YES/NO pelo token real](fin-06-tokens-reais.md) | [RFC-038](../../../docs/rfcs/RFC-038-contabilidade-e-risco-por-payoff.md) | FIN-05 | code |
| [FIN-07 — Provar reconciliação financeira](fin-07-reconciliacao-financeira.md) | [RFC-038](../../../docs/rfcs/RFC-038-contabilidade-e-risco-por-payoff.md) | FIN-06, QA-01 | read-only |
| [QA-01 — executar de verdade os testes PostgreSQL](qa-01-postgres-no-ci.md) | [RFC-038](../../../docs/rfcs/RFC-038-contabilidade-e-risco-por-payoff.md) | FIN-01 | code |
| [EXEC-01 — Corrigir dupla incidência de custos](exec-01-custos-sem-duplicacao.md) | [RFC-034](../../../docs/rfcs/RFC-034-execucao-economica-da-ordem-final.md) | FIN-01 | code |
| [EXEC-02 — Revalidar EV no tamanho e tipo finais](exec-02-ev-da-ordem-final.md) | [RFC-034](../../../docs/rfcs/RFC-034-execucao-economica-da-ordem-final.md) | EXEC-01, FIN-03, FIN-06 | code |
| [EXEC-03 — Reconciliar fills e cancelamento paper](exec-03-fills-fees-e-cancelamento.md) | [RFC-034](../../../docs/rfcs/RFC-034-execucao-economica-da-ordem-final.md) | EXEC-02, FIN-05 | code |
| [EXEC-04 — Concluir RFC-022 D4-A para os dois lados](exec-04-saidas-reduce-only.md) | [RFC-034](../../../docs/rfcs/RFC-034-execucao-economica-da-ordem-final.md) | EXEC-03, FIN-07 | code |
| [EXEC-05 — Provar execução integrada com carteira finita](exec-05-prova-integrada.md) | [RFC-034](../../../docs/rfcs/RFC-034-execucao-economica-da-ordem-final.md) | EXEC-04, QA-01 | read-only |
| [FRESH-01 — Alinhar cadência BTC à validade atual da estimativa](fresh-01-cadencia-estimador.md) | [RFC-030](../../../docs/rfcs/RFC-030-cadencia-estimador-e-ttl.md) | DB-04 | code |
| [FRESH-02 — Confirmar livro inalterado com evidência externa](fresh-02-evidencia-frescor-livro.md) | [RFC-031](../../../docs/rfcs/RFC-031-frescor-livro-e-validade-ordens.md) | OPS-02, DB-04 | code |
| [FRESH-03 — Limitar ordem ao prazo executável antes do fim](fresh-03-validade-ordens.md) | [RFC-031](../../../docs/rfcs/RFC-031-frescor-livro-e-validade-ordens.md) | FRESH-02, EXEC-04 | code |
| [BTC-01 — Normalizar o contrato BTC horário](btc-01-adaptador-contrato.md) | [RFC-039](../../../docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md) | — | code |
| [BTC-02 — Benchmark Binance com disponibilidade temporal](btc-02-benchmark-asof.md) | [RFC-039](../../../docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md) | BTC-01 | code |
| [BTC-03 — Worker BTC observacional e idempotente](btc-03-worker-sombra.md) | [RFC-039](../../../docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md) | BTC-02 | code |
| [BTC-04 — Medir cobertura e validade por mercado](btc-04-cobertura-valida.md) | [RFC-039](../../../docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md) | BTC-03, DATA-02 | code |
| [BTC-05 — Preparar ativação e observar a sombra](btc-05-plano-ativacao-sombra.md) | [RFC-039](../../../docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md) | BTC-04, OPS-04, FRESH-02, EXP-01 | operation-plan |
| [BTC-06 — Conectar intent BTC à carteira paper isolada](btc-06-adaptador-intent-paper.md) | [RFC-039](../../../docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md) | FIN-07, EXEC-05, BTC-03 | code |
| [BTC-07 — Preparar operação paper com mandato explícito](btc-07-plano-ativacao-paper.md) | [RFC-039](../../../docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md) | BTC-05, BTC-06, REPLAY-04, EXP-01, FRESH-03 | operation-plan |
| [REPLAY-01 — Dataset verificável e contrato de preservação](replay-01-dataset-export.md) | [RFC-032](../../../docs/rfcs/RFC-032-replay-carteira-finita-evidencia.md) | BTC-02 | code |
| [REPLAY-02 — Executar uma carteira finita de US$1.000](replay-02-carteira-finita.md) | [RFC-032](../../../docs/rfcs/RFC-032-replay-carteira-finita-evidencia.md) | REPLAY-01, FIN-07, EXEC-05 | code |
| [REPLAY-03 — Stress causal e contagens independentes](replay-03-stress-dedup.md) | [RFC-032](../../../docs/rfcs/RFC-032-replay-carteira-finita-evidencia.md) | REPLAY-02 | code |
| [REPLAY-04 — Relatório econômico reproduzível](replay-04-relatorio.md) | [RFC-032](../../../docs/rfcs/RFC-032-replay-carteira-finita-evidencia.md) | REPLAY-03, DATA-02 | code |
| [EXP-01 — Manifesto de experimento e controles](exp-01-manifesto-congelado.md) | [RFC-033](../../../docs/rfcs/RFC-033-experimento-prospectivo-btc.md) | BTC-01 | code |
| [EXP-02 — Avaliação prospectiva por mercado e dia](exp-02-avaliacao-prospectiva.md) | [RFC-033](../../../docs/rfcs/RFC-033-experimento-prospectivo-btc.md) | EXP-01, REPLAY-04, BTC-04 | code |
| [EXP-03 — Registrar a decisão do experimento](exp-03-decisao-evidencia.md) | [RFC-033](../../../docs/rfcs/RFC-033-experimento-prospectivo-btc.md) | EXP-02 | code |
| [GATE-01 — mandato experimental BTC sem alterar gates legados](gate-01-mandato-e-criterios.md) | [RFC-040](../../../docs/rfcs/RFC-040-experimento-btc-e-progressao-de-capital.md) | EXP-01 | read-only |
| [GATE-02 — relatório separado de prontidão](gate-02-relatorio-de-prontidao.md) | [RFC-040](../../../docs/rfcs/RFC-040-experimento-btc-e-progressao-de-capital.md) | GATE-01, EXP-03, EXEC-05 | code |
| [GATE-03 — preparar decisão concreta de microcapital](gate-03-plano-de-microcapital.md) | [RFC-040](../../../docs/rfcs/RFC-040-experimento-btc-e-progressao-de-capital.md) | GATE-02 | operation-plan |

## Continuidade e limites

Alvo por sessão: até 1.500 palavras de contexto documental inicial; um resultado,
até 6 arquivos de lógica e uma migration. Dividir se o contrato mínimo exigir mais,
sem ativar stub. Não executar o próximo prompt automaticamente.

`code` implementa/testa localmente; `read-only` inspeciona e escreve evidência local;
`operation-plan` prepara operação concreta e só aplica quando coberta pela autorização
vigente. Plano pronto não significa aplicado/observado, limpeza feita ou soak completo.
A criação deste pacote não autoriza execução real ou DELETE em produção.

Código do avaliador pode ser validado com fixtures. Resultado prospectivo exige
manifesto congelado antes da janela e dados novos observados; paper exige rollout
paper efetivamente observado. Verificar recibo, não apenas rótulo de status.

DATA-01 inventaria; DATA-02 protege; DATA-03 verifica preservação; DATA-04 implementa
poda limitada; DATA-05 prepara/aplica apenas limpeza autorizada e política contínua.
Ledger e datasets protegidos não são descartados para satisfazer quota.

RFC-035 (macro) e RFC-036 (outros símbolos) ficam reservadas/adiadas, sem prompts.
030–034 e 037 preservam a numeração do diagnóstico; 038–040 fecham lacunas econômicas
/contratuais e 041 inclui limpeza de dados. Sem migração de infraestrutura neste ciclo.
