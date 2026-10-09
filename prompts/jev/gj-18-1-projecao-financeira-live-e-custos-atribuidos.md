---
id: GJ18.1
macro: GJ18
part: 1
depends_on: ["GJ07.1","GJ07.2","GJ16.4"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE17
context: checkpoint-da-entrega
---

# GJ18.1 — Projeção financeira live e custos atribuídos

Checkpoint de [JE17 — Painel financeiro e operacional live](entregas/je-17-painel-financeiro-e-operacional-live.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ18.1 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ18.1 e GJ07.1, GJ07.2, GJ16.4 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos); [produto e contas](../../docs/PRD-GANSO-JEV.md#produto-e-contas).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/api/src/storage/jev-live-store.ts](../../apps/api/src/storage/jev-live-store.ts)
  - [apps/api/src/storage/jev-metrics.ts](../../apps/api/src/storage/jev-metrics.ts)
  - [apps/api/src/storage/jev-panel.ts](../../apps/api/src/storage/jev-panel.ts)
  - [apps/api/src/storage/jev-pilotstore.ts](../../apps/api/src/storage/jev-pilotstore.ts)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Projetar a contabilidade live a partir de fills, fees, funding e saldo reconciliados da venue, com atribuição JEV por participação/binding. Usar decimal/fixed-point e preservar fonte, unidade, período, versão e qualidade.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] PnL de negociação = realizado + aberto − fees + funding líquido assinado; resultado após JEV desconta a atribuição correspondente. Resultado conservador usa realizado − fees + funding + min(aberto,0) − JEV.
- [ ] Custos desconhecidos/gap/stale tornam campos afetados indisponíveis com motivos e as_of; zero só quando comprovado. Não reutilizar métricas/fills paper como resultados reais.
- [ ] Equity de risco, patrimônio e HWM contínuos vêm do piloto reconciliado; JEV/infra não entram na base dos limites de trading. Separar acumulado da conta e recortes por perfil/versão sem perder histórico.
- [ ] Fatura real JEV registra request uma vez; avaliação atribui lote integral por conta participante, inclusive live. Infra permanece card manual separado e não afeta PnL/aprovação.
- [ ] Capital real e bancas fictícias não são somados; balanços entre sucessores não são novos aportes. Reconciliação e projeção são idempotentes e eventos originais permanecem imutáveis.

## Verificação

Cálculo independente com long/short, fees maker/taker, funding positivo/negativo, PnL aberto negativo/positivo, request compartilhado, custo desconhecido, fill duplicado e sucessão de perfil na mesma conta.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ18.1 somente após verificar todos os aceites; no grupo, continue e consolide JE17/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.
