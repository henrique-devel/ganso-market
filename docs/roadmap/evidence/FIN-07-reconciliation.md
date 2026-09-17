# FIN-07 — Reconciliação financeira

Reexecução de 17/09/2026 UTC sobre a base `ea15dea40ea065e29867f71d68f3e4f1a5bac2e3`,
com FIN-01..06, QA-01 e EXEC-04 integrados. O pedido posterior do proprietário
ampliou expressamente o bloco para corrigir broker, cache e leitores, excedendo
o limite inicial de arquivos. Correção rastreada em
[FIN-03/#187](https://github.com/henrique-devel/ganso-market/issues/187).

**Resultado atual: FIN-07 desbloqueado, `code-verified`; reconciliação financeira local integral aprovada**. A evidência anterior bloqueada permanece
[no PR188](https://github.com/henrique-devel/ganso-market/blob/95c0ddd079f9490c80fa84631c060a4c6608e45d/docs/roadmap/evidence/FIN-07-reconciliation.md).
Ela não foi convertida retroativamente em sucesso.

## Correção e inventário dos consumidores

Eventos, atribuições ownership-v1 e semântica ledger-v1 permanecem preservados.
A carteira monetária usa financial-v2 por conta/estratégia/token. Não há backfill
nem transferência de legado para BTC. As linhas desconhecidas mantêm
`legacy_unattributed/unknown`; capital sem origem permanece indisponível.

| Caminho | Comportamento verificado |
|---|---|
| Broker: fill, fill parcial e settlement | `paper_owner_positions` é gravado dentro da mesma transação do evento/reserva. O teste lê a linha física antes de qualquer reconstrução por leitor. |
| Broker: redução, disputa, marca e descoberta de posição | Inventário por dono e `paper_open_owner_tokens()`; posições opostas sobrevivem mesmo quando o token líquido é zero. Marcas long usam bid e short usam ask executáveis. |
| Kill switch diário | R e U por dono, com âncoras persistentes separadas (migration0026). Mesmo limite USD configurado; lucro de B não compensa perda de A. Marca indisponível impede rearme automático. |
| `loadPaperPnl`, `loadOpenPositions`, equity/exposure/saídas | Seleção de dono obrigatória; um único estado financeiro alimenta PnL e posições. Helpers v1 têm nomes explícitos `loadLegacy*` e uso diagnóstico. |
| G2, performance e APIs paper/resolução | G2 usa paper/main; performance soma resultados já apurados por dono, identifica versão e devolve subtotais. Leituras financeiras HTTP usam transação somente leitura e não reparam cache. |
| Overview/divergência e telas | Descoberta por dono, chaves visuais conta/estratégia/token; Carteira seleciona paper/main. Resolução exibe U calculado pelo ledger, inclusive shorts, sem refazer uma subtração incorreta. |
| Compatibilidade `paper_positions`/`replayLedger` | Mantidos em ledger-v1 para diagnóstico histórico e arquivos de retenção. Endpoint antigo exige `accounting_version=ledger-v1` e retorna `diagnostic_only=true`. Não alimentam as decisões monetárias acima. |

A migration0026 adiciona somente um objeto JSON de âncoras à linha de controle;
não altera capital, caps ou histórico. A primeira observação válida do dia ancora
a parcela aberta; perda realizada do dia já é verificada imediatamente, incluindo
eventos tardios. Isso não reconstrói uma marca de meia-noite que nunca existiu.
Âncoras persistem após restart. Reversão de código conserva a coluna aditiva e
os eventos; não há downgrade destrutivo de schema.

## Precisão, oráculos e ambiente

[FIN-01/F1–F6](FIN-01-financial-contract.md) fornece valores manuais independentes.
USD/cotas usam fixed-point de nove casas (`10^-9`), comparação exata de bigint
ou texto canônico, sem epsilon. Basis residual, fees únicas, buckets UTC,
payoff-v1 e reservation-v1 foram conferidos. O cache v1 é explicitamente medido
na sua precisão histórica de seis casas; sua divergência não vira tolerância v2.

QA-01: PostgreSQL18.4, Docker local descartável, 26 migrations reais, bancos/clones
isolados por arquivo, ledger e HOLD ativos. Apenas capital/livros/eventos sintéticos.
FIN-01/F4 divide US$1.000 em A500/B500 no mesmo token. O cenário broker adicional
usa main500/B500: main passa por bridge/broker reais; B usa o contrato SQL de
reserva/fill. Isso testa isolamento concorrente sem alegar ativação de worker B.

## Resultados exatos

Números abaixo omitem zeros finais por legibilidade; as asserções usam nove casas.
C=cash, B=basis bruto, R=realizado líquido, F=fees, M=marca assinada, E=equity;
risco é perda residual da posição, separado das reservas e do realizado.

| Fixture/checkpoint | C | Q / B | R / F | M / E | Risco |
|---|---:|---|---|---|---:|
| F1 short10@0,40, ask0,50 | 1004 | -10 / 4 | 0 / 0 | -5 / 999 | 6 |
| F1 recompra4@0,50 | 1002 | -6 / 2,4 | -0,4 / 0 | -3 / 999 | 3,6 |
| F1 resolve1 restante | 996 | 0 / 0 | -4 / 0 | fechado / 996 | 0 |
| F2 BUY10 NO@0,60, bid0,50 | 994 | 10 / 6 | 0 / 0 | 5 / 999 | 6 |
| F2 NO resolve0 | 994 | 0 / 0 | -6 / 0 | fechado / 994 | 0 |
| F3 X/Y abertos | 930 | 100+100 / 30+40 | 0 / 0 | 70 / 1000 | 70 |
| F3 X/Y resolvidos0 | 930 | 0 / 0 | -70 / 0 | fechado / 930 | 0 |
| F6 sem marca | 9 | 3 / 1 | 0 / 0 | indisponível | 1 |
| F6 primeira venda1@0,40 | 9,4 | 2 / 0,666666667 | 0,066666667 / 0 | 0,8 / 10,2 | 0,666666667 |
| F6 segunda venda | 9,8 | 1 / 0,333333333 | 0,133333333 / 0 | 0,4 / 10,2 | 0,333333333 |
| F6 terceira venda | 10,2 | 0 / 0 | 0,2 / 0 | fechado / 10,2 | 0 |

Cada checkpoint compara estado derivado dos eventos, linhas de
`paper_owner_positions`, `loadPaperPnl`, `evaluateState` e `computeExposures`.
São checkpoints selecionados dos oráculos, não alegação de execução de cada
linha narrativa de FIN-01. F1/F2/F3/F6 têm cronologia sintética crescente no dia12;
resolução dia13. A suíte financial.pg existente cobre também eventos tardios,
marcas inválidas, desconhecidos e donos opostos sem netting.

### F4 — mesmo token, duas estratégias simultâneas

Aceites concorrentes A BUY10@0,40 e B BUY5@0,60; fee máxima sintética0,01/cota
(400bps no contrato de teste), reservas4,10/3,05. Ambos os fills também são
submetidos concorrentemente. A tentativa de A reservar510 além de4,10 falha por
cash; o dinheiro livre de B não é emprestado. B tem5 cotas e não pode vender6.
A reserva4 cotas para a2 e0,04 de cash/risco para fee; o fill consome ambos.

| Corte econômico | Dono | C | Q | B | R total | F | M | E | R diário / semanal | Risco |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 12/09 23:59:59.950Z, após a2 | A | 498,66 | 6 | 2,4 | 1,06 | 0,14 | 3 | 501,66 | 1,06 / 1,06 | 2,4 |
| mesmo corte | B | 496,95 | 5 | 3 | -0,05 | 0,05 | 2,5 | 499,45 | -0,05 / -0,05 | 3 |
| agregado | A+B | 995,61 | 11 | 5,4 | 1,01 | 0,19 | 5,5 | 1001,11 | 1,01 / 1,01 | 5,4 |
| 13/09 00:06Z, resolução1 | A | 504,66 | 0 | 0 | 4,66 | 0,14 | 0 | 504,66 | 3,60 / 4,66 | 0 |
| mesmo corte | B | 501,95 | 0 | 0 | 1,95 | 0,05 | 0 | 501,95 | 2 / 1,95 | 0 |
| agregado | A+B | 1006,61 | 0 | 0 | 6,61 | 0,19 | 0 | 1006,61 | 5,60 / 6,61 | 0 |

Caixa/inventário reservados zeram após os fills e após resolução. Entre a2 e
resolução, o teste abre reservas adicionais: A BUY2 exige cash/risco0,82; B SELL3
exige cash/risco0,03 e inventário3. Agregado reservado0,85/inventário3; disponível
A497,84/B496,92, agregado994,76. Essas reservas não alteram R/E; risco de posição
mais reserva é6,25. Valores agregados nesta tabela são somas das subcarteiras,
não netting de basis nem alocação do saldo de uma à outra.

Dia12 recebe a2 em 23:59:59.900Z; dia13 recebe somente o remanescente liquidado.
Na segunda-feira14/09, dia e semana de A voltam a0, total permanece4,66.
A suíte financeira existente executa a chegada de a2 depois da resolução e
reconstrói o dia12. Caso existente de long/short de donos opostos no mesmo token
prova risco4+6=10 mesmo com quantidade líquida0; ganhos não compensam donos.

### Caminho completo broker/cache/leitores

A regressão permanente `reconciliation-broker.pg.test.ts` exercita bridge,
quantidade final, EV, reserva, fill parcial FAK, maker, saída parcial EXEC-04,
cancelamento, settlement e retry/restart. Em 18 checkpoints independentes,
a comparação cobre cash, quantidade, basis, fees, R, equity e reservas.

| Corte | Dono | Cash | Q | Basis | Fees | R | Equity | Cash/inventário reservado |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Saída parcial | main | 498,18 | 4 | 2 | 0,06 | 0,18 | 500,58 | 0 / 4 |
| Mesmo corte | B | 497 | 5 | 3 | 0 | 0 | 500 | 0 / 0 |
| Soma explícita | main+B | 995,18 | 9 | 5 | 0,06 | 0,18 | 1000,58 | 0 / 4 |
| Settlement1 | main | 502,18 | 0 | 0 | 0,06 | 2,18 | 502,18 | 0 / 0 |
| Settlement1 | B | 502 | 0 | 0 | 0 | 2 | 502 | 0 / 0 |

No mesmo corte parcial, o diagnóstico v1 produz R0,089090 por misturar basis;
o cache físico v2 e as APIs devolvem R(main)=0,180000000 e R(B)=0,000000000.
A diferença histórica é explicada por esse evento e segregada. O escritor comum
do broker também executa os valores literais F4/a2: cache físico A1,060000000,
B−0,050000000 antes de `loadPaperPnl`; agregado1,010000000, dias1,01/5,60 e total6,61.
A sequência com relógio e fees literais FIN-01 usa o contrato de eventos/reservas;
a sequência completa bridge/broker usa a fee calculada e a liquidez do simulador.

APIs paper/positions e resolution-risk/pipeline são chamadas com Fastify e SQL
reais. Duas linhas no mesmo token preservam dono e R. O filtro paper/main não
inclui B. O teste compara o cache completo antes/depois dessas leituras: idêntico.
G2 após settlement retorna main2,18 ou B2 conforme seleção, sem mistura.
Performance maker de B continua separada da execução mista maker/taker de main.

## Reservas, recuperação e falhas

F5/`reservations.pg.test.ts` executa21 casos: disputa600+500 contra1000 nas duas
ordens de chegada, lock observado no PostgreSQL, um vencedor; duas saídas300/200
contra400 cotas; consumo parcial, fee, resíduo de nano, recusa de oversell,
rollback, cancel_requested que retém e cancel_effective que libera, resolução.
O saldo de B não financia A e o inventário de A não permite venda de B.

F4 captura caches v2/reservas (exceto `updated_at`, relógio da projeção),
adultera apenas linhas sintéticas via UPDATE permitido e reconstrói pelos eventos
com novo pool. Todas as colunas econômicas voltam exatamente; ledger completo
permanece idêntico após retry de aceite, fill e resolução. DELETE continua
protegido por HOLD. Não houve reconstrução de cache operacional.

Falha injetada por trigger no cache do banco descartável: fill, alterações da
ordem e consumo da reserva sofrem rollback; a rotina de segurança então registra
`cancel_effective` e libera a reserva em outra transação. Nenhum fill parcial
persiste. Nova ordem com liquidez e latência válidas executa normalmente.

Kill switch real SQL: A perde100/B ganha120 no mesmo token; agregado+20, mas
`DAILY_LOSS_LIMIT` engata. Outra fixture mantém A+200/B−200, âncoras independentes,
reabre conexões e move a marca0,50→0,20: perda60 de A não é compensada por B.
Sem marca válida, inventário líquido zero também não esconde risco:
`FINANCIAL_DATA_UNAVAILABLE`, sem rearme automático.

## Reprodução e resultados observados

As regressões [FIN-01/F1–F6](../../../apps/api/test/polymarket/paper/reconciliation.pg.test.ts) e [broker/cache/leitores](../../../apps/api/test/polymarket/paper/reconciliation-broker.pg.test.ts) agora fazem parte da suíte permanente; não é preciso copiar
o artefato histórico de `docs/roadmap/evidence` para testes.

```sh
GANSO_PG_RESULTS_DIR=/tmp/fin07-pg make test-postgres
npm run check --workspace @ganso-market/api
npm run check --workspace @ganso-market/web
make verify
```

O harness fornece a URL somente do banco descartável. Rejeita banco ausente,
falha, skip ou relatório incompleto. Execução final em 2026-09-17T14:01:25+00:00, código `a03490ccf07b05d927d045d937da699e4d962873`: **318 passed / 0 failed / 0 unexecuted, 26 arquivos** (287 casos SQL reais +31 unitários em arquivos mistos). Comando observado: `GANSO_PG_RESULTS_DIR=/private/tmp/fin07-repair-pg7 make test-postgres`, exit0.
[Resumo nominal](FIN-07-pg-results.json).

`make verify`: exit0, 2.478 JavaScript aprovados (287 skips SQL no gate source-only,
verificados separadamente no gate real),16 Rust,13+207 Python; formatação, lint,
build, scan de segredos e Compose aprovados. Typechecks API/web e diff também
passaram. CI remoto ainda deve confirmar source/PostgreSQL/Compose antes do merge.

As rodadas de desenvolvimento registraram erros de fixtures e expectativas
antes do sucesso: schema antigo do teste de kill switch, guarda DELETE/HOLD,
relógio futuro de relatório e latências taker, reserva zero não formatada e
cancelamento após rollback. Asserções foram alinhadas ao contrato comprovado;
nenhuma tolerância monetária ou guarda produtiva foi relaxada.

## Entrega e limites

Código `a03490ccf07b05d927d045d937da699e4d962873`. Publicação e implantação em andamento; CI remoto e SHA produtivo serão registrados no fecho. Saúde prévia verificada às13:57:48Z: release1f49f47, serviços existentes ativos e healthcheck aprovado.

Prontidão declarada é a financeira do contrato FIN-07 sobre fixtures não vazias,
com broker/cache/leitores e recuperação reconciliados. Não é alegação de lucro,
soak, conciliação de todo o histórico produtivo ou liberação live. Histórico
financeiro produtivo não foi consultado nesta reexecução; quantidade de eventos
sem dono/marca histórica confiável continua não medida (não presumida zero).
Nenhum capital, limite, parâmetro de operação ou kill switch foi manualmente alterado.
O deploy atualiza somente os serviços existentes afetados; não cria worker nem
habilita estratégia. EXEC-04 fornece as saídas usadas pela regressão; não se
antecipa o aceite de EXEC-05. Parar no FIN-07.

## Reparo mínimo da entrega operacional — issue198

[PR197](https://github.com/henrique-devel/ganso-market/pull/197) foi integrado em
main6279457, com CI/CD aprovado. API/paper/portfolio receberam o código e schema26;
configurações e banco foram preservados. A verificação adicional da resolução
identificou um bloqueio de sessão ociosa, liberado com rollback exclusivamente do
trabalho não confirmado, e em seguida um conjunto incompleto de estados de grupo.
A reversão para a imagem anterior reproduziu a mesma falha de grupo.

Correção em [OPS/RISK198](https://github.com/henrique-devel/ganso-market/issues/198):
antes do acoplamento, incluir irmãos negRisk sem estado que saíram do universo,
recomputando seus inputs versionados no mesmo corte. Grupos conectados são
percorridos até completar o conjunto necessário. Faltas de versão, falha no score,
conjuntos duplicados/inválidos e vetos continuam recusando prontidão. Nenhum estado
permissivo é fabricado; não há alteração de caps, timeout ou edição de cache manual.

A regressão SQL inclui um irmão terminal fora do universo e sem estado, obtém os
dois estados calculados e prova retry sem duplicar trabalho desnecessário.
`GANSO_PG_RESULTS_DIR=/private/tmp/fin07-resolution-pg make test-postgres`: exit0,
**319 passed/0 failed/0 unexecuted** (288 SQL reais+31 unitários mistos),26 arquivos;
os318 contratos anteriores também passam. Testes focados recompute/runner:39 passed.
`make verify` exit0:2478JS/16Rust/220Python;288 skips no gate source-only executados no PostgreSQL. A prontidão operacional final será registrada após implantar este reparo.
A causa da transação ociosa permanece para investigação própria em198; detalhes
operacionais ficam no diagnóstico local e não compõem o relatório público.
