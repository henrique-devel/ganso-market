# RFC-043 — Contenção e estabilidade do legado

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-01. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 2, 4 e 10.2. **Requisitos:** RF-10, RF-15, RF-16. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

A leitura de 22/09 é histórica; atualizar disco, reinícios e atividade antes de agir. Conter escrita dispensável sem apagar dados ou inventar encerramento financeiro. Paradas/restarts seletivos e reversíveis necessários ao bloco estão cobertos pela autorização de entrega. Não usar a urgência como autorização para DELETE, drop ou prune.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-01.1 — Diagnosticar capacidade e reinícios atuais.** [Prompt da sessão](../../prompts/ganso-2/g2-01-1-diagnostico-curto.md). Dependências: nenhuma.

**Entrega:** Causa localizada ou hipótese explicitamente limitada; capacidade atual e prioridade da contenção conhecidas.

**Contrato desta fatia:** Consultar o host somente para leitura com timeouts: espaço realmente disponível no volume, crescimento já coletado, reinícios, causa imediata nos logs filtrados e transações ociosas. Não imprimir segredos nem varrer corpus inteiro. Diferenciar falha de heap, OOM, SQL e watchdog sem pressupor uma delas. Registrar diagnóstico resumido e ação seletiva recomendada na linha do estado.

**Aceite proporcional:** Confirmar identidade SSH e observar métricas atuais. Se uma consulta falhar, registrar limite sem retentar indefinidamente. Não criar benchmark, dump JSON ou relatório separado obrigatório.

**Implantação:** Publicar apenas correções documentais necessárias; nenhuma escrita produtiva neste diagnóstico. G2-01.2 é a ação de contenção.

## S2

**G2-01.2 — Conter coleta e quiescer serviços dispensáveis.** [Prompt da sessão](../../prompts/ganso-2/g2-01-2-quiescencia-legado.md). Dependências: G2-00.1, G2-01.1.

**Entrega:** Crescimento dispensável interrompido e perfil legado controlado, sem perda de histórico.

**Contrato desta fatia:** Preparar e aplicar parada seletiva reversível dos produtores/estratégias legados dispensáveis. Suspender novas entradas, tratar ordens e reservas e manter gestão das posições que ainda precisem de dados; quando não houver saída executável, congelar com estado pendente explícito. Desabilitar somente timers/supervisores que reativariam os serviços selecionados. Preservar API de consulta, banco, volumes e histórico; registrar os nomes exatos na configuração/runbook de operação.

**Aceite proporcional:** Verificar que ordens/reservas não foram abandonadas sem estado, que os serviços escolhidos não ressurgem no próximo ciclo do supervisor e que a escrita não essencial foi contida. Checagem curta; não esperar sete dias aqui.

**Implantação:** Código/configuração por PR/merge/deploy e ação operacional seletiva estão autorizados. Manter caminho reversível sem rearmar estratégias automaticamente.

## S3

**G2-01.3 — Resolver a causa de reinícios que ainda afeta o produto.** [Prompt da sessão](../../prompts/ganso-2/g2-01-3-falha-do-paper.md). Dependências: G2-01.2.

**Entrega:** Falha corrigida no caminho necessário ou retirada do escopo com motivo verificável.

**Contrato desta fatia:** Se o componente segue necessário, reproduzir a falha encontrada e corrigir sua causa em mudança mínima, com encerramento/erro controlado. Não aumentar memória ou timeout para esconder vazamento. Se foi aposentado e não compartilha a causa com o núcleo, fechar como superseded com justificativa curta, sem desenvolver funcionalidade morta.

**Aceite proporcional:** Regressão da causa e um restart controlado do serviço necessário após deploy. Ausência de falha em teste curto não comprova soak. Se não houver causa reproduzível, registrar bloqueio específico sem alegar correção.

**Implantação:** PR/merge/deploy somente dos serviços afetados; rollback da release se o problema piorar. Aposentadoria verificada pode encerrar sem novo deploy.

## S4

**G2-01.4 — Prevenir transações ociosas e vazamento de conexões.** [Prompt da sessão](../../prompts/ganso-2/g2-01-4-transacoes-e-pools.md). Dependências: G2-00.1, G2-01.1.

**Entrega:** Caminho de transação necessário libera recursos corretamente; causa residual explicitada.

**Contrato desta fatia:** Investigar a origem pendente da transação ociosa e corrigir release/rollback/cancelamento nos caminhos de erro efetivamente usados. Respeitar pools e ordem de locks; não ampliar timeouts globais. Se o produtor original foi desligado, conferir se o helper compartilhado ainda carrega o defeito; não confundir zero sessões na fotografia com prevenção.

**Aceite proporcional:** Teste PostgreSQL real de erro no meio da transação, cancelamento e liberação da conexão; conferir execução normal. Em produção, uma consulta curta de atividade é suficiente para validar o deploy, sem dossier.

**Implantação:** PR/merge/deploy do consumidor afetado, preservando banco. Atualizar issue/estado com resumo se já fizer parte do fluxo GitHub do bloco.
