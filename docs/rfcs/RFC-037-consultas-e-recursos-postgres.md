# RFC-037 — Consultas limitadas e recursos medidos no servidor atual

**Status:** draft — especificação solicitada em 2026-09-10; não implementada por este documento.
**Prioridade:** fundação operacional. **Blocos:** DB-01 a DB-04.
**Dependências:** RFC-023 existente; nova RFC-041 para limpeza e manutenção física.

## Problema e base no repositório

`docker-compose.yml` limita Postgres a 1 CPU, 1024 MiB e 40 conexões. Pools possuem
orçamentos explícitos em `database.ts`, mas orçamento não corrige plano SQL caro.
O diagnóstico apontou consultas repetidas sobre trades, RTDS e snapshots. São
hipóteses de gargalo a confirmar na versão em execução, não novos fatos medidos.

## Decisões propostas

1. DB-01 produz baseline datada: SHA por processo, limites reais, pools somados,
   conexões ativas/esperando, CPU throttling, RAM, I/O, lock waits, temp files,
   latência e timeouts por consulta. Ler `pg_stat_statements` se já disponível;
   ausência da extensão não justifica instalação automática para inventário.
2. Começar com `EXPLAIN` sem execução e estimativas. `EXPLAIN ANALYZE` apenas para
   SELECT estreito e com orçamento conhecido; registra buffers, parâmetros e
   distribuição da fixture. Não executar varredura gigante para provar que é cara.
3. DB-02 otimiza a procura de último trade por mercado. DB-03 otimiza leitura RTDS
   as-of e consulta de livro/snapshot identificada pelo baseline, preservando
   identidade, desempate e causalidade (`source_ts` e `received_at` ≤ decisão).
   Se forem dois gargalos independentes extensos, dividir DB-03 em subblocos antes
   de codar, registrando IDs no estado; não expandir para refactor geral.
4. Índices e consultas são justificados por planos antes/depois e equivalência de
   resultados. Medir custo adicional de escrita, espaço físico e uso do índice.
   Índices redundantes só são removíveis após comprovar dependências e uso.
5. A migration runner usa transação única; `CREATE INDEX CONCURRENTLY` exige plano
   operacional separado compatível com essa restrição. Numerar migration pelo
   próximo slot disponível; preservar migrations aplicadas e rollback de consulta.
6. DB-04 prepara tuning do servidor atual baseado em orçamento total: limite CPU,
   `shared_buffers`, `work_mem` por operação × sessões simultâneas, manutenção,
   pools e reserva OS. Não assumir que 2–4 CPUs ou mais RAM são sempre melhores.
   Distinguir ajustes online de parâmetros que exigem restart.

## Aceite

Para cada consulta alterada: conjunto de resultados igual em fixture representativa,
casos de timestamp empatado, NULL e dados futuros; plano explica redução de linhas
lidas/ordenadas e custo de escrita. Teste com PostgreSQL real para SQL/migrations.

DB-04 define janela e orçamento antes do ensaio. Critério operacional: nenhuma
consulta do painel cancelada por timeout no ensaio com seis abas e workers ativos,
p95/p99 abaixo de seus orçamentos declarados, sem aumento de lacunas da coleta,
sem OOM e sem ultrapassar limite de conexões. Publicar duração e quantidade de
requisições; uma janela curta sem falha não comprova estabilidade por sete dias.

## Execução pequena

- [DB-01](../../prompts/roadmap/btc/db-01-baseline-consultas.md): inventário read-only.
- [DB-02](../../prompts/roadmap/btc/db-02-ultimo-trade-por-mercado.md): um acesso SQL.
- [DB-03](../../prompts/roadmap/btc/db-03-rtds-e-livro-asof.md): consultas as-of prioritárias.
- [DB-04](../../prompts/roadmap/btc/db-04-plano-recursos-e-validacao.md): plano concreto de recursos e ensaio.

## Limites

Sem mudança para máquina local, reescrita de banco, timeout global aumentado como
correção ou limpeza de dados nesta RFC. DELETE/VACUUM/repack são tratados na
RFC-041; liberação reutilizável no banco e disco devolvido ao OS são resultados
diferentes. A criação destes documentos não executa operação no servidor.
