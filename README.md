# Ganso Market

Ferramenta pessoal e single-user para pesquisa, paper trading e, depois dos
gates de segurança, execução maker-side limitada na Polymarket.

Este repositório começa pelos documentos que governam o desenvolvimento. A
implementação deve seguir o PRD e uma RFC ativa por vez.

**Decisão de escopo (2026-08-18):** o projeto segue um único caminho, a
Polymarket. O módulo Solana foi removido do escopo e do repositório; o
histórico permanece no git.

## Estado implementado

- `market-engine` em Rust, limitado a bootstrap e health;
- API Fastify com autenticação single-user (RFC-002), o recorder Polymarket
  (dados públicos, RFC-007) ativo em produção e o modelo fundamental
  (RFC-010), que produz apenas estimativas `q` com intervalo de incerteza;
- web React/Vite com login e health real;
- `model-worker` Python opcional, sem modelo;
- PostgreSQL com migrations versionadas;
- Nginx em loopback no desenvolvimento e modo standalone direto na porta 80.

O único modo aceito é `paper`. Não existem signer, wallet, estratégia, ordem
ou execução neste código. O modelo fundamental grava estimativas e relatórios
de calibração; nenhum modelo serve estimativa sem passar o gate de
não-inferioridade e ser promovido manualmente
([escopo e limites](docs/architecture/fundamental-model-scope.md)).

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

Para um Ubuntu dedicado reconstruído, sem TLS ou serviços extras, consulte
[`docs/runbooks/single-server.md`](docs/runbooks/single-server.md). O fluxo
reduzido é `sudo ./deploy/install-docker-ubuntu.sh` e `make server-up`.

O workflow [CI/CD](.github/workflows/ci-cd.yml) executa a verificação completa
e o smoke do Compose em pull requests e pushes. Todo push em `main` atualiza o
servidor automaticamente e valida a saúde do gateway do lado do servidor.

## Decisões já fechadas

- Uso exclusivo do proprietário; não é SaaS e não receberá fundos de terceiros.
- Servidor-alvo: Hetzner CPX42 em `178.105.65.251`.
- Caminho único Polymarket desde 2026-08-18; o módulo Solana saiu do escopo.
- A fundação standalone publica o painel em `http://178.105.65.251/`; o
  perímetro do painel autenticado usa firewall Hetzner restrito ao IP do
  operador (aplicado e verificado em 2026-08-18), sem publicação IPv6.
- Sem domínio, HTTPS, Certbot ou porta 443 nesse bootstrap.
- Uma conta com senha, access token e refresh token; sem MFA/passkey.
- Sem backup externo rotineiro, alta disponibilidade, multi-region ou
  recuperação garantida do banco.
- Polymarket: paper trading até os gates; execução real (RFC-009) autorizada
  pela emenda de 2026-08-15, a partir de servidor na Alemanha e burn wallet na
  Polygon, com risco jurisdicional/tributário assumido pelo proprietário e sem
  contorno de geoblock.

## Documentos

- [PRD do MVP](docs/PRD.md)
- [Estudo: direção e roadmap dos bots](docs/research/direcao-e-roadmap-bots.md)
- [Índice e ordem das RFCs](docs/RFC_INDEX.md)
- [Prompt mestre da IA de desenvolvimento](prompts/AI_DEVELOPER_SYSTEM_PROMPT.md)
- [Registro do servidor e acesso SSH](docs/ops/SERVER_ACCESS.md)
- [Arquitetura da fundação](docs/architecture/foundation.md)
- [Runbook de desenvolvimento](docs/runbooks/development.md)
- [Runbook do servidor único](docs/runbooks/single-server.md)
- [Runbook do perímetro de autenticação](docs/runbooks/auth-perimeter.md)
- [Runbook do recorder Polymarket](docs/runbooks/polymarket-recorder.md)
- [Runbook do modelo fundamental](docs/runbooks/polymarket-fundamental.md)
- [Escopo e limites do modelo fundamental](docs/architecture/fundamental-model-scope.md)
- [Dependências e licenças](docs/DEPENDENCIES.md)
- [Evidência de verificação da RFC-001](docs/test-results/RFC-001.md)
- [Handoff e continuidade do projeto](docs/HANDOFF.md)

## Ordem de desenvolvimento

1. RFC-001 — Fundação e runtime (implementada).
2. Bootstrap standalone — implementado neste rebuild.
3. RFC-002 — Autenticação e perímetro (implementada; publicada com firewall).
4. RFC-007 — Polymarket: fundação de dados e recorder V2 (recorder básico em
   produção; expansão de coleta e TTL nesta RFC).
5. RFC-010 — Modelo fundamental (`q` + incerteza; crypto e macro agendado)
   (implementada; modelos nascem em shadow).
6. RFC-011 — Microestrutura e paper broker realista.
7. RFC-012 — Risco de resolução (UMA) e grafo lógico entre mercados.
8. RFC-013 — Motor de portfólio, critérios de entrada/saída e gates.
9. RFC-009 — Execução Polymarket maker-side, somente depois dos gates da
   RFC-013 e de aprovação explícita.

Execução live não é consequência automática de terminar código. Ela exige os
critérios objetivos dos gates da RFC-013 e a ativação manual prevista na
RFC-009.
