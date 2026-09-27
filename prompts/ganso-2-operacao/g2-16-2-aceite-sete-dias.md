---
id: G2-16.2
macro: G2-16
rfc: RFC-053
section: S6
depends_on: [G2-16.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-16.2 — Concluir o aceite de sete dias de estabilidade

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S6 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s6), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Veredito operacional baseado na janela efetivamente observada.

Ao retornar, ler telemetria da janela, deploys, interrupções, contabilidade, dados, capacidade, custos e jornadas. Exigir sete dias consecutivos sem reinício inesperado ou divergência; falhas externas/gaps precisam estar registrados e não podem produzir fills falsos. Medir CPU/latência pela série, não fotografia. Conferir piso/reserva de disco e projeção de 90 dias, custo total conhecido e pendências de G2-13.4. Se janela insuficiente, registrar observing e próximo instante mínimo; se falhar, preservar intervalo e causa, corrigir o delta em subbloco e iniciar outra janela explicitamente. Não substituir esse resultado pelas datas antigas de outubro.

## Contexto de código

- `docs/PRD-GANSO-2.0.md`
- `docs/runbooks/btc-collector.md`
- `docs/runbooks/btc-baseline-runtime.md`
- `docs/runbooks/btc-recovery.md`
- `docs/roadmap/GANSO_2_EXECUTION_STATE.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Tabela curta dos critérios na linha/nota do acompanhamento, com aprovado, desconhecido ou falhou. Sete dias vazios de coleta não aprovam operação. Jev ausente permite aceite do núcleo paper, mas deve permanecer ausente na conclusão.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Consulta/documentação, sem novo deploy quando nada mudou. Declarar pronto operacional apenas se todos os critérios aplicáveis passarem; não aguardar o prazo em loop.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-16.2** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
