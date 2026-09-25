# Ticket BTC manual paper

G2-06.3, `trading.desk.v1` + `trading.commands.v1`, schema 42. A aba inicial
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
recibo final liquidado (mesmo sem posição elegível). O consumidor usa explicitamente
`btc.funding.paper-precut.v2`, aproximação paper descrita abaixo. Ausência de taxa
ou evidência válida permanece pendente e impede novas entradas. Contexto conserva
source_timestamp null e procedência HTTP; livro usa timestamp L2. Warmup de
estratégia não é gate do ticket. Nenhum relógio é inventado e nenhum capital é real.

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
custos/perdas e pins. Rollback preserva schema 42 e ledger: desabilitar admissão
antes de remover o consumidor e não removê-lo com posição/reserva sem gestão.
Coletor e banco não são reiniciados por esta fatia; quotas e guards permanecem.
Amostras curtas de CPU/disco não comprovam sustentabilidade de 7/30 dias.


## Contrato de funding para posições elegíveis

Modelo `btc.funding.paper-precut.v2`, envelope de recibo `btc.funding.v1`, schema SQL
42 (sem migration). O manifesto que congelar uma simulação deve incluir este
modelo, `hyperliquid.context-snapshot.v1`, janela de recebimento 5000ms, taxa final
RATE18, BTC8, USD_PER_BTC6, USD6, arredondamento floor do delta assinado por
conta/hora/posição e regra de empate do corte. Não combinar resultados deste
modelo com settlement exato ou com recibos legados sem distinguir as versões.

- A taxa vem exclusivamente de `fundingHistory` BTC, com `time` preservado inclusive
  milissegundos; não é previsão nem taxa corrente e não se divide novamente por 8.
  A taxa decimal é convertida exatamente para RATE18 (até 18 casas
  decimais), validada contra ±4%/hora antes de converter; excesso de precisão
  permanece `inexact_RATE18`, nunca arredondado ou substituído por zero. O ledger
  admite RATE18 somente no campo rate de funding, além do RATE9 legado; outros
  rates continuam RATE9. O payload original, taxa exata e política ficam pinados.
- O preço é o oracle da última resposta HTTP validada **recebida antes ou no corte**,
  no máximo 5000ms antes, mesma versão de instrumento e origem/parser esperados.
  A busca ordena received_at descendente/object_id ascendente, inspeciona até 16
  registros na janela indexada e escolhe o primeiro válido. Revalida Date, cache
  miss, ausência de Age positivo e RTT até 1500ms. Isso comprova a resposta HTTP,
  **não a idade do preço nem o oracle exato do settlement**. source_timestamp=null,
  quality=unknown e fidelity=paper_approximation_not_venue_settlement são preservados.
  Não usa mark, candle, preço futuro, interpolação nem inferência por premium.
- A posição líquida elegível usa fills com occurred_at estritamente anterior ao
  `fundingHistory.time`. Fill na mesma unidade de milissegundo mantém
  `ambiguous_cutoff_order`; fechamento anterior remove exposição, posterior não
  remove a obrigação. A chegada tardia da taxa debita/credita a posição histórica.
- Sem posição elegível, pode liquidar sem preço. Com posição e sem snapshot válido,
  `missing_pre_cut_snapshot` bloqueia a cobertura. Após gap, reinício ou expiração
  da retenção, uma resposta atual nunca sana um corte antigo. Nem todo bloqueio
  pode ser resolvido automaticamente; nenhum ajuste manual foi ativado aqui.
- O recibo guarda model_version, rate, price_evidence (ID, received_at, receipt_age_ms,
  source_timestamp, quality e fidelity), oracle_usd_raw, posições e deltas. A causa
  do evento aponta à evidência financeira pinada, com dependência do contexto.
  A UI expõe modelo, motivo e limitação. Saldo, risco diário e recovery usam o mesmo
  delta USD6. Uma pausa REDUCE_ONLY já provocada por pendência continua exigindo
  rearme explícito conforme S8, mesmo após restaurar a cobertura; funding não
  rearma risco ou HOLD. Taxa positiva cobra long/credita short; negativa inverte os sinais.
- Identidade de operação inclui modelo/hora/resposta/ID de contexto, impedindo
  crescimento de recibos pendentes idênticos. Liquidação é única por conta/hora;
  conflito preserva caixa/evidência e impede novas entradas. Recibos v1 já assentados
  não são reprocessados; pendência v1 pode receber novo recibo v2 explícito quando
  a observação final continua igual. Nenhum evento histórico é reescrito.

### Fonte e limites verificados em 25/09/2026

A [API pública oficial](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
expõe coin/fundingRate/premium/time no histórico e oraclePx sem timestamp do preço
no contexto. A [fórmula oficial](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)
usa posição × oracle × taxa, por hora. Não há nesses contratos evidência suficiente
para afirmar o preço exato de settlement. A consulta gratuita observada cobriu 21
horas consecutivas, com 8 taxas de 10 casas e timestamps de corte deslocados da hora
por 1–65ms. Isso demonstra incompatibilidade RATE9; não prova cobertura histórica
completa ou disponibilidade futura. Os [arquivos históricos oficiais](https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data)
têm custo de transferência, atualização mensal aproximada e gaps possíveis; não
foram usados. Nenhuma fonte paga ou nó adicional foi contratado.

Reversão de aplicação exige versão capaz de ler funding RATE18 e este modelo:
voltar a binário anterior a v2 após um evento RATE18 tornaria recovery incompatível.
Preservar ledger/schema/pins e gestão das posições; preferir correção adiante.
Os testes de posição elegível usam fixtures HTTP e de taxa declaradas em PostgreSQL
descartável; a implantação não cria trades para fabricar aceite produtivo.
