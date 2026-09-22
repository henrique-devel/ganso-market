# RFC-051 — Replay, avaliação e maturidade

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-09. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 8.3, 9.1 e 15. **Requisitos:** RF-13, RF-14, RF-10. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Validação do software, observação operacional e evidência econômica são resultados separados. Não criar dossiê por sessão: métricas do produto e um resumo no estado bastam. Os sete dias operacionais e o diagnóstico econômico de cerca de 30 dias são janelas do experimento, não esperas obrigatórias em todo PR. Quando a janela faltar, registrar observação pendente sem inventar aprovação.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-09.1 — Reproduzir decisões e conta a partir de dataset pinado.** [Prompt da sessão](../../prompts/ganso-2/g2-09-1-replay-dataset.md). Dependências: G2-07.3, G2-02.4.

**Entrega:** Resultado reproduzível a partir de versão/dados declarados.

**Contrato desta fatia:** Criar dataset com corte temporal, fontes, versões e inputs indispensáveis, e replay de carteira finita. Usar respostas Jev capturadas se existirem; nunca chamar modelo atual para prever passado. Declarar ausência de dados/fidelidade e impedir comparação silenciosa de datasets diferentes. Export é função de produto, não relatório extra obrigatório.

**Aceite proporcional:** Mesma sequência recupera PnL, reservas e decisões; ordem de chegada, late funding, gap e resposta ausente têm resultado definido. Dataset mantém dependências sob pin.

**Implantação:** PR/merge/deploy do runner sob demanda, sem varrer toda produção nem criar replay contínuo pesado.

## S2

**G2-09.2 — Calcular resultado líquido e contribuição do filtro.** [Prompt da sessão](../../prompts/ganso-2/g2-09-2-metricas-e-atribuicao.md). Dependências: G2-09.1.

**Entrega:** Desempenho explicado por risco, exposição e custos, sem somar cenários.

**Contrato desta fatia:** Implementar retorno líquido, drawdown, tempo exposto, giro, custos/IA/funding e operações vetadas. Mostrar trading líquido e resultado após custo operacional alocado sem dupla incidência. Referências normalizadas distinguem 25%/100% de exposição e spot/perpétuo. Métricas aceitam challenger ausente; não esperar integração Jev para tornar baseline avaliável.

**Aceite proporcional:** Casos manuais verificam fórmulas, patrimônio zero/negativo, funding atrasado, datas UTC, custo compartilhado e comparações com risco diferente. Eventos correlacionados não contam como observações independentes.

**Implantação:** PR/merge/deploy de métricas de leitura; nenhum parâmetro de estratégia é alterado.

## S3

**G2-09.3 — Entregar comparação e diagnóstico na interface.** [Prompt da sessão](../../prompts/ganso-2/g2-09-3-painel-experimentos.md). Dependências: G2-09.2, G2-06.4.

**Entrega:** Operador consegue escolher o próximo teste com base em informação compreensível.

**Contrato desta fatia:** Expor comparação por janela/versionamento, curva de patrimônio, drawdown, custos e motivos de divergência. Mostrar amostra, falhas de dados, influência Jev e status inconclusivo. Sistema mostra capacidade, reinícios e reconciliação com linguagem simples. Sem gráficos preenchidos com zeros para dado ausente.

**Aceite proporcional:** Conta sem trades, janela incompleta, modelo desativado e versão trocada; leitura não reescreve estatística. Conferir usabilidade sem produzir relatório visual obrigatório.

**Implantação:** PR/merge/deploy da avaliação; metadados de experimento permanecem imutáveis.

## S4

**G2-09.4 — Conferir retomada e janela operacional.** [Prompt da sessão](../../prompts/ganso-2/g2-09-4-prontidao-operacional.md). Dependências: G2-09.3.

**Entrega:** Prontidão operacional aprovada ou observação pendente com data e motivo precisos.

**Contrato desta fatia:** Fazer ensaio limitado de desconexão/restart no ambiente apropriado e consultar histórico de sete dias quando já disponível. Verificar reconciliação, reinícios inesperados e orçamento, sem esperar em loop ou criar automação Codex não solicitada. Se faltarem dias, registrar desde quando observa e data mínima de retorno; código entregue permanece separado do aceite temporal.

**Aceite proporcional:** Eventos confirmados preservados, reconciliação antes de entradas e ausência de divergência na janela efetivamente disponível. Sete dias incompletos recebem observacao, não aprovado nem falha fictícia.

**Implantação:** Publicar correções mínimas por PR/merge/deploy quando necessárias; uma leitura sem mudança não exige PR vazio. Registro só na linha do estado.

## S5

**G2-09.5 — Concluir o primeiro ciclo econômico com honestidade.** [Prompt da sessão](../../prompts/ganso-2/g2-09-5-diagnostico-economico.md). Dependências: G2-09.3, G2-07.3.

**Entrega:** Uma decisão econômica proporcional à amostra, inclusive inconclusiva, com próximo experimento delimitado.

**Contrato desta fatia:** No retorno a esta sessão, analisar a janela futura disponível, preferencialmente cerca de 30 dias, sem reotimizar parâmetros no mesmo conjunto. Avaliar resultado depois de custos, risco, concentração e contribuição Jev. Concluir continuar, nova hipótese, rejeitar ou inconclusivo; ausência de Jev real limita apenas essa comparação.

**Aceite proporcional:** Comparação sem lookahead, soma de contas ou exclusão de perdas. Amostra pequena não comprova alpha; registrar tentativas/versionamentos relevantes. Não produzir relatório volumoso obrigatório nem esperar 30 dias nesta execução.

**Implantação:** PR documental se houver atualização do experimento/estado; nenhuma promoção live, capital novo ou reajuste automático de risco.
