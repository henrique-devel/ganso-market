# Primeiro manifesto BTC paper — contrato v1

G2-07.1 congela a hipótese `btc.baseline.trend.v1`: continuação de tendência em
contexto 1 h, decisões em barras 15 min fechadas e saída solicitada em até 6 h.
É uma hipótese sem alpha ou rentabilidade validados, escolhida sem busca de
parâmetros/backtest. Este contrato e `config/trading/baseline.json` são normativos
em conjunto; divergência invalida o manifesto. A configuração contém o SHA-256
dos bytes UTF-8 deste documento. O validador fixa também o fingerprint da
configuração inteira. Alterar regra, custo, arredondamento ou texto normativo
exige nova versão e novo registro prospectivo, preservando tentativas anteriores.

Baseline e Jev permanecem **desligados**. Não há scheduler, ordem, conta, gênese,
chamada de IA ou alteração de runtime criada por carregar/validar o manifesto.
Ativação pertence a outra fatia. Somente paper; nenhuma compra ou aumento de quota.

## Registro, identidade e tempo

Antes de observar resultados, registrar de forma append-only: experiment_id,
conta/dono, cenário independente, manifest fingerprint, policy_version, SHA de
código implementador, instrument_version, ID/hash da metadata e taxas, modelos
de barras/execução/risco/contabilidade/valuation/funding e `start_at` UTC. Cada
conta recebe somente sua gênese fictícia idempotente USD6 `1000000000`; não somar
cenários nem reaproveitar/resetar contas ou âncoras. IDs operacionais privados
pertencem aos registros internos, não ao manifesto público.

Canonicalização `sorted-json-safe-integers.v1`: objetos JSON simples com chaves
ordenadas lexicograficamente por UTF-16, arrays na ordem original, strings via
JSON.stringify, somente inteiros seguros (sem -0), booleanos/null; sem whitespace.
SHA-256 sobre UTF-8, prefixo `sha256:`. Números financeiros são strings de inteiros.
Sem exclusões do hash, timestamps voláteis ou fingerprint autorreferente no JSON.
JSON com chaves duplicadas não é aceito na ingestão; o arquivo versionado deve ser
lido por parser que as rejeite ou por revisão do artefato canônico validado no CI.

Na ativação futura, `start_at` é a próxima fronteira UTC de 15 min estritamente
posterior ao registro. Janela prospectiva `[start_at, start_at + 30 dias)`; warmup
anterior pode formar indicadores, nunca PnL anterior ou seleção de parâmetros.
O registro é congelado mesmo se faltarem dados. Não deslocar o início para obter
resultado favorável. Sem replay de entradas perdidas após restart.

Uma decisão por conta/experimento/policy/fingerprint/instrument_version/barra T:
chave SHA-256 do array JSON desses campos, nesta ordem, com `T` = end_at UTC ISO
da barra 15 min. `decision_at` é o primeiro processamento observado em
`[T+10000ms,T+60000ms)`. Fora disso registrar `missed_decision_window`; nunca usar
o relógio do replay. Depois de gravada, repetir retorna o mesmo resultado.
Inputs selecionados são os persistidos e recebidos até decision_at, com ordem
determinística, IDs/hashes pinados. Não incorporar correção tardia à mesma decisão.
Outra revisão de instrumento interrompe entradas; não misturar versões no warmup.

## Barras, warmup e estados

Usar apenas `trading.closed-bar.v1`/`btc-observed-bars.v1`, BTC Hyperliquid mainnet,
trades observados do WS (`hyperliquid.feed.v1`). Barras 1 h são construídas da
mesma fonte de trades, não de candles públicos nem de 15 min interpolados.
Intervalos UTC `[start,end)`, lateness 10000ms; exigir end+lateness <= decision_at
e closed_at <= decision_at. Nenhuma barra em formação/futura, OHLC nulo, preço
não positivo, zero trades ou versão divergente participa.

Exigir as 12 barras 1 h e 15 barras 15 min consecutivas mais recentes elegíveis,
com mesma instrument_version da metadata congelada. A última 1 h termina em
floor((decision_at-10000)/3600000)*3600000; a última 15 min termina em T. Usar
`barWarmup` e validar timestamps/OHLC/input IDs. Qualidade admitida:
`observed_no_known_gap`, reasons vazio, continuity **unproven**. Isso indica
cobertura observada; não prova completude da venue. Gaps, restart e truncamento
reiniciam a janela elegível sem apagar dados. Nunca preencher barra ausente.

Precedência para entradas (registrar também todas as causas secundárias):

1. `disabled`: ativação ausente; `missed_decision_window`: janela perdida.
2. `data_unavailable`: barra ausente no meio, incompleta, inválida, metadata
   divergente ou evidência ausente/stale de livro/contexto/funding/recovery.
3. `warmup`: sequência saudável disponível desde o início observado ainda menor
   que 12/15; não é neutralidade. Sem nenhuma evidência, usar data_unavailable.
4. `position_managed`: posição/reserva/saída em aberto; gerir saída, sem aumento.
5. `neutral`: dados e warmup válidos, mas condições estritas do sinal não satisfeitas.
6. `candidate_long`/`candidate_short`: regra satisfeita; candidato não é ordem.
7. `rejected`: candidato com direção e causa preservadas (risco/pausa/HOLD,
   custo, tamanho mínimo, proteção de preço, evidência perdida ou veto Jev).

Saídas não dependem de warmup, neutralidade, Jev ou permissão de novas entradas.

## Regra determinística

SMA4/SMA12 são médias aritméticas dos últimos 4/12 closes 1 h. Não arredondar para
comparar: usar somas inteiras e produtos cruzados. Tendência long quando último
close 1 h > SMA4 > SMA12; short quando último close 1 h < SMA4 < SMA12. Igualdade
em qualquer comparação é neutra. Não se exige cruzamento recente das médias.

Na barra 15 min recém-fechada, C=close e O=open. Long exige tendência long,
C > high da barra 15 min anterior e C > O. Short exige tendência short,
C < low anterior e C < O. Sem filtro adicional de volume, IA ou frequência mínima.

ATR14 é a média simples (não Wilder/EMA) dos 14 true ranges mais recentes de
15 min, incluindo a barra de decisão. TR_i=max(H_i-L_i, abs(H_i-C_(i-1)),
abs(L_i-C_(i-1))). São necessários 15 candles por causa do close anterior.
ATR em USD_PER_BTC6 = ceil(soma(TR)/14); D=2*ATR. ATR zero rejeita
`zero_volatility`. Stop inicial long=C-D, short=C+D, arredondado para fora
(long para baixo, short para cima) até o preço válido mais próximo da metadata.
Stop <=0 ou incompatível com a banda de entrada rejeita; nunca estreitar D.

Banda de entrada [L,U]: L=ceil_valid(C*9990/10000),
U=floor_valid(C*10010/10000). `valid` respeita quantum, máximo de casas,
significant digits e exceção de preços inteiros de `assertHyperliquidOrder`.
Exigir L<=U, stop<L para long, stop>U para short. Compra usa limite U;
venda usa limite L e cap de reserva U. Na admissão e antes da execução,
best ask (long) ou best bid (short) deve estar em [L,U], stop ainda não disparado,
e todos os gates de evidência/risco devem passar. Mudança invalida o candidato;
não recalcular C/ATR/stop/tamanho para persegui-la.

Uma posição líquida por conta, sem piramidagem. Um IOC por candidato, parcial
permitido e restante cancelado; não completar a parcela faltante no mesmo sinal.
Stop permanece o do candidato para todos os fills. `opened_at` é occurred_at do
primeiro fill, não a aceitação nem cada parcial; deadline=opened_at+21600000ms.

## Tamanho, execução e custos

Dinheiro USD6, quantidade BTC8, preço USD_PER_BTC6; sem float. Q=100000000,
F=1000000000000 para fees em bps. Todas as parcelas positivas de risco/custo são
arredondadas separadamente para cima em USD6; quantidade sempre para baixo ao lot.
Patrimônio E é o positivo utilizável de `btc.valuation.v1`, incluindo PnL não
realizado, taxas/funding uma vez. Não descontar reservas do patrimônio duas vezes.

Para quantidade q, stop S, cap U e floor L, calcular exatamente:

- `core(q)=ceil(q*loss/Q)+ceil(q*U*5/F)+ceil(q*max(S,U)*5/F)`, em que loss=U-S
  long e S-L short. É `plannedRisk` de `btc.risk.v1` com fee_bps=5.
- `exit_slippage(q)=ceil(q*S*10/F)`: provisão de 10 bps na saída por stop.
- r=max(abs(última taxa final da hora corrente, RATE18),100000000000000),
  piso de planejamento 1 bp/h. `funding(q)=7*ceil(q*max(S,U)*r/10^26)`.
  Sete cortes provisionados acomodam fronteiras em ms; atraso/gap pode exceder
  esse horizonte. Não é previsão, teto da venue ou débito de ledger.
- `budget(q)=core(q)+exit_slippage(q)+funding(q)`. Nunca contar funding favorável
  futuro como crédito antecipado. Taxa final ausente ou cobertura pendente rejeita.
- `cost(q)` são as duas fees, exit_slippage e funding acima. Rejeitar
  `cost_veto` quando cost(q)>=ceil(q*D/Q), sem alegar que D seja lucro esperado.

Escolher o **maior múltiplo de lot** q>0 que caiba simultaneamente em
budget(q)*10000<=E*25, exposição bruta (posição + reservas + candidato, pelo maior
de mark e U)*10000<=E*2500, e saldo disponível após margem isolada 1x e fee
reservada, conforme `reservationHold`/S3. Busca inteira monotônica é permitida;
não aumentar q para atingir mínimo. Após dimensionar, aplicar cost_veto e
`assertHyperliquidOrder` em L/U/stop e mínimo de nocional com L. Se q=0 ou abaixo
do mínimo: `size_below_minimum`; não abrir uma ordem menor incompatível. Revalidar
núcleo de risco/reservas sob lock; mudança de saldo que invalide q rejeita sem resize.

Núcleo sempre prevalece: exposição 25%, risco planejado 0,25%, pausa diária 1,5%
desde âncora UTC ajustada por fluxos, drawdown 5% desde máxima por conta.
NORMAL/REDUCE_ONLY/HALTED, HOLD, ledger/recovery e rearme explícito são preservados;
não resetar banca/pausas para sinais. Stop não garante perda máxima.

Modelo `btc.ioc.v1`, latência mínima simulada 1000ms, TTL 5000ms a partir de
decision_at. Somente livro observado **posterior** à latência, idade <=2000ms,
profundidade top20 disponível e líquida do consumo da própria conta; nenhuma
extrapolação além dela. Revalidar mark/contexto <=5000ms, conexão, metadata,
funding e risco. Não substituir por close de candle, mark ou mid para fabricar fill.
Book pode ser WS ou snapshot HTTP validado pelos parsers atuais; preservar origem.

Taxa taker congelada RATE9 `450000` (4,5 bps), tier público base sem descontos,
account_effective_fee=null; planejamento 5 bps/ponta. A metadata pinada deve
concordar; mudança exige revisão/novo registro, não fee zero nem alteração silenciosa.
IOC cobra ceil da taxa acumulada por ordem, alocando-a aos fills conforme S4.
Spread/slippage já realizados estão no preço por nível: não debitá-los novamente.
Provisões de risco não são custos realizados. Sem passivas neste baseline.

## Funding e contabilidade compatíveis com a base

`btc.funding.paper-precut.v2`, envelope `btc.funding.v1`: final fundingHistory BTC,
RATE18 exata (até 18 casas, limite absoluto 4%/hora), sem dividir por 8. Cutoff é
`fundingHistory.time` original incluindo ms. Posição histórica por conta/posição
com fills estritamente anteriores; empate em ms fica `ambiguous_cutoff_order`.
Taxa atrasada usa exposição histórica, mesmo após encerramento.

Oracle da última resposta HTTP validada recebida <=cutoff e em [cutoff-5000,cutoff],
parser `hyperliquid.context-snapshot.v1`, mesma versão de instrumento. Ordenação
received_at DESC/object_id ASC, no máximo 16 candidatos, primeiro válido. Revalidar
Date/cache miss/Age não positivo/RTT<=1500ms como no parser. source_timestamp=null,
quality=unknown, fidelity=`paper_approximation_not_venue_settlement` obrigatórios.
É aproximação paper, **não oracle exato do settlement nem idade comprovada do preço**.

Delta USD6=floor(-q_assinada_BTC8*oracle_USD_PER_BTC6*rate_RATE18/10^26), uma vez
por conta/hora/posição. Taxa positiva debita long e credita short. Ausência de taxa,
snapshot válido ou precisão >18 permanece pendente, nunca zero; sem exposição
elegível pode liquidar sem preço. Recibos/pins/idempotência/replay são os existentes,
sem reescrever assentamentos antigos. Não combinar versões/fidelidades nos resultados.
REDUCE_ONLY anterior não rearma quando funding volta. Ver contrato detalhado em
[ticket BTC](../runbooks/btc-manual-ticket.md#contrato-de-funding-para-posições-elegíveis).

Colateral USDC e preço de referência USD (oracle cotado USDT) usam hipótese de
paridade numérica explícita, não conversão FX ou proteção de depeg. Perp não compra
spot: patrimônio=saldo de colateral+PnL não realizado; margem é reserva, não despesa.
Ledger `btc.ledger.v1`, reservas `btc.reservations.v1`, margem `btc.margin.v1`
e valuation atuais continuam soberanos. Marcação de encerramento usa livro
executável; manutenção/liquidação usa contexto mark/oracle com suas limitações.

## Saídas e prioridade

Gerir a cada ciclo/livro observado, inclusive fora das barras de decisão:
inconsistência/HALTED exige reconciliação sem inventar fill; liquidação S7 tem
prioridade; pausa de risco/exposição e stop solicitam redução persistente antes
da saída temporal, seguida da saída por tendência. Guardar todos os motivos.
Stop dispara em bid<=S para long, ask>=S para short. Saída temporal dispara em
now>=deadline inclusive; não espera a próxima barra nem reinicia após restart.
Em decisão com contexto 1 h válido, sair do long quando a tendência long deixa
de existir e do short quando a short deixa de existir (inclusive neutralidade).
Sem take-profit, trailing stop ou inversão na mesma decisão.

Ao disparar, persistir pedido de saída, cancelar reservas de aumento e tentar
IOC reduce-only pela profundidade observada, latência/TTL iguais aos de entrada.
Limite da redução é o pior preço válido disponível no lado de fechamento do top20,
sem inventar níveis; repetir remanescente só em novo livro após fim/cancelamento
do IOC anterior, sem ordens concorrentes. Preservar stop/deadline/motivo até zerar.
Esse limite não garante fechar em 6 h: sem livro fresco ou depth suficiente,
`exit_pending` e atraso ficam visíveis. Gaps atravessando stop/liquidação tornam
perda incerta e episódio inconclusivo, nunca uma saída retroativa no preço do stop.
Nova entrada só em barra posterior à do último encerramento e depois de zerar
posição/reservas; perdas e pausas continuam exigindo as regras do núcleo.

## Referências e Jev

Caixa sem remuneração: cenário analítico independente de USD 1000, sem exposição,
taxas, funding ou juros; retorno de trading zero. Custos operacionais aparecem
separadamente, nunca como gasto da banca fictícia.

Referência principal `passive_perp_25_analytical.v1`: USD 1000 próprios fictícios,
long inicial de até USD 250 (25%) em perp 1x isolado, comprado uma única vez com
IOC/custos/depth/latência idênticos, em start_at (TTL 5s). Quantidade ao lot para
baixo, cap 10 bps sobre best ask de start_at; livro/metadata/funding ausentes ou
sem fill deixam referência unavailable, sem mover retrospectivamente start_at.
Parcial permanece parcial. Manter quantidade sem rebalancear/repor até o fim da
janela; encerrar por IOC observado, registrando atraso/incompletude. Funding v2,
fee, marcação e liquidação S7 incluídos. É cálculo contrafactual, nunca uma conta
executável nem caminho para contornar risco. Não obedece stop/6 h/pausas da
estratégia: exposição pode desviar de 25% e perdas exceder limites da estratégia;
mostrar esses desvios e diferenças de risco. Se virar conta operante, exige outro
contrato com núcleo soberano. Não transferir patrimônio entre cenários.

Spot não é implementado/exibido nesta versão: perp/funding não representa posse
de BTC. Uma referência spot futura exige fonte/preço/custos próprios e rótulo
distinto, sem funding e sem tratar preço perp como fill spot. Sem referência 100%.

Jev é somente contrato de filtro **desativado**, orçamento real autorizado nesta
versão USD 0, sem credencial/modelo/prompt provisionados, sem chamadas. Baseline
nunca espera Jev. Quando outra entrega registrar provedor/prompt/modelo, preço,
teto já provisionado e ativação própria antes da observação, no máximo uma chamada
por candidato: permite ou veta exatamente o mesmo candidate_id, lado, quantidade,
stop e saída propostos pelo baseline. Não redimensiona nem altera alavancagem.
A conta variante é independente; se não puder aceitar exatamente q pelos seus
dados/risco/saldo/posição, rejeita. Resposta ausente, inválida, timeout ou custo
sem cobertura veta só a variante dentro do deadline original, nunca o baseline.
Persistir inputs/resposta/modelo/custo/hash; replay usa resposta capturada, sem
consultar IA sobre passado. Sem variante ativa, resultado Jev = unavailable,
nunca retorno zero ou prova de contribuição. Proposta de US$5 no PRD não autoriza gasto.

## Avaliação prospectiva predefinida

Sem treino/calibração neste experimento. Primeiro diagnóstico aos 30 dias corridos
registrados, sem aguardar nesta fatia e sem frequência mínima de trades. Reportar
por cenário e dias/episódios: retorno líquido, drawdown de patrimônio (inclui
não realizado), tempo/exposição média e máxima, giro, decisões por estado, fills,
cancelamentos, slippage observado, fees, funding, IA, disponibilidade, vetos,
saídas atrasadas, gaps e dados pendentes. Nunca somar cenários como um portfólio.

Retorno de trading=(patrimônio final-gênese-fluxos)/gênese, fluxo externo nesta
versão proibido; custos financeiros já no ledger contam uma vez. Separar custos
operacionais reais alocados: custo incremental direto ao cenário; custo comum
provisionado dividido igualmente apenas entre os cenários de estratégia ativos
no intervalo, não referências analíticas/manual. Se valor real é desconhecido,
retorno após operação=unavailable, não usar zero. Sem compra adicional.

Para avaliação econômica conclusiva exigir 30 dias, >=95% das 2880 janelas de
decisão com inputs elegíveis (warmup/data_unavailable/missed contam indisponíveis),
zero episódio com perda incerta e zero pendência de ledger/funding/valuation nos
pontos comparados. Posições abertas no limite da janela são marcadas/fechadas com
evidência real, despesas de saída e atraso separados; se insuficiente, inconclusivo.
Zero operações é resultado válido e inconclusivo para a hipótese de trading.

Sem promoção automática/live. Se invariantes falharem: rejeitar prontidão técnica
e reconciliar; não apagar perda. Com dados insuficientes: inconclusivo/continuar
observando, sem mudar parâmetros. Com dados suficientes: retorno após custos <=0
rejeita suporte econômico inicial; positivo mas <= caixa ou perp25 recomenda nova
hipótese/observação; positivo e superior às duas referências permite apenas
continuar paper, nunca declarar alpha. Referência unavailable torna comparação
inconclusiva. Nenhuma estatística por milhares de ticks correlacionados: reportar
dias/episódios e tamanho da amostra; esta v1 não usa teste de significância ou
intervalo de confiança como critério de promoção. Mudança exige novo experimento.

## Exemplos manuais normativos (sintéticos, não desempenho)

Nos exemplos de preços inteiros válidos, SMA4 usa os quatro valores finais.

| Caso | Inputs independentes | Resultado esperado |
| --- | --- | --- |
| Long | Closes 1 h: 8×98000, depois 99000, 99200, 99400, 99600; SMA4=99300, SMA12=98433⅓; 15 min O=99700, C=100000, high anterior=99900 | Tendência e candidato long; ATR14=500 dá D=1000, stop=99000, banda [99900,100100] |
| Short | Closes 1 h: 8×102000, depois 101000, 100800, 100600, 100400; SMA4=100700, SMA12=101566⅔; O=100300, C=100000, low anterior=100100 | Tendência e candidato short; ATR14=500 dá stop=101000, mesma banda |
| Neutro | 12 closes 1 h=100000, cobertura completa | Médias iguais: neutral, sem ordem |
| Warmup | Somente 11 barras 1 h saudáveis consecutivas desde início; 15 de 15 min válidas | warmup, sem confundir com neutro |
| Gap | 12 barras 1 h, uma incomplete/capture_gap | data_unavailable, mesmo se preço satisfaz sinal |
| Prazo | Primeiro fill 12:15:12.345Z, último parcial 12:15:13Z; now 18:15:12.344Z/18:15:12.345Z | Sem saída temporal / saída temporal solicitada no limite; parcial não prorroga |

ATR de exemplo: 15 barras com close 100000, high 100250, low 99750 (14 TR=500)
produzem ATR=500. Essa fixture de ATR é separada das fixtures de rompimento acima.
Para q=0,001 BTC, r=1 bp/h, long: core=USD1,200100, slippage=0,099000,
funding=0,070070, total=1,369170; short: core=1,200550, slippage=0,101000,
funding=0,070700, total=1,372250. E=1000 passa; q=0,002 excede USD2,50 e rejeita
apesar de exposição <25%. Com lot=0,00001, maior q por risco é 0,00182 em ambos
(long USD2,491895; short USD2,497495), supondo saldo/metadata/gates válidos.
Custos não são debitados em bloco: ledger usa somente fills/fees/funding reais.

Fontes oficiais consultadas em 25/09/2026: [fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)
e [funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding).
Os números de provisão, médias, ATR e avaliação são decisões desta hipótese;
não alegações da venue. A captura curta existente não comprova 7/30 dias.
