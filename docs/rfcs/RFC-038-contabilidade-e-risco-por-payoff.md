# RFC-038 — Contabilidade e risco por payoff

**Status:** draft — proposta técnica de 2026-09-10; execução em blocos paper.
**Depende de:** RFC-011/013; QA-01 para provar integração PostgreSQL.
**Habilita:** RFC-034/039/040 e replay com carteira finita reconciliada.
**Prompts:** `prompts/roadmap/btc/fin-01-contrato-financeiro.md` até FIN-07.

## Problema e evidência

O ledger suporta posições assinadas, mas seus consumidores divergem. Em
`portfolio/exitstore.ts::loadPaperPnl` e `portfolio/state.ts::evaluateState`,
o caminho de equity usa marca menos custo também para shorts. Em
`portfolio/exposure.ts::bucketWorstCase`, um `negRisk` faz dimensões inteiras
usarem a maior perna. `portfolio/exitcycle.ts` considera shares negativos vazios.
`paper/bridge.ts` representa NO como SELL do token afirmativo. PnL diário usa
`resolved_at`, atrasando o reconhecimento de saídas anteriores à resolução.
São fatos do código consultado em `d38142c`; revalidar apenas esses símbolos.

O custo registrado de um short é receita inicial; não equivale à sua perda
máxima. `paper_positions`, hoje por token, também não isola duas estratégias
que negociam o mesmo ativo. Acrescentar `strategy_id` somente à ordem é insuficiente.

## Contrato financeiro

1. **Fonte:** eventos financeiros imutáveis e atribuição verificável por
   `(account_id, strategy_id, token_id)`. Cash, posições, PnL, risco e reservas
   usam esse mesmo dono. Estratégias compartilham infraestrutura, não dinheiro.
2. **Entrada nova:** BUY do token real YES ou NO. SELL reduz inventário positivo
   daquele dono. Não abrir short sintético. Validar token, outcome, condition e
   livro juntos; não fabricar o livro NO invertendo uma cotação YES.
3. **Legado:** preservar eventos e interpretação original versionada. Shorts
   existentes continuam mensuráveis e fecham por BUY reduce-only ou resolução.
   Atribuição incerta permanece numa conta legada explicitamente identificada,
   sem contaminar a carteira BTC nem inventar titularidade histórica.
4. **Equity:** capital inicial + PnL realizado líquido + PnL aberto assinado.
   Long: quantidade × (marca − entrada); short legado: |quantidade| ×
   (entrada − marca). Bid para vender, ask para recomprar; marca indisponível
   impede afirmar equity fresca e nova capacidade, sem zerar a posição.
5. **Realização:** saídas parciais, fees e liquidação reconhecidas no timestamp
   do evento econômico, em buckets UTC. Fees entram uma vez. A resolução
   posterior reconhece somente o restante, nunca novamente o lucro já fechado.
6. **Risco:** calcular maior perda entre payoffs admissíveis, incluindo cashflows
   e fees. Short de 10 cotas vendido a 0,40 perde até US$6 antes de fees;
   BUY de 10 NO a 0,60 também. Não confundir equivalência econômica com token.
7. **Agregação:** somar eventos independentes. Compensação dentro do mesmo
   contrato exige conjunto completo de cenários de resolução comprovados;
   categoria/fator compartilhados não autorizam usar `max(pernas)`. Sem prova,
   somar perdas conservadoramente, incluindo cenário de resultado não coberto.
8. **Reservas:** aceitar ordem reserva cash/perda máxima e inventário de saída
   em transação concorrente. Fill parcial transfere reserva para posição;
   cancelamento solicitado não libera antes do cancelamento efetivo. Retry,
   expiração efetiva, liquidação e reinício não duplicam ou abandonam reservas.

## Persistência e compatibilidade

FIN-01 fecha o menor desenho físico coerente. Preferência: atribuição aditiva
dos eventos sem UPDATE histórico e cache versionado por dono/token. Uma tabela
associativa append-only é opção quando alterar o evento violaria seu contrato;
nomes novos serão **propostos** no plano, não presumidos existentes.
FIN-02 entrega uma migration aditiva e escrita transacional de atribuição;
FIN-05, se necessário, uma migration separada para reservas. Numeração só no
momento da implementação. Leitores antigos seguem compatíveis durante a
transição. Migração não redistribui patrimônio nem reescreve ledger.

## Blocos e aceite

| Bloco | Entrega única | Depende de |
| --- | --- | --- |
| FIN-01 | Contrato, fixtures econômicas e decisão de esquema | — |
| FIN-02 | Atribuição persistente por dono | FIN-01 |
| FIN-03 | Fold/PnL/equity por dono e tempo econômico | FIN-02 |
| FIN-04 | Exposição por cenários de payoff | FIN-03 |
| FIN-05 | Reservas atômicas e concorrentes | FIN-04 |
| FIN-06 | Entrada com token real e inventário limitado | FIN-05 |
| FIN-07 | Reconciliação reproduzível da carteira | FIN-06, QA-01 |

Fixtures calculadas à mão: short perde US$1 quando marca sobe de 0,40 para
0,50 em dez cotas; eventos independentes de US$30 e US$40 podem perder US$70;
saída antes da meia-noite pertence ao dia correto; dois donos no mesmo token
não se compensam. Duas ordens simultâneas não gastam os mesmos US$1.000.
Teste inclui fills parciais, repetidos e fora de ordem, fee, resolução e restart.

Aceite: reconstrução do ledger igual ao cache por dono e ao agregado; cash,
equity, PnL e reservas reconciliados em moeda exata; diferença explicada por
evento, nunca tolerância arbitrária. SQL real prova concorrência e isolamento.
Histórico sem dono ou marca confiável aparece como pendência mensurável.

## Limites e reversão

Não mudar caps, liberar live ou aumentar capital. Limpeza da RFC-041 preserva
ledger, atribuições e fixtures protegidas. Reversão desativa leitores novos e
preserva eventos; não faz downgrade destrutivo. FIN-07 produz evidência de
prontidão, sem iniciar worker. Protocolo e estado: `prompts/roadmap/btc/00-protocolo.md`
e `docs/roadmap/BTC_EXECUTION_STATE.md`.
