---
id: G2-09.1
macro: G2-09
rfc: RFC-051
section: S1
depends_on: [G2-07.3, G2-02.4]
mode: codigo
requirements: [RF-13]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-09.1 — Reproduzir decisões e conta a partir de dataset pinado

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S1 da RFC-051](../../docs/rfcs/RFC-051-ganso-2-avaliacao-maturidade.md#s1), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.3, 9.1 e 15.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Ledger/reconciliação e contratos BTC
- Marketstore, decisões, manifestos e pins
- Replay legado: localizar helpers realmente genéricos
- Novo runner proposto apps/api/src/trading/replay/

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Resultado reproduzível a partir de versão/dados declarados.

Criar dataset com corte temporal, fontes, versões e inputs indispensáveis, e replay de carteira finita. Usar respostas Jev capturadas se existirem; nunca chamar modelo atual para prever passado. Declarar ausência de dados/fidelidade e impedir comparação silenciosa de datasets diferentes. Export é função de produto, não relatório extra obrigatório.

## Validação e implantação

Mesma sequência recupera PnL, reservas e decisões; ordem de chegada, late funding, gap e resposta ausente têm resultado definido. Dataset mantém dependências sob pin.

PR/merge/deploy do runner sob demanda, sem varrer toda produção nem criar replay contínuo pesado.

## Encerramento curto

Atualize apenas a linha **G2-09.1** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
