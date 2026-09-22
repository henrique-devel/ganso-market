---
id: G2-02.1
macro: G2-02
rfc: RFC-044
section: S1
depends_on: [G2-00.2, G2-01.1]
mode: documentacao
requirements: [RF-15, RF-16]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-02.1 — Classificar dados protegidos e descartáveis

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-044](../../docs/rfcs/RFC-044-ganso-2-preservacao-retencao.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 10 e 11.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/api/src/polymarket/retention-manifest.ts e retention-policy.ts
- Schema, ledger e referências dos dados financeiros na base reconciliada
- docs/runbooks/retention-evidence.md e política de HOLD/pins, localizar
- docs/PRD-GANSO-2.0.md: seção 10

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Mapa de dados protegidos, raw dispensável e limites de retenção.

Mapear o conjunto financeiro, versões, ordens, dados pinados e corpus de pesquisa que devem permanecer no banco. Classificar raw sem referências e sem consumidor como candidato a descarte, sem apagá-lo. Reaproveitar seletores e proteções DATA existentes, conferir dependências transitivas e estimar capacidade por classe. O mapa orienta retenção e eventual limpeza delimitada; é um registro operacional curto.

## Validação e implantação

Conferir fechamento transitivo de referências e estimativa por catálogo. Nenhum agregado é declarado substituto de L2 sem contrato. Dados necessários permanecem protegidos no banco.

PR/merge documental; não comprar armazenamento nem remover HOLD nesta sessão.

## Encerramento curto

Atualize apenas a linha **G2-02.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
