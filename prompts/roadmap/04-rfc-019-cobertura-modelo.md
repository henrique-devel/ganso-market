# RFC-019 — cobertura de modelo: barreira (RFC-014) + variante updown

Você vai implementar o caminho do alpha: a variante de primeira passagem da RFC-014 (draft
existente) e a variante updown, ATÉ O FINAL: RFC/emendas → código → testes → merge → CD →
rebuild → verificação em produção → HANDOFF. Escopo aprovado pelo proprietário em
2026-08-28 (prioridade "alpha primeiro"). Depende da RFC-016 (horizonte intradia) — se ela
não estiver implementada, PARE e registre.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE nos passos de deploy.
  Nunca imprima secrets.
- Ordem de fontes: este prompt → `docs/rfcs/RFC-014-polymarket-first-passage.md` →
  RFC-010 → código. Leia `docs/HANDOFF.md` e `git log`; re-meça a cobertura atual antes de
  codar.
- Deploy em TRÊS passos; rebuild do `polymarket-estimator` é obrigatório (o modelo roda
  nele). Evidência: `/etc/ganso/release-sha` no container.
- **Invariantes que definem esta RFC:** nenhuma variante nasce servindo — TODA versão nova
  entra em `shadow` pelo catálogo do boot; a promoção continua exigindo gate PASS
  (100 mercados, não-inferioridade com IC95, nenhuma fatia de horizonte degradando > 20%)
  **+ ação manual do proprietário**. Versões de modelo são imutáveis por conteúdo. Livro
  inválido produz ausência explícita, nunca default. `make verify` verde antes de cada PR.

## Os fatos (medidos em 2026-08-28)

- Cobertura do gate: **31/100 mercados** (relatório #13, 23.172 obs), veredito
  `NO_EVIDENCE_OF_ALPHA` — e **por mérito**: Brier 0,1133 vs 0,1065 do preço; log-loss
  0,3833 vs 0,3351 com IC95 do delta **inteiramente positivo** [+0,0064, +0,0901]. Mais
  coleta da versão atual NÃO promove; só uma versão melhor.
- O sinal existe onde importa: no bucket **< 1 h o modelo BATE o preço em 13,6%** de Brier
  (0,0374 vs 0,0433) e em 1–6 h por 4,3% — nuance: são mercados TERMINAIS na reta final
  (o modelo não cobre updown). Sugestivo, não prova.
- O que o modelo recusa (corretamente, payoff de barreira ≠ distribuição terminal):
  64 de 84 mercados sem MODEL são barreira ("reach/dip to/hit/touch"); 7/7 updown de 1 h
  sem modelo. Cobertura efetiva ~10–18% da categoria.
- Ritmo de evidência: ~66 mercados rotulados/dia, só 6,9–9,7/dia cobertos. Com cobertura
  ampla: ~58–60/dia ⇒ **N=100 da variante em ~2–4 dias de resoluções**.

## Escopo

1. **Barreira (RFC-014):** implementar o draft — parser determinístico da família de
   pergunta (reach/dip/hit/touch, limiar e janela), mapa de primeira passagem (aproximação
   2·Φ documentada na RFC, com a assunção conhecida: monitoramento contínuo SUPERESTIMA
   toque em feed discreto — a RFC exige registrar esse viés, não escondê-lo). Nova versão de
   modelo no catálogo (`shadow`), features as-of sem leakage, walk-forward estratificado por
   forma de pergunta.
2. **Variante updown:** terminal com **strike = preço de abertura da janela** — a fonte do
   strike é o feed RTDS/Chainlink já gravado (o MESMO dado que resolve o mercado, zero
   basis risk) no instante `event_start_ts` da RFC-016, as-of, sem look-ahead. Se
   `event_start_ts` não existir para o mercado, a variante ABSTÉM (fail-closed).
3. **Calibração e relatório:** walk-forward com fatias por forma (terminal/barreira/updown)
   e por horizonte; o relatório diário passa a mostrar cobertura por forma. O gate de
   promoção continua o mesmo — a contagem N=100 da variante começa quando ELA começa a
   estimar.
4. **RFC-014 sai de draft** conforme o processo (status accepted → implemented com
   evidência); a variante updown entra como emenda da RFC-014 ou RFC-019 própria — siga a
   convenção do RFC_INDEX e registre a escolha.

## Verificação em produção

- Cobertura subindo: % de mercados crypto com linha MODEL/shadow (baseline: ~18%); registrar
  a curva diária.
- Zero regressão na versão terminal existente (as duas coexistem em shadow).
- Relatório de calibração seguinte com as fatias novas; acompanhar N até 100 e o primeiro
  veredito com dados da variante (esperança ≠ promessa: se vier `NO_EVIDENCE_OF_ALPHA`,
  **parar e registrar é o desenho do projeto**, não um fracasso do prompt).
- RAM do estimator dentro do limite (192 MiB; medir).

## Encerramento (obrigatório)

- Test-results no padrão do projeto; HANDOFF com cobertura antes/depois e o caminho até o
  gate; status em `prompts/roadmap/README.md`.
- Condições de parada: qualquer variante nascendo fora de `shadow`; qualquer atalho no gate
  de promoção; strike de updown vindo de fonte não gravada/as-of; `make verify` vermelho.
