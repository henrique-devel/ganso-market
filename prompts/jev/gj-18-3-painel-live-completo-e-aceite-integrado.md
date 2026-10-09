---
id: GJ18.3
macro: GJ18
part: 3
depends_on: ["GJ18.2"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE17
context: checkpoint-da-entrega
---

# GJ18.3 — Painel live completo e aceite integrado

Checkpoint de [JE17 — Painel financeiro e operacional live](entregas/je-17-painel-financeiro-e-operacional-live.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ18.3 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ18.3 e GJ18.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [painel e operacao](../../docs/PRD-GANSO-JEV.md#painel-e-operacao); [qualificacao e avaliacao continua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/web/src/JevPanel.tsx](../../apps/web/src/JevPanel.tsx)
  - [apps/web/src/JevLive.tsx](../../apps/web/src/JevLive.tsx)
  - [apps/api/src/storage/jev-panel.ts](../../apps/api/src/storage/jev-panel.ts)
  - [packages/contracts/src/trading/jev-panel.ts](../../packages/contracts/src/trading/jev-panel.ts)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Concluir a apresentação da conta real com métricas e estado operacional verificáveis. Substituir o rótulo fixo REAL · INDISPONÍVEL por status derivado dos dados, preservando indisponibilidade quando ela for verdadeira.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] Operador lê capital real, equity/HWM, PnL realizado/aberto, fees, funding, JEV atribuído e resultado conservador, separados de paper/stress e infraestrutura manual.
- [ ] Posições, ordens/fills, proteção, decisões/latência e pausa/emergência refletem o snapshot; mostrar motivo/horário de indisponibilidade, sem preencher com zero.
- [ ] Acumulado da conta e histórico por perfil/versão continuam corretos após restart/sucessão. Elegibilidade inicial permanece baseada em paper/stress, sem converter lucro live em aprovação automática.
- [ ] Interface mantém limites e ações autenticadas já aprovados, sem dados técnicos/segredos desnecessários. Capital real/fictício e atribuição versus fatura JEV têm rótulos compreensíveis.
- [ ] Integração do entrypoint, API, PostgreSQL e navegador comprova as três lacunas fechadas; capability/readiness libera apenas a condição de código, sem aprovar tempo observado, testnet, orçamento ou ato humano.

## Verificação

Navegador e integração Compose com estado financeiro reconciliado controlado: conta inexistente, ativo/protegido, pausa, emergência, stale, parcial, funding, custo desconhecido, restart e sucessão. Conferir totais esperados independentemente da projeção.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ18.3 somente após verificar todos os aceites; no grupo, continue e consolide JE17/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.
