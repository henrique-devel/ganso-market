Bloco: OPS-05 | RFC: RFC-021 | Data UTC: 2026-09-11T20:51:43Z
Estado: code-verified
Código: c528d5b0d74cc5cf8894ee953dd335df5f1e1b03 + mudanças locais não commitadas; alterações preexistentes preservadas.
Resultado: silêncio RTDS global e por feed/símbolo vira gap persistente, recuperável após falha de DB e retomado após restart; transporte não comprova preço fresco.
Evidência: [OPS-05](../../test-results/btc/OPS-05.md), fixtures rtds-silence/rtds-restart/rtdsgaps e wiring orchestrator-silence.
Arquivos de execução: rtds.ts, rtdssilence.ts (novo), rtdsgaps.ts (novo), orchestrator.ts, docker-compose.yml.
Migration: 0022_polymarket_rtds_gap_idempotency.sql; SHA256 f6e34a6b6ba3ce3a6f8c4764a8bee0e94c8855292fd5cb4991fdd9310dc5c7f7; 0005 e 0021 preservadas.
Dependência verificada: OPS-01 recibo + evidência RTDS + código; ausência de watchdog e gap best-effort confirmadas, sem inferir saúde de produção.
Limiar: GANSO_RTDS_SILENCE_MS=120000, inteiro 30000..3600000; decisão local conservadora alinhada a D1/cenário OPS-01, pendente de medição OPS-04.
Recuperação: um resubscribe e até GANSO_RTDS_MAX_RECONNECTS=3 (0..10); backoff N/2N/4N limitado a max(N,300s), orçamento preservado entre opens/restart.
Persistência: episode_id idempotente; até 256 pendências, 8 falhas em burst de 1–60s e sondagem a cada 5min; drain final até 5s; excesso/falha explícitos.
Saúde: STATUS.rtds expõe transporte, chegada válida global/por série, avanço de source_ts, mudança de valor, confirmação de persistência, erros cumulativos, recovery e restore.
Testes: npm run test --workspace @ganso-market/api -- test/polymarket/{rtds,rtds-silence,rtds-restart,rtdsgaps,orchestrator,orchestrator-silence}.test.ts — 65 passed, 1 skipped (PG sem DSN nessa execução).
Testes SQL separados: GANSO_TEST_DATABASE_URL=<DB descartável local> npm run test --workspace @ganso-market/api -- test/polymarket/rtdsgaps.test.ts — 9/9 passed, incluindo PG; nenhum skipped.
Testes auxiliares: npm run check --workspace @ganso-market/api; prettier --check nos 8 TS afetados; python3 scripts/check_compose_policy.py; git diff --check — passaram.
Ambiente: Node v26.4.0, Vitest 4.1.10, PostgreSQL 18.4 descartável; banco ops05_rtdsgaps_20260911 e role temporária removidos após testes.
Aceite: PONG/ACK/preço inválido não curam; primeiro preço fecha só os scopes correspondentes uma vez; série parcial e falha DB visíveis; stop/reconnect/replay/restart cobertos.
Produção: não consultada; sem deploy, aplicação de migration em produção ou soak; nenhuma alteração de benchmark RFC039, estimador ou kill switch.
Limites: pendências ainda não confirmadas no DB são memória e podem se perder em crash; overflow/restore acima de 256 exigem reconciliação; restauração presume um recorder ativo.
Próximo consumo: OPS-04 verificará frescor real e integração/deploy/soak; BTC benchmark consumirá proveniência e timestamps sem redefinir este detector.
