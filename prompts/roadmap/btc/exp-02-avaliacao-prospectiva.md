---
id: EXP-02
rfc: RFC-033
depends_on: [EXP-01, REPLAY-04, BTC-04]
mode: code
---

# EXP-02 — Avaliação prospectiva por mercado e dia

Implemente avaliador do manifesto sobre resultados elegíveis/reproduzíveis.
Siga `00-protocolo.md`; use interfaces dos pré-requisitos no estado.

## Contexto mínimo

- `docs/rfcs/RFC-033-experimento-prospectivo-btc.md`: decisões 4–6.
- `apps/api/src/polymarket/fundamental/calibration.ts`: avaliações existentes.
- `apps/api/src/polymarket/paper/fastbacktest.ts`: bootstrap/agrupamento atuais.
- `apps/api/src/polymarket/portfolio/gates.ts`: preservar gates principais.
- `apps/api/test/polymarket/paper/fastbacktest.test.ts`: fixtures de amostra.

## Escopo fechado

1. Valide freeze, hashes, holdout, cobertura e rótulos observados antes de avaliar.
   Prospectivo exige manifesto EXP-01 e dados novos com recibo operacional BTC-05;
   paper observado exige BTC-07. Plano pronto ou fixture não satisfazem isso.
2. Conte N por mercado elegível; trate dependência por mercado e blocos de dia.
   Poucos dias ou amostra incompatível produzem insuficiência explícita.
3. Compare baseline/controle/candidato em universo comum, mostrando também
   intenção de negociar e seleção por fill; não finja pareamento inexistente.
4. Execute revisões 50/100/300 conforme manifesto, com tratamento declarado
   de múltiplas comparações/olhadas. Sem desenho válido, resultado exploratório.
5. Relate PnL executável, diferença para controle, incerteza, perdas/stress,
   concentração e custos; Brier sozinho não comprova lucro.

## Verificação necessária

- Duplicar ticks/braços não aumenta N nem estreita artificialmente intervalos.
- Holdout contaminado ou custo desconhecido não vira confirmação econômica.
- Fixtures com correlação por dia exercitam agrupamento e poucos blocos.
- Revisões e candidatos omitidos do manifesto são recusados/classificados corretamente.

## Entrega

- Avaliador, testes e relatório pequeno incluindo resultado negativo/inconclusivo.
- Estado com evidências/limites para EXP-03.
- Declare método estatístico, unidade, comparação e ajustes usados.

## Limite do bloco

Não recalibre no holdout, some N de braços ou altere gates/risco.
Não prometa calendário a partir de 24 horários/dia sem cobertura elegível.
O avaliador pode ser implementado antes dos rollouts; classifique fixtures como teste.
