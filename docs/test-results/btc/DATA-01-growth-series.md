# DATA-01 — Série limitada de crescimento e espaço real

Suplemento da retomada autorizada em 12/09/2026, base interna
`c8b73677f863cb491c902e606c2dcc0ce2aaf5bf`, worktree
`/private/tmp/ganso-data01-growth`. O [inventário histórico](DATA-01.md) conserva
as medidas e limitações de sua própria janela. Este documento registra o
mecanismo novo; publicação, instalação, primeira amostra e sete dias observados
são resultados distintos.

## Escopo implementado

O [coletor](../../../deploy/capacity_series.py) aproveita o
[watchdog existente](../../../deploy/recorder_watchdog.py), depois da supervisão
normal. O [instalador restrito](../../../deploy/install_capacity_series.py)
prepara somente os dois arquivos de host, o backup do watchdog e o estado da
série. Não cria serviço, timer, cron ou automação do Codex; não aumenta recursos
nem orçamento. Custo externo adicional zero, no host existente.

As consultas são somente leitura; as escritas novas pertencem ao observador e
sua instalação. Sem inventário repetido, carga, escrita SQL, mudança de HOLD,
índice, exportação, poda ou compactação. Imagens, backups, dados e
paper/capital/caps/live/signer permanecem preservados.

## Protocolo da série

O primeiro `--start` grava `series.json` com início UTC, hash do coletor e datas
absolutas. Outro `--start` devolve a série existente, sem reiniciar ou estender
o período. A instalação reaplicada também conserva o backup original.

| Parâmetro       | Contrato implementado                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Amostras        | Oito slots fixos, `sample-00.json` a `sample-07.json`                                                                      |
| Cadência        | Vencimentos em início + 0, 1, 2, …, 7 dias de 86.400 s                                                                     |
| Carência        | Uma hora após cada vencimento; depois o slot fica `missed`                                                                 |
| Fim             | Último vencimento em início + 7 dias; janela fechada em início + 7 dias + 1 h                                              |
| Concorrência    | `flock` exclusivo e não bloqueante do estado da série                                                                      |
| Tentativas      | Reserva persistida antes da sonda; no máximo uma tentativa por slot                                                        |
| Falhas          | `partial`, `error`, `reserved` e `missed` são preservados; não geram retry                                                 |
| Persistência    | Até 16 KiB por amostra e 4 KiB de metadados: até 132 KiB, além do lock e do arquivo temporário atômico                     |
| Segurança local | Diretório privado, arquivos do UID executor, sem links simbólicos/hardlinks aceitos para estado, escrita atômica e `fsync` |

Interrupção depois da reserva consome a tentativa; manutenção/indisponibilidade
pode perder janelas. Não há recuperação tardia. São **até oito amostras e até
sete intervalos consecutivos comparáveis**, sem garantir oito sucessos. Ao fim,
o mecanismo informa estado, sem reiniciar a série ou exigir intervenção diária.

## Orçamento e contenção de carga

- Orçamento interno de comandos 10 s; subprocesso limitado pelo watchdog a 12 s,
  resposta a 4 KiB. Supervisão inibida ou acima de 45 s usa `--skip-probe`, teto
  de 1 s e erro `WATCHDOG_BUDGET_OR_INHIBITED`, sem SQL. Não altera o resultado
  nem o código de saída da supervisão.
- Saída por comando ≤64 KiB, stderr descartado, sem `Config.Env`. Exige um único
  PostgreSQL do projeto/diretório corretos e no máximo 16 mounts.
- Uma conexão e um `SELECT` de catálogo/estatísticas/tamanho: read-only `on`,
  statement/idle transaction 1.500 ms, lock 250 ms, conexão 1 s, paralelismo zero.
  `psql -XAt`, `ON_ERROR_STOP=1`, `application_name=data01-daily`; timeout no
  container 4 s + kill após 1 s, dentro do orçamento restante.
- WAL: até 256 entradas não recursivas; apenas segmentos válidos, inclusive
  `.partial`, sem ler payload. Exceder o limite é falha. Sem `du`, `COUNT` de
  tabelas, `ANALYZE`, `VACUUM`, `DELETE` ou flush/reset de estatísticas.
- Disponível real abaixo de 25% produz observação parcial com mapeamento, sem
  iniciar SQL; não implementa admissão nem autoriza limpeza. Erros são códigos
  estáticos sem credenciais/traceback; nenhuma falha ou parcial gera retry.

`pg_database_size` lê o tamanho físico do banco e pode atingir o timeout no
PostgreSQL pressionado. Um timeout é resultado válido da tentativa e reduz a
cobertura da série; não justifica aumentar o orçamento para obter um número.

## Identidade de armazenamento e significado dos bytes

O [DB-04](DB-04-write-capacity.md#filesystem-de-dados-wal-e-tablespaces) comprovou
PGDATA `/var/lib/postgresql/18/docker`, WAL `pg_wal`, `pg_default/base` e
`pg_global/global`, sem tablespaces customizados, volume
`ganso-market_postgres_data`. Todos em `8:1`, ext4, `/dev/sda1`, mount `/`:
322.302.373.888 B total, mínimo disponível 201.736.740.864 B, 62,592384%.
**São valores herdados de DB-04, não a primeira amostra da série.**

Cada tentativa revalida os quatro caminhos com `readlink`, mount Docker,
mountinfo do host e do namespace PostgreSQL, device e raiz interna do mount.
Só então usa `statvfs` do caminho de host correspondente. Filesystems são
deduplicados pela identidade device/tipo/origem: PGDATA, WAL e tablespaces no
mesmo filesystem contam uma vez. A folga do checkout não é substituto dessa
verificação. Um novo volume, tablespace ou mapeamento divergente é recusado.

| Campo                                    | Interpretação e limite                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `filesystems.*.available_bytes`          | `f_bavail × f_frsize`, disponível sem a reserva do root; representa todos os consumidores desse filesystem                         |
| `filesystems.*.free_bytes`               | `f_bfree × f_frsize`, livre incluindo reserva; não substituir por disponível no piso de 25%                                        |
| `sql.database_bytes`                     | `pg_database_size` do banco observado; bytes físicos, sem estimativa viva, atribuição por tabela ou promessa de recuperação        |
| `wal_segments.bytes` / `allocated_bytes` | Tamanhos lógico e alocado dos arquivos de segmento presentes; exclui `archive_status` e outras entradas, não equivale a WAL gerado |
| `sql.wal.wal_bytes`                      | Contador acumulado de WAL gerado pelo cluster, com `stats_reset`; não mede custo marginal de uma consulta ou tabela                |
| `sql.db_stats.temp_bytes`                | Contador SQL observado com reset, sem cálculo de ocupação simultânea de temporários                                                |

A observação inclui hash de machine-id, hostname, ID/PID/imagem/início do
container, system identifier, postmaster start, banco, hash do coletor e UTC.
Inspeções Docker antes/depois devem concordar. Falha após mapeamento fica
`partial`: caminhos herdados medidos, topologia SQL atual não totalmente validada.

O delta só é válido entre slots consecutivos `ok`, com identidade de host,
cluster, banco, armazenamento e coletor estável, e tempo positivo. Registra
variação do tamanho SQL, disponível por filesystem deduplicado e segmentos WAL.
O delta de WAL gerado exige o mesmo reset e contador não decrescente; em caso de
reset/rollback fica `null` com `reset_or_counter_rollback`, sem invalidar por si
só os outros deltas comparáveis. Lacuna, mudança de identidade ou relógio
regredindo fica explícita; não interpolar os dias faltantes.

## Instalação manual restrita e acompanhamento

Após checks/merge, os fontes da revisão aprovada foram extraídos em diretório
root privado, com hashes conferidos. Este dry-run passou antes da instalação:

```sh
sudo /usr/bin/python3 -I /var/lib/ganso/capacity-install-97c2787f3c4b81ed4ed4ad113459a123191ab1c1/install_capacity_series.py \
  --source-dir /var/lib/ganso/capacity-install-97c2787f3c4b81ed4ed4ad113459a123191ab1c1 --revision 97c2787f3c4b81ed4ed4ad113459a123191ab1c1 \
  --before-watchdog-sha256 8b9233bedbf835de75ed7f7f59ff94aa6d5d998a97f2375b11c6266075029b4e \
  --collector-sha256 de757473c79d850201c1e4eceaea3daf9534df02efd2563fd8c2c30825bf36a3 \
  --watchdog-sha256 2760313b958d1ba074da6456f3dc55fc60d40858f3f1baf5ae7d6f25b292c999 --dry-run
```

O mesmo comando passou sem `--dry-run`, após conferir o preflight: propriedade,
permissões, links, fontes ≤64 KiB, hashes, sintaxe, watchdog, backup e manifesto
são validados antes da escrita. Instala coletor antes do hook; conserva original em
`/var/lib/ganso/recorder-watchdog/capacity-series-install/before-recorder_watchdog.py`
e grava `installation.json` com revisão e hashes. Inicia os metadados com
`--start`; a primeira captura pertence à próxima invocação normal do timer.
Não força supervisão, restart ou ativação de unidade.

A instalação restrita evita a rotina geral de deploy/manutenção/poda. Sem prune,
limpeza de backups/imagens ou recriação de containers. Distinguir SHA do checkout/
aplicações, SHA documental e hashes destes dois arquivos.

O acompanhamento é somente leitura do estado persistido, sem nova sonda:

```sh
sudo /usr/bin/python3 -I /opt/ganso-market/deploy/capacity_series.py --status
```

Devolve metadados e até oito amostras de
`/var/lib/ganso/recorder-watchdog/capacity-series/`. Registrar `start_utc`,
`last_slot_due_utc`, `window_end_utc`, slots/status/deltas e seus erros. Não usar
`--due` como comando de acompanhamento. O coordenador pode ler esse estado em
sua rotina existente; DATA-01 não cria automação e não requer ação diária do dono.

### Rollback preservando evidência

Restaurar somente o watchdog por troca atômica, com hashes atual/backup validados.
O procedimento abaixo **não foi executado nesta seção**; divergência exige
revisão, sem sobrescrever mudanças posteriores.

```sh
sudo /usr/bin/python3 -I - <<'PY'
import hashlib, json, os, stat
from pathlib import Path
target = Path('/opt/ganso-market/deploy/recorder_watchdog.py')
evidence = Path('/var/lib/ganso/recorder-watchdog/capacity-series-install')
backup = evidence / 'before-recorder_watchdog.py'
manifest = evidence / 'installation.json'
for path in (target, backup, manifest):
    for directory in path.parents:
        info = directory.lstat()
        assert directory.resolve() == directory and stat.S_ISDIR(info.st_mode)
        assert info.st_uid == 0 and not info.st_mode & 0o022
    info = path.lstat()
    assert path.resolve() == path and stat.S_ISREG(info.st_mode)
    assert info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022
record = json.loads(manifest.read_bytes())
old = backup.read_bytes()
digest = lambda value: hashlib.sha256(value).hexdigest()
assert digest(old) == record['before_watchdog_sha256']
assert digest(target.read_bytes()) == record['files']['recorder_watchdog.py']
pending = target.with_name(target.name + '.capacity-rollback-pending')
fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'wb') as stream:
    stream.write(old)
    stream.flush()
    os.fsync(stream.fileno())
os.replace(pending, target)
fd = os.open(target.parent, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
print(json.dumps({'restored_watchdog_sha256': digest(target.read_bytes())}))
PY
```

A invocação seguinte do timer usa o watchdog restaurado e deixa de chamar o
observador. A execução já em curso pode concluir sua única tentativa limitada.
Conservar coletor, `series.json`, amostras, manifesto e backup; não apagar nem
reiniciar a série. O rollback não modifica banco, containers, serviço ou timer.

## Verificação local e limites do aceite

- 56 testes capacity/instalador e 59 watchdog aprovados: orçamento, reserva
  durável, idempotência, falhas, topologia, deduplicação, reset de WAL e caminhos
  privados. Ruff check/format dos seis arquivos e secret scan aprovados.
- [Contrato SQL em PostgreSQL 18.4 descartável](data01-catalog-contract.json):
  `passed`, observação em 12/09/2026 às 16:37:38.576931 UTC, banco vazio de
  aplicação, read-only `on`, statement `1500ms`, lock `250ms`, dois tablespaces
  padrão. O resultado confirmou a normalização explícita de OID textual/inteiro
  na validação Python e a remoção do container temporário. Não foi ensaio de
  escrita, dataset de aplicação ou medição da capacidade produtiva.
- Comandos locais de reprodução: `python3 -m unittest discover -s scripts/tests
-p 'test_capacity*.py' -v`, Ruff check/format dos arquivos alterados e suíte
  watchdog com fixtures. Nenhum teste usa produção como fixture.

Sete intervalos mostram crescimento líquido da janela, não taxa sustentável,
picos intradiários, headroom de CPU/RAM, restauração ou espaço recuperável.
Ingestão, retenção, temporários, WAL e outros consumidores concorrem. Projeções
7/30/90 dias dependem de intervalos reais suficientes e cobertura/erros expostos;
a coleta curta histórica não equivale a uma semana observada.

DATA-02/DATA-05 poderão consumir os bytes disponíveis do filesystem comprovado,
identidade, timestamp e falhas para suas decisões de admissão/preservação.
Esta série não implementa admissão, catálogo de arquivos/pins, reservas novas,
rotação nem poda. HOLD, Q4/DB-03B, índices suspensos e compactação adiada continuam
decisões vigentes; ausência de erro na série não remove nenhum desses gates.

## Operação verificada em 12/09/2026 UTC

O [PR #166](https://github.com/henrique-devel/ganso-market/pull/166), head
`99d1275a7ff126248e9f97569d750ee07bbafe42`, foi integrado às 16:58:34 UTC em
`97c2787f3c4b81ed4ed4ad113459a123191ab1c1`. Verify source e Verify Compose runtime
passaram no [PR](https://github.com/henrique-devel/ganso-market/actions/runs/34706586883)
e no [merge](https://github.com/henrique-devel/ganso-market/actions/runs/34706830333).
O job Deploy production do merge ficou literalmente **skipped**: manutenção
operacional `DEPLOY_ENABLED=true → false → true`, já restaurada e conferida.
Este diff contém código e não recebeu a classificação “deploy pulado: só texto”.
Não houve dispatch de deploy geral, poda de backups ou recriação da aplicação.

O dry-run e a instalação manual passaram, usando os três fontes extraídos do
merge aprovado em `/var/lib/ganso/capacity-install-97c2787f3c4b81ed4ed4ad113459a123191ab1c1`.
O instalador substituiu somente os dois arquivos host e iniciou o calendário.
[Metadados e comparações antes/depois](data01-growth-operation.json) registram
revisão, hashes, units, limites, timer, backups e identidade dos containers/imagens.
O SHA das aplicações/checkout produtivo não foi promovido para esse merge.

| Arquivo                     | SHA256 produtivo verificado                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `capacity_series.py`        | `de757473c79d850201c1e4eceaea3daf9534df02efd2563fd8c2c30825bf36a3` |
| `recorder_watchdog.py`      | `2760313b958d1ba074da6456f3dc55fc60d40858f3f1baf5ae7d6f25b292c999` |
| Backup do watchdog anterior | `8b9233bedbf835de75ed7f7f59ff94aa6d5d998a97f2375b11c6266075029b4e` |

O timer existente fez a primeira tentativa às **17:03:55.666555 UTC**, slot 0,
`ok`/`complete=true`, em **1,392270 s**. A [amostra publicada](data01-growth-first-sample.json)
é byte a byte igual ao arquivo host de 5.160 B, SHA256
`a0766e9afe0dbfaf61fb7c3cf20cab71be8c0c48d665a88df9f441e9e608bc9b`.
O manifesto tem 357 B, lock 0 B, todos modo 0600. Nenhum `--due`/supervisor foi
invocado manualmente; as duas execuções naturais seguintes reportaram `not_due`.

| Medida da primeira amostra        | Resultado                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Banco físico (`pg_database_size`) | 98.537.690.815 B / 91,770376 GiB                                                  |
| Filesystem real, uma vez          | `8:1`, ext4, `/dev/sda1`, mount `/`, total 322.302.373.888 B                      |
| Disponível sem reserva root       | 201.990.098.944 B / 188,117939 GiB / **62,670993%**                               |
| Margem instantânea sobre piso 25% | 113,076070 GiB; não é orçamento admitido para export                              |
| WAL presente                      | 8 segmentos, 134.217.728 B / 128 MiB lógicos e alocados                           |
| WAL acumulado do cluster          | 2.015.163.165.713 B; reset 17/08/2026 22:17:04.734133 UTC                         |
| SQL                               | read-only `on`, statement `1500ms`, lock `250ms`; horário SQL 17:03:56.928776 UTC |

Os quatro caminhos foram resolvidos para o volume `ganso-market_postgres_data`,
raiz host `/var/lib/docker/volumes/ganso-market_postgres_data/_data/18/docker`.
WAL, `base` e `global` são subdiretórios dessa raiz; os dois tablespaces padrão
foram confirmados pelo catálogo. Filesystem do checkout não foi usado como atalho.

| Marco UTC fixado pelo `--start`       | Data e hora                |
| ------------------------------------- | -------------------------- |
| Início / slot 0 devido                | 12/09/2026 17:03:34.182494 |
| Próxima tentativa / slot 1 devido     | 13/09/2026 17:03:34.182494 |
| Última tentativa / slot 7 devido      | 19/09/2026 17:03:34.182494 |
| Encerramento da janela, após carência | 19/09/2026 18:03:34.182494 |

Há **uma amostra completa e zero intervalos diários comparáveis**; o delta do
baseline é `PREVIOUS_UNAVAILABLE`. Ainda não há sete dias observados nem taxa de
crescimento sustentado. Falhas futuras permanecem resultados da série, sem retry.
O comando `--status` acima permite acompanhamento sem SQL e sem intervenção diária.

No pós-check às 17:05:14 UTC, os 230 IDs de imagem, os 11 containers com imagens e
horários de início, os cinco nomes de backup e os hashes das units coincidiram
com o preflight às 16:48:24 UTC. Timer ativo; watchdog `Result=success`, exit 0,
MemoryMax 128 MiB, CPUQuota 10%, TimeoutStart 70 s. Seus eventos mantiveram
`reason=persistence_stale`, `action=observe`: sucesso da série **não comprova
saúde do feed ou soak**. Nenhum rollback foi necessário. HOLD/dados, gates de
índices e escopo dos demais blocos não foram alterados por esta entrega.

A publicação desta evidência usa o [PR #167](https://github.com/henrique-devel/ganso-market/pull/167),
com verificação e classificação do deploy documental registradas no próprio PR.
