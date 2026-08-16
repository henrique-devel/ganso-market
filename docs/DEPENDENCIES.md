# Dependências e licenças — RFC-001 e RFC-001A

Versões foram consultadas nos registros oficiais em 2026-08-10 e são fixadas
nos manifests/lockfiles ou tags completas de imagem. O projeto é pessoal e
`UNLICENSED`; as licenças abaixo são das dependências.

## JavaScript diretas

| Dependência | Versão | Licença |
|---|---:|---|
| Fastify | 5.11.3 | MIT |
| pg | 8.23.0 | MIT |
| hash-wasm (Argon2id, RFC-002) | 4.12.0 | MIT |
| React / React DOM | 19.2.8 | MIT |
| Ajv | 8.20.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| Vite | 8.2.1 | MIT |
| @vitejs/plugin-react | 6.0.5 | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |
| Vitest | 4.1.10 | MIT |
| Prettier | 3.9.6 | MIT |
| pacotes `@types/*` | versões exatas nos manifests | MIT |

Fonte: metadados do [registro npm](https://www.npmjs.com/).

## Rust diretas

| Crate | Versão | Licença |
|---|---:|---|
| axum | 0.8.9 | MIT |
| tokio | 1.53.1 | MIT |
| tokio-postgres | 0.7.18 | MIT OR Apache-2.0 |
| serde / serde_json | 1.0.229 / 1.0.151 | MIT OR Apache-2.0 |
| time | 0.3.55 | MIT OR Apache-2.0 |
| tracing / tracing-subscriber | 0.1.44 / 0.3.23 | MIT |
| uuid | 1.24.0 | Apache-2.0 OR MIT |
| tower (testes) | 0.5.3 | MIT |
| futures | 0.3.33 | MIT OR Apache-2.0 |
| libc | 0.2.189 | MIT OR Apache-2.0 |
| yellowstone-grpc-client | 13.3.0 | Apache-2.0 |
| yellowstone-grpc-proto | 12.5.0 | Apache-2.0 |

Fonte: metadados do [crates.io](https://crates.io/).

## Python e imagens

| Dependência | Versão/tag | Licença upstream |
|---|---:|---|
| Ruff (desenvolvimento) | 0.16.2 | MIT |
| Python | 3.13.14-slim-bookworm | PSF-2.0 |
| Node.js | 24.19.0-bookworm-slim | MIT |
| Rust | 1.96.1-bookworm | MIT OR Apache-2.0 |
| PostgreSQL | 18.4-bookworm | PostgreSQL License |
| Nginx | 1.30.4-alpine3.24 | BSD-2-Clause |
| Debian Bookworm / Alpine 3.24 | tags acima | múltiplas, por pacote da imagem |

Tags foram confirmadas no repositório oficial de imagens do Docker Hub. Cada
referência usada pelos Dockerfiles e pelo Compose mantém a tag legível e fixa
também o manifest multi-arquitetura por digest `sha256`, para que CI e produção
resolvam os mesmos bytes.

## Transitivas

`package-lock.json` e `Cargo.lock` fixam as árvores transitivas. Depois de
instalar/atualizar dependências, execute:

```sh
python3 scripts/generate_license_report.py --output docs/dependency-licenses.json
```

O gerador falha se um pacote transitivo de registro não declarar licença. O
JSON produzido é o inventário verificável, não uma análise jurídica.
