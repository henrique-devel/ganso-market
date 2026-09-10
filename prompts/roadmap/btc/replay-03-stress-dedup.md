---
id: REPLAY-03
rfc: RFC-032
depends_on: [REPLAY-02]
mode: code
---

# REPLAY-03 — Stress causal e contagens independentes

Acrescente cenários adversos ao motor; cada cenário reexecuta a carteira.
Siga `00-protocolo.md`; use a interface de REPLAY-02 registrada no estado.

## Contexto mínimo

- `docs/rfcs/RFC-032-replay-carteira-finita-evidencia.md`: decisões 4–6.
- `apps/api/src/shadow-replay-cli.ts`: apresentação do contrafactual legado.
- `apps/api/src/polymarket/portfolio/sourcereplay.ts`: acumulação atual.
- `apps/api/src/polymarket/paper/fastbacktest.ts`: braços e intervalos.
- `apps/api/test/polymarket/portfolio/sourcereplay.test.ts`: casos existentes.

## Escopo fechado

1. Defina cenários versionados para fila, latência, profundidade, slippage,
   taxas e cauda. Valores assumidos ficam explícitos com sua procedência.
2. Reexecute fills, reservas e ledger; recalcule resultado/estatística.
   Não multiplique PnL por 0,5 nem reutilize veredito do cenário normal.
3. Deduplicate por identidade real do evento/decisão; vários instantes podem
   gerar oportunidades, mas não novos mercados independentes.
4. Separe mercados, decisões, ordens, fills e negócios encerrados.
5. Publique todos os cenários, sem selecionar só os positivos.

## Verificação necessária

- Mesma trajetória com taxa adicional reduz PnL pelo custo correspondente.
- Exemplo com perda não fica menos negativo por “stress de 50%”.
- Repetição de ticks/eventos não dobra N, capital disponível ou lucro.
- Alterar latência pode mudar seleção/fills: não imponha monotonicidade falsa
   ao PnL agregado de trajetórias diferentes.

## Entrega

- Motor de cenários e fixtures adversas reproduzíveis.
- Estado com schema de resultados para REPLAY-04.
- Evidência de ledger/custos independentes para cada cenário.

## Limite do bloco

Sem tunar braços para melhorar o resultado do fixture ou do dataset histórico.
Não misture cenários alternativos como carteira com capital multiplicado.
