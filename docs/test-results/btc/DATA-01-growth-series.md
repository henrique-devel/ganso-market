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

Após checks/merge, usar fontes da revisão aprovada em diretório root privado,
conferir hashes com a revisão local e registrar SHA256 do watchdog efetivo.
Os valores `<...>` abaixo dependem da evidência real da operação.

```sh
sudo /usr/bin/python3 -I <stage-root>/install_capacity_series.py \
  --source-dir <stage-root> --revision <sha-40-da-revisao> \
  --before-watchdog-sha256 <sha256-watchdog-atual> \
  --collector-sha256 <sha256-coletor-revisado> \
  --watchdog-sha256 <sha256-watchdog-revisado> --dry-run
```

Executar uma vez sem `--dry-run` após conferir o preflight: propriedade,
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

## Operação — pendente de evidência real

Esta implementação é código: `deploy_paths` classifica deploy como `true`; não
registrar `deploy pulado: só texto`. A operação prevê manutenção temporária da
variável `DEPLOY_ENABLED`: `true → false → true`, para inibir somente o job de
deploy geral durante a entrega manual restrita. Os checks continuam ativos.
Registrar os valores efetivamente observados, o resultado literal do job e a
restauração de `true` antes do fecho; a alteração não prova instalação concluída.

**Instalação, primeira amostra e período observado ainda não afirmados.**
Completar antes do fecho: revisão/branch/PR/merge/checks, resultado literal de
deploy/instalação, hashes antes/depois, timer efetivo, primeira tentativa e
medidas/erros, UTC de início, último vencimento e fim. Datas devem vir do estado
instalado. Até a primeira captura válida, os números acima são herdados de DB-04.
