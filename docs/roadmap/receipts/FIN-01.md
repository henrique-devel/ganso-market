Bloco: FIN-01 | RFC: RFC-038 | Data UTC: 2026-09-12
Estado: code-verified (especificação verificada, sem efeito no runtime)
Base: 95f752b41249cd03219c2baff3dd027873b046b9; commit de entrega no histórico deste arquivo.
Resultado: contrato financial-v2 e seis fixtures manuais; esquema aditivo proposto, ainda inexistente.
Evidência: [contrato e contas](../evidence/FIN-01-financial-contract.md).
Arquivos: evidência, este recibo e somente a linha FIN-01 do estado comum.
Dependências: nenhuma; símbolos do HEAD e 0008/0020 confirmados, divergências no contrato §5.
Decisões: dono conta/estratégia/token; quatro tabelas FIN-02, reserva FIN-05; legado desconhecido segregado.
Precisão/tempo: escala9, resíduo no fechamento; fee uma vez, realização econômica UTC, versões explícitas.
Testes locais: auditor Python/Decimal temporário, seis grupos F1–F6 passaram; revisão independente aprovada.
Verificações: git diff --check, scan_secrets.py e links passaram; classificador local: deploy pulado: só texto (3 arquivos).
Contagem: zero testes de runtime/SQL executados localmente; fixtures não provam concorrência PostgreSQL.
Publicação/checks: registro de entrega no PR desta branch codex/fin-01-financial-contract.
Produção: não consultada; só documentos, aplicar dispensa RFC-020 conforme classificador/CI, sem forçar deploy.
Limites: nenhuma migration/fold/reserva implementada, nenhum aceite operacional/saúde financeira produtiva.
Autorização: sequência FIN e docs/ops/DEVELOPMENT_AUTHORIZATION.md; sem mudança de capital/caps/live/signer.
Worktree: /private/tmp/ganso-fin01; Git interno e alterações de outras frentes preservados.
Próximo bloco elegível: FIN-02; QA-01 pode consumir oráculos, nenhum prompt seguinte foi lido/executado.
