> **07/10/2026 — direção confirmada após grilling:** JEV será o motor principal; três perfis paper/stress e um piloto live de US$250; infraestrutura excluída do PnL/aprovação das estratégias. Leia a [especificação](docs/PRD-GANSO-JEV.md), o [plano por fatias](docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md) e a [comparação com o código](docs/architecture/ganso-jev-code-map.md). O [pacote de 52 sessões](prompts/jev/README.md) foi preparado documentalmente. Executar um prompt selecionado tem autorização para alteração, PR, merge e produção; a preparação do pacote não executa nenhum deles. O desenho não comprova runtime entregue; prompts antigos de baseline/filtro não governam o novo ciclo.

> **Histórico de 28/09/2026:** Polymarket continua retirada. O runtime BTC existente e as entregas anteriores permanecem preservados; consulte o [escopo](docs/SCOPE.md) para distinguir direção futura e estado histórico.

# Instruções para agentes — Ganso Market

**Escopo histórico (28/09/2026; decisões conflitantes substituídas pelo PRD JEV):** ler [docs/SCOPE.md](docs/SCOPE.md).
BTC/Hyperliquid é o único foco atual; JEV fica para o futuro. Polymarket está
aposentada, com retirada local e produtiva autorizada. Não manter módulo/acervo
nem reabrir backlog legado por instrução histórica. Preservar componentes e dados
utilizados pelo BTC. A entrega de escopo não equivale à remoção física do legado.


Leia a [autorização contínua de desenvolvimento e entrega](docs/ops/DEVELOPMENT_AUTHORIZATION.md)
e o [prompt mestre](prompts/AI_DEVELOPER_SYSTEM_PROMPT.md) antes de executar uma tarefa.
Para blocos do roadmap, siga a rota de contexto mínimo indicada no prompt mestre.
No ciclo JEV, leia somente a emenda JEV da autorização, o prompt selecionado,
seu protocolo e as seções indicadas. Atualize apenas sua linha no estado JEV.
Entrega de código e qualificação/ativação operacional são estados separados.
No ciclo Ganso 2.0, leia somente a emenda 2.0 da autorização, a rota 2.0 do prompt
mestre, o prompt selecionado em `prompts/ganso-2/` e seu protocolo/RFC-seção.
Para a continuação operacional G2-11–17, usar
`prompts/ganso-2-operacao/`, a RFC-053 e o mesmo acompanhamento; começar
em G2-11.1 quando o pedido selecionar o início desse roteiro.
Uma sessão executa uma fatia até PR, merge e implantação aplicável. O registro
é uma linha em `docs/roadmap/GANSO_2_EXECUTION_STATE.md`; não exigir recibo ou
arquivo de evidência separado. O histórico de autorizações é consulta sob demanda.
Backup fica fora do ciclo atual até o sistema estar 100% operante, conforme a
emenda 2.0; não reintroduzir essa dependência a partir de documentos históricos.

O proprietário autorizou o fluxo completo **código local → PR → merge → produção**
para as tarefas solicitadas neste projeto, até alteração ou revogação. Prossiga
sem pedir novamente autorização para cada etapa coberta; execute os testes,
respeite as proteções do repositório e verifique a implantação conforme o runbook.
Uma instrução posterior do proprietário que limite a tarefa prevalece.

A autorização não dispensa gates técnicos, credenciais válidas ou permissões
efetivas das ferramentas. Ativação live, capital, operações destrutivas e mudanças
de perímetro continuam sujeitos ao escopo e às decisões específicas documentadas.
Preserve trabalho local alheio à tarefa e registre resultados efetivamente observados.
