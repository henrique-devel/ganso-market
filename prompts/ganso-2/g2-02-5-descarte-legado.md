---
id: G2-02.5
macro: G2-02
rfc: RFC-044
section: S5
depends_on: [G2-01.2, G2-02.1, G2-00.2]
mode: operacao-condicional
requirements: [RF-15, RF-16]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-02.5 — Executar somente a limpeza legada delimitada

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S5 da RFC-044](../../docs/rfcs/RFC-044-ganso-2-preservacao-retencao.md#s5), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 10 e 11.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Classificação de dados protegidos e descartáveis de G2-02.1
- Executor de retenção existente, localizar na main
- docs/runbooks/retention-evidence.md
- Catálogo HOLD/pins e objetos exatos candidatos

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Conjunto exato tratado ou plano pronto aguardando somente autorização específica do descarte.

Preparar dry-run somente de raw classificado como dispensável, com objetos/cortes exatos, limite por lote, interrupção e espaço de trabalho. Manter no banco o histórico financeiro, pins e dados de pesquisa necessários; não incluir esses dados no descarte. Executar somente quando esse conjunto estiver coberto por autorização específica vigente; se não estiver, apresentar esse resultado pronto como única decisão pendente. Não desligar HOLD global, editar migration aplicada, apagar volume nem fazer prune genérico. Compactação é operação distinta, somente se couber e estiver coberta.

## Validação e implantação

Após cada lote, verificar proteção e espaço realmente recuperado, diferenciando DELETE de devolução física ao filesystem. Repetição é idempotente. Resultado cabe na linha de estado e no manifesto que orienta a ação.

PR/merge do delta de código/procedimento e aplicação do conjunto autorizado; sem ação destrutiva implícita. Este prompt não bloqueia o núcleo se quota e capacidade já permitirem operar.

## Encerramento curto

Atualize apenas a linha **G2-02.5** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
