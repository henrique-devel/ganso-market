# DATA-03 — Preservação e restauração em PostgreSQL descartável

12/09/2026 UTC. Bloco exclusivo DATA-03/RFC-041. Base real `e9d6960`, código
`056b1e35f9333e7a28606643e3362c7710119744`, branch `codex/data-03-export-restore`,
worktree `/private/tmp/ganso-data03` pertencente ao Git interno correto.
Estado: **code-verified; publicação externa bloqueada pela revisão automática**.

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
local está pronta; falta aprovação reconhecida da publicação pública específica.

Recomendação:custo externo0, manter HOLD enquanto horizonte/fecho forem desconhecidos
(e monitorar crescimento); alternativa futura:recorte real com janela/âncora,
referências, destino, volume/tempo/folga atuais comprovados, sem backup ilimitado.
DATA-04 pode preparar consumo do contrato exato; certificados sintéticos nunca
liberam remoção real. Integração remota DATA-03 permanece pendente. Nenhum outro
bloco foi executado. Git externo antigo e trabalho local alheio preservados.
