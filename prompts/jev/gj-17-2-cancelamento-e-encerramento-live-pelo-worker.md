---
id: GJ17.2
macro: GJ17
part: 2
depends_on: ["GJ17.1","GJ16.3"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE16
context: checkpoint-da-entrega
---

# GJ17.2 — Cancelamento e encerramento live pelo worker

Checkpoint de [JE16 — Pausa e emergência live](entregas/je-16-pausa-e-emergencia-live.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ17.2 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ17.2 e GJ17.1, GJ16.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [execucao e protecao](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/api/src/execution-worker.ts](../../apps/api/src/execution-worker.ts)
  - [apps/api/src/venues/hyperliquid/live-execution.ts](../../apps/api/src/venues/hyperliquid/live-execution.ts)
  - [apps/api/src/venues/hyperliquid/live-protection.ts](../../apps/api/src/venues/hyperliquid/live-protection.ts)
  - [apps/api/src/venues/hyperliquid/live-reconcile.ts](../../apps/api/src/venues/hyperliquid/live-reconcile.ts)
  - [apps/api/src/storage/jev-operator.ts](../../apps/api/src/storage/jev-operator.ts)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Consumir a intenção persistida pelo worker com fencing. Pausa cancela entradas pendentes e conserva posição protegida; emergência cancela entradas e reduz a posição restante por IOC até confirmação reconciliada, sem depender de resposta JEV.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] Pausa cancela resting/maker e reservas conforme recibos; continua funding/risco/stop/reconciliação e pode manter posição protegida. Não fabricar cancel de ordem com estado incerto.
- [ ] Emergência reconsulta quantidade efetiva após cancel/fills e solicita IOC reduce-only limitada ao residual. Falta de liquidez mantém pendência explícita e tentativas delimitadas pelo contrato, sem nova exposição.
- [ ] Stop nativo permanece enquanto houver posição/resíduo/incerteza; sua remoção e conclusão só ocorrem após posição zero e ausência de ordens/reservas pendentes confirmadas.
- [ ] JEV indisponível, API fora do ar, resposta de comando perdida e restart não interrompem a intenção. Fencing/idempotência impedem dois workers de duplicar redução.
- [ ] Comando concorrente com stop, cancel, novo parcial ou sucessão não aumenta exposição nem abre posição oposta; pausas não são eliminadas ao mudar o perfil.

## Verificação

Cenários integrados de fill tardio após cancel, IOC parcial/timeout, stop simultâneo, JEV pendurado, falha de venue e takeover. Conferir estado pendente versus final confirmado, com quantidades calculadas independentemente.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ17.2 somente após verificar todos os aceites; no grupo, continue e consolide JE16/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.

