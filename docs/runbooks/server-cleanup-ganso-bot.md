# Runbook manual — remover o Ganso-bot sem perder Yellowstone

> **OBSOLETO:** o proprietário informou o rebuild do servidor em 2026-08-14.
> Não execute nenhum comando deste runbook no host novo; volumes, paths,
> fingerprints e alvos literais pertencem à instalação anterior.

Este é um procedimento destrutivo e sem backup. Ele limpa o mesmo CPX42 em
vez de reprovisionar a VM. Nenhum comando destrutivo deve ser executado até as
seções 1–6 terminarem com `PASS`.

O procedimento preserva o contrato externo Yellowstone por validação no portal
e por uma conexão nova. Apagar arquivos locais normalmente não cancela uma
assinatura externa, mas pode eliminar o único token conhecido. Por isso o portal
e o probe são gates obrigatórios.

## O que sabemos antes de conectar

O documento de congelamento do Ganso-bot, datado de 2026-08-10, registrou:

- projeto em `/home/ganso/ganso-bot`;
- containers parados, zero posições abertas e apenas TCP/22 exposta;
- projeto Compose `ganso`;
- volume `ganso_pgdata` com aproximadamente 43 GB;
- volumes esperados `ganso_pgdata`, `ganso_caddydata` e
  `ganso_caddyconfig`;
- arquivos sensíveis em `.env`, `data/credentials.json`,
  `data/keypair.enc` e `secrets/keypair.enc`;
- `data/credentials.json` com precedência sobre `.env`;
- depois da migração multiusuário, a wallet usada pelo bot podia estar cifrada
  em `user_wallets` no PostgreSQL; os `keypair.enc` podiam ser legado órfão;
- Geyser/RPC ainda como placeholders naquele registro.

Nada disso substitui a inspeção atual. Se o servidor divergir, pare e atualize
o manifesto antes de remover.

## 1. Validar a conexão SSH

No Hetzner Console, confirme que `claude-ganso-bot` é o nome da chave pública
cliente e que seu fingerprint é:

```text
MD5:7b:a8:61:f5:b2:27:08:69:d2:ea:25:3d:33:ae:17:d1
```

Esse valor provavelmente não é a host key. Confirme também no console web do
servidor o SHA256 da host key Ed25519:

```sh
sudo ssh-keygen -E sha256 -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Na máquina local, compare o valor obtido no console com:

```sh
ssh-keyscan -T 5 -t ed25519 178.105.65.251 2>/dev/null | ssh-keygen -E sha256 -lf -
```

Se não corresponder exatamente, pare. Depois conecte diretamente:

```sh
ssh -o StrictHostKeyChecking=ask ganso@178.105.65.251
```

Já no servidor:

```sh
id -un
hostname
ip -brief address
uptime
free -b
df -B1 /home/ganso /var/lib/docker
```

O usuário esperado é `ganso`; o IPv4 esperado é `178.105.65.251`. O hostname e
o Server ID devem ser anotados e comparados ao Hetzner Console, pois ainda não
há um hostname de referência no repositório. Não execute o restante em host,
usuário ou Server ID diferente. Registre também carga, RAM e ocupação do SSD; se
o uso de disco for maior que 75%, pare antes de compilar probes ou criar o
checkout de staging.

## 2. Inventário somente leitura

Valide o caminho literal:

```sh
cd /home/ganso/ganso-bot
test "$(pwd -P)" = "/home/ganso/ganso-bot"
git rev-parse --show-toplevel
```

O último comando deve retornar exatamente `/home/ganso/ganso-bot`.

Inventarie o Compose e o Docker:

```sh
docker compose ps -a
docker ps -a --no-trunc --filter label=com.docker.compose.project=ganso --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
docker volume ls --filter label=com.docker.compose.project=ganso
docker network ls --no-trunc --filter label=com.docker.compose.project=ganso
docker image ls --no-trunc --format 'table {{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}'
docker volume inspect ganso_pgdata ganso_caddydata ganso_caddyconfig
docker volume inspect d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4
docker ps -a --no-trunc --filter volume=d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4
docker inspect --format '{{.Id}} {{.Name}} image={{.Image}} status={{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}} project={{index .Config.Labels "com.docker.compose.project"}} mounts={{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}};{{end}}' ganso-bot-1 ganso-dashboard-1 ganso-postgres-1 ganso-proxy-1 ganso-redis-1
docker inspect ganso-bot-1 | jq -r '.[0].Config.Env[] | split("=")[0]' | sort
docker system df -v
```

Configs e secrets Docker existem somente no modo Swarm. Inventarie o estado sem
ocultar erro; se o daemon estiver em Swarm ativo, este usuário também precisa
ser manager para a listagem concluir:

```bash
(
set -euo pipefail
swarm_state="$(docker info --format '{{.Swarm.LocalNodeState}}')"
case "$swarm_state" in
  inactive)
    echo 'Docker Swarm inactive; configs/secrets Swarm não existem neste daemon'
    ;;
  active)
    docker service ls --format 'table {{.ID}}\t{{.Name}}\t{{.Mode}}\t{{.Replicas}}'
    docker secret ls --format 'table {{.ID}}\t{{.Name}}\t{{.Labels}}'
    docker config ls --format 'table {{.ID}}\t{{.Name}}\t{{.Labels}}'
    ;;
  *)
    echo 'STOP: estado Docker Swarm não reconhecido' >&2
    exit 1
    ;;
esac
)
```

Repita o `docker inspect --format` para todo ID retornado pelo filtro do projeto,
inclusive Prometheus/Grafana ou orphan. O comando com `jq` mostra somente nomes
de variáveis, nunca valores, e ajuda a localizar fontes de credencial fora de
`.env`/JSON. Se `jq` não estiver instalado, pare esse check; não substitua por um
`docker inspect` integral que imprima tokens.

Os três volumes nomeados só podem entrar no manifesto destrutivo se o `inspect`
confirmar que são exclusivos do projeto Compose `ganso`. Nome ausente ou label
divergente exige parada; não troque por um nome parecido no improviso.

Existe uma única exceção autorizada para composição do manifesto: o volume sem
label Compose
`d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4`.
Ela só é válida se `docker system df -v` registrar `0 B`, driver e scope forem
`local`, o owner registrado for o daemon Docker, `shared=false`, e o único
consumidor inventariado for o container parado
`ganso-redis-1`, ID
`4a96a1147ffb165e8c29f11702734204c026276c5269e62f64f2da42909df053`,
projeto Compose `ganso`, mount do tipo `volume` em `/data` com escrita. `0 B` é
somente um metadado; não prova exclusividade. Qualquer outro volume sem label
Compose ou divergência nesses campos causa parada. Esta exceção documental não
autoriza remoção; ela continua sujeita a todos os gates e a uma aprovação
destrutiva posterior.

Confira rede, processos e automações:

```sh
sudo ss -lntup
systemctl list-units --all --type=service --type=timer | grep -Ei 'ganso|bot' || true
systemctl --user list-units --all --type=service --type=timer | grep -Ei 'ganso|bot' || true
crontab -l || true
sudo crontab -l || true
sudo grep -RIlE 'ganso-bot|/home/ganso/ganso-bot' /etc/systemd/system /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly 2>/dev/null || true
findmnt -R /home/ganso/ganso-bot || true
sudo find /home/ganso/ganso-bot -xdev -type l -print
ssh-keygen -E md5 -lf /home/ganso/.ssh/authorized_keys
grep -nF 'command="/home/ganso/ganso-bot/scripts/deploy_from_ci.sh"' /home/ganso/.ssh/authorized_keys | cut -d: -f1 || true
```

Esperado: nenhum serviço/cron externo e nenhum mount ou symlink inesperado. Se
aparecer algo, não use a seção destrutiva até classificar o alvo.

Para cada unit literal encontrada, registre somente os caminhos declarados em
`EnvironmentFile` sem abrir seu conteúdo:

```sh
systemctl show UNIT_LITERAL --property=EnvironmentFiles --value
systemctl --user show UNIT_LITERAL --property=EnvironmentFiles --value
```

Execute apenas o comando do escopo em que a unit foi encontrada. Depois use
`stat` nos paths retornados para registrar owner/modo/tamanho; caminho ausente,
relativo, com glob ou dentro de recurso compartilhado causa parada. Não use
`systemctl cat` nem `grep` sobre o EnvironmentFile, pois isso pode exibir
valores.

Liste apenas localização e permissões dos arquivos sensíveis; não abra o
conteúdo:

```sh
sudo find /home/ganso/ganso-bot -xdev -type f \( -name '.env' -o -name 'credentials.json' -o -name 'keypair.enc' \) -printf '%p\t%u:%g\t%m\t%s bytes\n'
```

Não inicie nem mesmo o PostgreSQL durante este inventário. A possibilidade
histórica de a wallet estar somente em `user_wallets` é tratada de forma
fail-closed pelo gate seguinte: a recuperação externa precisa ser provada sem
usar o CPX42. Se o proprietário não puder produzir essa prova, pare; esta RFC
não autoriza iniciar o banco para exportar ou recuperar material cifrado.

## 3. Bloquear qualquer retorno do bot antigo

Antes da limpeza:

1. No GitHub do Ganso-bot, desabilite o workflow manual `Deploy`.
2. Remova `DEPLOY_HOST` e `DEPLOY_SSH_KEY` somente se forem exclusivos do bot.
3. Se existir uma linha `authorized_keys` com forced command para
   `deploy_from_ci.sh`, classifique seu fingerprint. Remova-a somente depois de
   abrir uma segunda sessão SSH humana e confirmar acesso ao console Hetzner.
4. Não revogue a chave humana que permite `ssh ganso@178.105.65.251`.
5. Qualquer unit/timer/cron encontrado precisa ser parado e desabilitado pelo
   nome literal antes da seção destrutiva; atualize o manifesto e não improvise.
6. Confirme `docker compose ps -a`: tudo deve continuar `Exited`.
7. Confirme no explorador/wallet que não há posição, ordem ou transação
   pendente dependente do bot.

Se não for possível separar a chave humana da chave de deploy, pare e faça essa
separação primeiro.

## 4. Gate da hot wallet

Em dispositivo confiável fora do CPX42:

1. Abra a recuperação mantida pelo proprietário sem expor seed/private key.
2. Confirme que o endereço derivado é exatamente
   `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`.
3. Assine e verifique uma mensagem offline.
4. Reconcile saldo, tokens e transações pendentes on-chain.

Marque `PASS-WALLET` somente após as quatro verificações. Se a única forma de
recuperação estiver em `user_wallets` dentro de `ganso_pgdata`, em
`/home/ganso/ganso-bot/data/keypair.enc` ou em `secrets/keypair.enc`, pare. A
recuperação offline fora do CPX42 é pré-requisito absoluto nesta sequência; não
há procedimento de exportação autorizado nesta RFC.

Nunca cole seed, private key ou passphrase no terminal compartilhado, no chat ou
no repositório.

## 5. Gate do contrato Yellowstone

No portal do fornecedor:

1. Confirme que a assinatura/plano está ativo e pago.
2. Registre fora do Git o nome do fornecedor, conta/projeto, limites e região.
3. Confirme se existe allowlist de IP e mantenha `178.105.65.251` permitido.
4. Crie, se possível, um token novo identificado como `ganso-market`.
5. Não cancele o plano e não revogue o token antigo ainda.

Crie o diretório de secrets do novo projeto:

```sh
install -d -m 700 /home/ganso/.config/ganso-market
install -d -m 700 /home/ganso/.config/ganso-market/secrets
```

O caminho está fora de `/home/ganso/ganso-bot`, portanto não entra na remoção.
Use o helper produzido pela RFC-001A para gravar o endpoint/token novo por TTY ou
para extrair somente os valores efetivos antigos. O helper deve criar:

```text
/home/ganso/.config/ganso-market/secrets/yellowstone_endpoint
/home/ganso/.config/ganso-market/secrets/yellowstone_token
/home/ganso/.config/ganso-market/secrets/solana_rpc_endpoints.json
```

Execute o helper a partir do checkout novo. Primeiro faça o inventário
redigido; ele imprime somente nomes, presença, modo e tamanho, e deve falhar se
a fonte efetiva estiver vazia, insegura, com placeholder ou schema inesperado:

```sh
cd /home/ganso/ganso-market
python3 scripts/rfc001a_secrets.py inventory --source-dir /home/ganso/ganso-bot
```

Se o portal forneceu a credencial nova preferida, grave-a somente por TTY, sem
argumentos ou variáveis de ambiente com segredo:

```sh
python3 scripts/rfc001a_secrets.py manual --destination-dir /home/ganso/.config/ganso-market/secrets
```

Somente se o fornecedor não permitir uma segunda credencial e o inventário
anterior tiver passado, migre os três valores efetivos antigos:

```sh
python3 scripts/rfc001a_secrets.py migrate --source-dir /home/ganso/ganso-bot --destination-dir /home/ganso/.config/ganso-market/secrets
```

O helper usa criação exclusiva e não sobrescreve nenhum dos três destinos. Se
uma tentativa parcial falhar, pare e investigue o erro redigido; não apague o
destino para forçar nova execução sem antes confirmar literalmente o que foi
criado.

Confira nomes, donos, modos e tamanhos sem mostrar conteúdo. Inclua os
diretórios e rejeite symlink:

```sh
test ! -L /home/ganso/.config
test ! -L /home/ganso/.config/ganso-market
test ! -L /home/ganso/.config/ganso-market/secrets
test "$(realpath -e /home/ganso/.config/ganso-market)" = "/home/ganso/.config/ganso-market"
test "$(realpath -e /home/ganso/.config/ganso-market/secrets)" = "/home/ganso/.config/ganso-market/secrets"
stat -c '%n %U:%G %a %s bytes' /home/ganso/.config/ganso-market /home/ganso/.config/ganso-market/secrets /home/ganso/.config/ganso-market/secrets/yellowstone_endpoint /home/ganso/.config/ganso-market/secrets/yellowstone_token /home/ganso/.config/ganso-market/secrets/solana_rpc_endpoints.json
```

O diretório deve ser `0700`; os três arquivos devem ser `0600`. Não copie o
`.env`, `credentials.json` ou diretório `data` inteiro.

O registro histórico diz que Geyser/RPC podiam estar como placeholders. Se o
helper apontar placeholder/ausência, obtenha uma credencial real no portal; não
contorne a falha copiando arquivos de backup.

## 6. Probes e autorização irreversível

Confirme por fonte oficial do cluster o hash de gênese público esperado. A RFC
não fixa mainnet/devnet/testnet, portanto não copie um hash por memória e não
avance se o cluster esperado estiver ambíguo. O hash é público; endpoint e token
continuam somente nos arquivos.

Execute a partir do checkout de `/home/ganso/ganso-market`. O probe Yellowstone
usa o cliente gRPC oficial, lê somente os dois arquivos dedicados, assina a
stream de slots `processed` e exige três slots estritamente crescentes dentro de
45 segundos:

```sh
cd /home/ganso/ganso-market
cargo run --locked --release -p ganso-rfc001a-yellowstone-probe -- \
  --secrets-dir /home/ganso/.config/ganso-market/secrets \
  --timeout-seconds 45
```

O probe RPC valida `getGenesisHash` e `getSlot` com commitment `confirmed`. No
comando abaixo, substitua somente o marcador pelo hash público confirmado; não
coloque URL ou token na linha de comando:

```sh
python3 scripts/rfc001a_rpc_probe.py \
  --secrets-file /home/ganso/.config/ganso-market/secrets/solana_rpc_endpoints.json \
  --expected-genesis-hash HASH_PUBLICO_CONFIRMADO \
  --timeout-seconds 30
```

O resultado mínimo permitido é:

- `PASS-YELLOWSTONE`: autenticação aceita e pelo menos três slots avançando;
- `PASS-RPC`: cluster correto e slot atual recebido;
- zero endpoint/token exibido em stdout, stderr, logs ou histórico;
- `PASS-WALLET` da seção 4;
- zero posição/ordem/transação pendente;
- workflow de deploy antigo desabilitado.

Antes de continuar, registre em `docs/test-results/RFC-001A.md` somente:

- data UTC;
- IP e hostname;
- IDs/nomes literais dos alvos;
- resultados `PASS/FAIL` redigidos;
- aprovação explícita do proprietário.

Não registre token, URL com credencial, seed, passphrase ou hashes de segredo.

Transcreva o inventário literal para um manifesto JSON que siga o schema
documentado em `scripts/rfc001a_manifest.py`. Valide primeiro sem aprovação:

```sh
python3 scripts/rfc001a_manifest.py validate \
  --manifest docs/test-results/RFC-001A-manifest.json
```

Somente depois de apresentar esse mesmo manifesto ao proprietário e receber a
aprovação explícita, registre `approval.approved=true` e repita com
`--require-approval`. O validador não autentica o proprietário e não executa
comando destrutivo; ele apenas rejeita identidade, paths, recursos ou gates
ambíguos.

A autorização desta emenda não deve ser transcrita como
`approval.approved=true`: ela apenas permite que o volume excepcional seja
classificado no inventário. A aprovação destrutiva posterior precisa citar o ID
completo expressamente.

Os consumidores registrados nos volumes pertencem ao inventário
pré-destrutivo: nesse momento os containers parados ainda existem. Depois do
`docker compose down`, a seção 7.3 exige uma segunda prova, independente, de
zero consumidores antes de qualquer remoção de volume.

## 7. Remoção permanente — executar somente após todos os PASS

Esta seção ainda não é executável no estado atual do projeto: wallet, portal,
probes reais, manifesto validado e aprovação destrutiva continuam pendentes. Ela
só se torna executável quando `docs/test-results/RFC-001A.md` contiver os IDs
literais e todos os gates. Não avance apenas porque os comandos abaixo estão
documentados.

Antes de remover, confirme que:

- todo container listado pelo label `com.docker.compose.project=ganso` foi
  inspecionado por ID, inclusive mounts, image ID e restart policy;
- nenhuma unit, timer, cron ou forced command de deploy consegue reiniciar o bot;
- qualquer orphan foi classificado literalmente;
- nenhum mount, volume, network ou credencial é compartilhado;
- a exceção de volume, se presente, coincide em todos os campos com o ID e o
  consumidor literal autorizados nesta emenda;
- os IDs das imagens próprias estão no manifesto aprovado.

### 7.1 Remover containers definidos no Compose

Primeiro confira a lista de serviços e revalide o único consumidor da exceção.
Ambos precisam coincidir com o manifesto:

```sh
cd /home/ganso/ganso-bot
test "$(pwd -P)" = "/home/ganso/ganso-bot"
docker compose config --services
test "$(docker ps -aq --no-trunc --filter volume=d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4)" = "4a96a1147ffb165e8c29f11702734204c026276c5269e62f64f2da42909df053"
test "$(docker inspect -f '{{.Name}} {{.State.Status}} {{.HostConfig.RestartPolicy.Name}} {{index .Config.Labels "com.docker.compose.project"}}' 4a96a1147ffb165e8c29f11702734204c026276c5269e62f64f2da42909df053)" = "/ganso-redis-1 exited no ganso"
test "$(docker inspect -f '{{range .Mounts}}{{if eq .Name "d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4"}}{{.Type}} {{.Destination}} {{.RW}}{{end}}{{end}}' 4a96a1147ffb165e8c29f11702734204c026276c5269e62f64f2da42909df053)" = "volume /data true"
```

Essas três asserções são somente leitura e específicas da exceção. Qualquer
saída diferente, inclusive volume já ausente ou consumidor adicional, invalida
o manifesto e exige nova aprovação; não avance para `docker compose stop`.

Somente depois da comparação e aprovação, execute em um novo bloco fail-closed:

```bash
(
set -euo pipefail
cd /home/ganso/ganso-bot
test "$(pwd -P)" = "/home/ganso/ganso-bot"
test -f /home/ganso/ganso-bot/docker-compose.yml
docker compose stop
docker compose down
)
```

Não use `--remove-orphans`: cada orphan deve ser removido posteriormente pelo ID
literal aprovado. Se `down` falhar, pare; não vá para volumes.

Confirme que não sobrou container do projeto:

```sh
docker ps -a --filter label=com.docker.compose.project=ganso --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
```

A saída deve conter somente o cabeçalho. Se houver orphan, pare e use somente o
ID literal registrado no manifesto; o runbook não autoriza um filtro destrutivo.

### 7.2 Remover Docker configs/secrets exclusivos, se existirem

Esta subseção é aplicável somente se o inventário confirmou Swarm ativo e o
manifesto aprovado contém IDs e nomes literais em `docker_configs` ou
`docker_secrets`. Inspecione cada ID sem exibir conteúdo e confirme que nenhum
Docker service ainda o referencia. Se houver service do Ganso-bot, pare: ele
precisa ser inventariado e removido por ID em uma emenda do manifesto antes dos
configs/secrets. Se houver consumidor compartilhado, o recurso fica fora da
remoção.

Os comandos `docker config rm` e `docker secret rm` não pedem confirmação.
Registre no relatório e execute uma linha por ID literal já aprovado, sem
substituição de comando, filtro ou lista gerada:

```sh
docker config rm ID_CONFIG_LITERAL_APROVADO
docker secret rm ID_SECRET_LITERAL_APROVADO
```

Se os arrays correspondentes do manifesto estiverem vazios, não execute esses
comandos. Qualquer placeholder ainda presente encerra esta subseção.

### 7.3 Remover os volumes exclusivos

Inspecione em um bloco sem remoção:

```sh
docker volume inspect ganso_pgdata ganso_caddydata ganso_caddyconfig
docker volume inspect d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4
docker ps -a --filter volume=ganso_pgdata
docker ps -a --filter volume=ganso_caddydata
docker ps -a --filter volume=ganso_caddyconfig
docker ps -a --no-trunc --filter volume=d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4
docker system df -v
```

Confirme novamente que cada label `com.docker.compose.project` é exatamente
`ganso` nos três volumes nomeados, que o volume excepcional continua sem label
Compose, driver `local`, `0 B` e consta por ID completo na aprovação destrutiva.
Os quatro volumes devem estar sem qualquer consumidor depois da seção 7.1. Se o
relatório de tamanho não for exatamente `0 B` para a exceção, pare; não use outro
comando para estimar ou limpar seu conteúdo. Somente então execute este bloco
separado, que valida os campos verificáveis e todos os consumidores antes de
remover o primeiro:

```bash
(
set -euo pipefail
test "$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' ganso_pgdata)" = "ganso"
test "$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' ganso_caddydata)" = "ganso"
test "$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' ganso_caddyconfig)" = "ganso"
test "$(docker volume inspect -f '{{.Name}}' d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4)" = "d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4"
test "$(docker volume inspect -f '{{.Driver}}' d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4)" = "local"
test "$(docker volume inspect -f '{{.Scope}}' d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4)" = "local"
exception_labels_json="$(docker volume inspect -f '{{json .Labels}}' d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4)"
if printf '%s\n' "$exception_labels_json" | grep -Fq '"com.docker.compose.project":'; then
  echo "STOP: volume excepcional ganhou label Compose" >&2
  exit 1
fi
ganso_pgdata_consumers="$(docker ps -aq --no-trunc --filter volume=ganso_pgdata)"
ganso_caddydata_consumers="$(docker ps -aq --no-trunc --filter volume=ganso_caddydata)"
ganso_caddyconfig_consumers="$(docker ps -aq --no-trunc --filter volume=ganso_caddyconfig)"
exception_consumers="$(docker ps -aq --no-trunc --filter volume=d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4)"
test -z "$ganso_pgdata_consumers"
test -z "$ganso_caddydata_consumers"
test -z "$ganso_caddyconfig_consumers"
test -z "$exception_consumers"
docker volume rm ganso_pgdata
docker volume rm ganso_caddydata
docker volume rm ganso_caddyconfig
docker volume rm d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4
)
```

Falha, label ausente nos volumes nomeados ou label Compose presente na exceção
encerra o bloco. A inspeção de `0 B` acontece antes deste bloco e permanece um
gate manual registrado na evidência. Não execute `docker volume prune` nem
`docker compose down -v`.

### 7.4 Remover network e imagens próprias

Se `ganso_default` ainda existir, primeiro inspecione sem remover:

```sh
docker network inspect ganso_default
```

Depois de confirmar label `ganso`, zero containers anexados e aprovação literal,
execute separadamente:

```bash
(
set -euo pipefail
test "$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' ganso_default)" = "ganso"
test "$(docker network inspect -f '{{len .Containers}}' ganso_default)" = "0"
docker network rm ganso_default
)
```

Remova somente as imagens construídas especificamente para `ganso-bot` e
`ganso-dashboard`, uma por vez, usando os image IDs literais anotados e aprovados
em `docs/test-results/RFC-001A.md`. Como os IDs só podem vir do inventário do
host, este documento não tenta adivinhá-los. Se o relatório ainda não contiver o
comando `docker image rm <ID_LITERAL_APROVADO>` já substituído por um ID real,
pare. Não remova por glob e não use `docker system prune` ou builder prune.
Imagens genéricas de PostgreSQL, Redis, Caddy ou Grafana não provam presença do
Ganso-bot e podem ser compartilhadas.

### 7.5 Remover o checkout antigo

Por fim, elimine o checkout antigo por um alvo literal. A movimentação não cria
cópia; ela apenas isola o alvo antes da remoção final:

```bash
(
set -euo pipefail
cd /home/ganso
test "$(pwd -P)" = "/home/ganso"
test -d /home/ganso/ganso-bot
test ! -L /home/ganso/ganso-bot
test ! -e /home/ganso/ganso-bot.DELETE-20260810
if findmnt -rn -o TARGET | grep -Eq '^/home/ganso/ganso-bot(/|$)'; then
  echo "STOP: mount encontrado dentro do alvo" >&2
  exit 1
fi
if sudo find /home/ganso/ganso-bot -xdev -type l -print -quit | grep -q .; then
  echo "STOP: symlink encontrado dentro do alvo" >&2
  exit 1
fi
sudo mv -- /home/ganso/ganso-bot /home/ganso/ganso-bot.DELETE-20260810
test ! -e /home/ganso/ganso-bot
test -d /home/ganso/ganso-bot.DELETE-20260810
test ! -L /home/ganso/ganso-bot.DELETE-20260810
sudo rm -rf -- /home/ganso/ganso-bot.DELETE-20260810
test ! -e /home/ganso/ganso-bot.DELETE-20260810
)
```

O bloco para automaticamente em mount, symlink, destino preexistente ou erro de
movimentação. Não altere o alvo para `/home/ganso` e não use variável ou `~` no
comando de remoção.

Depois que o token novo continuar funcionando, revogue no portal o token antigo
somente se o fornecedor confirmar que ele era exclusivo do Ganso-bot. Token
compartilhado deve ser rotacionado de forma coordenada ou permanecer ativo como
risco residual. Não cancele a assinatura Yellowstone.

## 8. Verificação pós-limpeza

```bash
(
set -euo pipefail
test ! -e /home/ganso/ganso-bot
remaining_ganso_containers="$(docker ps -aq --no-trunc --filter label=com.docker.compose.project=ganso)"
remaining_ganso_volumes="$(docker volume ls -q --filter label=com.docker.compose.project=ganso)"
remaining_volume_names="$(docker volume ls -q)"
remaining_ganso_networks="$(docker network ls -q --no-trunc --filter label=com.docker.compose.project=ganso)"
test -z "$remaining_ganso_containers"
test -z "$remaining_ganso_volumes"
if printf '%s\n' "$remaining_volume_names" | grep -Fxq 'd92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4'; then
  echo "STOP: volume excepcional do Ganso-bot ainda existe" >&2
  exit 1
fi
test -z "$remaining_ganso_networks"
test -z "$(pgrep -af '/home/ganso/[g]anso-bot|[g]anso-bot' || true)"
test -z "$(sudo grep -RIlE 'ganso-bot|/home/ganso/ganso-bot' /etc/systemd/system /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly 2>/dev/null || true)"
test -z "$(systemctl list-units --all --type=service --type=timer | grep -Ei 'ganso-bot|/home/ganso/ganso-bot' || true)"
test -z "$(systemctl --user list-units --all --type=service --type=timer | grep -Ei 'ganso-bot|/home/ganso/ganso-bot' || true)"
test -z "$({ crontab -l 2>/dev/null || true; } | grep -Ei 'ganso-bot|/home/ganso/ganso-bot' || true)"
test -z "$({ sudo crontab -l 2>/dev/null || true; } | grep -Ei 'ganso-bot|/home/ganso/ganso-bot' || true)"
test -z "$(grep -nF 'command="/home/ganso/ganso-bot/scripts/deploy_from_ci.sh"' /home/ganso/.ssh/authorized_keys || true)"
test -z "$(findmnt -rn -o TARGET | grep -E '^/home/ganso/ganso-bot(/|$)' || true)"
if sudo ss -H -lnt | awk '{print $4}' | grep -Eq ':(80|443)$'; then
  echo "STOP: listener TCP/80 ou TCP/443 ainda existe" >&2
  exit 1
fi
test ! -L /home/ganso/.config
test ! -L /home/ganso/.config/ganso-market
test ! -L /home/ganso/.config/ganso-market/secrets
test "$(realpath -e /home/ganso/.config/ganso-market)" = "/home/ganso/.config/ganso-market"
test "$(realpath -e /home/ganso/.config/ganso-market/secrets)" = "/home/ganso/.config/ganso-market/secrets"
stat -c '%n %U:%G %a %s bytes' /home/ganso/.config/ganso-market /home/ganso/.config/ganso-market/secrets /home/ganso/.config/ganso-market/secrets/yellowstone_endpoint /home/ganso/.config/ganso-market/secrets/yellowstone_token /home/ganso/.config/ganso-market/secrets/solana_rpc_endpoints.json

case "$(docker info --format '{{.Swarm.LocalNodeState}}')" in
  inactive)
    ;;
  active)
    ganso_secret_ids="$(docker secret ls -q --filter label=com.docker.compose.project=ganso)"
    ganso_config_ids="$(docker config ls -q --filter label=com.docker.compose.project=ganso)"
    test -z "$ganso_secret_ids"
    test -z "$ganso_config_ids"
    ;;
  *)
    echo 'STOP: estado Docker Swarm não reconhecido' >&2
    exit 1
    ;;
esac

used_percent="$(df -P /home/ganso | awk 'NR == 2 {gsub("%", "", $5); print $5}')"
case "$used_percent" in
  ''|*[!0-9]*)
    echo 'STOP: uso do SSD não pôde ser validado' >&2
    exit 1
    ;;
  *)
    test "$used_percent" -le 75
    ;;
esac
)
```

Resultado esperado:

- nenhum container, volume, network, Docker config ou Docker secret com label do
  projeto `ganso`, e o volume excepcional literal não existe;
- todos os image IDs próprios aprovados retornam `not found` em
  `docker image inspect`;
- nenhum processo, caminho, mount, unit, timer, cron ou forced command aponta
  para o checkout antigo;
- somente TCP/22 público; TCP/80 e TCP/443 continuam sem listener em IPv4 ou
  IPv6;
- os secrets mínimos do Ganso Market permanecem `0600`;
- probes Yellowstone/RPC continuam passando;
- wallet continua recuperável fora do servidor;
- `/home/ganso/ganso-market` permanece intacto e em `paper`.

No Hetzner Console, confirme que não existe regra inbound TCP/80 ou TCP/443 para
IPv4 ou IPv6 nesta RFC. A partir de outra máquina, confirme que
`178.105.65.251:80` e `:443` não estabelecem conexão. Se o host tiver IPv6,
repita o teste no endereço inventariado. `ss` sozinho não comprova o firewall.

Não reinicie o daemon Docker se houver qualquer workload compartilhado. A prova
de não-retorno nesta RFC é a ausência de containers, restart policies, units,
timers, crons, forced command e deploy externo. Reboot completo não faz parte da
limpeza.

## 9. O que deliberadamente não é apagado

- sistema operacional, usuário `ganso`, `.ssh`, firewall, IPv4 e host key;
- Docker e imagens genéricas compartilháveis;
- cache/dangling layers do BuildKit que não possam ser atribuídos de modo seguro
  ao projeto antigo; removê-los exigiria prune global ou reprovisionamento, ambos
  fora da autorização;
- journal global do SO e histórico geral do shell, pois não há remoção seletiva
  confiável sem apagar registros não relacionados;
- assinatura/conta Yellowstone;
- diretório e secrets ativos do Ganso Market;
- recuperação offline da wallet.

Depois da seção 7 não existe rollback do banco/corpus/configuração do Ganso-bot.
A única continuidade permitida é o novo projeto, os secrets mínimos validados e
a recuperação offline da wallet.
