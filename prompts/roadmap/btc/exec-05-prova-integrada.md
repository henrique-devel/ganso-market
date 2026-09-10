---
id: EXEC-05
rfc: RFC-034
depends_on: [EXEC-04, QA-01]
mode: read-only
---

# EXEC-05 — Provar execução integrada com carteira finita

Execute somente este bloco. Leia `00-protocolo.md`, RFC-034/Aceite e resumos
FIN-07/EXEC-01..04/QA-01 em `docs/roadmap/BTC_EXECUTION_STATE.md`.
Não recarregue arquivos inteiros já resumidos sem necessidade.

## Contexto mínimo

- `apps/api/test/polymarket/paper/bridge.pg.test.ts`: ponte SQL.
- `apps/api/test/polymarket/paper/brokerstore.test.ts`: persistência.
- `apps/api/test/polymarket/portfolio/integration.pg.test.ts`: estado SQL.
- `apps/api/src/polymarket/paper/ledger.ts`: fonte financeira.
- `apps/api/src/polymarket/paper/performance.ts`: evidência de execução.

## Um resultado

Criar `docs/roadmap/evidence/EXEC-05-integration.md` (proposto), comprovando
o ciclo econômico completo em banco de teste com capital simulado finito.

1. Execute as fixtures independentes e suites existentes na infraestrutura
   QA-01; declare quantidade de testes SQL realmente executados/ignorados.
2. Percorra decisão→token/tamanho final→EV→reserva→fill parcial→saída→resolução,
   incluindo duas estratégias no mesmo token e capital inicial de US$1.000.
3. Compare cash, posição, fee, PnL, equity e reservas a cada transição com
   a tabela manual; repita eventos/restart sem mudar o resultado.
4. Inclua recusa por EV insuficiente no tamanho final, fee desconhecida,
   livro insuficiente e inventário reservado; maker/taker separados.

## Aceite

Nenhum fill além da ordem ou do caixa; nenhum short novo; nenhum dono
financia outro; nenhuma parcela realizada/fee aparece duas vezes.
Entrada/saída aceita no fixture produz ordem ou motivo auditável; G4 sem
amostra continua sem evidência. Registre limitações do modelo de fila.
Saída BUY cobre short legado; SELL fecha long YES/NO sem cruzar zero.
FRESH-03 é dependência adicional de prontidão operacional, não requisito
para esta prova econômica isolada; não declare o worker pronto por inferência.

## Limites

Sem modificar runtime, ledger operacional, limites, gates ou deploy.
Falha vira correção mínima no bloco responsável; não maquiar relatório.
Ausência de SQL real mantém aceite pendente, não aprovado por mock.

## Encerramento

Atualize EXEC-05 com comandos, corte/HEAD, resultados e pendências.
Entregue evidência para RFC-032/033; não alegue lucro nem execute outro bloco.
