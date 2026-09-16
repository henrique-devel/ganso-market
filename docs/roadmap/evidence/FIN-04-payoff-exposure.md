# FIN-04 — exposição por perda máxima

Base integrada `1954c1c` (FIN-03), implementação em `codex/fin-04-payoff-exposure`.
Moeda USD, cotas e payoffs em inteiros escalados por `10^9`, versão `payoff-v1`.
Nenhum cap, capital, atribuição histórica, migration ou ativação live muda.

## Semântica e evidência

`B` continua basis bruto: custo pago no long e receita recebida no short.
Para cada payoff admissível `p`, perda residual = `sign(Q)B − Qp + F_pendente`;
o limite é o máximo dessa perda e zero. Long custa até B; short deve até
`|Q|−B`. Payout fracionário é arredondado conservadoramente, nunca liberando
um nano-USD por arredondamento. Não é VaR, probabilidade, marca ou stop-loss.

`feesPaidScaled` e `realizedPnlScaled` são informativos das posições presentes
na linha, não o total histórico da carteira. Fees pagas já pertencem ao R líquido
de FIN-03: não entram outra vez no risco residual. Perda desde C0 usa também R;
por exemplo, short Q=-10/B=4/F_pago=0,10/R=-0,10 tem risco residual 6 e perda
terminal desde C0 de 6,10. Uma fee ainda não debitada de 0,20 leva o residual a
6,20. O runner usa zero para fees futuras de resolução sob o contrato paper
atual (`brokerstore.ts` não cobra fee no settlement); custos de unwind não são
confundidos com taxas de resolução. Isso não declara uma tabela de fees live.

Eventos independentes somam perdas, mesmo com categoria/fator comuns e somente
uma perna `negRisk`. Todas as dimensões/chaves anteriores permanecem. Não existe
mais `bucketWorstCase=max`. A saída declara `conservative_sum`, `proven_scenarios`
ou `mixed`, com versão e referências; o log do runner identifica dono/versão/soma.

`PayoffProof` é uma entrada confiável de contrato: versão, referência de evidência,
escopo condition/event, pares token/condition e matriz completa de payoffs.
Cabe ao produtor verificar a exaustividade real antes de fornecer a prova; o
avaliador confere estrutura, cobertura e limites numéricos, não consulta contratos
externos nem autentica referências. Proof parcial, ambígua, inválida ou ausente
não autoriza compensação. O runtime não tem produtor verificado e **não fornece
provas**: permanece na soma conservadora. Fixtures de provas são contratos
sintéticos enumerados, nunca validação de um evento produtivo.

Com prova válida, só posições do mesmo dono e contrato se compensam. Cada
bucket considera seu próprio subconjunto de posições em TODOS os cenários;
portanto um hedge fora da categoria/mercado não abre headroom naquela dimensão.
Um resultado não possuído deve constar na prova e pode zerar todas as pernas.

O caminho de entrada usa as quantidades/basis/fees do mesmo replay FIN-03 de
`paper/main` usado para PnL, com metadados unidos depois. Nenhum net por token
apaga shorts de outro dono. O leitor sem seleção mantém compatibilidade do
ciclo de saída, rotulado legado desconhecido; FIN-04 não reatribui esse histórico.
O JSON da projeção é parâmetro SQL e não cache alternativo. Zero decimal é
filtrado numericamente. Atomicidade entre cálculo e aceite continua em FIN-05.

## Contrato entregue a FIN-05

1. Selecionar `(accountId,strategyId)` e versões ownership-v1/financial-v2 antes
   de calcular capacidade; não usar um total agregado como bankroll de cada dono.
2. Sob os locks/transação de FIN-05, reconstruir posições e reservas vigentes;
   `computeExposures` recebe quantidade assinada, basis bruto, fees pagas/R
   separados, teto de fees pendentes, identidades e todas as chaves dimensionais.
3. `capHeadroomFor` devolve USD de risco restante por cap, saturado em zero;
   evento e fator continuam restrições distintas, combinadas pelo menor headroom.
   A linha `total` é diagnóstico, não um novo cap. Caps mantêm os valores atuais.
4. Para BUY, reservar cash máximo e perda máxima, incluindo teto comprovado de
   fee. `computeSize` exige fee por cota explícita, usa o maior entre preço de
   execução e limite de entrada, divide headroom arredondando cotas para baixo
   e expõe `riskScaled` arredondado para cima, separado de `notionalScaled`.
   Zero de fee é uma afirmação explícita (maker paper atual), não ausência de dado.
5. Reservas e posições consomem o mesmo dono/dimensões; transferir somente o
   executado no fill, manter o resto até cancelamento/expiração efetivos, reservar
   inventário de saída, preservar retry/restart. Cash e risco são restrições
   paralelas, não dois débitos. Não usar valores de exibição de seis casas para
   reservar: entradas/saídas financeiras são nano-USD. Nenhuma reserva foi criada.

## Oráculos e verificação

- F3: payoffs `(0,0),(1,0),(0,1),(1,1)` para QX=QY=100 e BX/BY=30/40 dão
  PnL `−70,+30,+30,+130`: risco 70, inclusive com flags negRisk mistas.
- F1/F2: short Q=-10/B=4 e BUY10 NO/B=6 têm risco bruto 6; fee paga/pending
  separadas; short parcial Q=-6/B=2,40 tem residual 3,60.
- Evento sintético completo, duas pernas Q=10/B=6: `(1,0),(0,1)` dá risco 2;
  incluindo `(0,0)` o risco é 12. Sem prova também é 12. Buckets de uma perna
  continuam 6; estratégias/contas distintas somam 12. Posições opostas no
  mesmo token de donos distintos somam risco 4+6=10, apesar de Q agregado zero.
- Zero, lucro garantido, fees futuras, provas inválidas/ambíguas, payoff fracionário,
  isolamento por dimensão e sizing limitado ao headroom possuem expectativas
  constantes, sem usar a função de risco para construir o oráculo.
- PostgreSQL descartável exclusivo, migrations existentes até 0024: replay por
  duas estratégias → leitor SQL → exposição, com fees e exclusão do saldo zerado.

Resultados finais, SHA e publicação são registrados no [recibo](../receipts/FIN-04.md).
