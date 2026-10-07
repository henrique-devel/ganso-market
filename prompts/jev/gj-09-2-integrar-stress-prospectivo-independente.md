---
id: GJ09.2
macro: GJ09
part: 2
depends_on: ["GJ09.1"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE10
context: checkpoint-da-entrega
---

# Integrar stress prospectivo independente

Checkpoint **GJ09.2** da entrega [JE10 — Perfis simultâneos](entregas/je-10-perfis-simultaneos.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ09.2, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ09.2 e GJ09.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ09 Pares simultâneos e reservas](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj09-pares-simultaneos-e-reservas) do plano.
- Seções do PRD: [Produto e contas](../../docs/PRD-GANSO-JEV.md#produto-e-contas); [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [Qualificação e avaliação contínua](../../docs/PRD-GANSO-JEV.md#qualificacao-e-avaliacao-continua).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/desk-worker.ts](../../apps/api/src/storage/desk-worker.ts)
- [apps/api/src/storage/brokerstore.ts](../../apps/api/src/storage/brokerstore.ts)
- [apps/api/src/storage/passivestore.ts](../../apps/api/src/storage/passivestore.ts)
- [apps/api/src/storage/fundingstore.ts](../../apps/api/src/storage/fundingstore.ts)

## Resultado e limite

Rodar stress próprio por perfil com capital US$250, latência 2s e taxas de negociação duplicadas, mantendo mesmos limites e regras. Estado/posição/funding/sizing próprios e respostas JEV próprias quando divergir do paper; reunir no mesmo lote de perfil quando ambos precisarem decidir. Registrar evidência prospectiva, sem gerar resultado stress apenas reexecutando o paper.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Uma conta não empresta saldo, posição ou resposta à outra.
- Custo do lote aparece inteiro na avaliação de cada participante.
- Fechamento e qualificação contam separadamente nos dois cenários.

## Verificação

Trajetórias que divergem por parcial/latência/fees, funding e erro localizado; SQL de isolamento e reproof. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar pares completos, mas admissão de carga real segue GJ09.3/GJ12.1. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ09.2 no estado somente após verificar seu aceite. Na execução de JE10, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
