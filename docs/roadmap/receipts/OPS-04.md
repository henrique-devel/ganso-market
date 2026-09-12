Bloco: OPS-04 | RFC: RFC-021 | Data UTC: 2026-09-11T18:41:27Z
Estado: code-verified (documental; especificação verificada, sem efeito no runtime).
Código: base c528d5b0d74cc5cf8894ee953dd335df5f1e1b03; documento e recibo novos; alterações locais OPS-01/02/03 preservadas.
Resultado: [plano operacional](../../runbooks/btc-recovery.md) pronto, com gate de aplicação fechado e ponto de retomada explícito.
Arquivos: docs/runbooks/btc-recovery.md; este recibo; somente linha OPS-04 do estado.
Dependências: OPS-01/02/03 conferidos por recibo/código; OPS-02/03 ainda sem SHA integrado; OPS-05/06/07 ausentes por código e sem recibo/SHA.
RFC020: D1/D2/D3/D4a/D4b resolvidas por SHA ancestral no plano; prova histórica 07/09 separada de provenance atual não medida.
Operação: baseline por série/serviço, supervisor externo antes de recreates, manutenção reversível, migrations antes de workers, rollback com imagens fixadas e lock de deploy.
Contratos: snapshots/deltas/RTDS por par; relógios de fonte/recepção/observação distintos; D3 15 ticks/900s sem escrita manual; D4 monotônica sem inferir resolved.
Testes: seis blocos Bash passaram bash -n; links locais do runbook conferidos; secret scan e git diff --check passaram.
Testes SQL: Q1–Q4 executadas READ ONLY em PostgreSQL18.4 descartável, schema vazio e fixtures, após migrations reais 0001–0021.
Aceite SQL: zeros para séries ausentes, pares RTDS separados, avanço visível, gaps antigos sobrepostos, engate anterior preservado após novo engate, auditoria 900s e closed sem resolved.
Testes RFC020: test_server_update_target.py (6) e test_deploy_paths.py (22) passaram nesta sessão pela auditoria delegada.
Ambiente SQL: container dedicado sem rede/porta/volume persistente, dados em tmpfs; removido ao terminar; nenhum banco externo usado.
CI: make verify/integration do release integrado ainda não executados neste bloco; gates obrigatórios antes da aplicação.
Produção: não consultada, nenhum deploy/recreate/rearme/ativação de supervisor; host key pendente conforme OPS-01.
Limites: observabilidade atual não prova backlog integral nem universo minuto a minuto; exigir esses contratos/evidências antes dos respectivos aceites.
Autorização operacional: somente preparação operation-plan e validação local; aprovação D3 existente preservada, sem uso como autorização de rearme forçado.
Estágios: plano pronto; aplicado não; janela observada não; D3/D4 operacional não observado; soak de sete dias pendente.
Retomada exata: seção 1 do plano — integrar OPS-02/03, concluir OPS-05/06/07, reconciliar SSH, resolver artefato/CI/config/schema e contratos de observação; então avaliar operação concreta autorizada.
Próximo bloco elegível: OPS-05 para o delta RTDS; não iniciado automaticamente. OPS-04 operacional continua condicionado às demais dependências.
