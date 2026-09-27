---
id: G2-15.2
macro: G2-15
rfc: RFC-053
section: S5
depends_on: [G2-15.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-15.2 — Entregar configuração e ciclo de orçamento Jev

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S5 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s5), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Provisionamento, rotação e reconciliação do orçamento são seguros, explícitos e testados.

Preparar template sem segredo e procedimento de mounts somente leitura na API para /etc/ganso/jev/config.json e /run/secrets/jev_api_key, com owner/permissões compatíveis com o usuário real do container. Entregar/validar comando protegido de provisionamento para mês UTC, hash de tarifa, cobertura, limite e circuito. Tratar virada de mês, expiração de tarifa, revogação, custos incertos e falhas sem apagar reservas. Sem recarga ou renovação paga implícita. Se necessário adequar o atestado de limite, preservar limite rígido demonstrável com garantias reais do provedor, reserva antes de HTTP e falha fechada; não remover a proteção só para aceitar uma chave. Credencial/configuração válidas não habilitam consultas sem registro explícito.

## Contexto de código

- `apps/api/src/models/jev-config.ts`
- `apps/api/src/models/jev.ts`
- `apps/api/src/storage/jevstore.ts`
- `apps/api/src/storage/challenger-operations.ts`
- `apps/api/test/trading/jev.pg.test.ts`
- `docs/runbooks/btc-jev-activation.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

PG/fixtures mock: concorrência no teto, mês vencido, mudança de modelo/tarifa, restart após reserva, cobrança incerta, rotação e circuito. Testar que nenhum segredo aparece em logs, UI, comandos ou repositório. Com config ausente/desligada, resto da API continua.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Código/template podem ser entregues sem acesso real. Montagem/provisionamento só quando cobertura e autorização de consumo estiverem explicitamente disponíveis; não cria compra. Nenhuma chamada real nesta fatia.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-15.2** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
