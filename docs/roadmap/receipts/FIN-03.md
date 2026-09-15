Bloco: FIN-03 | RFC: RFC-038 | Data UTC: 2026-09-15
Estado: code-verified; release verificada operacionalmente, sem aceite financeiro integrado.
Base: c1976da867478cf42372669596cc544e3eb3c7d0; código: 5128511359dc1c0c21604c8aa1beadec6636d77b.
Publicação: [PR #175](https://github.com/henrique-devel/ganso-market/pull/175), merge 9a9461c0ceaa0fe832ffea8628b5999aae5b6d26.
Head publicado: 9af3c1987666364393ac1b4721c75815fb88eb34; três commits originais preservados e autorização registrada.
Worktree: /private/tmp/ganso-fin03; branches codex/fin-03-pnl-equity e codex/fin-03-receipt.
Dependências: contrato FIN-01 e ownership v1 FIN-02 conferidos; nenhuma migration nova.
Resultado: R líquido/fees/cashflow por dono/token, short assinado e buckets de event_ts UTC.
Fórmulas: C=C0+R−Σsign(Q)B; U=M−sign(Q)B; E=C+ΣM=C0+R+ΣU.
Precisão: financial-v2 nove casas, notional único, basis residual; cache 0024 transacional/late/restart/retry.
Marcas: bid long/ask short por quantidade; global v1 ignorada; stale deixa U/equity indisponíveis.
Capital: NULL preservado, sem seed/alocação/novo cap; runtime seleciona paper/main e preserva HALTED.
Compatibilidade: ledger-v1 e leitores sem seleção conservados; unknown não vira lucro do bot.
Testes finais: 95 passed, zero skipped em cinco arquivos; 8 PostgreSQL reais no descartável exclusivo.
Comando: GANSO_TEST_DATABASE_URL=<descartável> npm test --workspace @ganso-market/api -- test/polymarket/paper/{financial,financial.pg,ledger}.test.ts test/polymarket/portfolio/{state,runner}.test.ts --no-file-parallelism.
Gate local: make verify passou; 2379 JS passed/236 skipped separados, Rust/Python/build/Compose aprovados.
Revisão independente, TypeScript, Prettier, diff e secret scan passaram; scope inclui somente o cache 0024.
CI: source/Compose passaram no [PR](https://github.com/henrique-devel/ganso-market/actions/runs/34920886978) e [main](https://github.com/henrique-devel/ganso-market/actions/runs/34921236579); Deploy production passou.
Operação: núcleo e perfil afetado confirmados no merge; saúde/identidade PG/guards/watchdog/série finita preservados.
Consulta financeira produtiva: recusada pela revisão automática antes de executar; conteúdo/destino local exigem aprovação específica.
Limite: replay/cache produtivo e escrita financeira não comprovados; sem novos fills, ganho de latência, reconciliação integrada ou soak.
Autorização pública: recusa inicial respondida diretamente; publicação corrente/futuras tarefas em DEVELOPMENT_AUTHORIZATION.md.
Evidência: [contrato, cobertura e limites](../evidence/FIN-03-pnl-equity.md); sem inventário operacional público.
Continuidade: FIN-04 não iniciado; coordenador deve avaliar entrega e pendência financeira antes do próximo despacho.
