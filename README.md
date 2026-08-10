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
- Nginx local, sem certificado real nesta RFC.

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

## Decisões já fechadas

- Uso exclusivo do proprietário; não é SaaS e não receberá fundos de terceiros.
- Servidor-alvo: Hetzner CPX42, consumindo um endpoint Yellowstone/Geyser já existente.
- Painel público somente em `https://<IP_DO_SERVIDOR>`.
- Uma conta com senha, access token e refresh token; sem MFA/passkey.
- Hot wallet pública esperada: `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`.
- A chave privada nunca entra no Git, banco, logs, fixtures ou frontend.
- Sem backup externo rotineiro, alta disponibilidade, multi-region ou recuperação garantida do banco.
- A única cópia de recuperação indispensável é a da própria hot wallet, mantida offline pelo proprietário.
- Solana começa com Pump/PumpSwap, paper por padrão.
- Polymarket permanece analytics e paper trading enquanto o acesso partir do Brasil.

## Documentos

- [PRD do MVP](docs/PRD.md)
- [Índice e ordem das RFCs](docs/RFC_INDEX.md)
- [Prompt mestre da IA de desenvolvimento](prompts/AI_DEVELOPER_SYSTEM_PROMPT.md)
- [Arquitetura da fundação](docs/architecture/foundation.md)
- [Runbook de desenvolvimento](docs/runbooks/development.md)
- [Dependências e licenças](docs/DEPENDENCIES.md)
- [Evidência de verificação da RFC-001](docs/test-results/RFC-001.md)
- [Handoff e continuidade do projeto](docs/HANDOFF.md)

## Ordem de desenvolvimento

1. RFC-001 — Fundação e runtime.
2. RFC-002 — Autenticação e HTTPS por IP.
3. RFC-003 — Ingestão Yellowstone.
4. RFC-004 — Eventos, persistência e retenção.
5. RFC-005 — Hot wallet, risk guard e signer.
6. RFC-006 — Paper trading, estratégias e gates do modelo.
7. RFC-007 — Polymarket analytics/paper.
8. RFC-008 — Execução beta Solana, somente depois das gates.

Execução live não é consequência automática de terminar código. Ela exige os critérios objetivos da RFC-006 e a ativação manual prevista na RFC-005.
