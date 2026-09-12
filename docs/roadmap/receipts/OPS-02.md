Bloco: OPS-02 | RFC: RFC-021 D1 | Fecho UTC: 2026-09-11T05:55:56Z
Estado: code-verified
Código: base c528d5b0d74cc5cf8894ee953dd335df5f1e1b03 + patch local não commitado.
Resultado: silêncio global/top cinco persiste stream_silent e aciona recuperação limitada.
Evidência e reason codes: [OPS-02](../../test-results/btc/OPS-02.md).
Dependência: [OPS-01](OPS-01.md), D1 ausente comprovado no código; produção não atestada.
Arquivos de lógica: clobsilence.ts (novo), dualws.ts, orchestrator.ts, quality.ts.
Schema: migration 0021, índice parcial único por UUID de episódio; UPSERT não reabre gap fechado.
Observação: recepção de book/price_change válido de token inscrito, antes de DB; duplicata conta recepção, não atividade.
Exclusões de frescor: PING/PONG, ACK, trade, tick, payload inválido, REST e cache.
Limiares: N = 120 s, GANSO_CLOB_SILENCE_MS com piso de 30 s; janela de 15 min; até 2.048 buckets por token.
Controle: dois REST reais separados por >= 30 s; timeout de 10 s; blind/venue_quiet/unavailable preservam a lacuna.
Recuperação: resubscribe em N; reconnect em 2N/4N/8N, máximo três; callbacks de sockets antigos ignorados.
Persistência: limite de 64 episódios, uma gravação em voo; oito tentativas rápidas e sondagem de 5 min, mantendo UUID e janela.
Shutdown: cancelamento de HTTP e timers, drenagem final <= 5 s; fechamento pendente preservado; alarme se falhar.
Testes: npm run test --workspace @ganso-market/api -- test/polymarket/{orchestrator,orchestrator-silence,dualws,quality,clobsilence,bookpipe}.test.ts, com GANSO_TEST_DATABASE_URL — 127 passed, zero skipped.
Ambiente/teste: Node 26.4.0, Vitest 4.1.10, PostgreSQL 18.4 descartável; 2026-09-10T21:34:02Z.
Verificações: typecheck da API, Prettier, secret scan, git diff --check aprovados; migrations 0001–0021/reaplicação de 0021 aprovadas.
Produção: não consultada; sem deploy, sem alterações de kill switch/RTDS; identidade SSH continua pendente em OPS-01.
Limites: journal em memória; crash/fila cheia/DB indisponível podem deixar evidência pendente; event loop travado exige OPS-06.
Handoff: OPS-04 deve aplicar 0021 antes do recorder e medir gaps/controles/tentativas; demais dependências OPS ainda exigidas.
Continuidade: apenas OPS-02 executado; arquivos preexistentes de OPS-01 preservados; container temporário removido.
