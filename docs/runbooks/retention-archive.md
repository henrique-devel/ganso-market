# DATA-03 — Export e restauração isolada

Contrato de ensaio limitado sobre o [manifesto DATA-02](retention-evidence.md),
implementado em `retention-archive.ts`, `retention-archive-storage.ts`,
`retention-archive-replay.ts` e `retention-archive-cli.ts`. O resultado é um arquivo
com linhas reais da fixture descartável e, somente após restauração/reconciliação
com commit, um certificado. Ambos continuam `fixtureOnly:true` e
`executionAllowed:false`; o certificado também fixa `deletionEligibility:false`.
Não há extração de produção, executor de poda, backup rotineiro ou liberação de HOLD.

## Entradas e fecho fixado

O manifesto `data-02-manifest-v1` deve estar válido e corresponder ao SHA do código,
schema, política, objetos, corte UTC, chaves, watermark e pins observados. O plano
`data-03-fixture-plan-v1` fixa `fixtureOnly:true`, `datasetId`, `manifestHash`,
`profile`, `historicalCompleteness:"unknown"` e `rows`: inventário independente por
tabela de pares `{key,rowHash}`. Chaves bigint são texto. O plano e suas linhas
ficam vinculados pelo hash; uma divergência exige novo ensaio/inventário, nunca
edição do artefato para fazê-lo passar.

O manifesto HOLD vazio de DATA-02 não fornece linhas exportáveis nem snapshot
restaurável. Os perfis de evidência exigem um plano explícito preparado sobre uma
fixture independente já existente no banco descartável. Não preencher esse plano
com história suposta, agregado de um minuto ou dados inventados como produção.

| Perfil | Fecho aceito neste ensaio |
| --- | --- |
| `raw-l2` | Exatamente uma âncora `polymarket_book_snapshots_full`, com bids/asks completos não vazios, e deltas de `polymarket_book_deltas` para o mesmo token. Source/received UTC com microssegundos, source não posterior à recepção, sequência temporal coerente e IDs adjacentes da fixture sintética. |
| `paper-ledger` | Uma ordem manual BUY totalmente preenchida/encerrada em `paper_orders`, aceitação e fills em `paper_ledger_events`, e a posição correspondente em `paper_positions`. Reconcilia quantidade, custo, fees, PnL e abertura; cada fill exige o recorte L2 consumido. |
| `residual` | Inventário exatamente igual aos candidatos `review_only` não vazios de DATA-02, somente nos resíduos allowlisted `bonding_curve_state`, `event_quarantine`, `domain_events` e `pumpswap_pool_state`; equivalência das linhas, sem replay econômico. |

IDs de deltas são globais: adjacência sintética não comprova continuidade de feed
de um token real. O perfil paper não cobre mercado/decisão/estratégia/resolução ou
versão de fee externos: essas referências devem estar ausentes; caso contrário,
falha por fecho não suportado. A posição da fixture BUY permanece retida e aberta;
ordem encerrada não significa posição liquidada. Nenhum perfil comprova toda a
história, integridade econômica de uma carteira real ou saúde da fonte.

## Isolamento, limites e capacidade

Preparar explicitamente dois bancos PostgreSQL 18 descartáveis locais, com schema
`public`, migrations 1–23 aplicadas pelos mecanismos existentes e tabelas do recorte
vazias no destino. O CLI aceita apenas `localhost`, `127.0.0.1` ou `::1`, porta
explícita e nomes `ganso_data03_source_<sufixo>` /
`ganso_data03_restore_<sufixo>`, sem parâmetros de URL. Não descobre credenciais.
O servidor confirma nome do banco, schema e `systemIdentifier`; o arquivo fixa a
identidade do destino antes de transferir linhas. Destino e origem não podem ter
a mesma identidade. Um banco real não vira fixture por renomeação ou túnel.

- De 1 a 4 tabelas; até 1000 chaves por tabela, respeitando também a fatia do manifesto;
  consultas limitadas a 1001 linhas. Sem dump integral, OFFSET ou SQL executado do arquivo.
- `--max-bytes` padrão 1 MiB, teto 16 MiB, mínimo 1024 bytes para export. O orçamento
  cobre a soma de `archive.json` e `certificate.json`; o export reserva 8192 bytes
  para o certificado antes de aceitar o arquivo serializado.
- Cada transação tem 2 s, statement 500 ms e lock 100 ms, sem retry automático.
  Usa o lock exclusivo transacional DATA-02 `(741041,2)` antes de qualquer escrita
  e até commit, sem upgrade. A origem usa READ ONLY; nenhum pin é criado/removido.
- Diretório de saída existente, vazio, absoluto, canônico, sem symlinks, modo 0700.
  Arquivos 0600, lock exclusivo, staging e publicação atômica sem sobrescrever.
  A capacidade local é conferida antes da transferência e de cada escrita.
- Piso local: após reservar o orçamento, manter 25% do filesystem mais 64 MiB livres.
  Para o PostgreSQL destino, reservar `8 × maxBytes + 64MiB` para heap/índices/WAL,
  além do mesmo piso 25% + 64 MiB. É um teto conservador de ensaio, não estimativa de
  espaço recuperável ou garantia de capacidade em produção.

`--capacity` é um recibo de medição explícita do volume local de dados PostgreSQL,
incluindo qualquer volume de WAL. Contém `database`, `systemIdentifier`,
`measuredAtUtc`, `freeBytes`, `totalBytes` e
`method:"disposable-postgres-volume-df"`. Os valores devem ser medidos no destino
isolado, não no filesystem do cliente por conveniência, e ter no máximo 60 s quando
validados. Horário futuro, identidade diferente ou espaço insuficiente abortam
antes do restore. Se não couber, reduzir o conjunto/orçamento e produzir novo
inventário; não encher disco nem usar a amostra antiga de produção como recibo.

## Arquivo, validação e certificado

`data-03-archive-v1` contém manifesto/plano completos, hashes, identidades,
contagens e checksums por linha, resultado do replay, geração e expiração.
As linhas são strings `to_jsonb(row)::text` produzidas pelo PostgreSQL em UTC;
bigints e microssegundos não passam por conversão numérica/Date do JavaScript.
O replay usa parsing sem arredondamento de números e matemática decimal exata.
O restore usa `jsonb_populate_record` para recuperar tipos nativos e
`OVERRIDING SYSTEM VALUE` para preservar identidades. A conversão de compostos
e as regras de restauração por tipo estão na documentação oficial
[PostgreSQL 18 JSON](https://www.postgresql.org/docs/18/functions-json.html),
consultada em 12/09/2026.

O export revalida pins/conjunto/watermark/predicado/disposição sob o lock, lê só
as chaves explícitas e compara os hashes com o plano. Origem e destino precisam
corresponder ao `schemaHash`: colunas/tipos, constraints, índices, triggers,
funções de retenção e checksums registrados em `schema_versions`. Guards devem
estar habilitados e migration 23 presente; isso não compara os checksums com
arquivos locais por conta própria. O restore não aplica DDL nem desativa triggers.

No destino, cada tabela selecionada deve estar vazia. A inserção ocorre em uma
transação; depois são relidas chaves, bytes/hashes, contagens e resultado do replay.
Corrupção, export parcial, schema incompatível, referência ausente ou divergência
econômica impedem certificado. Falha antes do commit reverte o restore; expiração
ou falha de publicação após commit pode deixar linhas do ensaio sem certificado.
Não tratar a mera existência do arquivo, ou essas linhas, como restauração aceita.

O certificado `data-03-restore-certificate-v1` vincula `manifestHash`, `archiveHash`,
`planHash`, dataset, SHA, schema/versões, política, corte, contagens/checksums,
identidade do destino, replay, recibo de capacidade e horário do restore. Seu hash
detecta alteração; não é assinatura nem aprovação. Para restore separado, os
hashes esperados do arquivo e plano vêm de registro independente confiável, não
do próprio arquivo recebido. A identidade prevista também deve coincidir.

Arquivo e certificado expiram exatamente com o manifesto, cuja validade máxima
é 15 min. Verificação exige validade ainda vigente. `sequenceStateRestored:false` e
`targetUse:"verification_only_sequences_not_reseeded"`: sequências não são
reposicionadas; o destino serve somente à verificação, não à retomada da aplicação.

## CLI local

Exemplo com URLs descartáveis sem senha. Antes de executar, preparar
`manifest.json`, `plan.json` e um `capacity.json` recém-medido mediante inventário
independente da fixture; esses arquivos não são gerados automaticamente pelo CLI.
Definir `GANSO_GIT_SHA` com o SHA real do build que gerou o manifesto. Os paths
abaixo são exemplos absolutos e devem existir conforme os requisitos acima.

```sh
export GANSO_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55403/ganso_data03_source_test'
export GANSO_RESTORE_DATABASE_URL='postgresql://postgres@127.0.0.1:55403/ganso_data03_restore_test'
export GANSO_GIT_SHA='<SHA real de 40 caracteres hexadecimais do build>'
mkdir -m 700 /private/tmp/data03-export-fixture
node apps/api/dist/retention-archive-cli.js \
  --manifest /private/tmp/data03-inputs/manifest.json \
  --plan /private/tmp/data03-inputs/plan.json \
  --capacity /private/tmp/data03-inputs/capacity.json \
  --directory /private/tmp/data03-export-fixture \
  --max-bytes 1048576
```

Este modo exporta e restaura na mesma execução. Sucesso imprime apenas
`sha256:<hash do certificado>`. Falha retorna código 1 e mensagem genérica sem
URLs, credenciais ou payloads. Um diretório ocupado não é reutilizado.

Para verificar arquivo preexistente, usar somente `--archive`, sem `--manifest`
ou `--plan`, e os dois hashes independentes. O destino deve continuar vazio e ter
exatamente a identidade fixada pelo arquivo; após restore concluído, as tabelas
estão ocupadas e nova tentativa é recusada. Preparação do ciclo de vida do banco
descartável é externa ao CLI, sem limpeza automática do destino.

```sh
mkdir -m 700 /private/tmp/data03-restore-fixture
node apps/api/dist/retention-archive-cli.js \
  --archive /private/tmp/data03-export-fixture/archive.json \
  --expected-archive-hash '<hash SHA256 independente do arquivo>' \
  --expected-plan-hash '<hash SHA256 independente do plano>' \
  --capacity /private/tmp/data03-inputs/capacity.json \
  --directory /private/tmp/data03-restore-fixture \
  --max-bytes 1048576
```

O modo separado copia o arquivo para a nova saída antes do restore e
não precisa conectar a origem. O SHA do código continua obrigatório e o recibo
de capacidade deve ser atualizado. Hashes são 64 hex, sem prefixo `sha256:`.

## Expiração e continuidade

Não há rotina de retenção/limpeza de arquivos. A expiração invalida o certificado;
a remoção posterior exige lista manual dos paths exatos do ensaio. Não usar glob,
diretório pai ou prune global. Falha de escrita mantém staging em quarentena;
arquivo e staging remanescentes continuam consumindo espaço até revisão explícita.
O writer remove somente seus links temporários concluídos e seu próprio lock.

Ausência histórica de raw, âncora, referências ou fecho não é recuperada pelo
ensaio. Não há aqui restauração comprovada de corpus real, soak ou saúde de feeds.
Resultados efetivamente observados devem constar no recibo/evidência do bloco.

Decisão já aprovada na retomada de 12/09/2026: manter HOLD enquanto
fecho/horizontes forem desconhecidos, com custo externo 0 e preservação das
evidências existentes. O armazenamento continua crescendo; a série de capacidade
DATA-01 existente não é reiniciada por este bloco. Uma extração real futura exige
janela, âncoras/continuidade, fecho, destino, volume, duração e espaço medidos, além
do escopo e gates aplicáveis. Nenhuma extração nova é necessária para cumprir a
recomendação conservadora; não há backup externo rotineiro ou exclusão automática.

DATA-04 pode preparar seu consumo desse contrato e reconhecer o certificado
exato; estes certificados sintéticos não tornam qualquer conjunto elegível para
limpeza. Nenhuma execução de remoção é concedida por este runbook.
