---
id: FIN-01
rfc: RFC-038
depends_on: []
mode: read-only
---

# FIN-01 — Fechar o contrato financeiro e suas fixtures

Execute somente este bloco. Leia `00-protocolo.md` nesta pasta e
`docs/roadmap/BTC_EXECUTION_STATE.md`; não carregue HANDOFF inteiro.
Leia RFC-038, seções Contrato financeiro e Persistência.

## Contexto mínimo

- `apps/api/src/polymarket/paper/ledger.ts`: `applyFill`, `replayLedger`.
- `apps/api/src/polymarket/portfolio/exitstore.ts`: `loadPaperPnl`.
- `apps/api/src/polymarket/portfolio/exposure.ts`: `bucketWorstCase`.
- `migrations/0008_polymarket_paper_broker.sql`: ledger e cache por token.
- `migrations/0020_fast_strategy_registry.sql`: identidade fast existente.

## Um resultado

Criar `docs/roadmap/evidence/FIN-01-financial-contract.md` (arquivo proposto):
contrato curto e fixtures numéricas calculadas à mão, sem alterar runtime/banco.

1. Defina dinheiro, custo, receita, perda máxima, equity e timestamp realizado.
2. Escolha o menor esquema aditivo por conta/estratégia/token. Justifique
   como cada evento, cache, ordem e futura reserva compartilha esse dono.
3. Liste colunas/tabelas propostas e consumidores necessários por bloco;
   não trate esquema proposto como existente nem crie migrations neste passo.
4. Preserve eventos legados; explicite atribuição desconhecida e versões.

## Fixtures e aceite

- Dez cotas short a 0,40, marca 0,50: PnL −1; risco inicial 6, sem fees.
- Dez NO comprados a 0,60: risco 6; compra não é venda sintética de YES.
- Eventos independentes com custos 30 e 40 podem perder 70 juntos.
- Dois donos no mesmo token; saída parcial antes da meia-noite; resolução
  posterior; fee debitada uma vez; reserva simultânea sobre caixa de 1.000.

Inclua sequência de eventos, cash/PnL/posição esperados após cada passo,
unidades, UTC e regra de arredondamento. Resultado não pode vir de `replayLedger`.
Confirme os símbolos no HEAD e registre divergências; não exija SSH.

## Encerramento

Entregue somente o contrato e atualize a linha FIN-01 no estado comum.
Indique caminhos e decisões suficientes para FIN-02/QA-01 continuar.
Não implemente correções, opere servidor, mude limites ou comece outro bloco.
