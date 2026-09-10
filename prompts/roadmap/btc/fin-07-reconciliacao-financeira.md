---
id: FIN-07
rfc: RFC-038
depends_on: [FIN-06, QA-01]
mode: read-only
---

# FIN-07 — Provar reconciliação financeira

Execute somente este bloco. Leia `00-protocolo.md`, RFC-038/Aceite e as
evidências FIN-01..06/QA-01 em `docs/roadmap/BTC_EXECUTION_STATE.md`.
Leia os resumos e artefatos necessários, não o histórico completo.

## Contexto mínimo

- `apps/api/src/polymarket/paper/ledger.ts`: fold/eventos.
- `apps/api/src/polymarket/paper/brokerstore.ts`: caches e reservas.
- `apps/api/src/polymarket/portfolio/exitstore.ts`: PnL por dono.
- `apps/api/src/polymarket/portfolio/state.ts`: equity.
- `apps/api/src/polymarket/portfolio/exposure.ts`: risco.
- `apps/api/test/polymarket/portfolio/integration.pg.test.ts`: suíte SQL.

## Um resultado

Criar relatório `docs/roadmap/evidence/FIN-07-reconciliation.md` (proposto),
com prova reproduzível de que ledger, caches e estado financeiro concordam.

1. Execute fixtures independentes FIN-01 na infraestrutura SQL validada QA-01.
2. Compare por dono/token e agregado: cash, fees, realizado diário/semanal,
   posição, marca, equity, risco, caixa reservado e inventário reservado.
3. Reconstrua cache em banco de teste a partir dos eventos; compare antes/depois
   e após retry/restart. Não sobrescreva caches ou eventos em produção.
4. Se usar leitura histórica autorizada, registre corte UTC/HEAD e atribuição
   desconhecida. Não faça backfill nem transfira legado para BTC neste bloco.

## Aceite

Diferença monetária zero na precisão definida, ou divergência explicada por
evento e marcada pendente. Não aceitar tolerância arbitrária como reconciliação.
Teste duas estratégias negociando simultaneamente o mesmo token com caixa
finito; prove reservas, PnL no tempo e ausência de compensação entre donos.
SQL real deve ter executado; suíte ignorada não é sucesso.
Ausência de dados históricos não substitui fixtures nem impede prova local.

## Limites

Nenhuma alteração de runtime ou dados operacionais. Falha abre correção mínima
no bloco responsável, com evidência; não reparar silenciosamente no relatório.
Não iniciar worker, operar live ou mudar limites. EXEC-04 ainda entrega saídas.

## Encerramento

Atualize FIN-07 no estado com comandos, resultados e pendências mensuráveis.
Declare prontidão financeira apenas se os critérios passarem. Pare aqui.
