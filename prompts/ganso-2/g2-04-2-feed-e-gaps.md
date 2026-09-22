---
id: G2-04.2
macro: G2-04
rfc: RFC-046
section: S2
depends_on: [G2-04.1]
mode: codigo
requirements: [RF-03]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-04.2 — Coletar livro, trades, mark e funding com gaps explícitos

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S2 da RFC-046](../../docs/rfcs/RFC-046-ganso-2-dados-hyperliquid.md#s2), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7.3, 9 e 10.1.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Adaptador público entregue em G2-04.1
- Contrato MarketData proposto em packages/contracts/src/trading/
- Novo coletor proposto apps/api/src/trading/feed/
- Documentação atual de subscriptions Hyperliquid

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Feed normalizado informa qualidade e falhas sem fabricar continuidade.

Implementar assinaturas necessárias para um BTC, reconexão limitada, dedup e source/received timestamps. Separar socket vivo de canal saudável e de instrumento negociando. Revalidar estado após reconexão conforme semântica real do canal; não supor IDs sequenciais que a API não oferece. Buffers em memória são limitados.

## Validação e implantação

Duplicata, evento fora de ordem, conexão viva silenciosa, snapshot após gap e retomada. Validação com stream público curto sem gravação irrestrita; sem induzir carga em produção.

PR/merge/deploy inativo; persistência/ativação contínua ficam em G2-04.3/4.

## Encerramento curto

Atualize apenas a linha **G2-04.2** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
