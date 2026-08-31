# VERIFICAÇÃO — checklist pré-live: provar que a RFC-009 pode começar

Você vai verificar, com medição, TODAS as pré-condições da execução real e montar o pacote
de evidência para as duas aprovações manuais do proprietário. Este prompt NÃO implementa a
RFC-009 e NÃO executa nenhuma aprovação — ele prova (ou nega) que o caminho está pronto.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). SOMENTE leitura nesta sessão — zero deploy, zero
  escrita no servidor, zero `gates-cli approve` (a aprovação do G6 é ato EXCLUSIVO do
  proprietário; você pode rodar `gates-cli show`, nunca `approve`). Nunca imprima secrets.
- Fontes: `docs/rfcs/RFC-009-polymarket-live-execution.md` (pré-condições),
  `docs/rfcs/RFC-013` (gates), `docs/PRD.md` §6.6, `docs/HANDOFF.md`,
  `docs/runbooks/polymarket-portfolio.md` (procedimento do G6).

## O que verificar, com número e fonte (nada de "parece ok")

### A. Os seis gates

1. Última medição de CADA gate em `portfolio_gate_measurements`: os seis em `PASS`? Com
   quais métricas? (G2: posições fechadas ≥100, ≥30 mercados, ≥2 categorias, ≥20 dias
   distintos, ≥10 blocos, IC95>0 pós-haircut, ≥60 dias de relógio — o relógio conta desde
   2026-08-28 20:38:47Z se nenhum reset novo ocorreu; confirme em `portfolio_g2_clock`.)
2. `rfc_009_status` = `READY_FOR_OWNER_REVIEW`? Relatório novo cunhado
   (`portfolio_gate_reports`) refletindo os vereditos?
3. Replay de auditoria limpo (`PORTFOLIO_REPLAY_OK`, zero MISMATCH) e soak recente sem
   erros nos serviços.
4. Se QUALQUER gate não estiver `PASS`: o checklist FALHOU — produza o relatório dizendo
   exatamente o que falta, quanto falta e a projeção de data; não prossiga para B/C.

### B. Aprovações e trilha humana (registros, não promessas)

1. **G6**: existe revisão escrita do proprietário registrada pelo caminho da CLI? (Se não:
   preparar o pacote — `gates-cli show` completo, os seis vereditos, a expectativa
   calibrada — e entregar ao proprietário o comando `approve` documentado no runbook para
   ELE rodar.)
2. **Parecer jurídico/tributário obtido** — pré-condição 2 da RFC-009: há registro nos
   docs? (Fato informado pelo proprietário; sem registro, listar como pendente dele.)
3. **Burn wallet Polygon provisionada** — pré-condição 3: wallet criada com capital
   limitado definido, cópia de recuperação offline FORA do servidor comprovada, POL mínimo
   para gas. (Verificável só por registro/confirmação do proprietário — nunca peça ou
   manuseie seed/private key; a existência se registra, o material nunca.)
4. **Capital real definido** (PRD §6.6 aplica caps sobre o capital da burn wallet: entrada
   2%, mercado 5%, perda diária 3%, drawdown 10%): qual é o número? Sem número, pendente.
5. **Aprovação explícita do beta live** — pré-condição 4: ato separado do G6; existe?

### C. Saúde operacional de base

- Disco/RAM/CPU dentro do esperado; retenção fechando quotas sem `QUOTA_UNMET`; alarme
  global silencioso; kill switch DESARMADO com caminho de rearme testado; coletor onchain
  vivo; zero erros recorrentes não explicados nos logs (1 h por serviço).

## Entregável

- Relatório go/no-go no HANDOFF, item a item com número/fonte/data, e a lista nominal do
  que falta com dono (IA vs proprietário) e projeção. Status em
  `prompts/roadmap/README.md`. Se for GO em tudo: o próximo prompt (10, RFC-009) fica
  liberado — diga isso explicitamente no relatório.
- Condições de parada: qualquer tentação de rodar `approve`, engatar/rearmar switch, ou
  "ajudar" um gate. Este prompt só mede.
