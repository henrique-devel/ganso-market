# RFC-001A — Limpeza do Ganso-bot e preservação do Yellowstone

**Status:** superseded — não executar após o rebuild informado em 2026-08-14

O rebuild substituiu a limpeza seletiva do host antigo. Os comandos destrutivos,
IDs, volumes, paths e fingerprints desta RFC são apenas registro histórico e não
devem ser aplicados ao servidor novo.

**Emenda de escopo:** o proprietário autorizou somente incluir o volume literal
`d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4`
como exceção estrita à exigência de label Compose. Esta emenda não autoriza
remover esse volume nem qualquer outro alvo; todos os gates e uma aprovação
destrutiva posterior continuam obrigatórios.

**Dependências:** RFC-001

**Bloqueia:** RFC-002 e a publicação da aplicação no CPX42; permite somente o
checkout de staging, helpers e probes desta própria RFC

## Prompt a executar

Você deve executar a RFC-001A do Ganso Market: liberar o Hetzner CPX42 atual,
removendo logicamente todo artefato exclusivo do Ganso-bot sem backup, mas sem
perder o acesso ao contrato Yellowstone/Geyser nem a capacidade de recuperar a
hot wallet.

### Objetivo

Ao final, o mesmo host continua acessível por SSH e pronto para receber o Ganso
Market, mas não contém código referenciado/executável, container, imagem própria,
volume, banco, proxy, configuração, secret, job ou processo do Ganso-bot.

"Nada do Ganso-bot" significa remoção lógica dos artefatos controláveis. Não é
possível prometer apagamento forense de blocos de SSD, journal global do sistema,
camadas já desalocadas ou cache BuildKit não atribuível sem
destruir/reprovisionar a VM. Não apague logs globais, histórico SSH, sistema
operacional, builder global ou recursos compartilhados para simular essa
garantia.

### Contexto obrigatório

- Leia integralmente `docs/PRD.md`,
  `prompts/AI_DEVELOPER_SYSTEM_PROMPT.md`,
  `docs/ops/SERVER_ACCESS.md` e
  `docs/runbooks/server-cleanup-ganso-bot.md`.
- O servidor é `178.105.65.251`; o usuário histórico é `ganso` e
  `claude-ganso-bot` é o nome provável da chave pública cliente cadastrada na
  Hetzner, não um alias SSH confirmado.
- O caminho histórico do projeto antigo é `/home/ganso/ganso-bot`.
- O novo deploy usará `/home/ganso/ganso-market`.
- O endereço público esperado da wallet é
  `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`.
- O acesso HTTP ainda não deve ser publicado. Isso pertence à RFC-002.
- Não existe autorização para reinstalar o host, excluir a VM Hetzner, apagar
  `/home/ganso`, trocar a host key ou cancelar contrato externo.

### Evidência histórica que precisa ser revalidada

O repositório local do Ganso-bot registra, no congelamento de 2026-08-10:

- todos os containers estavam parados;
- existiam zero posições abertas naquele momento;
- somente TCP/22 estava público;
- o projeto Compose era `ganso`;
- o volume `ganso_pgdata` guardava aproximadamente 43 GB sem backup;
- os volumes Docker somavam aproximadamente 46,74 GB;
- o override efetivo de RPC/Geyser podia estar em `data/credentials.json`;
- após a migração multiusuário, a wallet ativa podia estar cifrada na tabela
  `user_wallets` de `ganso_pgdata`, e os arquivos `data/keypair.enc` e
  `secrets/keypair.enc` podiam ser apenas legado órfão;
- `KEY_PASSPHRASE` estava no `.env` antigo e era usada para abrir as wallets
  cifradas no PostgreSQL;
- Geyser e o pool RPC constavam como placeholders naquele congelamento; uma
  credencial RPC diferente era o único provedor externo real registrado.

Esses dados são evidência histórica local, não leitura atual do servidor. Em
especial, não assuma que o token Yellowstone está na VM. O contrato pode existir
somente no portal do fornecedor. Se o portal e uma conexão nova não puderem ser
validados, pare antes de apagar.

### Allowlist do que deve permanecer

Preserve somente:

1. o host Hetzner, IPv4, acesso SSH, host key, firewall e sistema operacional;
2. Docker e ferramentas-base necessárias ao Ganso Market;
3. `/home/ganso/ganso-market` e a configuração exclusiva do novo projeto;
4. acesso independente ao portal/conta/assinatura Yellowstone;
5. credencial ativa criada ou rotacionada para o Ganso Market;
6. endpoint RPC necessário ao novo projeto, em secret file próprio;
7. chave pública da hot wallet;
8. recuperação da wallet mantida fora do servidor e verificada pelo
   proprietário.

Não preserve banco, histórico, logs, código ou configuração do bot antigo por
serem "talvez úteis".

### Manifesto do que deve ser destruído

Depois de cada alvo ser identificado literalmente e confirmado como exclusivo:

- `/home/ganso/ganso-bot`, incluindo `.env`, `data/`, `secrets/`, `config/`,
  overrides e backups internos;
- containers do projeto Compose `ganso`;
- imagens construídas especificamente para `ganso-bot` e `ganso-dashboard`;
- network exclusiva `ganso_default`, se ainda existir;
- volumes exclusivos esperados `ganso_pgdata`, `ganso_caddydata` e
  `ganso_caddyconfig`;
- somente como exceção literal, o volume sem label Compose
  `d92737f70a4518d54a5d62dfecc8c51ca4477f8c7d6b0988c9caf004b130fbb4`,
  desde que o manifesto registre `0 B` observado no inventário, driver/scope
  `local`, owner Docker, `shared=false` e o único consumidor inventariado como
  o container parado `ganso-redis-1`, ID
  `4a96a1147ffb165e8c29f11702734204c026276c5269e62f64f2da42909df053`,
  projeto Compose `ganso`, mount do tipo `volume` em `/data` com escrita;
- proxy Caddy e observabilidade exclusivos do projeto antigo;
- units, timers e crons exclusivos, caso o inventário encontre algum;
- acesso de deploy automático do repositório antigo, sem revogar a chave SSH
  humana/compartilhada;
- token Yellowstone antigo depois de o token do Ganso Market passar no probe e
  de o portal confirmar que o token antigo não possui outro consumidor.

A exceção acima não se aplica a outro ID, tamanho observado, driver/scope,
consumidor, mount, owner, label Compose ou estado. `0 B` é apenas metadado do
inventário, não prova de exclusividade nem autorização. O vínculo com o Redis é
evidência pré-destrutiva esperada; após a remoção aprovada dos containers e
imediatamente antes de remover o volume, a lista de consumidores deve ser
revalidada como vazia. Qualquer divergência causa parada e exige nova decisão do
proprietário.

### Proibições

- Não criar snapshot Hetzner, `pg_dump`, tar, cópia de volume, clone do diretório
  antigo ou backup externo.
- Não copiar o `.env` antigo inteiro.
- Não copiar banco, corpus, logs, configs de estratégia ou credenciais de login.
- Não imprimir endpoint privado, token, seed, private key, passphrase ou conteúdo
  de keystore.
- Não colocar segredo em Git, banco, argumento de processo ou variável de
  ambiente persistente.
- Não executar `docker system prune`, `docker volume prune`, `rm -rf` em `/`,
  `/home`, `/home/ganso`, `/srv`, glob ou variável de shell.
- Não usar `docker compose down -v` antes de registrar e confirmar os volumes
  literais.
- Não apagar `.ssh`, firewall, rede, conta Linux ou imagens genéricas
  compartilhadas.
- Não iniciar o Ganso-bot em modo live para testar credenciais.
- Não cancelar a assinatura Yellowstone no portal.
- Não publicar TCP/80 ou TCP/443 em IPv4 ou IPv6 nesta RFC.

### Gate 1 — identidade e inventário somente leitura

1. Validar fingerprint, usuário, IP, hostname e diretório conforme o runbook.
2. Inventariar containers, imagens, cache atribuível, networks, volumes, mounts,
   Docker configs/secrets, restart policies, processos, portas, crons, timers,
   units, authorized keys e automações.
3. Para cada alvo, registrar caminho/ID literal, proprietário e se é
   compartilhado.
   Para volumes, registrar também os consumidores literais observados neste
   inventário; não exigir que containers ainda não aprovados para remoção já
   tenham desaparecido.
4. Confirmar que o Ganso-bot continua parado e não possui mecanismo de restart
   externo.
5. Desabilitar o workflow de deploy antigo e revogar somente credenciais
   exclusivas dele.

Qualquer alvo compartilhado fica fora da remoção até ser separado.

### Gate 2 — wallet

O proprietário deve, em dispositivo confiável e fora do servidor:

1. confirmar que controla a recuperação da wallet;
2. derivar/exibir o endereço e obter correspondência exata com
   `8qE2V1zbcui9RnNsKajVrJ1zS34bMFkumWA9h95Bx8AV`;
3. assinar e verificar um desafio offline sem transmitir seed/private key;
4. reconciliar saldo, tokens, transações pendentes e posições;
5. confirmar zero ordens/posições que dependam do processo antigo.

Se o único material recuperável ainda estiver na tabela `user_wallets` de
`ganso_pgdata`, em `data/keypair.enc` ou em `secrets/keypair.enc`, pare. Nesta
sequência a recuperação offline fora do CPX42 é pré-requisito absoluto; não há
fallback de exportação definido nesta RFC. Qualquer exceção exige uma nova
decisão e uma emenda anterior à limpeza. Não copie a passphrase do `.env` antigo
para a configuração do novo signer.

### Gate 3 — contrato Yellowstone e RPC

1. Entrar no portal do fornecedor por acesso independente da VM.
2. Confirmar conta, assinatura ativa, cobrança, endpoint, limites e eventual
   allowlist de IP.
3. Preferir criar/rotacionar uma credencial chamada `ganso-market`.
4. Gravar somente endpoint, token e RPC necessários em secret files `0600`, fora
   do Git e fora do diretório antigo.
5. Implementar um probe mínimo que:
   - leia os secrets por arquivo;
   - estabeleça gRPC com o mecanismo oficial do fornecedor;
   - receba pelo menos três atualizações de slot dentro do timeout definido;
   - não persista payload;
   - não imprima endpoint ou token.
6. Implementar probe RPC que confirme cluster/slot sem expor a URL.
7. Revogar a credencial antiga somente depois de ambos os probes passarem e de
   o portal confirmar que ela é exclusiva do Ganso-bot. Credencial compartilhada
   deve ser rotacionada de forma coordenada ou permanecer ativa como risco
   residual registrado.

Se o provedor não permitir uma segunda credencial, migre apenas os três valores
efetivos pelo helper redigido do runbook, valide-os e mantenha o bot parado. A
rotação fica como ação imediatamente posterior.

### Gate irreversível

A IA não deve executar a exclusão automaticamente. Ela deve apresentar ao
proprietário:

- host/IP confirmados;
- diretório antigo literal;
- nomes/IDs literais de containers, imagens, networks e volumes;
- `PASS` do controle/recovery da wallet;
- `PASS` do probe Yellowstone;
- `PASS` do probe RPC;
- confirmação de zero posição/ordem pendente;
- confirmação de que o deploy antigo foi desabilitado;
- confirmação de que `/home/ganso/ganso-market` e seus secrets ficam fora dos
  alvos.

Se a exceção de volume constar do pacote, ele também deve mostrar o ID completo,
`0 B` observado, driver/scope, owner, `shared=false`, o consumidor/mount
literais acima e a regra de revalidar zero consumidores antes do
`docker volume rm` literal.

Somente a confirmação explícita do proprietário autoriza seguir os comandos da
seção destrutiva do runbook. A autorização não amplia os alvos.

### Tarefas de implementação

1. Criar inventário redigido e classificar cada alvo.
2. Criar helper de inspeção/migração que reconheça a precedência histórica de
   `data/credentials.json` sobre `.env` e escreva somente:
   - `yellowstone_endpoint`;
   - `yellowstone_token`;
   - `solana_rpc_endpoints.json`.
3. O helper deve falhar em placeholder, vazio, permissão insegura, destino já
   existente, schema inesperado ou fonte efetiva não reconhecida. Antes do
   fallback, inventarie de forma redigida nomes de env, mounts, Docker
   config/secret e eventual `EnvironmentFile`; nunca imprima valores.
4. Criar probes Yellowstone e RPC sem persistência de dados.
5. Executar todos os gates.
6. Após aprovação manual, remover alvos literais na ordem do runbook.
7. Verificar que nenhum artefato lógico do Ganso-bot permanece e que os probes
   continuam passando.
8. Registrar evidência redigida em `docs/test-results/RFC-001A.md`.

### Testes obrigatórios

- Helper nunca imprime valores e rejeita placeholders.
- Override JSON ganha de `.env` quando válido.
- Destino existente não é sobrescrito.
- Secret files ficam `0600` em diretório `0700`.
- Probe rejeita token inválido e passa com a credencial nova.
- Slots Yellowstone avançam; RPC confirma o cluster esperado.
- Fingerprint ou host divergente causa parada.
- Wallet divergente ou não recuperável causa parada.
- Presença da wallet-alvo somente em `user_wallets`/volume antigo causa parada.
- Alvo compartilhado causa parada.
- Manifesto rejeita caminho pai, glob, symlink ou volume sem label Compose
  diferente da única exceção literal desta emenda.
- Manifesto rejeita a exceção se ID, tamanho observado, driver/scope, owner,
  exclusividade, consumidor, projeto Compose, mount ou modo de escrita divergir.
- Aprovação da emenda, por si só, não satisfaz o gate de aprovação destrutiva.
- Depois da remoção não existem containers, imagens próprias, network, volumes,
  repo, proxy, jobs ou listeners do Ganso-bot.
- TCP/80 e TCP/443 continuam sem listener em IPv4 ou IPv6 ao fim desta RFC.
- O Ganso Market permanece em `paper` e `disarmed`.

### Critérios de aceite

- Contrato Yellowstone permanece ativo no portal.
- Credencial do Ganso Market recebe slots no CPX42.
- RPC do novo projeto responde sem expor segredo.
- Recuperação offline da wallet foi comprovada e sua pubkey coincide.
- `ganso_pgdata`, os demais volumes rotulados exclusivos e, somente depois da
  aprovação destrutiva, o volume excepcional literal foram removidos sem
  backup.
- `/home/ganso/ganso-bot` não existe.
- Nenhuma restart policy, unit, timer, cron, webhook ou deploy externo consegue
  recriar o serviço antigo.
- SSH, firewall, IPv4, Docker e diretório do Ganso Market permanecem.
- Não há listener de aplicação externo antes da RFC-002.
- Evidência contém somente metadados redigidos.

### Condições de parada

Pare imediatamente se:

- fingerprint, IP, usuário, diretório, volume ou ID estiver ambíguo;
- o portal/assinatura Yellowstone não puder ser acessado;
- o token novo não receber slots;
- o único token válido estiver apenas em arquivo prestes a ser apagado;
- a wallet não puder ser recuperada fora do host;
- pubkey, saldo, posições ou transações não reconciliarem;
- existir symlink/mount inesperado ou recurso compartilhado;
- o volume excepcional não estiver em `0 B` no inventário, possuir label
  Compose, owner/consumer/mount diferente do registrado, mais de um consumidor
  ou ainda possuir qualquer consumidor imediatamente antes da remoção;
- o Ganso Market depender de qualquer alvo marcado para destruição;
- a exclusão exigir glob, variável não resolvida ou diretório pai;
- houver pedido para apagar a VM, `/home/ganso`, `.ssh` ou logs globais;
- o proprietário ainda não tiver aprovado os alvos literais.
