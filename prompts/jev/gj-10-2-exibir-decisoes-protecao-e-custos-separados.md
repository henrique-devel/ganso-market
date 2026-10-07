---
id: GJ10.2
macro: GJ10
part: 2
depends_on: ["GJ10.1"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE11
context: checkpoint-da-entrega
---

# Exibir decisões proteção e custos separados

Checkpoint **GJ10.2** da entrega [JE11 — Painel e prontidão](entregas/je-11-painel-e-prontidao.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ10.2, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ10.2 e GJ10.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ10 Painel do operador](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj10-painel-do-operador) do plano.
- Seções do PRD: [Painel e operação](../../docs/PRD-GANSO-JEV.md#painel-e-operacao); [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/web/src/Experiments.tsx](../../apps/web/src/Experiments.tsx)
- [apps/web/src/BtcOperations.tsx](../../apps/web/src/BtcOperations.tsx)
- [apps/web/src/btc-desk.css](../../apps/web/src/btc-desk.css)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)

## Resultado e limite

Adicionar tape de decisão, versão, probabilidades diagnósticas/latência e motivo; ordens/fills/posição e estado real da proteção. Criar subgrupo de custos JEV, infraestrutura manual e despesa real total, distinguindo cobrança única de custo avaliativo por conta. Registro manual de infraestrutura usa backend autenticado/idempotente e não altera resultado.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Operador entende o que ocorreu automaticamente e o que está pendente.
- Infra nunca entra em hurdle/PnL da estratégia.
- Resumo JEV capturado não é apresentado como fatura completa se houver lacuna.

## Verificação

Estados known/unknown, requests compartilhados, erro provider, proteção sem ACK e componentes responsivos; teste de gravação manual autorizado. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar backend/web compatíveis e verificar leitura/escrita autenticada; sem fatura automática ou mensagem externa. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ10.2 no estado somente após verificar seu aceite. Na execução de JE11, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
