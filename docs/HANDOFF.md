# Handoff do projeto Ganso Market

- Última atualização: 2026-08-14
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
- **FATO VERIFICADO:** auth, Yellowstone, modelos, estratégias, wallet,
  signer, ordens e execução não existem nesta entrega.
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
- **FATO VERIFICADO:** o workflow de CI/CD foi implementado e validado
  localmente, com deploy fail-closed. A chave restrita, os secrets do
  environment `production` e `DEPLOY_ENABLED=true` ainda não foram instalados;
  nenhum push ou alteração de credenciais GitHub foi feito nesta etapa.

## Sequência de RFCs

| RFC | Estado de acompanhamento | Evidência/condição |
| --- | --- | --- |
| RFC-001 — Fundação e runtime | Implementada localmente | [`docs/test-results/RFC-001.md`](test-results/RFC-001.md) |
| RFC-001A — Limpeza e preservação Yellowstone | Substituída pelo rebuild | Não executar no host novo |
| RFC-002 — Auth e HTTP | Draft a revisar | Bootstrap standalone não depende dela; auth continua obrigatória antes de dados sensíveis |
| RFC-003 — Yellowstone | Não iniciada | Não antecipar durante a RFC-002 |
| RFC-004 — Eventos e persistência | Não iniciada | Depende da RFC-003 |
| RFC-005 — Wallet, risco e signer | Não iniciada | Live continua proibido; depende das gates anteriores |
| RFC-006 — Paper e modelos | Não iniciada | Não existe simulador/modelo nesta fundação |
| RFC-007 — Polymarket paper | Não iniciada | Analytics/paper somente |
| RFC-008 — Execução beta Solana | Não iniciada | Proibida antes de todas as gates e aprovação explícita |

## Evidência mais recente

- `make verify`: sucesso em 2026-08-14; 94 testes TypeScript, 22 Rust, nove do
  worker e 106 dos scripts, além de formatadores, linters, builds, scanner e
  política do Compose.
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
  público e execução confirmada em modo `paper`.
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

## Decisões e invariantes vigentes

1. `ExecutionMode` aceita exclusivamente `paper`.
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

## Próximo passo mínimo

1. Revisar e reescrever a RFC-002 para autenticação no perímetro standalone.
2. Não adicionar login, tokens, wallet ou controles privados ao HTTP público
   antes dessa revisão.
3. Para operação atual, usar `cd /opt/ganso-market` seguido de
   `make server-status`, `make server-health` ou `make server-logs`.
4. Publicar os commits locais no GitHub para ativar os gates de CI.
5. O CD só deve ser habilitado depois de autorização explícita para instalar a
   chave forçada no servidor e cadastrar os dois secrets de `production`.

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
