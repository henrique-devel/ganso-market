# DB-02 — Retomada do ensaio de escrita

Plano fechado em 12/09/2026 antes de coletar a nova amostra. A [autorização
registrada](../../ops/DEVELOPMENT_AUTHORIZATION.md) cobre este ensaio limitado em
PostgreSQL descartável. O [resultado histórico](DB-02.md) e seu JSON permanecem
inalterados: a reprovação de COMMIT (+173,56%) não é apagada por este trabalho.

## Delta que justifica nova medição

O recorder executa INSERT VALUES individual, em autocommit. O primeiro benchmark
usava EXPLAIN ANALYZE sobre lotes de 500, media COMMIT em apenas 20 transações,
atribuía external_id a WS (o escritor real envia NULL), não enviava as novas linhas
ao mercado quente e não incluía os guards da migration 0023 hoje vigente.
São diferenças verificadas no código, não uma justificativa para repetir até passar.

## Protocolo fixo

- Base `e9d6960603804a07f142b13bfd24f495a661cb36`, branch
  `codex/db-02-write-recheck`, worktree `/private/tmp/ganso-db02-write`.
- PostgreSQL 18.4 dedicado em Docker, 1 CPU/1 GiB, max_connections 10; porta somente
  localhost; fsync/full_page_writes/synchronous_commit on. Uma conexão do benchmark,
  statement_timeout 5 s, lock_timeout 500 ms, 120 s por cenário e 10 min globais.
  Banco deve ter nome `ganso_db02_write_disposable`, schema public vazio de tabelas
  de usuário e nenhum outro cliente. Capturar imagem/cgroup antes e depois.
- Aplicar as migrations reais 0001–0023 em cada schema UUID privado, sem modificar
  seus conteúdos/checksums. Manter HOLD e os triggers de escrita em ambas variantes.
  Instalar somente o SQL candidato já publicado, concorrente e fora de transação.
- Seed de 100.000 trades por variante/1.000 mercados, 50% quente, 75% data_api/25% WS,
  duas identidades de token, idades/NULL/empates/futuro. WS tem external_id NULL.
  Carregar em lotes ≤5.000, fora da medição, sem VACUUM/checkpoint forçado/tuning.
- Separar fonte **data_api/WS**, **novo/conflito** e braço **autocommit/COMMIT
  explícito de uma linha**: oito cenários. SQL dos dois escritores extraído do
  código; sem EXPLAIN no caminho medido. Metade das linhas novas também é quente.
- Quatro rodadas de 625 operações por cenário/variante, A/B balanceado em blocos
  de 125 e invertido em rodadas pares; três warmups fixos de identidade já existente.
  Total medido por variante: **10.000 inserts + 10.000 conflitos**. Conflitos repetem
  exatamente os binds dos inserts. Todas as rodadas/amostras serão publicadas;
  sem remover outliers ou repetir uma execução concluída por resultado desfavorável.
- Principal: latência do INSERT individual até confirmação do autocommit e
  throughput. Diagnóstico: BEGIN/INSERT/COMMIT de uma linha, latência da transação
  e COMMIT separado. Esse braço não é o fluxo do recorder e não substitui autocommit.
- WAL por diferença dos contadores **do backend** PostgreSQL 18, flush explícito
  das estatísticas entre blocos, fora da cronometragem. Inclui commit/sequence/trigger;
  exclui outros backends, seed/build/limpeza. Não equiparar a WAL de statement do
  EXPLAIN anterior. Publicar bytes/records/FPI e tamanho do índice antes/depois.
- Exigir rowCount 1/0 conforme cenário e igualdade dos 110.000 registros finais
  (campos econômicos/identidade/tempo; ID gerado excluído), WS external_id NULL,
  1.000 mercados, 55.000 linhas no mercado quente e guards habilitados. Nenhum teste
  funcional/leitura já aprovado será repetido: somente invariantes da nova fixture.
- Manter **≤10%** de regressão para latência p95, tempo/throughput e p95 COMMIT
  diagnóstico; publicar agregado e cada rodada. Rodada reprovada não é ocultada por
  agregado favorável. Informar WAL adicional separadamente; não inventar orçamento
  operacional. Resultado contraditório ou erro/orçamento excedido mantém candidato.
- No primeiro erro, abortar sem retry e publicar o relatório parcial. Limpeza
  limitada aos schemas/container criados. Não executar DELETE/TRUNCATE de dados
  produtivos nem flexibilizar HOLD para realizar teste.

Este ensaio não mede distribuição/frequência de produção, concorrência WS/backfill,
seletores de retenção, demais workers, painel, crescimento sustentável ou soak.
DB-04 recebe os resultados e o workload; só seus gates completos permitem promoção.

Referências: [estatísticas por backend do PostgreSQL 18](https://www.postgresql.org/docs/18/monitoring-stats.html)
e [custo de instrumentação de EXPLAIN](https://www.postgresql.org/docs/18/sql-explain.html).

## Resultado observado

A preencher após a execução identificada; nenhum resultado previsto é aprovação.
