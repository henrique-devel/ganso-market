---
id: G2-13.2
macro: G2-13
rfc: RFC-053
section: S3
depends_on: [G2-13.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-13.2 — Validar a jornada manual paper ponta a ponta

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S3 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s3), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Uma operação simulada legítima percorre ticket, execução, saída e extrato no ambiente ativo.

Conferir dono, conta manual, dados atuais, funding e reconciliação. Percorrer interface autenticada: prévia, envio dentro dos caps existentes, aceitação/recusa, execução com livro posterior, cancelamento aplicável, fechamento e extrato. Repetir intenção em resposta ambígua sem duplicar ordem. Corrigir apenas impedimentos encontrados. Casos forçados de parcial, liquidação e crash ficam em PostgreSQL descartável; não fabricar preço, fill ou sinal produtivo para cumprir checklist. Uma operação paper feita no host torna-se história permanente, inclusive custos/perdas. Se autenticação do operador não estiver disponível, concluir checks independentes e registrar a jornada pendente, sem pedir senha no chat.

## Contexto de código

- `docs/runbooks/btc-manual-ticket.md`
- `apps/web/src/btc-ticket.ts`
- `apps/api/src/trading-commandapi.ts`
- `apps/api/src/storage/desk-commandstore.ts`
- `apps/api/src/storage/desk-consumer.ts`
- `apps/api/test/trading/desk-consumer.pg.test.ts`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Jornada observada e reconciliação de saldo/reserva/posição/taxas/funding; testes de concorrência/retry e isolamento das contas em banco descartável. Não declarar fill se só houve aceite. Zero negociação real e nenhum depósito.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Correções por PR e deploy seletivo se necessárias; operação paper manual dentro do escopo da sessão. Preservar conta, gênese e registros; não limpar operações de validação.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-13.2** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
