# RFC-026 — Painel home broker (paper): índice das três sessões

Esta RFC é a mais longa do bloco. Ela **não** roda numa sessão só: são **três sessões, uma
por PR**, cada uma com o seu prompt autocontido e o seu "Contexto mínimo". Este arquivo só
diz a ordem, a pré-condição e qual prompt abrir. Fonte de verdade das decisões:
`docs/rfcs/RFC-026-painel-home-broker.md` (D1–D11, P1–P5, aceite A1–A7). Origem: diagnóstico de
02–03/09/2026; relatório e mockups (canvas "Ganso Market · Mesa do Operador") linkados no
cabeçalho da RFC. Tudo em SIMULAÇÃO.

## Por que três prompts e não um

Os três PRs tocam conjuntos quase disjuntos de arquivos: PR 1 é React + dois SELECTs; PR 2
é `paper/api.ts` + Nginx + teste de perímetro; PR 3 é `readapi.ts` + Nginx + SVG. Um prompt
único obrigaria a sessão a ler ~20 arquivos e passaria de 900 palavras — o contexto que
faz a IA alucinar. Cada prompt abaixo lista 3–8 arquivos e nada mais.

## Ordem

| Sessão | Prompt | Depende de | Decisão do proprietário exigida |
| --- | --- | --- | --- |
| 0 | `11-hotfixes-pr0-overview-settlement-sombra.md`, item (a) | — | — (hotfix) |
| 1 | `18a-rfc-026-pr1-mesa.md` | PR-0 (a) mergeado | P3, P4, P5 |
| 2 | `18b-rfc-026-pr2-carteira.md` | PR 1 mergeado | **P1** (dois `location =` sob `/paper`) |
| 3 | `18c-rfc-026-pr3-series.md` | PR 1 mergeado (PR 2 não é pré-requisito) | **P2** (`^~ /api/polymarket/series`) |

Sem P1 registrado no HANDOFF, a sessão 2 executa só a parte web e os filtros de
`/decisions`. Sem P2, a sessão 3 não inicia.

## Pré-condição única, verificável

`grep -n "AND occurred_at" apps/api/src/polymarket/overview.ts` deve vir **vazio** (03/09 ainda
devolve `:466`; o grep cru de `occurred_at` não serve — é alias legítimo em outras linhas). Enquanto devolver, `GET /polymarket/overview` responde 500 em produção e a
faixa da carteira — que toda tela desta RFC carrega — não tem dado. **Nenhuma das três
sessões começa antes disso.**

## O que vale para as três sessões

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre (SQL só-SELECT, logs); escrita SOMENTE
  nos passos de deploy. Nunca imprima secrets.
- Deploy em **TRÊS passos**: merge → CD → rebuild de profile. O CD recria os serviços
  default (`api`, `web`, `nginx`) e reinicia os de profile **sem trocar a imagem**; nesta
  RFC nenhum worker muda, logo o terceiro passo não se aplica. Evidência de revisão é
  `/etc/ganso/release-sha` dentro do container, não `compose ps`.
- `make verify` verde e `scripts/tests/test_nginx_perimeter.py` verde antes de cada PR.
  Teste de regressão verificado **falhando** no código anterior.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Nesta RFC: zero migration, zero biblioteca nova em `apps/web`, nenhum `replayDecision`
  tocado. Cada prompt traz a sua tabela de re-medição.
- Ao final de cada sessão: `docs/HANDOFF.md`, a tabela "Medido depois" da RFC-026 e a linha 18
  da tabela "Ordem e status" de `prompts/roadmap/README.md` (atualize-a; crie-a se faltar, no
  modelo das linhas 01–10, `README.md:38-49`: `| 18 | [RFC-026 — painel home broker](18-rfc-026-painel-home-broker.md) | RFC (3 PRs) | 11 (a) | PR n ... |`).

## Entregável deste índice

Nenhum código. Abra o prompt da sessão que couber na ordem acima e siga só ele.

## Condições de parada

- Pré-condição acima não satisfeita.
- Tentativa de executar dois PRs na mesma sessão, ou de ler além do "Contexto mínimo" do
  prompt aberto.
- Qualquer item das condições de parada da RFC-026.
