Bloco: DATA-01 | RFC: RFC-041 | Data UTC: 2026-09-12
Estado: production-verified, somente inventário read-only; não é saúde/soak nem proteção aplicada.
Código/evidência: c7365d6; branch codex/data-01-inventory; base interna e74c246a2a4298f53cf58f5a9eb69135c332c702; correção documental/recibo no head do PR.
Entrega: [PR #160](https://github.com/henrique-devel/ganso-market/pull/160); checks/merge/classificação de deploy observados serão registrados no PR.
Resultado: [inventário e handoff](../../test-results/btc/DATA-01.md), candidatos com consumidores/referências, físico/vivo/TOAST/dead tuples, quotas e projeções7/30/90d.
Arquivos: relatório, coletor, JSON com complemento/reprodução/cálculos; este recibo; somente linha DATA-01 do estado.
Dependências: nenhuma; DB-04 consultado como contexto de pressão e comparação passiva, sem executar outros prompts.
Produção: janela principal04:36:23–04:37:09 UTC; complemento04:39:56–04:39:57; SSH com identidade fixada.
Catálogo: PostgreSQL18.4, foundation1–22, 79 tabelas,200 índices valid/ready,11FKs,28triggers; nenhuma migration ou índice aplicado.
Capacidade: tabelas92,226097GiB físicos; vivo estimado67,990744GiB; TOAST1,580833GiB já incluído; diferença24,235353GiB não é ganho recuperável.
Filesystem: livre186,465664GiB/62,1205%; margem111,423795GiB até piso25%; cenário bruto8,116813GiB/d cruza piso em13,73d, sem previsão física assegurada.
Pressão: PG~0,989CPU;390/395períodos throttled98,734%; cgroup1023,742→1023,992MiB; retenção natural deltas+50000deletes na amostra.
Cobertura:167ações auditadas, quotas já ultrapassadas em vários datasets; L2/labels/modelos/versões/cadeia econômica exigem fecho lógico, não sóFK.
Proteções: ledger/strategy triggers habilitados; quota tenta ledger e orders, orders sem filtro de status; prazo até quota ledger/orders indeterminado; nenhuma perda nelas afirmada.
Solana: EXISTS limitado confirmou quatro tabelas vazias no snapshot,112KiB físicos juntos; preservar schemas/migrations. 0xsonda ausente só na PK de markets consultada.
Artefatos:228imagens/218sem referência dos containers do projeto, camadas/rollback não reconciliados;5backups de código preservados;10JSONs de replay pequenos; sem export/restauração comprovados.
Verificação:26/27consultas concluídas; menor PK deltas cancelada em2s, sem retry; read-only/lock500ms; COUNT somente recorte orders LIMIT200.
Local: AST, JSON, componentes físicos, fórmula viva/taxas/projeções, links, revisão independente, secret scan e git diff --check passaram; sem teste runtime/carga.
Limites: bloat recuperável, crescimento físico sustentado, completude por token, pins/datasets, regeneração/restauração e orçamento de export não demonstrados.
Pendências herdadas: gates DB-02/03, Q4/DB-03B e headroom DB-04; ensaio escrita/WAL rejeitado pela revisão automática não executado/reencaminhado.
Decisões: proteger fecho/datasets antes de nova poda; revisar IDs antigos contra rollback; derivados/compactação só após prova; opções/impacto/custo0 no relatório.
Preservação: quatro documentos DB-01/BTC-04 e linhas locais alheias fora do PR; Git externo antigo intocado.
Autorização: PR→checks→merge vigente; texto segue RFC-020 deploy pulado; sem custo novo/caps/live/signer/perímetro/limpeza.
Próximo elegível: DATA-02 pode começar com inventário/limitações; nenhum outro bloco, tarefa ou automação iniciado.
