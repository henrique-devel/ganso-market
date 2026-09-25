# Ticket BTC manual paper

G2-06.3, `trading.desk.v1` + `trading.commands.v1`, schema 41. A aba inicial
BTC usa os comandos autenticados e a prévia assinada. SIMULAÇÃO, fonte real e saldo
fictício permanecem visíveis. Preços e quantidades chegam em USD6/BTC8; nocional
informado é arredondado para baixo ao quantum do instrumento. O tipo é o regime
fixo da conta (IOC ou passiva), sem somar cenários. Compra abre long, venda abre
short, cancelar libera o restante, encerrar reduz a posição. Aceite não é fill.
O extrato resumido mostra saldo, taxas, funding e posição; não é avaliação econômica.

## Consumidor e limites

O consumidor roda na API existente, no mesmo pool de até quatro conexões, sem
serviço, volume, compra, signer ou estratégia novos. Uma conta manual vinculada
é processada sequencialmente a cada segundo, sem sobrepor ciclos. Duas contas
manuais vinculadas são recusadas pelo limite operacional desta implantação.
Contas desabilitadas continuam tendo reservas, risco e saídas geridas. Heartbeat
com mais de cinco segundos, erro, recovery bloqueado ou lease ausente recusam
novos comandos de envio/fechamento; cancelamento e pausa autenticados continuam
acessíveis. A prontidão do consumidor não certifica frescor: S8 revalida dados.

IOC aguarda um livro observado posterior à latência e então consome somente a
profundidade disponível; o restante é cancelado. Passivas avançam pela fila e
trades observados, com a fidelidade limitada do contrato S5. O stop usa bid para
long e ask para short. Seu disparo persiste em `btc_desk_exits`, cancela aumentos
e gera reduções IOC com proteção na profundidade observada, reiteradas somente
em novos livros até zerar. Pausas por perda diária/drawdown/exposição também
solicitam saída. Liquidação usa S7. Livro ausente/stale não produz fill; HALTED
ou inconsistência não são rearmados automaticamente. Stop não garante perda máxima.

Funding faz no máximo uma consulta pública gratuita por 30 segundos, com timeout
8s, em paralelo ao ciclo de execução. Antes de abrir, a hora corrente precisa de
recibo final liquidado (mesmo sem posição elegível). Um oracle exato de settlement
indisponível permanece pendente e impede novas entradas; a resposta HTTP de contexto
não substitui timestamp/oracle de settlement. Contexto conserva source_timestamp
null e procedência HTTP; livro usa timestamp L2. Warmup de estratégia não é gate
do ticket. Nenhum relógio é inventado e nenhum capital é real.

Recovery e comandos compartilham uma identidade por conta/processo, com lease de
30s, lock, fencing e replay auditado. Após restart, aguardar a concessão antiga
expirar; filas passivas antigas são canceladas por S9. Prévia não escreve.
Duplo clique/retry usa a mesma chave; intenção tentada é preservada em sessionStorage
antes do envio. Se a resposta for incerta, repetir a mesma intenção, inclusive
após login; não abrir outra ordem para tentar compensar uma resposta perdida.

## Ativação explícita no servidor existente

Após CI, merge, migration e deploy seletivo de API/web, conferir coletor, espaço,
quotas, HOLD, pins, schema e saúde conforme os runbooks existentes. Usar SSH com a
identidade fixada em `docs/ops/SERVER_ACCESS.md`. Não imprimir secrets/server.env.
A migration não ativa nada. A ativação autorizada da conta manual IOC é:

```sh
docker compose --env-file deploy/server.env exec -T api \
  node apps/api/dist/desk-activate-cli.js NOME_DO_OWNER ioc
```

O CLI exige owner já existente, metadata real, cria `manual`/`manual:paper:v1`,
gênese idempotente US$ 1.000 e vínculo com chave aleatória não impressa, tudo na
mesma transação. Repetição compatível não altera banca, pausas ou histórico;
owner/regime divergente é recusado. Estratégias base/Jev continuam inativas.
Não há endpoint público de ativação, rearmar ou execução direta.

Verificar heartbeat/lease, GET autenticado, fonte/frescor, estado e saldo fictício
na UI. Os fluxos destrutivos/fixtures são validados somente em PG descartável.
Nenhuma execução produtiva pode ser forçada, remunerada ou apagada para limpar
smoke. Se forem observadas execuções paper reais, os dados persistem com seus
custos/perdas e pins. Rollback preserva schema 41 e ledger: desabilitar admissão
antes de remover o consumidor e não removê-lo com posição/reserva sem gestão.
Coletor e banco não são reiniciados por esta fatia; quotas e guards permanecem.
Amostras curtas de CPU/disco não comprovam sustentabilidade de 7/30 dias.
