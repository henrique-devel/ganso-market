# DB-03 — Acessos as-of RTDS e contrato de snapshots

**Plano candidato; DB-03 não executa índice ou repack no servidor.** A promoção
operacional do índice RTDS e seu ensaio de escrita/espaço/WAL pertencem ao DB-04.
Esta entrega mantém a infraestrutura existente e não acrescenta migration
automática. **O SQL da aplicação foi preservado:** no ensaio sem candidato,
os buffers do cenário de dois símbolos subiram de 1.364 para 6.408. O candidato
com índice passou na triagem de leitura; escrita/WAL continuam não verificados
por bloqueio da revisão automática. Resultados no
[relatório DB-03](../test-results/btc/DB-03.md).

## RTDS: seleção preservada e caminho candidato

O acesso selecionado é `loadFeedSamples`, Q2 do
[baseline DB-01](../test-results/btc/DB-01.md). O
[rewrite candidato](sql/db03-rtds-asof-query.sql) faz uma busca `LATERAL ... LIMIT 1`
por par distinto de símbolo/feed. O
[índice candidato](sql/db03-rtds-asof-index.sql),
`polymarket_rtds_prices_asof_idx`, é B-tree não único sobre
`(feed, symbol, COALESCE(source_ts, received_at) DESC, rtds_price_id DESC)`.

O contrato continua sendo a última linha de cada par com
`COALESCE(source_ts, received_at) <= decisão` **e** `received_at <= decisão`.
O maior `rtds_price_id` vence o empate no timestamp efetivo. `source_ts` nulo usa
`received_at`; amostra recebida depois da decisão não aparece mesmo quando traz
source antigo. Par sem dados não produz linha. Duplicatas nos arrays não devem
duplicar buscas nem alterar o resultado.

A preferência continua sendo a ordem de feeds do chamador, normalmente twap30
antes de twap60. Não filtrar preço antes do `LIMIT`: o preço inválido da última
linha pode levar ao próximo feed, mas não autoriza recuar para um preço anterior
do mesmo feed. Não impor limite inferior de TTL: o código ainda retorna a amostra
stale e calcula sua idade. Fonte que resolve BTC, TTL e estimador não mudam.

O índice existente `(feed, symbol, received_at)` não satisfaz a ordenação por
timestamp efetivo e id. Com o candidato, a busca pode consumir a ordem B-tree e
parar ao encontrar a primeira linha elegível, evitando ordenar todo o histórico
do par; a utilidade dessa combinação de ordenação e `LIMIT` é descrita em
[Indexes and ORDER BY, PostgreSQL 18](https://www.postgresql.org/docs/18/indexes-ordering.html).

**Limite concreto:** `received_at` permanece filtro residual nesse índice.
Muitos registros com source anterior e recebimento posterior ao corte podem
exigir muitas entradas/visitas ao heap antes do primeiro resultado, ou esgotar
o par. `LIMIT 1` limita a saída, não promete custo constante nem elimina todo
backlog. Medir `Rows Removed by Filter`, linhas, buffers e sort/temp também em
cortes históricos e nesse cenário adversarial. Não retirar a barreira causal
para obter um plano menor.

## Gates e decisão do SQL da aplicação

Comparar o SQL anterior e o rewrite em PostgreSQL descartável, com e sem o
candidato. Usar a distribuição DB-01: 120.000 linhas, dois símbolos, dois feeds,
30.000 linhas por par; cenários de um/dois símbolos, atual/histórico e ausente.
A fixture funcional inclui source/received futuros, NULL, empates, duplicatas,
arrays vazios, preferência por feed stale e último preço inválido. Comparar
identidade/valores selecionados antes de medir performance.

Orçamento de triagem DB-01: uma conexão, 5 s por statement, três warmups e vinte
medições por cenário/variante, teto de 120 s por cenário; p95 <=500 ms e redução
de pelo menos 50% das linhas/buffers, com menor sort/temp. p95 de vinte amostras
é triagem e não sustenta p99 nem equivalência de carga com produção.

**Decisão observada:** preservar o SQL atual e entregar o candidato executável
com os testes/evidências. Sem índice, houve amplificação de buffers em todos os
quatro cenários principais (até 4,70×), embora a latência tenha caído. O gate
conservador de p95 sem regressão de 10% também falhou em cenários vazios. DB-04
deverá coordenar índice validado e eventual troca de consulta, sem ativá-la
apenas com o ganho medido na variante que já possui o índice.

Antes da promoção do índice, medir os 10.000 inserts RTDS e o custo de persistência
exigido pelo DB-01, com zero erros/perdas, regressão de throughput/p95 de commit
<=10%, bytes adicionais declarados e WAL marginal comparável. Verificar também
os 1.000 upserts agregados e 1.000 deletes previstos no ensaio. Resultados de
fixture não substituem tamanho, duração de construção ou pressão de coleta no
servidor; o ensaio e a decisão operacional permanecem com DB-04.

## Promoção operacional preparada para DB-04

1. Confirmar identidade conforme [SERVER_ACCESS](SERVER_ACCESS.md), SHA, versão
   PostgreSQL, schema e catálogo reais. Revalidar RAM total <13 GB, SSD livre
   >=25%, conexões e pressão de coleta/retenção. Dimensionar espaço adicional,
   temporários e WAL a partir de medidas reais; não aumentar infraestrutura/caps.
2. Registrar janela, orçamento finito e critérios de interrupção. Resolver o gate
   de escrita antes de promover. Não concorrer com outro build ou manutenção
   pesada. Inspecionar índices equivalentes para evitar duplicação, sem remover
   o índice atual de feed/symbol/received_at nem outros objetos existentes.
3. Conferir nome, tabela, expressão, ordem, validade e método do candidato. Um
   índice homônimo diferente ou inválido não satisfaz o contrato. O uso de
   `IF NOT EXISTS` sozinho não valida o índice; a construção concorrente exige
   execução fora de bloco transacional e pode deixar índice inválido após falha.
   Essas restrições constam em
   [CREATE INDEX, PostgreSQL 18](https://www.postgresql.org/docs/18/sql-createindex.html).
4. Executar apenas o arquivo de índice conferido com `psql -X -v ON_ERROR_STOP=1`,
   schema explícito, em autocommit, sem `-1`/`BEGIN` e fora do runner. Proposta
   inicial de sessão de build: `lock_timeout=500ms` e `statement_timeout=10min`,
   sujeitos ao orçamento DB-04. Não alterar timeouts globais ou da aplicação.
   Acompanhar progresso, locks, CPU/RAM, espaço, escrita e lacunas de coleta.
5. Após sucesso, exigir `indisvalid`, `indisready` e `indislive` verdadeiros,
   `indisunique` falso, B-tree e definição exata; medir tamanho. Confirmar o
   plano com binds comparáveis antes de executar apenas SELECT estreito com
   orçamento conhecido. Um plano barato não comprova sozinho a barreira causal.
6. Coordenar a eventual troca do SQL com a disponibilidade do índice e validar
   seleção, buffers, p95, escrita e saúde da coleta na janela DB-04. Registrar
   release e resultado efetivo; build/deploy não equivalem a soak.

Consulta de inspeção, após confirmar que `public` é o schema correto:

```sql
SELECT c.relname, am.amname, i.indisvalid, i.indisready, i.indislive,
       i.indisunique, pg_get_indexdef(i.indexrelid) AS definition,
       pg_relation_size(i.indexrelid) AS index_bytes
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_am am ON am.oid = c.relam
WHERE i.indrelid = 'public.polymarket_rtds_prices'::regclass;
```

Não há migration neste bloco: o runner usa transação única, incompatível com
`CREATE INDEX CONCURRENTLY`. Uma migration futura deve usar o próximo slot livre,
sem reservar número agora nem editar migration aplicada. Em banco populado, ela
deve exigir prebuild concorrente com definição/validade conferidas para não
disparar build bloqueante no deploy; banco novo pode usar criação transacional.
Não inserir manualmente uma versão de schema para simular execução.

## Rollback

Se a consulta tiver sido promovida sob dependência do índice, restaurar primeiro
o SQL anterior em release revisada e verificar a seleção antes de remover o
índice. Se o SQL atual tiver sido preservado, não há rollback de código.
Se o índice degradar a escrita ou a construção falhar, inspecionar novamente o
catálogo e remover somente o objeto confirmado desta operação, em autocommit:
`DROP INDEX CONCURRENTLY public.polymarket_rtds_prices_asof_idx;`.
Sem CASCADE, remoção de dados, repack ou limpeza genérica. Reconciliar qualquer
migration futura de forma forward-only; nunca editar histórico aplicado.

## DB-03B: snapshots em lote adiados por contrato

O DB-01 comprovou Q4 `loadMidsAsOf` como segundo candidato independente: estava
ativa havia **31,299 s**, não latência concluída, e o plano estimava **68.333
linhas** no histórico do token amostrado. Q3 `bookAsOf`, usado como controle,
retornou uma linha em **0,094 ms**, com **seis buffers compartilhados** (três
hits/três reads). Uma execução de Q3 não é p95 nem prova de todos os cortes.

Ambas as consultas limitam somente `received_at`; empates nesse campo não têm
desempate declarado. A RFC-037 pede preservação de desempate e causalidade de
source/received, enquanto adicionar `source_ts <= decisão` ou `snapshot_id DESC`
altera a seleção permitida pelo SQL existente. Em Q4, a mudança pode alterar o
mid histórico utilizado pelo jump breaker. Um novo plano pode escolher outra
linha empatada mesmo sem mudar o texto do ORDER BY; não alegar equivalência
determinística com base em uma execução que escolheu o mesmo empate.

| Opção para revisão | Impacto e custo |
| --- | --- |
| Manter Q3/Q4 e abrir DB-03B com contrato independente | Sem custo adicional de índice/infra; preserva comportamento atual, mas mantém o trabalho de Q4 evidenciado pelo baseline. |
| Definir desempate e política de source_ts, depois reescrever Q4 | Pode permitir N buscas LIMIT 1, mas muda o resultado em empates/source futuro; exige revisão dos efeitos no jump breaker, fixture e nova medição. Índice adicional só se justificado por plano/escrita. |

**Recomendação:** manter Q3/Q4 neste bloco e registrar DB-03B como contrato
independente para revisão posterior. Primeiro tornar explícita a regra temporal
e de desempate; então comparar `LATERAL LIMIT 1` com o índice de token/received
existente. A fixture DB-03B deve ter 100.000 snapshots, lotes de 1/10/100 tokens,
ausentes/duplicados, empates, source futuro, último livro inválido, arrays vazios
e soma ímpar do mid, preservando aritmética inteira. Meta: p95 <=1.000 ms por cem
tokens, >=50% menos linhas/buffers; Q3 p95 <=50 ms e regressão tolerada
`max(10%, 1 ms)`. Este plano não executa DB-03B nem outro prompt.

DB-04 pode começar com os candidatos e este adiamento mensurável documentados
no estado; seu fechamento deve distinguir o acesso RTDS efetivamente promovido
da decisão pendente de Q4. Nem este adiamento nem um deploy comprovam resolução
operacional de Q2/Q4 ou estabilidade de sete dias.
