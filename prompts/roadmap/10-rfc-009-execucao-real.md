# RFC-009 — execução real maker-side na Polymarket

Você vai implementar a RFC-009, ATÉ O FINAL do que é seu: código → testes → merge → CD →
rebuild → canário verificado. Este é o único prompt da pasta cujo "final" inclui atos que
NÃO são seus: a ativação real é do proprietário, em cada degrau.

**PRÉ-CONDIÇÃO DURA:** o checklist pré-live (prompt 09) concluído com GO integral —
seis gates `PASS`, revisão G6 registrada, parecer jurídico obtido, burn wallet
provisionada, capital definido, aprovação explícita do beta. Se qualquer item não estiver
registrado, PARE na primeira seção e devolva o que falta. Verifique você mesmo; não aceite
"está ok" sem registro.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE nos passos de deploy.
  Nunca imprima secrets.
- Fonte normativa: `docs/rfcs/RFC-009-polymarket-live-execution.md` — a RFC é a
  especificação; este prompt acrescenta a disciplina de deploy e as fronteiras. Em
  conflito, a RFC e o PRD vencem.
- Deploy em TRÊS passos; janela única para config+binário quando um PR tocar os dois.
  `make verify` verde por PR; PRs pequenos por fase.

## Invariantes que esta RFC introduz sem nunca violar as existentes

1. `ExecutionMode` ganha `live` **gated e desarmado por padrão** — a config continua
   falhando fechada; `paper` permanece o default absoluto; NENHUM caminho ativa live sem o
   flag explícito + as pré-condições verificadas em runtime no boot (gates PASS registrados
   + aprovação registrada — o boot RECUSA live sem os registros, fail-closed).
2. **Estratégia nunca acessa o signer** (invariante 2 do projeto, agora com signer
   existindo): o signer é componente isolado, com fronteira de módulo e guard de escopo no
   padrão dos existentes.
3. **Secrets por arquivo montado** — private key/seed da burn wallet NUNCA em env, Git,
   banco, logs, fixtures ou frontend. Você nunca vê nem pede o material: o proprietário
   monta o arquivo no servidor; o código só lê do caminho montado e falha fechado sem ele.
4. Caps do beta sobre o capital da burn wallet (PRD §6.6): entrada 2%, mercado 5%, perda
   diária 3%, drawdown 10% — vinculantes no código, além dos caps da RFC-013.
5. Kill switch e vetos da RFC-012 valem para live com no mínimo a mesma força que em paper;
   wind-down implementado antes do primeiro trade real.
6. Perímetro: NENHUMA superfície nova de escrita pública. O que precisar de ato do
   proprietário segue o padrão CLI/painel já estabelecido (rearm/gates-cli).

## Fases (cada uma com PR próprio, evidência e parada)

1. **Cliente CLOB V2 + auth de API** (maker-first, post-only; o delay de 250 ms e o
   cancelamento bloqueado de ordens marketáveis em crypto/finance são fatos da venue que o
   código respeita), sem signer real — testes contra fixtures/sandbox.
2. **Signer isolado** lendo o arquivo montado; assinatura EIP-712 dos orders; guard de
   escopo; testes de fronteira (estratégia importando signer = teste falha).
3. **Reconciliação**: fills/posições/saldo reais vs onchain e vs o esperado; fees reais vs
   simuladas (é o G4 ganhando a contraparte live); relatório de divergência.
4. **Wind-down e kill switch live**: cancelar tudo, zerar exposição, modo somente-redução —
   exercitado em teste antes de qualquer ordem real.
5. **Canário**: com o proprietário presente e o flag ativado POR ELE — menor clip possível,
   1 mercado líquido, maker-only; medir fill/fees/reconciliação; relatório imediato no
   HANDOFF. Escalar só por decisão explícita dele, degrau a degrau.

## Verificação e encerramento

- Cada fase: `make verify` + suíte PG verde + evidência em `docs/test-results/RFC-009-…`.
- O canário só acontece com o proprietário na sessão, confirmando cada passo — nenhuma
  ordem real é criada por iniciativa sua, nunca.
- HANDOFF após cada fase; status em `prompts/roadmap/README.md`.
- Condições de parada: qualquer pré-condição sem registro; qualquer caminho que enfraqueça
  paper/fail-closed; secrets fora do arquivo montado; ordem real sem o proprietário;
  `make verify` vermelho.
