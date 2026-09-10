---
id: EXEC-04
rfc: RFC-034
depends_on: [EXEC-03, FIN-07]
mode: code
---

# EXEC-04 — Concluir RFC-022 D4-A para os dois lados

Execute somente este bloco. Leia `00-protocolo.md`, a emenda no topo da
RFC-022 e RFC-034/Saídas. Confira dependências no estado comum
`docs/roadmap/BTC_EXECUTION_STATE.md`; D1–D3 não são trabalho pendente.

## Contexto mínimo

- `apps/api/src/polymarket/portfolio/exitcycle.ts`: `planExit`, `POSITION_EMPTY`.
- `apps/api/src/polymarket/portfolio/exitstore.ts`: posições e evidência.
- `apps/api/src/polymarket/paper/bridge.ts`: seletor/vínculo de decisões.
- `apps/api/src/polymarket/paper/brokerstore.ts`: `reduceOnlyCap`, reservas.
- `apps/api/test/polymarket/portfolio/exitcycle.test.ts`: sinais de saída.
- `apps/api/test/polymarket/paper/bridge.pg.test.ts`: integração SQL.

## Um resultado

Uma decisão EXIT aceita produz redução executável do inventário do dono,
ou recusa explicada, sem abrir posição oposta.

1. Long real YES/NO vende o próprio token; short legado compra cobertura.
   `shares < 0` não é vazio. Quantidade usa saldo redutível e reservas.
2. Uma intenção ativa por conta/estratégia/token; ID da decisão deduplica.
   Duas decisões concorrentes não podem reservar o mesmo inventário.
3. Aplique livro/fee/valor da saída pelo lado correto. Redução obrigatória
   pode realizar perda: não exija EV positivo de nova entrada.
4. Preserve proteções de resolução/kill switch/reduce-only existentes;
   HOLD posterior não cancela automaticamente a saída já aberta.

## Verificação e aceite

Long de 8,11 cotas gera SELL até 8,11; short −8,11 gera BUY até 8,11.
Fill parcial limita a próxima saída; cobertura não cruza zero; inventário de
outro dono nunca é vendido. Teste duplicata, duas saídas simultâneas,
cancelamento, falta de livro e resolução concorrente em PostgreSQL real.
Cada EXIT elegível tem ordem vinculada ou motivo; amostra vazia não passa.
Execute testes focados e checks do protocolo comum.

## Limites

Não refazer D1–D3, alterar TTL/frescor ou abrir live. A emenda da RFC-022
prevalece sobre o SELL genérico do texto histórico para shorts.

## Encerramento

Atualize EXEC-04/D4 no estado com testes e limitações operacionais.
Deixe o contrato final para FRESH-03/EXEC-05. Pare após este bloco.
