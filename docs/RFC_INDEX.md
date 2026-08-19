# Índice das RFCs

As RFCs deste projeto são prompts operacionais para a IA de desenvolvimento. Cada uma delimita contexto, tarefas, artefatos, testes e condições de parada.

## Regra de execução

- Trabalhar em uma RFC por vez.
- Ler o PRD e o prompt mestre antes de editar.
- Não implementar dependência ainda não concluída.
- Não ampliar o escopo silenciosamente.
- Condição de parada tem precedência sobre “terminar rápido”.
- A IA deve registrar testes realmente executados e riscos residuais.

## Sequência

| RFC                                                  | Título                          | Dependências                  | Resultado                                                |
| ---------------------------------------------------- | ------------------------------- | ----------------------------- | -------------------------------------------------------- |
| [RFC-001](rfcs/RFC-001-foundation-runtime.md)        | Fundação e runtime              | nenhuma                       | monorepo, Compose, configuração e observabilidade mínima |
| [RFC-002](rfcs/RFC-002-auth-ip-http.md)              | Auth e perímetro                | RFC-001                       | autenticação single-user e gateway endurecido            |
| [RFC-007](rfcs/RFC-007-polymarket-paper.md)          | Polymarket analytics/paper (V2) | RFC-001 e RFC-002             | coleta V2/pUSD, recorder, sinais e paper sem execução    |
| [RFC-009](rfcs/RFC-009-polymarket-live-execution.md) | Execução Polymarket maker-side  | RFC-002 e RFC-007 + aprovação | live V2 maker-first com burn wallet na Polygon           |

## Descopo — 2026-08-18

Por decisão do proprietário, o projeto segue um único caminho: a Polymarket.
As RFCs do caminho Solana (RFC-001A, RFC-003, RFC-004, RFC-005, RFC-006 e
RFC-008) foram removidas do repositório junto com o código correspondente; os
textos permanecem no histórico do git. Uma retomada futura exigiria novas RFCs.

## Convenção de status

- `draft`: ainda pode mudar.
- `accepted`: autorizado para implementação.
- `in-progress`: a IA está trabalhando.
- `implemented`: critérios comprovados.
- `blocked`: uma condição de parada foi atingida.
- `superseded`: uma decisão posterior substituiu a RFC; não executar.

Nenhuma RFC pode ser marcada `implemented` apenas porque houve geração de código.
