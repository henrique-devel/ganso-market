---
id: GJ13.1
macro: GJ13
part: 1
depends_on: ["GJ09.3","GJ04.3"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE13
context: checkpoint-da-entrega
---

# Preparar fronteira autenticada do adaptador live

Checkpoint **GJ13.1** da entrega [JE13 — Adaptador live e proteção nativa](entregas/je-13-adaptador-live-e-protecao-nativa.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ13.1, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ13.1 e GJ09.3, GJ04.3 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ13 Adaptador live e proteção nativa](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj13-adaptador-live-e-protecao-nativa) do plano.
- Seções do PRD: [Produto e contas](../../docs/PRD-GANSO-JEV.md#produto-e-contas); [Execução e proteção](../../docs/PRD-GANSO-JEV.md#execucao-e-protecao); [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [apps/api/src/venues/hyperliquid/public.ts](../../apps/api/src/venues/hyperliquid/public.ts)
- [apps/api/src/config.ts](../../apps/api/src/config.ts)
- [apps/api/src/storage/ledger-contract.ts](../../apps/api/src/storage/ledger-contract.ts)
- [packages/contracts/src/trading/types.ts](../../packages/contracts/src/trading/types.ts)
- [apps/api/package.json](../../apps/api/package.json)

## Resultado e limite

Criar adaptador autenticado separado do público/paper, com contratos live versionados, identidades de ambiente/conta, signing protegido, IDs e nonce ownership. Revalidar SDK/API oficiais. Novos módulos são propostos, não código já existente. Credencial nunca entra no frontend/log/fixture; nenhuma submissão é liberada por encontrar chave.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Modo/ambiente explícitos e desabilitados por padrão.
- Contrato de conta live preserva patrimônio duradouro e atribuição de perfil.
- Nenhuma chave descoberta habilita executor ou bypassa gate.

## Verificação

Fixtures do transporte/signing boundary, ambiente incorreto, configuração ausente e colisão de IDs/nonces; sem ordem real. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar adaptador e contratos desativados para operação. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ13.1 no estado somente após verificar seu aceite. Na execução de JE13, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
