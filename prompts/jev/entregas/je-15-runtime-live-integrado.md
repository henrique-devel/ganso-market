---
id: JE15
mode: entrega-agrupada
checkpoints: ["GJ16.1","GJ16.2","GJ16.3","GJ16.4"]
depends_on: ["JE07","JE13","JE14"]
operational_gates: ["Qualificação GJ12.3", "Validação da venue GJ13.5", "Elegibilidade e ato inicial autenticado do operador", "JE15–JE17 integradas antes de entradas reais"]
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
context: entrega-com-checkpoints
---

# JE15 — Runtime live integrado

Execute integralmente **JE15**, incluindo todos os checkpoints abaixo, até revisão, PR, merge e publicação aplicável. Avance dentro do grupo sem novo pedido. Encerre após esta entrega, salvo sequência expressamente selecionada. Preparar este prompt não inicia implementação.

## Resultado e dependências

Conectar o adaptador live ao processo efetivamente publicado, com admissão persistida, decisões JEV, proteção/reconciliação independentes e continuidade após restart.

**Depende de código:** JE07, JE13, JE14. Confirme contratos integrados ou comprovados na base; os `depends_on` por checkpoint continuam obrigatórios. Dependências internas podem ser validadas na mesma branch. Preserve trabalho alheio e reaproveite aceites existentes.

Esta entrega fecha uma das três lacunas documentadas no [plano complementar](../../../docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md); não substitui os aceites históricos JE01–JE14.

## Autorização e contexto

A [autorização JEV](../../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco) cobre alterações, migrations aditivas, branch `codex/`, commit/push, PR/correções, merge após revisão/checks/proteções e implantação seletiva do escopo selecionado, sem reconfirmação por checkpoint. Compra, aporte, ativação inicial live/signer pelo agente e alteração dos limites permanecem fora desse fluxo.

Leia uma vez o [protocolo](../00-protocolo.md), a emenda de autorização, o plano complementar e as linhas deste grupo/seus IDs no [estado](../../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). Abra os checkpoints conforme avança e somente as seções/símbolos indicados. Confirme main, base, schema e runtime atuais; a auditoria de 09/10/2026 não certifica revisões posteriores.

## Checkpoints na ordem interna

1. [GJ16.1 — Admissão, configuração e ownership live](../gj-16-1-admissao-configuracao-e-ownership-live.md)
2. [GJ16.2 — Decisões JEV e execução live](../gj-16-2-decisoes-jev-e-execucao-live.md)
3. [GJ16.3 — Proteção, reconciliação e recuperação live](../gj-16-3-protecao-reconciliacao-e-recuperacao-live.md)
4. [GJ16.4 — Promoção, sucessão e integração do runtime](../gj-16-4-promocao-sucessao-e-integracao-do-runtime.md)

Teste cada comportamento crítico quando implementado, corrija falhas antes da parte dependente e continue no grupo. Dimensione pela fronteira funcional, sem teto de arquivos/migrations. Se precisar dividir por compatibilidade, registre a continuação e mantenha o grupo aberto; não habilitar stub nem declarar aceite parcial concluído.

## Verificação integrada

Exercitar o entrypoint real com PostgreSQL e wire/provider controlados: boot desativado, piloto previamente ativado em fixture, primeiro parcial, cancel/fill concorrentes, queda de JEV, takeover e sucessão sem duplicar ordem ou reiniciar patrimônio.

Reaproveite as suítes e adicione testes de comportamento necessários ao delta, sem espelhar implementação. SQL exige PostgreSQL descartável. No fechamento, execute `make verify`, `make test-postgres` e checks obrigatórios da base/PR/main, incluindo integração Compose. Não repetir a suíte completa entre checkpoints sem novo motivo; não pular revisão, testes ou proteções.

## Publicação e gates operacionais

Prepare preferencialmente um PR coerente para o grupo; revise contratos, diff, segredos e compatibilidade, acompanhe checks, corrija, faça merge e publique seletivamente. Anexe todo PR criado à tarefa e confira versão, saúde, persistência e proteções. Reversão usa código compatível, pausa entradas e preserva proteção/reconciliação; não apaga ledger nem desfaz migrations aplicadas.

Publique desativado enquanto faltarem gates. Entradas reais exigem **JE15–JE17 integradas**, qualificação observada, validação da venue, elegibilidade atual, capacidade/cobertura/custos válidos e ato inicial autenticado do operador. Configuração de signer não pode virar ativação por boot. Controles/proteção de um piloto previamente autorizado não dependem de novo JEV para reduzir risco.

GJ12.2/GJ12.3/GJ13.5/GJ15.1–3 permanecem etapas separadas; não executá-las por selecionar esta entrega. Fixtures não aprovam sete dias, 60 episódios, testnet ou 90 dias. Não comprar créditos, depositar, recuperar coletor ou iniciar agendamento por consequência.

## Fechamento e retomada

Atualize somente JE15 e seus checkpoints verificados no estado, com PR/SHA, validação resumida e publicação/gates pendentes. O mesmo PR/SHA pode cobrir vários IDs. Preserve os estados JE01–JE14 e etapas operacionais.

Se interrompido, registre base/branch, IDs validados, delta, falhas e próximo checkpoint na linha existente, sem relatório/recibo extra. Sem delta, registre reaproveitamento e não crie PR vazio. Relate resultado, validações e publicação/bloqueio observado; encerre após o escopo selecionado.

