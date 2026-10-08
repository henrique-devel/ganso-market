# Risco e dimensionamento JEV — JE05

`btc.jev-risk.v1` é separado de `btc.risk.v1`. Paper e stress mantêm vida
financeira própria; o piloto usa a identidade singleton live de JE02. A migration
0054 não cria contas, eventos, dinheiro, configuração nem executor.

O checkpoint usa o ledger JEV completo e os originais de mark/book/capture.
Fees, funding assinado e PnL aberto entram na equity; JEV e infraestrutura não
existem nessa base de cálculo. O HWM só cresce. O piso é HWM − US$12,50: um pico
de US$270 fixa US$257,50, incluindo depois de restart e troca de perfil.
O gatilho diário é 2% da equity efetiva de início do UTC, e não do saldo posterior.
Sem evidência de meia-noite com posição aberta, a admissão permanece pausada.

Funding, fill, fee, checkpoint, reconciliação e supervisor usam primeiro o lock
de `jev_accounts`. O writer financeiro observa risco antes e depois da transação
atômica. A reconciliação é vinculada à sequência do ledger e dura no máximo 2s;
uma sequência nova a invalida. O rollover preserva HWM/DD e só rearma a pausa
diária anterior quando flat, reconciliado, fresco e sem bloqueio global.
Pausa gera `cancel_requested`, preservando a reserva até reconciliação da venue.
O checkpoint persistente solicita fechamento; reduções IOC continuam disponíveis
sem depender de JEV. JE06/JE07 implementarão consumo, execução e agendamento.

`sizeJevEntry` busca o maior múltiplo válido de lote, arredondando quantidade para
baixo e cada custo para cima. Soma distância de 2ATR, tolerância nativa integral
de 10%, duas taxas e funding planejado de seis horas, tudo dentro de 1% da equity.
A exposição de entrada fica dentro de 50%, sem rebalanceamento por valorização.
Stop é arredondado para a entrada; pior preço nativo é arredondado contra a conta.
Stress dobra só trading fees. Crédito futuro não aumenta o lote; funding/fee
desconhecidos, ATR inválido, mínimo ou grade incompatíveis recusam a entrada.
Custos planejados não debitam o ledger. O plano/hash mantém uma única quantidade
na decisão dimensionada, reserva e ordem; recusa posterior ao checkpoint preserva
a observação e os pedidos de cancelamento. Um retry de reserva cancelada não gera
uma nova ordem. O executor futuro deve exigir status `reserved` e validar fill
no preço maker e quantidade restantes antes de consumo.

O supervisor live aceita somente a interface de reconciliação do futuro adapter,
com trading balance, PnL aberto, capital originalmente financiado US$250, origem e
evidência UTC reais. Não sintetiza caixa com o ledger live ainda não financiado.
Comandos têm sequência esperada: um concorrente vence, o outro recebe `FENCE` e
deve reler o estado antes de repetir com evidência nova. DD global tem precedência
sobre seleção de perfil e rollover. Rearme exige decisão explícita do operador,
flat/reconciliado/fresco e equity acima do mesmo piso; nunca reseta HWM ou aporta.
Autorizar o supervisor não habilita executor: não há rota, scheduler, signer ou
envio à venue nesta entrega. Qualificação e admissão continuam nos gates próprios.

Guards SQL serializam writers, preservam o plano, recusam reset de HWM/piso,
transições sem gênese, quebra de sequência e desbloqueio global sem decisão.
Todos os quatro journals são append-only, incluindo proteção contra TRUNCATE.
Reversão exige código compatível com 0054, pausa de entradas e preservação de
proteção/reconciliação; não remover eventos nem desfazer migrations.

Regras oficiais revalidadas em 08/10/2026: [mínimo perp de US$10 e erros ALO/reduce-only](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses),
[preço até cinco algarismos significativos e lote por szDecimals](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size),
[stop market com tolerância de 10% e gatilho mark](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/take-profit-and-stop-loss-orders-tp-sl).
Os testes são controlados; não comprovam observação prospectiva, liquidez ou live.
