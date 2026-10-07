---
id: GJ05.2
macro: GJ05
part: 2
depends_on: ["GJ05.1","GJ02.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE06
context: checkpoint-da-entrega
---

# Implementar cotação chegada e fila maker

Checkpoint **GJ05.2** da entrega [JE06 — Execução e proteção](entregas/je-06-execucao-e-protecao.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ05.2, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ05.2 e GJ05.1, GJ02.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ05 Execução maker e IOC integradas](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj05-execucao-maker-e-ioc-integradas) do plano.
- Seções do PRD: [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading/passive.ts](../../apps/api/src/trading/passive.ts)
- [apps/api/src/storage/passivestore.ts](../../apps/api/src/storage/passivestore.ts)
- [apps/api/src/storage/passive-contract.ts](../../apps/api/src/storage/passive-contract.ts)
- [apps/api/src/venues/hyperliquid/metadata.ts](../../apps/api/src/venues/hyperliquid/metadata.ts)

## Resultado e limite

Implementar preço um incremento válido dentro do spread, fallback no próprio melhor preço e rejeição post-only ao cruzar na chegada. Aplicar latência antes de aceitar e 2s de espera após ACK. Usar fila/trades observados e fees por parciais; incerteza de prioridade é explícita. Emitir evento/estado de primeira parcial para a proteção futura.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Tocar preço ou atualizar book não fabrica fill.
- ACK/chegada/validade não são confundidos.
- Parcial preserva quantidade e fee; sem top-up.

## Verificação

Maker long/short, spread mínimo, book stale/desconhecido, prints insuficientes, parciais e fee acumulada; PostgreSQL para persistência. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar maker novo inativo para admissão automática até cancel/saída e proteção integrados. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ05.2 no estado somente após verificar seu aceite. Na execução de JE06, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
