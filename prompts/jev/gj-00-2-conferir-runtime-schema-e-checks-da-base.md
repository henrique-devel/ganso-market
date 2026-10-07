---
id: GJ00.2
macro: GJ00
part: 2
depends_on: ["GJ00.1"]
operational_gates: []
mode: diagnostico
authorization: alteracoes-pr-merge-producao
tracking: docs/roadmap/GANSO_JEV_EXECUTION_STATE.md
delivery: JE01
context: checkpoint-da-entrega
---

# Conferir runtime schema e checks da base

Checkpoint **GJ00.2** da entrega [JE01 — Base reconciliada](entregas/je-01-base-reconciliada.md). Ao executar a entrega, realize este contrato, valide seu aceite e avance aos próximos checkpoints do grupo. PR, checks completos, merge e publicação são consolidados no fechamento da entrega. Se o proprietário solicitar somente GJ00.2, limite o escopo a este ID.

## Autorização explícita

Você está expressamente autorizado pelo proprietário a **alterar e implementar** o escopo selecionado deste checkpoint ou de sua entrega, criar branch `codex/`, commit/push, **criar e corrigir PR**, revisar o diff, acompanhar os checks obrigatórios, fazer **merge** após aprovação dos checks e proteções, e **publicar em produção** os componentes afetados. Inclui migrations aditivas, configuração e restart seletivo necessários. Prossiga sem pedir nova confirmação por etapa; respeite a [autorização registrada](../../docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco).

Esta autorização não compra API/infra nem aporta capital. Operação real segue os gates e a ativação autenticada inicial do operador; não a execute em nome dele. Publicar código desabilitado está autorizado enquanto os gates estiverem pendentes.

## Contexto mínimo

- Leia o [protocolo](00-protocolo.md) e somente a emenda de autorização acima.
- Consulte a linha GJ00.2 e GJ00.1 no [estado](../../docs/roadmap/GANSO_JEV_EXECUTION_STATE.md); confirme contratos/commits disponíveis sem reler o histórico.
- Leia somente [GJ00 Reconciliação da base e superfícies de implantação](../../docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md#gj00-reconciliacao-da-base-e-superficies-de-implantacao) do plano.
- Seções do PRD: [Dados capacidade e recuperação](../../docs/PRD-GANSO-JEV.md#dados-capacidade-e-recuperacao).

Localize os símbolos relevantes nestas entradas; abra apenas os trechos necessários. Módulos novos derivados do contrato são propostas, não funcionalidades existentes:

- [docker-compose.yml](../../docker-compose.yml)
- [Makefile](../../Makefile)
- [deploy/healthcheck.sh](../../deploy/healthcheck.sh)
- [docs/ops/SERVER_ACCESS.md](../../docs/ops/SERVER_ACCESS.md)
- [docs/runbooks/btc-postgres-capacity.md](../../docs/runbooks/btc-postgres-capacity.md)

## Resultado e limite

Observar versões efetivas, schema, modo, componentes BTC, posições/reservas pendentes e capacidade usando a identidade SSH registrada. Levantar baseline dos checks na base reconciliada e separar defeitos atuais de divergências históricas. Fazer correções pontuais de compatibilidade/configuração desse diagnóstico; reparos extensos recebem subfatia delimitada. Não ativar coleta, JEV ou ordens nesta sessão.

Escolha detalhes técnicos rotineiros dentro do contrato e versione antes do experimento. Preserve trabalho alheio e contratos históricos. Dimensione pela fronteira funcional, sem limite fixo de arquivos ou migrations aditivas. Valide o comportamento afetado antes de avançar à parte dependente; não declare aceite parcial como concluído.

## Aceite

- Base de checks e compatibilidade registradas com ambiente/data.
- Pendências reais delimitadas; ledger/pins e perímetro preservados.
- Ausência de capacidade não é curada aumentando quota ou excluindo protegido.

## Verificação

Checks existentes pertinentes; PostgreSQL somente descartável. Verificar leitura de versões/estado sem expor segredos; não usar produção como suíte. Execute testes proporcionais ao diff e checks exigidos na base reconciliada. SQL usa banco descartável; não produção. Fixture não comprova operação prospectiva.

## Publicação e gates

Publicar correções necessárias e verificar apenas componentes afetados; diagnóstico sem código segue publicação textual. Na execução agrupada, consolide revisão, PR, checks completos, merge e deploy aplicável no fechamento da entrega; não publique cada checkpoint separadamente. Verifique versão/saúde/persistência dos componentes publicados; para reversão, pause entradas, preserve proteção e use código compatível com o schema, sem apagar eventos.

Não há gate operacional adicional a cumprir para desenvolver este checkpoint; permanecem os controles do protocolo. Observação pendente deve ser registrada, sem manter a sessão esperando.

## Fechamento

Registre GJ00.2 no estado somente após verificar seu aceite. Na execução de JE01, continue no grupo e atualize a linha da entrega e seus IDs cobertos no fechamento; o mesmo PR/SHA pode cobrir vários IDs. Se houver continuação, registre o delta e o próximo checkpoint sem marcar o grupo concluído. Sem delta, não crie PR vazio. Relate validação/publicação ou bloqueio observado; não execute outra entrega fora do pedido.
