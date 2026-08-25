# Evidência de verificação — RFC-012 (risco de resolução e grafo lógico)

- Data: 2026-08-24 (BRT)
- Branch: `claude/rfc-012-execucao-c254e1` (4 commits das fases A–D + commit
  final de consolidação/hardening)
- Ambiente: macOS (Darwin 25.3.0), Node 24/26, Docker Desktop; PostgreSQL
  18.4-bookworm descartável para as verificações de banco; RPC público da
  Polygon para a verificação onchain ao vivo

Este documento registra somente comandos realmente executados e resultados
reais.

## 1. Gate de fonte completo (`make verify`)

Executado na raiz do repositório após o hardening final:

| Etapa                              | Resultado                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check` (prettier)  | OK                                                                                                                                            |
| `npm run lint` (tsc por workspace) | OK                                                                                                                                            |
| `npm test` — @ganso-market/api     | **76 arquivos aprovados + 3 pulados; 1.011 testes aprovados, 30 pulados** (suítes condicionais a PostgreSQL executadas de verdade na etapa 2) |
| `npm test` — @ganso-market/web     | **5 arquivos, 34 testes aprovados**                                                                                                           |
| `npm test` — contracts             | 2 arquivos, 70 testes aprovados                                                                                                               |
| `cargo fmt/clippy/test/build`      | OK (14 testes; workspace intocado pela RFC)                                                                                                   |
| Python unittest (workers+scripts)  | **9 + 25 testes aprovados**                                                                                                                   |
| `scripts/scan_secrets.py`          | OK                                                                                                                                            |
| `docker compose config` + policy   | **agregado 4 261 412 864 bytes (4064 MiB) < 4 GiB estrito**                                                                                   |
| `make integration`                 | **OK** — build, migrations, health/degradação/recuperação, logs, memória e shutdown                                                           |

O smoke foi repetido com `COMPOSE_PROJECT_NAME` exclusivo porque a primeira
tentativa encontrou um volume local preexistente, de outro checkout, com senha
PostgreSQL diferente. Em volume novo, as migrations 0001–0012 aplicaram e a
segunda execução do migrador confirmou todas como já aplicadas.

## 2. Migrations 0001–0012 e suíte integral contra PostgreSQL real

Container descartável `postgres:18.4-bookworm`; cada arquivo aplicado com o
protocolo do `apply.sh` (`--single-transaction`, `ON_ERROR_STOP=1`,
`migration_version`/`migration_checksum` por psql vars, checksum registrado
em `schema_versions`). As 12 migrations aplicaram limpas em sequência. A
`0010` original permaneceu byte a byte inalterada; o hardening aditivo está
nas migrations `0011_resolution_runtime_safety.sql` e
`0012_polymarket_market_metadata_history.sql`.

Com `GANSO_TEST_DATABASE_URL` apontando para PostgreSQL 18.4, a suíte API
integral e serial passou com **79/79 arquivos e 1.041/1.041 testes**. O recorte
de integração de resolução + concorrência de versionamento passou com
**23/23 testes**.

Constraints e triggers exercitados por SQL direto e pela suíte de integração:

| Tentativa                                                   | Erro observado (verbatim, resumido)                  |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| `INSERT resolution_scores` com `score='0.5'` (não canônico) | `resolution_scores_score_check`                      |
| `INSERT graph_edges` curada sem autor/justificativa         | `graph_edges_curated_needs_author`                   |
| `UPDATE resolution_scores`                                  | `resolution_scores rows are immutable (append-only…` |
| `DELETE FROM resolution_scores`                             | permitido para retenção/TTL; `UPDATE` segue proibido |
| reuso de `score_version` com hash de conteúdo diferente     | `SCORE_VERSION_CONTENT_MISMATCH` (gate do boot)      |
| replay da timeline UMA (re-sync do mesmo mercado)           | 0 linhas novas (dedupe por constraint)               |

A suíte de integração também prova, contra o banco real:

- **Look-ahead com dado plantado no futuro (teste obrigatório da RFC):**
  disputa e versão de regra inseridas com `received_at`/`valid_from`
  posteriores ao instante de decisão **não alteram** score nem ação naquele
  instante; num instante posterior o mesmo pipeline as enxerga
  (CIRCUIT_BREAKER). `closedTime` é proibido por regex no guard de escopo do
  módulo inteiro.
- **Reprodutibilidade:** mesma versão + mesmo instante ⇒ mesmo `scoreText` e
  mesma decomposição de features.
- **Acoplamento de grupo (tarefa 15):** mercado em disputa num evento
  negRisk arrasta o irmão para `effective_action=CIRCUIT_BREAKER` sem tocar
  a ação própria dele.
- **Clarificação material (tarefa 2):** mudança de limiar na regra vira
  linha `material` em `resolution_clarifications`.
- **Enforcement (tarefa 17):** intent sob VETO recusado; ordem manual sob
  VETO recusada sem `override_veto` e aceita com ele (`overrideApplied`);
  irmão de grupo sob CB recusado mesmo com override.
- **Broker sob concorrência:** aceite, evento imutável e rechecagens finais
  ocorrem na mesma transação; kill switch, settlement e gate terminal usam
  uma ordem de locks determinística. Sob CB, somente exposição assinada
  verdadeiramente reduce-only executa: long/SELL, short/BUY; posição flat,
  lado expansivo, cruzamento de zero ou falha de leitura cancelam sem fill.
- **Handshake durável do runtime:** journal de seis fontes, geração/lease,
  cursor, `graph_evaluated_at` e `graph_valid_until` persistidos. Cada lote do
  journal executa recompute → build → evaluate → sanity antes de avançar o
  cursor; falha em qualquer etapa não publica geração pronta. Uma única mutex
  serializa o pipeline e mutações curadas invalidam a prontidão atomicamente.
- **Versionamento e consultas as-of:** advisory locks e conflitos stale foram
  exercitados com conexões PostgreSQL concorrentes; relatórios e decisões usam
  `occurred_at`/versões válidas no instante, sem incorporar estado futuro.
- **Metadados de outcomes:** histórico temporal preserva a semântica de tokens.
  O token afirmativo só é mapeado em mercado exatamente binário com um único
  rótulo `Yes`/`Up`; ordem `[No, Yes]` é tratada corretamente e payload
  ambíguo, multivalorado ou legado falha fechado.

## 3. Boot real do serviço `polymarket-resolution` — baseline da fase D

`apps/api/dist/polymarket-resolution.js` executado contra o banco
descartável com as configs do repositório montadas (mesmos envs do Compose):

```
RESOLUTION_BOOT {score_version:"1.0.0", config_hash:"3cf7fc62…", lexicon_hash:"a2e62d91…", onchain_enabled:true}
SCORES_RECOMPUTED {trigger:"boot", scored:1, failed:0}
GRAPH_BUILT {nodes:1, structural:0, curated:0, revoked:0}
RESOLUTION_REPORT_GENERATED {report_id:1}
SIGTERM_RECEIVED → shutdown gracioso, exit 0
```

Antes disso, o mesmo boot foi **recusado** de propósito: a tabela
`resolution_score_versions` continha "1.0.0" com hash sintético (da suíte de
integração) e o serviço abortou com `RESOLUTION_FAILED`
(`SCORE_VERSION_CONTENT_MISMATCH`) — o gate de reprodutibilidade falha
fechado, como projetado.

Esse boot ocorreu antes do hardening final. O novo handshake de
geração/lease/freshness foi validado por testes do runner/store e pela suíte
integral em PostgreSQL real; o boot/soak do artefato final em produção permanece
explicitamente pendente de aprovação e deploy.

## 4. Verificação onchain ao vivo (condição de parada da RFC)

Feita **no início do desenvolvimento**, como a RFC exige, com achado
material:

- **ABI:** assinaturas dos eventos confirmadas no repositório oficial
  `Polymarket/uma-ctf-adapter` (tag `v2.0.0` e `main` idênticos nos eventos
  de ciclo de vida; V2 tem `QuestionEmergencyResolved`, V3
  `QuestionManuallyResolved`). keccak-256 implementado sem dependência nova
  e validado por 5 vetores conhecidos + segunda implementação independente
  (constantes DERIVADAS por LFSR/recorrência) em todos os tamanhos 0–300 e
  nas fronteiras de bloco 135/136/137/271/272/273.
- **Endereços:** o adapter nomeado na RFC (`0x6a9d…4f74`, V2) está
  **dormente** — `eth_getLogs` ao vivo achou 0 logs em ~80 mil blocos (~2
  dias), idem o V3 `0x157c…6a49`. Os resolvedores reais de hoje, extraídos
  do `resolvedBy` do Gamma e sondados ao vivo, são `0x65070be9…` (binários;
  7 317 logs em 10 mil blocos) e `0x69c47de9…` (negRisk; 1 891) — ambos
  emitindo **exatamente** os topic0 calculados das assinaturas verificadas
  (`QuestionInitialized 0xeee0…`, `QuestionResolved 0x566c…`,
  `QuestionReset 0x7981…`). Os quatro endereços estão na config.
- **Coletor executado de verdade** contra a Polygon (2 adapters da RFC,
  30 mil blocos): varredura em chunks de 5 mil, cursores gravados
  (`last_block 92 586 957`), 0 eventos na janela — coerente com a dormência
  medida acima.
- **Filtro de orçamento (decisão de implementação):** o fluxo global dos
  adapters ativos (~40 mil logs/dia) estouraria a quota de 0,09 GB da tabela
  protegida em dias; o coletor só grava eventos cujo `questionID` pertence a
  mercado já registrado (`polymarket_markets.question_id`, capturado pelo
  registry a partir desta RFC). Eventos não mapeados são contados
  (`skipped_unmapped`) e descartados — o histórico é prospectivo sobre o
  universo gravado, como o escopo da RFC define.

## 5. Perímetro (tarefa 18)

- `infra/nginx/nginx.conf`: publicados somente
  `location ^~ /api/polymarket/resolution-risk` e
  `location ^~ /api/polymarket/graph`, ambos com
  `if ($request_method != GET) { return 404; }` — o
  `POST /api/polymarket/graph/edges` e todas as rotas de escrita
  (paper/kill-switch/promote/demote) continuam fechadas no `^~ /api/` 404.
  Sintaxe validada com `nginx -t` na imagem pinada do Compose.
- Auth de sessão RFC-002 preservada: o painel envia `Authorization: Bearer`
  (token só em memória) e renova via refresh-cookie na expiração de 15 min.

## 6. Exigência da RFC → onde está coberto

| Exigência (Testes obrigatórios da RFC)                      | Cobertura                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diff de regra: versão nova + evento + recomputação          | `clarify.test.ts`, `integration.test.ts` ("classifies the planted rule change…"), state tick em `runner.ts`                                       |
| Rule-precision: corpus real, estável a cosmética            | `lexicon.test.ts` (23 testes: Chainlink > consenso de mídia, Strategy/8-K, mutações cosméticas)                                                   |
| Timeline UMA: reset/2 requests/P3/P4, replay                | `timeline.test.ts` (máquina de estados), `onchain.test.ts` (fold onchain), integração (replay sem duplicar)                                       |
| Circuit breaker mercado+grupo, liberação após settle        | `score.test.ts`, `integration.test.ts` (grupo), `enforcement.test.ts`                                                                             |
| Buffer monotônico no EV; 50/50 a preços altos               | `score.test.ts` ("EV líquido decresce…", "YES a 80¢ → payoff 50¢")                                                                                |
| Grafo: banda/persistência k; intra-banda sem sinal          | `evaluate.test.ts` (fixtures à mão), `graph.test.ts` (ciclo de vida k=3)                                                                          |
| negRisk: Σasks<1 executável; [1,1] impossível; placeholders | `evaluate.test.ts` (walk com profundidade real), `onchain.test.ts` ([1,1] em negRisk ⇒ resultado nulo), registry já filtra placeholders (RFC-007) |
| Veto de sanidade bloqueia modelo, baseline fica             | `sanity.test.ts` (15), `enforcement.test.ts` (intent recusado; manual não bloqueado)                                                              |
| Look-ahead com dado plantado no futuro                      | `integration.test.ts` contra PG real                                                                                                              |
| Reprodutibilidade por `score_version`                       | `integration.test.ts` + gate `SCORE_VERSION_CONTENT_MISMATCH` em runtime real                                                                     |
| Enforcement (tarefa 17) com `override_veto` no ledger       | `enforcement.test.ts` (gate) + `paper/enforcement.test.ts` (endpoints + payload do ledger)                                                        |
| CB reduce-only assinado, cross-zero e falha fechada         | `paper/brokerstore.test.ts`, `paper/enforcement.test.ts`                                                                                          |
| Handshake runtime, journal, lease e freshness do grafo      | `runner.test.ts`, `store.test.ts`, `recompute.test.ts`, `integration.test.ts`                                                                     |
| Metadados as-of e token afirmativo explícito                | `versioning.test.ts`, `versioning.pg.test.ts`, `registry.test.ts`                                                                                 |
| Divergência de camadas nas duas direções                    | `divergence.test.ts`                                                                                                                              |
| Busca de código: sem auth/wallet/ordem real                 | `scope.test.ts` do módulo (regexes + allowlist de tabelas + fetch só em `onchain.ts` + `closedTime` proibido)                                     |
| Relatórios declaram `n` real com intervalo                  | `report.test.ts` (Wilson), relatório gera IC + `prior_in_use` por categoria                                                                       |

## 7. Decisões de implementação registradas

1. **Banda de custo sem dupla contagem de spread:** a fórmula da RFC
   (`tol = fees + spread efetivo + ε`) pressupõe checagem em midpoint; a
   implementação avalia nas pernas EXECUTÁVEIS (bid/ask), onde o spread já é
   pago. A banda efetiva é fees por perna + ε — nunca mais frouxa que a da
   RFC (afrouxar é a direção proibida pela condição de parada).
2. **Intents sem estado de resolução falham fechados**
   (`RESOLUTION_STATE_MISSING`): um intent é sinal dependente de modelo e a
   camada de risco é exatamente o que ele deve atravessar; ordem manual sem
   estado segue permitida (não há veto a ignorar).
3. **P4 não é observável via Gamma** (é o reset "too early" onchain); a v1
   da timeline registra P1–P3 e a fase 2 onchain acrescenta P4 pelo sentinel
   `int256.min` do `QuestionResolved`.
4. **Adapters como config**: a dormência do V2 nomeado na RFC foi tratada
   como mudança de config (4 endereços), não de código — deployment novo do
   adapter é edição de `config/resolution.json`.
5. **`skipped` no avaliador não fecha violação aberta**: livro velho não é
   evidência de que o mispricing acabou (fail-closed); só leitura
   intra-banda fecha.

## 8. Não verificado / pendências

- **Soak de 24 h em produção** (recomputação horária + grafo a cada 1 min
  dentro de 1 GB PG / 192 MiB): pendente da ativação no servidor, como na
  RFC-011. O que foi verificado localmente: boot baseline da fase D, protocolo
  final em PostgreSQL real, smoke Compose e quotas/limites estáticos. O boot
  operacional do artefato final ainda faz parte da ativação.
- **Coleta onchain com eventos reais dos mercados do universo**: o coletor
  rodou ao vivo e gravou cursores, mas o universo local de teste não tinha
  `question_id` mapeado dos mercados ativos — os primeiros eventos gravados
  em produção virão dos mercados que o registry re-observar após o rebuild
  do recorder.
- **Backfill de `question_id`**: mercados que saíram do universo antes desta
  RFC ficam sem mapeamento onchain (prospectivo por decisão da RFC — sem
  backfill pago).
- **Divergência de camadas em produção**: máquina testada nas duas direções
  com fakes; a comparação real começa quando paper broker e resolução
  rodarem juntos no servidor.
- Priors externos vigoram até 200 resoluções por categoria (hoje: crypto ~
  centenas de labels mas o contador desta RFC começa do próprio pipeline);
  o relatório declara `prior_in_use` por categoria.
