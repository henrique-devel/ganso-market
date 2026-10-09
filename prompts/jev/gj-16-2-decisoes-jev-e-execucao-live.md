---
id: GJ16.2
macro: GJ16
part: 2
depends_on: ["GJ16.1","GJ03.4","GJ06.3","GJ13.3"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE15
context: checkpoint-da-entrega
---

# GJ16.2 — Decisões JEV e execução live

Checkpoint de [JE15 — Runtime live integrado](entregas/je-15-runtime-live-integrado.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ16.2 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ16.2 e GJ16.1, GJ03.4, GJ06.3, GJ13.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [decisao jev e supervisao independente](../../docs/PRD-GANSO-JEV.md#decisao-jev-e-supervisao-independente); [execucao e protecao](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/api/src/storage/jev-worker-store.ts](../../apps/api/src/storage/jev-worker-store.ts)
  - [apps/api/src/models/jev-decision-contract.ts](../../apps/api/src/models/jev-decision-contract.ts)
  - [apps/api/src/venues/hyperliquid/live-execution.ts](../../apps/api/src/venues/hyperliquid/live-execution.ts)
  - [apps/api/src/storage/jev-live-store.ts](../../apps/api/src/storage/jev-live-store.ts)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Conectar a conta live ativa ao dispatch JEV e aplicar abrir/manter/fechar usando o adaptador real. Reutilizar contexto, manifesto, reserva de custo e respostas originais; nunca executar live pelo broker paper. Dimensionamento continua determinístico pelo risco, separado da escolha JEV.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] Dispatch comporta três pares paper/stress e um único live, preservando isolamento e orçamento medido. Lote do perfil pode incluir paper/stress/live até o limite contratual de três participantes; cada participante tem estado e vínculo próprios.
- [ ] Cadências e gatilhos versionados permanecem 60s e 2s somente quando admissível com posição aberta. Resposta obsoleta, custo desconhecido, pausa, bloqueio ou lease vencida impedem entrada também na conclusão da decisão e na fronteira de envio.
- [ ] Entrada post-only ALO passa por reservas, precisão, exposição, stop e tolerância já aprovados; maker rejeitado não vira taker. Após 2s do ACK, cancelar/reconciliar restante sem completar parcial.
- [ ] Saída IOC reduce-only usa quantidade residual reconciliada e limites já aprovados. Timeout/ACK/perda de resposta não viram fill nem flat, nem autorizam reenvio cego.
- [ ] Request cobrado uma vez no ledger real JEV; cada conta participante recebe atribuição conservadora integral. Custos/decisões ficam ligados ao binding e versão vigentes, sem reinferir replay.

## Verificação

Decisão real do contrato com provider/wire controlados, sete contas, lote de três, reserva/limite concorrentes, decisão stale, ALO rejeitada, parcial, cancel/fill e envio de resultado incerto. Calcular custos esperados independentemente.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ16.2 somente após verificar todos os aceites; no grupo, continue e consolide JE15/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.
