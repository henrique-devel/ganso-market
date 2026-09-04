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
| [RFC-014](rfcs/RFC-014-polymarket-first-passage.md)        | Variante de primeira passagem (barreira)    | RFC-010                    | cobertura dos mercados "reach"/"dip to" da categoria crypto (incremento, não bloqueia) — **in-progress (2026-09-01), entregue como `crypto_updown_gbm@1.1.0` junto da RFC-019** |
| [RFC-015](rfcs/RFC-015-operator-dashboard.md)              | Painel do operador                          | RFC-011, RFC-012, RFC-013, RFC-016 | PnL no topo em todas as abas, aba "Visão geral" com agregador e feed keyset, dicionário PT com o código preservado, e o fim do `unknown` cru — **in-progress (2026-09-01)** |
| [RFC-016](rfcs/RFC-016-polymarket-intraday-horizon.md)     | Horizonte intradia e universo rápido        | RFC-007, RFC-010           | instante real de fim legível por todos os consumidores — evidência pontuável 36.212 → 74.412, última hora de vida 0 → 8.063 — **implementada e ativa em produção (2026-08-31)** |
| [RFC-017](rfcs/RFC-017-polymarket-shadow-replay.md)       | Shadow replay: varredura de config e replay de fonte | RFC-013, RFC-010 | **implementada e rodada em produção (2026-09-01)**: na população de hoje a taxa não muda **nenhuma** decisão em toda a lista até 0,40 (nem além de 100.000% a.a.), e o shadow teria agido diferente em 20,1% das linhas alcançáveis — 511 entradas só dele, com PnL ainda não medível |
| [RFC-018](rfcs/RFC-018-polymarket-gates-calibration.md)   | Gates mensuráveis e calibração                | RFC-013, RFC-012, RFC-010 | as três decisões de calibração do proprietário (27/08) em código: decision log grava quando o veredito muda (**fator medido 8,6×**), cap de fonte de resolução chaveado por família de cláusula, o estado `proposed` da UMA chegando ao breaker, e o caminho de registro de versão de modelo — **implementada e verificada em produção (2026-09-02)**: escrita do log 91,3 → 11,1 linhas/min (**8,2×**), `portfolio_exposures` chaveado por família de cláusula, `proposal_active` chegando ao breaker, e o achado da própria verificação — órfãos de exposição que prenderiam o G3 em FAIL |
| [RFC-019](rfcs/RFC-019-polymarket-updown-strike.md)        | Variante updown (strike = abertura) e cobertura por forma | RFC-014, RFC-016 | strike derivado do feed gravado as-of na abertura da janela; relatório com fatias e cobertura por forma — **in-progress (2026-09-01)** |
| [RFC-020](rfcs/RFC-020-deploy-sem-derrubar-o-banco.md)              | Deploy que não derruba o banco                          | RFC-001, RFC-007, RFC-010          | merge em `main` sem recriar o Postgres nem matar os workers; filtro de caminho no CD; lacuna de deltas registrada — **accepted (2026-09-04)** |
| [RFC-021](rfcs/RFC-021-silencio-do-feed-e-kill-switch.md)           | Silêncio do feed com conexões vivas e kill switch honesto | RFC-007, RFC-011, RFC-020        | parada silenciosa do WS vira lacuna `stream_silent`; gatilho lê deltas e snapshots e diz qual série calou; `closed` reflete a venue — **accepted (2026-09-04)** |
| [RFC-022](rfcs/RFC-022-ponte-runtime-e-saidas.md)                   | Ponte decisão→ordem, runtime de resolução e saídas      | RFC-012, RFC-013, PR-0 (b)         | ponte vê os aceites (frescor por `received_at`); graça para `NOT_READY`/`GENERATION_MISMATCH`; saída como ordem ou sinal — **accepted (2026-09-04)** |
| [RFC-023](rfcs/RFC-023-orcamento-da-api-e-erros-mudos.md)           | Orçamento de 1 s da API e erros mudos                   | PR-0 (a), RFC-015, RFC-002         | `statement_timeout` declarado por rota; `error_message`/`pg_code` em todo log de falha; `/live-volume` resolvido — **accepted (2026-09-04)** |
| [RFC-024](rfcs/RFC-024-descoberta-por-serie-e-livro-dos-rapidos.md) | Descoberta por série e livro garantido para o universo rápido | RFC-007, RFC-016, RFC-020, RFC-021 | horário BTC descoberto ≥ 60 min antes do fim e com livro a T−15 em ≥ 90 %; quota de `book_deltas` mantida em 52 GiB — **accepted (2026-09-04)** |
| [RFC-025](rfcs/RFC-025-disjuntor-de-parametro-redefinido.md)        | Disjuntor `PARAM_CHANGE` redefinido                     | RFC-013 (interpreta), RFC-018      | `PARAM_CHANGE` abre só em mudança real de parâmetro; universo rápido deixa de nascer congelado; medição antes/depois publicada — **accepted (2026-09-04)** |
| [RFC-026](rfcs/RFC-026-painel-home-broker.md)                       | Painel home broker (paper)                              | PR-0 (a), RFC-015, RFC-002, RFC-013 | Mesa, Carteira, Decisões, Resolução e séries sobre o React existente, só GET; `/paper/positions`, `/paper/orders` e `/series` publicados por location exato — **accepted (2026-09-04)** |
| [RFC-027](rfcs/RFC-027-decisoes-como-funil-e-sistema.md)            | Decisões como funil e Sistema com natureza do bloqueio  | RFC-026 (PR 1), RFC-015, RFC-018, RFC-023 | funil das 24 h sobre o log inteiro; "Quase" e "Congeladas"; natureza do bloqueio por gate com data quando há relógio — **accepted (2026-09-04)** |
| [RFC-028](rfcs/RFC-028-estrategia-fast-btc-updown.md)               | Estratégia `fast_btc_updown@0.1.0` em sombra            | PR-0 (b), RFC-022, RFC-025, RFC-011, RFC-016/019 | quatro braços com controle decidindo e gravando em sombra numa sub-carteira fora da evidência dos gates; zero ordens — **accepted (2026-09-04)** |
| [RFC-029](rfcs/RFC-029-tela-sombra-shadow-replay.md)                | Tela Sombra: shadow replay por job diário               | RFC-017 (emenda leve), RFC-015, RFC-026 | job no host grava JSON em volume só-leitura; endpoints GET que só leem disco; tela com ressalvas fixas e sem promoção — **accepted (2026-09-04)** |

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
