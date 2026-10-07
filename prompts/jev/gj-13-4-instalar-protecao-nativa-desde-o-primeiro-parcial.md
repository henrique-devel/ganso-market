---
id: GJ13.4
macro: GJ13
part: 4
depends_on: ["GJ13.3","GJ06.1"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE13
context: checkpoint-da-entrega
---

# Instalar proteção nativa desde o primeiro parcial

Checkpoint **GJ13.4** da entrega [JE13 — Adaptador live e proteção nativa](entregas/je-13-adaptador-live-e-protecao-nativa.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ13.4, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ13.4 e GJ13.3, GJ06.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ13 Adaptador live e proteção nativa](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj13-adaptador-live-e-protecao-nativa) do plano.
- Seções do PRD: [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)
- [apps/api/src/storage/baseline-exits.ts](../../apps/api/src/storage/baseline-exits.ts)
- [apps/api/src/venues/hyperliquid/public.ts](../../apps/api/src/venues/hyperliquid/public.ts)

## Resultado e limite

Implementar SL market mark-trigger por posição desde primeiro parcial, separado de filhos da ordem de entrada. Revalidar tolerance/campos/estados atuais, preservar reserva integral 10% no sizing e reconciliar quantidade/proteção durante fills/cancel. Falta de confirmação bloqueia entrada, cancela restante e solicita IOC sem JEV; pending não vira flat.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Cancelar maker não remove proteção da posição parcial.
- Triggered não é filled; quantidade residual permanece conciliada.
- Stop/IOC simultâneos não abrem oposto nem duplicam close.

## Verificação

Fixtures de parent cancel/partial, SL não confirmado, outage, trigger sem fill e restart; validar contratos oficiais. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar proteção/controlador live desativados; nenhum teste com capital real por esta entrega. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ13.4 no estado somente após verificar seu aceite. Na execução de JE13, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
