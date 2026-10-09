---
id: GJ16.1
macro: GJ16
part: 1
depends_on: ["GJ06.2","GJ13.1","GJ14.2"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE15
context: checkpoint-da-entrega
---

# GJ16.1 — Admissão, configuração e ownership live

Checkpoint de [JE15 — Runtime live integrado](entregas/je-15-runtime-live-integrado.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ16.1 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ16.1 e GJ06.2, GJ13.1, GJ14.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [produto e contas](../../docs/PRD-GANSO-JEV.md#produto-e-contas); [risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/api/src/execution-worker.ts](../../apps/api/src/execution-worker.ts)
  - [apps/api/src/config.ts](../../apps/api/src/config.ts)
  - [apps/api/src/venues/hyperliquid/live-adapter.ts](../../apps/api/src/venues/hyperliquid/live-adapter.ts)
  - [apps/api/src/venues/hyperliquid/live-auth.ts](../../apps/api/src/venues/hyperliquid/live-auth.ts)
  - [apps/api/src/storage/jev-promotion.ts](../../apps/api/src/storage/jev-promotion.ts)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Implementar o carregamento explícito da identidade/signer e a construção do adaptador no entrypoint implantado, sob ownership e fencing persistentes. Reutilizar a identidade/admissão de JE13–JE14; nenhuma conta, ativação ou credencial é criada por boot. Preservar o modo paper dos serviços e delimitar a configuração live do executor.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] Configuração ausente/inválida, identidade divergente, ambiente incorreto ou ativação humana ausente impedem envios; a publicação e o boot padrão permanecem sem assinatura/ordens.
- [ ] Signer vem apenas do mecanismo de segredo protegido do servidor; chave não aparece em Git, banco, logs, fixtures, chat ou frontend. Testes usam identidades artificiais.
- [ ] Uma conta live total, isolated 1x e US$250 iniciais; vínculos e patrimônio contínuos, sem elevar caps. Lease/generation obsoleta não autoriza chamadas de escrita à venue.
- [ ] Capability/readiness distingue adaptador existente de runtime conectado. Entradas reais ficam impedidas até pausa/emergência JE16 e painel JE17 estarem integrados e verificados; esse gate não impede publicar JE15 desativado.
- [ ] Boot/restart não admite paper, não altera HOLD/risco e não habilita signer. Recuperação de piloto já ativado respeita seu estado persistido, sem exigir uma nova ativação em todo boot.

## Verificação

Boot real com flags ausentes/fechadas, segredo inválido artificial, troca de identidade/ambiente, dois workers e perda de lease; assertar zero chamadas de assinatura/envio quando fechado. Testar a construção do adaptador pelo entrypoint, além do factory isolado.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ16.1 somente após verificar todos os aceites; no grupo, continue e consolide JE15/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.
