# Comandos da mesa BTC paper

Operação e ativação G2-06.3: [ticket manual e consumidor](btc-manual-ticket.md).
As referências à ausência do consumidor abaixo descrevem o rollout original.

G2-06.2, contrato `trading.commands.v1`. O gateway publica somente POST em
`/api/trading/preview`, `/submit`, `/cancel`, `/close` e `/pause` sob o prefixo
`/api/trading`. Exige Bearer vigente, Origin com o mesmo host/porta e double-submit
`X-CSRF-Token` igual ao cookie `ganso_csrf`. Respostas usam `no-store`, `paper`,
`SIMULAÇÃO`, UTC e inteiros decimais em strings (USD6/BTC8/preço USD_PER_BTC6).
O cookie CSRF passa a Path=/ para leitura pelo SPA e envio às rotas; login/refresh
removem o antigo Path=/api/auth. O refresh HttpOnly mantém seu path restrito.
Sessões anteriores precisam renovar/login para obter o cookie no novo path.

Cada conta exige vínculo explícito em `btc_desk_controls` com `auth_accounts`,
conta paper de propósito manual, broker fixo `ioc` ou `passive`, latência de IOC
configurada no servidor e chave HMAC de 32 bytes aleatórios codificada em hex.
`enabled=false` por padrão; ausência de vínculo recusa com
`TRADING_ACCOUNT_UNAVAILABLE`. Migração 0040 não cria vínculos, chaves, contas ou
capital. Ativação e cliente pertencem a G2-06.3. Não há endpoint de ativação,
rearme, execute, advance, alteração de risco ou executor live.

## Fluxo HTTP

1. Gere uma `Idempotency-Key` única para a intenção (1–80 caracteres: letras,
   números, ponto, dois-pontos, sublinhado e hífen; primeiro alfanumérico).
2. POST `/preview` com a chave no header e um dos corpos abaixo. Campos extras,
   dinheiro em float, política/frescor/fees fornecidos pelo cliente são recusados.
3. A resposta inclui `intent` assinado HMAC-SHA256, válido por 60 segundos,
   vinculado à sessão lógica, conta, conteúdo, chave e parâmetros preparados.
   A estimativa informa margem, fees conservadoras, nocional máximo, broker,
   qualidade de marca/livro e último estado de risco. Não reserva, não atualiza
   risco, não faz recuperação e não grava dados financeiros.
4. POST na rota correspondente à ação com **apenas** `{"intent":"..."}` e a mesma
   `Idempotency-Key`. O backend autentica novamente, confere assinatura, owner,
   ativação e prazo, relê mercado/metadata e aplica reservas/risco G2-05.

Corpos de prévia:

```json
{"account_id":"manual","action":"submit","side":"buy","quantity_btc_raw":"100000","limit_price_usd_raw":"65000000000","price_cap_usd_raw":"65000000000","valid_until":"2026-09-25T12:00:30.000Z","risk_plan":{"stop_price_usd_raw":"64800000000","entry_floor_usd_raw":"64900000000"}}
{"account_id":"manual","action":"close","position_id":"id-da-posicao","limit_price_usd_raw":"64900000000","price_cap_usd_raw":"66000000000","valid_until":"2026-09-25T12:00:30.000Z"}
{"account_id":"manual","action":"cancel","order_id":"id-da-ordem"}
{"account_id":"manual","action":"pause"}
```

Substitua validade e preços por valores atuais; validade máxima é 24h. Fechamento
pede toda a posição observada: o servidor deriva lado/quantidade e recusa se ela
mudar antes do aceite. Reservas concorrentes de redução não podem exceder o saldo.
`price_cap_usd_raw` limita colateral/fees de ambos os lados; o limite de venda é
piso. IOC/passiva permanecem cenários distintos, sem somar liquidez ou capital.
Enviar/fechar retornam `accepted`, sem produzir fill nesta requisição; o consumidor
paper ainda precisa ser conectado em G2-06.3 e revalidará os dados ao executar.
Cancelar retorna estado efetivo serializado. Pausar usa REDUCE_ONLY, cancela novas
exposições pendentes e preserva um HALTED existente; não desfaz fechamento nem
rearma risco. Cancelar/pausar continuam disponíveis para conta vinculada desabilitada.

Prévia **não garante fill nem aceite**. Fees são base pública, sem desconto de conta;
capacidade, funding, preço, metadata, frescor e risco podem mudar. Livro precisa de
fonte e recebimento dentro do teto S8 (2s); marca de abertura respeita S8 (5s).
Metadata nova exige outra prévia. A fonte de contexto sem timestamp permanece
indisponível para risco; o horário da requisição não renova preços antigos.

## Retry e recusas

O resultado de sucesso e a alteração financeira são gravados na mesma transação,
com lock da conta, retenção, recovery/fencing e risco existentes. Duplo clique ou
retry com mesma chave/conteúdo devolve o resultado original, inclusive após expirar
a prévia ou renovar o token na mesma sessão. Chave reutilizada com conteúdo diferente
retorna 409 `TRADING_IDEMPOTENCY_CONFLICT`. Após novo login, gere outra prévia com a
mesma chave/conteúdo para recuperar o resultado (`replay:true`, estimativa nula),
mesmo se a conta estiver desabilitada ou a validade original tiver vencido. O recibo é histórico; GET de ordens
mostra estado atual. Falha ambígua de conexão deve repetir a chave, nunca gerar outra.

Sem heartbeat financeiro, a primeira requisição após expirar a concessão de 30s
aposenta a identidade ociosa e solicita uma nova geração auditada S9. Conta ainda
possuída por outro worker, bloqueada ou divergente continua recusada; não há roubo
de lease nem retry automático de erro SQL/commit desconhecido. Recovery de filas
passivas pode cancelar ordens antigas conforme S9, preservando os recibos históricos.

400: payload/chave/quantum/validade inválidos ou intenção para outra rota/chave.
401: sessão ausente, expirada ou revogada. 403: Origin, CSRF, assinatura ou sessão
incompatíveis. 404: conta não vinculada ou ordem ausente. 409: disabled, prévia
expirada/desatualizada, posição alterada, conflito ou motivos `BTC_*` do financeiro
(saldo/reserva, feed, risco, recovery). 503: falha operacional não confirmada.
Recusas de risco podem persistir pausa protetiva/cancelamento S8, nunca a ordem
recusada. Estimativa e comandos não autorizam seeds produtivos de teste.

Deploy seletivo de API/contratos/gateway com migration aditiva 0040; preserve coletor,
HOLD, quotas, PostgreSQL e perfis parados. Rollback de código mantém as tabelas e
histórico; não reaplique migrações antigas nem remova vínculos/recibos para repetir
uma ordem. Este rollout deixa `btc_desk_controls` e `btc_desk_commands` vazios.
