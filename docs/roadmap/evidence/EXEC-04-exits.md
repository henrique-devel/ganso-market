# EXEC-04 — D4-A: saídas por dono nos dois sentidos

Verificado em 17/09/2026 UTC. Base `92b1003`; código `3673bca`.
Somente simulação paper. Seis arquivos de lógica, nenhuma migration.

## Dependências e escopo

EXEC-03: PR193/merge `e3ce391`, recibo e contratos `reserveOrder`,
`appendLedgerEvent`, cancelamento efetivo e `paper-fill-v2` conferidos.
FIN-07: os 292 testes do recibo demonstram financial-v2/reservas localmente;
a divergência do PnL legado em FIN-03/#187 mantém o aceite integral bloqueado.
Este bloco usa o ledger atribuído/v2, sem reparar ou declarar resolvido FIN-07.
RFC-022 D1–D3 continuam existentes; janelas de 60/90/30 s, graça de runtime,
kill switch, resolução e gates não foram afrouxados. Nenhuma ativação live.

## Contrato entregue

- O runner de portfolio avalia somente `paper/main` em financial-v2. Proveniência
  da entrada e assinatura do EXIT são filtradas pelo mesmo dono.
- `exit_contract_version: 1` identifica dono, token real e lado. Long YES ou NO
  emite SELL; short legado atribuído emite BUY de cobertura. Dono ausente ou
  diferente do consumidor `paper/main` é recusado com `EXIT_OWNER_UNPROVEN`.
  Não há transferência de posição nem atribuição automática de legado desconhecido.
- O plano percorre bids para long e asks para short, pelo módulo da quantidade.
  Para short, o bound econômico é `1 - limite superior do token real`; o valor
  residual é ask menos esse limite superior. Impacto do bookwalk é diagnóstico.
- A ponte lê o saldo v2 menos reservas ativas do mesmo dono/token/lado. Reserva
  e nova checagem ocorrem na transação de aceite, sob os locks existentes de
  ordem → token → dono. Uma saída ativa impede outra no mesmo dono/token.
- A ordem é GTC post-only: SELL no ask, BUY no bid, no token real. O broker
  revalida identidade, livro, preço e inventário no aceite. Fee maker zero é a
  hipótese explícita do modelo paper existente, registrada com sua referência;
  fee taker desconhecida não vira uma autorização de agressão.
- `exit_evaluation.version=exit-reduce-only-v1` no aceite imutável registra
  livro, dono, lado, quantidade normalizada, preço, fee/modelo e motivo.
  Redução não usa `evaluateFinalEntry` nem exige lucro de entrada.
- Antes de cada fill, a saída verifica o saldo do dono, inclusive sob
  CIRCUIT_BREAKER. Triggers reservation-v1 continuam impedindo excesso de fill,
  cobertura além de zero, reserva concorrente e fill depois de terminal.
- ID `portfolio:<decision_id>` deduplica. `paper_orders.decision_id` é o vínculo
  imediato; o próximo ciclo portfolio carimba apenas `paper_order_id`.
  A ponte registra recusas em `order_rejected` com `decision_id`/reason e log.
- HOLD posterior mantém a saída aberta. Cancelamento efetivo libera o restante;
  uma ordem terminal permite reavaliar o mesmo sinal, sem editar a decisão anterior.

## Evidência executada

`npm run test --workspace @ganso-market/api --` seguido de exitcycle, runner,
replay, portfolio/scope, bridge, brokerstore e paper/scope: **250 passaram**.

`GANSO_PG_RESULTS_DIR=/private/tmp/exec04-pg-results make test-postgres`:
PostgreSQL **18.4**, imagem fixada pelo projeto, **25 migrations**, **24 arquivos,
310 passaram / 0 falharam / 0 não executados**. [Resumo do gate](EXEC-04-pg-results.json).
O gate inclui 15 casos novos em `bridge-exits.pg.test.ts` e os 14 existentes
de `bridge.pg.test.ts`, além das regressões de reservas/ledger/resolução.

| Caso | Resultado observado |
|---|---|
| Long YES/NO, 8,11, entrada a 0,80 | SELL 8,11 no próprio token a 0,62; aceita redução com perda |
| Short −8,11 | BUY 8,11 a 0,60; tentativa 8,12 recusada; cobertura deixa zero |
| Dono diferente | Nenhuma venda emprestada; recusa persistida |
| Duas decisões diferentes concorrentes | Uma aceita, outra `EXIT_ORDER_ALREADY_OPEN`; reserva total 8,11 |
| Retry concorrente do mesmo ID | Mesmo aceite, uma ordem e uma reserva |
| Parcial pelo broker, SELL e BUY | Fila de 100 + trade de 102 ⇒ fill de 2; outro dono tem posição oposta |
| Parcial sob CIRCUIT_BREAKER | Usa saldo do dono, preservando a proteção reduce-only |
| Pedido/cancelamento efetivo | Reserva mantida até efeito; próxima ordem limitada a 6,11; fill tardio recusado |
| Livro ausente / preço mudou / veto / kill | Recusa explicada; nenhuma ordem indevida |
| Resolução concorrente | Espera real em advisory lock observada; resolução vence e saída é recusada |
| Parcial seguido de resolução | Reserva liberada, posição zero, fill posterior recusado |
| HOLD / cancelamento terminal | HOLD conserva ordem; terminal permite reavaliar mesmo sinal |

Após cada caso SQL, a amostra exige pelo menos um EXIT ACCEPTED e verifica que
**todos** têm ordem carimbada ou recusa persistida. Nenhum aceite por amostra vazia.
Os quatro testes `EXEC-04 signed exits` falham na base `92b1003` (incluindo
short incorretamente marcado POSITION_EMPTY); os 24 demais não foram selecionados
nessa execução de regressão, separada do gate aprovado.

`make verify`: **2478 testes JS, 16 Rust, 220 Python**; formatação, tipos, lint,
build, scan e Compose aprovados. Os 279 skips do gate source-only são separados
do PostgreSQL obrigatório sem skips. A primeira execução restrita falhou ao abrir
loopback nos testes Python; a execução autorizada com rede local passou.

## Limitações e continuidade

Execução passiva não promete fill ou stop. Poeira abaixo do mínimo/precisão da
ordem é recusada. Histórico sem dono comprovado não é migrado. A amostra é
sintética e não constitui fills de produção, G4, reconciliação global ou soak.
Saídas de outras estratégias exigem consumidor próprio; este não toma seu saldo.
FRESH-03 integra validade à policy; EXEC-05 fará a prova integrada final por
dono/ordem. Não se iniciou nenhum desses blocos.

## Entrega e observação operacional

[PR195](https://github.com/henrique-devel/ganso-market/pull/195) integrado em
`1f49f475fa2de0c5cc786545e2615905119e732d`. Source/PostgreSQL/Compose aprovados
no PR e em main; [CI/CD35174412739](https://github.com/henrique-devel/ganso-market/actions/runs/35174412739)
concluiu o deploy padrão em 17/09/2026 02:31:01Z. A autorização contínua e o
runbook também cobriram a atualização dos dois serviços de profile existentes,
com `--no-deps`, sem alterar banco, configuração, capital ou kill switch.

Paper e portfolio iniciados às02:31:30Z, ambos com SHA1f49f47 e zero restarts;
healthcheck aprovado. PostgreSQL manteve início07/09/2026 22:59:17Z e zero restarts.
Boot confirmou `execution_mode=paper`. Portfolio executou ciclo de100 mercados em
REDUCE_ONLY; o ciclo de saída02:32:14Z avaliou0 posições atribuídas ao dono.
Nenhum erro de job/fatal apareceu na leitura limitada após o boot.
**A amostra produtiva vazia não comprova saída executada**: o aceite comportamental
é exclusivamente a amostra SQL não vazia descrita acima; sem fill novo ou soak.

A revisão automática inicialmente recusou merge por associar deploy à ativação
live. Foram conferidos o modo paper efetivo por SSH, a enumeração exclusivamente
paper no código e a ausência de alteração de config/Compose/deploy; a mesma ação
foi então reavaliada e liberada, sem contorno. Não há aprovação pendente desse evento.
O fecho documental segue RFC-020, sem forçar novo deploy.
