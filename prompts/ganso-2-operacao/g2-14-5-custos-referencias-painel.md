---
id: G2-14.5
macro: G2-14
rfc: RFC-053
section: S4
depends_on: [G2-14.2, G2-14.3, G2-14.4, G2-13.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-14.5 — Completar custos, referências e painel de avaliação

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S4 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s4), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Painel permite avaliar contas, janela e custos com fontes e limitações visíveis.

Integrar curva/drawdown, janela comum, cobertura paginada e motivos. Conectar referência caixa e BTC perpétuo passivo de 25% com preço/fee/funding e janela compatíveis; separar spot se existir, sem adicionar nova estratégia. Entregar entrada validada/versionada de custos reais e rateio sem anexar faturas privadas ao Git. Falta de fatura ou custo incerto permanece desconhecido, não zero; valor reservado Jev não é custo liquidado. Mostrar risco/capital/exposição diferentes sem sugerir causalidade. Reaproveitar telemetria de G2-13.1 e autenticação; GET não gera dataset, cobra API ou altera saldo.

## Contexto de código

- `apps/api/src/experiments-api.ts`
- `apps/api/src/storage/metrics.ts`
- `apps/api/src/trading/metrics.ts`
- `apps/api/src/btc-metrics-cli.ts`
- `apps/web/src`
- `docs/contracts/btc-metrics-v1.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

UI/API: conta sem trades, posição aberta, gap, período incompleto, challenger ausente, real/mock, custo ausente e custo alocado uma vez. Benchmark e comparação usam a mesma janela. Conferir jornada autenticada quando disponível e PG com leitura sem mutação.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Deploy seletivo API/web/gateway conforme rotas. Publicar código pode concluir antes de receber fatura; custo completo permanece condição do aceite econômico, registrado no estado.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-14.5** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
