# OPS-03 — RFC-021 D2/D3: prova local

Data: 2026-09-11, rodada final 12:50:31–12:50:35 UTC.
Base: `c528d5b0d74cc5cf8894ee953dd335df5f1e1b03`; mudanças deste bloco ainda não commitadas.
Estado: **code-verified**. Produção não consultada, sem deploy ou rearme operacional.

## Comparação e escopo

O recibo OPS-01 e os símbolos atuais confirmaram D2/D3 ausentes: o gatilho lia somente
snapshots; `rearmKillSwitch` era chamado apenas pelo endpoint manual; o runner condicionava
as verificações ao sucesso do settlement. Foram reaproveitadas as escritas transacionais
de engate/rearme, sem criar outro switch, endpoint ou migration. Alterações anteriores
presentes no checkout foram preservadas.

D2 consulta `MAX(received_at)` de snapshots e deltas; não usa snapshots_full. Qualquer
série ausente ou com idade **> 300.000 ms** engata `RECORDER_STALE`, com `series`,
`snapshots_age_ms` e `deltas_age_ms` no evento e no log (ausência = idade null).
A constante `RECORDER_STALE_MS` permanece 5 minutos; a igualdade não engata e não
certifica recuperação, que exige ambas as idades **>= 0 e < 300.000 ms**.

## Contrato dos ticks para OPS-04

- `KILL_SWITCH_TICK_MS = 60.000`, `KILL_SWITCH_HEALTHY_TICKS = 15`, exportados.
- Estado somente em memória, próprio de cada start do runner. Baseline no boot/reset;
  janela zero não conta. Com início em t0, observações nas janelas 1 a 15 permitem
  rearme a partir de t0+900.000 ms. Nenhum tempo anterior ao boot entra no contador.
- Cada janela tem 60 s; jitter dentro dela é permitido. Repetições na mesma janela
  não incrementam; janela perdida ou retorno a uma janela anterior zera a sequência
  e fixa nova baseline no instante observado. Não há execução retroativa de ticks.
- Erro em qualquer consulta/transação, feed ausente/velho/futuro, gap `stream_silent`
  aberto, motivo inelegível, auditoria ausente ou novo engate interrompem a sequência.
  Uma consulta que atravessa a janela perde validade; frescor é reavaliado após leituras
  e antes de autorizar commit, inclusive quando vence dentro da mesma janela.
- Gatilho e settlement disparam independentemente no mesmo timer; cada um tem guarda
  contra sobreposição e log de rejeição. Settlement lento/falho não suprime o gatilho.
- Stop invalida observações em voo. A última autorização ocorre dentro da transação,
  antes de COMMIT; stop não revoga um commit já autorizado. Confirmação tardia do
  commit não credita ticks futuros. Reinício começa outra sequência de 15 minutos.

## Proteções e auditoria

A transação toma `FOR UPDATE` no singleton antes de decidir; perda diária detectada
sob `RECORDER_STALE` promove o bloqueio para `DAILY_LOSS_LIMIT`. Congelamentos UMA são
preservados. O caminho humano registra `mode:manual`, inclusive se o operador usar o
texto `RECORDER_STALE`: esse engate nunca é rearmado automaticamente. Eventos legados
com reason `RECORDER_STALE` sem mode seguem elegíveis pela aprovação D3 existente.

No 15º tick, um lock SHARE de `polymarket_data_gaps` exclui escritas concorrentes até
commit e antecede nova consulta das duas séries/gaps. Rearme exige o mesmo engaged_at
e reason. Append e mudança de estado são atômicos; colisão de auditoria provoca rollback.
O evento `kill_switch_rearmed` registra `mode:auto`, `healthy_ticks:15`, `tick_ms:60000`,
`engaged_at`, `healthy_since`; chave `rearm:auto:<engaged_at ISO>` e log
`PAPER_KILL_SWITCH_AUTO_REARMED`. Nenhum UPDATE/DELETE do ledger foi introduzido.
O endpoint de rearme manual mantém sua assinatura e contrato.

## Verificação executada

Ambiente: Node v26.4.0, npm 11.17.0, Vitest 4.1.10; PostgreSQL 18.4-bookworm local descartável.

```sh
npm run test --workspace @ganso-market/api -- test/polymarket/paper/brokerstore.test.ts test/polymarket/paper/runner.test.ts test/polymarket/paper/api.test.ts test/polymarket/paper/ledger.test.ts
# 4 arquivos, 168 passed, nenhum skipped
GANSO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55245/ops03_test npm run test --workspace @ganso-market/api -- test/polymarket/paper/kill-switch.pg.test.ts
# 1 arquivo, 8 passed, nenhum skipped
npm run check --workspace @ganso-market/api
# passou
git diff --check -- apps/api/src/polymarket/paper/brokerstore.ts apps/api/src/polymarket/paper/runner.ts apps/api/test/polymarket/paper/brokerstore.test.ts apps/api/test/polymarket/paper/runner.test.ts
# passou
```

Fixtures cobrem cada série stale, ausência/igualdade, 14/15, duplicados concorrentes,
gaps, erro por etapa, reboot, atraso/relógio, perda, manual, legado, novo engate,
frescor vencendo durante escrita e colisão. PostgreSQL usa DDL real da migration 0008,
upstream mínimo e schema exclusivo por teste, BEGIN/COMMIT/ROLLBACK reais. Os oito testes
provam 14/15, rollback de INSERT, dois workers, colisão de chave, gap concorrente,
engate manual concorrente, manual chamado RECORDER_STALE e guards reais de UPDATE/DELETE.
Schemas descartados ao final; os guards do ledger permanecem ativos durante os testes.
O container exclusivo `ops03-kill-switch-20260911` foi parado e removido após a validação;
a porta 55245 não permanece disponível. Imagem e containers preexistentes preservados.

## Handoff

OPS-04 deve confirmar release por processo, configuração/cadência e aplicação das
dependências em produção antes de atribuir efeito operacional. Correlacionar boot,
engaged_at, frescor por série, gaps e evento/log de rearme; exigir healthy_ticks=15,
intervalo desde healthy_since >=900s e um único rearme por engate. Examinar gaps de
agendamento e erros antes de interpretar ausência de recuperação. A origem dos ticks
intermediários é memória local, não quinze eventos persistidos no ledger.

Não foram medidos latência/contensão dos locks, volume das consultas, saúde do feed ou
soak em produção. O ensaio SQL não aplica todas as migrations nem substitui integração
com a release implantada. A evidência operacional permanece responsabilidade do OPS-04,
dentro da autorização vigente; nenhum próximo bloco foi executado.
