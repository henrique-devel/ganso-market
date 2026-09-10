---
id: REPLAY-04
rfc: RFC-032
depends_on: [REPLAY-03, DATA-02]
mode: code
---

# REPLAY-04 — Relatório econômico reproduzível

Entregue relatório CLI/artefato dos replays, mantendo resultados legados identificados.
Siga `00-protocolo.md`; use schemas publicados por REPLAY-01..03 no estado.

## Contexto mínimo

- `docs/rfcs/RFC-032-replay-carteira-finita-evidencia.md`: decisão 6 e aceite.
- `apps/api/src/fast-backtest-cli.ts`: formato de saída existente.
- `apps/api/src/shadow-replay-cli.ts`: compatibilidade do relatório legado.
- `apps/api/src/polymarket/paper/performance.ts`: métricas atuais.
- `apps/api/test/polymarket/paper/performance.test.ts`: exemplos de reconciliação.

## Escopo fechado

1. Mostrar dataset/config/execução/custos com hashes, cenário e cobertura.
2. Reconciliar caixa/equity, realizado/não realizado, reservas, taxas,
   drawdown, perda máxima, retorno e capital bloqueado.
3. Separar mercados, oportunidades, ordens, fills e negócios; comparar controle
   no mesmo universo, identificando amostras não pareadas e seus motivos.
   Use classificação central DATA-02 para separar sintéticos, sem apagar linhas.
4. Incentivos observados ficam separados do PnL de negociação; custos fixos
   são conhecidos ou desconhecidos. Desconhecido nunca equivale a zero.
5. Persistir artefato versionado/checksum; saída curta humana e formato máquina.
   Não modificar G1–G6 ou sugerir promoção automática.

## Verificação necessária

- Mesma entrada reproduz ledger e relatório lógico, descontando metadados de execução.
- PnL/custos reconciliam com fixture independente inclusive em perdas.
- Dataset incompleto torna limitações visíveis; não fabricar IC ou receita.
- Cenários negativos aparecem com a mesma estrutura dos positivos.

## Entrega

- Relatório, exemplo pequeno e comando reproduzível sem secrets.
- Estado com interface pronta para EXP-02.
- Evidência de reconciliação e limitações de execução/cobertura.

## Limite do bloco

Sem dashboard novo, treino ou decisão de risco real. Validação estatística
prospectiva pertence à RFC-033; dados legados não recebem esse rótulo.
