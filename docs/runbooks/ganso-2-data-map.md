# G2-02.1 — Mapa de preservação e retenção

Contrato documental `g2-02.1-v1`, base `a8e4833`, [RFC-044/S1](../rfcs/RFC-044-ganso-2-preservacao-retencao.md#s1), RF-15/RF-16.
**O conjunto liberado para descarte é vazio.** Financeiro, versões, decisões e
corpus de pesquisa permanecem no banco; o raw legado continua sob HOLD integral.
Este mapa classifica e dimensiona dados, sem alterar seletores, pins, schema ou
execução. G2-00.2 e G2-01.1 estão integrados; a quiescência de G2-01.2 não elimina
os consumidores de consulta/replay.

## Inventário por classe

A notação `prefixo_{a,b}` enumera apenas `prefixo_a` e `prefixo_b`, nunca um
curinga executável. As classes abaixo particionam as **86 tabelas públicas**
observadas; objeto novo/desconhecido fica protegido até classificação.

| Classe | Conjunto fechado / destino |
| --- | --- |
| F — Financeiro (11) | `paper_{orders,ledger_events,positions,kill_switch,financial_owners,order_owners,ledger_owners,owner_positions,order_reservations}`, `portfolio_position_entries`, `fast_wallet_state`. Permanentes: eventos/idempotência, ordens inclusive terminais, atribuição por dono e suas versões, reservas, posições e capital de origem conhecida ou desconhecida. |
| D — Decisões e controle (16) | `strategy_decisions`, `fast_config_versions`, `portfolio_{decisions,panel_snapshots,config_versions,factor_map_versions,circuit_breakers,cycle_summary,decision_hourly,exposures,g2_clock,g2_clock_events,gate_measurements,gate_reports,state,state_events}`. Preservar decisões aceitas/recusadas, versões/hashes, gates e estado; resumo horário e painel não substituem a decisão. |
| L — Livro raw (3) | `polymarket_{book_deltas,book_snapshots_full,book_snapshots}`. Preservar âncoras, deltas e snapshots usados pelo broker, marcação, calibração, API e replay; sem horizonte seguro de descarte demonstrado. |
| R — Outros insumos raw (3) | `polymarket_{trades,rtds_prices,oi_holders}`. Corpus de pesquisa e insumos de execução/modelos; HOLD integral enquanto referências e janelas não estiverem delimitadas. |
| P — Pesquisa e agregados (12) | `fundamental_{models,model_events,estimates,labels,gate_reports,calibration_reports}`, `paper_{feature_windows,fill_samples,fill_reports,markouts}`, `polymarket_{series_1m,rtds_1m}`. Manter no banco modelos, treino/validação, estimativas as-of, labels, features, calibração, relatórios e insumos correspondentes. |
| C — Contexto e proveniência (29) | `app_settings`, `audit_events`, `graph_{edges,sanity_vetoes,violations}`, `polymarket_{data_gaps,event_markets,events,macro_calendar,macro_releases,market_metadata_versions,markets,param_versions,resolution_events,resolution_input_changes,retention_log,rule_versions,universe_log}`, `resolution_{adjudication_samples,clarifications,layer_divergences,market_state,onchain_cursor,onchain_events,reports,runtime_state,score_versions,scores,uma_timeline}`. Preservar identidade token/mercado/outcome, versões, taxas/regras, qualidade, resolução, contexto macro e auditoria. |
| I — Pins (2) | `retention_evidence_pins`, `retention_pin_events`. Preservar controle/auditoria; pin v1 fixa tabela inteira. Nenhum pin explícito encontrado nesta leitura; isso não libera HOLD nem comprova ausência de datasets. |
| S — Resíduos sem consumidor (4) | `domain_events`, `event_quarantine`, `bonding_curve_state`, `pumpswap_pool_state`. Candidatos apenas a revisão: nenhum consumidor de negócio localizado em `apps/api/src`, `services`, `workers`, `deploy` e `config`; só referências nos módulos de retenção/arquivo. As quatro tabelas estão vazias nesta leitura. Linhas futuras exigem nova classificação. |
| O — Operação fora da política DATA (6) | `auth_{accounts,sessions,access_tokens,refresh_tokens,login_throttle}`, `schema_versions`. Necessários a autenticação/migrations; não pertencem ao descarte proposto nem herdam TTL de raw. |

## Fechamento transitivo e proteções

O conjunto protegido F+D+L+R+P+C contém **74 tabelas**: as 69 de
[`EVIDENCE_TABLES`](../../apps/api/src/polymarket/retention-policy.ts) mais as cinco
financeiras de [0024](../../migrations/0024_paper_financial_ownership.sql) e
[0025](../../migrations/0025_paper_order_reservations.sql), preservadas por 0026.
Os cinco objetos novos não integram a allowlist antiga de manifesto/pins;
possuem guards explícitos e a política de objeto desconhecido protege por padrão.
Não interpretar essa diferença como lacuna autorizada para poda.

Conferência de `pg_constraint`: **18 FKs** saem desse conjunto e todas terminam
nele, inclusive ao percorrer as referências até ponto fixo. As outras três FKs
são internas à autenticação; nenhuma FK envolve S. Foram conferidos **156
triggers DATA habilitados** (escrita e DELETE/TRUNCATE nas 78 tabelas F–S, sem I)
e os três de controle/auditoria de pins. O HOLD de statement também recusa
remoção em tabelas vazias; não foi ensaiado DELETE/TRUNCATE em produção.

O fecho conservador inclui as dependências lógicas que FKs não representam:

| Raiz / referência | Dependências que permanecem protegidas |
| --- | --- |
| Reserva e posição por dono | Reserva → versão de ownership → ordem → ledger; dono/capital, versões anteriores, `last_event_id`, eventos de aceite/fill/cancelamento/resolução. [FIN-05](../../migrations/0025_paper_order_reservations.sql) reconcilia pelos eventos, não apenas pelo status da ordem. |
| Ordem, ledger e tese de entrada | `order_id`, `decision_id`, `strategy_id`, token/condition e `fill_key` → decisões, `portfolio_position_entries`, atribuições, markouts/amostras. Parte desses vínculos não possui FK. Preservar também `payload_json`, `book_json`, `inputs_json` e versões de custo/fee usadas pelo [broker](../../apps/api/src/polymarket/paper/brokerstore.ts). |
| Decisão e pesquisa | Config/hash, factor map, rule/param/score, modelo/proveniência e timestamps → versões, estimativas/labels, features, resolução/grafo, gaps e fontes raw. O [replay de decisão](../../apps/api/src/polymarket/portfolio/replay.ts) e a [análise de fonte](../../apps/api/src/polymarket/portfolio/sourcereplay.ts) têm contratos diferentes; nenhum autoriza eliminar insumos de pesquisa. |
| Livro, fill e janela pinada | Token/janela → snapshot completo anterior ao início + todos os deltas necessários até o fim, trades, timestamps source/received, gaps, parâmetros e identidade de mercado as-of. [`bookAt`](../../apps/api/src/polymarket/replay.ts) usa âncora inclusiva e deltas posteriores até o instante inclusivo; a API ainda consulta esse acervo. |

Reter o superset inteiro fecha essas arestas sem inventar pins por linha. Isso
confere **cobertura de proteção**, não certifica completude histórica, ausência
de órfãos ou replay integral do corpus. `ON DELETE SET NULL` de painel→decisão
também destruiria proveniência; ausência de erro FK não seria prova de segurança.
Snapshot reduzido, agregado de minuto, relatório ou book slice de fill não
substituem L2/continuidade para simular fila. O perfil de fixture
[`raw-l2`](../../apps/api/src/polymarket/retention-archive-replay.ts) não constitui
contrato de substituição do corpus produtivo.

Reutilizar o contrato [DATA](retention-evidence.md):
[`selectRetentionCandidates`](../../apps/api/src/polymarket/retention-manifest.ts)
retorna `FALSE`/conjunto vazio para evidência ou pin; S admite somente inspeção
por PK, até `limit+1` (padrão 100, teto 1000), depois cutoff UTC. Manifesto tem
SHA, hashes de schema/política, watermark e validade ≤15 min, sempre
`executionAllowed:false`. Lock `(741041,2)` coordena escritor, pin e seletor até
commit. Remover pin não libera HOLD; quota não o sobrepõe.

Raw **sem referências transitivas e sem consumidor**, fora das janelas/âncoras
de pesquisa e dos pins, é candidato conceitual para G2-02.5. Nenhuma fatia
Polymarket satisfaz esse critério demonstradamente nesta sessão; não há seletor
DATA liberando-a. S está vazio, portanto não oferece economia por remoção de
linhas. Um futuro conjunto exige objetos/chaves/cortes exatos, revisão de
consumidores, coordenação/proteções e autorização específica; não desligar HOLD.

## Capacidade por catálogo e limites

Leitura produtiva em **23/09/2026, 01:33–01:35 UTC**, SSH com identidades
conferidas; schema foundation **26**, política `data-02-v1`. Transação READ ONLY,
statement 1,5 s / lock 100 ms / transação 8 s. Tamanhos vêm de
`pg_total_relation_size` e `pg_indexes_size`, sem COUNT/ANALYZE/scan de raw;
presença em S foi conferida por `EXISTS … LIMIT 1`, pins limitados a 1001.

| Classe | Ocupação física, GiB | Índices incluídos, GiB |
| --- | ---: | ---: |
| F — Financeiro | 0,034302 | 0,018784 |
| D — Decisões/controle | 4,657860 | 0,901512 |
| L — Livro raw | 172,765854 | 84,318375 |
| R — Outros raw | 5,137787 | 2,370300 |
| P — Pesquisa/agregados | 7,548889 | 3,064034 |
| C — Contexto/proveniência | 0,668610 | 0,117455 |
| I — Pins | 0,000038 | 0,000023 |
| S — Resíduos vazios | 0,000107 | 0,000076 |
| O — Operação | 0,000336 | 0,000214 |

Soma das relações públicas: **204.884.738.048 bytes (190,814 GiB)**;
banco completo: **204.897.834.687 bytes (190,826 GiB)**. Incluem alocação de
heap/TOAST/índices, não apenas linhas vivas; `reltuples` é estimativa e `-1`
significa desconhecido. Índices não são bytes adicionais à coluna de ocupação.
Não se estima tamanho de uma fatia descartável a partir do tamanho da tabela.
DELETE não implica devolução ao filesystem; bytes recuperáveis permanecem
**indeterminados**, sem compactação autorizada.

Filesystem do volume PG: 322.302.373.888 bytes totais, 95.671.382.016 disponíveis
(**89,101 GiB / 29,684%**), **14,059 GiB acima do piso de 25%**. O superset
necessário permanece dimensionado integralmente; não pressupor economia legada
para fazer caber o BTC. Reservar hipoteticamente 10 GiB de raw deixaria só
4,059 GiB dessa margem para índices adicionais, WAL, temporários e outros
crescimentos: não comprova admissão. Amostra única não projeta 90 dias.

| Classe / âmbito | Limite operacional |
| --- | --- |
| Legado protegido e pins | TTL efetivo nulo. TTLs/quotas em [`RETENTION_TABLES`](../../apps/api/src/polymarket/retention.ts) e orçamento global de 110 GiB são declarações históricas de monitoramento, não espaço reservado nem autorização de limpeza. |
| Financeiro/decisões/versões BTC e respostas Jev | Permanentes durante o projeto; preservar respostas/custo e dependências com cada decisão. Contratos futuros, sem tabelas BTC/Jev encontradas neste catálogo. |
| Raw BTC sem referências/pins | Proposta do [PRD §10.1](../PRD-GANSO-2.0.md#101-política-para-novos-dados): até 7 dias e 10 GiB, sujeitos à capacidade; implementação/admissão em G2-02.4. |
| Barras/features novas; logs novos | Proposta: 12 meses; 14 dias com rotação por bytes, respectivamente. Evidência de decisão/experimento/incidente prevalece; esses TTLs não se aplicam retroativamente ao corpus legado. |

No limite, recusar captura não essencial/novo experimento e sinalizar; nunca
descartar dados protegidos para caber. Esta entrega não compra armazenamento,
não remove HOLD e não implanta serviços. O próximo uso do mapa cabe às sessões
explicitamente selecionadas pelo proprietário.
