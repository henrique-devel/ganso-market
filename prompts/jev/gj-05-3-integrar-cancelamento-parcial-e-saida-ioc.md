---
id: GJ05.3
macro: GJ05
part: 3
depends_on: ["GJ05.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE06
context: checkpoint-da-entrega
---

# Integrar cancelamento parcial e saída IOC

Checkpoint **GJ05.3** da entrega [JE06 — Execução e proteção](entregas/je-06-execucao-e-protecao.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ05.3, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ05.3 e GJ05.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ05 Execução maker e IOC integradas](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj05-execucao-maker-e-ioc-integradas) do plano.
- Seções do PRD: [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/passivestore.ts](../../apps/api/src/storage/passivestore.ts)
- [apps/api/src/storage/brokerstore.ts](../../apps/api/src/storage/brokerstore.ts)
- [apps/api/src/trading/broker.ts](../../apps/api/src/trading/broker.ts)
- [apps/api/src/storage/reservationstore.ts](../../apps/api/src/storage/reservationstore.ts)
- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)

## Resultado e limite

Concluir corrida expiração/cancel/fill e integrar IOC reduce-only com o contrato maker novo. Ao fim dos 2s, cancelar restante e reconciliar fills concorrentes; nova entrada depende de novo JEV válido. Não fechar pelo último preço quando faltam liquidez/frescor. Só remover guards de separação para a versão coberta pelos testes.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Entrada maker e saída IOC coexistem sem inversão, double-fill ou double-fee.
- Quantidade residual permanece pendente; cancelamento não apaga parcial.
- Crash/restart não ressuscita prioridade antiga nem duplica reserva.

## Verificação

SQL real descartável para cancel race, reducing concorrente long/short, book posterior à latência, expiração e falta de liquidez. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar broker integrado e compatível; entrada automática depende ainda de proteção/worker/admissão. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ05.3 no estado somente após verificar seu aceite. Na execução de JE06, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
