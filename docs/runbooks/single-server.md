# Servidor único — instalação mínima

Este modo executa somente o Ganso Market em um host Ubuntu dedicado. A máquina
precisa de Docker Engine, Docker Compose, Git, Make, Python 3 e `curl`; Node,
Rust, PostgreSQL e Nginx são fornecidos pelos containers.

O deploy não instala nem altera firewall, domínio, certificado, proxy externo,
CI/CD ou ferramenta de observabilidade. O único bind no host é o gateway Nginx
em `0.0.0.0:80`; PostgreSQL, API, engine e worker não publicam portas próprias.

## Estado funcional atual

A implementação existente é a fundação do projeto: frontend, healthchecks,
PostgreSQL, API e engine. Ainda não existem autenticação, ingestão Yellowstone,
estratégia, wallet, ordens ou execução. Portanto a porta 80 entrega apenas esse
painel inicial. Não adicione material de wallet ou habilite execução live antes
de existir autenticação na aplicação.

## 1. Preparar um Ubuntu novo

Coloque o repositório no servidor, entre na raiz dele e execute:

```sh
sudo ./deploy/install-docker-ubuntu.sh
```

O instalador usa o repositório oficial do Docker, habilita o serviço no boot e,
quando chamado via `sudo`, adiciona o usuário atual ao grupo `docker`. Nesse
caso, encerre a sessão SSH e entre novamente uma vez.

## 2. Subir o Ganso Market

Na raiz do repositório:

```sh
make server-up
```

Na primeira execução, esse comando:

1. cria `deploy/server.env` a partir do exemplo;
2. gera uma senha aleatória do PostgreSQL sem mostrá-la;
3. constrói as imagens;
4. aplica as migrations;
5. inicia os serviços com reinício automático;
6. verifica frontend, liveness e readiness.

Depois disso, o painel responde em `http://IP_DO_SERVIDOR/`.

## Operação cotidiana

```sh
make server-status
make server-health
make server-logs
```

Para atualizar depois de obter uma nova versão do código:

```sh
make server-update
```

Execute `git pull --ff-only` antes somente quando o checkout tiver `.git`. O
primeiro deploy em `/opt/ganso-market` foi transferido como pacote do working
tree e não possui histórico Git; nesse caso, sincronize primeiro a nova versão
dos arquivos e só depois execute `make server-update`.

Para encerrar sem apagar os dados do PostgreSQL:

```sh
make server-down
```

Os containers usam `restart: unless-stopped`, então voltam após reboot desde
que tenham sido iniciados antes. Nenhum comando deste runbook remove volumes.

## Arquivos locais do servidor

- `deploy/server.env`: bind e porta do servidor; não versionado;
- `infra/secrets/local/postgres_password`: senha gerada; não versionada; o
  diretório pai `0700` restringe o acesso no host, enquanto o arquivo `0644`
  permite leitura pelos UIDs não-root dentro dos containers;
- volume Docker `ganso-market_postgres_data`: banco persistente.

Este modo é propositalmente simples: HTTP direto, sem TLS e sem filtro de
origem. Qualquer pessoa que alcance o IP pode acessar o conteúdo publicado na
porta 80. Se o painel passar a conter conta, tokens, wallet ou controles de
execução, autenticação de aplicação deve entrar antes desses recursos.
