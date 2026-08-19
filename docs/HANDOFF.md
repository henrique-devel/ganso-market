# Handoff do projeto Ganso Market

- Última atualização: 2026-08-18
- Branch principal: `main`
- Modo permitido no runtime atual: `paper`

Este documento registra o ponto de continuidade entre sessões. Ele não
substitui a ordem de fontes de verdade: solicitação atual do proprietário,
`docs/PRD.md`, RFC ativa e somente depois código/configuração.

## Estado atual

- **FATO VERIFICADO:** RFC-001 implementada e verificada localmente.
- **FATO VERIFICADO:** runtime composto por PostgreSQL, market-engine Rust,
  API Fastify, web React/Vite, worker Python opcional e Nginx local.
- **FATO VERIFICADO:** somente Nginx publica porta. Desenvolvimento usa
  `127.0.0.1:8080`; o novo modo standalone usa `0.0.0.0:80`. PostgreSQL,
  engine, worker e métricas permanecem internos.
- **FATO VERIFICADO:** implementados e testados offline (2026-08-15/16):
  autenticação single-user (RFC-002), core de ingestão Yellowstone filtrada
  (RFC-003), decoders/eventos de domínio Pump/PumpSwap (RFC-004) e o core do
  recorder Polymarket (antecipa a RFC-007). `make verify` verde
  (143 testes TypeScript, 74 Rust — 66 engine + 8 probe —, worker e scripts).
- **FATO VERIFICADO:** ainda NÃO existem: modelos/estratégias, paper broker,
  wallet, signer, ordens e execução ao vivo. A ingestão/decoders/recorder têm o
  loop ao vivo desligado (não iniciados por container) — bloqueios de credencial
  Yellowstone e de decisão de deploy documentados por RFC.
- **FATO VERIFICADO:** nenhum container está ativo na máquina local; o volume local
  `ganso-market_postgres_data` está preservado.
- **FATO INFORMADO:** o proprietário reconstruiu o servidor em 2026-08-14. A
  RFC-001A e o runbook de limpeza do host antigo estão obsoletos e não devem ser
  executados.
- **FATO VERIFICADO:** o host reconstruído usa Ubuntu 22.04 x86_64, usuário
  `root`, host key Ed25519 confirmada e checkout em `/opt/ganso-market`.
- **FATO VERIFICADO:** Docker 29.7.2 e Compose 5.4.0 foram instalados pelo
  repositório oficial; o serviço Docker está ativo e habilitado no boot.
- **FATO VERIFICADO:** o standalone foi publicado e validado externamente em
  `http://178.105.65.251/` em 2026-08-14.
- **FATO VERIFICADO:** o workflow de CI/CD está publicado na `main`, o
  environment `production` contém os dois secrets de deploy e a variável de
  repositório `DEPLOY_ENABLED=true` está ativa. A chave Ed25519 dedicada usa o
  comando forçado instalado no servidor; a cópia privada temporária local foi
  removida depois do primeiro deploy.
- **FATO VERIFICADO:** a primeira execução de produção do CD, no commit
  `e11aaa6`, passou pelos gates de fonte e Compose, atualizou o servidor e
  validou o gateway público com sucesso em 2026-08-15.
- **FATO VERIFICADO:** o proprietário iniciou o `polymarket-recorder` no
  servidor em 2026-08-18 (profile `polymarket`). O ciclo Gamma gravou 12
  mercados em `polymarket_markets`, mas todo insert de snapshot falhou com
  erro 22008 do PostgreSQL: o WebSocket envia `timestamp` como epoch em
  milissegundos e o recorder passava a string crua para a coluna
  `TIMESTAMPTZ source_ts`. A rejeição não tratada derrubava o processo e o
  container ficou em crash-loop com `polymarket_book_snapshots` vazia.
- **FATO VERIFICADO:** correção implementada e testada na branch
  `claude/proximas-etapas-apos-ssh-6344a1`: `sourceTsToDate()` converte
  epoch-ms para `Date` (valor inválido vira `NULL`) e falha de persistência
  agora fecha o socket com log JSON em vez de matar o processo. Suíte da API
  com 63 testes verde. Pendente: merge/deploy e reinício do serviço com o
  profile no servidor.

## Sequência de RFCs

| RFC | Estado de acompanhamento | Evidência/condição |
| --- | --- | --- |
| RFC-001 — Fundação e runtime | Implementada localmente | [`docs/test-results/RFC-001.md`](test-results/RFC-001.md) |
| RFC-001A — Limpeza e preservação Yellowstone | Substituída pelo rebuild | Não executar no host novo |
| RFC-002 — Auth e HTTP | Implementada no código (2026-08-15) | [`docs/test-results/RFC-002.md`](test-results/RFC-002.md); publicação pública gated pelo runbook de perímetro |
| RFC-003 — Yellowstone | Core implementado e testado offline (2026-08-15) | [`docs/test-results/RFC-003.md`](test-results/RFC-003.md); loop ao vivo bloqueado por credencial |
| RFC-004 — Eventos e persistência | Core implementado e testado offline (2026-08-15) | [`docs/test-results/RFC-004.md`](test-results/RFC-004.md); escrita ao vivo depende do feed |
| Recorder Polymarket (antecipa RFC-007) | Core implementado e testado offline (2026-08-15) | [`docs/test-results/RFC-007-recorder.md`](test-results/RFC-007-recorder.md); coleta ao vivo é decisão de deploy |
| RFC-005 — Wallet, risco e signer | Não iniciada | Live continua proibido; depende das gates anteriores |
| RFC-006 — Paper e modelos | Não iniciada; emendada 2026-08-15 (bundle/insider, regime, gates numéricos) | Não existe simulador/modelo nesta fundação |
| RFC-007 — Polymarket paper (V2) | Não iniciada; emendada 2026-08-15 (V2/pUSD, recorder, clima/macro, anti-longshot) | Analytics/paper; habilita RFC-009 após gates |
| RFC-008 — Execução beta Solana | Não iniciada; emendada 2026-08-15 (envio privado/swQoS) | Proibida antes de todas as gates e aprovação explícita |
| RFC-009 — Execução Polymarket maker-side | Nova (2026-08-15) | Live V2 com burn wallet Polygon; risco jurisdicional aceito; só após gates da RFC-007 e aprovação |

## Evidência mais recente

- `make verify`: sucesso em 2026-08-16; 143 testes TypeScript, 74 Rust (66
  engine + 8 probe), nove do worker e 107 dos scripts, além de formatadores,
  linters, builds (incl. clippy `-D warnings`), scanner e política do Compose.
  Migrations `0001`–`0004` presentes; inventário de licenças com 423 pacotes.
- `actionlint` 1.7.12: workflow de CI/CD aprovado; todas as actions externas
  estão fixadas por SHA imutável.
- Smoke CI/CD isolado: sucesso com projeto e volume próprios, incluindo build
  dos quatro serviços, migrations, health/degradação/recuperação e shutdown; o
  volume temporário literal foi removido sem tocar no volume canônico.
- Smoke isolado com volume novo: sucesso; primeiro boot, migration,
  reaplicação idempotente, perda/recuperação do PostgreSQL e shutdown sem
  órfãos; 79.307.242 bytes agregados em seis containers.
- Fluxo standalone isolado: `server-up`, `server-status`, `server-health` e
  `server-down` passaram, incluindo readiness interno do market-engine.
- Deploy remoto: cinco containers persistentes ativos, migration `0001`
  aplicada com exit `0`, frontend/API live/API ready em HTTP 200 pelo IPv4
  público e execução confirmada em modo `paper`. O primeiro deploy pelo GitHub
  Actions está registrado na
  [execução 31860868239](https://github.com/henrique-devel/ganso-market/actions/runs/31860868239).
- No host, somente SSH e Nginx estão publicados; Nginx usa `0.0.0.0:80`, sem
  listener `[::]:80`. UFW permanece inativo e não foi alterado.
- O volume temporário dos dois smokes foi removido após validação literal; o
  volume canônico `ganso-market_postgres_data` foi preservado.
- O volume canônico local contém checksum histórico diferente para a migration
  `0001` e por isso o migrador o rejeita. Nada foi regravado ou apagado; esse
  estado local não afeta um servidor reconstruído com volume novo.
- Budget configurado: 2.684.354.560 bytes e 4 vCPU, incluindo worker opcional
  e migrador one-shot.
- Inventário determinístico: 289 dependências npm/Cargo de registro com
  versão e licença identificadas.

Os comandos e resultados completos estão em
[`docs/test-results/RFC-001.md`](test-results/RFC-001.md).

## Decisão de escopo — 2026-08-15 (estudo + jurisdição)

- **FATO INFORMADO:** o proprietário decidiu perseguir execução real na
  Polymarket a partir de um servidor na Alemanha, com burn wallet dedicada na
  Polygon, **assumindo o risco jurisdicional e tributário**. Registro factual
  mantido: elegibilidade da ToS olha a residência do usuário, não do servidor; o
  Brasil está bloqueado; residência fiscal brasileira tributa renda mundial e
  exige reporte (DeCripto). A burn wallet limita perda, não é conformidade.
- **DECISÃO:** PRD emendado; RFC-007/006/008 atualizadas ao regime 2026; criada a
  RFC-009 (execução Polymarket maker-side). Fonte:
  [`docs/research/direcao-e-roadmap-bots.md`](research/direcao-e-roadmap-bots.md).
- **INVARIANTE MANTIDA:** disciplina paper-first + gates objetivos para os dois
  módulos; sem contorno técnico de geoblock em nenhuma RFC.
- **TODO de implementação:** quando a RFC-008/009 forem implementadas,
  `config/runtime.json` e os contratos precisarão de um valor `live` para
  `execution_mode`, sempre iniciando desarmado após restart. Até lá, o runtime
  permanece `paper`-only (invariante atual preservada).

## Decisões e invariantes vigentes

1. `ExecutionMode` aceita exclusivamente `paper` no runtime atual (o caminho
   `live` só é introduzido pela RFC-008/009, gated e desarmado por padrão).
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

- **DECISÃO — exposição:** o bootstrap standalone usa HTTP direto em
  `0.0.0.0:80`, sem firewall gerenciado pelo projeto, domínio, TLS, Certbot ou
  443. Essa autorização cobre somente a fundação sem auth/wallet/execução.
- **BLOQUEIO/TODO — Yellowstone:** uma credencial nova e slots avançando ainda
  precisam ser confirmados antes de iniciar ingestão.
- **BLOQUEIO/TODO — wallet:** a recuperação offline da hot wallet deve ser
  comprovada antes de qualquer implementação de wallet/signer.
- **RISCO:** não há backup externo automático, HA ou recuperação garantida do
  PostgreSQL, por decisão de escopo atual.
- **RISCO:** `ServiceHealth` é reproduzido manualmente entre linguagens; os
  schemas v1 são normativos, mas existe risco futuro de drift.
- **RISCO:** o market-engine não possui `healthcheck` declarativo no Compose;
  `make server-health` cobre sua readiness pela rede interna.
- **RISCO:** scanners de segredo são defesa em profundidade, não prova
  matemática de ausência de toda codificação possível.
- **RISCO:** a chave de CD é equivalente a uma credencial `root`, apesar do
  comando SSH forçado, porque o release verificado controla Dockerfiles,
  Compose e Makefile executados no servidor.
- **RISCO:** o rollback automático restaura código e containers, mas não desfaz
  migrations; mudanças futuras de banco devem ser retrocompatíveis e ter
  backup antes de qualquer migration destrutiva.

## Próximo passo mínimo

Fases 1 e 2 do roadmap implementadas no código e verificadas offline (RFC-002,
RFC-003, RFC-004 e o recorder Polymarket). Os próximos passos para ativar o que
está bloqueado:

1. **Yellowstone:** confirmar credencial nova com slots avançando (o probe
   `tools/rfc001a-yellowstone-probe` valida conectividade). Só então ligar o
   receiver da RFC-003 no `run()` do engine e conectar o writer da RFC-004
   (escrita microbatch, TTL/pruning). Sem isso, ingestão/decoders permanecem
   testados offline.
2. **Auth em produção:** antes de publicar login/tokens no IP público, aplicar a
   regra de firewall (ou TLS) de [`docs/runbooks/auth-perimeter.md`](runbooks/auth-perimeter.md)
   e criar a conta única via `node dist/account-cli.js create <user>`.
3. **Recorder Polymarket:** serviço iniciado no servidor em 2026-08-18, mas em
   crash-loop pelo bug de `source_ts` (corrigido nesta branch). Após o merge e
   o deploy, reiniciar o serviço com
   `docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-recorder`
   e confirmar `polymarket_book_snapshots` crescendo. Atenção: os alvos de
   deploy (`server-up`/`server-update`) rodam sem o profile `polymarket`;
   verificar após o próximo deploy se o recorder continua ativo e com a imagem
   nova.
4. **Depois das Fases 1–2:** RFC-005 (wallet/risk/signer) — pré-condição é a
   comprovação de recuperação offline da hot wallet — seguida da RFC-006 (paper
   e gates) e do restante da RFC-007 (baseline/calibração/paper broker).
5. Para operação atual, usar `cd /opt/ganso-market` seguido de
   `make server-status`, `make server-health` ou `make server-logs`. Todo push em
   `main` executa os gates e, se aprovados, atualiza produção.

### Bloqueios abertos

- **Yellowstone:** credencial + slots avançando ainda não confirmados (RFC-003/004
  ao vivo dependem disso).
- **Wallet:** recuperação offline da hot wallet deve ser comprovada antes da RFC-005.
- **Jurisdição (RFC-009):** parecer jurídico/tributário e provisionamento da burn
  wallet na Polygon antes de qualquer execução real na Polymarket.

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
