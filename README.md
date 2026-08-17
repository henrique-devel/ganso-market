# Ganso Market

Ferramenta pessoal e single-user para pesquisa, paper trading e, depois dos gates de segurança, execução beta limitada em Solana.

Este repositório começa pelos documentos que governam o desenvolvimento. A implementação deve seguir o PRD e uma RFC ativa por vez.

## Estado implementado

A RFC-001 fornece agora um runtime mínimo, ainda sem lógica de mercado:

- `market-engine` em Rust, limitado a bootstrap e health;
- API Fastify sem rotas de autenticação funcionais;
- web React/Vite que mostra somente health real;
- `model-worker` Python opcional, sem modelo;
- PostgreSQL com três tabelas fundacionais;
- Nginx em loopback no desenvolvimento e modo standalone direto na porta 80.

O único modo aceito é `paper`. Não existem signer, wallet, Yellowstone,
estratégia, ordem ou execução neste código.

Para reproduzir localmente:

```sh
make doctor
make install
make verify
make up
```

O gateway usa `127.0.0.1:8080` por padrão. Consulte
[`docs/runbooks/development.md`](docs/runbooks/development.md) antes de subir o
ambiente. `make down` encerra os containers sem apagar o volume do PostgreSQL.

Para um Ubuntu dedicado reconstruído, sem firewall, TLS ou serviços extras,
consulte [`docs/runbooks/single-server.md`](docs/runbooks/single-server.md). O
fluxo reduzido é `sudo ./deploy/install-docker-ubuntu.sh` e `make server-up`.

O workflow [CI/CD](.github/workflows/ci-cd.yml) executa a verificação completa
e o smoke do Compose em pull requests e pushes. Depois de configurar a chave
restrita e habilitar a variável conforme o runbook, todo push em `main` atualiza
o servidor automaticamente e confirma os três endpoints públicos de health.

## Decisões já fechadas

- Uso exclusivo do proprietário; não é SaaS e não receberá fundos de terceiros.
- Servidor-alvo: Hetzner CPX42 em `178.105.65.251`, consumindo um endpoint Yellowstone/Geyser externo já existente.
- A fundação standalone publica o painel diretamente em `http://178.105.65.251/`, sem firewall gerenciado pelo projeto e sem publicação IPv6.
- Sem domínio, HTTPS, Certbot ou porta 443 nesse bootstrap.
- Uma conta com senha, access token e refresh token; sem MFA/passkey.
- Hot wallet pública esperada: `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`.
- A chave privada nunca entra no Git, banco, logs, fixtures ou frontend.
- Sem backup externo rotineiro, alta disponibilidade, multi-region ou recuperação garantida do banco.
- A única cópia de recuperação indispensável é a da própria hot wallet, mantida offline pelo proprietário.
- Solana começa com Pump/PumpSwap, paper por padrão.
- Polymarket: paper trading até os gates; execução real (RFC-009) autorizada pela emenda de 2026-08-15, a partir de servidor na Alemanha e burn wallet na Polygon, com risco jurisdicional/tributário assumido pelo proprietário e sem contorno de geoblock.

## Documentos

- [PRD do MVP](docs/PRD.md)
- [Estudo: direção e roadmap dos bots](docs/research/direcao-e-roadmap-bots.md)
- [Índice e ordem das RFCs](docs/RFC_INDEX.md)
- [Prompt mestre da IA de desenvolvimento](prompts/AI_DEVELOPER_SYSTEM_PROMPT.md)
- [Registro do servidor e acesso SSH](docs/ops/SERVER_ACCESS.md)
- [Arquitetura da fundação](docs/architecture/foundation.md)
- [Runbook de desenvolvimento](docs/runbooks/development.md)
- [Runbook do servidor único](docs/runbooks/single-server.md)
- [Runbook do recorder Polymarket](docs/runbooks/polymarket-recorder.md)
- [Histórico: limpeza do Ganso-bot, não executar após rebuild](docs/runbooks/server-cleanup-ganso-bot.md)
- [Dependências e licenças](docs/DEPENDENCIES.md)
- [Evidência de verificação da RFC-001](docs/test-results/RFC-001.md)
- [Handoff e continuidade do projeto](docs/HANDOFF.md)

## Ordem de desenvolvimento

1. RFC-001 — Fundação e runtime.
2. Bootstrap standalone — estrutura implementada neste rebuild.
3. RFC-002 — autenticação, após reescrever o perímetro sem firewall.
4. RFC-003 — Ingestão Yellowstone.
5. RFC-004 — Eventos, persistência e retenção.
6. RFC-005 — Hot wallet, risk guard e signer.
7. RFC-006 — Paper trading, estratégias, bundle/insider e gates do modelo.
8. RFC-007 — Polymarket analytics/paper (CLOB V2), com recorder e calibração.
9. RFC-008 — Execução beta Solana, somente depois das gates.
10. RFC-009 — Execução Polymarket maker-side, somente depois das gates da RFC-007 e aprovação.

A RFC-001A é registro histórico e foi substituída pelo rebuild; não deve ser
executada no host novo.

Execução live não é consequência automática de terminar código. Ela exige os critérios objetivos da RFC-006 e a ativação manual prevista na RFC-005.
