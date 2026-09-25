# Consultas da mesa BTC paper

Operação e ativação G2-06.3: [ticket manual e consumidor](btc-manual-ticket.md).
As referências à ausência do consumidor abaixo descrevem o rollout original.

Contrato `trading.desk.v1` (G2-06.1). Usa a sessão Bearer do owner e o perímetro
HTTP existente. Respostas têm `Cache-Control: no-store`, `SIMULAÇÃO`, `mode: paper`,
`as_of` UTC e unidades explícitas; dinheiro/quantidade/preço são inteiros decimais
em strings. Nenhuma consulta ativa conta, reserva capital, executa fill, expira
ordem, atualiza risco ou repara projeção.

| GET publicado | Parâmetros | Resultado |
| --- | --- | --- |
| `/api/trading/accounts` | `limit`, `cursor` | Identidades de cenários independentes; sem total patrimonial |
| `/api/trading/account` | `account_id` obrigatório | Saldo, margem, marca/oracle, livro e frescor da conta |
| `/api/trading/positions` | `account_id`, `limit`, `cursor` | Posições abertas e encerradas, custo-base e margem |
| `/api/trading/orders` | `account_id`, `limit`, `cursor` | Último estado de cada reserva/ordem, fills efetivos e saldo reservado |

`limit` padrão 50, entre 1 e 100. A paginação usa IDs em ordem crescente e
`next_cursor` opaco vinculado à rota e conta; envie-o sem modificações. Cada página
representa um novo snapshot consistente, não uma sessão de snapshot entre páginas.
Não há contagem global, offset nem filtro implícito de conta. Parâmetros desconhecidos,
repetidos ou cursor de outra conta/rota retornam 400 `TRADING_INVALID_QUERY`.
Conta inexistente retorna 404 `TRADING_ACCOUNT_NOT_FOUND`; sem sessão, 401
`AUTH_UNAUTHENTICATED`; falha de leitura, 503 `TRADING_READ_UNAVAILABLE`.
Outros métodos e caminhos permanecem fechados no gateway.

`status: unavailable` e `reason_codes: [{component, code}]` podem acompanhar
campos conhecidos. `null` significa indisponível: não formatar como zero.
Posições sem projeção retornam lista vazia **com estado indisponível**, distinguindo
isso de uma lista conhecida vazia. `BTC_DESK_PROJECTION_UNAVAILABLE` indica projeção
inexistente/divergente; `BTC_DESK_PROJECTION_FUTURE` indica dados posteriores ao
relógio da consulta. Qualidade de marca/livro distingue `missing`, `stale`,
`source_time_unproven`, `feed_unavailable`, `future`, `incompatible`, `invalid` e
`fresh`, com motivos `BTC_MARK_*`/`BTC_BOOK_*`. Timestamp de recebimento não substitui
timestamp de origem; `as_of` nunca renova a observação. Um preço antigo pode ser
mostrado como referência com sua qualidade, sem certificar patrimônio/margem.

`cash_usd_raw` é fluxo de caixa; `balance_usd_raw` inclui PnL realizado; patrimônio
inclui PnL não realizado apenas quando calculável. Posição zerada tem PnL não
realizado zero independentemente da marca. Custo-base usa USD14 e PnL agregado USD6,
com o mesmo arredondamento conservador do backend financeiro. Margem isolada é 1x;
`unreserved_cash_usd_raw` é caixa livre menos reservas, **não** capacidade aprovada
para enviar ordens. Valores incluem custos já registrados no ledger; funding
pendente, frescor, risco e capacidade devem ser revalidados pelo futuro comando.
`liquidatable: null` significa risco indisponível, não posição segura.

`filled_btc_raw` acumula somente consumos efetivos, inclusive após cancelamento.
`remaining_btc_raw` é quantidade ainda reservada; cancelamento/expiração podem
zerá-la sem fill. `status: active` após `valid_until` continua sendo o último estado
persistido: uma leitura não libera a reserva nem inventa a transição de expiração.
O extrato de execuções e explicações causais detalhadas pertence à fatia de histórico.

A migration 0039 adiciona apenas modelos derivados, sem sementes ou ativação.
A projeção financeira é escrita atomicamente no append já existente; ordens usam
um head indexado atualizado no insert da reserva. GET usa REPEATABLE READ READ ONLY,
limite de statement de 1500 ms e consulta indexada da última sequência para verificar
coerência; não lê o histórico completo nem executa replay. A recuperação auditada
reconstrói a projeção derivada. Contas anteriores à migration sem projeção financeira
ficam indisponíveis até um append ou recuperação auditada explícitos; o GET nunca
faz esse backfill. No rollout G2-06.1 não se criam contas produtivas de teste.
Rollback de código preserva a migration aditiva e todo o histórico; uma projeção
que não acompanha a sequência corrente é recusada na leitura.

## Operações e acervo (G2-06.4)

Mesa, Operações, Experimentos e Sistema formam a navegação BTC; Acervo legado
mantém os leitores Polymarket e Sombra, com identificação própria e sem rearme
na interface. Seleção de conta é compartilhada entre as telas BTC, sem total
entre cenários. Trocar de conta descarta a visualização anterior; uma intenção
manual incerta continua guardada para retomada na conta manual.

`GET /api/trading/operation?account_id=…&order_id=…` usa `trading.desk.v1`,
com inputs aceitos, regime/limite/metadata persistidos, solicitação protetiva
quando existente e páginas de eventos de reserva. Cada consumo traz os eventos
financeiros de sua transação (fill/taxa com IDs e horários). `view=receipts`
mostra motivos e evidências do broker, paginados por ID de operação no IOC e por
sequência na passiva; não inferir cronologia pela ordenação de IDs IOC.
`limit` 1–100 e `cursor` têm os mesmos limites das outras leituras. O cursor
fica vinculado à conta, ordem e view. Ordem ausente retorna 404
`TRADING_ORDER_NOT_FOUND`. Parâmetros inválidos retornam 400; não há POST.

`GET /api/trading/orders` aceita também `position_id`, com cursor vinculado ao
filtro. A ficha usa essa leitura para navegar entre abertura e reduções da mesma
posição até os fills efetivos. Solicitação de saída não comprova posição zerada;
reserva liberada não representa quantidade executada. Valores ausentes permanecem
indisponíveis. Custos de uma página não são apresentados como total da operação.

`account.funding` é o último recibo não duplicado da hora UTC da consulta, ou
null se ausente. Não certifica liquidação de horas anteriores; risco e comandos
continuam revalidando todas as dependências. Funding contabilizado no saldo não
substitui esse estado. Oracle exato de settlement ausente com posição elegível
permanece pendente. Diagnóstico de sinal/warmup e avaliação de experimentos ainda
não são fornecidos por estas leituras. Recusas de prévia aparecem no ticket;
sem registro persistido correspondente, não se inventa uma causa histórica.

As consultas usam transação somente leitura, snapshot consistente, orçamento
1,5 s e índices por conta/ordem. Migration 0042 adiciona somente dois índices.
Deploy seleciona API/web/gateway e migration; preserva banco, coletor, consumidor
manual após recuperação normal e todas as evidências. Rollback mantém schema e
histórico. Reexportações exclusivamente de tipos no barrel de contratos não
recriam o coletor; mudanças em exports de runtime continuam conservadoras.
