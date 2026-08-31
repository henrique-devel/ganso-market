# DECISÃO + PR — redeclaração consciente da quota de `book_deltas`

Você vai preparar a decisão da quota com dado medido, apresentá-la ao proprietário e, com a
resposta dele, cunhar o número, ATÉ O FINAL: medição → opções → decisão dele → PR →
deploy → verificação → HANDOFF. Decisão de 2026-08-28: **a quota é redeclarada
conscientemente — o alarme não decide**.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE no deploy do PR final.
  Nunca imprima secrets.
- Leia `docs/HANDOFF.md` (seção "Dado para a redeclaração da quota", sessão 31/08) e
  `git log`; a janela de observação decidida fecha **~2026-09-04** — se você estiver rodando
  antes, PARE e registre quanto falta.
- A ESCOLHA do número é do proprietário. Este prompt autoriza preparar, perguntar e
  implementar a resposta — não escolher por ele.

## Dado já medido (30–31/08; complete a série)

- Pós-VACUUM FULL: banco caiu de 116 → **38 GB**; `book_deltas` cresce
  **~3,3 GB/dia físico líquido** (bem abaixo dos ~15 GB/dia pré-repack — o rewrite físico
  também compactou o ritmo de crescimento aparente).
- Quota vigente: **52 GiB** (`retention.ts`); orçamento global 110 GiB; gatilho do alarme
  99 GiB; invariante testada: soma das quotas declaradas < gatilho.
- Consumidores da janela de deltas: replay de book (RFC-007), features de microestrutura
  (RFC-011), G4 (reconciliação) e a leitura de mercado da RFC-013.

## Tarefa

1. **Completar a medição** (≥1 semana pós-repack): linhas/dia e GB/dia físico e vivo;
   janela retida real por token (min/max e a cauda coverage-gated — os tokens presos por
   `SERIES_COVERAGE_MISSING` ainda existem? quantos, quantas linhas?); projeção de
   estabilização (a quota atual compra quantos dias no ritmo medido?).
2. **Montar a tabela de opções para o proprietário** — cada linha: quota candidata → dias
   de microestrutura retidos → % do orçamento global → folga até o gatilho do alarme →
   efeito nos consumidores (replay/G4). Inclua ao menos: manter 52 GiB; uma opção que
   compre ~7 dias; uma que compre ~14; e o custo/risco de cada uma. Sem recomendação
   escondida: recomende UMA explicitamente, com o porquê.
3. **Perguntar ao proprietário e esperar a resposta.** Sem resposta, não há PR.
4. **PR**: o número escolhido em `retention.ts`, o teste da invariante
   (quotas < gatilho) atualizado, e o racional VERBATIM no HANDOFF (o que foi apresentado,
   o que ele escolheu, quando).
5. **Deploy**: merge → CD → rebuild do `polymarket-recorder` (a retenção roda nele) →
   verificar a primeira varredura com a quota nova (satisfeita ou podando na direção certa,
   sem `RETENTION_QUOTA_UNMET` espúrio).

## Encerramento

- HANDOFF + status em `prompts/roadmap/README.md`.
- Condições de parada: janela de observação incompleta; escolher o número sem o
  proprietário; quota que viole a invariante quotas < gatilho; qualquer mudança fora de
  `retention.ts`/testes/docs.
