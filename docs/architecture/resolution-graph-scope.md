# Escopo do módulo de risco de resolução e grafo lógico (RFC-012)

Este documento declara, normativamente, o que o módulo `resolution/` **não
faz**, e como essa fronteira é imposta por teste automatizado em todo
`make verify`.

## O que este módulo é

Camada analítica pura sobre os dados que a RFC-007 já grava: score de risco
de resolução `R` por mercado, mapeamento determinístico score→ação
(VETO/BUFFER/CIRCUIT_BREAKER), buffer de resolução para o EV, grafo lógico
entre mercados (MUTEX/IMPLIES/EQUIV/LADDER/NEGRISK) avaliado contra preços
executáveis com banda de custos, vetos de sanidade sobre o modelo
fundamental, divergência entre as duas camadas de circuit breaker, timeline
UMA por request (reset/2 requests, P1–P4) e o relatório de medição própria.

## O que este módulo NUNCA faz

- **Nenhuma execução real**: não existe ordem, assinatura, credencial de
  trading, caminho EIP-712 nem endpoint de trading — nem desarmado. O único
  modo de execução aceito pelo runtime é `paper`; o boot recusa qualquer
  outro (`EXECUTION_MODE_NOT_PAPER`).
- **Nenhuma escrita onchain**: o coletor da fase 2 usa exclusivamente
  métodos de LEITURA (`eth_blockNumber`, `eth_getLogs`,
  `eth_getBlockByNumber`) contra RPC público da Polygon. Métodos de estado
  (`eth_sendRawTransaction`, `eth_sign`, `personal_*`, `eth_accounts`) são
  proibidos por regex no guard de escopo.
- **Nenhum acesso a rede fora de `onchain.ts`**: `fetch(` é proibido em
  qualquer outro arquivo do módulo; WebSocket é proibido em todos.
- **Nenhum look-ahead**: todo loader é as-of (`received_at <= asOf`,
  `[valid_from, valid_to)`), e o campo `closedTime` da UMA — que só fica
  conhecível DEPOIS de o desfecho ser público — é proibido por regex no
  módulo inteiro.
- **Fonte primária de PnL**: o grafo não é. `inconsistency_signal` reporta
  magnitude líquida de custos e tamanho executável por book-walk sobre a
  profundidade gravada; nunca presume fill otimista e nunca usa midpoint.
- **Nenhum afrouxamento de banda**: a tolerância é custos medidos (fees
  taker por perna sobre preços executáveis) + ε de configuração. As pernas
  executáveis (bid/ask) já pagam o spread — o termo de spread da fórmula da
  RFC está embutido nelas, nunca é descontado da banda.

## Cobertura do guard

- Módulo: `apps/api/src/polymarket/resolution/` + entrypoint
  `apps/api/src/polymarket-resolution.ts`.
- Teste: `apps/api/test/polymarket/resolution/scope.test.ts` — varre todos os
  arquivos do módulo com comentários removidos; roda em todo `make verify`.
- Tabelas graváveis (allowlist fechada): `resolution_score_versions`,
  `resolution_scores`, `resolution_market_state`,
  `resolution_clarifications`, `resolution_uma_timeline`,
  `resolution_onchain_events`, `resolution_onchain_cursor`,
  `resolution_adjudication_samples`, `resolution_layer_divergences`,
  `resolution_reports`, `graph_edges`, `graph_violations`,
  `graph_sanity_vetoes`. Escrita fora dessa lista falha o guard.
- Migration: `migrations/0010_polymarket_resolution_graph.sql`. Serviço:
  `polymarket-resolution` (Compose, profile `polymarket`, 192 MiB).

> **FATO VERIFICADO:** os triggers de imutabilidade de
> `resolution_scores`, `resolution_score_versions`,
> `resolution_clarifications`, `resolution_uma_timeline` e
> `resolution_onchain_events` foram exercitados contra PostgreSQL real
> (UPDATE/DELETE recusados com "immutable"), assim como as constraints
> `resolution_scores_score_check` (regex de 6 dígitos) e
> `graph_edges_curated_needs_author`.

## Fronteira com as RFCs vizinhas

- **RFC-010**: leitura de `fundamental_estimates` (somente `source='MODEL'`
  dentro da janela de frescor; estimativa velha é ausência). Nenhuma escrita
  em tabelas `fundamental_*`; o fallback do veto de sanidade é o baseline que
  a RFC-010 já publica.
- **RFC-011**: o paper broker CONSULTA o gate deste módulo
  (`resolution/enforcement.ts`) antes de aceitar intents e ordens; este
  módulo LÊ `paper_kill_switch`/`paper_positions`/`paper_orders` para a
  divergência de camadas e o painel — nunca escreve em tabelas `paper_*`.
  O gatilho de disputa da RFC-011 permanece ativo como redundância
  independente (decisão do proprietário de 2026-08-24).
- **RFC-013**: consumirá score, ação, buffer, grupos e violações pela API e
  pelas tabelas; o cap conjunto por grupo negRisk usa o pior `R` do evento.
- **RFC-009**: qualquer caminho de execução real permanece fora deste módulo
  e atrás dos gates G1–G6 da RFC-013 + aprovação explícita do proprietário.
