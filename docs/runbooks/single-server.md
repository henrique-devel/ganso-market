# Servidor único — instalação mínima

Este modo executa somente o Ganso Market em um host Ubuntu dedicado. A máquina
precisa de Docker Engine, Docker Compose, Git, Make, Python 3, `curl` e `rsync`;
Node, Rust, PostgreSQL e Nginx são fornecidos pelos containers.

O deploy não instala nem altera firewall, domínio, certificado, proxy externo
ou ferramenta de observabilidade. O único bind no host é o gateway Nginx em
`0.0.0.0:80`; PostgreSQL, API, engine e worker não publicam portas próprias.

## Estado funcional atual

A implementação existente é a fundação do projeto: frontend, healthchecks,
PostgreSQL, API e engine, mais a autenticação single-user (RFC-002) e o
recorder Polymarket (RFC-007). Não existem estratégia, wallet, ordens ou
execução. O perímetro do painel autenticado (firewall Hetzner ou TLS) é
responsabilidade do operador — ver o runbook de perímetro.

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

### Containers de profile e a janela de ordem de deploy

`make server-update` **não troca a imagem dos containers de profile**
(`polymarket-*`). Toda mudança em código que eles executam exige rebuild
explícito:

```sh
docker compose --env-file deploy/server.env --profile polymarket up --build --detach \
  polymarket-recorder polymarket-estimator polymarket-paper polymarket-resolution
```

**Cuidado com configs versionadas que nomeiam conteúdo da imagem.** O diretório
`config/` é montado por bind e chega junto com o CD; o conteúdo que ele nomeia
(o léxico de resolução, por exemplo) vive **dentro da imagem** e só muda no
rebuild. Entre uma coisa e outra existe uma janela em que o binário ANTIGO lê a
config NOVA.

Aconteceu em 2026-08-26: `config/resolution.json` passou a declarar
`score_version: 1.1.0`, o `polymarket-resolution` antigo leu esse nome e gravou
uma linha em `resolution_score_versions` fixando 1.1.0 ao hash do léxico
**anterior**. Quando a imagem nova subiu, o hash calculado divergiu do gravado e
o serviço passou a falhar fechado com `SCORE_VERSION_CONTENT_MISMATCH` — o
comportamento correto, mas o nome de versão ficou queimado, porque a linha é
imutável por trigger (e deve ser). A saída foi cunhar 1.1.1.

Para evitar: quando um PR mudar **ao mesmo tempo** um arquivo de `config/` e o
conteúdo que ele nomeia, faça o rebuild dos containers de profile na mesma
janela do merge, antes de o serviço afetado reiniciar por qualquer outro
motivo.

## CI/CD do GitHub

O workflow `.github/workflows/ci-cd.yml` roda `make verify` e o smoke completo
do Compose em pull requests, pushes para `main` e execuções manuais. O deploy
acontece somente em `main`, depois dos dois gates, no environment GitHub
`production`.

Ativação única:

1. Gere uma chave Ed25519 exclusiva para o GitHub Actions, sem reutilizar a
   chave pessoal do operador.
2. Copie somente a chave pública para o servidor e execute, como root:

   ```sh
   ./deploy/install-github-deploy-key.sh /caminho/chave.pub
   ```

3. No environment `production` do repositório GitHub, cadastre:
   - `DEPLOY_SSH_KEY`: conteúdo da chave privada dedicada;
   - `DEPLOY_KNOWN_HOSTS`: linha completa Ed25519 de `178.105.65.251`, já
     validada pelo fingerprint registrado em `docs/ops/SERVER_ACCESS.md`.
4. Crie a variável de repositório `DEPLOY_ENABLED=true`. Sem ela, os gates de
   CI funcionam normalmente e o job de produção fica ignorado.
5. Apague a cópia privada temporária do computador usado na configuração após
   confirmar que o secret foi cadastrado.

A entrada em `authorized_keys` usa `restrict` e um comando forçado instalado em
`/usr/local/sbin`: o canal SSH não recebe shell, PTY ou forwarding. O workflow
envia um arquivo produzido por `git archive`; o servidor valida caminhos,
tipos, tamanho e secrets, cria backup do código e só então executa
`make server-update`. Falha, timeout ou interrupção dentro do comando remoto,
depois do início da cópia, restaura o código anterior e reinicia o runtime
anterior. Os cinco backups de código mais recentes ficam em `.deploy/backups`,
fora do contexto Docker. A checagem pública posterior deixa o workflow vermelho
se a rede externa falhar, mas não reverte um runtime que já passou no health
interno do servidor.

Essa validação estrutural não é uma assinatura criptográfica da origem. Como o
arquivo controla Makefile, Compose e Dockerfiles executados como root, a chave
de deploy deve ser tratada como credencial equivalente a root mesmo sem shell
interativo. Proteja `main` e o environment `production`, limite quem pode
alterar seus secrets e rotacione a chave em caso de suspeita.

O rollback não desfaz migrations já aplicadas. Toda migration entregue pelo CD
deve continuar compatível com a versão anterior até existir um procedimento de
backup e rollback do banco. O volume `ganso-market_postgres_data`,
`deploy/server.env` e `infra/secrets/local/postgres_password` nunca são
removidos ou substituídos pelo workflow.

Para atualizar o próprio comando forçado depois de uma mudança revisada nesses
scripts, repita manualmente o instalador da chave pública no servidor. O CD não
se autoatribui permissão para substituir sua raiz de confiança.

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
