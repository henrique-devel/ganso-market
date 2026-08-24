# Evidência de verificação — RFC-011 (microestrutura e paper broker)

- Data: 2026-08-23/24 (BRT)
- Branch: `claude/rfc-011-readiness-2a6695`; PRs #18 (aceitação + pré-trabalho),
  #19 (fundação), #20 (Parte A), #21 (Parte B), #22 (Partes C/D núcleo),
  #23 (fecho: calibração/relatório/intents + este documento)
- Ambiente: macOS do proprietário (worktree durável), Docker 29.7.2 local para
  os PostgreSQL descartáveis das verificações de migration

Este documento registra **somente comandos realmente executados e seus
resultados reais**. O que não foi executado está dito explicitamente na seção
"Não verificado / pendências".

## 1. Gate de fonte completo

`make verify` executado **verde (exit 0)** após cada parte (fundação, A, B,
C/D núcleo, fecho). Estado final:

| Suíte                             | Resultado real                                      |
| --------------------------------- | --------------------------------------------------- |
| vitest `@ganso-market/api`        | 642 passed, 7 skipped (649)                         |
| — dos quais módulo paper          | 127 testes em 13 arquivos                           |
| vitest `@ganso-market/web`        | 15 passed                                           |
| vitest `@ganso-market/contracts`  | 70 passed                                           |
| `cargo test --workspace`          | 14 passed                                           |
| unittest Python (worker+scripts)  | OK                                                  |
| `scripts/scan_secrets.py`         | passou                                              |
| `scripts/check_compose_policy.py` | passou, agregado 4.261.412.864 B (4064 MiB < 4 GiB) |

Os 7 skipped são os testes de integração da RFC-010 que exigem
`GANSO_TEST_DATABASE_URL` (comportamento documentado desde a RFC-010).

## 2. Migrations contra PostgreSQL real

Containers descartáveis `postgres:18.4-bookworm`; migrations **0001–0009**
aplicadas em sequência com o protocolo do `infra/migrations/apply.sh`
(checksum real por arquivo, `--single-transaction`, `ON_ERROR_STOP=1`):
todas `applied`, 8 tabelas `paper_*` criadas.

Constraints exercitadas por SQL direto, com o resultado real:

| Tentativa                                                          | Resultado observado                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `paper_feature_windows` com `volume_signed` e status `UNAVAILABLE` | `ERROR: ... "paper_feature_windows_signed_needs_onchain"`            |
| `window_kind` desconhecido (`'5s'`)                                | `ERROR: ... "paper_feature_windows_window_kind_check"`               |
| Janela invertida (`window_end <= window_start`)                    | `ERROR: ... "paper_feature_windows_check"`                           |
| `book_invalid_reason` inventado                                    | `ERROR: ... "paper_feature_windows_book_invalid_reason_check"`       |
| Janela duplicada com `ON CONFLICT DO NOTHING`                      | `INSERT 0 0` (absorvida)                                             |
| Ordem com `limit_price` vazio                                      | `ERROR: ... "paper_orders_limit_price_check"`                        |
| FAK sem `worst_price`                                              | `ERROR: ... "paper_orders_marketable_needs_worst"`                   |
| Evento de ledger duplicado (mesma `idempotency_key`)               | `INSERT 0 0` (absorvido)                                             |
| `UPDATE` em evento do ledger                                       | `ERROR: paper_ledger_events rows are immutable (append-only ledger)` |
| `DELETE` em evento do ledger                                       | `ERROR: paper_ledger_events rows are immutable (append-only ledger)` |

## 3. Testes obrigatórios da RFC — onde cada um está coberto

| Exigência da RFC                                                                                                          | Onde está coberto                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Features contra fixtures com resultado esperado                                                                           | `features.test.ts` — valores exatos (spread 400 bps, imbalance 0.333333, depth por k ticks, vol ln(1.1)→0.095310)                                                       |
| Look-ahead: feature em t não muda com dados > t                                                                           | `featurestore.test.ts` — dataset em memória com bounds; dados posteriores acrescentados → linha byte-idêntica; varredura do SQL de todo loader exigindo limite superior |
| Direção do WS não é lida; sem onchain → `UNAVAILABLE`                                                                     | `features.test.ts` (flow) + CHECK no banco (seção 2) + guard de escopo                                                                                                  |
| Validador: todos os tick sizes; abaixo de `min_order_size`; sequência byte a byte                                         | `validator.test.ts` — tabela completa dos 6 ticks; caso em que o up-then-down muda o resultado (0.3×0.39999999 → 0.12, não 0.11)                                        |
| Ordem sem `limit_price` → 422; FAK/FOK sem `worst_price` → 422                                                            | `api.test.ts` (endpoint) + `validator.test.ts` + CHECKs no banco                                                                                                        |
| Nenhum caminho cria ordem sem limite (propriedade)                                                                        | `policy.test.ts` — varredura de 720 contextos                                                                                                                           |
| Book-walk: partial por nível, `worst_price`, FAK vs FOK                                                                   | `broker.test.ts` + `brokerstore.test.ts`                                                                                                                                |
| Fila passiva: fill só após trades excederem a fila; porção preenchida não cancelável                                      | `broker.test.ts` (função pura) + `brokerstore.test.ts` (fluxo completo: 60 negociados → nada; +70 → 20)                                                                 |
| Latência/taker delay: book de t+lat(+250ms); cancel bloqueado no delay; trade entre cancel_requested e effective preenche | `brokerstore.test.ts` — book de execução pior que o da decisão; 409 no delay; fill dentro da janela de cancel                                                           |
| Fees pelo `fee_schedule_id` da época do fill                                                                              | `brokerstore.test.ts` — fee 700 bps no preço de execução, `fee_param_version_id` no evento                                                                              |
| Resolução YES/NO/0,5; 0,5 em negRisk → erro                                                                               | `broker.test.ts` + `brokerstore.test.ts` (congela mercado, nunca liquida)                                                                                               |
| Ledger: replay determinístico; duplicatas e out-of-order idempotentes                                                     | `ledger.test.ts` (shuffle+duplicatas → mesmo estado) + `brokerstore.test.ts` (re-rodar tick não adiciona nada)                                                          |
| Fill grava o trecho de book consumido                                                                                     | `brokerstore.test.ts` — `book_slice` no payload do evento                                                                                                               |
| Mark: `STALE_MARK` congelado; book-walk do tamanho total                                                                  | `broker.test.ts` (48, não 50) + `brokerstore.test.ts` (freeze após 1 h sem book)                                                                                        |
| Kill switch: cancela tudo, bloqueia, rearm; disputa UMA congela                                                           | `brokerstore.test.ts` + `api.test.ts` (endpoints)                                                                                                                       |
| Boot falha se `execution_mode != paper`                                                                                   | `runner.test.ts` (`EXECUTION_MODE_NOT_PAPER`)                                                                                                                           |
| Busca de código: sem auth/wallet/ordem real (+EIP-712)                                                                    | `scope.test.ts` — clone do guard da RFC-010 ampliado com `signTypedData`/`EIP712Domain`/`verifyingContract`                                                             |
| Markout assinado pelo lado; ausência explícita em book stale                                                              | `calibration.test.ts`                                                                                                                                                   |
| P(fill) walk-forward, nunca k-fold; intervalo publicado                                                                   | `calibration.test.ts` — labels só após a vida decorrer; Wilson por bucket; relatório com janela dos dados                                                               |
| Três colunas; otimista nunca em gate                                                                                      | `performance.test.ts` — base 4.80 / estresse 4.40 / otimista 10.90 no cenário de fixture; nota explícita                                                                |

## 4. Decisões de implementação registradas

- **RAM:** `polymarket-paper` 256 MiB; `model-worker` 256→**96 MiB** (não os
  128 cogitados: o cap do CI é estrito `< 4 GiB` e 128 deixaria o agregado
  exatamente em 4 GiB). Agregado verificado: 4064 MiB.
- **Disco:** reserva de 6 GB fechada em 6,00 GB: fundamental 4,7 + features
  0,6 + markouts/calibração 0,4 + ledger/ordens/estado 0,3 (o teste
  `budget.test.ts` passou a asseverar a reserva explicitamente).
- **Latência simulada:** default conservador de 1.000 ms (não existe medição
  de round-trip; o PONG do WS é descartado sem cronometrar — pré-trabalho
  opcional registrado na RFC).
- **Degradação de fills:** determinística (hash djb2 de ordem+trade), 30%,
  gravada como evento de negação; o ledger canônico É a coluna base.
- **Pré-trabalho obrigatório (PR #18):** o parser WS de trades descartava
  `size`/`fee_rate_bps`/`transaction_hash`; corrigido com teste pelo caminho
  real de produção.

## 5. Não verificado / pendências para `implemented`

- **Ativação em produção:** o serviço `polymarket-paper` está no Compose mas
  **não foi ativado no servidor** (o SSH ao servidor foi bloqueado pelas
  permissões da sessão de implementação). Ativar com
  `docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-paper`.
- **Rebuild do recorder em produção** após o merge do PR #18 (o CD não troca
  imagem de profile) — sem ele, os trades WS continuam sem
  `size`/`fee_rate_bps`/`transaction_hash` e a fila passiva do broker só
  enxerga o backfill da Data API (janelas de 5 min).
- **Soak de 24 h** com o recorder live dentro do orçamento de RAM/disco: não
  executado (mesma pendência que a RFC-010 registrou; comprova-se em produção).
- **Track record real:** ledger vazio até a ativação; os gates da RFC-009
  precisam de semanas de paper trading.
- **Feature A4 (direção de fluxo):** nasce `UNAVAILABLE` por construção até o
  pipeline onchain `OrderFilled` (fase 2 da RFC-007) existir.
- **Sinal externo defensivo (B4):** o fio `externalFairAgainst` existe na
  política e está testado, mas o produtor do sinal (divergência RTDS) só
  chega com os insumos da RFC-013 — hoje o valor é sempre `false` no endpoint
  de intents.
- A cadência do amostrador de P(fill) (10 tokens/5 min) e as sub-quotas foram
  dimensionadas por projeção, não por medição em produção — reavaliar no soak.
