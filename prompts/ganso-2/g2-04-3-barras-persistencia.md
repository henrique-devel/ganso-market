---
id: G2-04.3
macro: G2-04
rfc: RFC-046
section: S3
depends_on: [G2-04.2, G2-02.4]
mode: codigo
requirements: [RF-03, RF-15]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-04.3 — Persistir dados necessários e formar barras fechadas

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S3 da RFC-046](../../docs/rfcs/RFC-046-ganso-2-dados-hyperliquid.md#s3), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7.3, 9 e 10.1.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Feed de G2-04.2 e retenção de G2-02.4
- apps/api/src/database.ts
- Novos módulos propostos apps/api/src/trading/marketstore.ts e bars.ts
- migrations/: próximo número disponível

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Dados/barras consultáveis com qualidade e política de espaço aplicada.

Persistir raw limitado, metadados e barras 15 min/1 h com identidade de origem e versão de construção. Não preencher lacunas como se houvesse negócios; warmup incompleto impede sinal. Registrar pin dos inputs referenciados e projeções eficientes para interface, evitando revarrer raw a cada refresh. Usar migration aditiva se necessário.

## Validação e implantação

Barras na fronteira UTC, atraso, dedup, gap e reinício; SQL real demonstra persistência idempotente e quota/pin. Estimar volume por captura curta, sem afirmar sustentabilidade de 90 dias a partir dela.

PR/merge/deploy com gravação desabilitada até liberação do perfil no próximo bloco.

## Encerramento curto

Atualize apenas a linha **G2-04.3** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
