# EXEC-03 — contrato de execução paper

Código: 63fd9b3; base 83856e9 (EXEC-02/FIN-05 integrados). Modelo `paper-fill-v2`, sem migration.

- `requestCancel` trava a ordem e grava timestamp + evento na mesma transação.
  Retry conserva o primeiro pedido; falha de auditoria reverte o timestamp.
- Maker usa fila visível no aceite; sem snapshot não presume fila vazia.
  Somente volume de trades supera a fila, nunca simples toque do livro.
  Quantidades confirmadas vêm do ledger, não da recomputação dos trades/cache.
  Trade recebido tardiamente anterior ao último fill contribui à fila, mas não
  gera fill retroativo. Novos fills são limitados ao saldo aceito; FIN-05 impõe
  reserva, preço, fee, timestamp e dono na mesma inserção SQL.
- Pedido de cancelamento mantém reserva. Trades anteriores ao efeito ainda
  preenchem; no instante do efeito o cancelamento vence o empate. Depois do
  efeito a ordem sai da fila e o gatilho FIN-05 rejeita novos fills.
- Taker espera aceite + 250 ms (aceite já inclui latência configurada). Walk
  respeita tamanho/preço e profundidade. Sob lock do token, fills anteriores no
  mesmo snapshot recebido e lado descontam volume, inclusive entre donos.
  FAK parcial grava cancelamento do restante e libera sua reserva; FOK sem
  profundidade não consome nada. Fills e fechamento/cache são transacionais.
- Fee taker null/inválida ou sem versão/timestamps verificáveis impede fill.
  Fill persiste versão, taxa, source/received/valid_from, fórmula e referência
  temporal do livro. Retry não recalcula fees já confirmadas.

Fonte externa consultada em 17/09/2026: [Polymarket Fees](https://docs.polymarket.com/trading/fees).
A página informa fee maker zero e fórmula taker C × rate × p × (1 − p).
`maker-zero-docs-2026-09-17` identifica a revisão consultada; nenhum rebate.
Taxa taker vem do registro do mercado, nunca de uma taxa de categoria presumida.
O modelo existente conserva fixed-point interno de nove casas e saída de seis;
a documentação da venue descreve arredondamento de cinco casas. Portanto a
simulação não declara equivalência de liquidação live nem amostra real da venue.

## Cobertura e limitações

215 testes focados: broker/brokerstore/performance/ledger/financial.
PG descartável, migrations reais: fixture do broker 10 cotas → fill 2 → pedido
→ fill 3 antes do efeito → cancelamento; trade de 100 no efeito não preenche.
Reserva 5 → 4 → 2,5 → 0; posição final 5. Falha no evento do pedido reverte
pedido e conserva reserva. Fixtures FIN-05 também provam disputa fill/cancel,
rollback, reconstrução e limites. Dois donos independentes: compra 10 × 0,40
com fee 0,10; venda 10 × 0,60 com fee 0,20; cada um termina com cash 1.001,70,
PnL 1,70, fees 0,30 e reserva zero após retries reordenados/reconciliação.

O relatório existente adiciona execução maker/taker, fees e cobertura de fonte,
PnL coberto, fills sem atribuição e markouts por tipo/horizonte. Fill rate conta
ordens com qualquer fill, inclusive parcial cancelado. PnL por tipo conserva a
contabilidade legada desse relatório, explicitamente identificada; tokens mistos
ou sem classificação ficam fora da atribuição e sua cobertura é reportada.
A divergência financeira FIN-07 não é resolvida por esta métrica. Amostra vazia
retorna PnL null; nada disso aprova G4, que não foi alterado.

Fila/degradação e latência continuam modelos conservadores simulados, sem
calibração live. Novo snapshot constitui novo orçamento observado; não há
simulação de impacto inter-snapshots. Fills legados sem referência do snapshot
não podem ser debitados desse orçamento novo. Trades antigos removidos não são
reconstruídos: o ledger preserva efeitos já confirmados, mas fila não observada
não comprova oportunidade nova. Sem política nova de frescor/expiração.

## Contrato para EXEC-04

`reserveOrder(tx, orderId, now)` cria payload reservation-v1 no aceite;
`appendLedgerEvent(tx, fill)` consome cash/reserva/inventário via migration 0025;
`appendLedgerEvent(tx, cancel_effective | expired)` libera saldo; o pedido não.
`reconcileReservations(tx, {accountId,strategyId})` reconstrói sob lock do dono.
`requestCancel(pool, orderId, deps)` exige transação. Reutilizar ordem → token →
dono, identidade/fee imutáveis e mesmos limites. EXEC-04 não iniciado; FIN-07
continua dependência própria. Nenhum worker ativado, sem live/caps/G4 novos.

## Verificação observada

`node_modules/.bin/vitest run apps/api/test/polymarket/paper/{broker,brokerstore,performance,ledger,financial}.test.ts`: 215 passaram.
`make test-postgres`: PostgreSQL 18.4, 25 migrations, 23 arquivos, 295 passaram,
zero falhas/zero skips. `make verify`: 2.472 JavaScript, 16 Rust e 220 Python;
264 testes SQL omitidos no gate sem banco foram cobertos pelo gate PG separado.
Typecheck, formatação, build, scan e Compose passaram. Rebase posterior alterou
somente documentos de EXEC-02; árvores de código/testes verificadas idênticas.
Logs locais: `/private/tmp/exec03-focused.log`, `/private/tmp/exec03-pg.log`,
`/private/tmp/exec03-verify.log`. Recibo de EXEC-03 permanece com até 25 linhas.
Push recusado pela revisão automática por saída sensível sem autorização
explícita do payload/destino. Nenhuma tentativa alternativa, PR ou deploy.
Autorização contínua foi lida; o bloqueio efetivo da ferramenta permanece.

O proprietário autorizou explicitamente a publicação do código/documentação
na retomada desta tarefa; a recusa acima é histórico, não aprovação pendente.

## Publicação e observação operacional

[PR193](https://github.com/henrique-devel/ganso-market/pull/193) integrado em
`e3ce391e854d2c1664f354e13781236f116700c1`; checks source/PostgreSQL/Compose
aprovados no PR e main. [CI/CD35171147254](https://github.com/henrique-devel/ganso-market/actions/runs/35171147254)
concluiu o deploy padrão. Leitura SSH com host key fixada em 17/09/2026 01:40Z:
API no SHA do merge, healthcheck aprovado, zero restarts; PostgreSQL iniciado
em 07/09 22:59:17Z, zero restarts. Worker paper preservado em `18a6c20`, iniciado
em 17/09 00:20:44Z, zero restarts. Nenhum comando para ligar/recriar worker foi
executado. Portanto o código está publicado e na API, mas sua aplicação ao
processo paper ainda depende de uma entrega operacional posterior compatível
com o limite do pedido. Não confundir os testes com fills novos de produção.
O fecho documental não deve forçar outro deploy; aplica-se RFC-020.
