# Consultas da mesa BTC paper

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
