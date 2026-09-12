Bloco: DATA-03 | RFC: RFC-041 | Data UTC: 2026-09-12
Estado: code-verified; publicação GitHub bloqueada pela revisão automática.
Código:056b1e35f9333e7a28606643e3362c7710119744; basee9d6960; branch codex/data-03-export-restore.
Entrega local:/private/tmp/ganso-data03; PR/checks remotos/merge/deploy não executados.
Resultado: export limitado e restore transacional de fixture com contagens/hashes/chaves/replay exatos, sem poda.
Arquivos:retention-archive{,-storage,-replay}.ts/CLI, helper catálogo DATA-02,3testes,runbook/evidência/artefatos.
Contrato:[runbook](../../runbooks/retention-archive.md); [evidência](../../test-results/btc/DATA-03.md).
Dependência:DATA-02 schema23/guards/pins/lock741041,2 reutilizados; nenhuma migration alterada ou nova.
Versões:archive-v1,fixture-plan-v1,restore-certificate-v1; hashes vinculam manifesto/plano/arquivo/SHA/schema/policy/destino.
Limites:1–4objetos,1000linhas/tabela,16MiB,transação2s/statement500ms/lock100ms; folga25%+64MiB e recibo PG≤60s.
Testes source:2338passed/211skipped; format/lint/build/typecheck/scan_secrets/diff passaram;25unitários novos incluídos.
PostgreSQL18.4 descartável:20DATA-03+23regressões DATA-02 passed;43reais/0skipped nas execuções finais.
Aceite:rawL2(1âncora+2deltas),ordem/ledger/posição manual e residual exato; bigint/micros/decimal preservados.
Falhas:corrupto/parcial/schema/pin/rowdrift/expiração/capacidade/concorrência recusados; rollback preserva destino preexistente.
CLI056b1e3:exit0 às09:28:33.963Z;8747bytes arquivo+5068certificado; arquivo parcial rehashado exit1/sem certificado.
Artefato:[archive](../../test-results/btc/DATA-03-fixture-archive.json); [certificado](../../test-results/btc/DATA-03-fixture-certificate.json).
Expiração:09:43:33.631Z; depois é evidência histórica; fixtureOnly/execução false/deletionEligibility false.
Preservação real:nenhum corpus/pin/export/restore de produção; manifesto DATA-02 vazio/vencido não fornece história.
Limites:continuidade real/fecho/horizontes desconhecidos;target sóverificação/sequências não reposicionadas; semsaúde/soak.
Publicação:2pushes recusados mesmo após owner/origin/push:true/autorização conferidos; falta aprovação reconhecida da publicação pública específica.
Decisão posterior:manterHOLD(custo externo0,cresce disco,recomendado) ou fixar recorte real/destino/âncoras/folga atuais.
Herdados:DB-02/03,Q4/headroom pendentes;ensaioDB-03 rejeitado não reexecutado;Git externo/quatro artefatos/linhas alheias preservados.
Próximo:DATA-04 pode preparar contrato local;integração remota pendente;certificado não libera exclusão;nenhum outrobloco executado.
