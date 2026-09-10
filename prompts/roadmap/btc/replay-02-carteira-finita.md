---
id: REPLAY-02
rfc: RFC-032
depends_on: [REPLAY-01, FIN-07, EXEC-05]
mode: code
---

# REPLAY-02 — Executar uma carteira finita de US$1.000

Implemente o motor determinístico usando contratos financeiros já reconciliados.
Siga `00-protocolo.md`; leia no estado os símbolos de FIN-07/EXEC-05/REPLAY-01.

## Contexto mínimo

- `docs/rfcs/RFC-032-replay-carteira-finita-evidencia.md`: decisões 3–4.
- `apps/api/src/polymarket/paper/fastbacktest.ts`: execução atual dos braços.
- `apps/api/src/polymarket/portfolio/sourcereplay.ts`: contrafactual atual.
- `apps/api/src/polymarket/paper/brokerstore.ts`: contratos alterados por FIN/EXEC.
- `apps/api/test/polymarket/paper/fastbacktest.test.ts`: fixtures existentes.

## Escopo fechado

1. Inicialize US$1.000 finitos por cenário alternativo, com conta/estratégia/
   token explícitos; braços na mesma conta compartilham capital.
2. Reutilize aritmética/ownership da RFC-038 e execução final da RFC-034.
   Não crie um segundo cálculo de equity, taxas ou reservas.
3. Ordene colocação, latência, fills, cancelamentos, expiração, saídas e
   liquidação; documente desempate. Libere caixa no evento correto.
4. Sem refill, venda descoberta implícita ou capital reservado reutilizado.
   Evidência insuficiente de fill/taxa torna resultado líquido indisponível.
5. Produza ledger de simulação e estados reconciliáveis por evento.

## Verificação necessária

- Duas obrigações simultâneas não podem consumir os mesmos US$1.000.
- Fill parcial/cancelamento libera somente a reserva permitida.
- Restart, evento repetido e resolução repetida não duplicam caixa/PnL.
- Compare trajetória curta com ledger esperado calculado independentemente.

## Entrega

- Motor determinístico e fixtures de falta de caixa/perda/resolução.
- Estado com interface para stress e relatório dos próximos blocos.
- Evidência de reconciliação em cada evento, inclusive ordens abertas.

## Limite do bloco

Sem calibração, visualização, pesquisa de parâmetros ou ordens externas.
Se FIN/EXEC não estiverem concluídos, registre dependência; não copie defeitos antigos.
