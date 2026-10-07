---
id: GJ01.1
macro: GJ01
part: 1
depends_on: ["GJ00.2"]
operational_gates: []
mode: codigo
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE02
context: checkpoint-da-entrega
---

# Versionar contratos de perfis e contas

Checkpoint **GJ01.1** da entrega [JE02 — Contratos e manifestos](entregas/je-02-contratos-e-manifestos.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ01.1, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ01.1 e GJ00.2 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ01 Contratos de contas perfis e capital](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj01-contratos-de-contas-perfis-e-capital) do plano.
- Seções do PRD: [Produto e contas](../../docs/PRD-GANSO-JEV.md#produto-e-contas); [Autoridade e decisões substituídas](../../docs/PRD-GANSO-JEV.md#autoridade-e-decisoes-substituidas).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [packages/contracts/src/trading/types.ts](../../packages/contracts/src/trading/types.ts)
- [packages/contracts/src/trading/validation.ts](../../packages/contracts/src/trading/validation.ts)
- [packages/contracts/src/trading/index.ts](../../packages/contracts/src/trading/index.ts)
- [apps/api/src/trading/identity.ts](../../apps/api/src/trading/identity.ts)

## Resultado e limite

Localizar validadores/exports reais antes de editar. Introduzir contrato versionado para perfil, versão, conta paper/stress e identidade financeira duradoura do piloto, com vínculo imutável às decisões/operações. Diferenciar modo declarado de executor habilitado. Manter v1 legível e definir entradas/saídas consumíveis pelas próximas sessões.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Dono/modo/versão incompatíveis são rejeitados.
- Três pares e um live único são representáveis sem somar bancas fictícias.
- Contrato live não instancia signer ou habilita submissão.

## Verificação

Testes de contratos e validação de exemplos válidos/inválidos, compatibilidade com fixtures v1 e precisão monetária. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar contratos compatíveis, com recursos novos inativos; sem migration aplicada nesta fatia. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ01.1 no estado somente após verificar seu aceite. Na execução de JE02, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
