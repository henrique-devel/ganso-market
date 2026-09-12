Bloco: DATA-02 | RFC: RFC-041 | Data UTC: 2026-09-12
Estado: production-verified da aplicação/proteções; não é saúde de feeds, capacidade ou soak.
Código:725805e/revisão1abfe74; headcb37065; merge/deploy8132cd357ffb47340e39af278a65dc06469edb0f; branch codex/data-02-protection.
Entrega:[PR #161](https://github.com/henrique-devel/ganso-market/pull/161) integrado08:44:19Z; checks PR/main e deploy success08:49:04Z; fecho documental em codex/data-02-evidence.
Resultado: HOLD integral de69 tabelas de evidência/config +4 resíduos; quota não autoriza limpeza.
Contrato:[runbook](../../runbooks/retention-evidence.md); [evidência](../../test-results/btc/DATA-02.md); seis arquivos de lógica e migration0023, anteriores intactas.
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
Revisão automática: recusa inicial do artefato local resolvida com isolamento/desenho seguro aprovado; nenhum bypass/ensaioDB-03.
Produção:checksum0023fcc5b882… confirmado;146/146guards habilitados +ledger/strategy/pins; recorder/portfolio SHA8132cd3; health local passou.
Observação:3panel/5exit cycles; inserts avançaram e deletes não nos4contadores;16gapsRTDS/8divergências observados; pausa ocorreu apósdeploy, ver horários/limite no relatório.
Manifesto produção08:51:26.576Z:[JSON](../../test-results/btc/DATA-02-manifest.json), hashadbc6738…; orders/deltasHOLD0inspecionadas/0candidatos, expira09:06:26.576Z; sem poda/export/restauração.
Decisão aprovada: manter HOLD integral; novos dados/experimentos exigem orçamento demonstrável e fecho protegido/preservado; delta documental, sem nova admissão/limpeza/certificação produtiva; arquivos/admissão serão DATA-05.
Herdados: DB-02/03,Q4 e headroom DB-04 pendentes; ensaioDB-03 rejeitado não executado/reencaminhado; caps/paper/perímetro mantidos.
Preservação: Git externo, quatro artefatosDB-01/BTC-04 e linhas locais alheias intocados; entrega em worktree do Git interno.
Próximo: DATA-03 pode começar preparação com contrato/proteções aplicados; horizontes/pins finos/âncoras e gates herdados pendentes; nenhum outro bloco iniciado.
