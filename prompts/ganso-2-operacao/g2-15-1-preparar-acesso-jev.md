---
id: G2-15.1
macro: G2-15
rfc: RFC-053
section: S5
depends_on: [G2-11.1]
authorization: continuous-with-operational-gates
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-15.1 — Preparar acesso, tarifa e cobertura Jev

**Adiado por decisão de 28/09/2026.** JEV é evolução futura conforme [escopo vigente](../../docs/SCOPE.md). Não executar esta sessão no marco BTC atual; o contrato abaixo só se aplica após seleção futura explícita.

Execute somente esta sessão. Leia o [protocolo](00-protocolo.md), o contrato comum e a [seção S5 da RFC-053](../../docs/rfcs/RFC-053-ganso-2-prontidao-operacional.md#s5), e sua linha no [estado único](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). Consulte o [roadmap](../../docs/roadmap/GANSO_2_OPERATIONAL_ROADMAP.md) somente para dependência ou decisão concreta. Não reler todo o histórico.

## Entrega

Checklist concreto de configuração com acesso/custo verificados ou lacuna específica identificada.

Esta preparação fica adiada até seleção futura explícita. Consultar documentação oficial atual TypeSafe e o adaptador existente. Conferir acesso do proprietário, presença segura da credencial, versão fixada, tarifa, validade, cobrança de erros e limite total faturável. Não imprimir nem pedir chave/senha no chat. O requisito atual de atestado de teto por tentativa não está comprovado apenas por contexto máximo; obter evidência ou especificar em G2-15.2 um mecanismo verificável equivalente de controle de custo. Conferir consumo coberto e orçamento total com host/impostos/IA; US$5 é teto proposto, não crédito. Não supor que crédito promocional renova. Registrar somente referências não sensíveis e itens faltantes.

## Contexto de código

- `apps/api/src/models/jev-contract.ts`
- `apps/api/src/models/jev-config.ts`
- `apps/api/src/models/jev-typesafe.ts`
- `docs/contracts/btc-jev-adapter-v1.md`
- `docs/runbooks/btc-jev-activation.md`
- `docs/runbooks/single-server.md`

Os caminhos são pontos de entrada, não autorização para refatorar tudo. Localize a versão atual antes de inferir ausência; leia 3–6 arquivos relevantes e amplie somente por necessidade demonstrada.

## Validação

Confrontar contrato HTTP/modelo/preço com fontes oficiais e implementação; indicar o que foi conferido e o que depende da conta do proprietário. Sem chamadas pagas, compra, cadastro automático ou preenchimento de atestado fictício.

Execute testes proporcionais e checks obrigatórios. SQL financeiro usa PostgreSQL descartável; fixtures não comprovam produção, estabilidade ou desempenho econômico.

## Entrega e limites operacionais

Preparação/documentação apenas. Se faltarem acesso/decisão de consumo, deixar activation_ready=false; isso não bloqueia baseline nem a avaliação sem Jev. Nenhuma instalação de SDK ou novo serviço é necessária por padrão.

A autorização contínua cobre código → PR → correções/checks → merge → implantação aplicável desta sessão, sem nova confirmação por etapa. Compra, consumo pago ainda não coberto, descarte delimitado, capital e mudança de perímetro dependem da autorização específica aplicável. Prepare o resultado concreto antes de solicitar apenas o que faltar. Criar este prompt não executou nem ativou seu conteúdo.

## Encerramento

Atualize a linha **G2-15.1** no acompanhamento: status, PR/SHA quando houver, validação resumida e deploy/pendência. Atualize o resumo/próxima sessão se necessário; sem recibo ou dossiê obrigatório. Diferencie código pronto, ativação realizada e aceite observado. Não classifique ativação faltante como concluída por haver código. Pare nesta fatia; não inicie outra sessão, agente ou automação.
