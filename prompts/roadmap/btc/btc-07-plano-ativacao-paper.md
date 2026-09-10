---
id: BTC-07
rfc: RFC-039
depends_on: [BTC-05, BTC-06, REPLAY-04, EXP-01, FRESH-03]
mode: operation-plan
---

# BTC-07 — Preparar operação paper com mandato explícito

Prepare rollout da carteira paper finita. Siga `00-protocolo.md`.
Aplicação exige escopo concreto de modo/alocação coberto pela autorização vigente.

## Contexto mínimo

- `docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md`: decisão 7 e aceite.
- `docs/rfcs/RFC-033-experimento-prospectivo-btc.md`: manifesto e orçamento.
- `docs/runbooks/single-server.md`: operação existente.
- `deploy/remote-deploy.sh`: alvos e reversão.
- `config/fast.json`: versão congelada que não será editada silenciosamente.

## Escopo fechado

1. Verifique recibos e código; BTC-05 exige observação operacional, não apenas
   plano. Confirme reconciliação, replay, validade temporal e manifesto congelado.
2. Produza `docs/runbooks/btc-paper-rollout.md` (novo): conta/estratégia, versão,
   braços, capital/alocação, stops, simultaneidade, custos, comandos e rollback.
3. Use até US$1.000 virtuais por cenário alternativo, conforme mandato escolhido;
   preserve reserva histórica/conta principal sem transferência implícita.
4. O alvo é paper; valores ausentes mantêm adapter desabilitado. Config não
   permite live; kill/breakers de execução, reservas e limites seguem obrigatórios.
5. Aplicar somente operação autorizada; observar decisões/ordens/fills/cancelamentos/
   saídas/resolução e reconciliar. Ausência de oportunidade não equivale a fill provado.

## Verificação necessária

- SHAs/configuração/ownership efetivos conferidos após aplicação, se ocorreu.
- Ledger e capital finito reconciliam; custos e lacunas ficam explícitos.
- Nenhuma ordem real ou contaminação dos gates/carteira principais.
- Rollback desabilita entradas e preserva tratamento seguro das posições existentes.

## Entrega

- Runbook e recibo separando plano, aplicação, intervalo observado e pendências.
- Somente recibo operacional com IDs/UTC comprova paper observado para EXP-02.
- Se não aplicado, registrar plano pronto; não declarar operação validada.

## Limite do bloco

Sem microcapital real ou aprovação implícita por lucro no replay.
O pedido atual de documentação não executa este rollout.
