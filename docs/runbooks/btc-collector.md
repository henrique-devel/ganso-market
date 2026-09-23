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

Os tetos iniciais do coletor são menores que os da política SQL: 512 MiB raw,
768 MiB lógicos totais e 1 GiB físico (tabelas, TOAST, projeções e índices). São
limites de corpus, mantidos também após restart, não uma previsão de duração.
O envelope conservador cabe na margem observada antes da ativação; ajustar só
após medir crescimento real em outra entrega. WAL/duplicação não são bytes lógicos:
a reserva de disco usa alocação real do filesystem e continua independente do teto
de tabelas. Uma transação limitada pode ultrapassar ligeiramente o teto físico;
a reserva adicional evita depender desse teto como proteção exata de disco.

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
progresso, último commit de captura, health individual dos três canais, gaps,
subscriptions, retries, counters e limites. Docker health verifica progresso,
socket e livro/contexto; silêncio de trades permanece explícito no canal e não
prova socket morto. Contexto sem timestamp da fonte conserva qualidade unknown.
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
