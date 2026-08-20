# Evidência de verificação — RFC-007 (fundação de dados Polymarket)

- Data: 2026-08-19/20 (BRT)
- Commits: `40731be` (implementação), `3f48be5` (correções da revisão
  adversarial), `+1` (pool do recorder) na branch `claude/rfc-007-data-foundation`
- Ambiente: clone em diretório temporário no macOS do proprietário (o checkout
  em `~/Desktop` estava bloqueado por permissão do macOS); Docker 29.6.1 local
  para o smoke ao vivo isolado

## Comandos realmente executados e resultados

### Suítes e gates (offline)

- `make verify` — **verde (exit 0)** após a implementação e após as correções
  da revisão (formatadores, lint estrito incl. testes, vitest, builds TS/Rust,
  compileall/unittest do worker, scanner de secrets, política do Compose com
  agregado 3.758.096.384 bytes após o recorder ir a 1024 MiB).
- `npx vitest run test/` (apps/api) — **213 testes, 25 arquivos, todos
  verdes**, incluindo as suítes novas: registry/universo (caps, exclusões,
  falha parcial de fetch sem exits em massa), versionamento (vigência
  `[valid_from, valid_to)`, auto-reparo `MAX(version)+1`, hash canônico),
  bookpipe (snapshot+deltas byte a byte, dedupe por hash da venue, serialização
  de handleMessage, onPersistFailure com janela exata, seedBook), dualws
  (dedupe entre conexões; perda em 1 conexão não é gap; nas 2 é), trades
  (janelamento sem perda/duplicata na borda, overflow de offset vira gap),
  samplers (transições UMA únicas; hidratação ignora rule_change), rtds
  (frames oficiais; E18; agregação 1min), macro (calendário idempotente;
  release BLS único; gap único após 6h), retention (cutoff seguro sem OFFSET;
  progresso por bytes lógicos; pré-condição por minuto-com-delta; tabelas
  protegidas), replay (âncora+deltas com duplicata e size=0; `to` exclusivo),
  readapi (401 sem token; as-of nas bordas; validações 400; adaptadores).
- Regressão de `source_ts` epoch-ms → timestamptz coberta por teste
  (crash-loop do commit `350d3c9`).

### Revisão adversarial

Workflow de revisão com 6 lentes (SQL×schema, retenção/perda de dados,
erro/crash, concorrência, universo/regras, API) + refutação por achado:
**24 achados confirmados, todos corrigidos e cobertos por teste** (commit
`3f48be5`). Destaques: 3 bugs classe perda-de-dados na retenção; falta de
transação no versionamento; ordem de aplicação de deltas; handler de `error`
ausente no socket `ws` (matava o processo — reproduzido ao vivo).

### Smoke ao vivo isolado (Docker local, projeto/volume próprios)

Stack `postgres + migrate (0001–0005) + polymarket-recorder` contra as APIs
reais da Polymarket, projeto `gansorfc007smoke` (volume canônico intocado):

- 1ª rodada (pré-correções): expôs 3 problemas reais — crash-loop por
  `Unhandled 'error' event` no `ws` (DNS EAI_AGAIN), snapshots full duplicados
  entre as duas conexões WS, double-parse do calendário macro. Todos
  corrigidos.
- 2ª rodada: universo com 66–95 mercados (crypto+macro), regras e parâmetros
  versionados (66 versões cada), calendário macro sincronizado (15 entradas),
  trades por WS e Data API, dedupe de books confirmado (subscribe = 1/token).
  RTDS zerado → frame de subscribe corrigido contra a doc oficial
  (Binance lista por vírgula; TWAP um símbolo por assinatura; valor E18).
- 3ª rodada: persistência falhando em rajada (centenas de `*_PERSIST_FAILED`)
  → causa: pool compartilhado `max 4` com `query_timeout` de 2 s dimensionado
  para a API; recorder ganhou pool próprio (10 conexões, 30 s).
- 4ª rodada (final, ~7 min sob carga plena): **zero erros, zero gaps não
  registrados**; 95 mercados / ~190 tokens; 748.892 deltas L2; 264.367 trades
  (WS+backfill); RTDS 2.085 preços crus + agregados 1min; OI/holders 2.266
  amostras; séries 1m 3.319 buckets; `source_ts` e `ingest_lag_ms` preenchidos
  em 100% dos deltas.

### Medição de volume (decisão futura para o proprietário)

No ritmo observado (universo com séries curtas crypto 5min/15min), os deltas
L2 geram ~29 GB/dia. A quota dura de 12 GB governa (quota vence TTL), então a
janela efetiva de L2 será ~0,5 dia, não os 14 dias do TTL alvo. Opções
futuras: reduzir séries curtas do universo (prioridade 3 do cap) ou rebalancear
quotas. Nenhuma ação tomada sem decisão do proprietário.

## Riscos residuais e pendências

- Validação ao vivo em produção pendente (merge/deploy + ativação do profile e
  janela de observação; o critério de 7 dias contínuos com uptime ≥ 99% só se
  comprova em produção).
- Shapes tolerantes de `/fee-rate`, `/holders` e frame RTDS conferidos ao vivo
  no smoke, mas a doc oficial deve ser reconferida a cada mudança de schema da
  venue (frames desconhecidos são contados, nunca derrubam).
- FOMC/BEA: apenas calendário (sem API pública de valores); releases dessas
  fontes são manuais, documentado no runbook e no arquivo do calendário.
- O smoke final foi interrompido por falha ambiental do host (rede do macOS
  após sleep — errno 49 até em loopback), não por defeito do recorder.
