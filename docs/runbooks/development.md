# Runbook de desenvolvimento — RFC-001

## Pré-requisitos

- Rust 1.96.1 com `rustfmt` e `clippy`;
- Node.js 24–26 e npm 11;
- Python 3.9+ para tooling local (imagem runtime 3.13.14);
- Docker Engine com Compose v2;
- Make e curl.

`make doctor` verifica a disponibilidade sem instalar software no sistema.
Versões de runtime dos containers são fixadas nos Dockerfiles e no Compose.

## Primeira execução

```sh
make doctor
make install
make init-secrets
make verify
make up
curl --fail http://127.0.0.1:8080/api/health/live
curl --fail http://127.0.0.1:8080/api/health/ready
```

`make init-secrets` cria um password aleatório apenas para o PostgreSQL local.
Ele não sobrescreve o arquivo existente e nunca mostra seu conteúdo. Não copie
o arquivo para Git, logs, fixtures ou chat. O diretório fica em `0700`; o
arquivo fica em `0644` para que os UIDs não-root dos containers consigam ler o
bind mount. Fora desse diretório privado, o arquivo não é acessível no host.

O worker opcional sobe somente com:

```sh
docker compose --profile model up --build --detach
```

## Comandos canônicos

| Comando               | Efeito                                           |
| --------------------- | ------------------------------------------------ |
| `make install`        | instala dependências fixadas e usa lockfiles     |
| `make format`         | formata Rust, TypeScript/JSON/CSS e Python       |
| `make lint`           | TypeScript check, Clippy e Ruff                  |
| `make test`           | testes unitários sem mainnet/serviço externo     |
| `make build`          | compila todos os componentes                     |
| `make verify`         | executa gates locais e valida Compose            |
| `make migrate`        | reaplica migrations de forma idempotente         |
| `make integration`    | smoke de health, queda do PostgreSQL e shutdown  |
| `make resource-check` | budgets e consumo atual dos containers           |
| `make secret-scan`    | padrões proibidos e vazamento do secret local    |
| `make down`           | encerra sem `--volumes`; dados locais permanecem |

Instalação/pull inicial requer os registries das dependências e imagens. Depois
da instalação, testes unitários não consultam mainnet nem APIs externas.

## Falhas esperadas e diagnóstico

- `CONFIG_INVALID`: confira JSON, schema `1`, campos conhecidos e modo `paper`.
- `SECRET_FILE_*`: execute `make init-secrets` e confira que o diretório está em
  `0700` e o arquivo regular em `0644`; não imprima seu valor.
- `POSTGRES_UNAVAILABLE`: liveness deve continuar 200 e readiness deve ficar 503. Veja apenas tipo/reason code dos logs; não adicione DSN completa.
- checksum de migration divergente: não edite uma migration aplicada. Crie uma
  nova migration em uma RFC que autorize a mudança.
- porta 8080 ocupada: copie `.env.example` para `.env` e altere somente
  `GANSO_HTTP_PORT`; não publique em `0.0.0.0` nesta RFC.

## Shutdown e dados

API, engine e worker tratam SIGINT/SIGTERM e encerram listeners/pools. O Compose
define grace periods. `make down` não apaga volumes. Não existe comando de reset
destrutivo no runbook; remoção de volume exige decisão explícita do proprietário.
