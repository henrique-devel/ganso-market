# RFC-040 — Mandato BTC e progressão de experimento para escala

**Status:** draft — especificação solicitada em 10/09/2026; sem ativação live.
**Dependências:** contratos RFC-038/039/034, replay RFC-032 e avaliação RFC-033.
**Objetivo:** separar prontidão técnica, orçamento experimental e prova para escala.
**Prompts:** GATE-01, GATE-02 e GATE-03 em `prompts/roadmap/btc/`.

## 1. Decisão proposta e limites

O proprietário quer aprender mais rápido e aceita estudar maior risco. A referência
continua US$1.000 paper. A banca real, perda experimental total e prazo real não foram
informados; não inventar esses parâmetros. Nenhum prompt desta RFC envia ordens reais.

O mandato específico BTC1h não exige negociar macro só para preencher “duas categorias”.
Essa regra vale para um novo relatório de experimento; G1–G6 históricos não viram PASS.
A RFC-009 continua controlando signer/executor e sua implementação antecipada continua
proibida até uma emenda expressamente autorizada. Draft não é um bypass em runtime.

## 2. Três decisões diferentes

1. **Técnica:** token/payoff corretos, fonte contratual comprovada, reservas e limites
   por estratégia, ordem final válida, idempotência, reconciliação, restart seguro,
   detecção de stale e preservação de saídas/cancelamentos seguros. Testes de falhas
   podem comprovar reação a clarificações, sem esperar um evento real raro.
2. **Experimento:** orçamento total integralmente perdível, ticket/mínimo da venue,
   teto conjunto de posições+ordens, drawdown/perda, duração, hipóteses e corte.
   Menos certeza estatística pode ser aceita explicitamente neste estágio; não
   dispensar engenharia nem representar o estágio como lucro provado.
3. **Escala:** PnL prospectivo líquido robusto à execução adversa, capacidade de size,
   dependência temporal, concentração, seleção de candidatos e custos operacionais.
   PnL de rebates só entra quando observado. Resultado inconclusivo não libera escala.

O relatório deve distinguir `insufficient_evidence`, `failed`, `ready_for_review` e
`not_applicable` com motivo. Relatório não concede grant de live nem altera limits.

## 3. Artefatos mínimos

- Mandato versionado por estratégia: universo, account id, dataset/model/policy ids,
  invariantes, critérios e evidência de autorização de mudanças normativas.
- Matriz que associa cada gate legado à finalidade preservada, adaptação proposta,
  justificativa e teste. Não deletar nem rescrever relatórios passados.
- Relatório read-only com estados distintos: operação, paper, experimento e escala.
  Nenhum requisito ausente ganha default zero, booleano true ou aprovação presumida.
- Plano de integração da RFC-009 com lista do que ainda NÃO existe (signer, client,
  reconciliation live, saldo, rede/contratos). Não denominar prontidão paper como live.

## 4. Blocos

| ID | Entrega | Dependência |
|---|---|---|
| GATE-01 | Mandato e matriz de critérios, sem mudar runtime | EXP-01 |
| GATE-02 | Relatório separado de prontidão com proveniência | GATE-01, EXP-03, EXEC-05 |
| GATE-03 | Plano concreto de experimento e emenda 009, sem execução | GATE-02 |

Um orçamento real não definido limita apenas GATE-03; não bloqueia engenharia paper.
Receber o prompt GATE-03 autoriza preparar o plano, não preencher as decisões do dono.

## 5. Critérios de aceite

- Candidato lucrativo porém contabilmente divergente não fica pronto tecnicamente.
- Candidato sem N suficiente permanece inconclusivo; nenhum p-value selecionado
  retrospectivamente ou shadow PnL sem capital finito conta como prova de escala.
- Paper/replay, taxas e perdas conciliam com RFC-038/034/032 na mesma versão.
- Mínimo de ordem cabe no teto: cinco cotas a .90 custam 4,50; um teto de 2 sobre
  capital 100 precisa recusar, não arredondar para cima e violar risco.
- Elegibilidade e disponibilidade para novas ordens/saída verificadas na fonte atual.
  O [registro de restrições](https://help.polymarket.com/en/articles/13364163-geographic-restrictions)
  de 10/09 incluía BR/DE; não reutilizar a premissa “VPS alemão permite operar”.
- Nenhuma ativação, assinatura, concessão implícita, afrouxamento do gate legado,
  reinício de relógio ou aprovação histórica reescrita por este pacote.

## 6. Fora de escopo e condição de interrupção

Sem construção de executor/signer nesta RFC, transferência, contorno de geoblock,
nova infraestrutura, símbolos extras ou UI ampla. Falta de elegibilidade/orçamento
real bloqueia ativação futura, não a avaliação paper. Parar a proposta de escala
se dados, saldo, custos ou payoff não forem verificáveis; registrar a falta exata.
