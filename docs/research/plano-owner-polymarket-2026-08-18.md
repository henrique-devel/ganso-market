# Plano do proprietário — motor Polymarket (2026-08-18)

Diretriz registrada verbatim (estrutura levemente formatada). Este documento é
fonte normativa das RFCs da fase Polymarket, junto com o PRD.

## Como a oportunidade deve ser entendida

O sistema não deve tentar prever apenas "YES ou NO". Ele precisa responder:

- Qual é a nossa probabilidade estimada?
- Qual é a incerteza dessa estimativa?
- Qual é o preço realmente executável?
- Quanto custa entrar e sair?
- Existe liquidez suficiente?
- A regra de resolução é objetiva?
- Existem mercados relacionados que contradizem esse preço?
- A posição aumenta demais algum risco já existente no portfólio?

A Polymarket atualmente opera com CLOB V2, ordens assinadas fora da blockchain
e liquidação em Polygon. A integração futura deve mirar a arquitetura V2 e
pUSD, não implementações antigas (docs: v2-migration). Uma visão baixista
normalmente significa comprar NO. Não existe venda descoberta simples
equivalente a um short tradicional (docs: positions-tokens).

## A armadilha das previsões "óbvias"

Comprar YES por US$ 0,99 arrisca US$ 0,99 para ganhar no máximo US$ 0,01. Um
erro pode apagar aproximadamente 99 acertos. No outro extremo, comprar por
US$ 0,005 permite retorno bruto máximo de 200x, mas implica probabilidade de
mercado próxima de 0,5%; em condições razoavelmente eficientes, a perda total
seria o resultado dominante.

O objetivo não é "taxa de acerto". É: **vantagem probabilística calibrada,
líquida de custos, com sobrevivência do capital.**

## Dados que devem ser coletados continuamente

- Texto completo e versões das regras.
- Fonte oficial de resolução e prazo.
- Eventos, tags, outcomes e relações negative-risk.
- Livro de ofertas completo e seus deltas.
- Bid, ask, spread e profundidade.
- Trades, volume, open interest e concentração.
- Taxas, tick size e tamanho mínimo.
- Clarificações, disputas e mudanças de status.
- Fontes externas específicas de cada categoria.
- Timestamp original e timestamp de recebimento de cada informação.

O preço da interface pode ser midpoint ou último trade, não o preço executável.
A estratégia precisa usar bid/ask e profundidade reais (docs: prices-orderbook).

## Os quatro modelos do motor Polymarket

### 1. Modelo fundamental

Estima a probabilidade `q` usando: o próprio mercado como prior; fontes
oficiais externas; modelos estatísticos específicos por categoria; histórico
comparável; relações com outros mercados.

Modelos diferentes por categoria (não um universal): crypto/preço de ativos,
indicadores macroeconômicos, eleições e pesquisas, esportes, menções e
discursos, geopolítica e notícias.

**Primeiro protótipo: crypto e eventos macro agendados** (fontes e resultados
mais estruturados). Esportes ao vivo, política e geopolítica têm maior pressão
de latência, ambiguidade e risco regulatório.

### 2. Modelo de microestrutura

Escolhe quando e como entrar: spread; profundidade por nível; imbalance do
livro; fluxo comprador/vendedor agressivo; velocidade de cancelamento e
reposição; volatilidade recente; idade do último trade; tempo até catalisador
e resolução; chance de preenchimento da ordem; adverse selection depois do
fill.

Ordens: GTC, GTD, FOK, FAK e post-only (docs: order-lifecycle). Em geral:
post-only/GTD para oportunidades sem urgência; FAK/FOK com pior preço explícito
quando a informação estiver desaparecendo rapidamente; **nenhuma ordem sem
limite máximo de preço ou slippage**.

### 3. Modelo de risco de resolução

A resolução usa o UMA Optimistic Oracle. O título do mercado não basta: regras,
fonte, data, exceções e clarificações determinam o payoff. Disputas podem
prolongar o capital imobilizado e existe resultado excepcional 50/50 (docs:
resolution).

Features: ambiguidade textual; confiabilidade e disponibilidade da fonte;
número de exceções; dependência de interpretação humana; mudanças nas regras;
histórico de disputas semelhantes; probabilidade de resolução tardia;
inconsistência entre título e regra completa.

### 4. Motor de portfólio

Controla: exposição por evento; categoria e fonte de resolução; correlação
entre posições; concentração temporal em um mesmo catalisador; liquidez
agregada; perda diária, semanal e drawdown; capital bloqueado até resolução.

## Critério de entrada

Para YES: `EV por share = q − ask executável − custos`
Para NO: `EV por share = (1 − q) − ask_NO executável − custos`

Entrada somente quando:

```
limite inferior da estimativa de probabilidade − preço executável
  > taxas + slippage + custo de capital + margem de segurança
```

Taxas são variáveis por mercado e tipo de execução; consultar em tempo real
(docs: fees). Tamanho parte de fração conservadora de Kelly, sempre limitado
por: profundidade disponível; incerteza do modelo; correlação; ambiguidade da
resolução; perda máxima do portfólio; slippage como proporção do edge.

## Critério de saída

Sair quando: o bid executável já captura a maior parte da vantagem; a
probabilidade do modelo mudou; a tese ou fonte foi invalidada; a liquidez ou
regra deteriorou; um catalisador não coberto pelo modelo se aproxima; o capital
bloqueado deixou de compensar o edge residual; limites do portfólio foram
atingidos.

**Não prometemos stop-loss.** Um livro binário pode saltar de um preço alto
para perto de zero.

## Features do produto (por oportunidade na interface)

- Probabilidade do mercado.
- Probabilidade estimada e intervalo de confiança.
- YES ou NO sugerido.
- Bid/ask, spread e profundidade.
- Edge bruto e líquido.
- Taxas e slippage esperado.
- Tamanho máximo executável.
- Risco de resolução.
- Fonte oficial e trecho relevante da regra.
- Mercados correlacionados ou contraditórios.
- Motivo da entrada.
- Condição de invalidação.
- Atualidade dos dados.
- Resultado provável, melhor e pior cenário.

## Grafo lógico entre mercados

- Eventos mutuamente exclusivos devem somar aproximadamente 100%.
- Se A implica B, `P(A) ≤ P(B)`.
- Mercados equivalentes devem convergir.
- Escadas temporais devem respeitar monotonicidade.
- Eventos negative-risk têm relações econômicas específicas.

Essa camada pode ser mais defensável que tentar ganhar apenas por NLP de
notícias.
