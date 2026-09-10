# RFC-033 — Experimento prospectivo BTC1h e decisão por evidência

**Status:** draft — documentação solicitada em 2026-09-10; parâmetros operacionais não alterados.
**Objetivo:** descobrir rapidamente se há vantagem executável e distinguir sinal, execução e exposição.
**Dependências:** RFC-039 para observações; RFC-032 para carteira executável; RFC-040 para eventual microcapital.
**Prompts:** `EXP-01` → `EXP-02` → `EXP-03`.

## Problema e base existente

RFC-028 tem braços/configuração congelados; `fundamental/calibration.ts` e gates possuem
avaliações próprias. Resultados antigos selecionados numa grade são pesquisa exploratória.
Eles podem propor uma hipótese, mas não fornecer a validação prospectiva dessa mesma seleção.

## Decisões

1. **Manifesto congelado antes de observar o holdout.** Registrar hipótese, universo BTC1h,
   cutoff, versões/hashes de regra, benchmark, policy, execução, custos e dataset;
   braços, semente, controle, horários elegíveis, limites, métrica principal, comparações,
   revisão estatística, orçamento e critérios de encerramento. Guardar horário de congelamento.
   Histórico e treino terminam antes do período de avaliação. Nenhuma edição do mesmo manifesto:
   mudar regra ou escolher vencedor gera novo ID e holdout futuro, sem reutilizar o anterior.
   Prospectivo exige dados novos com recibo operacional `BTC-05`; paper observado exige
   `BTC-07`. Plano de rollout pronto não é evidência. O avaliador pode ser desenvolvido antes.
2. **Comparações pequenas.** Baseline congelado e controle aleatório determinístico por mercado.
   Primeiro testar mais oportunidades mantendo risco por entrada; depois mais tamanho mantendo
   os mesmos sinais. Maker e taker seletivo têm execução/custos próprios e hipótese identificada.
   Limitar e registrar número de variantes/comparações antes do teste; não varrer parâmetros
   silenciosamente. Resultado de seleção exploratória é rotulado como tal.
3. **Mais risco na pesquisa.** Cada cenário alternativo dispõe de US$1.000 simulados finitos.
   Exemplos para estudo de tamanho: perda máxima de US$10/US$20/US$40 por entrada
   (1%/2%/4% do capital inicial), mesmas decisões; não são alteração dos defaults atuais.
   Manifesto precisa declarar também perda total, stop diário, simultaneidade e regra de sizing.
   Sem esses campos, não iniciar execução da carteira. Não aumentar oportunidades e tamanho
   simultaneamente no contraste principal. Não pressupor que cenários independentes compartilham capital.
4. **Unidade e cobertura.** Há até 24 mercados horários por dia de 24 horas, não 24 amostras
   por braço, ordem ou tick. Denominador de mercados esperados deriva do calendário UTC e do
   contrato; distinguir descoberta, dados válidos, oportunidade, execução e resolução.
   Agrupar dependência intramercado e usar blocos de dia na incerteza; poucos blocos são
   insuficiência estatística explícita. Fills maker condicionais podem mudar a amostra: publicar
   intenção de negociar e execução, com comparações pareadas quando possíveis.
5. **Revisões pré-definidas.** Marcos propostos de 50/100/300 mercados elegíveis independentes
   por comparação, não por soma de braços. Aos 50: integridade, cobertura e perdas;
   aos 100: continuidade/futilidade; aos 300: avaliação confirmatória se o desenho permitir.
   Regras de parada financeira valem continuamente. Declarar ajuste para múltiplas comparações
   e olhadas intermediárias; sem desenho válido, IC/p são exploratórios e não promovem.
   Cobertura baixa alonga o calendário. Não prometer lucro ou conclusão em uma semana.
6. **Medição econômica.** Métrica principal e diferença para controle sobre carteira executável;
   publicar incerteza, drawdown, perda máxima, taxas, slippage, concentração e capital bloqueado.
   Probabilidade bem calibrada/Brier melhor isoladamente não comprovam lucro.
   Separar PnL de negociação, incentivos efetivamente observados e custos fixos conhecidos ou
   desconhecidos. Stress requer reexecução, sem cortar perdas pela metade.
7. **Decisão registrada.** Estados: `research`, `shadow`, `paper_evaluable`, `inconclusive`,
   `rejected`, `candidate_for_review`. Nenhum representa aprovação automática para live.
   Encerrar hipótese ruim é resultado útil. Nova versão não apaga falhas nem mistura amostras.
   Preservar G1–G6 e seus relatórios; gates de mandato BTC/microcapital são proposta distinta
   na RFC-040, com critérios explícitos e aprovação específica antes de capital real.

## Aceite por bloco

| Bloco | Evidência necessária |
| --- | --- |
| EXP-01 | Manifesto imutável rejeita holdout anterior ao freeze, riscos ausentes e versões alteradas |
| EXP-02 | Ticks/braços não inflam N; intervalos respeitam dias; seleção e revisões ficam visíveis |
| EXP-03 | Evidência insuficiente permanece inconclusiva; relatório não promove nem modifica gates |

## Preservação e reversão

Pinar dados de experimentos ativos e encerrados com evidência decisória conforme RFC-041.
Pausar avaliação não apaga decisões, manifesto, resultados negativos ou amostras excluídas.
Operação/despacho de ordens não integra estes prompts; produzir código e artefatos revisáveis.
