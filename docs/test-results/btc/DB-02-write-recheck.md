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

Coleta única **2026-09-12 14:43:19.535–14:44:18.392 UTC**, **58,857 s**; código de
medição `dbd59e9adea37c232108540429b7c69c476d90dd` (protocolo prévio em `29afa90`).
[JSON integral](db02-write-result.json): 40.000 amostras em nanossegundos, versões e
checksums das 23 migrations, SQLs, índices/guards, métricas por rodada e hashes do
harness/protocolo/código. Hash do harness conferido contra esse commit.

Instância `ganso-db02-write-pg`, ID
`0c08ffb7615668056963d80c053cfa1832e7720af59b2ff4fb0d6d3e041dcc70`, imagem
`sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382`;
PostgreSQL 18.4/aarch64, porta **127.0.0.1:54606**, banco dedicado do protocolo.
Limites Docker confirmados: **1.000.000.000 NanoCPUs / 1.073.741.824 B**. fsync,
full_page_writes e synchronous_commit on, shared_buffers 128 MiB, work_mem 4 MiB.
Memória após limpeza dos schemas: 162 MiB; eventos OOM/OOM-kill/max **0** desde a
criação do container. Contadores de CPU desde o boot incluem seed/DDL e tempo fora
da medição; não foram usados como throttling específico do INSERT. Os outros
containers locais foram preservados; CPU/IO do host não são exclusivos deste teste.

O primeiro `docker run` não iniciou PostgreSQL porque a porta 55433 já estava
ocupada. Foi removido somente esse container incompleto e usada porta dinâmica em
localhost. Não houve rejeição de aprovação de ferramenta nesta retomada, retry de
consulta, execução estatística descartada, mudança de timeout ou novo serviço pago.

### Gates de escrita

Cada célula de p95 vem de **2.500 operações** por variante. P99 e todos os máximos
continuam no JSON como descrição da fixture, sem inferência de cauda produtiva.

| Braço / operação / fonte | p95 total ms sem → com | p95 COMMIT ms sem → com | Agregado | Rodadas reprovadas (1–4) |
|---|---:|---:|---|---|
| Autocommit / INSERT / data_api | 2,137 → 1,961 | não separado | passa | 1 |
| Autocommit / INSERT / WS | 1,719 → 1,959 | não separado | falha (+14,02%) | 1, 3, 4 |
| Autocommit / conflito / data_api | 1,099 → 1,458 | não separado | falha (+32,63%) | 2, 4 |
| Autocommit / conflito / WS | 0,925 → 0,895 | não separado | passa | 4 |
| Explícito / INSERT / data_api | 3,415 → 3,905 | 1,507 → 1,777 | falha (COMMIT +17,91%) | 1, 2, 3, 4 |
| Explícito / INSERT / WS | 3,237 → 3,243 | 1,527 → 1,436 | passa | 3 |
| Explícito / conflito / data_api | 3,136 → 2,970 | 1,113 → 1,065 | passa | 3, 4 |
| Explícito / conflito / WS | 2,899 → 2,894 | 0,846 → 0,779 | passa | 2 |

**3/8 agregados e 15/32 rodadas reprovados. Nenhum cenário passou a regra conjunta
pré-registrada; `allGatesPassed=false`.** INSERT explícito/data_api também teve
tempo ativo +12,60% e throughput −11,19%. Os agregados favoráveis não autorizam
ignorar as rodadas desfavoráveis. O limite inclusivo de 10% é comparado em
nanossegundos inteiros, sem folga absoluta/epsilon; nenhum critério foi relaxado.

O diagnóstico de COMMIT dos conflitos data_api agora tem agregado −4,32%, enquanto
duas rodadas falham (+63,99% e +15,56%). Isso não substitui nem torna diretamente
comparável a observação histórica +173,56% em lotes instrumentados de 500 linhas.
A reprovação histórica continua registrada; esta retomada acrescenta medidas do
fluxo atual e expõe dispersão, sem atribuir toda a variação ao índice.

### WAL, espaço e integridade

Contadores do próprio backend, forçados a publicar entre blocos: total medido
**11.025.568 B → 11.793.780 B**, adicional **768.212 B**. O adicional ocorre somente
nos INSERTs data_api: **+426.028 B / +16,92%** no autocommit e
**+342.184 B / +13,64%** no explícito. Os 5.000 INSERTs WS e os 10.000 conflitos de
cada variante tiveram WAL idêntico entre variantes. **FPI=0** em todas as janelas.
Esses bytes incluem commit/sequence e não são a métrica antiga de EXPLAIN.

Há variação de latência também em WS/conflitos sem diferença de WAL. É evidência
de que o ensaio não isolou causalidade de toda a latência; não prova ausência de
custo do índice nem anula os gates reprovados. Comparar causas em DB-04 requer
controles e a carga integrada, sem escolher somente amostras favoráveis.

Índice candidato: **6.774.784 B → 6.914.048 B** após os 10.000 novos trades.
Heap final igual: **30.588.928 B**. Índices totais finais: **51.019.776 B →
57.933.824 B**. A distribuição de identidades/empates mudou em relação à fixture
histórica; não tratar diferença de tamanho entre ensaios como compactação.

Foram exatamente 10.000 inserts e 10.000 conflitos por variante, sem erro/perda:
**110.000 registros iguais**, 1.000 mercados, 55.000 trades quentes, nenhum WS com
external_id preenchido. Os dois guards 0023 estavam habilitados antes/depois;
checksums 0001–0023 conferidos. Dois schemas descartáveis removidos com sucesso,
`cleanupErrors=[]`; container e seu volume próprios removidos depois da coleta.

### Comandos, entrega e handoff

```sh
node --test docs/test-results/btc/db02-write-benchmark.test.mjs
GANSO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54606/ganso_db02_write_disposable node docs/test-results/btc/db02-write-benchmark.mjs > /private/tmp/db02-write-result.json
node --check docs/test-results/btc/db02-write-benchmark.mjs
python3 scripts/scan_secrets.py
git diff --check
```

**8 testes da metodologia passaram**, cobrindo fixture/identidades, percentis,
outliers, fronteira inclusiva de 10% e retorno de falha do gate. Antes da coleta
eram sete; depois foi adicionado o teste de exit status. A versão medida terminou
com **exit 0**, significando conclusão do experimento, e JSON com gate falso.
O runner entregue agora retorna **2** quando coleta completa reprova gate, **1**
em erro/limpeza incompleta e **0** somente com todos os gates aprovados. Essa mudança
de saída foi testada sem repetir o ensaio; raw e hash da versão medida preservados.
Para nova execução, criar container dedicado e usar sua porta localhost nova; o
container/porta desta evidência não estão mais disponíveis.

Os 22 testes funcionais/de leitura antigos não foram repetidos manualmente: SQL
de produção, candidato, backfill e migrations aplicadas não mudaram. Os gates de
repositório exigidos pelo CI continuam obrigatórios para publicar esta entrega.

**Recomendação DB-02: manter o índice candidato suspenso.** DB-04 recebe o runner,
fixtures e limites reproduzíveis; deve exigir os cenários/gates completos, medir
concorrência real e folga, e separar controle de ruído de efeito de escrita. Se
preparar comparação A/A ou amostragem operacional adicional, registrar previamente
seu protocolo e publicar tudo; não usar repetição até aprovação. Não aplicar o
índice em produção com base nos cinco agregados favoráveis deste ensaio.

DB-03 pode prosseguir em sua própria tarefa. DB-04 mantém ownership da validação
operacional integrada; nenhum desses prompts foi executado aqui. Esta retomada
não consultou produção, não aplicou índice/tuning/migration, não liberou HOLD nem
alterou live/capital/perímetro/infra, Q4 ou compactação. Não há aprovação pendente
do proprietário para o trabalho já autorizado; permanecem **gates técnicos**.
