---
id: FIN-04
rfc: RFC-038
depends_on: [FIN-03]
mode: code
---

# FIN-04 — Medir exposição por perda possível

Execute somente este bloco. Leia `00-protocolo.md`, RFC-038/Contrato financeiro
e FIN-01/03 em `docs/roadmap/BTC_EXECUTION_STATE.md`.

## Contexto mínimo

- `apps/api/src/polymarket/portfolio/exposure.ts`: `computeExposures`.
- `apps/api/src/polymarket/portfolio/exitstore.ts`: posições de entrada.
- `apps/api/src/polymarket/portfolio/runner.ts`: construção de exposição.
- `apps/api/src/polymarket/portfolio/sizing.ts`: headroom consumido.
- `apps/api/test/polymarket/portfolio/exposure.test.ts`: expectativas.
- `apps/api/test/polymarket/portfolio/sizing.test.ts`: limites derivados.

## Um resultado

Substituir a exposição por custo/max-leg por perda máxima conservadora
derivada do payoff e do dono, sem alterar os valores dos caps.

1. Separe custo/receita de risco. Inclua perda de short legado e fees.
2. Eventos independentes somam risco; pertencer à mesma categoria/fator
   não permite compensação. Remova a regra genérica `bucketWorstCase=max`.
3. Redução de risco dentro do mesmo contrato só com cenários completos
   comprovados. Sem essa prova, use soma conservadora explicitamente rotulada.
4. Preserve cada dimensão e sua chave. `negRisk` não torna um bucket inteiro
   mutuamente exclusivo; resultado não coberto pode perder todas as pernas.

## Verificação e aceite

Fixture FIN-01: posições independentes de custo 30 e 40 consomem 70,
inclusive quando só uma marca `negRisk=true` na categoria/fator compartilhados.
Short dez cotas vendido a 0,40 arrisca 6 antes de fees.
Teste evento incompleto, evento com prova de cenários, zero e duas estratégias.
Compare valores esperados enumerando payoffs, sem chamar a função de risco
para construir o esperado. Sizing não excede o novo headroom.

## Limites

Este bloco não cria reservas concorrentes: FIN-05 faz a atomicidade.
Não reclassifique dados históricos para fazer um teste passar; não crie
modelo probabilístico de risco quando o contrato exige perda máxima.
Execute testes focados e checks previstos em `00-protocolo.md`.

## Encerramento

Atualize FIN-04 no estado com mudanças de semântica e fixtures executadas.
Liste o contrato que FIN-05 usará para reservar capacidade. Pare aqui.
