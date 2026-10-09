---
id: GJ18.2
macro: GJ18
part: 2
depends_on: ["GJ18.1","GJ17.3","GJ10.2"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE17
context: checkpoint-da-entrega
---

# GJ18.2 — Snapshot live de execução, proteção e decisões

Checkpoint de [JE17 — Painel financeiro e operacional live](entregas/je-17-painel-financeiro-e-operacional-live.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ18.2 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ18.2 e GJ18.1, GJ17.3, GJ10.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [painel e operacao](../../docs/PRD-GANSO-JEV.md#painel-e-operacao); [dados capacidade e recuperacao](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/api/src/storage/jev-panel.ts](../../apps/api/src/storage/jev-panel.ts)
  - [apps/api/src/storage/jev-promotion.ts](../../apps/api/src/storage/jev-promotion.ts)
  - [apps/api/src/jev-panel-api.ts](../../apps/api/src/jev-panel-api.ts)
  - [apps/api/src/storage/jev-live-store.ts](../../apps/api/src/storage/jev-live-store.ts)
  - [packages/contracts/src/trading/jev-panel.ts](../../packages/contracts/src/trading/jev-panel.ts)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Publicar snapshot owner-scoped consistente e limitado com fontes live: posição, ordens/recibos, fills, proteção, controles e decisões. Adaptar contratos compartilhados de forma compatível; fonte e indisponibilidade devem ser explícitas.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] Ordens/fills live vêm dos eventos/recibos reconciliados da venue, com IDs, parcial, cancel, IOC residual e evidência; consulta ao journal paper não preenche campos live.
- [ ] Proteção mostra posição efetiva, quantidade protegida, confirmação nativa, estado pendente/falha, fonte e timestamp; ausência de confirmação nunca aparece como protegido.
- [ ] Decisões apresentam probabilidades, modelo/manifesto/versão, latência, motivo e vínculo à conta/perfil corretos. Snapshot inclui pausa/emergência, runtime/capability e gates sem inventar estado.
- [ ] GET é read-only, sem criação de conta, pin, admissão, recibo ou observação financeira. Snapshot preserva isolamento/transação consistente e limites de tempo/linhas; histórico tem paginação delimitada quando necessária.
- [ ] Payload não inclui segredo, chave ou material de assinatura; consultas owner-scoped e respostas no-store preservam auth/perímetro. Informação insuficiente retorna motivo, não falso zero/flat.

## Verificação

PostgreSQL real: fonte live versus paper, owner divergente, limite de queries/linhas, snapshot durante novo fill, fonte stale, leitura repetida sem writes e compatibilidade dos consumidores API/web.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ18.2 somente após verificar todos os aceites; no grupo, continue e consolide JE17/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.
