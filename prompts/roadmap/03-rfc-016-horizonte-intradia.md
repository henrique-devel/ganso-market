# RFC-016 — horizonte intradia e universo rápido

Você vai redigir e implementar a RFC-016, ATÉ O FINAL: RFC no padrão do projeto → migration
→ código → testes → merge → CD → rebuild → verificação em produção → HANDOFF. Escopo
aprovado pelo proprietário em 2026-08-28 (sequência "alpha primeiro").

**ATENÇÃO ao nome:** RFC-016 (documento) e migration **0016** (índice da FK de
panel_snapshots, já aplicada) são coisas DISTINTAS que por coincidência dividem o número.
A migration desta RFC é a **0017** (confirme o próximo número livre em `migrations/`).

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE nos passos de deploy.
  É permitido consultar a API pública da Gamma (leitura) do servidor ou local para validar
  campos. Nunca imprima secrets.
- Ordem de fontes: este prompt → `docs/PRD.md` → RFC-016 que você vai escrever → código.
  Leia `docs/HANDOFF.md` e `git log` antes; re-meça os fatos abaixo.
- Deploy são TRÊS passos; o CD aplica migrations mas NÃO troca imagem de profile; evidência
  de revisão é `/etc/ganso/release-sha` no container. Migrations aplicadas não mudam;
  mudanças de banco retrocompatíveis (rollback não desfaz migration).
- Invariantes: fail-closed; a INVARIANTE DE EVIDÊNCIA da RFC-010 fica — **uma estimativa
  precisa sobreviver `horizonte + ~27 h` para virar evidência; `budget.test.ts` segura esse
  piso e não pode ser afrouxado**. `make verify` verde antes de cada PR.

## Os fatos (verificados em 2026-08-28, contra a API real)

- A Gamma devolve **`endDate` com instante completo** (`"2026-08-28T16:00:00Z"`) e
  **`eventStartTime`** (`"2026-08-27T16:00:00Z"`); nós gravamos só `end_date_iso`
  (**date-only**: `"2026-08-28"`). Verificado no mercado
  "Bitcoin Up or Down on August 28?" (`endDateIso: 2026-08-28`, `endDate: …T16:00:00Z`).
- Consequência medida: **558 mercados crypto ativos constam "vencidos"**; nenhum mercado
  aparece com horizonte < 6 h; a cadência decidida pelo proprietário (10 s na última hora —
  bucket `lt_1h: 10000` EXISTE em `config/fundamental.json` e está correta) **nunca ativa**
  porque o horizonte calculado (`features.ts:348`: `rule end_date ?? end_date_iso`) erra;
  gap medido entre estimativas nos updown vivos: 60 s.
- Universo: cap de 100 mercados/200 tokens rejeitou ~46 mercados/dia; os updown de
  5–15 min/1 h disputam slot com mercados de meses; `capPriority` atual prioriza macro
  agendado — sem prioridade por horizonte, o universo rápido não é capturado.

## Escopo da RFC (redija o documento primeiro, no padrão do RFC_INDEX)

1. **Migration 0017 (aditiva):** `end_ts timestamptz` (e `event_start_ts`, se o desenho
   aprovar) em `polymarket_markets` E no histórico as-of
   (`polymarket_market_metadata_versions`) — nullable, backfill conforme a Gamma re-observa
   (mesmo padrão do `questionID` da RFC-012). Nada de UPDATE retroativo inventado.
2. **Captura nos DOIS call sites** — registro do universo (`registry.ts`) e varredura de
   pendentes (`samplers.ts`). Lição do PR #49: os dois caminhos consultam a Gamma com
   parâmetros diferentes; a assimetria entre eles foi a causa raiz do bug das categorias.
   Teste que cobre os dois.
3. **Consumidores passam a usar `end_ts` com fallback para `end_date_iso`:** horizonte das
   features (RFC-010), buckets de cadência, labels, priorização. Auditar TODOS os leitores
   de `end_date_iso` (grep) e decidir um a um, com o motivo no PR.
4. **Cadência de 10 s ativando de verdade:** re-modelar `budget.test.ts` com a distribuição
   real de horizontes agora legível — o volume de estimativas nos mercados curtos SOBE por
   desenho (é a decisão de 2026-08-22 finalmente valendo). Verificar contra a quota de 2 GB
   de `fundamental_estimates`; se o teto apertar, o ajuste é decisão do proprietário, não
   afrouxamento silencioso do piso `horizonte + 27 h`.
5. **Prioridade por horizonte no cap do universo:** mercados curtos ganham prioridade
   explícita (desenho a propor na RFC: reserva de slots por bucket, mantendo macro
   agendado). Muda o que é gravado — declare na RFC o efeito esperado no giro de universo
   (~1.586 enter/exit por semana hoje).
6. **Exposição para consumo futuro:** horizonte real nos payloads de leitura já publicados
   (opportunities/resolution-risk) para a futura aba "Rápidos" (RFC-015) — sem location novo
   no Nginx nesta RFC.

## Verificação em produção (depois do deploy completo)

- Distribuição de horizonte sã: ~0 mercados ativos "vencidos" com `end_ts` presente;
  updown de 1 h aparecendo no bucket < 1 h.
- `tokens_considered`/linhas por token nos updown vivos na última hora de vida: gap ~10 s
  (era 60 s).
- Volume de `fundamental_estimates` nas primeiras 48 h dentro da quota (medir e registrar
  a taxa nova; comparar com o modelo do `budget.test.ts`).
- Zero erros novos em recorder/estimator; universo com os buckets curtos entrando
  (registrar o giro).

## Encerramento (obrigatório)

- RFC-016 com status `implemented` só com evidência (test-results no padrão do projeto);
  RFC_INDEX atualizado; HANDOFF com os números medidos; status em
  `prompts/roadmap/README.md`.
- Condições de parada: afrouxar o piso `horizonte + 27 h`; UPDATE retroativo em histórico
  imutável; quota estourando sem decisão do proprietário; `make verify` vermelho.
