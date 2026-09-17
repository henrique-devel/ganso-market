Bloco: EXEC-03 | RFC: RFC-034 | Data UTC: 2026-09-17
Estado: code-verified; publicação expressamente autorizada pelo proprietário, entrega em andamento.
Código: 63fd9b3; base83856e9 após rebase documental; worktree /private/tmp/ganso-exec03.
Resultado: aceite → parcial → pedido → parcial antes do efeito → cancelamento sem fill posterior.
Dependências: EXEC-02/PR190–192 e FIN-05/0025 conferidos por código/recibos.
Modelo: paper-fill-v2; nenhuma migration; ledger e gatilhos reservation-v1 reutilizados.
Cancelamento: pedido/evento transacionais com lock; efeito libera somente restante.
Maker: fila por trades, sem lucro por toque; ledger preserva quantidades sob reordenação/restart.
Taker: latência existente e profundidade finita por snapshot/lado/token; FAK libera restante.
Fees: null/procedência ausente recusam; versão/timestamps/fórmula persistidos, zero maker documentado.
Métricas: maker/taker, fees/PnL/markouts e cobertura no relatório existente; amostra vazia sem evidência.
Focados: 215 passed (broker/brokerstore/performance/ledger/financial); typecheck/diff passaram.
SQL: make test-postgres, PostgreSQL18.4/25 migrations, 23 arquivos/295 passed/zero skips.
Checks: make verify passou (2472 JS/264 PG skips separados; 16 Rust; 220 Python; build/scan/Compose).
Aceite econômico: dois donos, cash1.001,70/PnL1,70/fees0,30 cada; retries e reconstrução.
Produção: não alterada; nenhum worker ativado; CI remoto não executado.
Autorização: proprietário respondeu “Autorizo realizar a publicação codigo/documentação”; recusa anterior superada.
Limites: simulação, precisão difere da venue; PnL legado exclui tokens mistos; sem G4/soak/live.
EXEC-04: reserveOrder + appendLedgerEvent(fill/terminal) + reconcileReservations + requestCancel transacional.
Detalhes/reprodução/limitações: [evidência](../evidence/EXEC-03-fills.md).
Próximo: EXEC-04 depende também de FIN-07; nenhum bloco seguinte iniciado.
