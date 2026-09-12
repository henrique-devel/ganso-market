# DB-03 — Preparo do ensaio autorizado de escrita/WAL

**Retomada em 12/09/2026; preparação, sem nova coleta PostgreSQL.** Base
`33e890fc32c33b8b7791fc395655a6d21d5f0be5`, branch
`codex/db-03-write-preparation`, worktree `/private/tmp/ganso-db03-write-preparation`.
A execução definitiva pertence à validação **DB-04**, na próxima tarefa.

## Autorização e limites vigentes

A [autorização específica](../../ops/DEVELOPMENT_AUTHORIZATION.md#retomada-das-recomendações-btc--12092026),
publicada no PR #163, foi conferida com o registro fiel do coordenador de
14:28:42.527173 UTC. O proprietário aprovou o ensaio limitado em PostgreSQL
descartável e a execução sequencial das recomendações. As duas recusas antigas
permanecem fatos históricos, **sem aprovação adicional pendente** para este ensaio.
Uma nova recusa de ferramenta deverá ser respeitada e relatada, sem contorno.

Q3/Q4, causalidade, desempate, feed e TTL ficam intactos; o adiamento conservador
de Q4/DB-03B foi aprovado. HOLD, imagens/backups/rollback e migrations aplicadas
continuam preservados. Custo externo adicional zero; nenhuma infraestrutura,
capital/caps/live/signer/perímetro nova. Não aplicar índice em produção nesta etapa.

## Falhas concretas corrigidas no preparo

O [runner histórico](db03-benchmark.mjs) e o [JSON de leitura](db03-benchmark-result.json)
permanecem inalterados para reproduzir a evidência do PR #158. **Não usar seu modo
`--with-writes` para a validação atual:** ele repete dez cenários de leitura, faz
UPDATE adversarial/VACUUM, usa DDL anterior ao HOLD 0023 e mede EXPLAIN dentro da
transação. Seus upserts em lote com recebimento fixo também diferem do escritor.

O novo [runner exclusivo de escrita](db03-write-benchmark.mjs) prepara o delta:
SQL VALUES do flush RTDS e upsert individual do escritor, schema atual com guards,
WAL do backend fora do cronômetro, identidade descartável, limites finitos,
relatório parcial em falhas e saída diferente de zero quando o gate reprova.
Reutiliza a metodologia `summary/compare/exitStatus` do runner DB-02 integrado,
sem modificar seus arquivos, resultados ou critérios. Importar o módulo não
conecta; a CLI requer `--execute` e destino explícito.

## Protocolo fixado antes da execução DB-04

| Item | Parâmetro |
| --- | --- |
| Destino | PostgreSQL 18.4 dedicado, Docker local, 1 CPU/1 GiB, max_connections 10; uma conexão de ensaio |
| Identidade | URL com host literal 127.0.0.1, porta explícita ≥1024, usuário postgres, banco `ganso_db03_write_disposable`; sem parâmetros de URL que sobrescrevam destino/config |
| Pré-condições | Versão 180004; banco declarado; sem tabelas de usuário preexistentes em qualquer schema; nenhum outro client backend; fsync, full_page_writes e synchronous_commit on |
| Limites | Connect/statement/idle transaction 5 s; lock 500 ms; 120 s por cenário/setup e 600 s global; primeiro erro encerra, sem retry; ultrapassar 600 s inclusive na limpeza impede saída de sucesso |
| Schema | Migrations reais 0001–0023, checksums e versões conferidos por schema UUID; revisão obrigatória se a cadeia mudar |
| Seed | 120.000 RTDS por variante, dois símbolos × dois feeds × 30.000; 1.000 agregados; setup fora das medições |
| Raw | 5.000 linhas em autocommit + 5.000 em transação explícita diagnóstica por variante; VALUES com duas linhas por flush, sem EXPLAIN |
| Agregados | 500 upserts individuais em autocommit + 500 em transação explícita por variante; oito binds e CURRENT_TIMESTAMP originais |
| Amostragem | Quatro rodadas; raw 625 operações de duas linhas/rodada, blocos A/B de 125; agregados 125 operações/rodada, blocos de 25; inverter ordem dos blocos |
| Warmup | Três por cenário/variante, fora da medição, com rollback; raw sem acrescentar linhas persistidas, agregados em chaves da fixture |
| WAL | Contadores PG18 por backend, flush das estatísticas entre blocos, fora da cronometragem; inclui commits/sequence/guards, exclui setup/build/warmup/controle HOLD/VACUUM/cleanup |
| Saída | Todas as amostras e rodadas, hashes do runner/protocolo/fontes/migrations/metodologia, planos ausentes porque não se repete leitura; JSON separado da evidência antiga |

Dois registros por flush são uma fixture fixada a partir da referência DB-01
(~1,90 inserts RTDS/s, flush nominal de um segundo), **não uma distribuição de
lotes comprovada em produção**. O flush real envia a fila inteira sem esse cap;
DB-04 deve declarar essa limitação ao relacionar a fixture com coleta/backlog.
O braço explícito mede COMMIT separadamente e é diagnóstico; autocommit é o
caminho do escritor. Não somar os dois braços como se ambos fossem produção.

Depois da escrita, exigir 130.000 RTDS e 1.000 agregados por variante, igualdade
dos campos econômicos/identidade/tempo RTDS e valores/identidades de agregados.
`received_at` dos agregados vem de CURRENT_TIMESTAMP: validar janela temporal
do servidor e reportar essa exceção à comparação byte a byte, sem substituir o
SQL por um timestamp fixo para fabricar igualdade. Guards devem seguir habilitados.

**DELETE/HOLD:** a migration 0023 rejeita DELETE/TRUNCATE inclusive em RTDS.
O controle prepara um alvo máximo de 1.000 linhas da fixture e exige a recusa
`55000 / DATA02_EVIDENCE_HOLD`, com zero perda. Não desabilitar trigger/HOLD para
obter mil exclusões; p95/throughput de exclusão ficam **indisponíveis**, sem gate
aprovado por vacuidade. VACUUM normal, sem FULL/REPACK, fica restrito às tabelas
RTDS dos dois schemas próprios, após as medições e fora do WAL/cronômetro de escrita.

Critério mantido: regressão **≤10%** de p95 total, tempo/throughput e COMMIT
diagnóstico, no agregado **e em cada rodada**, sem tolerância absoluta/epsilon,
remoção de outliers ou nova execução para obter aprovação. Publicar WAL e bytes
adicionais separadamente; não inventar um orçamento operacional. Erro, drift de
identidade/schema/guard, orçamento excedido ou resultado contraditório impedem
promoção. Mesmo que os gates de escrita passem, o controle HOLD não mede poda e
nenhum resultado deste runner autoriza sozinho um índice produtivo.

## Comandos preparados para DB-04 — não executados nesta retomada

Criar uma instância nova, verificar o ID/imagem e o bind efetivo antes de montar
a URL. Não reutilizar um banco existente pelo nome. Exemplo limitado:

```sh
docker run --detach --rm --name ganso-db03-write-pg --cpus=1 --memory=1g --publish 127.0.0.1::5432 --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=ganso_db03_write_disposable postgres:18.4-bookworm -c max_connections=10 -c shared_buffers=128MB
docker inspect ganso-db03-write-pg --format '{{.Id}} {{.Image}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{json .NetworkSettings.Ports}}'
docker exec ganso-db03-write-pg pg_isready -U postgres -d ganso_db03_write_disposable
```

Após conferir a porta dinâmica publicada em **127.0.0.1**, informar a URL completa
em `GANSO_TEST_DATABASE_URL`; não copiar uma porta antiga. No checkout interno:

```sh
node --test docs/test-results/btc/db03-write-benchmark.test.mjs
node docs/test-results/btc/db03-write-benchmark.mjs --execute > /private/tmp/db03-write-result.json
```

Guardar stdout/JSON também quando exit code for 1 (erro/incompleto) ou 2 (gate de
escrita reprovado), registrar ID/imagem/cgroup antes/depois e publicar toda a
coleta. Exit 0 indica somente conclusão dos gates de escrita medidos. A CLI limpa
apenas seus schemas UUID; encerramento abrupto pode exigir inspecioná-los ou
remover o container descartável pelo **ID conferido**, nunca por prune global.
Não sobrescrever `db03-benchmark-result.json` nem os resultados DB-02.

## Verificação desta preparação e handoff

Nesta retomada, a autorização e os contratos foram conferidos por leitura e
revisão independente. Não houve conexão PostgreSQL, build de índice, ensaio de
escrita/WAL, repetição da leitura aprovada ou consulta a produção. Resultados de
testes da preparação e entrega são registrados no recibo DB-03; execução SQL e
gates efetivos do novo runner continuam **não verificados até DB-04**.

O [DB-02 retomado](DB-02-write-recheck.md) já entrega sua coleta única e mantém o
candidato suspenso: 3/8 agregados e 15/32 rodadas reprovados, 0/8 cenários aprovam
a regra conjunta. Esses números não são reensaiados nem relaxados pelo DB-03.
DB-04 recebe esse resultado e o presente preparo RTDS para validar escrita,
folga e coleta no orçamento existente; não tratar preparo, fixture ou publicação
de texto como produção, capacidade sustentada ou soak.

Referências conferidas em 12/09/2026: [estatísticas por backend PostgreSQL 18](https://www.postgresql.org/docs/18/monitoring-stats.html)
e [instrumentação de EXPLAIN](https://www.postgresql.org/docs/18/sql-explain.html).
