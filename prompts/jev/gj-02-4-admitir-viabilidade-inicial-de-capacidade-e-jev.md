---
id: GJ02.4
macro: GJ02
part: 4
depends_on: ["GJ00.2","GJ02.3"]
operational_gates: []
mode: diagnostico
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE03
context: checkpoint-da-entrega
---

# Admitir viabilidade inicial de capacidade e JEV

Checkpoint **GJ02.4** da entrega [JE03 — Retenção e viabilidade](entregas/je-03-retencao-e-viabilidade.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ02.4, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ02.4 e GJ00.2, GJ02.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ02 Manifestos contexto retenção e orçamento](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj02-manifestos-contexto-retencao-e-orcamento) do plano.
- Seções do PRD: [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/btc/collector.ts](../../apps/api/src/btc/collector.ts)
- [apps/api/src/storage/operational-readiness.ts](../../apps/api/src/storage/operational-readiness.ts)
- [docs/runbooks/btc-postgres-capacity.md](../../docs/runbooks/btc-postgres-capacity.md)
- [docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md)

## Resultado e limite

Estimar três pares, modo rápido, corpus protegido de 90d e 180d após encerramento com fixtures e preço documentado. Revalidar recursos disponíveis e diferentes tetos SQL/coletor. Delimitar gates e carga máxima a confirmar em runtime/JEV real; não confundir estimativa com consumo/latência medidos. Resolver contenção reversível autorizada; sem compra, limpeza genérica ou aumento de quota.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Estimativa rastreável e gates explícitos para admissão real.
- Orçamento agregado US$8 operacional/US$2 geração, infraestrutura fora do resultado da estratégia.
- Indisponibilidade de credencial/capacidade bloqueia ativação, preservando entrega técnica independente.

## Verificação

Leituras de recursos e estimativas reproduzíveis; carga apenas em ambiente descartável delimitado. Nenhuma chamada paga nesta estimativa. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar limites/diagnóstico e documentação; manter operação nova desabilitada. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ02.4 no estado somente após verificar seu aceite. Na execução de JE03, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
