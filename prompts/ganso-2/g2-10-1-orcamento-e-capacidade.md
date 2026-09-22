---
id: G2-10.1
macro: G2-10
rfc: RFC-052
section: S1
depends_on: [G2-03.3, G2-01.2, G2-04.4]
mode: analise
requirements: [RF-15]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-10.1 — Medir perfil e escolher manter ou migrar

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-052](../../docs/rfcs/RFC-052-ganso-2-custo-hospedagem.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 11.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Perfil BTC e métricas de recursos disponíveis
- docs/research/ganso-2-infraestrutura-2026-09-22.md: somente referência histórica
- Configuração efetiva de retenção/IA
- Preços oficiais atuais Hetzner/AWS/GCP

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Decisão cotada de manter ou plano concreto de destino/custo.

Cotar o perfil real com compute/disco/IP/tráfego/IA/impostos e custo temporário de duas máquinas. Comparar retenção/projeção e recursos, considerando menor carga após quiescência. Exigir capacidade, reserva 40% no lançamento e projeção 90 dias acima 25%; um modelo de projeção explícito basta, sem esperar 90 dias. Se pouca amostra, declarar limite.

## Validação e implantação

Economia mínima proposta 20% e tetoUS$ 80 incluindo adicionais; teste representativo de desempenho/capacidade, sem afirmar equivalência de vCPU entre provedores. Nenhuma compra baseada apenas em anúncio público.

PR/merge da decisão curta no runbook/estado. Se permanecer, concluir a frente com justificativa e marcar prompts de migração superseded, não blocked.

## Encerramento curto

Atualize apenas a linha **G2-10.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
