# Instruções para agentes — Ganso Market

Leia a [autorização contínua de desenvolvimento e entrega](docs/ops/DEVELOPMENT_AUTHORIZATION.md)
e o [prompt mestre](prompts/AI_DEVELOPER_SYSTEM_PROMPT.md) antes de executar uma tarefa.
Para blocos do roadmap, siga a rota de contexto mínimo indicada no prompt mestre.
No ciclo Ganso 2.0, leia somente a emenda 2.0 da autorização, a rota 2.0 do prompt
mestre, o prompt selecionado em `prompts/ganso-2/` e seu protocolo/RFC-seção.
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
