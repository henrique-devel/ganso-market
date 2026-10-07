---
id: GJ08.1
macro: GJ08
part: 1
depends_on: ["GJ07.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE09
context: checkpoint-da-entrega
---

# Contar episódios e medir cobertura real

Checkpoint **GJ08.1** da entrega [JE09 — Avaliação contínua](entregas/je-09-avaliacao-continua.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ08.1, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ08.1 e GJ07.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ08 Avaliador prospectivo e estados](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj08-avaliador-prospectivo-e-estados) do plano.
- Seções do PRD: [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/baseline-periods.ts](../../apps/api/src/storage/baseline-periods.ts)
- [apps/api/src/storage/operational-readiness.ts](../../apps/api/src/storage/operational-readiness.ts)
- [apps/api/src/storage/equity-history.ts](../../apps/api/src/storage/equity-history.ts)
- [apps/api/src/storage/metrics.ts](../../apps/api/src/storage/metrics.ts)

## Resultado e limite

Definir episódio desde abertura até posição integralmente encerrada, contando parciais como a mesma operação. Implementar denominador de cobertura de dados independente do número de chamadas JEV e revelar gaps internos, fontes e disponibilidade. Não reaproveitar bordas de 15min como prova de 99%. Preservar event-time/receive-time e recorte original.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- 59 versus 60 episódios tem resultado correto.
- Dobrar inferências não aumenta cobertura artificialmente.
- Lacuna financeira irrecuperável é identificada e não some por restart.

## Verificação

Trajetórias com múltiplos fills, zero posição, mudanças UTC, gaps dentro de slots e fontes stale. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar episódios/qualidade com versão; nenhum gate habilita live nesta sessão. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ08.1 no estado somente após verificar seu aceite. Na execução de JE09, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
