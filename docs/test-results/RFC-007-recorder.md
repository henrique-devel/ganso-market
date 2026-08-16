# Evidência — recorder Polymarket (antecipação da RFC-007)

- Data: 2026-08-15
- Escopo: coletor read-only de dados públicos da Polymarket (CLOB V2), como
  antecipação da RFC-007. Apenas APIs públicas; sem auth de trading, wallet,
  ordens ou execução. Vive no workspace da API
  (`apps/api/src/polymarket/`) e usa `fetch`/`WebSocket` globais do Node 24 (sem
  dependências novas).

## O que foi implementado

- **Registry de mercados** (`gamma.ts`): parse do JSON da Gamma para
  `MarketRegistryEntry` (condition_id, question, clobTokenIds parseado do array
  stringificado, neg_risk, tick size, min size, rewards min/max, fee type,
  datas), com tick/rewards mantidos como strings decimais (nunca float). Filtro
  de universo: inclui crypto/macro/economics/weather ativos com regras e dois
  tokens; **exclui eleições** (por palavra-chave) e categorias fora do conjunto.
- **Livro** (`book.ts`): reconstrução a partir do snapshot + aplicação de deltas
  `price_change` (tamanho absoluto; zero remove o nível); comparação de preços
  por inteiro de ponto fixo (BigInt), sem float; top-10 por lado (melhor bid =
  maior preço, melhor ask = menor).
- **Parsing de mensagens** (`messages.ts`): frames do WebSocket de mercado
  (array ou objeto único) para `book`, `price_change`, `last_trade_price`,
  `tick_size_change`, com validação defensiva.
- **Recorder** (`recorder.ts`): `SnapshotThrottle` (top-of-book a cada ~2–5s por
  token), `MarketBookTracker` (mantém livro por token e persiste snapshots
  throttled), `fetchTrackedMarkets`, adaptador de WebSocket do Node, mensagem de
  subscribe (`assets_ids`/`type: market`), heartbeat PING/10s e store PostgreSQL.
- **Entrypoint** `polymarket-recorder.ts` (processo próprio, reconecta ao fechar).
- **Migration 0004**: `polymarket_markets` (registry com `rules_version`) e
  `polymarket_book_snapshots` (top-10 com source_ts/received_at); preços/tamanhos
  em JSONB como strings.

## Testes executados

`make verify` — sucesso em 2026-08-15. `vitest` da API: **58 testes** (17 novos
do Polymarket), incluindo parse de mercado + array stringificado, filtro de
universo (inclui crypto, exclui eleição/fechado/thin/categoria fora),
comparação decimal exata, reconstrução de livro + deltas + top-10, parse de
frames WS (array/objeto/malformado) e o tracker (snapshot a partir do book,
throttle e novo snapshot após o intervalo). Typecheck, prettier, build (tsc +
vite), secret-scan e compose policy: verdes.

## Não coberto / bloqueios

- **Coleta ao vivo** (fetch da Gamma, WebSocket real, persistência) não é
  executada em teste nem iniciada por container ainda; o transporte é injetável e
  o núcleo é testado com fakes. Rodar continuamente pede um serviço/So novo no
  Compose (fora do orçamento atual sem revisão) — decisão de deploy.
- **Simulador, baseline/calibração, EV com custos V2, sinais e paper broker** são
  o corpo principal da RFC-007 e permanecem pendentes; este recorder é a fundação
  de dados ("recorder primeiro").
- **TTL/pruning** das tabelas Polymarket será adicionado junto do restante da
  RFC-007.
