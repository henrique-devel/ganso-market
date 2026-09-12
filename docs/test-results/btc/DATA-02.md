# DATA-02 — Proteções aplicadas e dry-run verificado

12/09/2026 UTC. Escopo exclusivo DATA-02/RFC-041. Código `725805e`, revisão
`1abfe74`, head do PR `cb37065`, merge/deploy `8132cd357ffb47340e39af278a65dc06469edb0f`.
[PR #161](https://github.com/henrique-devel/ganso-market/pull/161) integrado às
08:44:19Z. [CI do PR](https://github.com/henrique-devel/ganso-market/actions/runs/34683825275)
e [CI/deploy da main](https://github.com/henrique-devel/ganso-market/actions/runs/34684036786)
aprovaram Verify source e Verify Compose runtime. Deploy do PR foi skipped por
evento; deploy da main executou e concluiu success às08:49:04Z.

## Resultado e implementação

Política `data-02-v1`:69 tabelas de evidência/configs protegidas integralmente;
quatro resíduos Solana apenas inspecionáveis para revisão, também protegidos no
banco. Legado virou monitor de catálogo sem SELECT de raw ou DELETE/ANALYZE.
Quota/TTL declarados não autorizam retenção destrutiva. Exposição encerrada vira
zero por UPDATE, preservando identidade/cap/detalhe. Nenhum executor/exportador
foi criado. Seis arquivos de lógica e uma migration nova; anteriores imutáveis.

O [contrato/runbook](../../runbooks/retention-evidence.md) explicita fecho econômico,
raw/âncoras, pins integrais, coordenação até commit, manifesto/contagens e limites.
`data-02-synthetic-v1` classifica0xsonda com exclusão/motivo/contagem; identidade
desconhecida fica inelegível. Consumidores de métricas não foram modificados.

## Verificações locais reais

- `npm test`:2313 passed (API1994, web249, contracts70);191 skipped na API.
- `npm run format:check`, `npm run lint`, `npm run build`, API typecheck,
  `python3 scripts/scan_secrets.py`, `git diff --check`: passaram.
- PostgreSQL18.4 descartável local:16 testes `retention-manifest.pg.test.ts` e7
  `retention-protection.pg.test.ts` passaram, inclusive146 recusas DELETE/TRUNCATE,
  guards antigos idênticos, concorrência de escritores/pins e rollback.
- 3 testes direcionados `portfolio/integration.pg.test.ts` passaram com1–23
  migradas;31 casos excluídos pelo filtro, não passados. Cinco panel cycles reais
  confirmaram fechamento sem ressurreição, zero sem falsa brecha, identidade/cap
  preservados e rejeição de poda da decisão com proveniência intacta.
- CLI completo gerou manifesto local; SHA/hash/corte/expiração conferidos.
- A primeira tentativa sem escalada não alcançou localhost (`EPERM`), e não foi
  contada como PG passed. Falha inicial de tipo PostgreSQL `name[]` nas chaves e
  falha de relógio regressivo na fixture foram corrigidas e repetidas com sucesso.
- Revisão independente corrigiu predicado vs inspeção, bigint/UTC/bytes,
  controles de pins no catálogo, validade temporal e compatibilidade do painel.

SQL foi testado apenas nos bancos descartáveis `data02_test` e
`data02_runner_test`, localhost55523, schemas próprios ou banco de fixture.
O ensaio DB-03 de escrita/WAL rejeitado não foi executado nem reencaminhado.

## Produção: aplicação observada

Preflight08:40:32Z:foundation22; guards ledger/strategy enabled `O`; três
transações ativas, nenhuma com mais de5s na leitura; nenhuma linha econômica
consultada. SSH com host key fixada do registro vigente.

Migration0023 aplicada pelo deploy transacional. Checksum observado às08:50:23Z,
igual ao arquivo local: `fcc5b88258dd042d09853a5d7b164be961e67aa2bd6635f3e390c10b8c46ee18`.
Catálogo confirmou73 objetos e146/146 guards novos habilitados; ledger e strategy
continuaram com seus guards de imutabilidade habilitados. Pins lock/audit e audit
guard habilitados (tipos62/13/58). Nenhum DELETE/TRUNCATE de teste em produção.

Os profiles afetados reutilizaram a imagem API validada (mesmo Dockerfile), sem
dois builds extras; apenas recorder/portfolio foram recriados. Ambos retornaram
SHA embutido `8132cd3…` às08:49:53Z. PostgreSQL não foi recriado para esta ação.

**Limite operacional registrado:** pretendia-se pausar o portfolio antes da
migration. O deploy do núcleo terminou às08:49:04Z, antes do comando de pausa
às08:49:14Z; retomada às08:49:53Z (39s entre comando e retomada, não duração exata
da parada). O runner antigo era incompatível com o novo guard de exposições.
Não foi atestada ausência de falha transitória naquele intervalo; não atribuir
perda não comprovada. O runner compatível foi observado nos ciclos posteriores.

Janela de logs dos novos containers08:49:53–08:52:58Z:64 `RETENTION_PROTECTED`,
1 `ORCHESTRATOR_STARTED`,3 `PORTFOLIO_CYCLE` (último100 mercados),5
`PORTFOLIO_EXIT_CYCLE`,1 medição de gates e1 `PORTFOLIO_REPLAY_OK`. Foram observados
também16 `RTDS_GAP_PERSISTED`,8 `BOOK_DIVERGENCE`,1 `RTDS_UNKNOWN_FRAME` e1
`PORTFOLIO_BREAKER_OPENED`. Nenhum desses registros foi apagado, reclassificado
como saúde ou atribuído causalmente ao deploy sem investigação.

Contadores `pg_stat_user_tables`,08:50:23→08:52:37Z (`stats_reset` nulo na leitura):

| Tabela | Δ inserts | Δ updates | Δ deletes |
| --- | ---: | ---: | ---: |
| polymarket_book_deltas |14642|0|0|
| polymarket_rtds_prices |256|0|0|
| portfolio_decisions |75|0|0|
| portfolio_panel_snapshots |200|0|0|

São contadores sujeitos a lag, não completude por série nem inventário exato.
`make server-health` passou às08:53:11Z por localhost; api/web/postgres healthy e
serviços existentes running. `df` livre197360584/314748412KiB, acima do piso25%.
Não atribuir variação física à proteção, nem alegar ganho recuperável.

## Manifesto de produção

Uma tentativa do CLI, sem retry, gerou [manifesto preservado](DATA-02-manifest.json)
às08:51:26.576Z, expiração09:06:26.576Z; hash/id
`adbc67386cdf511c4c5f520018ccbdb90ade980610b85ff2b7ff078959fe6f4e`.
SHA8132cd3, schema/policy/triggers/índices/checksums fixados; hash validado localmente.
Objetos exatos `paper_orders` e `polymarket_book_deltas`, cutoff
`2026-09-01T00:00:00Z`:ambos HOLD,0 linhas inspecionadas e conjunto exato vazio,
sem estimativa apresentada como COUNT. `executionAllowed:false`. O artefato é
evidência histórica e expira; não é autorização de limpeza ou snapshot restaurável.

## Limites e continuidade

Aplicação técnica comprovada, sem soak/saúde dos feeds, poda, export/restauração,
benefício físico ou liberação de capacidade. Horizonte/pins finos e âncoras
permanecem desconhecidos; HOLD não promete caber indefinidamente no SSD.
Recomendação:custo externo0, manter HOLD até definir datasets/janelas/âncoras e
provar preservação. Alternativa posterior:aprovar recortes precisos com essas
provas; quota isolada nunca decide. Caps/paper/live/signer/perímetro inalterados.
Gates DB-02/03,Q4/headroom DB-04 continuam pendentes. DATA-03 pode iniciar preparação
de preservação com o contrato e proteções aplicados; nenhum outro bloco iniciado.

A primeira revisão automática recusou a criação local da migration por risco de
writers. Após comprovar worktree/PG descartáveis e substituir falha imediata de
writers por espera compartilhada curta, o artefato local foi aprovado. Ações de
entrega/produção passaram pelas permissões efetivas; nenhum bypass foi utilizado.
Git externo antigo e quatro artefatos/linhas locais DB-01/BTC-04 preservados.
