---
id: FIN-03
rfc: RFC-038
depends_on: [FIN-02]
mode: code
---

# FIN-03 — Reconciliar PnL e equity por dono

Execute somente este bloco. Leia `00-protocolo.md`, RFC-038/Contrato financeiro
e as evidências FIN-01/02 em `docs/roadmap/BTC_EXECUTION_STATE.md`.
Use o contrato atribuído entregue por FIN-02.

## Contexto mínimo

- `apps/api/src/polymarket/paper/ledger.ts`: `replayLedger`, `unrealizedPnlUsd`.
- `apps/api/src/polymarket/portfolio/exitstore.ts`: `loadPaperPnl`.
- `apps/api/src/polymarket/portfolio/state.ts`: `evaluateState`.
- `apps/api/src/polymarket/portfolio/runner.ts`: adaptação do PnL ao estado.
- `apps/api/test/polymarket/paper/ledger.test.ts`: regressões do fold.
- `apps/api/test/polymarket/portfolio/state.test.ts`: equity/limites.

## Um resultado

Derivar um resultado financeiro coerente por dono dos eventos atribuídos,
incluindo shorts legados e realização no tempo econômico.

1. Agrupe posições, cash e fees por conta/estratégia/token; agregado é soma.
2. Corrija marca assinada: bid para long, ask para short; ausência de marca
   fica explícita, sem ganho fictício ou liberação de capacidade.
3. Compute realização por fill redutor/fee/resolução e seu `event_ts` UTC.
   `resolved_at` não substitui a data de uma saída parcial anterior.
4. Adapte o estado ao novo resultado preservando compatibilidade legada;
   se faltou contrato de FIN-02, descreva ajuste mínimo antes de ampliá-lo.

## Verificação e aceite

Converta fixtures FIN-01 em expectativas constantes, independentes da função.
Short de dez cotas a 0,40 marcado a 0,50 perde 1; taxa não entra duas vezes.
Saída em um dia e resolução no seguinte realizam parcelas distintas.
Evento duplicado/fora de ordem não altera resultado; dois donos não se netam.
Teste o caminho carregador → estado, além da função pura, com fixture SQL
quando houver consulta. Rebuild/cache deve igualar replay e agregado.

## Limites

Sem migration nova por conveniência, novos caps, alteração dos gates ou live.
Não ligar worker nem modificar política de execução. Não reescrever o ledger.
Execute testes focados e checks do protocolo; falta de SQL real fica pendente.

## Encerramento

Atualize FIN-03 no estado com fórmulas, contratos e resultados dos testes.
Registre discrepâncias históricas sem atribuir lucro ao bot. Pare neste bloco.
