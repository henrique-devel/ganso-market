---
id: JE16
mode: entrega-agrupada
checkpoints: ["GJ17.1","GJ17.2","GJ17.3"]
depends_on: ["JE11","JE15"]
operational_gates: ["Qualificação GJ12.3", "Validação da venue GJ13.5", "Elegibilidade e ato inicial autenticado do operador", "JE15–JE17 integradas antes de entradas reais"]
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: entrega-com-checkpoints
---

# JE16 — Pausa e emergência live

Execute integralmente **JE16**, incluindo todos os checkpoints abaixo, até revisão, PR, merge e publicação aplicável. Avance dentro do grupo sem novo pedido. Encerre após esta entrega, salvo sequência expressamente selecionada. Preparar este prompt não inicia implementação.

## Resultado e dependências

Aplicar pausa e emergência autenticadas à conta real, com trava durável na fronteira de envio e conclusão observada pelo worker e painel.

**Depende de código:** JE11, JE15. Confirme contratos integrados ou comprovados na base; os `depends_on` por checkpoint continuam obrigatórios. Dependências internas podem ser validadas na mesma branch. Preserve trabalho alheio e reaproveite aceites existentes.

Esta entrega fecha uma das três lacunas documentadas no [plano complementar](../../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md); não substitui os aceites históricos JE01–JE14.

## Autorização e contexto

A [autorização JEV](../../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre alterações, migrations aditivas, branch `codex/`, commit/push, PR/correções, merge após revisão/checks/proteções e implantação seletiva do escopo selecionado, sem reconfirmação por checkpoint. Compra, aporte, ativação inicial live/signer pelo agente e alteração dos limites permanecem fora desse fluxo.

Leia uma vez o [protocolo](../00-protocolo.md), a emenda de autorização, o plano complementar e as linhas deste grupo/seus IDs no [estado](../../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). Abra os checkpoints conforme avança e somente as seções/símbolos indicados. Confirme main, base, schema e runtime atuais; a auditoria de 09/10/2026 não certifica revisões posteriores.

## Checkpoints na ordem interna

1. [GJ17.1 — Controles live persistentes e autenticados](../gj-17-1-controles-live-persistentes-e-autenticados.md)
2. [GJ17.2 — Cancelamento e encerramento live pelo worker](../gj-17-2-cancelamento-e-encerramento-live-pelo-worker.md)
3. [GJ17.3 — Painel de intervenção live e fluxo integrado](../gj-17-3-painel-de-intervencao-live-e-fluxo-integrado.md)

Teste cada comportamento crítico quando implementado, corrija falhas antes da parte dependente e continue no grupo. Dimensione pela fronteira funcional, sem teto de arquivos/migrations. Se precisar dividir por compatibilidade, registre a continuação e mantenha o grupo aberto; não habilitar stub nem declarar aceite parcial concluído.

## Verificação integrada

Validar comando autenticado até bloqueio do signer, cancelamento, IOC residual e confirmação reconciliada, incluindo concorrência com JEV/fill/stop, resposta perdida e restart.

Reaproveite as suítes e adicione testes de comportamento necessários ao delta, sem espelhar implementação. SQL exige PostgreSQL descartável. No fechamento, execute `make verify`, `make test-postgres` e checks obrigatórios da base/PR/main, incluindo integração Compose. Não repetir a suíte completa entre checkpoints sem novo motivo; não pular revisão, testes ou proteções.

## Publicação e gates operacionais

Prepare preferencialmente um PR coerente para o grupo; revise contratos, diff, segredos e compatibilidade, acompanhe checks, corrija, faça merge e publique seletivamente. Anexe todo PR criado à tarefa e confira versão, saúde, persistência e proteções. Reversão usa código compatível, pausa entradas e preserva proteção/reconciliação; não apaga ledger nem desfaz migrations aplicadas.

Publique desativado enquanto faltarem gates. Entradas reais exigem **JE15–JE17 integradas**, qualificação observada, validação da venue, elegibilidade atual, capacidade/cobertura/custos válidos e ato inicial autenticado do operador. Configuração de signer não pode virar ativação por boot. Controles/proteção de um piloto previamente autorizado não dependem de novo JEV para reduzir risco.

GJ12.2/GJ12.3/GJ13.5/GJ15.1–3 permanecem etapas separadas; não executá-las por selecionar esta entrega. Fixtures não aprovam sete dias, 60 episódios, testnet ou 90 dias. Não comprar créditos, depositar, recuperar coletor ou iniciar agendamento por consequência.

## Fechamento e retomada

Atualize somente JE16 e seus checkpoints verificados no estado, com PR/SHA, validação resumida e publicação/gates pendentes. O mesmo PR/SHA pode cobrir vários IDs. Preserve os estados JE01–JE14 e etapas operacionais.

Se interrompido, registre base/branch, IDs validados, delta, falhas e próximo checkpoint na linha existente, sem relatório/recibo extra. Sem delta, registre reaproveitamento e não crie PR vazio. Relate resultado, validações e publicação/bloqueio observado; encerre após o escopo selecionado.
