# BTC — recuperação verificável e ensaio de coleta (OPS-04)

Plano verificado em **2026-09-11**, base `c528d5b0d74cc5cf8894ee953dd335df5f1e1b03`.
Plano reconciliado com os artefatos locais OPS-01 a OPS-07 em **2026-09-12**;
o [recibo original OPS-04](../roadmap/receipts/OPS-04.md) preserva a avaliação anterior.
**Plano pronto; não aplicado; nenhuma janela de produção observada; soak pendente.**
Este documento prepara a operação da [RFC-021](../rfcs/RFC-021-silencio-do-feed-e-kill-switch.md).
Executar etapas de escrita somente dentro da autorização operacional concreta vigente.
D3 já aprovada em 05/09: isso permite seu código condicionado, não um rearme forçado.
Não houve SSH nesta tarefa. Não habilitar live/signer nem apagar dados/gaps/ledger.

## 1. Gate de liberação — verificar no release integrado

| Dependência | Artefato efetivamente conferido | Resultado / pendência |
|---|---|---|
| OPS-01 | [Recibo](../roadmap/receipts/OPS-01.md), [inventário](../test-results/btc/OPS-01.md), base acima | Inventário original local. Identidade SSH reconciliada no console Hetzner pelo proprietário em 12/09/2026 UTC; [registro atualizado](../ops/SERVER_ACCESS.md). A [entrega integrada](../test-results/btc/RFC-021-release.md) registra a nova inspeção remota; não inferir saúde de coleta da saúde dos containers. |
| OPS-02 | [Recibo](../roadmap/receipts/OPS-02.md), `clobsilence.ts`, `dualws.ts`, `orchestrator.ts`, `quality.ts`, migration `0021` | Código e 127 testes registrados. Conferir inclusão do patch/migration no SHA integrado e CI desse release. |
| OPS-03 | [Recibo](../roadmap/receipts/OPS-03.md), `paper/brokerstore.ts`, `paper/runner.ts` | Código e 168 + 8 testes PostgreSQL registrados. Conferir SHA integrado/CI; aplicação não atestada. |
| OPS-05 | [Recibo](../roadmap/receipts/OPS-05.md), `rtds.ts`, `rtdssilence.ts`, `rtdsgaps.ts`, migration `0022` | Detector global/por feed-símbolo, persistência idempotente e recuperação implementados. Limiares 120 s/3 reconnects precisam de medição operacional; conferir release/schema. |
| OPS-06 | [Recibo](../roadmap/receipts/OPS-06.md), heartbeat do recorder, `deploy/recorder_watchdog.py`, instalador e units | Artefatos e 56 testes locais registrados; instalação/ativação no host não atestadas. Primeira instalação exige antes a imagem com heartbeat e SHA válido; procedimento abaixo. |
| OPS-07 | [Recibo](../roadmap/receipts/OPS-07.md), `samplers.ts:processRows` e testes SQL/consumidores | Sweep persiste `closed=TRUE` de forma idempotente, sem inferir resolução. Monotonicidade pertence ao sweep; upserts do registry preservam autoridade preexistente para escrever false. Observar separadamente eventual regressão no refresh. |

Pré-requisitos reais da [RFC-020](../rfcs/RFC-020-deploy-sem-derrubar-o-banco.md), todos ancestrais da base:
D1 `621697cad734c721b4cc5c45f52b1cde38baa232`; D2 `b6868e6bc3394fea8d0006b19a953f2b44d3befc`;
D3 `d0339c608ca964c8b66a3919ff3e319ec079473d`; D4a `4906639e85f50cbf7162eaec1e751f0683e160ca`;
D4b `2ac761b2e2117ad12f42a4d8f69a10e5975b25e4`. A RFC registra prova de produção em 07/09;
ela não identifica os processos atuais. Não repetir uma parada do banco para comprovar RFC-020.

Antes de liberar, preencher no recibo operacional: SHAs integrados OPS-02/03/05/06/07,
`OPS_RELEASE` (40 hex), hash SHA-256 do `git archive`, CI `make verify` + integração do
mesmo SHA, schema/checksums e compatibilidade com as imagens de rollback. Resolver cada
SHA com `git rev-parse <ref>^{commit}` e conferir `git merge-base --is-ancestor <sha> "$OPS_RELEASE"`.
Conferir arquivos/testes no release (`git show "$OPS_RELEASE:<path>"`), além dos recibos.
Artefatos ausentes não são dispensados pela existência deste plano.

## 2. Preparação e evidência externa

Os comandos de host abaixo são **Bash**, em `/opt/ganso-market`, após o gate e a
autorização aplicável. Confirmar ferramentas `timeout`, `flock`, `sha256sum`, Docker/Compose.
Usar `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes` com a identidade fixada no registro.
Não imprimir `server.env`, secrets, `docker inspect` integral ou `compose config` integral.

```bash
set -euo pipefail
cd /opt/ganso-market
umask 077
OPS_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OPS_EVID="/var/log/ganso/ops04/$OPS_STAMP" # proposto: fora de containers e do rsync de deploy
install -d -m 0700 "$OPS_EVID"
dc() { docker compose --env-file deploy/server.env --profile polymarket "$@"; }
# Executar psql em processo externo para que timeout imponha o limite.
db() { timeout 20s bash -c 'docker compose --env-file deploy/server.env exec -T -e PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=5000" postgres psql -X -v ON_ERROR_STOP=1 -U ganso_market -d ganso_market "$@"' -- "$@"; }
OPS_TARGETS=(polymarket-recorder polymarket-paper)
# Acrescentar estimator/resolution/portfolio somente se a inspeção do delta ou RFC-020 exigir.
OPS_INVENTORY=(polymarket-recorder polymarket-paper polymarket-estimator polymarket-resolution polymarket-portfolio)
capture() {
  local label="$1" svc cid
  test "$(du -sk "$OPS_EVID" | awk '{print $1}')" -lt 65536 # teto da sessão: 64 MiB
  date -u +%FT%TZ > "$OPS_EVID/$label.utc"
  for svc in postgres "${OPS_INVENTORY[@]}"; do
    cid=$(dc ps --all -q "$svc")
    if test -z "$cid"; then printf 'ausente\n' > "$OPS_EVID/$label.$svc.state"; continue; fi
    docker inspect --format '{{.Id}} {{.Created}} {{.Image}} {{.State.Status}} {{.State.StartedAt}} {{.RestartCount}} {{index .Config.Labels "com.docker.compose.config-hash"}}' "$cid" > "$OPS_EVID/$label.$svc.state"
    if test "$svc" != postgres; then
      timeout 10s docker exec "$cid" cat /etc/ganso/release-sha > "$OPS_EVID/$label.$svc.sha" || printf 'SHA runtime indisponível: %s\n' "$svc" >> "$OPS_EVID/$label.errors"
      timeout 10s docker logs --since 10m --tail 2000 --timestamps "$cid" 2>&1 | head -c 1048576 > "$OPS_EVID/$label.$svc.log" || printf 'captura incompleta: %s\n' "$svc" >> "$OPS_EVID/$label.errors"
    fi
  done
  db -Atc 'SELECT pg_postmaster_start_time();' > "$OPS_EVID/$label.pg-start"
}
capture before
db -Atc 'SELECT condition_id FROM polymarket_markets WHERE closed IS TRUE ORDER BY condition_id;' | LC_ALL=C sort > "$OPS_EVID/closed.before"
cp docker-compose.yml "$OPS_EVID/compose.before.yml"
cp config/runtime.json "$OPS_EVID/runtime.before.json"
cp config/macro-calendar.json "$OPS_EVID/macro-calendar.before.json"
printf 'services:\n' > "$OPS_EVID/images.before.yml"
for svc in "${OPS_TARGETS[@]}"; do
  cid=$(dc ps --all -q "$svc"); test -n "$cid"
  tag="ganso-ops04-rollback/$svc:$OPS_STAMP"
  docker image tag "$(docker inspect --format '{{.Image}}' "$cid")" "$tag"
  printf '  %s:\n    image: %s\n' "$svc" "$tag" >> "$OPS_EVID/images.before.yml"
done
```

Guardar também `.deploy/current-sha`, versão Docker/Compose e hashes dos arquivos de
configuração; comparar a configuração alvo sem expor conteúdo sensível. Capturas
incompletas exigem repetição delimitada antes de recreate. Não fazer image prune durante
a janela. O diretório acima tem no máximo 64 MiB **mais uma captura de até 5 MiB**;
ao atingir o teto, interromper coleta de logs e preservar/exportar evidência antes de
continuar. Não apagar automaticamente. Logs Docker atuais (`json-file`, 10m × 3)
são limitados, mas desaparecem no recreate e não substituem a evidência externa.
Inventariar os cinco profiles não autoriza ativar serviços ausentes/parados. SHA runtime
indisponível exige resolver o artefato pela imagem capturada e seu manifesto antes do
deploy; não substituir pela versão do checkout. Reservar a janela sem CD concorrente.

O [runbook OPS-06](recorder-watchdog.md) e o instalador definem os nomes reais abaixo.
O observador tem timeout de 70 s, cooldown de 300 s com backoff até 1.800 s, máximo
de 3 restarts/h e 32 eventos de até 64 KiB. Verificar folga de host/recorder e
permissões root do checkout conforme aquele runbook. O marker de manutenção inibe
também a observação do watchdog; durante a janela usar `capture` e Q1/Q2 externos.

```bash
OPS06_TIMER=ganso-recorder-watchdog.timer
OPS06_SERVICE=ganso-recorder-watchdog.service
OPS06_STATE=/var/lib/ganso/recorder-watchdog
OPS06_MAINTENANCE_FILE="$OPS06_STATE/maintenance"
```

**Instalação existente:** capturar pelo menos dois ciclos externos datados antes
da manutenção, com ID/SHA, heartbeat/SQL e orçamento. Registrar enabled/active
anteriores para reversão. Se o marker já existe, preservá-lo e resolver a manutenção
anterior antes de avançar. Parar timer e service antes de criar o marker; aguardar
qualquer pedido Docker já aceito, que não é revertido ao parar a unit.

```bash
systemctl cat "$OPS06_TIMER" "$OPS06_SERVICE" > "$OPS_EVID/supervisor.units"
systemctl is-enabled "$OPS06_TIMER" > "$OPS_EVID/supervisor.enabled.before" || true
systemctl is-active "$OPS06_TIMER" > "$OPS_EVID/supervisor.active.before" || true
test ! -e "$OPS06_MAINTENANCE_FILE" # se já existia, manter manutenção e investigar
systemctl disable --now "$OPS06_TIMER"
systemctl stop "$OPS06_SERVICE"
touch "$OPS06_MAINTENANCE_FILE"
```

**Primeira instalação:** registrar a ausência das duas units. O instalador verifica
heartbeat e SHA dentro do recorder em execução; portanto só pode ser executado
depois de implantar a imagem OPS-06. A baseline e a primeira troca de imagem usam
os probes externos Docker/SQL acima, sem alegar cobertura do supervisor ainda ausente.
Criar o diretório de estado root:root 0700 e o marker antes dessa troca, sem alterar
diretório/marker preexistentes sem investigação. Após recorder e paper validados,
seguir o bloco de instalação da seção 3. A instalação inicia o timer, mas o marker
impede a unit de executar até a validação e remoção explícita.

```bash
# Somente para primeira instalação, com ausência das units e do estado confirmada.
test ! -e "$OPS06_STATE"
install -d -o root -g root -m 0700 "$OPS06_STATE"
touch "$OPS06_MAINTENANCE_FILE"
```

Se o estado já existir de uma instalação anterior, conferir root:root 0700 e preservar
orçamento/evidência; não executar o bloco de criação nem limpar arquivos existentes.

Exigir os testes locais OPS-06 de event loop travado/DB indisponível, teto e backoff.
Não injetar falha em produção neste plano. Em instalação existente, ausência de
evidência exige investigar antes de recreate; na primeira instalação, registrar
essa ausência como baseline e confirmar pelo menos dois ciclos após ativação.
`systemctl active` sozinho não aceita a etapa. Preservar evidência e marker durante
abortos; remover apenas o marker criado nesta operação quando retomada a recuperação
automática. Supervisor só pode atuar no recorder.

## 3. Sequência de aplicação e reversão

| Etapa / duração prevista | Comando / alvo | Impacto, pós-ação e reversão |
|---|---|---|
| Baseline, 10 min (amostra/min) | `capture before`; Q1/Q2 abaixo | Read-only no runtime; medir dados, gaps, filas, lag, switch e banco. Reversão: encerrar probes; preservar arquivos. |
| Supervisor existente, ≥2 ciclos; ou baseline de primeira instalação | Blocos da seção 2 | Registrar estado anterior; parar timer/service e manter marker durante a manutenção. Na primeira instalação, usar probes externos até a imagem com heartbeat estar disponível. |
| Release default, orçamento 45 min | Canal existente `.github/workflows/ci-cd.yml`, arquivo por `git archive --format=tar.gz --output="$OPS_ARCHIVE" "$OPS_RELEASE"`, envio SSH `"deploy $OPS_RELEASE" < "$OPS_ARCHIVE"` pela chave restrita já instalada | `remote-deploy.sh` valida arquivo ≤50 MiB, guarda código e chama `make server-update`: build → postgres sem force → migrate → api/web/nginx/market-engine com `--no-deps` → probes. Não rodar manualmente o script sem o contrato de SSH. Registrar hash/saída do job. Rollback automático só de código/default, migrations permanecem. |
| Schema + banco, ≤2 min de consultas | `capture after-default`; Q0 abaixo | ID/Created/Image/config-hash e `pg_postmaster_start_time()` do postgres devem ser iguais. Antes do envio, comparar digest/config-hash alvo: até `up postgres` sem force recria se mudarem. Mudança de banco/config é fora desta operação: abortar. |
| Workers, build medido; wait ≤180 s cada | Bloco abaixo, recorder primeiro, paper após 5 min de Q1 saudável | Pausa apenas dos alvos; registrar onset/fim, ID/SHA e gaps. Demais workers só se incluídos explicitamente. Rollback de imagem/config abaixo, nunca postgres. |
| Instalar/retomar supervisor, ≥2 ciclos | Bloco de instalação/ativação abaixo | Somente após verificar novo ID/SHA e ausência de falha de persistência. Registrar evidência por ciclo; recuperação/backoff habilitados. Reversão: parar timer/service e preservar marker/estado; na primeira instalação, uninstall reversível. |
| D3, mínimo 900 s após baseline válida | Q1/Q2 por minuto e ledger Q3 | Apenas observar 15 ticks internos condicionados; sem endpoint/UPDATE manual. Reinício/reset recomeça a sequência. Parar avanço se guardas falharem. |
| Ensaio, 60 min contínuos; D4 até 24 h | Q1/Q2 por minuto, `capture` a cada 5 min; Q4 após sweep e refresh | Após último recreate/reset. Qualquer buraco reinicia a janela; guardar também o trecho reprovado. Encerrar probes é reversível; dados preservados. |

Conferir [single-server](single-server.md), [recorder](polymarket-recorder.md),
`deploy/remote-deploy.sh` e `deploy/healthcheck.sh`. Os probes são `/`, API live/ready e
engine ready: **não cobrem recorder nem commit**. `--wait` do recorder atual só prova
processo rodando. Evitar os atalhos `make recorder-up`/profile `up --build` sem `--no-deps`.

Q0 (antes de qualquer worker; comparar **todas** versões/checksums com o release e saída
de migrate, inclusive 0021 e 0022; não apenas `max(version)`):

```bash
# Depois de o job default TERMINAR; obter antes causaria deadlock com remote-deploy.sh.
exec 9<>/opt/ganso-market/.deploy/deploy.lock
flock -w 30 -x 9
: "${OPS_RELEASE:?SHA integrado do release autorizado}"
test "$(cat .deploy/current-sha)" = "$OPS_RELEASE"
test "$(cat deploy/release-sha)" = "$OPS_RELEASE"
db -c "SELECT version, checksum_sha256 FROM schema_versions WHERE component='foundation' ORDER BY version;"
db -c "SELECT indexname,indexdef FROM pg_indexes WHERE indexname IN ('polymarket_silence_gap_episode_idx','polymarket_rtds_gap_episode_idx') ORDER BY indexname;"
sha256sum migrations/0021_polymarket_silence_gap_idempotency.sql migrations/0022_polymarket_rtds_gap_idempotency.sql
# Comparar com before.postgres.state: o hash efetivo precisa continuar igual.
dc config --hash postgres
dc build --pull "${OPS_TARGETS[@]}"
dc up --detach --no-deps --no-build --wait --wait-timeout 180 polymarket-recorder
capture after-recorder
# PARAR aqui para 5 min de Q1/Q2; só então atualizar o paper e alvos adicionais autorizados.
dc up --detach --no-deps --no-build --wait --wait-timeout 180 polymarket-paper
for svc in "${OPS_TARGETS[@]}"; do
  case "$svc" in polymarket-recorder|polymarket-paper) continue;; esac
  dc up --detach --no-deps --no-build --wait --wait-timeout 180 "$svc"
done
capture after-workers
SERVER_ENV=deploy/server.env ./deploy/healthcheck.sh
```

Comparar `/etc/ganso/release-sha` de cada alvo com `OPS_RELEASE`, não com o checkout.
Fixar nova baseline de RestartCount após recreate planejado. `migrate` precisa ter
exit 0 antes deste bloco; não reaplicar migrations só para repetir prova. OPS-05
acrescenta 0022; OPS-07 não altera schema. Ambas 0021/0022 exigem checksum no manifesto.

Primeira instalação ou atualização das units, depois das verificações acima:

```bash
# Na primeira instalação, criar somente se o diretório ainda não existir.
if test ! -e "$OPS06_STATE"; then
  install -d -o root -g root -m 0700 "$OPS06_STATE"
fi
# O marker deve ter sido criado na preparação desta operação e continuar presente.
test -f "$OPS06_MAINTENANCE_FILE"
/opt/ganso-market/deploy/install-recorder-watchdog-timer.sh --dry-run
/opt/ganso-market/deploy/install-recorder-watchdog-timer.sh
systemctl cat "$OPS06_TIMER" "$OPS06_SERVICE" > "$OPS_EVID/supervisor.units.after"
# Só remover o marker após conferir saúde/ID/SHA do novo recorder e SQL.
rm -- "$OPS06_MAINTENANCE_FILE"
systemctl enable --now "$OPS06_TIMER"
systemctl start "$OPS06_SERVICE"
systemctl show "$OPS06_SERVICE" -p Result -p ExecMainStatus -p ExecMainStartTimestamp > "$OPS_EVID/supervisor.probe"
cp "$OPS06_STATE/status.json" "$OPS_EVID/supervisor.first.json"
```

Esperar o próximo ciclo do timer, salvar outro `status.json` e conferir UTC crescente,
ID/SHA esperado e diagnóstico; o sucesso de `--check-target`/instalador não exige DB
saudável nem prova coleta. Na primeira instalação, registrar UTC da ativação e o trecho
sem cobertura. Em rollback, parar timer/service antes de criar o marker; o uninstall
`deploy/install-recorder-watchdog-timer.sh --uninstall` preserva estado/evidência.
Se o supervisor já estava instalado, restaurar seu estado anterior conforme o recibo.

Rollback dos workers: primeiro inibir supervisor e capturar a falha. Exigir compatibilidade
da imagem anterior com schema atual. O rollback de `remote-deploy.sh` não restaura profiles.
Usar Compose anterior, imagens tagueadas e **somente binds alterados nesta operação**
restaurados da cópia, sem desfazer mudanças concorrentes. Para o Compose de backup fora
da raiz, `--project-directory` preserva resolução dos paths relativos.

```bash
systemctl disable --now "$OPS06_TIMER"
systemctl stop "$OPS06_SERVICE"
touch "$OPS06_MAINTENANCE_FILE"
capture abort || printf 'captura de falha incompleta; preservar arquivos e prosseguir com reversão\n' >> "$OPS_EVID/abort.errors"
# Se o release alterou estes binds, comparar com os hashes registrados antes de restaurar.
# cp "$OPS_EVID/runtime.before.json" config/runtime.json
# cp "$OPS_EVID/macro-calendar.before.json" config/macro-calendar.json
docker compose --project-directory /opt/ganso-market --env-file /opt/ganso-market/deploy/server.env \
  -f "$OPS_EVID/compose.before.yml" -f "$OPS_EVID/images.before.yml" --profile polymarket \
  up --detach --no-deps --no-build --force-recreate --wait --wait-timeout 180 "${OPS_TARGETS[@]}"
capture after-rollback
```

Após rollback: conferir SHA anterior por serviço, banco invariável e repetir Q1/Q2/probes.
Manter o lock durante intervenção/validação; ao encerrar com resultado registrado,
liberá-lo com `flock -u 9` e `exec 9>&-`. Se retomar em outra sessão, adquirir o lock e
revalidar o release atual antes de agir. Não desfazer um CD posterior silenciosamente.
Não remover migrations 0021/0022 ou seus índices, fechar gaps por UPDATE, zerar switch ou restaurar banco.
Se imagem anterior incompatível, parar os workers afetados (`dc stop <alvo>`), preservar
evidência e tratar correção; não repetir restarts. Deixar explícito paper parado/sem coleta.

## 4. Consultas do ensaio

Salvar Q1 como `$OPS_EVID/q1.sql` e Q2 como `$OPS_EVID/q2.sql` no host. `db` impõe 20 s
por invocação; timeout/arquivo vazio conta como falha de observação. Usar uma consulta
por minuto, salva fora do container, desde a baseline até o fim do ensaio. Exemplo de
janela de 60 min (61 amostras; grava custo real, não promete cadência sem atraso):

```bash
OPS_T0=$(date -u +%FT%TZ)
for i in $(seq 0 60); do
  t=$(date -u +%Y%m%dT%H%M%SZ)
  db --csv -f - < "$OPS_EVID/q1.sql" > "$OPS_EVID/$t.q1.csv"
  db --csv -v t0="$OPS_T0" -f - < "$OPS_EVID/q2.sql" > "$OPS_EVID/$t.q2.csv"
  if (( i % 5 == 0 )); then capture "sample-$t"; fi
  if (( i < 60 )); then sleep 60; fi
done
```

Q1 — linhas **visíveis no PostgreSQL** por minuto completo, IDs e relógios por série.
Repete o minuto anterior para permitir detectar inserts tardios. Confirmar pares RTDS
com assinaturas do release OPS-05; atualmente spot recebe `btcusdt`, TWAP `btc/usd` etc.
Não transformar fonte ausente/futura em frescor nem usar snapshots_full/âncoras para D2.

```sql
WITH t AS (SELECT date_trunc('minute', statement_timestamp()) AS until),
expected(series) AS (
  VALUES ('snapshots'), ('deltas')
  UNION ALL
  SELECT 'rtds/'||f||'/'||c||CASE WHEN f='spot' THEN 'usdt' ELSE '/usd' END
  FROM unnest(ARRAY['spot','twap30','twap60']) f
  CROSS JOIN unnest(ARRAY['btc','eth','sol','xrp']) c
), samples AS (
  SELECT 'snapshots' AS series, snapshot_id AS id, source_ts, received_at
  FROM polymarket_book_snapshots,t WHERE received_at >= until-interval '2 min' AND received_at < until
  UNION ALL
  SELECT 'deltas',delta_id,source_ts,received_at
  FROM polymarket_book_deltas,t WHERE received_at >= until-interval '2 min' AND received_at < until
  UNION ALL
  SELECT 'rtds/'||feed||'/'||symbol,rtds_price_id,source_ts,received_at
  FROM polymarket_rtds_prices,t WHERE received_at >= until-interval '2 min' AND received_at < until
)
SELECT statement_timestamp() AS observed_at,g.minute,e.series,count(s.id) AS visible_rows,
       max(s.id) AS visible_max_id,max(s.source_ts) AS max_source_ts,max(s.received_at) AS max_received_at,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (s.received_at-s.source_ts))*1000) AS source_receive_p99_ms,
       count(s.id) FILTER (WHERE s.source_ts IS NULL) AS missing_source,
       count(s.id) FILTER (WHERE s.source_ts>s.received_at) AS future_source
FROM t CROSS JOIN LATERAL generate_series(until-interval '2 min',until-interval '1 min',interval '1 min') g(minute)
CROSS JOIN expected e LEFT JOIN samples s ON s.series=e.series AND s.received_at>=g.minute AND s.received_at<g.minute+interval '1 min'
GROUP BY g.minute,e.series ORDER BY g.minute,e.series;
```

Q2 — D3 no instante observado e todos os gaps sobrepostos, inclusive antigos abertos:

```sql
WITH h AS (
 SELECT statement_timestamp() AS observed_at,
   (SELECT max(received_at) FROM polymarket_book_snapshots) AS snapshots,
   (SELECT max(received_at) FROM polymarket_book_deltas) AS deltas,
   EXISTS(SELECT 1 FROM polymarket_data_gaps WHERE cause='stream_silent' AND gap_end IS NULL) AS silent_open
)
SELECT h.*,k.engaged,k.reason,k.engaged_at,k.rearmed_at,k.frozen_markets_json,
       snapshots>observed_at-interval '5 min' AND snapshots<=observed_at
       AND deltas>observed_at-interval '5 min' AND deltas<=observed_at AND NOT silent_open AS healthy_now
FROM h CROSS JOIN paper_kill_switch k WHERE k.kill_switch_id=1;
SELECT gap_id,source,token_id,cause,gap_start,gap_end,details_json
FROM polymarket_data_gaps WHERE gap_start<=statement_timestamp() AND (gap_end IS NULL OR gap_end>=:'t0'::timestamptz)
ORDER BY gap_start,gap_id LIMIT 501;
```

501 linhas significa captura saturada: delimitar/paginar por `gap_id`, preservar o total
e reprovar aceite até completar evidência. Medir onset até primeira observação do gap
persistido; alvo CLOB ≤N+60 s, N padrão 120 s (piso 30). Detalhes devem preservar UUID,
controle `blind`/`venue_quiet`/`unavailable`, tentativas e motivo de fechamento. Controle
REST falho não dispensa gap. Gap fechado por saída do universo não prova feed recuperado.

Q3 — executar `db -v t0="$OPS_T0" -f -` com SQL abaixo; incluir também o engate
referenciado pelo `engaged_at` atual, mesmo anterior a t0:

```sql
SELECT event_id,event_ts,event_type,payload_json,
 CASE WHEN event_type='kill_switch_rearmed' AND payload_json->>'mode'='auto'
 THEN extract(epoch FROM (event_ts-(payload_json->>'healthy_since')::timestamptz)) END AS healthy_seconds
FROM paper_ledger_events
WHERE event_type IN ('kill_switch_engaged','kill_switch_rearmed')
  AND (event_ts>=:'t0'::timestamptz OR event_ts=(SELECT engaged_at FROM paper_kill_switch WHERE kill_switch_id=1)
       OR event_ts IN (SELECT (payload_json->>'engaged_at')::timestamptz FROM paper_ledger_events
                      WHERE event_type='kill_switch_rearmed' AND payload_json->>'mode'='auto'
                        AND event_ts>=:'t0'::timestamptz))
ORDER BY event_ts,event_id;
```

Aceitar D3 apenas com `mode:auto`, `healthy_ticks:15`, `tick_ms:60000`, `healthy_seconds>=900`,
um único rearme por `engaged_at` e log `PAPER_KILL_SWITCH_AUTO_REARMED`. O engate deve ser
RECORDER_STALE automático/legado elegível; `mode:manual`, perdas ou disputa não são elegíveis.
Snapshots e deltas devem permanecer <300.000 ms, sem stream_silent aberta de **qualquer**
source. Erro, gap, tick perdido, reboot ou novo engate reinicia a sequência. SQL externo
não conta ticks internos (estado só em memória): correlacionar ledger, logs/cadência e
amostras. Se não houver episódio elegível, registrar D3 operacional **não observado**;
não engatar/rearmar para fabricar aceite. Evento D2 deve trazer série e idades.

Q4 — executar após o sweep e após refresh Gamma, até 24 h; comparar mercados específicos:

```sql
SELECT r.condition_id,r.event_type,r.received_at,r.payload_json #>> '{raw,closed}' AS raw_closed,
       r.payload_json #>> '{raw,resolved}' AS raw_resolved,m.closed,m.updated_at
FROM polymarket_resolution_events r LEFT JOIN polymarket_markets m USING(condition_id)
WHERE r.received_at>=:'t0'::timestamptz AND r.payload_json #>> '{raw,closed}'='true'
ORDER BY r.received_at,r.resolution_event_id LIMIT 501;
```

```bash
db -Atc 'SELECT condition_id FROM polymarket_markets WHERE closed IS TRUE ORDER BY condition_id;' | LC_ALL=C sort > "$OPS_EVID/closed.after"
comm -23 "$OPS_EVID/closed.before" "$OPS_EVID/closed.after" > "$OPS_EVID/closed.regressions"
test ! -s "$OPS_EVID/closed.regressions"
```

Repetir comparação usando também o conjunto pós-sweep como baseline do refresh.
Exigir raw.closed=true → coluna true e idempotência do sweep; registrar qualquer
regressão true→false/NULL ou desaparecimento após o refresh. OPS-07 não mudou a
autoridade do registry: essa monotonicidade global não está implementada pelo bloco
e uma regressão exige diagnóstico do writer antes do aceite operacional. Sem mercado
novo observado, D4 segue pendente; count>0 histórico não basta. A prova local OPS-07
cobre false/ausente no sweep e regressões de seus consumidores. `closed`
não implica `resolved`/`market_resolved`, resultado final, label, payout ou settlement;
o sweep não pode criar resolução a partir de closed.

## 5. Aceite, abortos e continuidade

Aceitar a janela somente com minutos completos sem buracos de observação, progresso
regular de snapshots/deltas **e de cada par RTDS**, IDs visíveis e relógios coerentes,
gaps reconciliados e nenhuma perda/erro de persistência. Valores de preço podem repetir.
Fixar antes do deploy teto de lag por série: para source→receive, proposta operacional
`max(2 × p99 da baseline válida, 5.000 ms)`; baseline stale/inválida não define teto.
RTDS deve respeitar também os limites de fonte/recepção entregues por OPS-05. Esse teto
do ensaio não altera RECORDER_STALE_MS nem autoriza rearme.

**Backlog é um gate separado:** comparar p99/idade, minutos repetidos sem crescimento
tardio, STATUS `pipeline.deltasQueued`, `clob_silence.pendingWrites` e contadores
`insertFailures`/`overflowDropped`. Exigir filas drenadas e estáveis por ≥3 observações,
nenhuma perda e progresso no DB. Hoje STATUS vem a cada 5 min e não expõe lote em voo,
`messageChain` ou buffer RTDS; `received_at` é preenchido antes de INSERT, não há
`inserted_at`/clock de commit. Logo essas consultas **não provam ausência integral de
backlog**. Antes de dar esse aceite, exigir no artefato integrado observabilidade de
profundidade/idade do item mais antigo, inclusive em voo, por caminho CLOB/RTDS, com
limites e evidência externa OPS-06. Sem isso registrar “backlog não verificável”, não
“coleta saudável”; não implementar telemetria faltante dentro de OPS-04.

| Abortar / voltar | Resposta |
|---|---|
| SHA/checksum divergente, postgres mudou, probe/SQL timeout, evidência externa ausente | Interromper sequência; capturar; não avançar workers nem executar restart de banco. |
| ≥2 restarts não planejados em 10 min, ou teto menor de OPS-06 atingido | Inibir supervisor; parar tentativas; rollback compatível dos alvos ou mantê-los parados. |
| `BOOKPIPE_PERSIST_FAILED`, `BOOKPIPE_CHAIN_FAILED`, `RTDS_PERSIST_FAILED`, `RTDS_1M_PERSIST_FAILED`, `RTDS_GAP_PERSIST_FAILED`, `GAP_PERSIST_FAILED`; overflow/journal cheio/exaurido | Reprovar janela no primeiro erro; guardar dropped/janelas/tentativas. Investigar DB/pressão; rollback só se ligado ao release, nunca mascarar com restart repetido. |
| Sem avanço por 2 minutos em série esperada, idade/lag acima do teto em 2 amostras, fila crescente em 3 observações ou não drenada | Reprovar/inibir recuperação repetida; comparar venue/universo e gaps. Retomar janela do zero apenas após causa resolvida. |
| Rearme fora de D3, closed regrediu/gerou resolução indevida | Parar paper/alvo afetado, preservar ledger e voltar imagem compatível. Sem correção de dados improvisada. |

`WS_SILENCE_SHUTDOWN_UNFLUSHED`, `PAPER_KILL_SWITCH_TICK_FAILED`, `JOB_STILL_RUNNING` e
retenção falha também impedem declarar aceite enquanto não reconciliados; o retry de
retenção RFC-020 ocorre em 10 min, não prova recuperação antes de concluir.

Fechar recibo com quatro campos independentes: **plano pronto**, **aplicado** (UTC/SHA
por serviço/schema/supervisor), **janela observada** (início/fim, arquivos/hash,
aprovada/reprovada e limites), **soak pendente/concluído**. D4 24 h e D3 não observada
continuam pendentes mesmo se o ensaio de coleta passar.

Sete dias são uma meta posterior: guardar diariamente minutos completos, universo
efetivo por minuto, gaps, clocks e eventos fora do container, antes de retenção/quota.
Para cada minuto com universo >50 tokens, comparar deltas/min com 1% da **média por
minuto** da hora anterior completa (incluir zeros); exigir gap stream_silent cobrindo
cada queda e onset ≤N+60 s, e nenhum controle blind contradizendo fluxo normal no
mesmo escopo. STATUS de 5 min não prova universo de cada minuto: completar essa
evidência antes do aceite de sete dias. Não transformar 60 min, fixture ou expectativa
de soak em tarefa operacional concluída. Nenhum próximo bloco/monitor é iniciado aqui.
