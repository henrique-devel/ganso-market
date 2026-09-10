---
id: FIN-05
rfc: RFC-038
depends_on: [FIN-04]
mode: code
---

# FIN-05 — Reservar dinheiro e inventário atomicamente

Execute somente este bloco. Leia `00-protocolo.md`, RFC-038/Reservas e
FIN-02/04 em `docs/roadmap/BTC_EXECUTION_STATE.md`.

## Contexto mínimo

- `apps/api/src/polymarket/paper/brokerstore.ts`: aceite/fill/cancelamento.
- `apps/api/src/polymarket/paper/ledger.ts`: `appendLedgerEvent`.
- `apps/api/src/polymarket/portfolio/exposure.ts`: headroom e risco.
- `apps/api/src/database.ts`: executor e transações disponíveis.
- `apps/api/test/polymarket/paper/brokerstore.test.ts`: fluxo existente.
- `migrations/0008_polymarket_paper_broker.sql`: estados de ordem.

## Um resultado

Introduzir reserva transacional por dono para impedir uso concorrente
do mesmo caixa, capacidade de risco ou inventário redutível.

1. Use o contrato FIN-02/04. Crie no máximo uma migration aditiva de reservas
   se necessária; número conferido agora e tabela nomeada como proposta.
2. Aceite + reserva ocorrem na mesma transação, com lock/constraint que
   cubra o dono financeiro. Evite check-then-insert sem proteção concorrente.
3. Fill parcial transfere a parte consumida à posição/cash. Cancelamento
   solicitado conserva reserva até efeito; fill concorrente tem ordem definida.
4. Expiração efetiva/resolução/restart reconciliam saldos idempotentemente.
   Este bloco não decide novos prazos nem muda a policy de validade.

## Verificação e aceite

Em PostgreSQL real, dispare dois aceites que somados excedem US$1.000:
no máximo o saldo disponível é reservado, independentemente da interleaving.
Teste duas saídas do mesmo inventário, fill parcial + cancelamento, rollback,
retry e retomada. Donos distintos nunca compartilham a reserva por acidente.
Cash disponível + reservado + capital comprometido deve reconciliar com
cashflows; exposição não duplica reserva já transferida à posição.

## Limites

Sem novo limite financeiro, worker, live ou mudança da semântica de expiry.
Use módulo pequeno proposto se necessário. Mock não prova atomicidade;
sem PostgreSQL, registre pendência e não declare este critério aprovado.
Execute testes focados e checks do protocolo comum.

## Encerramento

Registre FIN-05, migration, invariantes e teste concorrente no estado.
Deixe contrato de reserve/release/consume para EXEC-03/04. Pare aqui.
