---
id: EXP-03
rfc: RFC-033
depends_on: [EXP-02]
mode: code
---

# EXP-03 — Registrar a decisão do experimento

Implemente artefato/estado decisório sem alterar configuração operacional.
Siga `00-protocolo.md`; leia as evidências entregues por EXP-02 no estado.

## Contexto mínimo

- `docs/rfcs/RFC-033-experimento-prospectivo-btc.md`: decisão 7 e preservação.
- `docs/rfcs/RFC-018-polymarket-gates-calibration.md`: status e gates existentes.
- `apps/api/src/polymarket/portfolio/gates.ts`: vereditos atuais.
- `apps/api/src/polymarket/fundamental/calibration.ts`: persistência de avaliação.
- `apps/api/src/polymarket/portfolio/sourcereplay.ts`: distinguir contrafactual legado.

## Escopo fechado

1. Estados: research, shadow, paper_evaluable, inconclusive, rejected,
   candidate_for_review; cada transição inclui manifesto/evidência e motivo.
2. Separe prontidão técnica, perda experimental aceitável e evidência de lucro.
   Resultado insuficiente não recebe aprovação por ausência de erro técnico.
3. Mostre benefício versus controle, cobertura, riscos, custos e critérios
   cumpridos/faltantes; mantenha histórico das hipóteses negativas.
4. Produza entrada revisável para RFC-040; nenhuma transição liga live,
   aumenta tamanho ou declara G1–G6 aprovados por critérios diferentes.
5. Referencie pins/datasets de evidência para preservação na RFC-041.

## Verificação necessária

- Amostra insuficiente e holdout contaminado permanecem inconclusivos.
- Perda/critério de encerramento geram decisão com evidência rastreável.
- candidate_for_review não produz escrita de config, ordem ou alteração de gate.
- Mudança de hipótese cria histórico novo; não reescreve experimento anterior.

## Entrega

- Artefato decisório legível e schema versionado com testes de transição.
- Estado com resultado técnico e pendências reais de política/operação.
- Exemplo negativo, inconclusivo e candidato para revisão.

## Limite do bloco

Sem autorização presumida de capital real ou obrigação de “achar” um vencedor.
Microcapital e qualquer novo gate de mandato BTC pertencem à RFC-040.
