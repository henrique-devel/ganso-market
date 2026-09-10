---
id: EXEC-03
rfc: RFC-034
depends_on: [EXEC-02, FIN-05]
mode: code
---

# EXEC-03 — Reconciliar fills e cancelamento paper

Execute somente este bloco. Leia `00-protocolo.md`, RFC-034/Execução simulada
e as dependências em `docs/roadmap/BTC_EXECUTION_STATE.md`.

## Contexto mínimo

- `apps/api/src/polymarket/paper/broker.ts`: regras de fill.
- `apps/api/src/polymarket/paper/brokerstore.ts`: fill/cancelamento persistente.
- `apps/api/src/polymarket/paper/ledger.ts`: idempotência econômica.
- `apps/api/src/polymarket/paper/performance.ts`: métricas de execução.
- `apps/api/test/polymarket/paper/broker.test.ts`: cenários do simulador.
- `apps/api/test/polymarket/paper/brokerstore.test.ts`: persistência.

## Um resultado

Provar e corrigir o ciclo aceito→fill parcial→cancelamento efetivo para
que o simulador mova cash/reserva/posição uma única vez por execução.

1. Reuse FIN-05; quantidade preenchida acumulada não excede ordem/reserva.
2. Mantenha fila maker auditável e latência/profundidade taker. Toque no
   limite sem evidência de fill não preenche automaticamente a ordem.
3. Fee tem procedência/versão verificável. Assunções pertencem ao replay;
   ausência de fee ou amostra não aprova taker nem o gate G4.
4. Separe métricas maker/taker existentes com cobertura explícita; não
   crie painel novo. Corrija somente lacunas necessárias ao contrato de fill.

## Verificação e aceite

Teste fill parcial seguido de cancelamento solicitado, fill ainda permitido
antes do efeito e nenhum após efeito; latência e profundidade limitam volume.
Retry/reordenação/restart preservam fees e PnL, inclusive com dois donos.
PostgreSQL real prova consumo/liberação atômicos de reservas e rollback.
Fixture de fila impede lucro por simples toque; fixture de profundidade
impede fills ilimitados. Registre modelo e limitações, sem chamar isso de live.
Execute testes focados e checks exigidos pelo protocolo comum.

## Limites

Não criar nova política de expiração ou frescor: pertence a FRESH-03.
Sem ajustar G4, simular rebate presumido, abrir live ou ligar worker.

## Encerramento

Atualize EXEC-03 com transições provadas e cobertura maker/taker.
Informe as funções de reserva/fill disponíveis para EXEC-04. Pare aqui.
