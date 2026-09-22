---
id: G2-04.1
macro: G2-04
rfc: RFC-046
section: S1
depends_on: [G2-03.2]
mode: codigo
requirements: [RF-02]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-04.1 — Integrar metadados do instrumento e adaptador público

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-046](../../docs/rfcs/RFC-046-ganso-2-dados-hyperliquid.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7.3, 9 e 10.1.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- packages/contracts/src/trading/: contratos neutros
- apps/api/package.json e lockfile
- Novo adaptador proposto apps/api/src/venues/hyperliquid/
- Referências Jev/SDK na pesquisa aprovada; documentação oficial atual da venue

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Instrumento e metadados versionados disponíveis ao núcleo.

Criar adaptador público fino e fixar versão do SDK adotado. Obter BTC, precisão/mínimos, colateral, taxas de referência e parâmetros de margem/funding com origem/versão. Registrar licença/notices de trechos efetivamente reutilizados. Não copiar default de wallet, alavancagem Jev ou runtime Bun.

## Validação e implantação

Testes de contrato com respostas válidas/incompatíveis e falha de rede; uma consulta pública limitada quando rede disponível. Taxa desconhecida não vira zero.

PR/merge/deploy do adaptador desativado; nenhum cliente de execução real ou segredo.

## Encerramento curto

Atualize apenas a linha **G2-04.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
