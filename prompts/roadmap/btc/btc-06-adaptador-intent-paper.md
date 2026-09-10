---
id: BTC-06
rfc: RFC-039
depends_on: [FIN-07, EXEC-05, BTC-03]
mode: code
---

# BTC-06 — Conectar intent BTC à carteira paper isolada

Implemente somente o adapter executável, desabilitado por padrão.
Siga `00-protocolo.md`; consulte contratos FIN-07/EXEC-05/BTC-03 no estado.

## Contexto mínimo

- `docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md`: decisões 4 e 7.
- `apps/api/src/polymarket/paper/bridge.ts`: criação de intent e envio ao broker.
- `apps/api/src/polymarket/paper/brokerstore.ts`: `acceptPaperOrder` e ownership corrigido.
- `apps/api/src/polymarket/paper/fastpolicy.ts`: `FastOrderPlan` e contexto.
- `migrations/0020_fast_strategy_registry.sql`: estratégia e reserva histórica.

## Escopo fechado

1. Converta decisão BTC em intent paper com experimento, conta, estratégia,
   braço, token/lado, perda máxima e chave idempotente conforme contrato financeiro.
2. Revalide EV/tamanho/tipo/custos/frescor da ordem final; respeite kill/breakers
   de execução, reservas e saídas reconciliadas. Sombra nunca chama o adapter.
3. Conta finita e limite explicitamente configurados: até US$1.000 virtuais
   por cenário alternativo, sem somar cenários nem reutilizar capital comprometido.
4. Preserve reserva histórica de US$100/conta principal; nenhuma redistribuição
   automática. Sem mandato/alocação válidos, recuse paper com motivo verificável.
5. Eventos, posições, taxas e resolução carregam ownership correto e ficam
   fora da evidência principal; não crie segunda contabilidade.

## Verificação necessária

- Mesmo token em duas estratégias não mistura caixa, posição, fee ou resolução.
- Retry não duplica ordem/reserva; déficit de caixa recusa nova obrigação.
- Sombra/default desabilitado cria zero ordens; kill/breaker veta paper.
- Cenário integrado de fill parcial, cancelamento, saída e liquidação reconcilia.

## Entrega

- Adapter, testes integrados e contrato mínimo de configuração para BTC-07.
- Estado com evidências financeiras e limitações; nenhuma ativação executada.
- Prove que resultado BTC não contamina carteira/gates principais.

## Limite do bloco

Sem deploy, alteração da 0.1.0, cash transfer, signer ou ordem real.
Receber este prompt implementa o adapter; não autoriza mudar modo/alocação.
