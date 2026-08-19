# Handoff do projeto Ganso Market

- Última atualização: 2026-08-19
- Branch principal: `main`
- Modo permitido no runtime atual: `paper`

Este documento registra o ponto de continuidade entre sessões. Ele não
substitui a ordem de fontes de verdade: solicitação atual do proprietário,
`docs/PRD.md`, RFC ativa e somente depois código/configuração.

## DECISÃO DE ESCOPO — caminho único Polymarket (2026-08-18)

**FATO INFORMADO:** o proprietário decidiu seguir por um único caminho: a
Polymarket. O desenvolvimento do bot para a rede Solana foi pausado e removido
do escopo.

**FATO VERIFICADO:** em consequência, foram removidos do repositório: as RFCs
do caminho Solana (RFC-001A, RFC-003, RFC-004, RFC-005, RFC-006, RFC-008) e
seus test-results, os módulos `domain/` e `ingestion/` do market-engine (e as
dependências `yellowstone-grpc-*`, `bs58`, `sha2`, `futures`), o probe
Yellowstone, os scripts `rfc001a_*` e o runbook de limpeza do host antigo. O
PRD (v0.2), README, índice de RFCs e prompt mestre foram reescritos para o
caminho único. Todo o histórico permanece no git; uma retomada futura do
caminho Solana exigiria novas RFCs.

- A migration `0003_domain_events.sql` permanece aplicada no servidor; suas
  tabelas ficam dormentes e vazias (nada escreve nelas). Migrations aplicadas
  não são removidas nem alteradas.
- O market-engine ficou reduzido à fundação (runtime, configuração,
  health/readiness); 14 testes Rust.
- A hot wallet Solana e sua prova de recuperação offline deixaram de ser
  bloqueios do projeto. A única wallet prevista é a burn wallet Polygon da
  RFC-009.

## DECISÃO DE PRODUTO — motor de quatro modelos e novas RFCs (2026-08-19)

**FATO INFORMADO:** o proprietário definiu o desenho do motor Polymarket
(oportunidade respondida por 8 perguntas; modelos fundamental, microestrutura,
risco de resolução e portfólio; critérios de entrada/saída; grafo lógico entre
mercados; campos do painel). Registro verbatim em
[`docs/research/plano-owner-polymarket-2026-08-18.md`](research/plano-owner-polymarket-2026-08-18.md).

**FATO VERIFICADO:** pesquisa profunda executada em 2026-08-19 (docs oficiais
V2, GitHub, Reddit, X/Truth Social, literatura quant, incidentes UMA; 8 agentes
de pesquisa, ~1M tokens) e consolidada em
[`docs/research/polymarket-deep-dive-2026-08.md`](research/polymarket-deep-dive-2026-08.md).
Destaques que moldaram as RFCs: fees V2 por categoria (fórmula
`C × feeRate × p × (1−p)`, taker only, crypto 0.07 — maker/post-only é
estruturalmente preferível), delay de 250ms para ordens marketáveis em
crypto/finance, não existe histórico oficial de book L2 (o recorder próprio é a
única fonte de microestrutura), UMA: bond ~US$ 750, liveness 2h, máx. 2
requests e resultado 50/50 possível, RTDS/Chainlink TWAP é o mesmo dado que
resolve mercados crypto (insumo direto do modelo fundamental).

**FATO VERIFICADO:** RFCs reestruturadas em 2026-08-19: a RFC-007 virou
fundação de dados/recorder V2; foram criadas RFC-010 (modelo fundamental),
RFC-011 (microestrutura e paper broker), RFC-012 (risco de resolução e grafo
lógico) e RFC-013 (motor de portfólio, entrada/saída e gates). PRD emendado
para v0.3 (POLY-09..16). RFC-009 agora depende dos gates G1–G6 da RFC-013.
Revisão adversarial de consistência aplicada (numeração cruzada, orçamento de
40 GB com reserva explícita, fontes macro na coleta, replay independente de
TTL).

## Estado atual

- **FATO VERIFICADO:** runtime composto por PostgreSQL, market-engine Rust
  (fundação), API Fastify (auth + recorder Polymarket), web React/Vite, worker
  Python opcional e Nginx. Somente Nginx publica porta; desenvolvimento usa
  `127.0.0.1:8080`, standalone usa `0.0.0.0:80`.
- **FATO VERIFICADO:** o host de produção usa Ubuntu 22.04 x86_64, usuário
  `root`, checkout em `/opt/ganso-market`, Docker 29.7.2/Compose 5.4.0.
  Somente SSH e Nginx publicados; UFW inativo.
- **FATO VERIFICADO:** CI/CD ativo: todo push na `main` roda os gates e, se
  aprovados, atualiza o servidor pelo comando SSH forçado com validação de
  release e rollback. Incidentes de 2026-08-17/18 resolvidos: a reinstalação de
  SSH do servidor tinha removido a chave de deploy (restaurada) e uma cópia
  manual de código do Mac tinha deixado `/opt/ganso-market` com dono UID 501
  (restaurado com `chown -R root:root`). **Lição operacional: nunca copiar
  código manualmente para o servidor; o caminho é merge na `main` → CD.**
- **FATO VERIFICADO:** autenticação em produção desde 2026-08-18: firewall
  Hetzner restringe a porta 80 ao IP do operador (confirmado por sondas
  externas de três países — todas timeout), conta única `owner` criada por CLI
  e login validado pelo proprietário. Modelo 1 do runbook
  [`auth-perimeter.md`](runbooks/auth-perimeter.md); HTTP em claro é risco
  aceito com origem única.
- **FATO VERIFICADO:** recorder Polymarket ativo em produção desde 2026-08-18
  (profile `polymarket`), após correção do crash de `source_ts` (epoch-ms →
  `Date`, PR #2): container estável, 2.314+ snapshots em 24 tokens com
  `source_ts` preenchido e defasagem média ~3,2 s. O deploy (`server-update`)
  não remove o container do profile, mas não troca a imagem dele: após deploy
  que altere o recorder, rodar
  `docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-recorder`.
- **FATO VERIFICADO:** ainda NÃO existem: modelos/estratégias, paper broker,
  wallet, signer, ordens e execução ao vivo.

## Sequência de RFCs

| RFC                                                   | Estado de acompanhamento                                                         | Evidência/condição                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| RFC-001 — Fundação e runtime                          | Implementada                                                                     | [`docs/test-results/RFC-001.md`](test-results/RFC-001.md)                                                         |
| RFC-002 — Auth e HTTP                                 | Implementada e publicada com perímetro (2026-08-18)                              | [`docs/test-results/RFC-002.md`](test-results/RFC-002.md)                                                         |
| RFC-007 — Polymarket: fundação de dados e recorder V2 | Reescrita 2026-08-19 (draft); recorder básico ativo em produção desde 2026-08-18 | [`docs/test-results/RFC-007-recorder.md`](test-results/RFC-007-recorder.md); expansão de coleta é o próximo passo |
| RFC-010 — Modelo fundamental (`q` + incerteza)        | Não iniciada (draft 2026-08-19)                                                  | Depende da RFC-007                                                                                                |
| RFC-011 — Microestrutura e paper broker               | Não iniciada (draft 2026-08-19)                                                  | Depende de RFC-007 e RFC-010                                                                                      |
| RFC-012 — Risco de resolução e grafo lógico           | Não iniciada (draft 2026-08-19)                                                  | Depende da RFC-007                                                                                                |
| RFC-013 — Motor de portfólio e gates                  | Não iniciada (draft 2026-08-19)                                                  | Gates G1–G6 habilitam a RFC-009                                                                                   |
| RFC-009 — Execução Polymarket maker-side              | Não iniciada; exige gates G1–G6 da RFC-013 + aprovação explícita                 | Burn wallet Polygon; risco jurisdicional aceito                                                                   |

As RFCs do caminho Solana foram removidas em 2026-08-18 (ver decisão acima).

## Decisões e invariantes vigentes

1. `ExecutionMode` aceita exclusivamente `paper` no runtime atual (o caminho
   `live` só é introduzido pela RFC-009, gated e desarmado por padrão).
2. Estratégia nunca acessa signer; nesta etapa sequer existe signer.
3. Secrets entram por arquivo montado. Private key e seed nunca usam env,
   Git, banco, logs, fixtures ou frontend.
4. Configuração falha fechada para modo/campo/arquivo desconhecido ou inválido.
5. Readiness depende de `SELECT 1`; liveness não mascara dependência ausente.
6. Money usa inteiro matemático exato: string decimal canônica na fronteira
   JSON e `bigint` internamente.
7. Logs de aplicação/access são JSON, têm correlation ID quando aplicável e
   não registram query string recebida.
8. `make down` e o smoke não removem volumes por padrão.
9. A fundação standalone pode publicar somente Nginx em IPv4/TCP 80; nenhum
   serviço interno ganha porta no host.

## Decisões pendentes e riscos residuais

- **RISCO:** não há TTL/retenção nas tabelas Polymarket; `polymarket_book_snapshots`
  cresce ~200 mil linhas/dia. Coberto pela RFC-007 reescrita (implementar).
- **RISCO:** não há backup externo automático, HA ou recuperação garantida do
  PostgreSQL, por decisão de escopo atual.
- **RISCO:** `ServiceHealth` é reproduzido manualmente entre linguagens; os
  schemas v1 são normativos, mas existe risco futuro de drift.
- **RISCO:** o market-engine não possui `healthcheck` declarativo no Compose;
  `make server-health` cobre sua readiness pela rede interna.
- **RISCO:** a chave de CD é equivalente a uma credencial `root`, apesar do
  comando SSH forçado.
- **RISCO:** o rollback automático restaura código e containers, mas não desfaz
  migrations; mudanças futuras de banco devem ser retrocompatíveis.
- **BLOQUEIO (RFC-009):** parecer jurídico/tributário e provisionamento da burn
  wallet na Polygon antes de qualquer execução real na Polymarket.

## Próximo passo mínimo

Implementar a RFC-007 reescrita (fundação de dados e recorder V2): expandir o
recorder em produção para regras versionadas + timeline UMA, livro completo com
deltas do universo, trades, OI/holders, fees/tick/min size versionados,
calendário macro, TTL/retenção dentro das quotas (30 GB de dados + 4 GB
headroom + 6 GB reservados às RFCs 010–013) e API de leitura. Depois, em
ordem: RFC-010 → RFC-011 → RFC-012 → RFC-013 → gates → RFC-009.

Operação do servidor: `cd /opt/ganso-market` seguido de `make server-status`,
`make server-health` ou `make server-logs`. Todo push em `main` executa os
gates e, se aprovados, atualiza produção.

## Como atualizar este handoff

Ao concluir cada atividade:

1. atualizar data, RFC ativa e estado da sequência;
2. registrar somente comandos realmente executados e resultados reais;
3. registrar decisões, bloqueios e riscos que continuam abertos;
4. apontar a evidência versionada correspondente;
5. declarar explicitamente o próximo passo mínimo;
6. nunca incluir conteúdo de secrets, credenciais ou material de wallet.

Para localizar o commit corrente sem manter hash autorreferente neste arquivo:

```sh
git log -1 --oneline
```
