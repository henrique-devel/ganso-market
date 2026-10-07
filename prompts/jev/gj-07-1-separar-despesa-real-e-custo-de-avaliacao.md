---
id: GJ07.1
macro: GJ07
part: 1
depends_on: ["GJ03.4","GJ02.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE08
context: checkpoint-da-entrega
---

# Separar despesa real e custo de avaliação

Checkpoint **GJ07.1** da entrega [JE08 — Contabilidade e referências](entregas/je-08-contabilidade-e-referencias.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ07.1, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ07.1 e GJ03.4, GJ02.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ07 PnL atribuição JEV e benchmarks](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj07-pnl-atribuicao-jev-e-benchmarks) do plano.
- Seções do PRD: [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos); [Detalhes a fixar antes dos experimentos](../../docs/PRD-GANSO-JEV.md#detalhes-a-fixar-antes-dos-experimentos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading/metrics.ts](../../apps/api/src/trading/metrics.ts)
- [apps/api/src/storage/metrics.ts](../../apps/api/src/storage/metrics.ts)
- [apps/api/src/storage/jevstore.ts](../../apps/api/src/storage/jevstore.ts)
- [apps/api/src/btc-metrics-cli.ts](../../apps/api/src/btc-metrics-cli.ts)

## Resultado e limite

Criar contratos separados para cobrança real única, custo avaliativo integral de lote por conta e infraestrutura manual excluída. Não violar conservação da fatura real para imitar custo conservador. Explicitar política de atribuição JEV geração/validação, vinculando à proposta/perfil quando identificável e mantendo incompletude visível até regra completa; não omitir esse custo.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Request faturado uma vez no global e inteiro por participante na avaliação.
- Infra ausente não bloqueia PnL/eligibilidade da estratégia.
- Cobrança desconhecida ou custo sem regra completa não vira zero.

## Verificação

Fixtures/SQL de cobrança compartilhada, uso inválido, custo incerto, geração identificável e conservação do global. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar métricas/contratos compatíveis; a aceitação econômica aguarda atribuição completa e custos conhecidos. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ07.1 no estado somente após verificar seu aceite. Na execução de JE08, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
