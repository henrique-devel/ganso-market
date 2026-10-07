---
id: GJ07.3
macro: GJ07
part: 3
depends_on: ["GJ05.3","GJ04.1","GJ02.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE08
context: checkpoint-da-entrega
---

# Construir referências caixa e BTC protegido

Checkpoint **GJ07.3** da entrega [JE08 — Contabilidade e referências](entregas/je-08-contabilidade-e-referencias.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ07.3, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ07.3 e GJ05.3, GJ04.1, GJ02.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ07 PnL atribuição JEV e benchmarks](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj07-pnl-atribuicao-jev-e-benchmarks) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading/metrics.ts](../../apps/api/src/trading/metrics.ts)
- [apps/api/src/trading/passive.ts](../../apps/api/src/trading/passive.ts)
- [apps/api/src/trading/funding.ts](../../apps/api/src/trading/funding.ts)
- [apps/api/src/storage/equity-replay.ts](../../apps/api/src/storage/equity-replay.ts)

## Resultado e limite

Construir trajetória caixa US$250 não remunerados e BTC passivo US$250 com exposição inicial 50%, quantidade fixa, execução/taxas/funding e DD US$12,50 desde pico. Ao gatilho solicita saída e fica em caixa sem reentrada. Usar recortes/convenções comparáveis de paper/stress; não comprar novamente ao início de cada rolling window.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- BTC inclui custo/funding e não usa curva ideal sem execução.
- Sem rebalanceamento e sem reset de risco na janela.
- Referências não reservam capital real nem acumulam patrimônio fictício ao live.

## Verificação

Fixtures de quantidade inicial, saída parcial/gap, pico/drawdown, funding e recortes de janela. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar benchmark/resultado inativos para ordens reais; proteger sua evidência necessária. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ07.3 no estado somente após verificar seu aceite. Na execução de JE08, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
