# Comparação Jev operacional — G2-08.3

A API existente agenda a conta challenger registrada, após processar o baseline.
HTTP Jev não bloqueia os ticks seguintes. Funding, stop, saídas e risco continuam
com entradas Jev desligadas, erro, timeout, orçamento esgotado ou circuito aberto.
O manifesto baseline, seu início, metadata, pausas e ledger não são alterados.

## Configuração e cobertura antes de registrar

Padrão: **desativada**, sem chave, tarifa ou crédito padrão. US$ 5/mês é proposta,
não saldo. O backend procura `/etc/ganso/jev/config.json` e
`/run/secrets/jev_api_key`. A chave deve ser arquivo 0600, não vazio, até 4096 bytes;
a configuração, até 8192 bytes, não pode ser gravável por grupo/outros. Sem chave
ou configuração válida, o resto da API inicia normalmente. Com o switch desligado,
a chave tem somente presença/permissão verificadas, sem leitura de conteúdo.

A montagem desses dois arquivos protegidos, somente na API e somente leitura,
é uma ação operacional posterior via override Compose local. Não colocar chave
no Git, frontend, logs, argumento CLI ou `runtime.json`. Nenhum arquivo secreto,
mount, variável, plano ou compra é criado automaticamente nesta entrega. Alterar
configuração exige reinício seletivo da API; cobertura SQL é reavaliada em cada
tick, antes da reserva e no aceite. Remover chave/desligar config exige o mesmo
reinício, preservando o consumidor de saídas.

A forma da configuração é `{enabled, tariff, provision_reference,
billing_bound_reference}`. `enabled` precisa ser `true`; `tariff` tem os campos
exatos de `JevTariff` em `btc-jev-adapter-v1.md`. Não há exemplo preenchido com
preço, limite ou cobertura fictícios. `billing_bound_reference` identifica a
comprovação do teto **total faturável**, incluindo falhas/overhead; contexto máximo
ou previsão de tokens não provam esse teto. `provision_reference` identifica
cobertura já disponível, explicitamente conferida pelo operador.

Antes de ativar, conferir contrato oficial vigente, prova de cobertura, limite
faturável, mês UTC e capacidade/frescor atuais. Uma linha protegida preexistente
em `btc_jev_budgets` precisa ter `origin='real'`, `enabled=true`, referência de
cobertura correspondente, mês vigente, `tariff_hash=jevHash(tariff)`, limite menor
ou igual ao consumo já coberto (e no máximo USD6 5000000), saldo de reserva
suficiente e circuito fechado. O CLI **não cria nem aumenta essa linha**, não
limpa falhas e não renova mês. Uma linha `mock` nunca satisfaz cobertura real.
Sem evidência, entregar desativada; não solicitar contratação como requisito.
Nenhuma chamada real de teste é feita pelo CLI.

## Registro explícito, prospectivo e idempotente

Depois dos checks e implantação, com as condições anteriores satisfeitas, enviar
`{manifest,contract}` pelo stdin ao `apps/api/dist/challenger-activate-cli.js OWNER`
no container API, nos mesmos moldes do CLI baseline. Os bytes são os arquivos
congelados `config/trading/baseline.json` e
`docs/contracts/btc-baseline-manifest-v1.md`; o SHA vem da imagem publicada.

O dono autenticado precisa ser o mesmo do baseline. A conta fixa `challenger`
recebe experimento próprio, início na próxima fronteira UTC de 15 minutos,
registro imutável e metadata original pinada do baseline. O vínculo fixa hash do
registro fonte, modelo, origem, versão/hash do prompt, tarifa, atestado de limite,
manifesto e código. Repetir retorna o original; não muda início, risco ou pausa.
Mudar a identidade configurada desabilita novas consultas; não substitui o registro.

Gênese única de USD6 1000000000 só em/após início. Não há reset nem transferência
entre cenários. A comparação começa nessa data e usa decisões fonte posteriores;
histórico anterior permanece sem respostas Jev. Cada conta calcula sua própria
elegibilidade e tamanho, antes de Jev, com a política congelada. O filtro não muda
nenhum parâmetro financeiro. Receipt, input original, fence, deadline e replay
continuam sob os contratos 08.1/08.2. Rede segue fora de SQL/locks, com reserva antes
do envio, sem retries/reenvio de dispatching após crash ou COMMIT incerto.

## Mesa, Experimentos e contenção

`GET /api/trading/jev` exige a mesma sessão autenticada, é READ ONLY, no-store e
usa orçamento SQL de 1500 ms. Mesa e Experimentos exibem switch/gates, registro,
data inicial, até 20 decisões, elegibilidade própria, origem efetivamente registrada,
resposta/latência/custo, veto/abstenção/indisponibilidade e admissão. Ausência de
consulta não recebe origem mock ou resposta real. Tentativa sem resposta pode ter
custo incerto: a reserva continua comprometida, não vira custo zero.

Gasto real do provedor por mês é separado de saldos fictícios. Custo medido,
reserva pendente/incerta, comprometido e limite disponível são campos distintos.
Custos de fixtures mock não entram no total real. Cadastro, habilitação, receipt
allow e preenchimento de ordem são fatos diferentes. Avaliação econômica 09/10
não é parte desta entrega.

Pausa autenticada aceita challenger e baseline somente para conter entradas;
tickets manuais não podem operar suas ordens. Pausa persiste no risco, sem rearme
implícito. Desabilitar `btc_jev_budgets.enabled` contém consultas e impede aceite
se revogado durante HTTP; custos incertos são preservados. Nunca resetar circuito,
guards, checkpoint ou reserva para retomar. Funding, saídas e risco continuam.

Deploy seleciona API/web e o caminho GET exato no Nginx; não há migration nova
(schema 45), mudança de pool/teto, serviço, host ou cobrança. Preservar coletor e
PostgreSQL. Rollback anterior à composição não gere saídas challenger: só com conta
flat, sem reservas e entradas contidas, preservando registros, pins, ledger e
compatibilidade funding v2/RATE18. Testes financeiros só em PostgreSQL descartável;
fixtures marcadas MOCK não são evidência de ativação, fills ou mercado produtivo.
