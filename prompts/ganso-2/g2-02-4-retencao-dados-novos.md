---
id: G2-02.4
macro: G2-02
rfc: RFC-044
section: S4
depends_on: [G2-02.1, G2-03.1]
mode: codigo
requirements: [RF-15]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-02.4 — Limitar persistência de novos dados BTC

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S4 da RFC-044](../../docs/rfcs/RFC-044-ganso-2-preservacao-retencao.md#s4), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 10 e 11.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Contrato neutro de dados/identidade de G2-03.1
- apps/api/src/polymarket/retention-policy.ts: padrões reaproveitáveis
- Módulo proposto apps/api/src/trading/retention.ts
- docker-compose.yml ou configuração proposta do worker BTC

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Contrato de armazenamento disponível ao feed e proteção no limite de capacidade.

Criar contrato de TTL/quota/pins para raw, barras, decisões e financeiro do BTC, sem importar semântica binária. Defaults do PRD: raw não pinado até 7 dias/10 GiB; agregado 12 meses; logs 14 dias; ledger e decisões preservados. No limite, recusar escrita não essencial/novo experimento e sinalizar, nunca apagar pins para caber. Entregar seletores e execução restrita à política nova; descarte histórico fica separado.

## Validação e implantação

Fixtures de pin transitivo, quota cheia, retenção vencida, repetição e proteção financeira. SQL real quando houver persistência. Captura que não cabe é recusada sem degradação silenciosa de evidência.

PR/merge/deploy com policy versionada; retenção destrutiva apenas no conjunto novo explicitamente configurado e coberto pelo procedimento, não no corpus legado.

## Encerramento curto

Atualize apenas a linha **G2-02.4** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
