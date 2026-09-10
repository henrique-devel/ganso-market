---
id: GATE-01
rfc: RFC-040
depends_on: [EXP-01]
mode: read-only
---

# GATE-01 — mandato experimental BTC sem alterar gates legados

Siga [00-protocolo.md](00-protocolo.md); confira apenas a linha GATE-01 e EXP-01
em `docs/roadmap/BTC_EXECUTION_STATE.md`.

## Objetivo

Escrever a matriz de requisitos do experimento BTC, distinguindo demonstração
técnica, evidência econômica e decisões de capital ainda não tomadas.

## Leitura mínima

- `docs/rfcs/RFC-040-experimento-btc-e-progressao-de-capital.md`: §§1–3.
- `docs/rfcs/RFC-009-polymarket-live-execution.md`: pré-condições e gates.
- `docs/rfcs/RFC-013-polymarket-portfolio-engine.md`: seção de gates.
- `apps/api/src/polymarket/portfolio/gates.ts`: condições efetivas G1–G6.
- `config/portfolio.json`: limites e gatilhos atuais.
- Recibo EXP-01 e artefato de protocolo experimental nele indicado.

## Entrega pequena

Proponha `docs/roadmap/BTC_MANDATE.md` (novo, até 120 linhas) com universo,
US$1.000 paper, versões, comparação com controle e critérios de corte definidos
antes dos resultados. Para cada gate atual: finalidade, evidência técnica,
critério de paper e eventual mudança normativa separada.

Não escolher banca real, trocar 60 dias por número arbitrário, exigir macro apenas
para atingir duas categorias, nem chamar teste sintético de evento real observado.
Incerteza e critério não aplicável devem ter motivos distintos.

## Aceite e limite

Revisão documental cobre candidato lucrativo com falha contábil, candidato saudável
sem N, e mínimo da venue maior que ticket. Nenhum caso recebe aprovação implícita.
Não editar config de risco, registro de modelos, reports antigos ou runtime.

Registre recibo/estado. GATE-02 poderá implementar o relatório; não o execute agora.
