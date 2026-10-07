---
id: GJ04.1
macro: GJ04
part: 1
depends_on: ["GJ02.2","GJ01.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE05
context: checkpoint-da-entrega
---

# Aplicar limites persistentes por conta

Checkpoint **GJ04.1** da entrega [JE05 — Risco e dimensionamento](entregas/je-05-risco-e-dimensionamento.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ04.1, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ04.1 e GJ02.2, GJ01.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ04 Supervisor de risco e tamanho](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj04-supervisor-de-risco-e-tamanho) do plano.
- Seções do PRD: [Risco e dimensionamento](../../docs/PRD-GANSO-JEV.md#risco-e-dimensionamento).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/trading/risk.ts](../../apps/api/src/trading/risk.ts)
- [apps/api/src/storage/riskstore.ts](../../apps/api/src/storage/riskstore.ts)
- [apps/api/src/storage/reservationstore.ts](../../apps/api/src/storage/reservationstore.ts)

## Resultado e limite

Versionar política para US$250, risco 1%, exposição 50%, diário 2% e DD fixo US$12,50 desde pico observado. Persistir dia UTC, HWM e pausas; funding/fees/aberto entram no patrimônio de negociação, JEV/infra não. Não editar resultados ou policy v1 para fingir nova banca.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Rollover diário não zera HWM/DD.
- Pausa cancela aumentos e permite reduzir; retorno diário só com flat/reconciliado/fresco.
- Limite DD permanece em dólar ao subir patrimônio.

## Verificação

Risk fixtures e SQL com fronteiras, funding concorrente, restart, rollover, US$250→270 e perda de US$12,50 do pico. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar política/checkpoint novos sem rearmar contas históricas ou piloto. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ04.1 no estado somente após verificar seu aceite. Na execução de JE05, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
