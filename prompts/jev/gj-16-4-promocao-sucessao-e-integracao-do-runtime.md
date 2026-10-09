---
id: GJ16.4
macro: GJ16
part: 4
depends_on: ["GJ16.3","GJ14.3","GJ08.3"]
operational_gates: ["Gates existentes antes de operação real", "JE15–JE17 integradas antes de entradas reais"]
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE15
context: checkpoint-da-entrega
---

# GJ16.4 — Promoção, sucessão e integração do runtime

Checkpoint de [JE15 — Runtime live integrado](entregas/je-15-runtime-live-integrado.md). Ao executar a entrega, cumpra este contrato, valide seu aceite e continue no grupo; revisão, PR, checks completos, merge e publicação são consolidados no fechamento. Pedido restrito a GJ16.4 permanece restrito a este contrato.

## Autorização explícita

A [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre implementar/corrigir o escopo selecionado, migrations aditivas, branch `codex/`, commit/push, PR/revisão, merge após checks/proteções e publicação seletiva. Prossiga sem reconfirmar fases. Publicar desativado é permitido; não comprar API/infra, aportar, elevar limites ou executar a ativação inicial de signer/live em nome do operador.

## Contexto mínimo

- Leia uma vez o [protocolo](00-protocolo.md), a emenda e o [plano complementar](../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md).
- Confira GJ16.4 e GJ16.3, GJ14.3, GJ08.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md), sem reler o histórico.
- Seções do PRD: [qualificacao e avaliacao continua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [sucessao e geracao de propostas](../../docs/PRD-GANSO-JEV.md#sucessao-e-geracao-de-propostas).
- Entradas atuais; localizar símbolos e ler somente trechos necessários:
  - [apps/api/src/venues/hyperliquid/live-adapter.ts](../../apps/api/src/venues/hyperliquid/live-adapter.ts)
  - [apps/api/src/venues/hyperliquid/live-succession.ts](../../apps/api/src/venues/hyperliquid/live-succession.ts)
  - [apps/api/src/storage/jev-promotion.ts](../../apps/api/src/storage/jev-promotion.ts)
  - [apps/api/src/storage/jev-pilotstore.ts](../../apps/api/src/storage/jev-pilotstore.ts)
  - [docker-compose.yml](../../docker-compose.yml)

A lista aponta código da base auditada; confirme caminhos/símbolos na base atual. Módulos novos necessários são implementação proposta, não prova de funcionalidade entregue.

## Resultado e limite

Conectar promoção/sucessão ao ciclo real do runtime e fechar a integração da entrega. A API persiste a decisão humana; o worker assume apenas o piloto autorizado e promove sucessora somente pelo contrato aprovado.

Preserve ledger, respostas originais, versões/vínculos, pins, capital, auth/perímetro e trabalho alheio. Detalhes rotineiros de implementação cabem no contrato; mudança de produto/dinheiro não é decisão técnica implícita.

## Aceite

- [ ] Piloto autorizado em fixture percorre o entrypoint até execução/proteção/reconciliação; o deploy padrão percorre o mesmo entrypoint com envios fechados. Testar apenas factories não fecha JE15.
- [ ] Reprovação comprovada conduz a cancelamento, redução e confirmação flat/sem ordens antes da sucessora atualmente elegível. Dados insuficientes/inconclusivos e maior lucro de outra estratégia não causam troca.
- [ ] Uma identidade/conta live e patrimônio/HWM/limites contínuos; sucessão não aporta US$250 novamente, não limpa bloqueio global nem controles de pausa/emergência e não duplica promoção.
- [ ] Capacidade, heartbeats, budgets, estado do executor e motivos de indisponibilidade ficam observáveis e entram na prontidão, sem confundir saúde do processo com admissão operacional.
- [ ] Runbook descreve recuperação/reversão compatíveis e implantação seletiva, com signer/entradas desativados quando gates faltam. GJ12.3/GJ13.5/GJ15.1–3 continuam sem aprovação automática.

## Verificação

Integração Compose com PostgreSQL real e transporte controlado: piloto ativado apenas em fixture, troca válida, candidata rejeitada, IOC residual, restart durante troca, concorrência de promoção e boot de produção desativado.

Execute testes proporcionais durante o checkpoint; SQL usa PostgreSQL descartável, nunca produção. No fechamento do grupo, cumpra `make verify`, `make test-postgres`, revisão e checks obrigatórios PR/main/Compose conforme protocolo. Fixture/teste/deploy não comprovam observação prospectiva.

## Publicação e gates

Consolide publicação na entrega. Código pode ser publicado desativado; entradas reais continuam condicionadas à integração JE15–JE17 e às etapas operacionais existentes, sem selecionar ou aprovar esses gates por este prompt. Nunca executar a ativação humana em nome do operador nem ensaio externo da venue por consequência.

Confira versão/saúde/persistência do delta publicado; reversão preserva proteção/reconciliação, schema e eventos. Não reiniciar coletor, alterar HOLD/quota, apagar protegido ou incluir backup/contratação neste escopo.

## Fechamento

Marque GJ16.4 somente após verificar todos os aceites; no grupo, continue e consolide JE15/IDs cobertos no estado. Registre PR/SHA e validação/gate pendente efetivos. Se incompleto, mantenha aberto e registre delta/falha/próximo checkpoint. Não alterar estados históricos nem executar outra entrega/chat/agente/agendamento automaticamente.
