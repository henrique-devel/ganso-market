# Ganso Market

Ferramenta pessoal e single-user para pesquisa, paper trading e, depois dos
gates de segurança, execução maker-side limitada na Polymarket.

Este repositório começa pelos documentos que governam o desenvolvimento. A
implementação deve seguir o PRD e uma RFC ativa por vez.

**Próximo ciclo (10/09/2026):** [RFCs e prompts em blocos pequenos](prompts/roadmap/btc/README.md)
para operação, contabilidade, BTC horário, replay e limpeza de dados. Uma sessão
executa um bloco; [estado curto](docs/roadmap/BTC_EXECUTION_STATE.md) substitui a
leitura integral do HANDOFF. Novas especificações ainda não implementadas.

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

O modo operacional é `paper`: há decisões, ordens simuladas, ledger, posições,
replay e painel. Não há executor/signer de ordens reais. A estratégia fast tem
config/policy/backtest; seu worker observacional é trabalho do próximo ciclo.
Modelos produzem estimativas em sombra; sua promoção e influência nas decisões
seguem os gates. Consulte a [baseline de 10/09](docs/roadmap/BASELINE-2026-09-10.md)
para limitações verificadas, sem inferir disponibilidade atual a partir desta lista.

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
e o smoke do Compose em pull requests e pushes. Após os checks em `main`, mudanças
de runtime seguem para deploy e verificação de saúde no servidor; mudanças somente
de texto podem dispensar deploy conforme a RFC-020.

O proprietário concedeu [autorização contínua para código local → PR → merge → produção](docs/ops/DEVELOPMENT_AUTHORIZATION.md)
nas tarefas solicitadas, respeitando os gates e o escopo de cada entrega.

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
- [Autorização contínua de desenvolvimento e entrega](docs/ops/DEVELOPMENT_AUTHORIZATION.md)
- [Registro do servidor e acesso SSH](docs/ops/SERVER_ACCESS.md)
- [Arquitetura da fundação](docs/architecture/foundation.md)
- [Runbook de desenvolvimento](docs/runbooks/development.md)
- [Runbook do servidor único](docs/runbooks/single-server.md)
- [Runbook do perímetro de autenticação](docs/runbooks/auth-perimeter.md)
- [Runbook do recorder Polymarket](docs/runbooks/polymarket-recorder.md)
- [Runbook do modelo fundamental](docs/runbooks/polymarket-fundamental.md)
- [Runbook do paper broker](docs/runbooks/polymarket-paper.md)
- [Runbook do motor de portfólio e gates](docs/runbooks/polymarket-portfolio.md)
- [Escopo e limites do modelo fundamental](docs/architecture/fundamental-model-scope.md)
- [Onde mora a ponte decisão → ordem de paper](docs/architecture/decision-to-paper-bridge.md)
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
