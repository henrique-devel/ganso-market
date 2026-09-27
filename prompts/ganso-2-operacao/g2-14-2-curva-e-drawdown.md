---
id: G2-14.2
macro: G2-14
rfc: RFC-053
section: S4
depends_on: [G2-14.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-14.2 — Calcular curva, PnL aberto e drawdown

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S4 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s4), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Relatório calcula patrimônio e drawdown em períodos com exposição, com incerteza explícita.

Consumir o histórico versionado no corte de replay. Substituir indisponibilidade genérica após qualquer exposição por cálculos sustentados nas observações. Distinguir drawdown observado na cadência de captura de extremo intrabar não observado. Ajustar fluxos de capital, separar custo de trading e operacional e não debitar slippage já no fill novamente. Posição aberta exige marca válida no corte; gaps tornam o trecho/métrica incompleto. Preservar leitores de datasets antigos e seus campos null; não inventar passado.

## Contexto de código

- `apps/api/src/storage/metrics.ts`
- `apps/api/src/trading/metrics.ts`
- `apps/api/src/storage/replay-dataset.ts`
- `apps/api/src/btc-metrics-cli.ts`
- `apps/api/test/trading/metrics.test.ts`
- `docs/contracts/btc-metrics-v1.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Exemplos manuais com pico, perda, recuperação, short, patrimônio zero/negativo, funding tardio, fluxo externo e lacuna. Mesmo dataset produz mesmos números. Testar evolução de schema e ausência de acesso ao provedor nas leituras.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

API/CLI afetados; nenhuma mudança da política-base. Validar relatório com uma captura disponível e declarar limitações de amostra, sem fabricação de performance.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-14.2** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
