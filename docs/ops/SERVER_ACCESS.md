# Registro do servidor

Este arquivo registra somente metadados operacionais. Senha, chave privada SSH,
seed, private key da wallet e tokens de provedor não pertencem ao repositório.

## Estado atual verificado após o rebuild

| Campo | Valor |
|---|---|
| Data da verificação/deploy | `2026-08-14` |
| IPv4/URL | `178.105.65.251` / `http://178.105.65.251/` |
| Usuário SSH | `root` |
| Hostname | `ubuntu-16gb-fsn1-2-bot` |
| Sistema | Ubuntu `22.04` (`jammy`), `x86_64` |
| Host key Ed25519 | `SHA256:Qr1GY+n8sfQfQe6ZxHhHkUSZ3PzBtPAwkDQWnU/VV9Q` |
| Chave cliente aceita | `SHA256:Pg3pm6B9lc6NcOBvwTQ9BBX5nn2mpZda9TLRhzePe8U` |
| Docker / Compose | `29.7.2` / `5.4.0` |
| Checkout | `/opt/ganso-market` |
| Runtime | cinco containers persistentes; migration exit `0`; modo `paper` |
| Entrada da aplicação | somente Nginx em `0.0.0.0:80`; sem `[::]:80` |
| Firewall local | UFW inativo; não alterado pelo deploy |

A primeira versão foi enviada como pacote verificado, sem `.git` e sem copiar
secrets locais. O password PostgreSQL foi gerado no próprio servidor.

Conexão operacional:

```sh
ssh -i ~/.ssh/id_ed25519 root@178.105.65.251
cd /opt/ganso-market
make server-status
make server-health
```

## Registro histórico anterior ao rebuild

| Campo | Valor | Estado |
|---|---|---|
| Provedor | Hetzner | informado pelo proprietário |
| Plano | CPX42 | informado pelo proprietário |
| Datacenter/network zone | `fsn1-dc14` / `eu-central` | verificados no IMDS em 2026-08-11; correlacionar o servidor no Hetzner Console |
| IPv4 público | `178.105.65.251` | informado pelo proprietário |
| IPv6 público | `2a01:4f8:c013:6eb5::1/64` | verificado no host por SSH em 2026-08-10; não publicar a aplicação em IPv6 |
| Server ID | `147530325` | verificado no IMDS em 2026-08-11; correlacionar com o IPv4 no Hetzner Console |
| Hostname | `ubuntu-16gb-fsn1-2-bot` | verificado pelo console web e por SSH em 2026-08-10 |
| URL do painel beta | `http://178.105.65.251/` | será habilitada somente na RFC-002 |
| Nome da chave SSH na Hetzner | `claude-ganso-bot` | interpretação mais provável dos dados informados; confirmar no console |
| Usuário Linux | `ganso` | verificado por SSH em 2026-08-10 |
| Diretório antigo esperado | `/home/ganso/ganso-bot` | path canônico confirmado por SSH em 2026-08-11; revalidar antes de qualquer remoção |
| Diretório do novo projeto | `/home/ganso/ganso-market` | destino definido para o deploy |
| Fingerprint da chave SSH informada | `MD5:7b:a8:61:f5:b2:27:08:69:d2:ea:25:3d:33:ae:17:d1` | provavelmente da chave pública cliente; confirmar no console |
| Host key Ed25519 | `SHA256:iWEL5d0MqyhYUzj0cfMgzMxh20OS82aYKD9gmFSLVL0` | correspondência exata entre console web independente, rede e `known_hosts` em 2026-08-10 |
| Chave cliente dedicada | `SHA256:69pP4/MGJm7c4o0AfKwvlkfRXAgXdzyzLIvAIxCChfY` | autorizada para `ganso` e validada em segunda sessão SSH em 2026-08-10 |

O fingerprint acima não é senha nem chave privada. Pelo formato apresentado no
cadastro da Hetzner, ele provavelmente identifica a chave pública cliente
chamada `claude-ganso-bot`; ele não deve ser usado como fingerprint da host key
do servidor sem confirmação explícita no console.

## Procedimento histórico de primeiro acesso

No Hetzner Console, confirme primeiro que a chave cadastrada
`claude-ganso-bot` possui o fingerprint informado. Na máquina do operador,
identifique o arquivo público correspondente e valide-o; não use a chave
privada como argumento:

```sh
ssh -G ganso@178.105.65.251 | awk '$1 == "identityfile" {print $2}'
```

Na sequência, execute `ssh-keygen -E md5 -lf` passando o caminho literal do
arquivo `.pub` confirmado. O resultado esperado é:

```text
MD5:7b:a8:61:f5:b2:27:08:69:d2:ea:25:3d:33:ae:17:d1
```

Essa validação comprova a identidade cliente, não a do host. Para a primeira
conexão, abra o console web do próprio servidor e obtenha por canal independente
o fingerprint da host key:

```sh
sudo ssh-keygen -E sha256 -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Na máquina local, compare com:

```sh
ssh-keyscan -T 5 -t ed25519 178.105.65.251 2>/dev/null | ssh-keygen -E sha256 -lf -
```

`ssh-keyscan` sozinho não autentica o servidor. Só prossiga se o SHA256 obtido
no console web e o visto localmente forem idênticos.

Depois da validação:

```sh
ssh -o StrictHostKeyChecking=ask ganso@178.105.65.251
```

Após conectar, confirme sem modificar o host:

```sh
id -un
hostname
ip -brief address
```

O usuário verificado é `ganso`, o hostname é
`ubuntu-16gb-fsn1-2-bot`, o IPv4 público é `178.105.65.251` e o endereço
IPv6 atribuído ao host é `2a01:4f8:c013:6eb5::1/64`. O IMDS retornou Server ID
`147530325`, availability zone `fsn1-dc14` e network zone `eu-central`; o ID
ainda deve ser correlacionado com o IPv4 no Hetzner Console. Use
`StrictHostKeyChecking=yes` nas conexões seguintes. Diferença de usuário, IP,
Server ID ou fingerprint é condição de parada.

## Regras atuais após o rebuild

- Não versionar `~/.ssh/config`, chave privada SSH ou senha.
- Não executar a RFC-001A nem o runbook destrutivo do Ganso-bot no host novo.
- O bootstrap standalone publica somente Nginx em IPv4/TCP 80, sem firewall
  gerenciado pelo projeto.
- PostgreSQL, API, engine e worker não publicam portas no host.
- A aplicação não cria bind IPv6, porta 443, domínio, certificado ou Certbot.
- Manter a host key atual fixada antes de conexões futuras.
