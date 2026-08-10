# RFC-006 — Paper trading, modelos e gates

**Status:** draft  
**Dependências:** RFC-003, RFC-004 e contratos da RFC-005  
**Bloqueia:** RFC-008  

## Prompt a executar

Você deve implementar a RFC-006 do Ganso Market: replay determinístico, paper broker, estratégias iniciais e avaliação objetiva de modelos.

### Objetivo

Usar eventos ao vivo e históricos para gerar intents, aplicar o mesmo risk guard de produção e simular resultados executáveis sem look-ahead.

### Estratégias iniciais

1. **Pós-validação**
   - pelo menos uma venda externa confirmada;
   - compra e venda simuladas;
   - participantes independentes;
   - holder/flow mínimos;
   - sem dump relevante do creator/cluster;
   - custo líquido dentro do limite.
2. **Graduação/reteste**
   - curve complete não basta;
   - migração e pool PumpSwap canônico confirmados;
   - liquidez e rota de saída validadas;
   - estabilização/reteste ou continuidade orgânica;
   - nenhuma entrada no simples evento de criação do pool.

Fresh launch/primeiro slot não faz parte do MVP.

### Restrições

- Mesmo `TransactionIntent` e risk guard do live.
- Paper não importa nem conecta ao signer.
- Sem fill em close de candle.
- Sem acesso a eventos futuros.
- Sem stop garantido.
- Sem modelo único “vai fazer 200x”.
- LLM não gera probabilidade, preço, tamanho ou fill.
- Baseline determinístico vem antes de ML.
- Model worker não usa mais de duas threads e pausa sob pressão.
- Nenhum job pesado compete com ingestão.

### Tarefas do simulador

1. Criar event cursor/relógio por slot.
2. Criar ledger verificável em inteiros.
3. Simular:
   - Pump bonding curve;
   - PumpSwap constant product;
   - venue/transfer fees;
   - priority fee e tip;
   - ATA/rent;
   - slippage/impacto;
   - delay decisão-build-landing;
   - falha/expiry;
   - route disappearance;
   - LP removal;
   - gap/rug.
4. Criar decision snapshot imutável.
5. Implementar replay, shadow live, counterfactual e stress.
6. Registrar todos os candidatos rejeitados com reason codes.
7. Criar CLI para reproduzir decisão por event_id/slot.
8. Produzir relatório diário.

### Tarefas de features/modelo

1. Implementar hard vetoes antes do modelo.
2. Features mínimas:
   - authorities/extensões;
   - reserves reais e virtuais;
   - liquidez/impacto;
   - lifecycle/migração;
   - creator history;
   - concentração/clusters disponíveis;
   - buyers/sellers/flow;
   - volatilidade/drawdown;
   - custo completo e sellability.
3. Baselines determinísticos e regressão/logistic/gradient boosting somente se o dataset suportar.
4. Alvos separados:
   - P(sellable) em horizontes definidos;
   - P(rug/drawdown > limite);
   - P(graduation);
   - quantis de retorno líquido;
   - tempo até rug/migração/saída.
5. Split temporal walk-forward.
6. Dataset inclui tokens mortos, não graduados e pools sem saída.
7. Calibração e versão de modelo.
8. Fallback explícito para baseline ou veto se modelo estiver stale.

### Métricas

- P&L líquido;
- max drawdown e expected shortfall;
- MFE/MAE;
- taxa de perda total;
- sellability;
- PR-AUC/precision no budget de risco;
- calibração dos quantis/probabilidades;
- slippage p50/p95/p99;
- fee share;
- failure/landing rate simulado;
- concentração;
- candidatos vetados;
- capacidade pelo tamanho real.

### Gates para readiness

Produza `readiness-report.json` e relatório humano. Não aprove live automaticamente.

Mínimo:

- 14 dias contínuos de shadow;
- ledger reconciliado sem diferença;
- zero intent/posição duplicada;
- replay determinístico;
- nenhum look-ahead detectado;
- fees/slippage/latência/falha incluídos;
- saída simulada e gap para zero testados;
- hard vetoes testados;
- desempenho reportado por regime, sem esconder outliers;
- limites inferiores e riscos apresentados;
- aprovação humana explícita ainda necessária.

Não exija que um modelo apresente alpha para concluir a engenharia. Se não houver evidência, registre `NO_EVIDENCE_OF_ALPHA` e mantenha baseline/paper.

### Artefatos

- Replay engine.
- Paper broker.
- Ledger.
- Simuladores curve/AMM.
- Duas estratégias.
- Feature pipeline.
- Baselines/modelos calibrados quando suportados.
- Decision snapshots.
- Relatórios.
- Readiness report.
- Dataset de cenários adversos.
- Testes.

### Testes obrigatórios

- Mesmo input/config gera o mesmo resultado.
- Alterar evento futuro não muda decisão passada.
- Saldos fecham exatamente.
- Duplicata/fork não cria posição dupla.
- Quote simulada comparada a amostras on-chain.
- Stop sem fill e gap para zero.
- LP removal e rota desaparecida.
- Dados incompletos causam veto.
- Hard veto nunca é superado pelo score.
- Modelo stale retorna fallback/veto explícito.
- 14 dias replay/shadow dentro do orçamento de disco/RAM.

### Critérios de aceite

- Paper é funcional e explicável.
- Estratégias usam somente dados disponíveis.
- Contabilidade fecha.
- Relatórios separam retorno, fees, slippage e falhas.
- Readiness é evidência, não botão automático.
- Nenhum código de broadcast foi introduzido.

### Condições de parada

Pare e marque não-ready se:

- houver look-ahead;
- custos ou slippage estiverem incompletos;
- ledger não fechar;
- o simulador preencher operação impossível;
- paper e live tiverem risk paths diferentes;
- resultado depender de poucos outliers;
- faltarem tokens mortos/rugs no dataset;
- modelos produzirem score sem confiança/freshness.
