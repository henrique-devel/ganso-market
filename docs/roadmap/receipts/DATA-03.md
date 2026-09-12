Bloco: DATA-03 | RFC: RFC-041 | Retomada UTC: 2026-09-12
Estado: code-verified; publicação novamente recusada pela revisão automática, após autorização específica.
Base:973a7cc(PR168); worktree /private/tmp/ganso-data03-publication; branch codex/data-03-publication.
Código histórico056b1e3/entrega2421832 reaplicados9d68dab/fb69041; fontes/testes/dependências/migrations idênticos.
Resultado: export/restore limitado de fixture com chaves/hashes/contagens/replay exatos, sem poda.
Arquivos:14 exclusivos DATA-03;5lógica/3testes/runbook/estado/recibo/relatório/2artefatos; nenhuma migration.
Contrato:[runbook](../../runbooks/retention-archive.md); [histórico e retomada](../../test-results/btc/DATA-03.md).
Dependência:DATA-02 schema23/guards/pins/lock741041,2;HOLD integral já aprovado e mantido.
Limites:1–4objetos/1000linhas/16MiB;tx2s/statement500ms/lock100ms;folga25%+64MiB/recibo PG≤60s.
Testes atuais:2338source passed/211skipped;format/lint/build/typecheck/segredos/diff passaram.
Histórico PG18.4:20DATA-03+23regressõesDATA-02=43passed;sem reexecução atual, pois nenhum delta SQL/código.
Aceite histórico:rawL2,ordem/ledger/posição e residual;bigint/micros/decimal preservados;origem intacta/rollback testado.
CLI056b1e3:exit0 às09:28:33.963Z;arquivo8747bytes+certificado5068bytes;parcial rehashado exit1 sem certificado.
Artefatos:[archive](../../test-results/btc/DATA-03-fixture-archive.json) e [certificado](../../test-results/btc/DATA-03-fixture-certificate.json),bytes preservados.
Expiração original09:43:33.631Z preservada;fixtureOnly true/executionAllowed false/deletionEligibility false.
Produção:nenhum corpus/pin/export/restore/poda;manifesto vazioHOLD não fornece história ou autorização de exclusão.
Deploy:operacionalmente dispensável(CLI fora do grafo dos serviços);plano de suspensão temporária para evitar prune não executado.
DEPLOY_ENABLED=true confirmado18:09:50Z e não alterado;sem SSH/rebuild/reinício/novo SHA de serviço.
Publicação:autorização posterior registrada no PR163;NOVA recusa considerou citação não confiável para egress público;sem PR/CI remoto/merge/deploy.
Limites:história/fecho/continuidade reais não comprovados;destino só verificação/sequências não reposicionadas;sem saúde/soak.
Decisão mantida:HOLD/custo externo0;índices suspensos,Q4/DB03B/compactação adiados;sérieDATA-01 preservada.
Preservação:Git externo,rootd04875a,worktree histórico,quatro artefatos e demais linhas intactos;nenhum outro bloco executado.
Próximo:contrato local pronto para DATA-04;dependência publicada aguarda resolução da nova recusa;sem exclusão real.
