---
id: GJ16.3
macro: GJ16
part: 3
depends_on: ["GJ16.2","GJ06.1","GJ13.2","GJ13.4"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE15
context: checkpoint-da-entrega
---

# GJ16.3 — Proteção, reconciliação e recuperação live

Checkpoint de [JE15 — Runtime live integrado](entregas/je-15-runtime-live-integrado.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ16.3 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ16.3 e GJ16.2, GJ06.1, GJ13.2, GJ13.4 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento); [execucao e protecao](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [dados capacidade e recuperacao](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/api/src/execution-worker.ts](../../apps/api/src/execution-worker.ts)
  - [apps/api/src/venues/hyperliquid/live-protection.ts](../../apps/api/src/venues/hyperliquid/live-protection.ts)
  - [apps/api/src/venues/hyperliquid/live-reconcile.ts](../../apps/api/src/venues/hyperliquid/live-reconcile.ts)
  - [apps/api/src/storage/jev-live-store.ts](../../apps/api/src/storage/jev-live-store.ts)
  - [apps/api/src/storage/jev-pilotstore.ts](../../apps/api/src/storage/jev-pilotstore.ts)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Integrar os ciclos contínuos de proteção, posição/ordens/fills/funding e recuperação ao worker, independentes de JEV e API. Reutilizar o supervisor existente e persistir toda evidência financeira original necessária à reconstrução.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] Primeiro parcial instala e confirma proteção nativa reduce-only para a posição efetiva; quantidade protegida acompanha novos fills/reduções. Falha bloqueia entrada, cancela restante maker e solicita redução sem esperar JEV.
- [ ] Risco, proteção e reconciliação continuam com JEV indisponível/lento, orçamento JEV esgotado ou entradas pausadas. Cadência e budgets seguem o contrato existente, com teste de starvation.
- [ ] Fees, funding assinado, posições e ordens são reconciliados com IDs/timestamps originais e deduplicação. Gap/stale divergente bloqueia entrada e qualificação, sem fabricar frescor ou sobrescrever ledger.
- [ ] Restart/takeover reconstrói ordens, reservas, stop, resíduos e pendências a partir do banco e da venue antes de novas entradas. Submission incerta é reconciliada, sem repetir ordem por timeout.
- [ ] Perda diária, drawdown/HWM, primeiro fill e máximo de 6h não são reiniciados; redução concorrente com stop/emergência nunca abre posição oposta. Shutdown impede novas entradas e mantém proteção nativa.

## Verificação

Provider JEV travado, parcial antes/depois de cancel, stop recusado, funding tardio/duplicado, fonte stale, crash depois do envio e antes do recibo, dois workers/takeover e reconstrução financeira em PostgreSQL descartável.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ16.3 somente após verificar todos os aceites; no grupo, continue e consolide JE15/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.

