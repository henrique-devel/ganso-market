---
id: G2-13.4
macro: G2-13
rfc: RFC-053
section: S3
depends_on: [G2-13.2, G2-13.3]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-13.4 — Retomar a baseline e demonstrar o ciclo automático

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S3 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s3), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Baseline pronta, decisões prospectivas e gestão automática confirmadas sem depender de Jev.

Revalidar capacidade, liveness, reconciliação, funding e histórico de barras (12 horárias e 15 de 15 min no contrato atual). Fixar antes da observação a identidade do período/política e classificação piloto/econômica. Aplicar rearme explícito apenas com precondições satisfeitas, sem apagar âncoras, perdas ou gaps. Confirmar candidato, motivo de abstenção, reserva/ordem quando elegível e saídas por stop/prazo/risco. Não afrouxar limiares para obter trade. Se não houver candidato, registrar prontidão e deixar o aceite de operação automática pendente; não manter a sessão esperando mercado nem declarar ciclo concluído sem execução observada.

## Contexto de código

- `docs/runbooks/btc-baseline-runtime.md`
- `apps/api/src/storage/baseline-runtime.ts`
- `apps/api/src/storage/baseline-exits.ts`
- `apps/api/src/trading/strategies/baseline.ts`
- `apps/api/src/storage/riskstore.ts`
- `apps/api/test/trading/baseline-runtime.pg.test.ts`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Caminho automático integrado long/short/parcial/saída/restart em PostgreSQL descartável; no host observar decisões atuais e, quando ocorram, ordem, fill, saída e reconciliação. Falha após rearme contém entradas e preserva gestão de posições.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Ativação exclusivamente paper e dentro dos caps existentes, conforme sessão selecionada. Registrar período/início/versões e resultado real. Falta de sinal não bloqueia desenvolvimento independente de métricas/Jev, mas permanece requisito do aceite final.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-13.4** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
