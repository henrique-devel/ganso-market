# Autorização contínua de desenvolvimento e entrega

## Ciclo JEV com autonomia por bloco

Em **07/10/2026**, após consolidar o grilling e o plano, o proprietário solicitou
prompts por bloco, divididos em sessões independentes, com autorização expressa
para **alteração, merge, PR e publicação em produção**. A preparação deste pacote
é documental e não manda executar suas sessões.

Ao selecionar um prompt em [prompts/jev](../../prompts/jev/README.md), ficam
autorizados inspeção, implementação e correções do escopo, branch `codex/`,
commit/push, criação/atualização/revisão do PR, acompanhamento dos checks,
merge após checks/proteções e publicação em produção dos componentes afetados.
Inclui migrations aditivas, configuração, quiescência reversível e restart
seletivo previstos no prompt. Concluir essas etapas sem reconfirmação por fase.
Limitações posteriores do pedido prevalecem; não executar outro bloco automaticamente.

A [especificação JEV](../PRD-GANSO-JEV.md) substitui os contratos antigos
conflitantes: três pares paper/stress com US$250 fictícios por conta, um piloto
live de US$250 reais totais e infraestrutura fora do PnL/aprovação da estratégia.
Os pools JEV agregados são US$8 operação e US$2 geração/validação por mês.
Publicar código não contrata API/infra, deposita, aumenta capital ou arma live.
Ativação paper em GJ12.2 depende de cobertura, capacidade e orçamento existentes.
GJ13.5 autoriza ensaio testnet delimitado com conta dedicada, identidade válida e
fundos de teste existentes; não compra ou deposita capital real.
Live depende dos gates e do ato inicial autenticado do operador; o agente não
clica em seu lugar. Sucessão automatizada posterior segue o contrato aprovado.

Manter checks/proteções, testes proporcionais, identidade SSH, auth/perímetro,
segredos, ledger, pins e migrations aplicadas. Sem bypass, limpeza genérica ou
perda de trabalho alheio. A emenda de não exigir backup até o sistema estar
100% operante permanece; não criar essa frente como pré-requisito.

Registro mínimo: atualizar somente a linha do prompt no
[estado JEV](../roadmap/GANSO_JEV_EXECUTION_STATE.md), com estado, PR/SHA quando
houver, validação resumida e publicação/gate pendente. Sem recibo, relatório,
pasta de evidência ou screenshots obrigatórios. Evidência financeira e respostas
JEV são dados funcionais do produto. Sete/90 dias são observação própria e não
impedem desenvolver/publicar os demais componentes compatíveis desativados.

As permissões efetivas das ferramentas continuam necessárias. Diante de bloqueio
real, concluir trabalho independente e informar a ação, causa e condição mínima;
pedir somente informação ou decisão ainda ausente, sem reabrir autorização do fluxo.

## Coleta contínua BTC — autorização de 02/10/2026

O proprietário autorizou expressamente: “Autorizado a coleta continua”. Autoriza
retomar e manter o coletor público BTC/Hyperliquid em paper, no perfil v3
`btc-storage-200gb-80pct.v1`, sem prazo de piloto. Aplicam-se o orçamento de
200 GB decimais e a parada aos 160 GB (80%) já aprovados abaixo. Esta decisão
substitui a pendência de autorização de retomada e os prazos dos pilotos históricos;
não exige comprovação prévia de 90 dias para esta partida autorizada. O aceite de
estabilidade/econômico continua separado e não é presumido pela ativação.

Partida seletiva do coletor e observação inicial autorizadas, preservando os
processos de API/web/gateway/PG e as sessões. Manter HOLD, pins, corpus, guards,
CPU/RAM/pools, piso de disco e `restart=no`; uma parada terminal não renova
automaticamente a coleta. Ao atingir a trava, parar e analisar redução ou novo
procedimento conforme a decisão anterior. Sem poda, rearme de baseline, ordens,
capital/live, contratação ou nova automação por consequência desta autorização.

## Armazenamento BTC — autorização de 02/10/2026

O proprietário determinou: “então esquece esse quota logica vamos fazer o seguinte
traz o limite para 200gb quando chegar em 80% desse limite a gente trava e analisa
no futuro como reduzir ou o que fazer”. Substitui os tetos antigos de armazenamento
pelo orçamento de **200 GB decimais (200.000.000.000 B)**, com parada de coleta e
recusa de novas capturas aos **160 GB (80%)**, tanto lógicos quanto físicos.
Raw usa o mesmo orçamento, sem manter o teto anterior menor. A margem de 20%
permite registros essenciais de fechamento/contabilidade, sujeitos ao teto total.
Manter HOLD, pins, corpus, auth/sessões, risco, orçamento CPU/RAM/conexões e piso
de disco livre; não podar, rearmar ou contratar recursos por esta decisão.
Redução/otimização será analisada depois da trava, conforme pedido. A retomada
contínua foi autorizada posteriormente na seção acima; a decisão de orçamento
por si só não retomou o piloto concluído. Fluxo de código/testes/PR/merge/deploy autorizado.
As seções de pilotos abaixo são históricas quanto aos tetos, sem renovar seus prazos.

## Piloto G2-12.3 — autorização de 02/10/2026

O proprietário autorizou expressamente: “Autorizado o Piloto de 30minutos cuidado para
não perder a sessão”. A proposta aceita é uma nova janela BTC de até 30 minutos, com
parada automática e os tetos existentes, para medir frescor, crescimento e estabilidade.
Preservar sessão/auth e não recriar API, web, gateway ou PostgreSQL para essa partida.
Não renovar automaticamente, alterar quotas/HOLD/risco, rearmar baseline ou executar
ordens por consequência desta autorização. O resultado observado fica na linha G2-12.3
do acompanhamento existente.


## Piloto G2-12.3 — autorização de 28/09/2026

Após a proposta do PR #312, o proprietário respondeu:

> 1 podemos ir com mais no lugar de 11gib pode ir com 16 e no lugar de 8 podemos ir com 12  sobre o item 2 autorizado

Autoriza o perfil temporário do **coletor** raw/lógico/físico **4/16/12 GiB** e
piloto de até seis horas com prazo absoluto/parada automática, como exceção
limitada ao aceite prévio de 90 dias e da fatura discriminada. Abrange o fluxo de
implementação, testes, PR, merge, publicação e partida seletiva já concedido.
Não pedir novamente essas aprovações. O prazo concreto depende do preflight.

A proposta preservava as quotas SQL: raw 10, lógico 12 e recusa física 14 GiB.
Continuam preservadas; o limite lógico efetivo da coleta é, portanto, **12 GiB**,
menor que o teto de 16 GiB do perfil. Diagnóstico/horizonte devem mostrar o menor
limite. Não tratar a autorização como alteração implícita de SQL, risco, banca,
HOLD, dados, pools, infraestrutura, live ou ativação da baseline. Janela piloto
não é lançamento contínuo, sete dias observados nem extensão automática.


<a id="aposentadoria-polymarket-28092026"></a>

## Emenda vigente — aposentadoria Polymarket (28/09/2026)

O proprietário determinou: “vamos começar então com o Escopo pode remover e
alterar tudo que envolva o legado de Polymarket”, autorizando expressamente
“desde do ambiente local até no servidor de produção” e fixando o foco em
“BTC/Hyperliquid com JEV no futuro”.

Aplicar [escopo vigente](../SCOPE.md): substituir a preservação obrigatória do
módulo/acervo por aposentadoria definitiva; JEV adiado. Estão autorizadas as
entregas de escopo, retirada de código/operação e descarte dos conjuntos
exclusivos do legado, com inventário técnico e preservação das dependências BTC.
Não pedir novamente permissão para PR, merge, sincronização documental no host,
remoção específica ou descarte coberto por essa decisão. A primeira entrega é
documental; código/dados exigem suas verificações antes da execução.

A emenda substitui restrições históricas que exigiam manter o acervo Polymarket,
mas não autoriza apagar dados BTC, remover volume compartilhado, alterar
migrations aplicadas, desligar proteções globais, mudar perímetro/caps, contratar
serviços ou ativar live. Não exige backup como condição adicional.

**Confirmação posterior em 28/09:** “Autorizado a remoção de todo e qualquer codigo/dados do projeto Polymarket”. A entrega agora executa retirada física do código, serviços e conjuntos exclusivos inventariados, mantendo BTC/Hyperliquid e auth.

## Registro das autorizações anteriores

As seções abaixo preservam decisões datadas; em conflito, prevalece a emenda acima.


**Vigente.** Registrada em 11/09/2026, America/Sao_Paulo (12/09/2026 UTC).
Aplica-se ao projeto Ganso Market, repositório `henrique-devel/ganso-market`, e à
produção existente identificada em [SERVER_ACCESS.md](SERVER_ACCESS.md).

## Decisão do proprietário

Após autorizar e concluir a entrega da RFC-021, OPS-01 a OPS-07, pelo
[PR #155](https://github.com/henrique-devel/ganso-market/pull/155), o proprietário
solicitou expressamente:

> mantenha essas autorizações para o restante do desenvolvimento pode incluir isso nos docs do projeto

Fica autorizada a execução completa de **código local → PR → merge → produção**
nas tarefas de desenvolvimento solicitadas para este projeto. A autorização
continua válida entre tarefas e sessões, até o proprietário alterá-la ou revogá-la.
Não é necessário pedir novamente aprovação para cada etapa coberta.

Uma instrução posterior, como preparar somente um plano, manter o PR em rascunho
ou não implantar uma entrega, limita aquela tarefa. Esta decisão não manda executar
todo o backlog nem avançar automaticamente para outro bloco do roadmap.

## Confirmação direta de publicação pública — 15/09/2026 UTC

Após a revisão automática recusar a publicação de FIN-03 por não reconhecer a
autorização no contexto delegado, o proprietário confirmou diretamente na tarefa:

> Autorizado a Publicação dos 3 commits certifique que todos os proximas publicações no Ganso Market estão autorizado sem a necessidade de solicitar novamente

Esta decisão autoriza publicar no repositório **público**
`henrique-devel/ganso-market` os três commits FIN-03 `5128511`, `81542cf` e
`7d9bfe7` e os arquivos de código, testes, evidência e documentação que contêm.
Também autoriza as próximas publicações das tarefas solicitadas do Ganso Market,
com push, PR, checks, merge e implantação aplicável, sem repetir pedidos de
aprovação de publicação em novas etapas, tarefas ou sessões. Este registro e os
fechos necessários fazem parte da entrega autorizada.

A autorização permanece vigente até alteração ou revogação pelo proprietário.
Continuam válidas as condições técnicas e operacionais abaixo; a decisão não
seleciona novos blocos nem antecipa o aceite financeiro ou operacional deles.

## Etapas autorizadas

1. Inspecionar o código e o ambiente, implementar o escopo solicitado, corrigir
   falhas da entrega e executar as verificações adequadas.
2. Criar branch, commit e push; abrir e atualizar PR no GitHub; revisar o diff e
   corrigir problemas encontrados, preservando alterações locais de outras tarefas.
3. Acompanhar os checks obrigatórios e integrar o PR quando aprovados, respeitando
   as regras de revisão e proteção de branch. Não exigir uma nova confirmação do
   proprietário apenas porque chegou a etapa de merge.
4. Acompanhar o CI/CD e realizar as etapas operacionais necessárias ao escopo da
   entrega, inclusive migrations previstas, atualização dos serviços afetados e
   instalação de componentes operacionais previstos na RFC/runbook. O SSH usa a
   identidade já validada e as credenciais existentes, sem expor segredos.
5. Verificar saúde, SHA efetivo dos serviços afetados, persistência e proteções;
   registrar evidências, limitações e resultado no PR/recibo. Aplicar rollback
   previsto no runbook quando necessário, compatível com o schema e preservando dados.

Mudanças somente documentais seguem o classificador da RFC-020: se o CI/CD indicar
`deploy pulado: só texto`, concluir a publicação dos documentos sem forçar uma
recriação de serviços. Publicar código, demonstrar um aceite operacional e concluir
um período de observação são resultados distintos e devem ser relatados como tal.

## Condições que permanecem

- Testes, checks obrigatórios, proteções de branch, critérios das RFCs e verificações
  do runbook continuam exigidos. Corrigir falhas antes de integrar; não usar bypass
  administrativo para contornar um gate.
- Manter a identidade SSH fixada e o perímetro atual. Divergência de identidade deve
  ser reconciliada por canal independente conforme o registro de acesso.
- Deploy não ativa automaticamente live/signer, aumenta capital/caps, promove
  modelos ou força rearme de kill switch. Essas ações seguem as decisões e gates
  específicos do PRD e das RFCs, inclusive autorizações específicas já concedidas.
- A autorização de entrega não é autorização genérica para apagar dados/volumes,
  reescrever ledger, alterar migrations aplicadas ou mudar infraestrutura/perímetro
  fora do escopo solicitado. Operações desse tipo exigem conjunto concreto e
  autorização específica aplicável, sem pedir novamente uma autorização já existente.

Este registro expressa a decisão do proprietário; não cria credenciais nem altera
as permissões efetivas do GitHub, SSH, ambiente de execução ou ferramentas. Quando
houver bloqueio real, concluir o trabalho independente e informar a ação bloqueada,
a causa e a intervenção mínima necessária. Pedir somente a informação ou decisão
que ainda faltar, sem reiniciar a aprovação de todo o fluxo.

## Continuidade

Esta é a referência vigente para autorização das entregas. Menções antigas a
“autorização aplicável” ou “aguardar autorização” devem ser avaliadas à luz deste
registro e do escopo atual; recibos históricos continuam sendo evidência de sua data.
Restrições técnicas ou decisões específicas de produto não são revogadas por essa
leitura. Registrar aqui qualquer alteração futura expressa pelo proprietário.

## Retomada das recomendações BTC — 12/09/2026

O registro do coordenador `BTC-recomendacoes-autorizacao.md`, de
`2026-09-12T14:28:42.527173+00:00`, preserva a pergunta apresentada imediatamente
antes da resposta do proprietário (espaçamento normalizado abaixo):

> autoriza publicar as entregas DATA-03/04/05 — revisão conjunta de 28 arquivos, base e9d6960..8c8418d — no repositório público henrique-devel/ganso-market e realizar o ensaio limitado de escrita/WAL em PostgreSQL descartável?

Resposta exata do proprietário:

> Perfeito vamos fazer a publicação e sobre as recomendações sugeridas no documento Resultado da sequência BTC — DB-02 a DATA-05
>
> Pode executar e começar a fazer agora, para cada bloco fazer a recomendação em sessões separadas respeitando a sequencia no final traga o consolidado

A resposta autoriza a publicação das entregas indicadas, com revisão, checks,
merge e implantação aplicáveis, e a execução das recomendações do consolidado em
sessões separadas, um bloco por vez, na sequência DB-02 → DB-03 → DB-04 → DATA-01 →
DATA-02 → DATA-03 → DATA-04 → DATA-05, com consolidado ao final. O ensaio limitado
de escrita/WAL em PostgreSQL descartável está aprovado: 10 mil inserts, mil
upserts/deletes e VACUUM conforme o plano conferido. A execução deve preservar os
limites do ensaio e os critérios técnicos; não autoriza relaxar gates ou tratar
fixtures como evidência de produção, soak ou preservação real.

As restrições temporárias de publicação apenas local foram superadas por essa
resposta. Recusas e pedidos antigos sem resposta permanecem como histórico, sem
constituir aprovação atual pendente para as ações agora cobertas. Uma nova recusa
efetiva de ferramenta continua sendo uma restrição: informar a ação e a causa,
concluir o trabalho independente e não contornar a recusa.

Permanecem HOLD, imagens, backups e rollback preservados, Q4 e compactação adiados,
infraestrutura caseira existente e custo externo adicional zero. A autorização
não permite limpeza ou poda genérica de produção, apagar dados produtivos,
reescrever ledger ou migrations aplicadas, mudar Q4 sem contrato, alterar
capital/caps/live/signer/perímetro, comprar infraestrutura nem executar compactação
sem os critérios e a autorização aplicáveis. A promoção do índice candidato de
último trade continua dependente dos gates técnicos e da validação operacional;
essa resposta não equivale a índice aplicado ou gate aprovado.

<a id="ciclo-ganso-20--entrega-com-registro-minimo-22092026"></a>

## Ciclo Ganso 2.0 — entrega com registro mínimo (22/09/2026)

O proprietário aprovou o PRD 2.0 e solicitou prompts pequenos para sessões
isoladas, reiterando expressamente autorização de **código, criação de PR,
merge e produção** em cada fatia. Também dispensou evidência formal por sessão
para não gastar tempo com documentação de execução.

Para qualquer prompt selecionado em [prompts/ganso-2](../../prompts/ganso-2/README.md)
ou na [continuação operacional G2-11–17](../../prompts/ganso-2-operacao/README.md),
estão autorizados implementação, branch/commit/push, criação e correção do PR,
merge após os checks e implantação dos serviços afetados. Inclui migrations
aditivas, configuração, restart seletivo, quiescência reversível e ativação paper
explicitamente previstos no prompt. Não pedir novamente confirmação por etapa.
Criar o pacote não manda executar todos os prompts nem iniciar novas sessões.

**Emenda posterior do proprietário em 22/09:** seguir sem backup até o sistema
estar 100% operante. Backup, restauração de backup, agenda, contratação e custo
associados saem do escopo atual; não exigir essa frente para coletar, operar,
fazer merge, implantar ou concluir o 2.0. Esta decisão substitui requisitos
anteriores conflitantes. Retenção, pins e reconciliação após reinício permanecem.

**Registro mínimo substitui o recibo obrigatório neste ciclo:** basta atualizar
a linha do prompt em [GANSO_2_EXECUTION_STATE.md](../roadmap/GANSO_2_EXECUTION_STATE.md)
com estado, PR/SHA quando houver, validação em uma frase e deploy/pendência.
Não exigir relatório, recibo separado, screenshots, export de logs, pasta de
evidências ou ensaio prolongado em toda entrega. Resultados do CI/PR e uma
checagem operacional breve quando aplicável são suficientes para esse registro.
Ausência de um documento de evidência não é motivo para bloquear ou refazer trabalho.

Testes proporcionais e checks obrigatórios continuam; não inventar resultado ou
ignorar falha para dispensar burocracia. O histórico financeiro, dados de fill,
respostas Jev e métricas são requisitos funcionais do produto,
não provas administrativas da sessão. Observação de sete dias e avaliação econômica
ficam nos prompts próprios, sem impedir entrega dos outros componentes validados.

Documentação segue a dispensa de deploy da RFC-020; não recriar serviços nem abrir
PR vazio para uma consulta sem alterações. Restrições e recibos antigos permanecem
históricos; a exigência antiga de anexar recibo por bloco não vale para Ganso 2.0.

Permanecem o escopo paper, a banca fictícia de US$ 1.000 por cenário, os contratos
financeiros e o teto total de planejamento de US$ 80/mês. Esta autorização de
entrega não compra infraestrutura/API, cancela fornecedor, aumenta orçamento,
ativa dinheiro real nem apaga conjunto de dados ainda não delimitado. Aplicar
autorizações específicas já existentes sem perguntá-las de novo; quando faltar
uma decisão desse tipo, preparar resultado concreto e pedir somente o que falta.
Identidade SSH, proteções de branch e permissões efetivas das ferramentas continuam
necessárias. Preservar trabalho local de outras sessões.

## Continuidade documental de 27/09/2026

Pedido do proprietário: “Crie o roadmap e os prompts para seguir essa ordem recomendada para a gente progredir no projeto”. A entrega é o pacote G2-11–17, com o mesmo acompanhamento e fluxo de entrega já autorizado; não é uma ordem de executar todos os prompts. Esta nota aplica a autorização contínua às sessões futuras selecionadas e não amplia autorização de compra, consumo pago, descarte, capital, caps ou perímetro. Backup continua fora do pré-requisito. Preparação Jev não equivale a cobertura de consumo nem ativação.
