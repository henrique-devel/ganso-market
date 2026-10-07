---
id: GJ10.1
macro: GJ10
part: 1
depends_on: ["GJ09.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE11
context: checkpoint-da-entrega
---

# Exibir perfis PnL e limites

Checkpoint **GJ10.1** da entrega [JE11 — Painel e prontidão](entregas/je-11-painel-e-prontidao.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ10.1, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ10.1 e GJ09.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ10 Painel do operador](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj10-painel-do-operador) do plano.
- Seções do PRD: [Painel e operação](../../docs/PRD-GANSO-JEV.md#painel-e-operacao); [Resultados e custos](../../docs/PRD-GANSO-JEV.md#resultados-e-custos).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/web/src/App.tsx](../../apps/web/src/App.tsx)
- [apps/web/src/Experiments.tsx](../../apps/web/src/Experiments.tsx)
- [apps/web/src/BtcDesk.tsx](../../apps/web/src/BtcDesk.tsx)
- [apps/api/src/experiments-api.ts](../../apps/api/src/experiments-api.ts)

## Resultado e limite

Construir visão principal por perfil e conta com PnL realizado/aberto/taxas/funding/JEV, estado de avaliação e limites diário/global. Distinguir fake/real e risco/PnL; não somar bancos alternativos. Usar DTOs existentes ou extensões compatíveis, com terminologia clara e details sob demanda.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Mesmos números nos cards, tabelas e gráficos.
- Vazio/stale/custo desconhecido não aparecem como lucro/zero confirmado.
- Live indisponível/sem ativação é visível sem botão que opere por engano.

## Verificação

Testes de estados do usuário e inspeção visual com trajetórias positivas/negativas, parcial, bloqueio e dados ausentes. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar API/web seletivamente; verificar bundle, auth e DTO; não admitir operação por UI saudável. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ10.1 no estado somente após verificar seu aceite. Na execução de JE11, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
