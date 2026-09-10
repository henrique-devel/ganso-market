# RFC-034 — Execução econômica da ordem final

**Status:** draft — proposta técnica de 2026-09-10; somente paper.
**Depende de:** RFC-038; RFC-022 D1–D3 já presentes no HEAD consultado.
**Relaciona:** RFC-031 para validade/frescor; RFC-032/033 para avaliação.
**Prompts:** `prompts/roadmap/btc/exec-01-custos-sem-duplicacao.md` até EXEC-05.

## Problema e evidência

Em `portfolio/ev.ts::computeEv`, o preço de execução já incorpora o bookwalk,
mas `slippageScaled` é novamente subtraído. Uma vantagem de US$0,10 pode
aparecer como US$0,05. O motor avalia uma cotação candidata; depois sizing e
`paper/policy.ts::decideOrderType` escolhem tamanho/tipo, sem contrato único que
revalide toda a economia da ordem final. São evidências do código `d38142c`.

Fees taker desconhecidas impedem agressão na policy global. Isso não demonstra
que maker seja bom nem que G4 esteja aprovado: ausência de amostra é ausência
de evidência. D4 da RFC-022 continua pendente, e `exitcycle.ts` descarta shorts
como `POSITION_EMPTY`. Maior vazão sem corrigir esses pontos produz uma
simulação incapaz de justificar aumento de risco.

## Decisões

### Um custo, uma incidência

O EV taker usa VWAP para o tamanho final, fee vigente e verificável, custo
de capital, buffer de resolução e margem definidos pela estratégia. Slippage
VWAP−melhor preço permanece diagnóstico; não volta a ser descontado do EV
baseado em VWAP. Walk incompleto ou preços inválidos recusam a ordem.

Maker usa preço limite e hipóteses explícitas de fill/seleção adversa. Tocar
o preço não garante fill. Não aplicar custos taker fictícios a maker; não
presumir rebate sem fonte. A versão do modelo de execução e a origem/idade
da fee acompanham a evidência. Null não vira zero nem taxa arbitrária.

### Contrato da ordem final

Depois de dimensionar e escolher tipo/preço, validar o mesmo token real,
dono, quantidade, lado, livro, limite probabilístico e fee que irão à ordem.
Uma mudança de livro, quantidade, tipo ou validade exige nova verificação.
Persistir breakdown e motivo de recusa vinculados ao decision/order ID,
sem editar a decisão append-only fora dos campos autorizados.

Para entradas, o EV líquido conservador deve superar a margem no tamanho
final. Para saídas, comparar manter versus reduzir e respeitar o motivo
de saída: uma redução obrigatória de risco pode realizar perda. Não submetê-la
ao gate de lucro de uma nova entrada. Frescor/expiry seguem RFC-031;
não introduzir relógios concorrentes nesta RFC.

### Execução simulada e amostra

Simular fills parciais, latência, profundidade consumida e cancelamento
efetivo. A soma dos fills não supera quantidade aceita nem reserva. Eventos
duplicados/reordenados e retomada após falha preservam resultado e cash.
Maker conserva regra de fila auditável; maker/taker têm métricas separadas
de fill rate, seleção adversa, fees e PnL. Reportar cobertura e incerteza;
G4 sem amostra continua sem evidência. Metadata de fee real tem procedência;
cenários assumidos ficam restritos ao replay e identificados como hipótese.

### Saídas da RFC-022 D4

Concluir D4-A com inventário do dono/token: long YES ou NO gera SELL;
short legado gera BUY de cobertura. Quantidade é o saldo redutível descontado
de saídas concorrentes. Nunca atravessar zero, abrir exposição oposta ou
fechar o inventário de outra estratégia. Deduplicação por decisão e uma
intenção de saída ativa por dono/token; partial fill reduz o saldo pendente.
HOLD posterior não cancela automaticamente. Kill switch, resolução e
reduce-only continuam aplicáveis conforme seus contratos existentes.

## Blocos e aceite

| Bloco | Entrega única | Depende de |
| --- | --- | --- |
| EXEC-01 | Custos puros sem dupla incidência | FIN-01 |
| EXEC-02 | Revalidação econômica da ordem final | EXEC-01, FIN-03, FIN-06 |
| EXEC-03 | Fidelidade dos fills/fees/cancelamento paper | EXEC-02, FIN-05 |
| EXEC-04 | Saídas D4-A dos dois lados | EXEC-03, FIN-07 |
| EXEC-05 | Prova integrada por dono e ordem | EXEC-04, QA-01 |

Fixtures independentes: melhor ask 0,50, VWAP 0,55, payoff esperado 0,65 e
custos adicionais zero ⇒ EV 0,10, slippage diagnóstico 0,05. Uma cota cabe
no primeiro nível e cem cotas deixam de passar; maker convertido em taker
deve incluir a fee. Sem fee verificada, nenhuma ordem taker nova.

Saída parcial e resolução posterior realizam cada cota uma vez; duas saídas
simultâneas não vendem o mesmo inventário; short coberto não vira long.
Toda entrada/saída aceita no fluxo de teste termina em ordem vinculada ou
recusa explicada. Fixture PostgreSQL prova transações, unicidade, reservas e
replay; nenhuma amostra vazia satisfaz aceite. Testes econômicos calculam os
resultados sem chamar a própria função que estão verificando.

## Escopo operacional

Não alterar G2/G4, caps, kill switch, mandato ou live. Não reconstruir D1–D3
sem regressão demonstrada. Preferir módulos pequenos a ampliar `brokerstore.ts`;
migration só se o contrato de evidência exigir e isolada no bloco responsável.
Reversão interrompe novas ordens paper e mantém fills/ledger para reconciliação.
FRESH-03 integra validade à policy final depois de EXEC-04.
Protocolo: `prompts/roadmap/btc/00-protocolo.md`; estado:
`docs/roadmap/BTC_EXECUTION_STATE.md`.
