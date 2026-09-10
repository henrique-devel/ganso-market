---
id: OPS-05
rfc: RFC-021
depends_on: [OPS-01]
mode: code
---
# OPS-05 — Detectar silêncio RTDS com socket aberto

Siga `prompts/roadmap/btc/00-protocolo.md`. Consulte em
`docs/roadmap/BTC_EXECUTION_STATE.md` somente este bloco e suas dependências.
Um bloco por contexto; não carregar o diagnóstico ou handoff histórico inteiro.

## Objetivo

Adicionar detecção de silêncio RTDS persistida e recuperável, isolada da mudança
de benchmark BTC da RFC039.

## Leitura mínima

- `docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md` — emenda OPS-05 e princípio D1.
- `apps/api/src/polymarket/rtds.ts` — createRtdsRecorder / parseRtdsFrame.
- `apps/api/src/polymarket/orchestrator.ts` — createOrchestrator.
- `apps/api/test/polymarket/rtds.test.ts` — socket e flush fixtures.
- `migrations/0005_polymarket_data_foundation.sql` — polymarket_data_gaps / polymarket_rtds_prices.

Abra os símbolos/seções indicados; paths de saída novos são propostos.

## Escopo e limites

Medir último frame de preço válido por feed/símbolo assinado e saúde global;
transporte vivo não prova preço fresco. Registrar início/fim de gap e tentativa de
resubscribe/reconnect com backoff e budget. Escolher limiar explícito apoiado em
OPS-01; expor configuração validada, nunca preencher lacuna com preço repetido de
cache. Resubscribe/reconnect não apaga a falha de persistência. Não alargar escopo
para novos símbolos, mudar TWAP para Binance, alterar estimador ou kill switch.
Se a causa já está tratada, entregar regressão que confirme o comportamento sem
reescrever collector funcional.

## Aceite e verificação

- Socket falso fica aberto e sem preço: gap aparece e recuperação é limitada.
- Heartbeat inválido/PONG não fecha gap; primeiro preço válido fecha uma vez.
- Um feed silencioso é visível mesmo com outro fluindo; erro de persistência aparece.
- Stop cancela timer/retry; reconexão não duplica assinaturas nem buckets.
- Rodar rtds e orchestrator afetados e typecheck da API.

## Fim e handoff

Registrar campos de saúde, limiar e evidence fixture. OPS-04 verificará frescor
real; BTC benchmark consumirá dados com proveniência sem redefinir este detector.
