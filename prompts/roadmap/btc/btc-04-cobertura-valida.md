---
id: BTC-04
rfc: RFC-039
depends_on: [BTC-03, DATA-02]
mode: code
---

# BTC-04 — Medir cobertura e validade por mercado

Implemente relatório limitado de cobertura do worker, sem redesenhar o painel.
Siga `00-protocolo.md`; use as queries/identidades publicadas por `BTC-03`.

## Contexto mínimo

- `docs/rfcs/RFC-039-btc-horario-contrato-benchmark-worker.md`: decisões 5–6.
- `migrations/0020_fast_strategy_registry.sql`: índices e histórico de decisões.
- `apps/api/src/polymarket/paper/api.ts`: padrões de leitura e guard.
- `apps/api/src/polymarket/paper/performance.ts`: delimitação de evidência principal.
- `apps/api/src/fast-backtest-cli.ts`: saída de relatório CLI.

## Escopo fechado

1. Relatório por período/versão: mercados esperados, descobertos, contratos
   válidos, dados válidos, decisões, execuções simuladas e resoluções.
2. Denominador horário deriva do calendário/contrato; declare ausentes e gaps.
   Contagem por mercado não cresce por tick, braço, tentativa ou retry.
   Use classificação central DATA-02; sintéticos ficam separados e preservados.
3. Exponha divergência Binance/TWAP, atrasos e motivos de exclusão por instante.
   Kill não apaga janela inteira nem torna dado inválido aceitável.
4. Use CLI ou GET autenticado/keyset; respostas e consultas limitadas.
5. Identifique sombra e PnL hipotético; não apresente retorno de carteira sem
   replay finito. Preserve relatórios e evidência dos gates principais.

## Verificação necessária

- Fixture com gaps reconcilia cada denominador e motivo de exclusão.
- Repetir ticks mantém N; mercado inválido não elimina outros válidos.
- Leitura não grava em tabelas; paginação não duplica/omite decisões.
- Teste regressão de performance/evidência principal se esse caminho mudar.

## Entrega

- Relatório reproduzível com exemplo pequeno e números reconciliados.
- Estado com query/entrada para avaliação `EXP-02`.
- Liste consultas verificadas e qualquer limite de cobertura disponível.

## Limite do bloco

Sem novas telas, alertas externos, reset global de janela ou ativação de worker.
Se execuções ainda não existem, campo fica não disponível com motivo; não zero.
