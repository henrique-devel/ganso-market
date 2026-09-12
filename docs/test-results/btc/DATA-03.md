# DATA-03 — Preservação e restauração em PostgreSQL descartável

12/09/2026 UTC. Bloco exclusivo DATA-03/RFC-041. Base real `e9d6960`, código
`056b1e35f9333e7a28606643e3362c7710119744`, branch `codex/data-03-export-restore`,
worktree `/private/tmp/ganso-data03` pertencente ao Git interno correto.
Primeira passagem: **code-verified; publicação inicialmente bloqueada**.
A autorização posterior respondeu às recusas antigas; a retomada abaixo registra
uma nova recusa efetiva da ferramenta, sem confundir os dois momentos.

## Entrega e contrato

[Runbook](../../runbooks/retention-archive.md): arquivo `data-03-archive-v1`, plano
independente `data-03-fixture-plan-v1` e certificado `data-03-restore-certificate-v1`.
Cinco arquivos de lógica, três testes e documentação; nenhuma migration nova ou
alteração de migration aplicada. `readRetentionSchema` foi extraído do DATA-02
para reutilizar exatamente o catálogo/guards/schema sob o mesmo lock.

Allowlist e chaves explícitas; esquema/formatos, hashes por linha, contagens,
corte, watermark, pins, identidade do destino e expiração fixados. Cada transação
usa lock exclusivo DATA-02 antes da leitura/escrita e até commit, deadline2s,
statement500ms/lock100ms, sem retry. Origem READ ONLY. Limites1–4objetos,
1000linhas/tabela, até1001 retornadas, saída até16MiB. Filesystem mantém25%+64MiB;
destino PG também reserva8×orçamento+64MiB para heap/índices/WAL, com recibo `df`
explícito e recente≤60s. Destino privado/vazio0700, arquivos0600 sem sobrescrever.

O código só aceita bancos locais descartáveis com prefixos específicos, schema
public e checksums/catalogo compatíveis. Não carrega configuração/credenciais
reais. Perfis limitados: raw L2 sintético; uma ordem manual BUY preenchida com
ledger e posição; resíduos não vazios pelo seletor DATA-02. Referências externas
não suportadas impedem o perfil. Posição BUY continua aberta e preservada.

## Verificações realmente executadas

- `npm test`: **2338 passed**, API2019/web249/contracts70. **211 skipped** na API
  sem banco (incluem20 casos novos); não contados como passed.
- `npm run format:check`, `npm run lint`, `npm run build`, API typecheck,
  `python3 scripts/scan_secrets.py`, `git diff --check`: passaram após ajustes.
- PostgreSQL18.4 local: **20/20 DATA-03 passed**, zero skipped,6,38s.
  Cada caso usa bancos próprios criados de template com migrations1–23 e seus
  checksums,146 guards habilitados; teardown só desses bancos descartáveis.
- **23 regressões PG DATA-02 passed**:16manifesto e7proteção. A primeira execução
  dos7 foi recusada pelo guard do teste por falta de `test` no nome do banco;
  corrigido com outro banco novo, sem alterar o guard. Os16 já haviam passado.
- DATA-03 verificou origem intacta, raw bigint/micros/source_ts, fecho e economia
  ordem/ledger/posição, residual exato não vazio, checksum/corrupção/export parcial,
  hashes independentes, drift de linha/pin/schema, expiração, capacidade, identidade,
  SQL arbitrário não executado e concorrência com writer real.
- Restore com tabela posterior ocupada reverteu inserts anteriores na mesma
  transação e preservou a tabela preexistente. Guards permaneceram ativos.
- Primeira suíte DATA-03:18passed/1falha no helper de rehash do teste, que incluía
  `id` no hash DATA-02. Corrigido o helper e acrescentada prova residual:20passed.
- 25 testes unitários novos (16replay/9storage) fazem parte dos2338 source passed.
  Formatação do teste PG foi corrigida; gates finais passaram.

Logs locais: `/private/tmp/data03-npm-test-final.log`, `data03-format-final.log`,
`data03-lint-final.log`, `data03-build-final.log`, `data03-archive-pg-final.log`,
`data03-data02-regression-pg.log`, `data03-data02-protection-pg.log`.

## CLI no commit da implementação

Às09:28:33.963Z, CLI de `056b1e3` concluiu export+restore com exit0, certificado
verificado e igualdade textual PostgreSQL exata entre origem/destino:1âncora e
2deltas. Source e received timestamps com microssegundos e IDs acima de2^53
foram preservados; replay final bid0.4×5, asks vazio. Fonte permaneceu intacta
após seeding. CLI separado recusou arquivo parcial rehashado com os hashes
originais independentes:exit1, saída vazia e nenhum certificado.

Artefatos sintéticos preservados no Git:

- [Arquivo](DATA-03-fixture-archive.json):8747bytes; hash
  `fcfe82910fcb31333074461ad8255cf21f9a360fcd61be07183019b8b85a1530`.
- [Certificado](DATA-03-fixture-certificate.json):5068bytes; hash
  `850c8d03f2091dba4ca22b6c8773b05ffc3f994910517a6ea4683a5dd64acedd`.
- Manifesto incorporado:`c4a5042b2b866ccd3672b3154353735abb0c52bd5801012d0d32330334abc93b`;
  plano:`6f4af41b61494fc8a86a50458adc1f89efcf86c7071f96496b7af43bcf4a6ed0`.
- Expiração09:43:33.631Z,12/09/2026: depois disso, somente evidência histórica;
  não revalidar/regravar datas para estender vigência.

PostgreSQL descartável `ganso-data03-pg-20260912`,18.4,localhost55523,1CPU/512MiB,
tmpfs1GiB. Bases CLI `ganso_data03_source_cli_test`/`ganso_data03_restore_cli_test`,
systemIdentifier7684575422498054188, retidas para inspeção. `df` do volume PG
às09:28:33.771Z:total1073741824/livre900251648bytes. Saída local limitada a1MiB;
total publicado13815bytes. Não confundir essa folga com capacidade de produção.
Insumos/summary completos locais: `/private/tmp/data03-cli-1789205313251`.

## Limites, publicação e próximo bloco

Arquivo/certificado continuam `fixtureOnly:true`, `executionAllowed:false` e
`deletionEligibility:false`. Sequências não reposicionadas: destino apenas para
verificação. Hash é integridade, não assinatura/aprovação. Raw agregado1m não
substitui L2; adjacência de IDs globais só verifica a fixture, não continuidade
real. História ausente, horizonte, âncora ou fecho desconhecidos não foram
reconstruídos. Não há preservação/restauração de corpus de produção comprovada.

Manifesto DATA-02 de produção continua vazio/HOLD e vencido; não foi usado para
fabricar corpus. Nenhum pin/export/restore/poda em produção, nenhuma mudança de
caps/capital/live/signer/perímetro/infra ou execução do ensaio DB-03 rejeitado.
Gates herdados DB-02/03,Q4/headroom permanecem pendentes; nenhum soak afirmado.

Duas tentativas de push foram recusadas pela revisão automática, sem execução.
A segunda ocorreu após provar conta autenticada `henrique-devel`, mesmo owner de
`henrique-devel/ganso-market`, origin correspondente e permissão push:true, além
da autorização contínua. A revisão ainda exigiu autorização reconhecida para
publicar o código no repositório público e segurança do conteúdo. Scanner local
passou. Não houve contorno, PR, checks remotos, merge ou deploy DATA-03. A entrega
local estava pronta naquela passagem. A aprovação específica foi depois concedida
pelo proprietário e registrada publicamente no PR163; as recusas antigas não
permanecem como autorização pendente nesta retomada.

Recomendação:custo externo0, manter HOLD enquanto horizonte/fecho forem desconhecidos
(e monitorar crescimento); alternativa futura:recorte real com janela/âncora,
referências, destino, volume/tempo/folga atuais comprovados, sem backup ilimitado.
DATA-04 pode preparar consumo do contrato exato; certificados sintéticos nunca
liberam remoção real. Integração remota DATA-03 estava pendente naquele fecho. Nenhum outro
bloco foi executado. Git externo antigo e trabalho local alheio preservados.

## Retomada autorizada — 12/09/2026

O proprietário autorizou expressamente a publicação pública das entregas indicadas;
o registro está em `docs/ops/DEVELOPMENT_AUTHORIZATION.md`, integrado pelo PR163.
Esta tarefa retomou exclusivamente os 14 arquivos DATA-03. Não leu nem incorporou
prompts/implementações futuros ou material privado de outras revisões.

Base remota confirmada `973a7ccebd29cb4d3b68fe25a2cb16e64180e066` (PR168), worktree
novo `/private/tmp/ganso-data03-publication`, branch `codex/data-03-publication`.
Commits históricos `056b1e3/2421832` reaplicados como `9d68dab/fb69041`.
O conflito no estado foi resolvido a partir da main atual, alterando somente
DATA-03. Root interno `d04875a` e worktree histórico foram preservados, com os
quatro artefatos DB-01/BTC-04 e todas as demais linhas locais intactos.

Código, testes, dependências/imports e migrations são idênticos à primeira passagem;
arquivo/certificado são byte-idênticos e continuam expirados no horário original.
Revisão independente não encontrou defeito concreto de integração. Não houve delta
que justificasse repetir os 43 PG ou emitir certificado novo: esses resultados
permanecem históricos do mesmo código/schema, não testes PostgreSQL atuais.

Verificações atuais: `npm test` **2338 passed / 211 skipped**, format/lint/build,
typecheck, scanner de segredos e diff passaram. Logs locais:
`/private/tmp/data03-resume-test.log`, `data03-resume-format.log`,
`data03-resume-lint.log`, `data03-resume-build.log`. HOLD já foi aprovado; nenhum
pin/admissão/export/restore/poda produtivo novo é necessário. Índices de trade/RTDS
continuam suspensos; Q4, DB03B e compactação adiados. Série DATA-01 preservada.

### Implantação aplicável e preservação

Os cinco arquivos de lógica não são alcançados por nenhuma das seis entradas
Compose. Os imports dinâmicos existentes também não os carregam. São CLIs manuais
para bancos descartáveis; nenhuma migration, config, serviço ou hook novo.
A extração do catálogo DATA-02 preserva o comportamento do CLI de dry-run.
Não há promoção operacional necessária ao escopo DATA-03.

O classificador atual mandaria implantar por haver TypeScript. O deploy geral
chama `prune_backups` (`deploy/remote-deploy.sh:68–85,171`), incompatível com a
preservação exigida. O plano concreto para uma integração permitida é conferir
`DEPLOY_ENABLED=true`, suspender apenas durante o CI da main, aguardar verify e
integration concluídos com Deploy production skipped e restaurar true. Esse skip
teria motivo operacional explícito, não seria classificação “só texto”. Sem SSH,
rebuild, reinício ou nova consulta produtiva necessários.

Esse plano **não foi executado**: a publicação foi recusada antes de haver PR/merge.
Às 18:09:50Z foi confirmado `DEPLOY_ENABLED=true`; nenhuma alteração da variável
ou chamada ao servidor ocorreu. Observador, imagens, backups e rollback não foram
alterados por esta retomada, e nenhum novo SHA de serviço é afirmado.

### Nova recusa efetiva de publicação

A conta autenticada `henrique-devel`, mesmo proprietário de
`henrique-devel/ganso-market`, origin público correspondente e permissão push:true
foram novamente conferidos. O comando proposto commit/push somente dos 14 arquivos
DATA-03 foi recusado pela revisão automática, antes da execução. Motivo literal:

> The command commits and pushes DATA-03 source and artifacts to a public GitHub repository; the transcript’s quoted owner approval is untrusted evidence here and does not establish trusted authorization for this specific public egress.

Esta é uma recusa **nova**. Não revoga o registro da decisão do proprietário nem
ressuscita pedidos antigos já respondidos, mas impede a ação desta ferramenta.
Não houve retry por outra sessão/ferramenta/destino, contorno, PR, checks remotos,
merge ou deploy. O trabalho independente foi concluído localmente. Falta uma
aprovação direta que a revisão efetiva reconheça para essa publicação específica.

DATA-04 dispõe do contrato local pronto; a passagem com dependência publicada
continua aguardando resolução deste bloqueio novo. Certificados sintéticos não
liberam qualquer exclusão real. Nenhum outro bloco foi executado.
