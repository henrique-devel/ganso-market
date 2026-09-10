---
id: BTC-03
rfc: RFC-039
depends_on: [BTC-02]
mode: code
---

# BTC-03 — Worker BTC observacional e idempotente

Implemente o ciclo de sombra usando os contratos entregues por `BTC-01/02`.
Siga `00-protocolo.md`; localize os símbolos novos no estado, sem reler históricos.

## Contexto mínimo

- `docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md`: decisões 4–5.
- `apps/api/src/polymarket/paper/fastpolicy.ts`: contexto e decisão pura.
- `apps/api/src/polymarket/paper/runner.ts`: lifecycle e reentrância.
- `migrations/0020_fast_strategy_registry.sql`: decisões e identidade existentes.
- `apps/api/test/polymarket/paper/scope.test.ts`: limites de escrita.

## Escopo fechado

1. Crie worker/configuração próprios no mesmo repositório/banco; não ative.
2. Use experimento, conta simulada, estratégia, braço, mercado e slot para
   ownership/idempotência. Compatibilidade futura com FIN-02 sem usar posições.
3. Avalie validade por mercado/instante; registre kill de execução como contexto.
   Dados próprios válidos podem gerar observação com kill ativo; zero ordens.
4. Separe tentativas recusadas de decisão do slot: gap temporário não deve
   consumir antecipadamente a oportunidade única. Limite tentativas/logs.
5. Persista insumos, versões, motivos e identificadores para replay.
   Eventual migration é nova; respeite imutabilidade e não aplique em produção.

## Verificação necessária

- Retry, dois ticks concorrentes e restart não duplicam decisão do slot.
- Spy e verificação de persistência: zero ordens, posições e ledger alterados.
- Kill ativo com dado válido observa; dado inválido é excluído com motivo.
- Worker desabilitado preserva lifecycle e testes de escopo existentes.

## Entrega

- Worker e persistência isolados; testes de idempotência e ausência de ordens.
- Estado com identidade/queries a usar por `BTC-04`.
- Evidência dos limites de escrita e nenhuma mudança nos gates principais.

## Limite do bloco

Não copie o pacote operacional do antigo prompt 20b. Sem deploy, UI ou paper.
Primeira ordem depende de FIN-07, EXEC-05 e decisão específica de modo/alocação.
