Bloco: FIN-05 | RFC: RFC-038 | Data UTC: 2026-09-16
Estado: code-verified; implementação/testes locais, sem aceite financeiro produtivo/soak.
Base: ae33084e1242fbb649b38341e875bf7b0ecca6a4; código na branch codex/fin-05-reservations.
Resultado: aceite e reserva transacionais por dono, transferência em fill e release somente efetivo.
Migration: 0025_paper_order_reservations.sql, número conferido na main; tabela proposta por FIN-01.
Dependências: FIN-02 ownership-v1/0024 e FIN-04 payoff-v1 conferidos por código/recibos integrados.
Locks: ordem/token antes do dono; NO KEY UPDATE compatível com FKs; escritores monetários participam.
Precisão: nano-USD, reservas para cima, cashflows half-away-from-zero; saldo SQL final não negativo.
Invariantes: C=C0+cashflows; disponível=C−H; longs disponível+H+basis=C0+R; risco separado, sem duplicação.
Teste concorrente: US$600/US$500 contra US$1.000, duas ordens de chegada e backend bloqueado observado.
Resultado concorrente: um aceite e uma recusa; somente US$600 ou US$500 reservados, rollback da perdedora.
Testes focados: 237 passed/zero skipped, sete arquivos; 45 PostgreSQL reais, incluindo 19 FIN-05.
Cobertura: risco, duas saídas, donos/contas, partial+cancel nas duas ordens, fee, nanos, rollback/retry/restart/GTD/resolução.
Contrato EXEC-03/04: reserveOrder + payload imutável; consume/release por appendLedgerEvent; reconcileReservations por dono.
Config: API/paper usam os arquivos existentes de caps/fatores/léxico somente leitura; valores preservados.
Legado: sem reservas fabricadas/capital inferido; ordem legada aberta bloqueia nova capacidade do dono.
Compatibilidade: ledger legado preservado; garantia de admissão vale para o broker FIN-05, não binários antigos simultâneos.
Gates: make verify passou; última verificação completa e publicação registradas no fecho da entrega.
Produção: ainda não consultada ou alterada por esta tarefa; PR/CI/merge/deploy pendentes.
Limites: sem benchmark produtivo/reconciliação integrada/soak; sem live, worker, cap ou validade novos.
Revisão automática: guarda adicional contra aceites de binários antigos recusada/não aplicada; caminho compatível mantido.
Evidência e comandos: [FIN-05](../evidence/FIN-05-reservations.md).
Worktree: /private/tmp/ganso-fin05; alterações locais de outros blocos preservadas.
Próximo elegível: FIN-06; contrato também entregue a EXEC-03/04, nenhum bloco posterior iniciado.
