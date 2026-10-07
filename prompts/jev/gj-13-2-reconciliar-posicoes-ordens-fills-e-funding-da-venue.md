---
id: GJ13.2
macro: GJ13
part: 2
depends_on: ["GJ13.1","GJ07.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE13
context: checkpoint-da-entrega
---

# Reconciliar posições ordens fills e funding da venue

Checkpoint **GJ13.2** da entrega [JE13 — Adaptador live e proteção nativa](entregas/je-13-adaptador-live-e-protecao-nativa.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ13.2, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ13.2 e GJ13.1, GJ07.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ13 Adaptador live e proteção nativa](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj13-adaptador-live-e-protecao-nativa) do plano.
- Seções do PRD: [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/venues/hyperliquid/public.ts](../../apps/api/src/venues/hyperliquid/public.ts)
- [apps/api/src/storage/recoverystore.ts](../../apps/api/src/storage/recoverystore.ts)
- [apps/api/src/storage/ledgerstore.ts](../../apps/api/src/storage/ledgerstore.ts)
- [apps/api/src/storage/fundingstore.ts](../../apps/api/src/storage/fundingstore.ts)

## Resultado e limite

Implementar leitura autenticada/associação do piloto e journal de estado observado da venue, fills, fees, funding e recibos, com replay/ownership. Tratar lacunas/stale/paginações e estados incertos. Distinguir settlement real de aproximação paper. No restart, reconciliar posição/ordens/proteções antes de admitir entrada.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Recibo/fill/funding duplicados não duplicam saldo.
- Estado remoto desconhecido nunca vira flat/saldo zero.
- Sem modificar eventos antigos para conciliar; divergência vira pendência explícita.

## Verificação

Fixtures/SQL de fill parcial/tardio, paginação, recebimento fora de ordem, crash e taxa/funding reais. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar leitores/conciliador desativados para submissão; consultas reais somente com acesso e identidade válidos. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ13.2 no estado somente após verificar seu aceite. Na execução de JE13, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
