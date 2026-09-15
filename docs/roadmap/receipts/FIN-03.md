Bloco: FIN-03 | RFC: RFC-038 | Data UTC: 2026-09-15
Estado: code-verified; código financeiro por dono, sem aceite financeiro integrado.
Base: c1976da867478cf42372669596cc544e3eb3c7d0; código: 5128511359dc1c0c21604c8aa1beadec6636d77b.
Worktree: /private/tmp/ganso-fin03; branch: codex/fin-03-pnl-equity.
Dependências: contrato FIN-01 e atribuição ownership v1 FIN-02 conferidos.
Resultado: R líquido/fees/cashflow por dono/token, shorts medidos e buckets econômicos UTC.
Fórmulas: C=C0+R−Σsign(Q)B; U=M−sign(Q)B; E=C+ΣM=C0+R+ΣU.
Precisão: financial-v2, nove casas; notional único e resíduo de basis removido na última saída.
Cache: paper_owner_positions da 0024, rebuild transacional/retry; nenhuma migration nova.
Marcas: bid long/ask short por quantidade; marcas v1 globais ignoradas; stale conserva indisponibilidade.
Capital: NULL permanece desconhecido; não há seed, alocação, repartição ou novo cap.
Runtime: runner seleciona paper/main; missing capital/marca impede novas entradas; HALTED preservado.
Compatibilidade: ledger-v1 e leitores sem seleção explícita conservados; unknown não vira lucro do bot.
Testes focados finais: 95 passed, zero skipped, cinco arquivos; 8 casos PostgreSQL real exclusivo.
Comando: GANSO_TEST_DATABASE_URL=<descartável> npm test --workspace @ganso-market/api -- test/polymarket/paper/{financial,financial.pg,ledger}.test.ts test/polymarket/portfolio/{state,runner}.test.ts --no-file-parallelism.
Gate local: make verify VENV=<venv existente> passou; 2379 testes JS passed/236 skipped separados, Rust/Python/build/Compose aprovados.
Revisão independente, TypeScript, Prettier, diff e secret scan passaram; scope allowlist inclui somente o cache 0024.
Evidência: [contrato, cobertura e limites](../evidence/FIN-03-pnl-equity.md).
Produção: implantação/verificação pós-merge ainda não executadas neste registro inicial.
Limites: sem novos fills, ganho de latência, reconciliação histórica/integrada ou soak comprovados.
Autorização: DEVELOPMENT_AUTHORIZATION.md e autorização direta da sequência FIN; sem custo externo adicional.
Próximo elegível: FIN-04 após fecho desta entrega; nenhum prompt posterior executado.
