# Autorização contínua de desenvolvimento e entrega

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
