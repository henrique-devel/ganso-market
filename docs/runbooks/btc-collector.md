# Coletor público BTC — G2-04.4

O processo `btc-worker` coleta somente metadados, livro, trades e contexto públicos
Hyperliquid BTC. Não importa estratégia, executor, signer ou carteira. Configuração
padrão desabilitada e escala zero; ativação exige configuração paper explícita.

## Admissão no host existente

Antes de ativar, conferir identidade SSH em `docs/ops/SERVER_ACCESS.md`, versão
instalada, migrations 0027/0028, health da API, HOLD/pins e quiescência legada.
Usar Compose efetivo com `deploy/server.env`, incluindo o overlay de contenção.
Conferir memória/CPU atuais e limites combinados com `check_compose_policy.validate`:
com um coletor são 2048 MiB, 3 CPUs, 7 conexões máximas mais 8 reservadas, em host
existente de 8 CPUs/15,2 GiB. Pool do coletor: máximo 2; consultas: 6 s, transações
de retenção: statement 5 s/lock 2 s. Não ampliar host, quotas ou pools para caber.

Medir `df -B1` no mount real de PostgreSQL. Menos de 25% livre proíbe persistência.
A implementação exige ainda 1 GiB de reserva **acima** desse piso, antes de cada
captura e antes de fechar barras. Criar diretório vazio
`/var/lib/ganso/btc-capacity` e comparar seu `stat.st_dev` com o Source do volume
PostgreSQL em `docker inspect`. Ambos precisam estar no mesmo filesystem.
Montar somente esse diretório vazio, read-only, em `/capacity`; nunca usar
filesystem da imagem/overlay como evidência de espaço do banco.

Os tetos internos desta correção são **4 GiB raw, 6 GiB lógicos totais e
4 GiB físicos**, incluindo o corpus anterior; as quotas SQL continuam 10/12 GiB.
O piso de 25% mais 1 GiB, o limite de conexões e a parada terminal continuam
independentes. Não há configuração para ampliar esses tetos pelo operador.

Justificativa de admissão (25/09/2026 00:20 UTC): filesystem 322.302.373.888 B,
94.190.473.216 B disponíveis; corpus 536.909.884 B raw, 798.752.769 B lógicos,
473.636.864 B físicos. A margem acima do piso + reserva era 12,54 GB; crescer
até o teto físico permite no máximo outros 3,82 GB em tabelas/índices, deixando
aproximadamente 8,72 GB além do piso/reserva para WAL e demais alocações. Essa
conta não reserva disco: o guard mede o filesystem antes de cada transação.
Uma transação limitada pode ultrapassar ligeiramente o teto físico, mas não há
loop de reinício nem expansão de volume. Crescimento externo pode parar antes.

A captura anterior de 08:14 a 14:01 de 23/09 acumulou cerca de 92,7 MB raw/h e
138 MB lógicos/h (média de calendário, incluindo interrupções). Repetir aquela
média daria aproximadamente 40 h adicionais antes dos novos tetos raw/lógico.
Ela **não** prevê a cadência atual: snapshots de livro são mais frequentes e há
mais captures. Planejar apenas uma janela operacional de até 24 h, reavaliando
os deltas reais e recusando novos experimentos se a janela necessária não couber.
Não existe promessa de 7 dias: com HOLD, crescimento monotônico sempre esgota
a capacidade. Não esperar nem declarar maturidade de 7/30 dias nesta entrega.

`growth` expõe raw/lógico/físico/disco, duração e, depois de 60 s, taxa/hora e
horizonte linear separado por teto. Usar o menor horizonte positivo, com margem
para picos; queda/ausência de crescimento não significa duração infinita.
O estimador é diagnóstico, jamais autoriza ignorar o guard. Medir por amostras
separadas e confrontar especialmente WAL/alocação do host com as tabelas BTC.

Manter `btc-paper-v1` em HOLD e suas quotas SQL de 10/12 GiB; TTL raw 7 dias,
barras 12 meses, logs 14 dias, pins permanentes e dependências prevalecem.
Este worker não executa poda nem altera a política. Pode parar antes do TTL;
retomar não remove dados nem zera ocupação. Nenhum descarte legado é autorizado.

## Ativação seletiva

Após merge/checks/deploy e preflight aprovados, criar fora do checkout
`/etc/ganso/btc-worker.json` com `schema_version: 1`, `execution_mode: "paper"`,
`enabled: true`. Criar `/etc/ganso/btc-collector.compose.yml`:

```yaml
services:
  btc-worker:
    scale: 1
    volumes:
      - /etc/ganso/btc-worker.json:/etc/ganso/btc-worker.json:ro
      - /var/lib/ganso/btc-capacity:/capacity:ro
```

Adicionar esse caminho ao `COMPOSE_FILE` existente em `deploy/server.env`, sem
remover o overlay legado. Validar novamente o modelo efetivo e comparar IDs/início
de PG/web/nginx antes/depois. Executar somente:

```sh
docker compose --env-file deploy/server.env build btc-worker
docker compose --env-file deploy/server.env up -d --no-deps --no-build --wait btc-worker
```

O serviço não publica portas; rede edge permite apenas a saída pública já usada
pelos adaptadores. `restart: no` é intencional: recusa terminal não vira loop de
reinício e não retoma coleta sem intervenção. Deploy atualiza apenas serviços
ativos e permite este coletor; não ativa coletor parado nem qualquer legado.

## Checagem breve e parada

`docker compose ... exec -T btc-worker cat /tmp/ganso-btc-health.json` informa
progresso, último commit, canais, gaps, retries, contadores, limites e
`consumer_freshness` dos últimos dados **confirmados no banco**. Docker health
mede processo/socket/entrega por canal; admissão financeira depende separadamente
de livro até 2 s e mark até 5 s. Um processo saudável não garante dado admissível.
A API reavalia idade e gap em cada consulta/transação, sem cache de frescor.

## Captura e procedência temporal

Política `btc-current-state.v1`: trades observados integralmente por WebSocket;
livro REST `l2Book` completo top-20 a cada ciclo (mínimo 1 s entre inícios,
descontando o tempo de consulta/gravação da espera, sem rajada de compensação); contexto
REST `metaAndAssetCtxs` no máximo a cada 2 s. Os snapshots intermediários ainda
não expostos a consumidores podem ser agrupados, com contagem persistida em cada
capture. Não são descartados trades nem objetos já persistidos/referenciados.
O livro continua finito, sem garantia de fila contínua; replay de snapshots não
prova cada mudança intrassegundo. Barras continuam derivadas de trades completos
observados, com gaps/warmup explícitos. Isso reduz escopo de captura futura sem
poda, remoção de arestas ou reclassificação de evidência financeira.

`l2Book.time` é preservado como timestamp da fonte. O WebSocket observado tinha
intervalos maiores que 2 s; consultar L2 permite obter o snapshot atual sem
renomear um timestamp antigo. Se a fonte devolver tempo antigo, o livro continua
stale e novos fills/intents executáveis são recusados.

`activeAssetCtx` e o corpo de `metaAndAssetCtxs` não têm horário de atualização
do mark. Para o novo snapshot, **`source_timestamp` permanece null e a qualidade
de tempo do evento permanece unknown**. Preservam-se contexto BTC original,
hash, parser, horário de início/fim da consulta, `Date`, `Age` e `X-Cache`.
O contrato financeiro distingue `freshness_timestamp` e
`timestamp_basis=http_response_date`: é frescor da resposta de estado atual,
**não** prova do instante em que o preço mudou na cadeia. Não há fallback de
mark para mid/oracle ou cópia do timestamp do livro.

Aceitar essa observação requer HTTPS oficial sem redirect, `Miss from cloudfront`,
Age ausente/zero, Date válido, resposta de até 256 KiB e 1,5 s, coerência de
relógios (resolução HTTP de 1 s), BTC e versão de metadados compatíveis. O relógio
HTTP envelhece até 5 s; contexto legado WS sem tempo continua degradado.
Resposta ausente, cache, timeout, incompatibilidade ou tempo inválido encerra a
coleta; nenhum retry irrestrito ou timestamp sintético. Limites de idade de risco
permanecem 2/5 s, incluindo recepção, capture e revalidação de gap.

O worker usa uma subscription pública (trades) e no máximo 60 consultas L2/min
(peso 2), 30 contexto/min (peso 20), mais metadata/min (peso 20): teto de 740 do
limite público de 1200/min/IP, sem cliente privado, credencial ou API paga.
Fontes oficiais revalidadas nesta correção:
[WebSocket](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions),
[Info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals),
[limites](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits),
[Date HTTP](https://www.rfc-editor.org/rfc/rfc9110.html#name-date).

Barras/warmup são consultadas por `readBtcMarketView`; início parcial, restart,
silêncio e gap continuam incompletos. Warmup pendente não é falha do coletor.

A cada 30 s o log limitado expõe deltas de bytes lógicos, alocação física, espaço
consumido no filesystem e WAL **do cluster inteiro** (não atribuir todo WAL ao
BTC). Comparar amostras, CPU/memória reais e consumo SQL; captura curta não prova
sustentabilidade de 7/90 dias nem ausência futura de gaps.

`docker kill --signal=USR1 <ID exato do btc-worker>` provoca uma reconexão pública
pelo caminho normal, com gap/revalidação e retry limitado; não mexe em PG/rede do
host. Usar uma vez na aceitação, observar aumento de retries e retomada por canal.
Os três retries são limite por sessão; esgotamento encerra o worker. Metadados
são reconsultados a cada minuto; incompatibilidade/mudança de versão interrompe
coleta para não misturar regras antigas e novas.

Falha/quota/espaço/buffer excedido encerra admissão, fecha socket e publica razão,
`gap_open=true`, último capture confirmado e quantidade do lote sem confirmação.
Não reenviar lote rejeitado como completo; restart usa sessão nova e o cursor
persistido registra descontinuidade. O status terminal fica no filesystem do
container parado e nos logs; nenhum log de payload/segredo é necessário.

Para contenção/rollback: `docker compose ... stop btc-worker`, manter restart=no,
configurar `enabled:false` e escala zero no overlay. Não apagar dados, pins,
volumes nem migrations; não reiniciar Polymarket. Voltar imagem do coletor somente
quando compatível com schema, nunca reativar o placeholder pré-G2-04.4.
