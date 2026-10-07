---
id: GJ01.2
macro: GJ01
part: 2
depends_on: ["GJ01.1"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE02
context: checkpoint-da-entrega
---

# Adaptar gênese e replay ao capital explícito

Checkpoint **GJ01.2** da entrega [JE02 — Contratos e manifestos](entregas/je-02-contratos-e-manifestos.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ01.2, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ01.2 e GJ01.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ01 Contratos de contas perfis e capital](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj01-contratos-de-contas-perfis-e-capital) do plano.
- Seções do PRD: [Produto e contas](../../docs/PRD-GANSO-JEV.md#produto-e-contas); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading/ledger.ts](../../apps/api/src/trading/ledger.ts)
- [apps/api/src/storage/ledgerstore.ts](../../apps/api/src/storage/ledgerstore.ts)
- [apps/api/src/storage/ledger-contract.ts](../../apps/api/src/storage/ledger-contract.ts)
- [apps/api/src/storage/replay-dataset.ts](../../apps/api/src/storage/replay-dataset.ts)
- [migrations/0029_btc_account_ledger.sql](../../migrations/0029_btc_account_ledger.sql)

## Resultado e limite

Introduzir capital explícito de US$250 nas contas novas e manter replay das gêneses v1 US$1.000. Separar vida da conta e janela experimental. Atribuir perfil a eventos sem alterar ownership histórico. Se necessário, criar uma migration aditiva compatível; a 0029 serve como referência e não pode ser editada.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Gênese idempotente e resultados antigos preservados.
- Replay v2 respeita capital e dono sem reset em recortes.
- Troca futura de perfil live não fabrica novo depósito de US$250.

## Verificação

Ledger/replay com fixtures independentes; PostgreSQL descartável para duplicação, rollback, ownership e compatibilidade. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Aplicar migration nova antes dos leitores/escritores afetados; publicar ledger/replay sem admitir negociação nova. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ01.2 no estado somente após verificar seu aceite. Na execução de JE02, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
