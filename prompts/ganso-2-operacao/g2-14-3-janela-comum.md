---
id: G2-14.3
macro: G2-14
rfc: RFC-053
section: S4
depends_on: [G2-13.3, G2-14.2]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-14.3 — Comparar baseline e Jev com inícios diferentes

**Adaptação de escopo — 28/09:** entregar cortes/janelas BTC e comparadores
genéricos sem exigir conta, chamada ou ativação JEV. A comparação com challenger
abaixo é compatibilidade futura, verificável por fixtures. A avaliação produtiva
atual é baseline versus referências BTC/caixa, conforme [escopo](../../docs/SCOPE.md).

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S4 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s4), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Comparação prospectiva usa uma janela comum sem alterar gêneses ou fingir capital/risco iguais.

Resolver a incompatibilidade entre início próprio do challenger e comparação inception-to-cut com starts iguais. Definir corte comum futuro antes de observar resultados, patrimônio/posição/reservas de abertura, versões e fim comum. Carregar eventos anteriores apenas para reconstruir estado inicial; atribuir PnL, custos e funding à janela sem perder obrigações antigas. Capital/risco diferentes permitem lado a lado e motivo; não habilitar delta causal artificial. Vincular ao comparison_start_at registrado e ao período fonte que ainda aceita entradas por toda a avaliação; tratar expiração por G2-13.3. Nunca retroagir Jev, resetar baseline ou selecionar a posteriori o trecho mais favorável.

## Contexto de código

- `apps/api/src/storage/metrics.ts`
- `apps/api/src/storage/replaystore.ts`
- `apps/api/src/challenger-activate-cli.ts`
- `apps/api/src/experiments-api.ts`
- `apps/api/test/trading/experiments.test.ts`
- `docs/contracts/btc-jev-challenger-v1.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

PG/fixtures de baseline iniciada antes da variante, posição atravessando início/fim, fluxo externo, funding atrasado, custos, janela sem sobreposição e versões diferentes. Comparação válida deixa de cair em COMPARISON_WINDOW_OR_CONTRACT; casos incompatíveis continuam recusados/rotulados.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Contratos/API/CLI e registro prospectivo compatíveis; nenhum novo capital ou ativação Jev. Preparar o contrato exato de janela para G2-15.3 e avaliação G2-17.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-14.3** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
