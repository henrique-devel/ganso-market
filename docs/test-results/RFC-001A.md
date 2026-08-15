# Evidência — RFC-001A

**Estado:** `BLOCKED / GATE 1 PARTIAL / PRE-DESTRUCTIVE GATES NOT RUN`

**Registro UTC:** `2026-08-11T01:42:23Z`

**Emenda UTC:** `2026-08-11T02:18:04Z`

**Revalidação Gate 1 UTC:** `2026-08-11T02:41:50Z`

Este registro não autoriza remoção. Sessões SSH de identidade foram abertas,
mas nenhum comando destrutivo da limpeza foi executado no CPX42. A pedido do
proprietário, uma chave pública dedicada foi autorizada para o usuário `ganso`;
duas linhas inválidas produzidas durante a colagem no console foram removidas
por substituição atômica depois de validar as três fingerprints legítimas.
A autorização posterior para emendar o tratamento do volume anônimo também não
autoriza sua remoção nem a de qualquer outro alvo.

## Fatos verificados localmente

- A chave pública cliente local possui fingerprint
  `MD5:7b:a8:61:f5:b2:27:08:69:d2:ea:25:3d:33:ae:17:d1` e comentário
  `ganso-bot-deploy`.
- Um `ssh-keyscan` de rede para `178.105.65.251` em 2026-08-10 observou host key
  Ed25519 `SHA256:iWEL5d0MqyhYUzj0cfMgzMxh20OS82aYKD9gmFSLVL0`, igual ao
  registro local de `known_hosts`.
- O proprietário confirmou pelo console web independente a host key Ed25519
  `SHA256:iWEL5d0MqyhYUzj0cfMgzMxh20OS82aYKD9gmFSLVL0`; ela corresponde
  exatamente à observação de rede e ao `known_hosts` local.
- Uma sessão com verificação estrita confirmou usuário `ganso`, hostname
  `ubuntu-16gb-fsn1-2-bot`, IPv4 `178.105.65.251/32` e IPv6
  `2a01:4f8:c013:6eb5::1/64`.
- A chave cliente dedicada
  `SHA256:69pP4/MGJm7c4o0AfKwvlkfRXAgXdzyzLIvAIxCChfY` foi autorizada e
  validada em uma segunda sessão SSH. O `authorized_keys` terminou como arquivo
  regular `ganso:ganso`, modo `0600`, com exatamente as duas chaves de acesso
  válidas depois da revogação da chave de deploy.
- O IMDS do host retornou Server ID `147530325`, availability zone
  `fsn1-dc14` e network zone `eu-central`. A correlação desse ID com o IPv4, o
  nome/fingerprint da chave histórica e o firewall efetivamente anexado ainda
  precisam ser confirmados no Hetzner Console.
- O `authorized_keys` atual contém a chave histórica com fingerprint
  `MD5:7b:a8:61:f5:b2:27:08:69:d2:ea:25:3d:33:ae:17:d1` e a chave dedicada
  com fingerprint `MD5:02:7b:b0:09:5c:5d:d0:1d:1f:ab:be:06:e1:81:bd:f0`.
- O helper de secrets, o validador de manifesto e os probes locais foram
  implementados e testados sem credenciais reais e sem mainnet.
- O runtime existente rejeita configuração `live`; nenhum signer foi adicionado
  por esta RFC.

## Inventário remoto redigido

### Host e rede

- 8 CPUs AMD EPYC Genoa; load observado `0.00/0.00/0.00`.
- RAM total `16.37 GB`, usada `0.61 GB`, disponível `15.76 GB`, sem swap.
- Disco raiz `322.24 GB`, usado `70.25 GB`, livre `238.83 GB` (`23%` usado).
- Nenhum listener TCP/80 ou TCP/443. Os únicos listeners externos são SSH em
  `0.0.0.0:22` e `[::]:22`.
- UFW ativo, default deny inbound, com regra allowlisted `22,80,443/tcp`
  somente para o IPv4 do operador. Não existe regra UFW `0.0.0.0/0` ou
  `::/0` para 80/443; a presença de 443 ainda diverge do MVP e permanece
  pendente de decisão explícita.
- Docker e containerd ativos; Docker client/server `29.6.1`; Swarm `inactive`,
  portanto configs/secrets Swarm não existem nesse daemon.

### Containers

Todos têm label Compose `ganso`, workdir `/home/ganso/ganso-bot`, estado
`exited`, `restart_count=0` e, depois do hardening desta execução,
`restart_policy=no`. A revalidação de 2026-08-11 confirmou os mesmos cinco IDs
e nenhuma reinicialização.

| Nome | ID literal | Exit | Image ID literal |
|---|---|---:|---|
| `ganso-bot-1` | `16557a95e5492b64c0e1f41f0930ba4d14964fc7d5e568139b47b2dbb8b3c047` | 137 | `sha256:5716bc47ca2c075ab7e2791e280ab6fb0b0d24ddfbb6d0c3f270be3c633922e4` |
| `ganso-dashboard-1` | `3b2a379ae331e22b5f7494ef2efa9c26e65a0d1300ed699eb576c8d0d125a744` | 0 | `sha256:f7db2ae37025130693955c67b11e559f4b63f7179e29a073ac7e7099a03ad805` |
| `ganso-proxy-1` | `94c7cb8d92b34aab72f9190f28e7e8cdbf5856344eaa05366ba8d92c75b0533a` | 0 | `sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648` |
| `ganso-postgres-1` | `57fa524d8cb2c3e72c4dbb413fbc946d33999b528a4029f964d5619731326dbb` | 0 | `sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb` |
| `ganso-redis-1` | `4a96a1147ffb165e8c29f11702734204c026276c5269e62f64f2da42909df053` | 0 | `sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99` |

As imagens `ganso-bot:latest` e `ganso-dashboard:latest` estão ligadas aos IDs
literais da tabela e possuem labels projeto/serviço `ganso/bot` e
`ganso/dashboard`, respectivamente. Caddy,
PostgreSQL e Redis são imagens genéricas e ficam fora de qualquer remoção. O
build cache ocupa `10.61 GB`, mas não foi atribuído com exclusividade; prune
permanece proibido e esse cache fica explicitamente fora do manifesto.

Os cinco containers e as duas imagens próprias foram classificados como
`owner=docker-daemon` e `shared=false`: todos os containers têm projeto Compose
`ganso`; as imagens próprias têm tags/labels exclusivas do projeto e somente os
containers inventariados as referenciam. Qualquer consumidor novo invalida a
classificação e causa parada.

### Network e volumes

- Network `ganso_default`, ID
  `f57a0ceb6a04d0ef57fff875c8a14eac8bf07d19bb27a8cfec53fa3498512d8d`,
  label Compose `ganso`, bridge local e zero containers anexados; classificada
  como `owner=docker-daemon`, `shared=false`.
- `ganso_pgdata`: driver/scope `local`, label `ganso`, `46.79 GB`, referenciado
  somente por `ganso-postgres-1` em `/var/lib/postgresql/data` com escrita.
- `ganso_caddydata`: driver/scope `local`, label `ganso`, `143 B`, referenciado
  somente por `ganso-proxy-1` em `/data` com escrita.
- `ganso_caddyconfig`: driver/scope `local`, label `ganso`, `490 B`,
  referenciado somente por `ganso-proxy-1` em `/config` com escrita.
- Os três volumes nomeados foram classificados como `owner=docker-daemon` e
  `shared=false` a partir dos labels e consumidores literais acima.
- Volume anônimo
  `d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4`:
  driver/scope `local`, sem label Compose, `0 B`, gerenciado pelo daemon Docker
  e referenciado somente por `ganso-redis-1` no mount do tipo `volume` em `/data`
  com escrita. A RFC e o validador proíbem aprová-lo silenciosamente. O
  proprietário autorizou uma emenda somente para tratar este ID completo como
  exceção estreita, mantendo todos os gates, a revalidação de zero consumidores
  depois da remoção dos containers e uma aprovação destrutiva posterior. Nenhuma
  remoção foi autorizada ou executada por essa decisão.

### Filesystem e automações

- `/home/ganso/ganso-bot` existe, é canônico, diretório `ganso:ganso` modo
  `0775`, sem symlink e sem mount aninhado; Git top-level corresponde ao path,
  HEAD `3d034f0dbe2f70a16fde78e0b549cb28a90089c5`, branch `master`.
- O target foi classificado como `owner=ganso`, `shared=false`: não há symlink,
  mount, processo ou automação externa; todos os consumidores bind observados
  pertencem aos containers Compose `ganso` inventariados.
- Há dois arquivos untracked não abertos:
  `docker-compose.override.yml` (`ganso:ganso`, `0664`, `1413 B`) e
  `docker-compose.override.yml.bak-20260731` (`root:root`, `0644`, `641 B`).
- `/home/ganso/ganso-market` ainda não existe.
- Nenhum processo externo referencia o path antigo; nenhum unit/timer systemd
  de sistema/usuário e nenhum cron de sistema/usuário referencia o bot.
- Os binds observados são `config -> /app/config` somente leitura,
  `data -> /app/data` com escrita, `secrets -> /app/secrets` somente leitura e
  `deploy/Caddyfile -> /etc/caddy/Caddyfile` somente leitura.
- Quatro arquivos sensíveis foram inventariados somente por metadados, sem abrir
  conteúdo: `.env` (`0664`, `3542 B`), `data/credentials.json` (`0644`,
  `423 B`), `data/keypair.enc` (`0644`, `352 B`) e `secrets/keypair.enc`
  (`0644`, `428 B`). Os modos são inseguros e fazem o helper falhar fechado.
- `jq` não está instalado; por regra do runbook, nomes de variáveis dos
  containers não foram extraídos por um fallback improvisado.

### Deploy antigo

- Repositório privado `henrique-devel/ganso-bot`, permissão observada `ADMIN`.
- Workflow `Deploy` passou de `active` para `disabled_manually`.
- Repo secrets exclusivos `DEPLOY_HOST` e `DEPLOY_SSH_KEY` foram removidos sem
  leitura de valores.
- A forced key `github-actions-deploy@ganso-bot`, vinculada literalmente a
  `/home/ganso/ganso-bot/scripts/deploy_from_ci.sh`, foi removida de
  `authorized_keys` por substituição atômica. As chaves histórica e dedicada
  preservadas foram retestadas com sucesso.

## Gates operacionais

| Gate | Estado | Evidência faltante |
|---|---|---|
| Identidade/console | `PARTIAL` | usuário, hostname, IPs, host key, Server ID e zona passaram; faltam correlacionar ID/IP, firewall e nome/fingerprint da chave histórica no Hetzner Console |
| Inventário remoto literal | `PARTIAL` | recursos, consumers, owners e exclusividade foram registrados; faltam os nomes de variáveis porque `jq` não existe no host e a confirmação do Hetzner Firewall |
| Deploy antigo | `PASS` | workflow desabilitado, secrets exclusivos e forced key removidos; duas chaves preservadas retestadas |
| Wallet offline | `NOT RUN` | recovery externa, pubkey esperada, desafio offline e reconciliação |
| Portal Yellowstone | `NOT RUN` | assinatura/cobrança/limites/allowlist e credencial `ganso-market` |
| Probe Yellowstone real | `NOT RUN` | três slots avançando no CPX42 |
| Probe RPC real | `NOT RUN` | hash de gênese público confirmado e slot `confirmed` |
| Manifesto real | `NOT CREATED` | o schema exige os nove gates como `true`; wallet, portal, probes, reconciliação e Gate 1 ainda não permitem um documento válido |
| Aprovação irreversível | `NOT REQUESTED` | todos os gates anteriores precisam passar primeiro |
| Remoção e pós-verificação | `NOT RUN` | depende de aprovação literal do proprietário |

## Testes executados

- `ssh -N` com a chave histórica, sem abrir canal de sessão — PASS;
  autenticação pública aceita e nenhuma opção `command` reportada para a
  entrada correspondente.
- Segunda sessão com a chave dedicada, `BatchMode=yes`,
  `StrictHostKeyChecking=yes` e `IdentitiesOnly=yes` — PASS; retornou
  `ganso`, `ubuntu-16gb-fsn1-2-bot`, IPv4 esperado e IPv6 atribuído.
- Validação redigida de `authorized_keys` após a correção — PASS; arquivo
  regular, owner/group `ganso:ganso`, modo `0600` e duas fingerprints válidas
  válidas depois da revogação da chave GitHub Actions.
- `docker update --restart=no` nos cinco IDs literais, após prechecks de ID,
  estado e label — PASS; todos permaneceram `exited`, `restart_count=0` e
  passaram a `restart=no`.
- GitHub Actions: `Deploy` — `disabled_manually`; `gh secret list` — lista
  vazia depois da remoção dos dois secrets exclusivos.
- Nova autenticação com cada chave preservada depois da remoção da
  forced key — PASS para ambas.
- `curl --fail --silent --show-error --max-time 3 --noproxy '*'` nos endpoints
  IMDS individuais `instance-id`, `availability-zone` e `region` — PASS;
  retornou `147530325`, `fsn1-dc14` e `eu-central` sem usar token.
- `docker ps -a --filter label=com.docker.compose.project=ganso --no-trunc` e
  `docker inspect` dos IDs literais — PASS; cinco containers `exited`, todos
  com restart `no`, consumers e mounts registrados acima. A primeira formatação
  de `docker inspect` falhou ao consultar `.Name` em mounts bind; nenhuma
  mutação ocorreu, e a repetição usando `.Source` para bind passou.
- `docker network inspect`, `docker volume inspect` e `docker system df -v` —
  PASS para a rede, os quatro volumes, consumers e tamanhos registrados.
- `pgrep -f '[g]anso-bot'` — PASS, zero processos. Uma busca anterior incluiu o
  próprio texto do script remoto e produziu um falso positivo; o padrão
  autocontido corrigido eliminou essa ambiguidade.
- `ss` para listeners e `ufw status numbered` com origem redigida — PASS para
  ausência de listeners 80/443 e ausência de regra HTTP world-open; a regra
  UFW allowlisted ainda inclui 443 e permanece pendente.

- `.venv/bin/ruff format --check workers scripts` — PASS, 21 arquivos.
- `.venv/bin/ruff check workers scripts` — PASS.
- `python3 -m unittest scripts.tests.test_rfc001a_manifest -v` — PASS, 39/39.
- `python3 -m unittest discover -s scripts/tests -v` — PASS, 88/88, incluindo o
  mock RPC em loopback; nenhuma credencial real ou mainnet foi usada.
- Extração por `awk` dos blocos Bash das seções 7.3 e 8 do runbook, seguida de
  `bash -n` — PASS; validação somente de sintaxe, nenhum comando do runbook foi
  executado.
- `python3 -m unittest discover -s workers/model-worker/tests -v` — PASS, 9/9;
  a execução final permitiu somente o health server de loopback dos testes.
- `python3 -m compileall -q workers/model-worker/src scripts` — PASS, com cache
  redirecionado para diretório temporário.
- `cargo fmt --all --check` — PASS.
- `cargo test --workspace --all-targets --locked` — PASS, 22/22.
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`
  — PASS.
- `cargo build --workspace --locked` — PASS.
- `npm run format:check` — PASS.
- `npm run lint` — PASS.
- `npm test` — PASS, 94/94.
- `npm run build` — PASS.
- `python3 scripts/generate_license_report.py --output docs/dependency-licenses.json`
  — PASS, 412 pacotes de registro.
- `python3 scripts/scan_secrets.py` — PASS; nenhum conteúdo correspondente foi
  impresso.
- `git diff --check` — PASS para mudanças tracked.
- `rg -n '[[:blank:]]+$'` nos cinco arquivos da emenda — PASS, sem match; cobre
  também esses arquivos ainda untracked.

## Critérios de aceite

Nenhum critério operacional de aceite da RFC-001A está marcado como atendido
neste estágio. O inventário atual e a ausência de listeners TCP/80 e TCP/443
foram verificados antes da limpeza, mas ainda precisam ser repetidos como
pós-condição. Contrato Yellowstone, credencial real, RPC, wallet, validação final
da exceção de volume, recursos removidos e preservação pós-limpeza continuam sem
`PASS`.
