---
id: G2-16.1
macro: G2-16
rfc: RFC-053
section: S6
depends_on: [G2-13.4, G2-14.5]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-16.1 — Verificar recuperação e iniciar observação operacional

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S6 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s6), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Falhas/retomada demonstradas e início verificável de uma janela de estabilidade.

Se Jev estiver ativo, exigir G2-15.3; se ausente, declarar escopo baseline. Exercitar desconexão, reinício antes/depois do commit, lease/fence, reservas, saída pendente e recuperação em ambiente apropriado. Cenários destrutivos em banco descartável; produção admite apenas restart seletivo controlado compatível com posições/saídas e sem perda de dados. Conferir que diagnóstico cobre collector, contas e fonte, sem reduzir tudo a /health. Fixar início da janela após o ensaio planejado, condições de interrupção, frequência de amostragem e cobertura esperada. Mudança de release/configuração durante janela fica registrada e exige avaliar comparabilidade. Evidência econômica deve estar pré-registrada, não começa retroativamente no aceite de sete dias.

## Contexto de código

- `docs/runbooks/btc-recovery.md`
- `apps/api/src/storage/recoverystore.ts`
- `apps/api/src/storage/desk-consumer.ts`
- `apps/api/src/storage/challenger-runtime.ts`
- `apps/api/src/experiments-api.ts`
- `docs/PRD-GANSO-2.0.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Zero divergência, nenhuma duplicação financeira, nenhuma entrada com lease/fonte inválidos e saídas preservadas. Recuperação real só é declarada se observada. Se mercado ainda não gerou ciclo automático, conservar essa pendência separada da estabilidade.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Checagem breve e registro no estado; usar telemetria do produto existente. Não criar heartbeat/automação Codex, agendar nova sessão ou ficar em espera por sete dias. Registrar observing e data mínima de retorno.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-16.1** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
