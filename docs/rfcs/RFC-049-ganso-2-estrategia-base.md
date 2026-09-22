# RFC-049 — Estratégia-base e experimento prospectivo

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-07. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 8.1 e 8.3. **Requisitos:** RF-11, RF-13, RF-09. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Uma hipótese de continuação de tendência: contexto 1 h, barras fechadas 15 min, manutenção máxima 6 h. Fechar uma regra determinística antes de olhar resultado futuro. Sem busca extensa de parâmetros, sem requisito de lucro para começar paper e sem frequência mínima de trades. Limites do núcleo são superiores à estratégia.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-07.1 — Fechar a regra e o manifesto do primeiro experimento.** [Prompt da sessão](../../prompts/ganso-2/g2-07-1-manifesto-baseline.md). Dependências: G2-05.10.

**Entrega:** Uma política-base explícita e congelável, suficiente para implementação sem inventar regras depois.

**Contrato desta fatia:** Escolher e especificar uma regra simples e reproduzível para tendência, entrada, stop por volatilidade, saída e warmup. Fixar parâmetros, fontes, custo e regras de avaliação antes da observação prospectiva. Definir referência BTC/caixa e variante Jev como filtro da mesma entrada. Versionar manifesto, sem otimizar usando o futuro nem alegar alpha validado.

**Aceite proporcional:** Exemplos manuais de sinal comprado, vendido, neutro, warmup e saída por 6 h; validação impede parâmetros contraditórios com risco. Sem backtest massivo nesta sessão.

**Implantação:** PR/merge da configuração/contrato; automação fica desligada. Não pedir confirmação de cada escolha rotineira dentro da hipótese aprovada.

## S2

**G2-07.2 — Implementar sinal, tamanho e saídas da regra congelada.** [Prompt da sessão](../../prompts/ganso-2/g2-07-2-politica-deterministica.md). Dependências: G2-07.1, G2-04.3.

**Entrega:** Mesmos inputs/versionamento geram a mesma intenção e motivo.

**Contrato desta fatia:** Implementar exatamente o manifesto, com candidato e motivos determinísticos e tamanho limitado por volatilidade/custos/risco. Entrada e saída usam timestamps as-of; risco planejado inclui custos. Nenhum caminho gera sinal durante gap/warmup incompleto. Não adicionar Jev ou retocar limiares para aumentar trades.

**Aceite proporcional:** Fixtures independentes para tendência long/short, neutralidade, cost veto, stop, saída temporal e impossibilidade de olhar barra em formação. Saída continua possível quando novas entradas estão pausadas.

**Implantação:** PR/merge/deploy de código ainda inativo para ordens automáticas.

## S3

**G2-07.3 — Ligar a conta-base automática com risco e dedup.** [Prompt da sessão](../../prompts/ganso-2/g2-07-3-ativar-baseline.md). Dependências: G2-07.2, G2-06.3, G2-01.4.

**Entrega:** Baseline toma decisões futuras rastreáveis e pode abster-se corretamente.

**Contrato desta fatia:** Conectar ciclo por barra fechada a candidato→risco→reserva→broker, com uma decisão idempotente por chave/versionamento. Ativar somente conta-base independente da manual. Definir posição única e redução antes de inversão; registrar candidato, veto e ordem. O loop não depende de IA nem reabre sinal já consumido após restart.

**Aceite proporcional:** Fluxo integrado com skip/entrada/saída, barra repetida e reinício; em produção checar uma decisão real quando houver input suficiente, sem forçar trade ou esperar lucro. Limites permanecem os do PRD.

**Implantação:** PR/merge/deploy e ativação da estratégia paper estão autorizados. Resultado econômico ainda é experimental.
