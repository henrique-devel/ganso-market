# Evidência de verificação — RFC-012 (risco de resolução e grafo lógico)

- Data: 2026-08-24 (BRT)
- Branch: `claude/rfc-012-execucao-c254e1` (4 commits, um por fase do plano de
  PRs do handoff: A fundação/score, B grafo, C enforcement/onchain/API,
  D dashboard/perímetro)
- Ambiente: macOS (Darwin 25.3.0), Node 24/26, Docker Desktop; PostgreSQL
  18.4-bookworm descartável para as verificações de banco; RPC público da
  Polygon para a verificação onchain ao vivo

Este documento registra somente comandos realmente executados e resultados
reais.

## 1. Gate de fonte completo (`make verify`)

Executado na raiz do repositório após a fase D:

| Etapa                            | Resultado                                                          |
| -------------------------------- | ------------------------------------------------------------------ |
| `npm run format:check` (prettier) | OK                                                                 |
| `npm run lint` (tsc por workspace) | OK                                                                 |
| `npm test` — @ganso-market/api   | **73 arquivos aprovados + 2 pulados; 849 testes aprovados, 17 pulados** (os 17 são as suítes de integração PG, executadas de verdade na etapa 2)  |
| `npm test` — @ganso-market/web   | **5 arquivos, 34 testes aprovados**                                |
| `npm test` — contracts           | 2 arquivos, 70 testes aprovados                                    |
| `cargo fmt/clippy/test/build`    | OK (14 testes; workspace intocado pela RFC)                        |
| Python unittest (workers+scripts) | OK                                                                 |
| `scripts/scan_secrets.py`        | OK                                                                 |
| `docker compose config` + policy | **agregado 4 261 412 864 bytes (4064 MiB) < 4 GiB estrito**        |

Novos testes da RFC-012: **~230 na API** (léxico 23, keccak/ABI 25, score 21,
timeline 10, clarificações 7, config 8, escopo 3, grafo/escadas/curadas/
avaliador 50, sanidade 12, divergência 3, enforcement 8 + 5 endpoints, onchain 10, API 14,
relatório 7, integração PG 10) e **17 no web** (cliente tolerante a payload
malformado + página de resolução renderizada).

## 2. Migrations 0001–0010 contra PostgreSQL real

Container descartável `postgres:18.4-bookworm`; cada arquivo aplicado com o
protocolo do `apply.sh` (`--single-transaction`, `ON_ERROR_STOP=1`,
`migration_version`/`migration_checksum` por psql vars, checksum registrado
em `schema_versions`). As 10 migrations aplicaram limpas em sequência.

Constraints e triggers da 0010 exercitados por SQL direto e pela suíte de
integração (`GANSO_TEST_DATABASE_URL=… npx vitest run
test/polymarket/resolution/integration.test.ts` — **10/10 aprovados**):

| Tentativa                                                        | Erro observado (verbatim, resumido)                 |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| `INSERT resolution_scores` com `score='0.5'` (não canônico)      | `resolution_scores_score_check`                     |
| `INSERT graph_edges` curada sem autor/justificativa               | `graph_edges_curated_needs_author`                  |
| `UPDATE resolution_scores`                                        | `resolution_scores rows are immutable (append-only…` |
| `DELETE FROM resolution_scores`                                   | `resolution_scores rows are immutable…`             |
| reuso de `score_version` com hash de conteúdo diferente           | `SCORE_VERSION_CONTENT_MISMATCH` (gate do boot)     |
| replay da timeline UMA (re-sync do mesmo mercado)                 | 0 linhas novas (dedupe por constraint)              |

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

## 3. Boot real do serviço `polymarket-resolution`

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

| Exigência (Testes obrigatórios da RFC)             | Cobertura                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Diff de regra: versão nova + evento + recomputação   | `clarify.test.ts`, `integration.test.ts` ("classifies the planted rule change…"), state tick em `runner.ts` |
| Rule-precision: corpus real, estável a cosmética     | `lexicon.test.ts` (23 testes: Chainlink > consenso de mídia, Strategy/8-K, mutações cosméticas) |
| Timeline UMA: reset/2 requests/P3/P4, replay         | `timeline.test.ts` (máquina de estados), `onchain.test.ts` (fold onchain), integração (replay sem duplicar) |
| Circuit breaker mercado+grupo, liberação após settle | `score.test.ts`, `integration.test.ts` (grupo), `enforcement.test.ts`                     |
| Buffer monotônico no EV; 50/50 a preços altos        | `score.test.ts` ("EV líquido decresce…", "YES a 80¢ → payoff 50¢")                        |
| Grafo: banda/persistência k; intra-banda sem sinal   | `evaluate.test.ts` (fixtures à mão), `graph.test.ts` (ciclo de vida k=3)                  |
| negRisk: Σasks<1 executável; [1,1] impossível; placeholders | `evaluate.test.ts` (walk com profundidade real), `onchain.test.ts` ([1,1] em negRisk ⇒ resultado nulo), registry já filtra placeholders (RFC-007) |
| Veto de sanidade bloqueia modelo, baseline fica      | `sanity.test.ts` (15), `enforcement.test.ts` (intent recusado; manual não bloqueado)      |
| Look-ahead com dado plantado no futuro               | `integration.test.ts` contra PG real                                                      |
| Reprodutibilidade por `score_version`                | `integration.test.ts` + gate `SCORE_VERSION_CONTENT_MISMATCH` em runtime real             |
| Enforcement (tarefa 17) com `override_veto` no ledger | `enforcement.test.ts` (gate) + `paper/enforcement.test.ts` (endpoints + payload do ledger) |
| Divergência de camadas nas duas direções             | `divergence.test.ts`                                                                      |
| Busca de código: sem auth/wallet/ordem real          | `scope.test.ts` do módulo (regexes + allowlist de tabelas + fetch só em `onchain.ts` + `closedTime` proibido) |
| Relatórios declaram `n` real com intervalo           | `report.test.ts` (Wilson), relatório gera IC + `prior_in_use` por categoria               |

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
  RFC-011. O que foi verificado localmente: boot limpo, ciclo completo e
  quotas/limites estáticos.
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
