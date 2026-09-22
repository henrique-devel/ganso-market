---
id: G2-08.1
macro: G2-08
rfc: RFC-050
section: S1
depends_on: [G2-03.2, G2-07.1]
mode: codigo
requirements: [RF-12, RF-15]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-08.1 — Integrar respostas tipadas e limites de custo

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-050](../../docs/rfcs/RFC-050-ganso-2-jev-challenger.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.2 e 8.3.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/api/package.json e lockfile
- Novo módulo proposto apps/api/src/trading/models/jev.ts
- Contrato de decisão/experimentação neutro
- Documentação atual TypeSafe e pesquisa Jev aprovada

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Adaptador tipado, substituível e incapaz de consumir orçamento sem limite.

Criar interface substituível para pergunta restrita com output validado. Registrar modelo/prompt/input hash/tempo/custo e deadline; orçamento mensal proposto atéUS$ 5 com reserva atômica de custo para não exceder por concorrência. Cancelar/ignorar resposta tardia e limitar retries. Segredos só no backend/configuração protegida; nem logs nem frontend.

## Validação e implantação

Resposta malformada, erro, timeout, custo desconhecido e chamadas concorrentes no teto. Usar fixtures rotuladas como mock; chamadas pagas só com configuração/orçamento já disponibilizados para esse fim.

PR/merge/deploy desativado por padrão; nenhum modelo/serviço local extra.

## Encerramento curto

Atualize apenas a linha **G2-08.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
