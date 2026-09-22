# RFC-042 — Base reconciliada e destino do legado

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-00. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 4 e 10.2. **Requisitos:** RF-16. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Main, checkout e produção são superfícies diferentes. Preservar mudanças locais; verificar se cada correção já foi integrada antes de reaplicá-la. A ausência de recibo não prova ausência de código. O inventário é enxuto e serve para decidir destino, não para reconstruir toda a história. FIN-07 entregue é ponto de partida a revalidar.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-00.1 — Reconciliar a base de desenvolvimento.** [Prompt da sessão](../../prompts/ganso-2/g2-00-1-base-reconciliada.md). Dependências: nenhuma.

**Entrega:** Base de implementação identificada e mudanças locais preservadas; diferenças de versão explicadas.

**Contrato desta fatia:** Comparar HEAD, main e mudanças locais sem reset, checkout destrutivo ou stash indiscriminado. Preparar checkout isolado na main atual quando necessário; classificar diferenças em já integradas, trabalho a preservar e delta útil. Atualizar apenas a baseline curta do estado 2.0, incluindo a situação FIN-07/EXEC-05/issue 198. Publicar os documentos deste ciclo que ainda não estejam na main antes de iniciar dependentes, sem misturar alterações alheias.

**Aceite proporcional:** Conferir que cada mudança local continua acessível e que referências de versão existem. Para esta entrega documental, verificar links/diff e checks exigidos, sem executar suíte financeira sem motivo.

**Implantação:** Publicar documentação por PR/merge; respeitar dispensa de deploy de texto. Não atualizar containers só para uniformizar SHAs.

## S2

**G2-00.2 — Dar destino ao código e backlog herdados.** [Prompt da sessão](../../prompts/ganso-2/g2-00-2-destino-do-legado.md). Dependências: G2-00.1.

**Entrega:** Nenhuma família de pendência fica sem destino; dependências de remoção explicitadas.

**Contrato desta fatia:** Mapear componentes e blocos antigos para manter, adaptar, corrigir, arquivar ou remover. Identificar consumidores, dados protegidos e alvo 2.0 de cada item. Usar uma tabela compacta no próprio estado, seção Destino do legado; ampliar somente com achados úteis. Não corrigir todo o backlog nem marcar trabalho substituído como implementado.

**Aceite proporcional:** Para candidatos a remoção, conferir referências de código, Compose, CI, health e timers. Conferir transferência de OPS/DB/DATA/FIN/EXEC/FRESH/BTC/REPLAY/EXP/GATE; pendência real recebe destino e responsável lógico.

**Implantação:** PR documental sem recriação de serviços; remoções e quiescência pertencem aos prompts próprios.
