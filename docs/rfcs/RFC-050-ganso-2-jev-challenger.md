# RFC-050 — Jev como filtro opcional e medido

**Status:** accepted para execução de seus prompts quando selecionados. **Data:** 22/09/2026. **Marco:** G2-08. Criar esta RFC não implementa nem ativa o resultado.

**Fonte:** [PRD 2.0](../PRD-GANSO-2.0.md), seções 8.2 e 8.3. **Requisitos:** RF-12, RF-01, RF-15. **Roteiro:** [prompts](../../prompts/ganso-2/README.md). **Acompanhamento:** [estado 2.0](../roadmap/GANSO_2_EXECUTION_STATE.md).

## Contrato comum

O modelo permite ou veta candidato-base; não muda direção, tamanho, alavancagem, risco ou saída. Resposta com deadline, identidade, versão e custo. Falha provoca abstenção da entrada challenger, sem impedir gestão das posições. Simulação de saldo não torna a API gratuita. Credencial e orçamento são configuração explícita; mock nunca se apresenta como resposta real.

A [autorização de entrega](../ops/DEVELOPMENT_AUTHORIZATION.md#ciclo-ganso-20--entrega-com-registro-minimo-22092026) cobre código → PR → merge → produção no escopo do prompt. Verificar o resultado e registrar somente a linha de acompanhamento; sem recibo, screenshots ou dossiê obrigatório. Dados de negócio necessários ao ledger e ao replay continuam obrigatórios. Ler esta seção e apenas S correspondente ao prompt, não todas as sessões.

## S1

**G2-08.1 — Integrar respostas tipadas e limites de custo.** [Prompt da sessão](../../prompts/ganso-2/g2-08-1-adaptador-jev.md). Dependências: G2-03.2, G2-07.1.

**Entrega:** Adaptador tipado, substituível e incapaz de consumir orçamento sem limite.

**Contrato desta fatia:** Criar interface substituível para pergunta restrita com output validado. Registrar modelo/prompt/input hash/tempo/custo e deadline; orçamento mensal proposto atéUS$ 5 com reserva atômica de custo para não exceder por concorrência. Cancelar/ignorar resposta tardia e limitar retries. Segredos só no backend/configuração protegida; nem logs nem frontend.

**Aceite proporcional:** Resposta malformada, erro, timeout, custo desconhecido e chamadas concorrentes no teto. Usar fixtures rotuladas como mock; chamadas pagas só com configuração/orçamento já disponibilizados para esse fim.

**Implantação:** PR/merge/deploy desativado por padrão; nenhum modelo/serviço local extra.

## S2

**G2-08.2 — Aplicar Jev ao mesmo candidato-base.** [Prompt da sessão](../../prompts/ganso-2/g2-08-2-filtro-challenger.md). Dependências: G2-08.1, G2-07.3.

**Entrega:** Filtro Jev atua de forma isolável, sem autoridade sobre capital.

**Contrato desta fatia:** Implementar allow/veto/abstain sobre o mesmo candidato exógeno do baseline, com conta independente. Consultar uma vez por candidato 15 min, cache por versão/input e revalidar intenção antes do aceite. Preservar tamanho/saídas; registrar resposta original para replay. Se posições/caixa divergem, registrar elegibilidade própria em vez de forçar pareamento impossível.

**Aceite proporcional:** Timeout/erro bloqueiam só nova entrada challenger; saída/risco continuam. Entrada expirada, conta sem saldo e resposta duplicada não geram ordem; nenhum fallback heuristic é rotulado Jev.

**Implantação:** PR/merge/deploy com ativação separada no próximo prompt; não resetar a conta-base para melhorar comparação.

## S3

**G2-08.3 — Ativar comparação Jev dentro do orçamento.** [Prompt da sessão](../../prompts/ganso-2/g2-08-3-ativar-challenger.md). Dependências: G2-08.2, G2-06.4.

**Entrega:** Challenger real identificado e medido, ou integração pronta sem simular uma ativação que não aconteceu.

**Contrato desta fatia:** Expor origem real/mock, custo, latência, veto e indisponibilidade. Ativar challenger apenas se a credencial e o orçamento de consumo estiverem explicitamente disponíveis; do contrário entregar controle pronto, desativado, e registrar o único impedimento. Congelar comparabilidade e data de início; não retrofabricar respostas para alcançar o baseline.

**Aceite proporcional:** Uma chamada real limitada quando autorizada, bloqueio no orçamento e continuidade de saídas; UI distingue saldo fictício de gasto real. Não contratar plano, cobrar cartão ou aumentar teto implicitamente.

**Implantação:** PR/merge/deploy e ativação no orçamento já autorizado; ausência de API não bloqueia baseline nem avaliação sem Jev.
