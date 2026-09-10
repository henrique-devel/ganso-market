---
id: GATE-03
rfc: RFC-040
depends_on: [GATE-02]
mode: operation-plan
---

# GATE-03 — preparar decisão concreta de microcapital

Siga [00-protocolo.md](00-protocolo.md). Este bloco prepara uma decisão;
não implementa RFC-009, envia ordem, abre carteira ou deposita dinheiro.

## Resultado

Plano verificável com requisitos restantes, orçamento de perda e separação entre
eventual autorização de construir o executor e autorização de ativá-lo.

## Leitura mínima

- `docs/rfcs/RFC-040-experimento-btc-e-progressao-de-capital.md`: §§1/4–6.
- `docs/rfcs/RFC-009-polymarket-live-execution.md`: pré-condições e rollout.
- `docs/roadmap/BTC_MANDATE.md`: versão vigente, sem inferir aprovação ausente.
- Relatório e recibo GATE-02: estados/limitações, não documentação histórica inteira.
- `docs/ops/SERVER_ACCESS.md`: contexto de execução.

## Escopo

Crie documento local proposto `docs/roadmap/BTC_MICROCAPITAL_PLAN.md` (até 100 linhas).
Liste executor/signer/reconciliação live ainda ausentes; não confunda paper pronto
com ordem real pronta. Verifique documentação oficial atual da venue para acesso,
contratos/fees, mínimo de ordem, cancelamento, saída e resgate; registre links/data.

Use capital/perda/ticket/prazo somente quando informados pelo proprietário. Sem esses
valores, deixe campos explícitos e complete todo trabalho independente antes da
pergunta necessária. Não mudar VPS como solução de elegibilidade ou contornar bloqueio.

## Aceite

Conta fecha para mínimo da venue, ordens+posições, pior payoff e perda total. Plano
inclui gatilhos de interrupção, replay/fill versus live, dono e evidência de cada gate.
GATE-03 não substitui aprovação expressa de emenda 009 nem de ativação; referências
a autorizações existentes devem ser exatas, evitando pedir novamente o que já vale.

Feche recibo com o que está pronto e os únicos campos/decisões realmente pendentes.
