# FIN-02 — atribuição persistente do ledger

Base: `9632031b005445f42d90628bea153368eb34bd1c` (FIN-01 integrado).
Worktree: `/private/tmp/ganso-fin02`; branch `codex/fin-02-ledger-ownership`.
Escopo: RFC-038, Contrato financeiro/Persistência. Somente FIN-02; nenhum
prompt posterior ou QA foi lido/executado. Custo externo adicional zero.

## Contrato entregue

A migration aditiva `0024_paper_financial_ownership.sql` cria as quatro tabelas
propostas em FIN-01: `paper_financial_owners`, `paper_order_owners`,
`paper_ledger_owners` e `paper_owner_positions`. As três primeiras são evidência
append-only; o cache com decimais de nove casas permanece vazio e sem consumidor.
As quatro compartilham os locks de escrita/HOLD DATA-02. Nenhuma migration
aplicada, evento histórico, capital, cap, modo paper ou signer é alterado.

Triggers de INSERT congelam ordem/dono e evento/associação na mesma transação,
inclusive quando `appendLedgerEvent` recebe pool sem transação explícita. Os
campos de identidade econômica da ordem ficam imutáveis; status, fila e geração
de resolução mantêm as atualizações do broker. Locks seguem ordem → token →
chave idempotente; conflitos monetários de conteúdo, timestamp ou identidade
falham, e retry idêntico retorna `false` sem tocar cache ou associação.
Marcas por minuto conservam a semântica diagnóstica de primeira escrita.

O produtor vigente cria somente ordens manual/intent/portfolio: a partir da
migration, essas fontes pertencem à conta `paper`, estratégia `main`. A fonte
fast já admitida pelo schema congela seu `strategy_id` na mesma conta; o nome
`main` fica reservado. Não há worker fast novo nem ativação da estratégia.
A evidência registra essa regra prospectiva e a ordem; não infere a titularidade
de ordens anteriores a partir de `strategy_id IS NULL`.

Refinamento conservador da proposta FIN-01: **identidade verificada não comprova
capital inicial**. Por isso `initial_cash_usd` aceita NULL também para dono
prospectivo verificado, com `capital_source_ref=unestablished:FIN-02`. Não há
seed de US$1.000/100, partição ou redistribuição. Equity absoluta/admissão futuras
precisam estabelecer origem de capital antes de usar esse campo.

Histórico sem associação lê explicitamente `legacy_unattributed/unknown`; a
migration não faz backfill em massa. Uma ordem antiga que recebe novo evento
adquire associação desconhecida, sem modificar a ordem. Rejeição de uma ordem
que nunca foi inserida também é desconhecida. Kill switch global não recebe dono
monetário. Evidências e supersessões são versionadas; as leituras entregues
selecionam somente ownership versão 1, nunca agregam versões distintas.

Resolução continua sendo **um evento global**, associado a cada dono com saldo
aberto no instante econômico, inclusive long/short cujo saldo agregado é zero.
O broker descobre esses donos pelo ledger atribuído, sem depender do cache v1
por token. Payout é aplicado pelos leitores existentes como antes; nenhuma nova
equity, exposição ou reserva foi implementada. Fee embutida no fill tem uma única
associação; fee comum de resolução com múltiplos donos é recusada sem repartição
comprovada. Associação global arbitrária ou condition divergente é recusada.

Um fill atrasado cujo dono já consta na resolução pode ser persistido normalmente.
Se a chegada revelaria um dono ausente de resolução posterior já gravada, a
transação falha com `FIN02_LATE_OWNER_REQUIRES_ATTRIBUTION`: exige evidência e nova
atribuição auditada, sem reescrever evento nem deixar exposição silenciosamente
aberta. Não há API de correção histórica automática neste bloco.

## Interface para FIN-03

- `ownership.ts`: `OWNERSHIP_VERSION`, `LEGACY_OWNER`, `FinancialOwner`,
  `AttributedLedgerEvent`, `loadAttributedLedgerEvents(pool, filter)` e
  `loadOpenOwnerTokens(pool, tokenId?)`.
- A leitura contém `eventId`, timestamps econômico/recebido, token/condition,
  payload original e dono/status/evidência; filtros conta/estratégia/token.
- `paper_attributed_ledger_v1` seleciona ownership v1 com fallback desconhecido.
  `paper_open_owner_tokens` calcula somente pertencimento por quantidade exata,
  com cutoff econômico para a associação de eventos globais.
- Payloads e replay continuam `ledger-v1`; ownership v1 não é o fold financial-v2.
  Em particular, marca antiga é valor global do token e **não** marca individual
  reutilizável para cada dono. FIN-03 deve conservar essa distinção.

Menor leitura seguinte: este contrato, `ownership.ts`, `ledger.ts`, a migration
0024 e `ownership.pg.test.ts`; em `brokerstore.ts`, somente `settlementTick` e os
símbolos de projeção que o próprio bloco FIN-03 exigir. Oráculos econômicos:
FIN-01 §4, sem consultar prompt posterior nesta sessão.

## Verificação

Testes finais em 12/09/2026 21:58 UTC: 163 passaram, três arquivos, zero skipped,
incluindo 16 casos PostgreSQL reais e 147 testes ledger/broker. Foram cobertos F4,
fee embutida única, retry, corrida entre dois clientes, rollback de ordem/evento,
resolução real net-zero, INSERT multirow, titularidade/condition inválidas, chegada
tardia, 17 payloads monetários inválidos, bytes históricos e guards ativos.
Comando: `GANSO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55524/fin02_test npm test --workspace @ganso-market/api -- test/polymarket/paper/ownership.pg.test.ts test/polymarket/paper/ledger.test.ts test/polymarket/paper/brokerstore.test.ts --no-file-parallelism`.

`make verify VENV=/Users/kovi/Desktop/henrique/ganso-market/ganso-market/.venv`
passou localmente (Node 26.4/npm11.17/Python3.9). A primeira tentativa parou em
bind local bloqueado pelo sandbox; a repetição autorizada passou. Typecheck,
formatação focada, `git diff --check` e `scripts/scan_secrets.py` passaram após
a última edição. Suítes PG de outros blocos ficam skipped no gate sem URL;
não foram convertidas em passed nem usadas como prova desta entrega.
Checksum SQL testado: `773fdce27553a50c7ea85e573817d8dfec00a33ca4d921836a43090b29a9b199`.
Revisão independente conferiu produtores, locks, resolução, legado e payloads.
Publicação: [PR #172](https://github.com/henrique-devel/ganso-market/pull/172),
código `3e05396d675b82072d90023d2e235449aec61500`, merge normal
`4787b171e5e4f77cfd24a05c98f2c3151379b840` em 22:04:58 UTC, sem bypass.
[CI do PR](https://github.com/henrique-devel/ganso-market/actions/runs/34721519934):
Verify source e Verify Compose runtime passaram.
[CI/CD de main](https://github.com/henrique-devel/ganso-market/actions/runs/34721746299):
source, Compose e o job Deploy production passaram.
A suíte nova usa PostgreSQL real exclusivamente por `GANSO_TEST_DATABASE_URL`,
schema próprio com todas as migrations e fixtures históricas inseridas antes da
0024. Não desabilita guards nem apaga linhas; o container descartável é exclusivo.

A verificação operacional do escopo foi executada. O relatório detalhado foi
entregue ao coordenador como artefato local, separado deste contrato público.
A publicação final do recibo contém referências de código/checks e não exporta
o inventário operacional. Isso não amplia o aceite financeiro dos blocos seguintes.
FIN-03 está elegível para consumir a atribuição; sua implementação não foi antecipada.

Contexto ampliado somente para os produtores, guards DATA-02, harness PostgreSQL,
parser decimal e runbooks/CI indispensáveis à atomicidade e entrega. São cinco
arquivos TS (incluindo testes) e uma migration; sem refatoração do broker.
