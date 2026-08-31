# RFC-017 — shadow replay: varredura de config e replay contrafactual de fonte

Você vai construir a ferramenta de shadow replay com OS DOIS modos aprovados pelo
proprietário em 2026-08-28, ATÉ O FINAL: RFC → código → testes → merge → CD → rebuild →
primeira rodada real em produção → HANDOFF.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy. A rodada da
  ferramenta em produção é read-only por construção (o CLI recusa qualquer escrita). Nunca
  imprima secrets.
- Ordem de fontes: este prompt → decisões do proprietário (HANDOFF, 27–28/08) → RFC-013
  tarefa 7 → código. Leia `docs/HANDOFF.md` e `git log`; re-meça a janela real do decision
  log antes de desenhar (pós-migration-0016 a poda fecha; a janela muda com o tempo).
- Deploy em TRÊS passos; o CLI roda dentro do container da `api` (padrão `gates-cli`:
  `docker compose exec -T api node apps/api/dist/<nome>.js`).
- Invariantes: `replayDecision` e seu check de hash (`CONFIG_HASH_MISMATCH`) NÃO mudam — o
  modo contrafactual é um caminho NOVO e explícito ao lado dele; NUNCA gravar config
  candidata em `portfolio_config_versions` (cunhar versão é ato do proprietário); o sweep
  importa `entryDecisionRow`/`exitDecisionRow` de `decisionrow.ts` — um TERCEIRO construtor
  de linha é proibido e o review deve verificar. `make verify` verde antes de cada PR.

## Contexto (medido em 28/08; re-meça)

- O replay determinístico da RFC-013 t.7 existe e roda (auditoria horária das 50 decisões
  mais novas, `PORTFOLIO_REPLAY_OK`). `inputs_json.replay` guarda ~24 escalares de entrada e
  ~26 de saída em 9 dígitos (`replay.ts`); o book vem de `book_json`.
- `loadRecentDecisions` (gatestore) NÃO pagina — a varredura precisa de loader keyset novo
  (`decision_id ASC`, cursor, streaming; a janela cheia não cabe em memória num container
  de 384 MiB).
- `capitalCostAnnual = 0.12` na config 1.2.0; na entrada cobra só o excedente sobre o hurdle
  (`ev.ts` — morde quando `r > 0,1825/p`); na saída já é vinculante. O número da varredura
  cunha a **1.3.0** — não antes.
- População: entradas ACCEPTED são raras (baseline); se o log da janela tiver poucos
  aceites, as % de flip tendem a zero por construção — as métricas de MARGEM são o headline
  honesto (lente de degeneração: não deixar a varredura "passar porque não havia contra o
  que comparar").

## Modo A — varredura de config (decisão 2 de 27/08)

- CLI: `sweep <caminho.da.chave> --values 0.12,0.15,0.183,0.20,0.25,0.30,0.365,0.40`
  (a taxa gravada 0.12 SEMPRE na lista — linha de controle que deve dar zero).
- Por decisão: (1) baseline obrigatório — `replayDecision` com a config gravada tem que dar
  `MATCHED`; mismatch exclui e conta (`baseline_mismatch`) — drift de motor nunca vira sinal;
  (2) clonar a config trocando SÓ a chave; (3) re-derivar com
  `deserializeEntryReplay`/`evaluateMarket`/`entryDecisionRow` (e o trio de exit);
  (4) classificar: veredito muda? tamanho muda (Δ mediano/p90)? binding constraint novo (top
  transições)? Δ edge_net/custos? excedente passou a > 0?
- Agregação com DUPLA ponderação (por linha E por mercado distinto) — o log grava uma linha
  por mercado por ciclo e mercados longevos dominariam a % por linha.
- Saída: stdout `--format table|json` + bloco de proveniência (janela, versões, contagens).
  A rodada escolhida vai VERBATIM para o HANDOFF. Sem tabela nova, sem painel nesta RFC.
- Generalização: aceitar caminho de chave arbitrário dentre os replayáveis (safetyMargin,
  edgeLiqMin, priceBand, kelly.*, depth.takePct, exits.*); documentar a recusa dos
  não-replayáveis (breakers.jumpThreshold, lossLimits.*) com o motivo.

## Modo B — replay de fonte (aprovado em 28/08): "e se fosse o shadow?"

- Pergunta: as decisões teriam sido diferentes se o `q/q_lo/q_hi` viesse das linhas
  MODEL/shadow de `fundamental_estimates` (as-of o `decision_ts`, sem look-ahead) em vez do
  baseline? E, cruzando com `fundamental_labels`, qual o PnL contrafactual das entradas que
  o shadow teria aceitado (com os custos do próprio motor)?
- Diferença estrutural do modo A: LÊ tabelas de mercado (estimates + labels) — é ferramenta
  de análise offline, não auditoria; declare isso no output. Janela limitada pelo overlap
  decision-log × estimates retidos; medir e imprimir a janela coberta.
- Regras de honestidade: shadow ausente no instante → decisão excluída e contada (nunca
  interpolar); PnL contrafactual usa os MESMOS custos/degradação conservadora do ledger
  (coluna base), rotulado como hipotético; resultado alimenta a decisão de promoção, não a
  substitui (o gate da RFC-010 continua soberano).

## Testes

- Modo A: taxa acima do cruzamento flipa linha sintética ACCEPTED→REJECTED e muda binding
  constraint; taxa 0.12 → zero mudanças (controle); baseline mismatch exclui; determinismo
  byte a byte entre duas rodadas; ponderação linha vs mercado.
- Modo B: shadow ausente exclui; as-of sem look-ahead (teste com estimativa posterior ao
  decision_ts NÃO usada); PnL contrafactual bate conta feita à mão em fixture pequena.
- `make verify` verde; nenhum teste toca tabelas de produção.

## Deploy, primeira rodada e encerramento

1. Merge → CD → rebuild da `api` (onde o CLI vive). Conferir `release-sha`.
2. Primeira rodada real (read-only) dos DOIS modos; registrar janela, contagens e a tabela
   no HANDOFF. O número de `capitalCostAnnual` que sai do modo A é apresentado ao
   proprietário — **a cunhagem da 1.3.0 é decisão dele, em janela única config+rebuild**.
3. NUNCA varrer janela que atravesse o deploy da mudança de cadência de escrita do decision
   log (RFC-018) — densidades diferentes na mesma população.
4. HANDOFF + status em `prompts/roadmap/README.md`. Condições de parada: escrita em
   qualquer tabela; terceiro construtor de linha; check de hash do replay de auditoria
   tocado; `make verify` vermelho.
