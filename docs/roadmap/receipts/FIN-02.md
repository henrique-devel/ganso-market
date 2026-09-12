Bloco: FIN-02 | RFC: RFC-038 | Data UTC: 2026-09-12
Estado: implemented; atribuição v1 entregue, contabilidade financial-v2 não antecipada.
Base: 9632031b005445f42d90628bea153368eb34bd1c; código: 3e05396d675b82072d90023d2e235449aec61500.
Publicação: [PR #172](https://github.com/henrique-devel/ganso-market/pull/172), merge 4787b171e5e4f77cfd24a05c98f2c3151379b840.
Checks públicos: Verify source + Verify Compose runtime passaram no PR e main; job Deploy production passou.
Migration: 0024_paper_financial_ownership.sql; DDL aditivo, sem reescrita de migrations aplicadas.
Contrato: quatro tabelas; triggers ordem/evento/atribuição atômicos; donos imutáveis e resolução global por dono.
Leitura exportada: ownership.ts, loadAttributedLedgerEvents/loadOpenOwnerTokens, ownership versão 1.
Legado: fallback unknown explícito; nenhum backfill em massa ou novo consumidor financeiro no código.
Decisão: identidade verificada não comprova capital; NULL impede presumir verba disponível.
Testes: 163 passed, zero skipped nos três arquivos focados; 16 casos PostgreSQL real via GANSO_TEST_DATABASE_URL.
Cobertura: F4/fee única, conflito/retry, concorrência, rollback, net-zero real, multirow, legado, guards e inválidos.
Gates locais: make verify passou; TypeScript, Prettier, diff e secret scan passaram; PG alheio skipped é separado.
Operação: verificação executada; resultado detalhado e limites entregues ao coordenador em artefato local.
Publicação de detalhes operacionais no PR: recusada pela revisão automática; versão pública final reduzida.
Escopo preservado: sem nova equity/exposição/reserva, alocação de capital ou ativação fast/live/signer.
Evidência pública: [contrato e testes](../evidence/FIN-02-ledger-ownership.md).
Evidência operacional local: FIN-02-production-evidence.md, entregue com o fecho ao coordenador.
Worktree: /private/tmp/ganso-fin02; branches codex/fin-02-ledger-ownership e codex/fin-02-receipt.
Próximo elegível: FIN-03; menor lista de leitura na evidência; nenhum prompt posterior/QA executado.
