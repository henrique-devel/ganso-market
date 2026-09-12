# Protocolo dos blocos BTC — contexto curto

Este arquivo vale junto do prompt escolhido. O pedido atual do proprietário prevalece.
O pacote foi solicitado em 10/09/2026 para especificar o desenvolvimento; sua criação
não implementou código, fez deploy, limpou produção ou habilitou dinheiro real.

## Entrada mínima de uma sessão

1. Confirme a raiz com `git rev-parse --show-toplevel` e preserve `git status --short`.
2. Leia este protocolo, **um** prompt e apenas sua linha/dependências no
   [estado](../../../docs/roadmap/BTC_EXECUTION_STATE.md). Leia a seção citada da RFC.
3. Abra os 3–6 arquivos/símbolos indicados pelo prompt. Caminho inexistente:
   procure com `rg --files`; não invente o conteúdo. Arquivo novo deve estar nomeado
   como proposto. Não leia HANDOFF inteiro, todos os prompts ou diagnóstico integral.
4. Como alvo, use até 1.500 palavras de contexto documental inicial. Expanda quando
   necessário para resolver uma dúvida concreta; explique o motivo em uma linha.

## Escopo e autorização

- Ao receber um prompt como pedido de execução, trabalhe no bloco selecionado.
  Seu `draft` documental não exige uma segunda confirmação para a tarefa solicitada.
- `code`: implementação/testes locais, seguidos de PR, merge e implantação aplicável
  sob a [autorização contínua](../../../docs/ops/DEVELOPMENT_AUTHORIZATION.md), após
  os checks obrigatórios e sem nova confirmação por etapa. Um pedido mais restrito
  prevalece; a autorização não seleciona o próximo bloco.
- `read-only`: inspeção/medição e evidência,
  permitindo escrever o relatório local e rodar testes em banco descartável.
  `operation-plan`: produzir plano executável e verificável; atuar em produção
  somente se a ação concreta estiver coberta por autorização vigente.
- Autorizações anteriores continuam válidas. Não repita aprovação de decisões já
  concedidas: a RFC-021 D3, rearme condicionado de 15 min, já foi aprovada em 05/09.
  Isso não autoriza rearmar com feed stale, perdas, disputa ou engate manual.
- Consulta SSH autorizada: registro em `docs/ops/SERVER_ACCESS.md`, host key fixada.
  Não leia/imprima segredos. Consulta não significa autorização genérica de escrita.
- Limpeza irreversível requer escopo concreto: manifesto, objetos, corte e proteções.
  Se a autorização existente não cobrir esse resultado, prepare tudo antes de pedir
  aprovação. Não use a criação desta documentação como autorização de DELETE.
- Não habilite live, signer, ordens reais, saque ou bypass de gates nestes blocos.
  RFC-040 distingue proposta de experimento, preparação e ativação futura pela 009.

## Um bloco, uma entrega

- Confirme dependências por código e recibo de evidência, não por título `implemented`.
  Separe prova local de prova em produção. Recibo ausente não significa código ausente.
- Para implementação pura, contrato/teste local pode satisfazer a dependência; para
  afirmar saúde, limpeza ou resultado prospectivo, exigir aplicação/observação datada.
  Plano pronto e fixture não substituem o recibo operacional ou dados novos pós-freeze.
- Uma premissa histórica refutada não manda parar automaticamente: se o resultado já
  existe, verifique e registre; adapte só o delta dentro do escopo. Pare a parte
  dependente se faltar contrato/dado essencial; continue trabalho independente útil.
- Antes de editar, declare objetivo, 3–6 arquivos previstos e teste econômico/operacional.
- Uma mudança coerente por bloco; alvo de até 6 arquivos de lógica e uma migration.
  Se o contrato mínimo exigir mais, divida antes e registre dependências. Não deixe
  stub ativo para caber no limite. Arquivos grandes: leia por símbolo, não integralmente.
- Migrations já aplicadas são imutáveis; escolha o próximo número livre, sem fixá-lo
  a partir de um relatório antigo. Coordene antes de dois blocos criarem migrations.
- Dados monetários decimais/fixed-point; source/received timestamps e versões explícitos;
  token, lado, quantidade, conta/estratégia e perda máxima devem concordar.
- Fixtures independentes da implementação, falhas relevantes e happy path. Para SQL,
  use PostgreSQL descartável via `GANSO_TEST_DATABASE_URL`; produção nunca é banco de teste.
- Rode testes direcionados a cada bloco; checks de integração/CI antes de entrega para
  deploy. Não repetir suíte inteira sem mudança/falha que justifique. Teste não rodado
  fica explicitamente não verificado; não transformar skipped em passed.
- SSR/REST/WS/SDK externos: abra documentação oficial atual antes de implementar uma
  interface mutável. Registre data e fonte, nunca trate fee ou regra histórica como atual.
- Não apagar ledger ou histórico para fazer teste/gate passar; não fabricar frescor,
  fill, resultado, ausência de gap, independência estatística ou capacidade de recuperação.

## Saída curta e continuidade

Use [o recibo](../../../docs/roadmap/RECEIPT_TEMPLATE.md): escreva até 25 linhas em
`docs/roadmap/receipts/<ID>.md` (criar no fecho), com SHA, evidência, testes reais,
limitações e próximo bloco. Atualize só a linha do estado. Não acrescente ensaio ao HANDOFF.

Não execute automaticamente o próximo prompt. Uma sessão = um bloco; várias IAs podem
trabalhar em blocos independentes. Mesmo arquivo, migration ou contrato compartilhado
exige coordenação; dependência concluída é condição de integração, não calendário.
