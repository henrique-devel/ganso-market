---
id: G2-09.3
macro: G2-09
rfc: RFC-051
section: S3
depends_on: [G2-09.2, G2-06.4]
mode: codigo
requirements: [RF-13, RF-14]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-09.3 — Entregar comparação e diagnóstico na interface

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S3 da RFC-051](../../docs/rfcs/RFC-051-ganso-2-avaliacao-maturidade.md#s3), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.3, 9.1 e 15.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- apps/web/src/App.tsx e tela proposta Experimentos
- APIs de métricas G2-09.2
- Ficha de operação G2-06.4
- Status de capacidade/conexões/modelo

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Operador consegue escolher o próximo teste com base em informação compreensível.

Expor comparação por janela/versionamento, curva de patrimônio, drawdown, custos e motivos de divergência. Mostrar amostra, falhas de dados, influência Jev e status inconclusivo. Sistema mostra capacidade, reinícios e reconciliação com linguagem simples. Sem gráficos preenchidos com zeros para dado ausente.

## Validação e implantação

Conta sem trades, janela incompleta, modelo desativado e versão trocada; leitura não reescreve estatística. Conferir usabilidade sem produzir relatório visual obrigatório.

PR/merge/deploy da avaliação; metadados de experimento permanecem imutáveis.

## Encerramento curto

Atualize apenas a linha **G2-09.3** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
