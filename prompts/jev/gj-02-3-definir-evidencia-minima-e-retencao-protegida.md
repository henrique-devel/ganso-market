---
id: GJ02.3
macro: GJ02
part: 3
depends_on: ["GJ02.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE03
context: checkpoint-da-entrega
---

# Definir evidência mínima e retenção protegida

Checkpoint **GJ02.3** da entrega [JE03 — Retenção e viabilidade](entregas/je-03-retencao-e-viabilidade.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ02.3, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ02.3 e GJ02.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ02 Manifestos contexto retenção e orçamento](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj02-manifestos-contexto-retencao-e-orcamento) do plano.
- Seções do PRD: [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao); [Detalhes a fixar antes dos experimentos](../../docs/PRD-GANSO-JEV.md#detalhes-a-fixar-antes-dos-experimentos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/storage/btc-retention.ts](../../apps/api/src/storage/btc-retention.ts)
- [apps/api/src/trading/retention.ts](../../apps/api/src/trading/retention.ts)
- [apps/api/src/storage/replay-dataset.ts](../../apps/api/src/storage/replay-dataset.ts)
- [apps/api/src/storage/btc-marketstore.ts](../../apps/api/src/storage/btc-marketstore.ts)

## Resultado e limite

Definir e implementar a representação da evidência necessária de decisão/fill/funding/qualidade, incluindo holds e respostas JEV. Dimensionar closure de dependências e prazo de experimento mais 180 dias pós-encerramento; ledger/resultados/versões permanecem. Novos objetos usam envelope versionado; expiração abrange somente dispensáveis não protegidos. Não executar descarte de produção nesta sessão.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Replay necessário continua possível e pins prevalecem.
- Expiração não remove evidência ainda dependida ou ledger.
- Raw irrelevante não é copiado indefinidamente como requisito do novo modelo.

## Verificação

Retenção/replay em PostgreSQL descartável: dependências transitivas, pin, encerramento, expiração e rollback. Medir tamanho de corpus representativo delimitado. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar seletores/escritores compatíveis; preservar HOLD/quotas e dados existentes. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ02.3 no estado somente após verificar seu aceite. Na execução de JE03, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
