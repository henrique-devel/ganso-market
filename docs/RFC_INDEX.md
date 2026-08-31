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

| RFC                                                        | Título                                      | Dependências               | Resultado                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [RFC-001](rfcs/RFC-001-foundation-runtime.md)              | Fundação e runtime                          | nenhuma                    | monorepo, Compose, configuração e observabilidade mínima                                                                    |
| [RFC-002](rfcs/RFC-002-auth-ip-http.md)                    | Auth e perímetro                            | RFC-001                    | autenticação single-user e gateway endurecido                                                                               |
| [RFC-007](rfcs/RFC-007-polymarket-data-foundation.md)      | Polymarket: fundação de dados e recorder V2 | RFC-001 e RFC-002          | coleta completa versionada (regras, livro+deltas, trades, OI, fees, disputas) com TTL                                       |
| [RFC-010](rfcs/RFC-010-polymarket-fundamental-model.md)    | Modelo fundamental (`q` + incerteza)        | RFC-007                    | estimativas calibradas por categoria (crypto, macro agendado) — **implementada**                                            |
| [RFC-011](rfcs/RFC-011-polymarket-microstructure-paper.md) | Microestrutura e paper broker               | RFC-007 e RFC-010          | timing/tipo de ordem e simulação realista com custos V2 — **código completo (2026-08-24); ativação pendente**               |
| [RFC-012](rfcs/RFC-012-polymarket-resolution-graph.md)     | Risco de resolução e grafo lógico           | RFC-007                    | score de resolução (UMA) e consistência entre mercados — **ativa em produção (2026-08-26)**                                 |
| [RFC-013](rfcs/RFC-013-polymarket-portfolio-engine.md)     | Motor de portfólio e gates                  | RFC-010, RFC-011 e RFC-012 | EV mínimo, Kelly fracionário, limites, painel e gates da execução — **código completo, fases A–E (2026-08-26); ativação pendente** |
| [RFC-009](rfcs/RFC-009-polymarket-live-execution.md)       | Execução Polymarket maker-side              | RFC-013 + aprovação        | live V2 maker-first com burn wallet na Polygon                                                                              |
| [RFC-014](rfcs/RFC-014-polymarket-first-passage.md)        | Variante de primeira passagem (barreira)    | RFC-010                    | cobertura dos mercados "reach"/"dip to" da categoria crypto (incremento, não bloqueia)                                      |
| [RFC-016](rfcs/RFC-016-polymarket-intraday-horizon.md)     | Horizonte intradia e universo rápido        | RFC-007, RFC-010           | instante real de fim legível por todos os consumidores; a evidência da última hora de vida deixa de ser descartada          |

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
