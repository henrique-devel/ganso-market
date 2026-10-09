---
id: GJ17.1
macro: GJ17
part: 1
depends_on: ["GJ10.3","GJ16.4"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE16
context: checkpoint-da-entrega
---

# GJ17.1 — Controles live persistentes e autenticados

Checkpoint de [JE16 — Pausa e emergência live](entregas/je-16-pausa-e-emergencia-live.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ17.1 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ17.1 e GJ10.3, GJ16.4 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [painel e operacao](../../docs/PRD-GANSO-JEV.md#painel-e-operacao); [risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/api/src/storage/jev-operator.ts](../../apps/api/src/storage/jev-operator.ts)
  - [apps/api/src/jev-panel-api.ts](../../apps/api/src/jev-panel-api.ts)
  - [apps/api/src/storage/jev-live-store.ts](../../apps/api/src/storage/jev-live-store.ts)
  - [apps/api/src/venues/hyperliquid/live-auth.ts](../../apps/api/src/venues/hyperliquid/live-auth.ts)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Estender comandos do operador para a conta live ativada, mantendo auth, same-origin/CSRF, idempotência e isolamento por proprietário. Persistir a trava de entradas e intenção de emergência sob o mesmo ownership usado por decisão/envio.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] Pausa/emergência pode selecionar explicitamente live ou todas as contas admitidas/ativadas do proprietário; o escopo all inclui live e informa essa inclusão. Nenhum comando admite ou ativa conta.
- [ ] Comando duplicado reaproveita intenção/recibo; mesma chave com payload diferente retorna conflito. Estado e auditoria sobrevivem a restart e à sucessão.
- [ ] Pausa trava entradas antes de responder accepted; gate revalida controle na conclusão JEV e imediatamente antes de enviar entrada. Emergência mantém essa trava e solicita encerramento durável.
- [ ] Não disponibilizar chave de assinatura ou segredo em query/body/HTTP; controles preservam sessão, perímetro, CSRF e respostas no-store. Outro proprietário/conta não ativada é rejeitado.
- [ ] Accepted/duplicate indica intenção recebida, não flat. Controles não limpam drawdown/HWM, rearme global, capital ou elegibilidade; retomada não acontece por restart/sucessão.

## Verificação

PostgreSQL com locks concorrentes, repetição/perda de resposta, chave conflitante, auth/CSRF/origin, owner divergente e comando recebido entre avaliação JEV e envio. Verificar consultas e chamadas da fronteira.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ17.1 somente após verificar todos os aceites; no grupo, continue e consolide JE16/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.
