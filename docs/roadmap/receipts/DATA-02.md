Bloco: DATA-02 | RFC: RFC-041 | Data UTC: 2026-09-12
Estado: code-verified; aplicação/observação de produção ainda pendentes neste recibo inicial.
Código: 725805e; revisão/runbook1abfe74; branch codex/data-02-protection; base interna530229e.
Entrega: [PR #161](https://github.com/henrique-devel/ganso-market/pull/161); checks/merge/deploy em acompanhamento autorizado.
Resultado: HOLD integral de69 tabelas de evidência/config +4 resíduos; quota não autoriza limpeza.
Contrato: [runbook](../../runbooks/retention-evidence.md); seis arquivos de lógica e migration0023, sem reescrever anteriores.
Legado: uma consulta catálogo, sem DELETE/ANALYZE/coverage scan/reduçãoTTL; estimativa físico/vivo não é ganho recuperável.
SQL:146 guards DELETE/TRUNCATE, writers compartilhados, seletor/pins exclusivo sem fila, auditoria transacional de pins integrais.
Economia: ledger/idempotency/orders/positions/entries/decisions/fills/marks/resoluções/configs/gates/raw protegidos, mesmo semFK.
Runtime: exposição encerrada vira zero por UPDATE, preserva id/cap/detalhe e evita falsa brecha; UI pode mostrar bucket zero.
Manifesto: SHA/schema/policy/hash/cutoffUTC/PK/watermark/pins/validade≤15min;1–4 objetos; fatia≤1000+1 e transação≤2s.
Contagem: exata só no recorte; resto desconhecido/estimado separado; bigint e microssegundos preservados; sem autorização de execução.
Sintético: data-02-synthetic-v1 exclui0xsonda com motivo/contagem; desconhecidos inelegíveis; nenhum registro/trigger removido.
Testes source: npm test2313 passed/191 skipped; format:check/lint/build/API typecheck/secret scan/diff passaram.
PostgreSQL18.4 descartável:16 manifesto+7 proteção+3 portfolio passed;31 casos portfolio fora do filtro, não passados.
Ciclo real:5 panel cycles; encerramento não ressuscita exposição, guard recusa apagar decisão, proveniência intacta.
Revisão independente: corrigidos painel, predicado, precisãobigint/UTC/bytes, controlespins no catálogo e validade temporal.
Revisão automática: artefato local inicialmente recusado por risco de writers; isolamento comprovado e desenho seguro aprovados.
Produção prévia read-only: release1878bf2; disco195567460KiB disponível; núcleohealthy no instante, sem atestar feeds/soak.
Aplicação: migration/profiles/SHA/ciclos precisam ser comprovados; portfolio antigo deve pausar até runner compatível, guards preservados.
Limites: sem poda/export/restauração/ganho físico; horizonte/pins finos/âncoras desconhecidos mantêmHOLD; sem contagem sintética global.
Decisão posterior: manterHOLD(recomendado enquanto desconhecido,custo externo0) ou definir horizontes/pins com prova de preservação.
Herdados: DB-02/03,Q4 e headroom DB-04 pendentes; ensaioDB-03 rejeitado não executado/reencaminhado; caps/paper/perímetro mantidos.
Preservação: Git externo, quatro artefatosDB-01/BTC-04 e linhas locais alheias intocados; entrega em worktree do Git interno.
Próximo: DATA-03 pode preparar preservação com contrato; nenhuma poda antes da prova de aplicação; nenhum outro bloco iniciado.
