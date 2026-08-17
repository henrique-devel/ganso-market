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

| RFC | Título | Dependências | Resultado |
|---|---|---|---|
| [RFC-001](rfcs/RFC-001-foundation-runtime.md) | Fundação e runtime | nenhuma | monorepo, Compose, configuração e observabilidade mínima |
| [RFC-001A](rfcs/RFC-001A-server-cleanup-yellowstone.md) | Histórico: limpeza do Ganso-bot | superseded pelo rebuild | não executar no host novo |
| [RFC-002](rfcs/RFC-002-auth-ip-http.md) | Auth e perímetro a revisar | RFC-001 | draft deve ser reescrito antes da implementação |
| [RFC-003](rfcs/RFC-003-yellowstone-ingestion.md) | Ingestão Yellowstone | RFC-001 | stream filtrado, filas e backpressure |
| [RFC-004](rfcs/RFC-004-events-storage.md) | Eventos e persistência | RFC-003 | decoders, estado, PostgreSQL e TTL |
| [RFC-005](rfcs/RFC-005-wallet-risk-signer.md) | Wallet, risco e signer | RFC-001 e RFC-004 | fronteira de assinatura local e políticas |
| [RFC-006](rfcs/RFC-006-paper-model-gates.md) | Paper e gates do modelo | RFC-003 a RFC-005 | simulador, estratégias, bundle/insider e readiness |
| [RFC-007](rfcs/RFC-007-polymarket-paper.md) | Polymarket analytics/paper (V2) | RFC-001, RFC-002 e RFC-004 | coleta V2/pUSD, recorder, sinais e paper sem execução |
| [RFC-008](rfcs/RFC-008-solana-beta-execution.md) | Execução beta Solana | RFC-001 a RFC-006 + aprovação | canário e micro-live Pump/PumpSwap com envio privado |
| [RFC-009](rfcs/RFC-009-polymarket-live-execution.md) | Execução Polymarket maker-side | RFC-002, RFC-004 e RFC-007 + aprovação | live V2 maker-first com burn wallet na Polygon |

## Convenção de status

- `draft`: ainda pode mudar.
- `accepted`: autorizado para implementação.
- `in-progress`: a IA está trabalhando.
- `implemented`: critérios comprovados.
- `blocked`: uma condição de parada foi atingida.
- `superseded`: uma decisão posterior substituiu a RFC; não executar.

Nenhuma RFC pode ser marcada `implemented` apenas porque houve geração de código.
