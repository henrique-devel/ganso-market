---
id: G2-08.2
macro: G2-08
rfc: RFC-050
section: S2
depends_on: [G2-08.1, G2-07.3]
mode: codigo
requirements: [RF-01, RF-12]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-08.2 — Aplicar Jev ao mesmo candidato-base

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-050](../../docs/rfcs/RFC-050-ganso-2-jev-challenger.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.2 e 8.3.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Candidato/manifesto baseline
- Adaptador Jev G2-08.1
- Broker/risco e conta challenger
- Ledger/decisões e armazenamento de respostas

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Filtro Jev atua de forma isolável, sem autoridade sobre capital.

Implementar allow/veto/abstain sobre o mesmo candidato exógeno do baseline, com conta independente. Consultar uma vez por candidato 15 min, cache por versão/input e revalidar intenção antes do aceite. Preservar tamanho/saídas; registrar resposta original para replay. Se posições/caixa divergem, registrar elegibilidade própria em vez de forçar pareamento impossível.

## Validação e implantação

Timeout/erro bloqueiam só nova entrada challenger; saída/risco continuam. Entrada expirada, conta sem saldo e resposta duplicada não geram ordem; nenhum fallback heuristic é rotulado Jev.

PR/merge/deploy com ativação separada no próximo prompt; não resetar a conta-base para melhorar comparação.

## Encerramento curto

Atualize apenas a linha **G2-08.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
