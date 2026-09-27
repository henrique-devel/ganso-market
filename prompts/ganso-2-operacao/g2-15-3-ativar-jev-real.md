---
id: G2-15.3
macro: G2-15
rfc: RFC-053
section: S5
depends_on: [G2-13.4, G2-14.5, G2-15.2]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-15.3 — Ativar e validar a comparação Jev real

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S5 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s5), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Challenger real registrado prospectivamente e primeira resposta auditável dentro da cobertura disponível.

Exigir gate atual de dados/capacidade/contabilidade e baseline apta; falta de candidato/trade por mercado não é falha de infraestrutura. Conferir janela comum e horizonte de entradas antes de registrar a conta. Instalar configuração e chave protegidas, provisionar orçamento somente coberto e executar registro pelo mecanismo existente/adaptado. Uma gênese de US$1.000 independente conforme contrato original; sem transferir da baseline nem somar cenários. Validar uma chamada real limitada pelo mesmo caminho de reserva/custo, com origem/modelo/input/resposta/deadline. Se for probe sem candidato, rotular explicitamente como diagnóstico e excluí-lo das decisões econômicas, mantendo custo; nunca fabricar ordem ou resposta histórica. Não esperar 30 dias para ativar.

## Contexto de código

- `docs/runbooks/btc-jev-activation.md`
- `apps/api/src/challenger-activate-cli.ts`
- `apps/api/src/storage/challenger-operations.ts`
- `apps/api/src/storage/challenger-runtime.ts`
- `apps/api/src/storage/jevstore.ts`
- `apps/api/src/trading-readapi.ts`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Resposta real e custo conferidos; integração elegível preserva direção/tamanho/saídas. Timeout, orçamento e resposta inválida são exercitados com mocks, sem consumir crédito para fabricar falhas. Saídas continuam com Jev desligado. Account ready, chamada real, allow, ordem e fill são aceites distintos.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Restart seletivo da API e ativação paper só com credencial/cobertura efetivas. Se faltarem, manter desativado e marcar parte pronta versus ativação bloqueada, sem declarar 100% com Jev. Ausência Jev não bloqueia G2-16/17 no escopo baseline; registrar essa opção.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-15.3** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
