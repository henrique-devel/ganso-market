# RFC-052 — Custo e eventual mudança de hospedagem

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-10. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 11. **Requisitos:** RF-15. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

Teto recorrente totalUS$ 80, metaUS$ 30–50 condicionada a cotação. Permanecer no host é resultado válido. Não presumir que dados atuais cabem em disco menor, que existe estoque ou que preço histórico é cotação. Não contratar, cancelar serviço ou abrir perímetro apenas por autorização de deploy. Migração não autoriza perda de ledger.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-10.1 — Medir perfil e escolher manter ou migrar.** [Prompt da sessão](../../prompts/ganso-2/g2-10-1-orcamento-e-capacidade.md). Dependências: G2-03.3, G2-01.2, G2-04.4.

**Entrega:** Decisão cotada de manter ou plano concreto de destino/custo.

**Contrato desta fatia:** Cotar o perfil real com compute/disco/IP/tráfego/IA/impostos e custo temporário de duas máquinas. Comparar retenção/projeção e recursos, considerando menor carga após quiescência. Exigir capacidade, reserva 40% no lançamento e projeção 90 dias acima 25%; um modelo de projeção explícito basta, sem esperar 90 dias. Se pouca amostra, declarar limite.

**Aceite proporcional:** Economia mínima proposta 20% e tetoUS$ 80 incluindo adicionais; teste representativo de desempenho/capacidade, sem afirmar equivalência de vCPU entre provedores. Nenhuma compra baseada apenas em anúncio público.

**Implantação:** PR/merge da decisão curta no runbook/estado. Se permanecer, concluir a frente com justificativa e marcar prompts de migração superseded, não blocked.

## S2

**G2-10.2 — Preparar instalação, corte e rollback do destino.** [Prompt da sessão](../../prompts/ganso-2/g2-10-2-preparar-migracao.md). Dependências: G2-10.1.

**Entrega:** Procedimento executável e reversível; apenas eventual decisão externa restante identificada.

**Contrato desta fatia:** Se migração foi escolhida, preparar configuração mínima, compatibilidade de imagens/arquitetura, transferência direta dos dados, sincronização final e corte com um writer por conta. Definir rollback depois de novas escritas sem perder eventos e prazo de coexistência. Deixar proposta de contratação e custo extraordinário pronta quando ainda não autorizada; não inventar credencial/host.

**Aceite proporcional:** Ensaio em destino já disponível/autorizado ou ambiente isolado equivalente, declarando limites; transferência e sequência de corte coerentes. Plano contempla saldo/configuração/versões e acesso do operador.

**Implantação:** PR/merge/deploy dos scripts necessários no escopo; provisionamento pago/perímetro somente se já houver autorização concreta vigente.

## S3

**G2-10.3 — Migrar o ambiente aprovado e verificar o custo final.** [Prompt da sessão](../../prompts/ganso-2/g2-10-3-executar-migracao.md). Dependências: G2-10.2, G2-05.10, G2-09.4.

**Entrega:** Migração aceita dentro do orçamento, ou rollback aplicado com estado financeiro preservado.

**Contrato desta fatia:** Aplicar cópia inicial, validar, suspender escritas na origem, copiar delta final, reconciliar e cortar. Impedir duas instâncias escrevendo/operando a mesma conta. Manter rollback até critérios do plano; não apagar origem para provar economia. Se destino ou custo ainda não foi autorizado, parar somente essa ação depois de deixar plano pronto.

**Aceite proporcional:** Nenhuma transação confirmada perdida no corte; saldos/ordens/versões iguais, acesso/health e orçamento real. Encerramento do recurso antigo somente no escopo específico já autorizado e após validação. Registrar evento operacional no experimento.

**Implantação:** PR/merge de ajustes e deploy no destino aprovado; acompanhamento curto. Não contornar identidade SSH nem geoblock.
