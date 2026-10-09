---
id: GJ17.3
macro: GJ17
part: 3
depends_on: ["GJ17.2","GJ14.2"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE16
context: checkpoint-da-entrega
---

# GJ17.3 — Painel de intervenção live e fluxo integrado

Checkpoint de [JE16 — Pausa e emergência live](entregas/je-16-pausa-e-emergencia-live.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ17.3 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ17.3 e GJ17.2, GJ14.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [painel e operacao](../../docs/PRD-GANSO-JEV.md#painel-e-operacao).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/web/src/JevPanel.tsx](../../apps/web/src/JevPanel.tsx)
  - [apps/web/src/JevLive.tsx](../../apps/web/src/JevLive.tsx)
  - [apps/api/src/storage/jev-panel.ts](../../apps/api/src/storage/jev-panel.ts)
  - [packages/contracts/src/trading/jev-panel.ts](../../packages/contracts/src/trading/jev-panel.ts)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Expor pausa/emergência live no painel, com seleção e impacto claros, estados derivados do worker e tratamento de resposta perdida. Preservar ativação inicial/rearme global como ações distintas e os contratos existentes.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] Conta live ativada aparece como destino dos controles; opção all identifica contas reais/fictícias afetadas. Pausa e emergência explicam efeito sobre entradas, posição e avaliação.
- [ ] Exibir recebido, cancelando, redução pendente, protegido, conclusão reconciliada ou indisponível conforme evidência. ACK e HTTP 200 nunca são apresentados como posição encerrada.
- [ ] Cliques duplicados/retry reaproveitam a chave do comando; falha de resposta permite recuperar seu resultado sem duplicar ordens. Refresh/restart mantém estado persistido.
- [ ] Sem botão de trade manual, aporte, edição de estratégia ativa ou desbloqueio implícito. Não acrescentar retomada automática ou botão que limpe pausa/bloqueio; eventual novo fluxo de retomada exige contrato próprio.
- [ ] UI/API/worker passam por integração real do comando com transporte controlado; a proteção permanece funcionando durante a intervenção e a interface não mostra segredos.

## Verificação

Backend SQL/API e navegador: seleção live/all, duplo clique, CSRF, resposta perdida, restart, posição parcial, comando pendente e confirmação flat. Atualizar capability/readiness somente com o fluxo implementado.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ17.3 somente após verificar todos os aceites; no grupo, continue e consolide JE16/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.

