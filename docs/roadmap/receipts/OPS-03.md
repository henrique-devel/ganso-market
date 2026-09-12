Bloco: OPS-03 | RFC: RFC-021 | Data UTC: 2026-09-11T12:50:35Z
Estado: code-verified
Código: base c528d5b0d74cc5cf8894ee953dd335df5f1e1b03 + mudanças OPS-03 não commitadas; alterações preexistentes preservadas.
Resultado D2: gatilho lê snapshots/deltas e audita série/idades; RECORDER_STALE_MS preservado em 300.000 ms.
Resultado D3: rearme automático condicionado a 15 ticks válidos, ambas frescas, sem stream_silent aberta e engate elegível.
Evidência: [OPS-03](../../test-results/btc/OPS-03.md).
Arquivos: brokerstore.ts, runner.ts e seus testes; novo apps/api/test/polymarket/paper/kill-switch.pg.test.ts.
Documentos: evidência, este recibo e somente linha OPS-03 do estado; nenhuma migration alterada/criada neste bloco.
Dependência: OPS-01 confirmado pelo recibo e código local; D2/D3 ausentes antes; saúde de produção não inferida.
Ticks: baseline por start/reset; janela zero sem crédito; janelas consecutivas de 60s, mínimo 900s; repetição não incrementa.
Resets: erro, janela perdida/anterior, consulta que atravessa janela, feed inválido, gap, motivo/auditoria inelegível ou novo engate.
Reboot/stop: memória descartada/invalida observações; nenhuma importação de histórico saudável; commit já autorizado não é revogado.
Proteções: locks e recheck transacional, perda preservada/promovida, frozen_markets intactos, origem manual nunca auto-rearmada.
Auditoria: evento mode:auto/healthy_ticks:15 + log; chave por engate, colisão/erro faz rollback; ledger append-only preservado.
Compatibilidade: endpoint manual mantido; engate humano registra mode:manual mesmo com reason RECORDER_STALE; legado sem mode segue D3.
Testes: npm run test --workspace @ganso-market/api -- test/polymarket/paper/{brokerstore,runner,api,ledger}.test.ts — 168 passed.
Testes SQL: GANSO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55245/ops03_test npm run test --workspace @ganso-market/api -- test/polymarket/paper/kill-switch.pg.test.ts — 8 passed.
Checks: npm run check --workspace @ganso-market/api e git diff --check dos arquivos alterados — passaram.
Ambiente: Node26.4.0/npm11.17.0/Vitest4.1.10; PostgreSQL18.4 descartável, DDL0008/guards reais, schemas isolados; nenhum skipped.
Aceite: série correta; 14/15; duplicados/gaps/erros/reboot/atraso; concorrência manual/duplo worker/gap; rollback e imutabilidade reais.
Produção: não consultada; sem deploy, rearme operacional, mudança de limiar ou remoção de eventos antigos.
Limites: sem soak/latência de locks/integração de todas as migrations; ticks intermediários em memória, contrato detalhado na evidência.
Autorização: modo code + D3 aprovada em 2026-09-05; SQL somente em banco descartável local.
Próximo bloco: OPS-04 validar release, cadência, séries/gaps e auditoria com evidência de produção dentro da autorização vigente.
