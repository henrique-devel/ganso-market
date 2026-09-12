Bloco: FIN-02 | RFC: RFC-038 | Data UTC: 2026-09-12
Estado: implemented; atribuição v1 implantada, contabilidade financial-v2 ainda não ativada.
Base: 9632031b005445f42d90628bea153368eb34bd1c; código: 3e05396d675b82072d90023d2e235449aec61500.
Publicação: [PR #172](https://github.com/henrique-devel/ganso-market/pull/172), merge 4787b171e5e4f77cfd24a05c98f2c3151379b840.
Checks: Verify source + Verify Compose runtime passaram no PR e main; Deploy production passou em main.
Migration: 0024_paper_financial_ownership.sql, aplicada 22:09:43 UTC; versões/checksums 1–24 conferidos.
Contrato: quatro tabelas; triggers ordem/evento/atribuição atômicos; donos imutáveis e resolução global por dono.
Leitura exportada: ownership.ts, loadAttributedLedgerEvents/loadOpenOwnerTokens, ownership versão 1.
Legado: histórico intacto e unknown explícito; zero backfill em massa, capital seed ou cache v2 ativado.
Decisão: dono verificado não comprova capital; initial_cash_usd NULL e origem unestablished até evidência.
Testes: 163 passed, zero skipped nos três arquivos focados; 16 casos PostgreSQL real via GANSO_TEST_DATABASE_URL.
Cobertura: F4/fee única, conflito/retry, concorrência, rollback, net-zero real, multirow, legado, guards e inválidos.
Gates locais: make verify passou; TypeScript, Prettier, diff e secret scan passaram; PG alheio skipped é separado.
Runtime: API/paper/portfolio com SHA interno 4787b17; profiles atualizados sob lock em 22:12 UTC.
Persistência: quatro marcas atribuídas, zero sem dono; evento 71932 gravado pelo paper novo às 22:13:22 UTC.
Integridade: 32.151 linhas até evento 71920 com MD5 7aa3b790c5a2383162b076b2bb91ca54 inalterado.
PostgreSQL: ID/Created/image/config-hash/postmaster preservados; guards originais e novos ativos.
Operação: configs/caps/paper/signer, recorder/watchdog/série DATA-01 preservados; imagens de rollback guardadas.
Limites: kill RECORDER_STALE engatado, sem ordens/fills novos; gates financeiros legados BLOCKED, sem soak amplo.
Evidência: [contrato, testes e produção](../evidence/FIN-02-ledger-ownership.md); rejeições de guard testadas só no PG descartável.
Worktree: /private/tmp/ganso-fin02; branches codex/fin-02-ledger-ownership e codex/fin-02-receipt; checkout alheio preservado.
Próximo elegível: FIN-03; menor lista de leitura na evidência; nenhum prompt posterior/QA executado.
