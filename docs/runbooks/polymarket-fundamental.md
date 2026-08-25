# Runbook — modelo fundamental Polymarket (RFC-010)

O serviço `polymarket-estimator` estima, para cada token do universo gravado
pela RFC-007, a probabilidade `q` do desfecho YES com intervalo de incerteza
`[q_lo, q_hi]`, e grava essas estimativas versionadas em
`fundamental_estimates`. Ele **não** cria ordem, ordem de papel, sinal ou
posição, e não toca em wallet, signer ou credencial de trading. Os limites do
módulo estão em
[`docs/architecture/fundamental-model-scope.md`](../architecture/fundamental-model-scope.md);
leia esse documento antes de operar este serviço.

O serviço só lê PostgreSQL: ele consome o que o recorder da RFC-007 gravou e
não fala com nenhuma API externa.

> **FATO VERIFICADO:** no Compose, `polymarket-estimator` está apenas na rede
> `backend`, que é `internal: true` — o container não tem egress.

## O que ele roda

| Job            | Cadência                                                | Efeito                                                                                   |
| -------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `estimate`     | `fundamental.estimate_interval_ms` (default 60 s) + 1× no boot | um ciclo completo: universo → livro as-of → modelo → `fundamental_estimates`         |
| `revalidation` | 15 min + 1× no boot, **antes** do primeiro ciclo         | rebaixa a `shadow` todo modelo `active` cuja categoria mudou de regra/param depois da promoção |
| `labels`       | 1 h + 1× no boot                                         | sincroniza `fundamental_labels` a partir da timeline de resolução da RFC-007              |
| `calibration`  | checagem a cada 10 min + 1× no boot                      | roda quando 24 h se passaram desde o **último relatório gravado** (não desde o boot); materializa a calibração de cada modelo não-retired e roda o gate |

Cada job é supervisionado: falha vira uma linha JSON em stderr com
`reason_code` e **nunca derruba o processo**.

> **Por que a calibração não usa um timer de 24 h:** um `setInterval` iniciado
> no boot é zerado por todo deploy. Numa semana de deploys frequentes o job que
> produz a única evidência que o gate consegue ler nunca rodaria — foi
> exatamente o que aconteceu em 2026-08-23. A cadência agora é medida contra o
> `generated_at` do **último relatório gravado**, então reinício não empurra a
> execução. `CALIBRATION_DUE` no log marca cada disparo. Ciclo que ainda está rodando
quando o próximo dispara é pulado (`JOB_STILL_RUNNING`), não enfileirado.

Por ciclo o serviço emite `ESTIMATOR_CYCLE` com `rows_written`, `markets`,
`tokens_considered`, `tokens_rate_limited`, `consumer_rows`, `shadow_rows`,
`absent`, `absent_reasons` e `fallback_reasons`. Esses contadores são a
observabilidade primária do serviço.

## Serviço e rede

- Serviço Compose `polymarket-estimator`, atrás do profile `polymarket` (não
  sobe com `make up` nem no smoke de CI).
- Reusa a imagem da API e roda
  `node --max-old-space-size=320 apps/api/dist/polymarket-estimator.js`.
- Rede `backend` apenas (PostgreSQL). **Não publica porta no host e não tem
  egress.**
- Monta, somente-leitura: `config/runtime.json`, `config/fundamental.json` e
  `deploy/release-sha`.
- `mem_limit` 384 MiB, `cpus` 0.5, `pids_limit` 128, `stop_grace_period` 10 s.
  Orçamento agregado do Compose validado por `scripts/check_compose_policy.py`.
- Pool PostgreSQL próprio: `max = 4` conexões, timeout de query 60 s,
  `application_name = ganso-market-polymarket-estimator` (as janelas de leitura
  são largas; o pool é pequeno de propósito para não competir com o recorder).
- Depende de `migrate` concluído. **Não** depende do recorder para subir — mas
  sem o recorder gravando livro não há estimativa, só ausências
  (`absent_reasons.NO_BOOK`).

## Operar em desenvolvimento

```bash
make up             # sobe a base (postgres, migrate, api, web, nginx)
make recorder-up    # sobe o recorder Polymarket (fonte dos dados)
make estimator-up   # sobe o modelo fundamental (RFC-010)
make estimator-logs # acompanha os logs (JSON, um objeto por linha)
make estimator-down # encerra o modelo fundamental
```

## Operar no servidor standalone

```bash
cd /opt/ganso-market
docker compose --env-file deploy/server.env --profile polymarket \
  up --build --detach polymarket-estimator
docker compose --env-file deploy/server.env --profile polymarket \
  logs --follow --tail 100 polymarket-estimator
```

Depois de qualquer deploy que altere o código do estimador, repita o
`up --build` acima (o deploy padrão não troca a imagem do profile).

Para derrubar sem mexer no resto:

```bash
docker compose --env-file deploy/server.env --profile polymarket \
  rm --stop --force polymarket-estimator
```

## Configuração

O módulo tem arquivo próprio, `config/fundamental.json`, apontado por
`GANSO_FUNDAMENTAL_CONFIG_FILE` (no container, `/etc/ganso/fundamental.json`).
Sem a variável, o serviço usa os defaults compilados. O parser falha fechado:
chave desconhecida, tipo errado, valor fora de faixa ou `schema_version`
diferente de `1` recusam o boot.

Campos existentes, com default e faixa aceita — o arquivo não aceita nada além
disto:

| Campo                         | Default    | Faixa aceita         | Significado                                                       |
| ----------------------------- | ---------- | -------------------- | ----------------------------------------------------------------- |
| `schema_version`              | `1`        | `1`                  | única versão suportada                                            |
| `s_ref_usd`                   | `100`      | 1 – 100 000          | tamanho de referência (US$) do microprice executável               |
| `max_book_age_ms`             | `30000`    | 1 000 – 300 000      | idade máxima do livro no instante da decisão                      |
| `max_exec_spread`             | `0.1`      | 0,001 – 0,5          | spread executável a `S_ref` acima do qual o livro é inválido      |
| `thin_book_multiple`          | `3`        | 1 – 100 (inteiro)    | múltiplos de `S_ref` abaixo dos quais o livro é marcado fino      |
| `fallback_widen_factor`       | `1.5`      | 1,0001 – 10          | alargamento do intervalo no fallback                              |
| `estimate_interval_ms`        | `10000`    | 1 000 – 3 600 000    | tique do laço; precisa ser ≤ a cadência mais fina                 |
| `estimate_cadence_ms.lt_1h`   | `10000`    | 1 000 – 3 600 000    | cadência por token quando falta < 1h para resolver                |
| `estimate_cadence_ms.1h_6h`   | `60000`    | 1 000 – 3 600 000    | idem, 1–6h                                                        |
| `estimate_cadence_ms.6h_24h`  | `300000`   | 1 000 – 3 600 000    | idem, 6–24h                                                       |
| `estimate_cadence_ms.1d_7d`   | `600000`   | 1 000 – 3 600 000    | idem, 1–7 dias                                                    |
| `estimate_cadence_ms.gt_7d`   | `600000`   | 1 000 – 3 600 000    | idem, > 7 dias                                                    |
| `rule_change_window_ms`       | `86400000` | 0 – 2 592 000 000    | janela em que uma regra nova marca `rule_changed_recently`        |
| `gate.min_markets`            | `100`      | **100** – 100 000    | mercados resolvidos cobertos exigidos; 100 é piso, não teto       |
| `gate.max_horizon_degradation`| `0.2`      | 0,0001 – **0,2**     | degradação relativa de Brier que reprova uma fatia de horizonte   |
| `gate.bootstrap_resamples`    | `1000`     | 200 – 20 000         | reamostragens do block bootstrap                                  |
| `gate.bootstrap_seed`         | `20260819` | 0 – 2 147 483 647    | seed fixa e registrada (determinismo)                             |
| `gate.block_days`             | `1`        | 1 – 30               | comprimento do bloco do bootstrap, em dias                        |
| `walk_forward.train_days`     | `21`       | 1 – 3 650            | janela de treino                                                  |
| `walk_forward.validation_days`| `7`        | 1 – 3 650            | janela de validação, sempre no futuro do treino                   |
| `walk_forward.step_days`      | `7`        | 1 – 3 650            | passo do deslizamento                                             |
| `crypto.ewma_lambdas`         | `[0.94, 0.97]` | cada item 0,5 – 0,9999 | decays do ensemble de volatilidade                          |
| `crypto.student_df`           | `4`        | 2,1 – 200            | graus de liberdade da variante Student-t                          |
| `crypto.min_history_minutes`  | `120`      | 10 – 100 000         | histórico mínimo de TWAP antes de o modelo falar                  |
| `crypto.max_feed_age_ms`      | `120000`   | 1 000 – 3 600 000    | idade máxima da amostra do feed resolutor                         |
| `macro.default_sigma`         | ver abaixo | cada valor 1e-9 – 1e9| dispersão de consenso por variável, quando o calendário omite     |
| `macro.post_release_window_ms`| `7200000`  | 0 – 604 800 000      | janela do regime pós-release                                      |
| `macro.under_reaction_coefficient` | `0.64` | 0 – 1              | coeficiente de sub-reação — **hipótese**, validada em separado    |
| `macro.max_calendar_age_ms`   | `2592000000` | 60 000 – 31 536 000 000 | idade máxima da entrada de calendário considerada           |

`macro.default_sigma` traz por padrão `cpi_yoy 0.15`, `cpi_mom 0.08`,
`core_cpi_yoy 0.12`, `nonfarm_payrolls 60000`, `unemployment_rate 0.12` e
`fed_target_rate 0.1`. Chaves extras são aceitas e somam ao mapa padrão.

Dois limites são **assimétricos de propósito**: `gate.min_markets` só pode ser
elevado (mínimo aceito 100) e `gate.max_horizon_degradation` só pode ser
apertado (máximo aceito 0,2). Além da faixa do parser, `gate.ts` reaplica os
dois pisos em memória. O gate pode ficar mais rígido por configuração, nunca
mais frouxo.

Alterou `config/fundamental.json`? Reinicie o serviço; o arquivo é lido no
boot.

> Erro de configuração aparece como linha `fatal` com
> `reason_code: "ESTIMATOR_FAILED"` e `error_name: "FundamentalConfigError"`, e
> o processo termina com exit code 1 (o `reason_code` específico do parser —
> `FUNDAMENTAL_CONFIG_FIELD_UNKNOWN`, `FUNDAMENTAL_CONFIG_FIELD_INVALID`,
> `FUNDAMENTAL_CONFIG_SCHEMA_UNSUPPORTED`, `FUNDAMENTAL_CONFIG_FILE_UNREADABLE`,
> `FUNDAMENTAL_CONFIG_FILE_INVALID_JSON`) fica na mensagem da exceção.

## Proveniência: como o `git_sha` chega ao container

Toda linha `source = 'MODEL'` exige `git_sha` — é constraint de banco, não
convenção. A resolução, em ordem:

1. `GANSO_GIT_SHA`, se contiver 40 caracteres hexadecimais (override explícito,
   usado em execução local e em testes);
2. o arquivo apontado por `GANSO_RELEASE_SHA_FILE` (no Compose,
   `/etc/ganso/release-sha`, montado de `deploy/release-sha`).

`deploy/release-sha` está marcado como `export-subst` no `.gitattributes` e
contém o placeholder `$Format:%H$`. O CD publica o release com
`git archive --format=tar.gz "$GITHUB_SHA"`, e o `git archive` reescreve o
placeholder com o commit exato — por isso o checkout de produção, que não tem
`.git`, ainda carrega a revisão verificável. Em um checkout git comum o
placeholder permanece literal e a resolução corretamente devolve "desconhecido".

Quando o SHA não pode ser resolvido:

- no boot sai `{"level":"warn", ..., "reason_code":"PROVENANCE_UNAVAILABLE",
  "effect":"models_cannot_serve_baseline_only"}`;
- **nenhum modelo serve** — nem `active`, nem `shadow`. Toda linha de
  consumidor vira `MARKET_BASELINE` com `fallback_reason =
  'PROVENANCE_UNAVAILABLE'`;
- o baseline continua funcionando normalmente. O serviço não para.

Diagnóstico rápido no container:

```bash
docker compose --env-file deploy/server.env --profile polymarket \
  exec -T polymarket-estimator cat /etc/ganso/release-sha
```

Saída `$Format:%H$` significa que o checkout não veio de um `git archive`. Para
uma execução pontual fora do CD, exporte `GANSO_GIT_SHA` com o commit real no
ambiente do serviço; não invente um valor, e não use um SHA que não corresponda
ao código em execução — a proveniência é a única coisa que liga uma estimativa
ao binário que a produziu.

## Verificar que está gravando

```bash
docker compose exec postgres psql -U ganso_market -d ganso_market -c \
  "SELECT (SELECT count(*) FROM fundamental_estimates)                          AS estimativas,
          (SELECT count(*) FROM fundamental_estimates WHERE source = 'MODEL')   AS de_modelo,
          (SELECT count(*) FROM fundamental_estimates WHERE status = 'shadow')  AS shadow,
          (SELECT count(*) FROM fundamental_models)                             AS modelos,
          (SELECT count(*) FROM fundamental_labels)                             AS labels,
          (SELECT count(*) FROM fundamental_gate_reports)                       AS gates;"
```

Distribuição de fallback na última hora (o número que mais importa no dia a
dia):

```bash
docker compose exec postgres psql -U ganso_market -d ganso_market -c \
  "SELECT source, fallback_reason, count(*)
     FROM fundamental_estimates
    WHERE status = 'active'
      AND decision_ts > now() - interval '1 hour'
    GROUP BY 1, 2
    ORDER BY 3 DESC;"
```

Enquanto nenhum modelo estiver promovido, o esperado é 100% de
`MARKET_BASELINE`: com `NO_ACTIVE_MODEL` quando a categoria não tem modelo
nenhum registrado, e com `MODEL_IN_SHADOW` assim que existir um modelo em
shadow. Isso é o sistema funcionando, não falha.

## Endpoints da API

Todos exigem o Bearer token da RFC-002 e são somente leitura, exceto as duas
transições manuais de ciclo de vida. Nenhum deles cria ordem, sinal ou toca em
wallet.

| Método e rota                                | Parâmetros                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /polymarket/estimates`                  | `market_id` (obrigatório), `from`, `to` (ISO 8601), `limit` (1–5000, default 1000), `include_shadow` (`true`/`false`) |
| `GET /polymarket/estimates/latest`           | `category` opcional (`crypto_updown` ou `macro_scheduled`); só linhas `status = 'active'`       |
| `GET /polymarket/models`                     | registry completo, com o último veredito de gate por modelo                                      |
| `GET /polymarket/models/{id}/calibration`    | último gate + último relatório de calibração + fallback da mesma janela                          |
| `POST /polymarket/models/{id}/promote`       | shadow → active; 409 `NO_EVIDENCE_OF_ALPHA` com o relatório anexo quando o gate não é PASS        |
| `POST /polymarket/models/{id}/demote`        | kill manual imediato; corpo opcional `{"reason": "..."}` (até 500 caracteres)                     |

Outros códigos de recusa: `401 AUTH_UNAUTHENTICATED`, `400 MARKET_ID_REQUIRED`,
`400 INVALID_TIMESTAMP`, `400 INVALID_LIMIT`, `400 INVALID_INCLUDE_SHADOW`,
`400 INVALID_CATEGORY`, `400 INVALID_REASON`, `404 MODEL_NOT_FOUND`,
`404 NO_CALIBRATION_REPORT`, `409` com o código do registry
(`NO_GATE_REPORT`, `REGIME_MIX_INELIGIBLE`, `ALREADY_ACTIVE`, `MODEL_RETIRED`)
e `500 FUNDAMENTAL_API_FAILED`.

### Como chamar

> **FATO VERIFICADO:** o gateway responde `404` a qualquer caminho `/api/` que
> não seja health ou `/api/auth/` (`infra/nginx/nginx.conf`), e o serviço `api`
> não publica porta no host (`expose: 3000`). Ou seja: estes endpoints **não
> são alcançáveis pelo IP público**. Eles são chamados de dentro da rede do
> Compose.
>
> **FATO VERIFICADO:** a imagem da API (Node slim) não traz `curl` nem `wget`;
> a imagem pinada do Nginx traz `/usr/bin/curl`. Por isso os exemplos abaixo
> usam o container `nginx`, que enxerga `api:3000` pela rede `edge`.

Primeiro o token (a senha entra por stdin, nunca por argv; `Origin` precisa
bater com `Host`, e o access token vale no máximo 15 minutos):

```bash
read -rs -p 'senha: ' GANSO_PASSWORD && echo
token="$(printf '{"username":"owner","password":"%s"}' "$GANSO_PASSWORD" |
  curl --fail --silent --show-error \
    --header 'Content-Type: application/json' \
    --header 'Origin: http://127.0.0.1:8080' \
    --data @- http://127.0.0.1:8080/api/auth/login |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
unset GANSO_PASSWORD
```

No servidor standalone troque `http://127.0.0.1:8080` por
`http://178.105.65.251` nos dois lugares (`Origin` e URL) e acrescente
`--env-file deploy/server.env` aos comandos `docker compose` abaixo.

Última estimativa por token da categoria crypto:

```bash
docker compose exec -T nginx curl --fail --silent \
  --header "Authorization: Bearer $token" \
  'http://api:3000/polymarket/estimates/latest?category=crypto_updown'
```

Histórico com proveniência completa de um mercado, incluindo as linhas shadow:

```bash
docker compose exec -T nginx curl --fail --silent \
  --header "Authorization: Bearer $token" \
  'http://api:3000/polymarket/estimates?market_id=0xCONDITION_ID&from=2026-08-19T00:00:00Z&include_shadow=true&limit=200'
```

Registry e último gate de cada modelo:

```bash
docker compose exec -T nginx curl --fail --silent \
  --header "Authorization: Bearer $token" \
  http://api:3000/polymarket/models
```

Relatório de calibração de um modelo:

```bash
docker compose exec -T nginx curl --fail --silent \
  --header "Authorization: Bearer $token" \
  http://api:3000/polymarket/models/MODEL_ID/calibration
```

Promoção manual (só passa com gate PASS) e kill manual:

```bash
docker compose exec -T nginx curl --silent --request POST \
  --header "Authorization: Bearer $token" \
  http://api:3000/polymarket/models/MODEL_ID/promote

docker compose exec -T nginx curl --silent --request POST \
  --header "Authorization: Bearer $token" \
  --header 'Content-Type: application/json' \
  --data '{"reason":"kill manual: comportamento suspeito em macro"}' \
  http://api:3000/polymarket/models/MODEL_ID/demote
```

## Ciclo de vida de um modelo

```
registro (nasce shadow) -> estimativas shadow -> relatório de calibração
   -> gate -> promoção MANUAL -> [mudança de venue/fee/regra/regime]
   -> revalidação obrigatória (volta a shadow) -> ... -> kill manual
```

1. **Registro.** Toda rodada de treino cria uma VERSÃO nova e imutável em
   `fundamental_models`, sempre com `status = 'shadow'`. O registro recusa
   janela de treino que cruze 28/abr/2026 sem `regime_mix = true`, e um
   `model_id` já existente é recusado (reescrever a identidade apagaria a
   proveniência das estimativas que já apontam para ele). Evento
   `registered` em `fundamental_model_events`.

   > **BLOQUEIO/TODO:** nesta entrega o registro é feito pela função
   > `registerModel` do módulo `registry.ts`; **não existe CLI nem endpoint
   > HTTP que registre modelo**. A API só lê o registry e faz promote/demote.
   > Enquanto não houver um comando de treino/registro, registrar um modelo em
   > produção exige código.

2. **Estimativas shadow.** A cada ciclo, todo modelo não promovido que
   conseguir falar gera uma linha `source = 'MODEL'`, `status = 'shadow'`, ao
   lado da linha de consumidor (que continua sendo o baseline, com
   `fallback_reason = 'MODEL_IN_SHADOW'`). Linhas shadow são invisíveis ao
   consumidor: só saem da API com `include_shadow=true`.

3. **Relatório de calibração.** O job diário junta as estimativas do modelo aos
   labels finais, exigindo `decision_ts < publicly_knowable_ts` (estimativa
   feita depois de o desfecho ser público não é previsão), e materializa em
   `fundamental_calibration_reports`: Brier e log loss do modelo e do baseline,
   deltas com CI 95% de block bootstrap, fatias por bucket de horizonte, bins de
   reliability, cobertura empírica do intervalo de 90% e as taxas de fallback.
   Métricas headline excluem mercados degenerados (baseline fora de
   [0,01; 0,99]); a versão com degenerados vai como anexo.

4. **Gate.** O mesmo job avalia o gate e grava `fundamental_gate_reports` +
   evento `gate_pass` ou `no_evidence_of_alpha`. Um modelo `active` que
   reprova é **rebaixado a shadow na mesma chamada** — a categoria volta ao
   baseline antes de qualquer humano ler o relatório.

5. **Promoção manual.** Só o operador promove, e só via
   `POST /polymarket/models/{id}/promote`. A promoção exige o último gate com
   veredito `PASS`; modelo `regime_mix` é recusado antes mesmo de as métricas
   serem lidas. Se já houver um modelo `active` na categoria, o antigo é
   rebaixado primeiro (o intervalo entre as duas transições deixa a categoria no
   baseline — é a direção segura de falhar). Evento `promoted`.

6. **Revalidação obrigatória.** A cada 15 minutos, e no boot antes do primeiro
   ciclo, todo modelo `active` cuja categoria teve versão nova de regra
   (`polymarket_rule_versions.version > 1`) ou de parâmetros
   (`polymarket_param_versions.version > 1`) depois do `promoted_at` volta a
   `shadow`, com evento `revalidation_required` e log
   `MODEL_REVALIDATION_REQUIRED`. Modelo com `promoted_at` ilegível também é
   revalidado — falha fechada. Depois disso o modelo precisa de gate novo para
   ser promovido de novo.

7. **Kill manual.** `POST /polymarket/models/{id}/demote` devolve a categoria ao
   baseline imediatamente. É idempotente para modelo que já está em shadow, e é
   a primeira ação diante de qualquer dúvida — o baseline é sempre uma opção
   válida.

Nada disso libera execução: um modelo `active` apenas muda a origem da
estimativa de `MARKET_BASELINE` para `MODEL`.

## Como ler um `NO_EVIDENCE_OF_ALPHA`

`NO_EVIDENCE_OF_ALPHA` significa **"a evidência disponível não mostrou que o
modelo deixa de ser pior que o preço"**. Não é um bug do serviço, não é um erro
de dados por padrão, e não deve ser tratado como algo a "consertar" mexendo no
gate.

Localize o relatório:

```bash
docker compose exec -T nginx curl --fail --silent \
  --header "Authorization: Bearer $token" \
  http://api:3000/polymarket/models/MODEL_ID/calibration
```

ou direto na tabela:

```bash
docker compose exec postgres psql -U ganso_market -d ganso_market -c \
  "SELECT gate_report_id, verdict, markets_covered, observations,
          failures_json, evaluated_at
     FROM fundamental_gate_reports
    WHERE model_id = 'MODEL_ID'
    ORDER BY evaluated_at DESC
    LIMIT 5;"
```

`failures_json` lista todos os critérios reprovados:

| Falha                        | Significado                                                              | O que fazer                                                                 |
| ---------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `INSUFFICIENT_MARKETS`       | menos de 100 mercados resolvidos cobertos na categoria                    | esperar. Só o tempo resolve; baixar o piso é proibido                        |
| `NO_OBSERVATIONS`            | nenhuma estimativa pareada com label final na janela                      | conferir se o modelo está gerando linhas shadow e se `labels` está rodando   |
| `INVALID_WINDOW`             | janela de avaliação degenerada                                            | bug de operação/relógio: investigar antes de qualquer conclusão              |
| `BRIER_NOT_NON_INFERIOR`     | o CI 95% do delta de Brier não exclui "o modelo é pior"                   | resultado legítimo: o modelo fica em shadow                                  |
| `LOG_LOSS_NOT_NON_INFERIOR`  | idem para log loss                                                        | idem                                                                          |
| `HORIZON_SLICES_MISSING`     | não houve estratificação por horizonte                                    | cobertura insuficiente; esperar mais dados                                   |
| `HORIZON_DEGRADATION:<bucket>` | a fatia citada degradou o Brier mais que 20% relativo                   | olhar a fatia: a miscalibração do mercado cresce com o horizonte, e a expectativa a priori é que o modelo só tenha chance perto da resolução |

Ações **permitidas**: deixar o modelo em shadow acumulando evidência; treinar
uma versão nova (que nasce shadow de novo); restringir o escopo do modelo por
categoria; investigar dados (gaps da RFC-007, feed stale, labels faltando).

Ações **proibidas**: afrouxar `gate.min_markets` ou
`gate.max_horizon_degradation` (o código reaplica os pisos e ignora a
tentativa); promover "manualmente no banco"; interpretar um PASS como edge
líquido de custos.

Um PASS também não é permanente: ele é reavaliado todo dia, e a revalidação por
mudança de regra/param ignora o histórico.

## Orçamento e retenção

- `fundamental_estimates` tem **TTL de 90 dias** e quota de 3 GB; as tabelas de
  metadados (`fundamental_models`, `fundamental_labels`,
  `fundamental_gate_reports`, `fundamental_model_events`,
  `fundamental_calibration_reports`) são **protegidas e nunca podadas** — são a
  trilha de auditoria de cada decisão de promoção.
- A poda é executada pelo **job de retenção do recorder** (RFC-007, diário), não
  pelo estimador. Recorder parado significa retenção parada.
- Ao atingir 90% da quota de um tipo, a poda vai até 80% e registra linha em
  `polymarket_retention_log`; 90% dos 110 GB globais dispara
  `QUOTA_GLOBAL_ALARM`. `GET /polymarket/data-quality` (endpoint da RFC-007)
  mostra bytes por tabela e % do orçamento.
- Taxa: no máximo 1 **avaliação** por token a cada `estimate_cadence_ms[bucket]`,
  onde o bucket é o horizonte do mercado naquele instante. A cadência conta
  tentativas, não linhas gravadas: um token cujo livro está inválido produz
  ausência (sem linha) e mesmo assim respeita a cadência, senão ele seria
  relido seis vezes por minuto para sempre sem produzir nada. Um mercado migra de
  `gt_7d` para `lt_1h` conforme se aproxima da resolução, e a cadência aperta
  junto.
  **Atenção:** cada modelo em shadow soma uma linha adicional por token e por
  ciclo. Rodar N modelos shadow multiplica a volumetria por (1 + N); observe
  `shadow_rows` no `ESTIMATOR_CYCLE` e o crescimento da tabela antes de deixar
  vários modelos em shadow ao mesmo tempo.
- **Cadência por horizonte (decisão do proprietário, 2026-08-22).** A resolução
  temporal é gasta onde importa: 10 s na última hora, 60 s até 6h, 5 min até
  24h, 10 min daí em diante. O motivo é duplo — perto da resolução o mercado se
  move rápido e é onde a RFC espera que o modelo tenha chance; longe da
  resolução as linhas dominavam o armazenamento (67% do volume vinha de
  horizonte > 7 dias) e **nunca viravam evidência**, porque são podadas muito
  antes de o mercado resolver.
- **Janela real, medida:** 1.020 B por linha em PostgreSQL 18 (200 k linhas,
  após `VACUUM ANALYZE`). Com a cadência plana de 60 s eram ~576 k linhas/dia e
  a quota de 3 GB guardava **~5,5 dias**. Com a cadência por horizonte o volume
  cai ~6,6× e a janela passa de **um mês**, que é o que torna realista acumular
  os 100 mercados resolvidos do gate.
- **Piso que não pode ser violado:** uma estimativa precisa sobreviver
  `horizonte + ~27 h` para virar evidência (resolução → liveness UMA ~2 h →
  sync de label ≤ 1 h → até 24 h até a calibração diária). Encurtar a janela
  para menos que isso apaga a evidência antes de ela ser pontuada — é o teste
  `budget.test.ts` que segura essa invariante.
- Memória: `mem_limit` 384 MiB com `--max-old-space-size=320`. O orçamento do
  módulo (RFC-007) é de 110 GB de PostgreSQL (emenda de 2026-08-25) e 3 GB de
  RAM para as aplicações.

```bash
docker compose exec postgres psql -U ganso_market -d ganso_market -c \
  "SELECT relname,
          pg_size_pretty(pg_total_relation_size(relid)) AS tamanho
     FROM pg_catalog.pg_statio_user_tables
    WHERE relname LIKE 'fundamental_%'
    ORDER BY pg_total_relation_size(relid) DESC;"
```

## Incidentes conhecidos e resposta

- **Tudo em `MARKET_BASELINE` com `NO_ACTIVE_MODEL` ou `MODEL_IN_SHADOW`:**
  estado normal enquanto nenhum modelo foi promovido. `NO_ACTIVE_MODEL`
  significa que a categoria não tem modelo registrado; `MODEL_IN_SHADOW`
  significa que existe modelo e o que falta é o gate. Nada a fazer.
- **`PROVENANCE_UNAVAILABLE` em massa:** o `git_sha` não foi resolvido. Ver a
  seção de proveniência. O baseline continua; nenhum modelo serve.
- **Muitos `absent_reasons.NO_BOOK` ou `BOOK_STALE`:** o problema é do
  recorder, não do estimador. Ver
  [`polymarket-recorder.md`](polymarket-recorder.md) e
  `polymarket_data_gaps`.
- **`SPREAD_TOO_WIDE` / `DEPTH_BELOW_SREF` frequentes:** livro realmente fino
  no instante da decisão. Não há estimativa, e ausência é veto. Não relaxe
  `max_exec_spread` para "ter cobertura": isso troca ausência honesta por
  número podre.
- **`FEED_STALE` em crypto:** RTDS parado ou atrasado (o RTDS não tem replay; o
  buraco é permanente). Verificar o recorder; o baseline continua.
- **`UMA_DISPUTE_ACTIVE`:** disputa aberta no mercado. É veto por design; o
  modelo volta a servir quando a disputa fecha.
- **`RULE_NOT_PARSEABLE` / `MODEL_ABSTAINED` constantes em um mercado:** o
  mercado está fora do modelo por decisão explícita (regra ambígua, consenso
  ausente, histórico insuficiente) e fica no baseline. Não force o parser a
  adivinhar.
- **`JOB_FAILED` / `JOB_STILL_RUNNING`:** um job falhou ou estourou a janela.
  O processo segue; verifique `error_name` e o tempo do ciclo. Ciclo pulado é
  mais seguro que ciclo enfileirado.
- **`CALIBRATION_REPORT_FAILED`:** o relatório de um modelo falhou; os demais
  continuam. O gate daquele modelo não avançou — nada foi promovido por
  omissão.
- **`GATE_REPORT_NOT_PERSISTED`:** o relatório de gate não foi gravado. Nenhuma
  promoção pode acontecer sem relatório persistido; trate como falha de banco.
- **`MODEL_REVALIDATION_REQUIRED`:** mudança de regra/param na categoria; o
  modelo voltou a shadow e precisa de gate novo. Esperado após qualquer
  mudança de venue, fee schedule, regra ou regime.
- O estimador grava estimativas e relatórios; nada aqui executa ordens nem toca
  wallet.
