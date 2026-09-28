# Servidor único — instalação mínima

Este modo executa somente o Ganso Market em um host Ubuntu dedicado. A máquina
precisa de Docker Engine, Docker Compose, Git, Make, Python 3, `curl` e `rsync`;
Node, PostgreSQL e Nginx são fornecidos pelos containers.

O deploy não instala nem altera firewall, domínio, certificado, proxy externo
ou ferramenta de observabilidade. O único bind no host é o gateway Nginx em
`0.0.0.0:80`; PostgreSQL, API e workers não publicam portas próprias.

## Estado funcional atual

O núcleo ativo contém frontend, PostgreSQL, API/autenticação e Nginx.
Os cinco workers Polymarket estão aposentados operacionalmente; suas leituras,
replay e histórico permanecem. O estado medido e a decisão de hospedagem estão em G2-10.1 abaixo. O perímetro do painel
é responsabilidade do operador — ver o runbook de perímetro. Somente paper.

## G2-10.1 — Permanecer no host provisionado (27/09/2026 UTC)

Atualização: o [plano G2-12.1 de 28/09](ganso-2-capacity-plan.md) revalida
capacidade/custo e substitui as projeções abaixo para nova admissão. As medições
de G2-10.1 permanecem históricas; a permanência contida continua vigente.

**Decisão: permanecer, sem migração, contratação ou aumento de gasto.** Preservar
API/painel/PostgreSQL e manter o coletor parado. Isso permite consulta ao acervo;
não aprova coleta contínua, sete dias de operação nem sustentabilidade financeira.
G2-10.2/10.3 ficam **superseded** por esta decisão, para registro exclusivo do
coordenador em sessões próprias. Esta entrega altera somente este runbook;
roadmaps/estado de execução não são alterados. Deploy dispensado por texto.

### Perfil medido e limites

Base auditada `980c66c`, schema 45; dependências 03.3/01.2/04.4 entregues e contratos
conferidos em Compose e nos runbooks de [coleta](btc-collector.md) e
[Jev](btc-jev-activation.md). SSH autenticado, somente leitura, em
27/09/2026 04:54:26–04:56:30 UTC; SQL READ ONLY, statement 2 s/lock 500 ms,
sem export de payload, varredura raw, carga pesada, restart ou teste SQL de escrita.

| Medida | Resultado e interpretação |
| --- | --- |
| Host | 8 CPUs x86_64; RAM 16.367 GB, disponível 14.825 GB; swap zero. Não confundir RAM host com folga do cgroup. |
| Filesystem PG | Capacidade 322,302,373,888 B; usados 217,385,394,176 B; disponíveis 91,768,614,912 B (28,47%); diferença reservada/indisponível 13,148,364,800 B. |
| Banco / relações | `pg_database_size` 207,131,358,911 B; relações BTC 2,232,508,416 B e demais relações 204,884,770,816 B, incluindo índices/TOAST. Acervo legado preservado. |
| Corpus limitado do coletor | Raw 2,147,899,519 B; lógico 3,756,535,747 B; físico 2,051,284,992 B. Físico é a soma das seis relações do contrato de capacidade; não todo BTC nem todo banco. |
| Transitórios e outros | WAL atual 150,994,944 B; `/tmp` 20,806,407 B; `/var/tmp` 0; logs host 1,573,906,755 B; `.deploy` 95,880,860 B (du aparente, não somar novamente ao df). `temp_bytes` PG 78,007,034,744,505 B é cumulativo, não ocupação atual. Nenhuma limpeza executada. |
| Recursos em ~20 s | PG 0,472 core, 58/137 períodos throttled, memory.current 1,073,303,552/1,073,741,824 B; API 0,283 core, 61/104, 174,366,720/402,653,184 B. Memory.current inclui cache; docker stats PG descontava cache e mostrava 451 MiB. Sem reserva sustentada comprovada. |
| Conexões e orçamento | 3/40 client backends, zero idle-in-transaction. Perfil com coletor: limites 2048 MiB/3 CPUs, pools 7 + 8 reservadas; coletor pool 2. Limites não são uso nem equivalência entre provedores. |
| Tráfego | Interface externa eth0: RX 10.798/TX 12.397 B na amostra ~20 s, coletor parado. NetIO dos containers inclui rede interna e períodos distintos; não é egress faturável. Franquia/consumo mensal autenticados ausentes. |

Cinco sondas sequenciais de leitura da cabeça BTC e da política/capacidade passaram
(PASS), com tempo de parede docker/psql de 104,12–163,19 ms; readiness 200 em 2,97 ms.
Ensaio representativo **apenas da consulta leve/capacidade atual**, sem percentil
estatístico, escrita, replay completo ou equivalência de destino. Nenhum destino
foi provisionado/testado. CPU shared, burst, armazenamento remoto e latência exigiriam
ensaio próprio; vCPU anunciada não equivale à CPU de desenvolvimento ou à atual.
Coletor confirmado exited/1 desde 26/09 22:07:29 UTC, restart=0/policy=no; permanece
parado após 55P03 já diagnosticado em 09.4, sem atribuir o detentor histórico do lock.

### Retenção e projeção explícita de 90 dias

Unidades: GB=10^9 B, GiB=2^30 B; 90 dias=2160 h. HOLD=true, quotas SQL raw/total
10/12 GiB; worker raw/lógico/físico 4/6/4 GiB; piso filesystem 25% + 1 GiB.
TTL raw 7 dias, barras 12 meses, logs 14 dias e pins permanentes não liberam bytes
sob HOLD; o worker não poda. Ledger, pins e dependências não são descartáveis.
Os bytes de relações medem alocação preservada, **não tamanho de dump/transferência**:
compressão, bloat, reconstrução de índices e delta não foram ensaiados. Não descontar
legado nem copiar todo raw para produzir esta análise. Sistema, imagens/cache,
WAL e temporários exigem margem, mas não se confundem com dados transferíveis.

Modelo conservador: C=322,302 GB; A=91,769 GB disponíveis; U=C−A=230,534 GB
(inclui reserva filesystem). Usar como cenário, não previsão, as taxas observadas
em ~10 h de coleta anteriores a esta sessão: raw 74,769 MB/h, lógico 132,754 MB/h,
físico BTC 68,914 MB/h e filesystem 90,144 MB/h. Não somá-las entre si.
Sem descarte, `A(t)=A−90.143.759,186×t` B; crescimento em 90 dias=194,711 GB.
Reserva de lançamento exige `U/D≤0,60`; fim exige `(U+r×2160)/D<0,75`.
Logo D mínimo de triagem é >566,993 GB (lançamento isolado ≥384,223 GB),
antes de picos/temporários adicionais; 160/320 GB não passam por anúncio.
O host atual já falha 40% (faltam 37,152 GB disponíveis), embora passe o piso
instantâneo. Os tetos do worker interromperiam antes: lógico ~20,23 h, raw
~28,72 h, físico ~32,56 h adicionais àquela taxa, **não 7/30/90 dias**.

Com coleta parada e crescimento zero hipotético, os 28,47% se manteriam acima de
25%, mas abaixo de 40%; logs/API/WAL podem crescer, portanto não há garantia de
90 dias parado. Para coleta sustentável sem compra, falta demonstrar redução de
crescimento/armazenamento e retenção compatível com os dados protegidos: com o
footprint atual, crescimento líquido filesystem ≤4,685 MB/h para manter piso+1GiB
por 90 dias e lógico ≤1,243 MB/h para caber em 6 GiB, além de recuperar a reserva
de lançamento e validar CPU/I/O. Isso exige trabalho e evidência próprios;
esta decisão **não** desliga HOLD, amplia caps, autoriza descarte ou rearma coleta.

### Cotação pública atual e custo total

Consulta em **27/09/2026**, Linux sob demanda, sem trial, crédito, Spot, compromisso,
backup obrigatório ou serviço gerenciado. Perfis comparativos preservam cerca de
16 GB RAM; são candidatos de preço, não capacidades aprovadas. Valores USD/mês
antes de tributos/IA/egress excedente; GCP usa 730 h/mês. Estoque/cotação autenticada
e fatura do host atual não foram fornecidos.

| Perfil / região | Compute + disco + IPv4 | Tráfego e conclusão |
| --- | --- | --- |
| Host provisionado, CPX42 informado, FSN | Fatura **desconhecida**. Lista atual de reposição: US$ 81,99 + disco local incluído + US$ 0,60 = **82,59**. Não é a mensalidade contratada. | Referência EU 20 TB; lista já excede US$ 80 antes de adicionais, sem provar extrapolação da fatura existente. Permanecer não certifica teto financeiro. |
| Hetzner CX43, NBG/HEL, 8 vCPU shared/16 GB | US$ 18,49 + 160 GB local incluídos + volume separado 600 GB × até US$ 0,050 + IPv4 0,60 = **49,09**. | 20 TB EU incluídos; excedente depende da tarifa/região autenticada. Página indicava indisponível. Volume 600 GB serve só à triagem de disco; sem ensaio/cotação final. |
| AWS Lightsail, Ohio, 4 vCPU/16 GB | Bundle **US$ 84**, 320 GB SSD e IPv4 incluídos; só ele já excede teto. Para dados em volume independente de 600 GB: +US$ 60 = **144**. | 6 TB RX+TX de franquia; excesso apenas TX, exemplo oficial Ohio US$ 0,09/GB. Sem aceite de desempenho/estoque. |
| GCP e2-standard-4, Iowa us-central1, 4 vCPU/16 GiB | US$ 0,13402284/h × 730 = 97,84; pd-balanced 600 GiB × US$ 0,10 = 60; IPv4 US$ 0,005/h × 730 = 3,65; **161,49**. | Entrada gratuita; Premium saída para América do Sul US$ 0,19/GiB no primeiro TiB. Ex.: 100 GiB = +US$ 19. Sem alegar egress real zero. |

Fontes oficiais: [Hetzner tabela vigente](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/),
[CX43/estoque público](https://www.hetzner.com/cloud/cost-optimized/),
[IPv4](https://docs.hetzner.com/cloud/servers/primary-ips/overview/),
[volumes](https://www.hetzner.com/cloud/block-storage/),
[faturamento/tráfego](https://docs.hetzner.com/cloud/billing/faq/),
[AWS bundles, disco e exemplo Ohio](https://aws.amazon.com/lightsail/pricing/),
[GCP compute](https://cloud.google.com/products/compute/pricing/general-purpose),
[disco Iowa](https://cloud.google.com/products/block-storage) e
[rede/IP](https://cloud.google.com/vpc/network-pricing?hl=en).
O HTML oficial de volumes Hetzner retornou US$ 0,0484 no texto e 0,0500 no
calculador (EUR 0,044 em ambos); usamos o maior, sem esconder a divergência nem
transformá-lo em preço contratado. Confirmar tarifa antes de qualquer reavaliação.

Custo total mensal `T = compute + disco + IP + egress + IA + impostos/taxas`.
Fatura, tributos aplicáveis e câmbio efetivo do pagamento estão **desconhecidos**;
USD nativo dispensa conversão entre linhas, não impostos. Se cobrança em EUR,
`USD=EUR×FX_EURUSD`; em BRL, `BRL=USD×FX_USDBRL + taxas`. Não fixar cotação cambial
fictícia nem alíquota zero. Jev tem zero chamadas/budgets/challenger registrados na
verificação 09.5, sem cobertura/tarifa autenticada: custo externo e contribuição
incremental desconhecidos; US$ 5 é proposta, não crédito nem despesa comprovada.

Economia exige `T_destino≤0,8×T_atual`, `T_destino≤US$80` **e gasto adicional zero**.
Só os US$ 49,09 conhecidos exigiriam atual ≥US$ 61,36 para 20%, antes dos custos
faltantes; comparar com lista de reposição não prova economia na fatura.
Coexistência não é grátis: planejar `custo_90d = 3×T_destino + C_origem(h) +
transferência + temporários`, com h=72 como hipótese, nunca autorização de corte.
Para Hetzner, 72 h do CX43 custariam US$ 2,1312, IPv4 US$ 0,072 e volume cerca de
US$ 2,96 (rateio ilustrativo 730 h), **~US$ 5,16 adicionais** enquanto a origem
continua integralmente devida. Usando os totais mensais como aproximação, AWS/GCP
somariam ~US$ 14,20/15,93 em 72 h, antes de tráfego/tributos/IA; cobrança final pode
diferir. Desligar origem não cancela cobrança; cancelamento não está autorizado.

Nenhum candidato satisfaz os gates conjuntos de provisão sem aumento, economia
comprovada, capacidade contínua e teste de destino. Resultado final: **manter o
provisionado**, sem prometer continuidade; reavaliar apenas com solução de capacidade
no orçamento já existente e custos completos. Nenhum fornecedor/recurso/API/CI
pago foi adicionado, nenhum dado removido e nenhum serviço publicado/reiniciado.

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

### Deploy seletivo e perfis Ganso 2.0

`server-update` compara os arquivos recebidos com a árvore efetivamente instalada
(última cópia de código já criada pelo comando remoto, cujo SHA deve coincidir
com `.deploy/current-sha`). O classificador calcula
candidatos e o host os cruza com os containers em execução; lista vazia não vira
`up` genérico. Mudança no worker BTC seleciona `btc-worker`; compartilhados Node
selecionam seus consumidores ativos. Texto dispensa deploy. Sem base verificável,
o fallback atualiza somente código já ativo e roda migrations, sem iniciar perfis.

PostgreSQL precisa estar em execução e nunca recebe `up`, `pull` ou recriação em
uma atualização. Mudança na sua configuração exige um plano separado. Migration
usa `run --rm --no-deps`, com bind novo; conferir versão/checksum antes de trocar
consumidores quando houver SQL novo. API/web atualizados provocam `nginx -t` e
reload para resolver o IP atual dos upstreams. ID e início do banco são conferidos.

Os cinco `polymarket-*` continuam em perfil, escala zero e `restart: no`.
G2-04.4 implementa somente o coletor público BTC, desabilitado/escala zero por
padrão. Ativação operacional e limites seguem [btc-collector.md](btc-collector.md);
configuração/overlay explícitos permitem um coletor ativo, sem estratégia/ordens.
Deploy pode atualizá-lo quando já ativo; um coletor parado não é reativado.
O overlay e os timers inibidos de G2-01.2 continuam vigentes.

G2-03.4 removeu `market-engine` e `model-worker` do Compose, código, configuração
e toolchain (base histórica `a6e3816`). Depois da atualização dos consumidores,
`server-update` localiza somente esses dois serviços pelos labels exatos de
projeto/serviço, revalida o ID, aplica `restart=no` e para os containers. O passo
é idempotente e preserva containers, imagens, volumes e dados; não usa prune nem
remoção genérica de órfãos. Serviços fora dessa lista não são aposentados.
Os contratos compartilhados e Python operacional permanecem. A readiness da API
continua dependente somente do PostgreSQL.

O gate mantém memória combinada <4 GiB, CPU ≤7 e oito conexões PostgreSQL de
reserva (máximo 40). Com todos os perfis declarados e os seis workers em escala
zero: 1792 MiB, 2,5 CPUs, orçamento de 5 conexões; a projeção de um worker BTC
completo soma 256 MiB/0,5 CPU/2 conexões, sem ativá-lo. O host valida ainda pelo
menos 512 MiB e 1 CPU de reserva sobre os limites do runtime efetivo. O smoke
usa o perfil BTC inativo, ensaia a parada dos dois stubs por labels, verifica
auth sem eles e comprova readiness 503/200 ao interromper/retomar PostgreSQL.

A seleção usa a cópia de código já existente no ciclo de deploy; não instala
comando root novo nem cria rotina de backup. Cópia ausente ou SHA divergente
aciona o fallback conservador. O lock do comando remoto impede duas publicações
simultâneas de disputarem a seleção dessa cópia.

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
acontece somente em `main`, depois dos gates source, PostgreSQL e Compose, no environment GitHub
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
