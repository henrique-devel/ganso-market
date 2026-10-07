---
id: GJ03.1
macro: GJ03
part: 1
depends_on: ["GJ02.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE04
context: checkpoint-da-entrega
---

# Definir escolhas JEV e vínculo por conta

Checkpoint **GJ03.1** da entrega [JE04 — Decisão JEV integrada](entregas/je-04-decisao-jev-integrada.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ03.1, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ03.1 e GJ02.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ03 Decisões JEV lotes e custos reais](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj03-decisoes-jev-lotes-e-custos-reais) do plano.
- Seções do PRD: [Decisão JEV e supervisão independente](../../docs/PRD-GANSO-JEV.md#decisao-jev-e-supervisao-independente).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/models/jev-contract.ts](../../apps/api/src/models/jev-contract.ts)
- [apps/api/src/models/jev-typesafe.ts](../../apps/api/src/models/jev-typesafe.ts)
- [apps/api/src/storage/challenger-runtime.ts](../../apps/api/src/storage/challenger-runtime.ts)

## Resultado e limite

Criar contrato de direção long/short e intenção open/hold/close, perguntas por conta dentro do perfil, versão de modelo/perguntas e esquema de resposta. Cada pergunta vincula conta/posição/corte explicitamente; IDs não isolam state. Escolhas válidas não têm gate de confiança. Validar ação compatível com posição e distinguir erro localizado de erro no binding/lote.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Sem dependência de candidato baseline.
- Conta diferente recebe interpretação própria; binding ambíguo invalida lote.
- Nenhuma resposta controla tamanho, risco ou proteção.

## Verificação

Fixtures de schema, respostas válidas/contraditórias, distribuição diagnóstica, conta sem posição e pergunta mal vinculada. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar contratos/validador e manter transporte de negociação novo desativado. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ03.1 no estado somente após verificar seu aceite. Na execução de JE04, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
