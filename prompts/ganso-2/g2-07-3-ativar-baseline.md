---
id: G2-07.3
macro: G2-07
rfc: RFC-049
section: S3
depends_on: [G2-07.2, G2-06.3, G2-01.4]
mode: codigo-operacao
requirements: [RF-09, RF-11]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-07.3 — Ligar a conta-base automática com risco e dedup

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S3 da RFC-049](../../docs/rfcs/RFC-049-ganso-2-estrategia-base.md#s3), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 8.1 e 8.3.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Worker BTC e política-base
- Broker/risco/reconciliação BTC
- Manifesto e conta-base US$ 1.000
- Painel de decisões e pausa do operador

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Baseline toma decisões futuras rastreáveis e pode abster-se corretamente.

Conectar ciclo por barra fechada a candidato→risco→reserva→broker, com uma decisão idempotente por chave/versionamento. Ativar somente conta-base independente da manual. Definir posição única e redução antes de inversão; registrar candidato, veto e ordem. O loop não depende de IA nem reabre sinal já consumido após restart.

## Validação e implantação

Fluxo integrado com skip/entrada/saída, barra repetida e reinício; em produção checar uma decisão real quando houver input suficiente, sem forçar trade ou esperar lucro. Limites permanecem os do PRD.

PR/merge/deploy e ativação da estratégia paper estão autorizados. Resultado econômico ainda é experimental.

## Encerramento curto

Atualize apenas a linha **G2-07.3** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
