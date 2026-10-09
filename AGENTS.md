> **07/10/2026 — direção confirmada:** JEV será o motor principal; três perfis paper/stress e um piloto live de US$250; infraestrutura excluída do PnL/aprovação das estratégias. Leia a [especificação](docs/PRD-GANSO-JEV.md), o [plano](docs/roadmap/GANSO_JEV_IMPLEMENTATION_PLAN.md) e a [comparação com o código](docs/architecture/ganso-jev-code-map.md). O [pacote de execução](prompts/jev/README.md) usa **14 entregas agrupadas, 52 critérios rastreáveis e seis etapas operacionais separadas**. Selecionar uma entrega autoriza seus checkpoints até PR, merge e produção aplicável; a preparação documental não inicia implementação. O desenho não comprova runtime entregue; prompts antigos de baseline/filtro não governam o novo ciclo.

> **Complemento de 09/10/2026:** o [plano JE15–JE17](docs/roadmap/GANSO_JEV_LIVE_COMPLETION_PLAN.md) acrescenta três entregas e 10 checkpoints GJ16–GJ18 para runtime live, pausa/emergência live e painel live. Total atual: 17 entregas/62 IDs e as mesmas seis etapas operacionais. Histórico JE01–JE14 preservado; novos itens planned. Preparar documentos não inicia implementação nem ativação.

> **Histórico de 28/09/2026:** Polymarket continua retirada. O runtime BTC existente e as entregas anteriores permanecem preservados; consulte o [escopo](docs/SCOPE.md) para distinguir direção futura e estado histórico.

# Instruções para agentes — Ganso Market

Leia a [autorização contínua de desenvolvimento e entrega](docs/ops/DEVELOPMENT_AUTHORIZATION.md)
e o [prompt mestre](prompts/AI_DEVELOPER_SYSTEM_PROMPT.md) antes de executar uma tarefa.
Para blocos do roadmap, siga a rota de contexto mínimo indicada no prompt mestre.
No ciclo JEV, leia somente a [emenda JEV da autorização](docs/ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-jev-com-autonomia-por-bloco),
o prompt da entrega selecionada em `prompts/jev/entregas/`, seu [protocolo](prompts/jev/00-protocolo.md)
e os checkpoints/seções indicados. Avance entre os checkpoints do grupo sem novo
pedido, teste as partes afetadas e consolide revisão, PR, checks completos, merge
e implantação no fechamento da entrega. Dependências internas podem ser verificadas
na mesma branch; dependências externas precisam estar integradas ou comprovadas na base.
O tamanho segue a fronteira funcional, sem limite fixo de arquivos ou migrations aditivas.
Atualize apenas a linha da entrega e os IDs cobertos no
[estado JEV](docs/roadmap/GANSO_JEV_EXECUTION_STATE.md). Entrega de código e
qualificação/ativação operacional são estados separados. Os seis prompts operacionais
permanecem próprios. Pedido restrito a um ID limita o escopo a esse ID. Não iniciar
outra entrega, chat ou agente sem solicitação; esta revisão documental não executa o plano.
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
