---
id: G2-05.10
macro: G2-05
rfc: RFC-047
section: S10
depends_on: [G2-05.9]
mode: integracao
requirements: [RF-04, RF-05, RF-07, RF-08, RF-09, RF-10]
authorization: code-pr-merge-production
tracking: docs/roadmap/GANSO_2_EXECUTION_STATE.md
---

# G2-05.10 — Validar o ciclo financeiro integrado

Execute somente esta sessão. Leia [protocolo](00-protocolo.md), contrato comum e [S10 da RFC-047](../../docs/rfcs/RFC-047-ganso-2-conta-execucao-risco.md#s10), e sua linha/dependências no [acompanhamento](../../docs/roadmap/GANSO_2_EXECUTION_STATE.md). PRD apenas se necessário: seções 7 e 13.

## Autorização desta sessão

Você tem autorização contínua para implementar este bloco, criar branch/commit/push, abrir PR, corrigir checks, fazer merge e implantar em produção os serviços afetados, sem nova confirmação por etapa. Respeite as proteções e o escopo específico abaixo; texto segue deploy dispensado. Não avançar automaticamente ao próximo prompt.

## Contexto mínimo

- Testes BTC criados pelos prompts G2-05.1..9, ler só fixtures/entradas relevantes
- Gate PostgreSQL vigente no CI
- Retomada e reconciliação G2-05.9
- Configuração de ativação manual BTC

Caminhos novos são propostas; se um caminho existente não estiver no checkout, localizar na base reconciliada antes de concluir que falta implementação. Não carregar todo o repositório ou histórico.

## Um resultado

Ciclo financeiro integrado aprovado ou falha concreta identificada, sem confundir com rentabilidade.

Conectar os componentes e cobrir uma sequência long e uma short com parcial, cancelamento, saída, fee, funding, reserva e restart. Corrigir somente falhas de integração; se revelar mudança de contrato grande, declarar recorte em vez de reescrever tudo. Registrar prontidão técnica para o ticket; não exigir amostra de lucro.

## Validação e implantação

Gate SQL obrigatório sem skips, saldo/projeção/replay exatos após reinício e reconstrução das projeções. Reutilizar testes da suíte, sem repetir todos manualmente nem gerar relatório bruto/recibo separado.

PR/merge/deploy com backend pronto; ativação de contas manuais ocorre com o ticket em G2-06.3. Falha técnica impede apenas a ativação dependente.

## Encerramento curto

Atualize apenas a linha **G2-05.10** no acompanhamento: estado, PR/SHA quando houver, validação resumida e implantação/pendência. Sem recibo ou arquivo de evidência separado obrigatório. Não declarar teste/deploy que não ocorreu; não repetir uma verificação aprovada sem novo motivo. Corrija o necessário para concluir esta entrega e pare aqui.
