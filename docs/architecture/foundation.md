# Fundação do runtime — RFC-001

## Escopo

Esta arquitetura implementa somente bootstrap, contratos, configuração,
persistência fundacional e observabilidade. Auth, Yellowstone, eventos de
domínio, modelos, paper broker, wallet, signer e qualquer execução pertencem a
RFCs posteriores e não têm caminho oculto nesta base.

O runtime continua single-user e o único valor válido de `execution_mode` é
`paper`.

## Processos

| Processo | Runtime | Responsabilidade nesta RFC | Dependência obrigatória |
|---|---|---|---|
| `market-engine` | Rust | bootstrap, contracts internos e health | PostgreSQL |
| `api` | Node.js/Fastify | health interno; auth retorna 404 | PostgreSQL |
| `web` | React estático | renderizar health real da API | API |
| `model-worker` | Python, profile `model` | health; nenhum modelo | nenhuma |
| `migrate` | cliente PostgreSQL one-shot | aplicar migrations versionadas | PostgreSQL |
| `nginx` | Nginx | gateway local para web e health da API | API e web |

Ordem de boot: `postgres (healthy) -> migrate (sucesso) -> api/market-engine`;
Nginx aguarda API e web saudáveis. O worker é opcional e não participa do
caminho crítico.

PostgreSQL, engine, worker e endpoints `/metrics` não publicam portas no host.
A rede `backend` é interna; a rede `edge` permite o bind do gateway, mas nenhum
container nela publica porta por conta própria. O único bind no host é o Nginx
em `127.0.0.1:8080`; nesta RFC o endereço não pode ser sobrescrito por ambiente.

## Configuração

A precedência é deliberadamente curta:

1. defaults seguros no processo;
2. JSON não secreto apontado por `GANSO_CONFIG_FILE`;
3. conteúdo do arquivo apontado por `GANSO_POSTGRES_PASSWORD_FILE`, somente
   para o campo secreto correspondente.

Variáveis de ambiente são apenas localizadores ou a porta não secreta do
gateway local. Um password não é aceito no JSON nem diretamente em variável de
ambiente. Campo desconhecido, schema diferente de `1`, arquivo ilegível,
secret vazio/multilinha ou modo diferente de `paper` rejeitam o boot.

O arquivo versionado é [`config/runtime.json`](../../config/runtime.json). O
secret local é gerado por `make init-secrets`, fica em um diretório `0700` e
recebe modo `0644` para ser legível pelos UIDs não-root dos containers. Ele
permanece em `infra/secrets/local/`, ignorado pelo Git, e seu valor nunca é
impresso.
O migrador rejeita conteúdo vazio, multilinha, NUL ou maior que 4 KiB e cria um
`PGPASSFILE` temporário `0600`; o valor não é exportado como variável.
Private key e seed não pertencem a esta RFC e nunca usam env.

## Fronteiras e convenções

- nomes de arquivos e campos: `kebab-case` para diretórios/serviços e
  `snake_case` nas fronteiras JSON/SQL;
- timestamps: RFC 3339 em UTC com sufixo `Z`; PostgreSQL usa `TIMESTAMPTZ` e
  timezone UTC;
- IDs externos: strings opacas; correlation IDs têm até 64 caracteres seguros;
- slots e inteiros que podem superar a precisão JavaScript: strings decimais
  canônicas;
- dinheiro: `raw` é inteiro matemático exato, `decimals` é escala e `asset_id`
  declara o ativo; nunca há conversão por `Number`/float;
- schemas: IDs `urn:ganso-market:contracts:v1:*`; mudança incompatível cria
  novo diretório de versão.

Os contratos normativos e fixtures ficam em
[`packages/contracts`](../../packages/contracts/README.md).

## Health, métricas e logs

- `/health/live`: vida do processo; não consulta dependências;
- `/health/ready`: `503 not_ready` se uma dependência obrigatória falhar;
- `/metrics`: texto Prometheus, somente na rede interna do Compose.

Cada resposta de health contém estado real, timestamp UTC, modo `paper`,
correlation ID, checks e reason codes. A web não converte falha de rede em
estado saudável.

Logs de aplicação e access logs controlados pelo projeto são JSON, incluem
serviço, timestamp/correlation ID quando aplicável e redigem campos marcados
como password, token, cookie, authorization, seed ou private key. Linhas
diagnósticas emitidas pelos binários upstream de PostgreSQL/Nginx mantêm o
formato nativo. Falhas de readiness usam reason codes e não registram conteúdo
do secret ou strings de conexão.

## Recursos

Os limites do Compose somam menos de 4 GiB mesmo contando o worker opcional e o
migrator one-shot. `scripts/check_compose_policy.py` valida a soma e o isolamento
de portas a partir da configuração canônica do Compose. Isso é budget, não
benchmark; RSS idle real é registrado apenas quando `make integration` ou
`make resource-check` é executado com o daemon disponível.

## Exposição pública

O modo de desenvolvimento mantém o Nginx em `127.0.0.1:8080`. Após o rebuild do
servidor informado em 2026-08-14, o modo standalone pode publicar somente o
Nginx em `0.0.0.0:80`, sem firewall gerenciado por este projeto, TLS, ACME,
domínio ou porta 443. PostgreSQL, API, engine e worker continuam sem portas no
host. Essa exceção serve apenas para a fundação atual, que não contém auth,
wallet, tokens ou execução; esses recursos exigem uma nova revisão de perímetro.
