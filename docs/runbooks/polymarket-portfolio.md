# Runbook — motor de portfólio e gates (RFC-013)

**SIMULAÇÃO — SEM EXECUÇÃO REAL.** O serviço `polymarket-portfolio` decide
quanto apostar e quando sair, sobre dados gravados. Ele não assina, não
autentica e não cria ordem real; o guard automatizado é
[`apps/api/test/polymarket/portfolio/scope.test.ts`](../../apps/api/test/polymarket/portfolio/scope.test.ts),
que roda no `make verify` e no CI.

## O que o serviço loga

| Log                            | Cadência        | O que confirma                                                                          |
| ------------------------------ | --------------- | --------------------------------------------------------------------------------------- |
| `PORTFOLIO_BOOT`               | boot            | `config_version`, `config_hash`, `factor_map_version`, `factor_map_hash`                |
| `PORTFOLIO_CYCLE`              | 60 s            | `evaluated`, `entrable`, `state`, `positions`, `open_breakers`, `stale_marks`           |
| `PORTFOLIO_EXIT_CYCLE`         | 30 s            | posições abertas avaliadas; `EXIT` gravado quando o veredito muda                       |
| `PORTFOLIO_GATES_MEASURED`     | boot e 1 h      | os seis gates e `rfc_009_status`                                                        |
| `PORTFOLIO_GATE_REPORT_MINTED` | quando muda     | um relatório novo — só sai quando **um veredito** muda, não a cada ciclo                |
| `PORTFOLIO_G2_CLOCK_RESET`     | quando muda     | `regime_fingerprint_changed` = a venue mudou fee/tick naquela categoria                 |
| `PORTFOLIO_REPLAY_OK`          | junto dos gates | as 50 decisões mais novas reproduzem; `PORTFOLIO_REPLAY_MISMATCH` é para acordar alguém |

## Os gates, e o que cada estado significa

`INSUFFICIENT_DATA` **não** é `FAIL`. "Ainda não medimos" e "medimos e não
funcionou" são estados diferentes, e colapsá-los foi exatamente o incidente do
G1 em 2026-08-26 — um `PASS` sem evidência nenhuma, de pé por ~4 h. Um gate que
passa sem dado é pior que um que falha: um `FAIL` é lido como problema e
investigado, um `PASS` é lido como progresso e acumulado.

Consulta paginada de todas as medições já gravadas (nenhuma é podada):

```sh
curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://178.105.65.251/api/polymarket/gates/measurements?gate=G2&limit=20"
```

## Registrar a aprovação do proprietário (G6)

G6 é o único gate que uma conta não passa. Ele é escrito contra um
**relatório** — um retrato congelado dos seis vereditos — e o motor cunha um
relatório novo assim que qualquer veredito muda. Uma aprovação vale, portanto,
exatamente enquanto valerem os números que ela leu.

Deliberadamente **não** existe endpoint para isso. O perímetro da RFC-013
publica as superfícies do portfólio somente em GET, e as duas coisas que ficam
fechadas na borda são as que mudam o que o sistema tem permissão de fazer: sair
de `HALTED`, e esta.

### 1. Ver o relatório corrente

```sh
docker compose exec -T api node dist/gates-cli.js show
```

Devolve `report_id`, `overall_status`, os seis vereditos, se já há aprovação, e
a expectativa calibrada que a RFC exige impressa no relatório.

### 2. Escrever a revisão

A revisão vai por **stdin** — texto livre, mínimo de 40 caracteres, e ela é o
gate: uma assinatura sobre uma página em branco não é uma revisão.

```sh
docker compose exec -T api node dist/gates-cli.js approve 7 \
  --reviewer owner --acknowledge-expectation < revisao.txt
```

### 3. O que a CLI recusa, e por quê

| Código                         | Situação                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `REPORT_NOT_FOUND`             | não existe relatório com esse id                                                                  |
| `REPORT_NOT_CURRENT`           | um relatório mais novo existe: os números se mexeram, então a revisão seria de outra coisa        |
| `REPORT_ALREADY_APPROVED`      | uma aprovação não é editada no lugar; mudar de ideia significa números novos, logo relatório novo |
| `GATES_NOT_READY`              | algum gate medido não está `PASS` — assinar antes é o gate esperando a aritmética o alcançar      |
| `EMPTY_NOTE`                   | menos de 40 caracteres de registro escrito                                                        |
| `INVALID_REVIEWER`             | `--reviewer` fora de `[A-Za-z0-9_.@-]{1,64}`                                                      |
| `EXPECTATION_NOT_ACKNOWLEDGED` | faltou `--acknowledge-expectation`                                                                |
| `APPROVAL_RACED`               | o relatório mudou entre a checagem e a escrita; a mesma guarda está dentro do `UPDATE`            |

Aprovar **não** libera a RFC-009 sozinho: o veredito geral só sai de `BLOCKED`
com os seis gates em `PASS`, e ligar execução real continua sendo um ato
manual, explícito e separado do proprietário.

## Operação

```sh
cd /opt/ganso-market
make server-status
make server-logs
docker compose --env-file deploy/server.env --profile polymarket \
  up --build --detach polymarket-portfolio
```

**Merge, CD e rebuild de profile são três passos e nenhum adivinha o outro.**
O CD entrega `config/` e o checkout; a imagem dos containers de profile só muda
no rebuild explícito. Quando um PR mexe ao mesmo tempo num arquivo de `config/`
e no conteúdo que ele nomeia, o rebuild tem que sair na mesma janela do merge —
foi assim que o `score_version` 1.1.0 foi queimado permanentemente em
2026-08-26. Detalhe em [`single-server.md`](single-server.md).
