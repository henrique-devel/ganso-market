---
id: G2-17.1
macro: G2-17
rfc: RFC-053
section: S7
depends_on: [G2-14.5, G2-16.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-17.1 — Verificar cobertura da janela econômica prospectiva

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S7 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s7), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Amostra econômica auditável, com janelas ausentes e custos contabilizados.

Usar período/manifesto já fixados antes dos resultados em G2-13.4/14.3/15.3; este prompt não escolhe novo início depois de olhar lucro. Avaliação pode acumular durante os sete dias e não precisa esperar G2-16.2 para começar. Reunir cerca de 30 dias e pelo menos 2.736/2.880 janelas elegíveis segundo o manifesto vigente, distinguindo sem sinal de falta de dado. Validar cobertura dos chunks, equity, funding, custos operacionais, versão e benchmarks. Se Jev existir, usar só respostas capturadas e sua janela comum; se não existir, avaliar baseline/caixa/BTC sem inventar variante. Preservar todo período original e explicar qualquer campanha sucessora registrada prospectivamente.

## Contexto de código

- `config/trading/baseline.json`
- `docs/contracts/btc-baseline-manifest-v1.md`
- `apps/api/src/btc-replay-cli.ts`
- `apps/api/src/btc-metrics-cli.ts`
- `apps/api/src/storage/metrics.ts`
- `docs/roadmap/GANSO_2_EXECUTION_STATE.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Reconciliar total de janelas, decisões, ordens, fills, episódios e dias; não contar eventos correlacionados como amostras independentes. Custos/desconhecidos/gaps permanecem no resultado. Duração suficiente com poucos trades pode continuar inconclusiva.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Runner sob demanda, com limites e capacidade atuais. Se faltarem dias/cobertura, observing com critério de retorno; sem automação Codex não solicitada, espera longa ou retuning da estratégia.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-17.1** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
