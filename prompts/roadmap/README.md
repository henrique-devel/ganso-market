# Roadmap de prompts — do estado de 2026-08-31 até a execução real

Esta pasta contém os prompts operacionais, **um por sessão de IA**, que levam o projeto do
estado de 2026-08-31 até a execução real (RFC-009). Cada prompt é **autocontido**: carrega a
autorização de SSH, as regras de deploy e os fatos medidos de que precisa — pode ser colado
numa sessão nova sem nenhum outro contexto além do repositório.

Origem: diagnóstico completo de 2026-08-28 e as **7 decisões do proprietário** do mesmo dia
(registradas no HANDOFF): shadow replay com os dois modos; publicação de
`GET /paper/performance` aprovada (location exato); quota de `book_deltas` redeclarada
conscientemente; janela de pg_repack autorizada (executada); backup mínimo recusado (risco
mantido); fix do fingerprint G2/G5 autorizado (entregue); **prioridade invertida — alpha
primeiro, dashboard depois**.

## O que JÁ FOI FEITO (não há prompt para isso — não re-execute)

Bloco de hotfixes de 28/08, verificado e com soak fechado em 31/08 (PRs #50–#59):
medidor de quota em bytes vivos reais (#50); fingerprint do G2/G5 = schedule da venue (#51 —
**o piso de 60 dias conta desde 2026-08-28 20:38:47Z → melhor caso G2/G5 ≈ 2026-10-27**);
graça de 180 s no cancel por lag (#52); coletor onchain vivo (#53 — a causa real era
histórico podado do RPC); batch do DELETE orçado por bytes (#54); VACUUM FULL recuperou
78 GB (banco 116 → 38 GB); migration 0016 (índice da FK) destravou a poda de
`portfolio_decisions` (449 k linhas na primeira rodada). Kill switch rearmado pelo
proprietário em 31/08 18:21Z. Duas sessões já foram desperdiçadas re-recebendo prompts de
trabalho concluído — **todo prompt desta pasta manda re-medir antes de agir; honre a parada**.

## Como usar

1. Uma sessão por prompt, na ordem abaixo (∥ = pode rodar em paralelo/quando der).
2. Todo prompt começa mandando ler `docs/HANDOFF.md` e conferir `git log`: se outro prompt já
   entregou parte do escopo, a sessão adapta ou para.
3. O prompt mestre (`prompts/AI_DEVELOPER_SYSTEM_PROMPT.md`) continua sendo o sistema base;
   estes arquivos são o "pedido do proprietário" de cada sessão.
4. Ao concluir, a sessão atualiza o HANDOFF e a coluna de status abaixo.

### Bloco 11–21 — do diagnóstico de 02–03/09 até "paper rodando fluido em sombra + telas novas"

Os prompts **11–21** saem do diagnóstico operacional de 02–03/09/2026 (relatório publicado e
canvas "Mesa do Operador", linkados no cabeçalho de cada RFC) e formam um bloco novo depois do
NO-GO do checklist 09: primeiro os hotfixes sem RFC (PR-0: `/overview` 500, liquidação travada,
sombra vazando), depois a infraestrutura que torna qualquer medição confiável (RFC-020 deploy sem
derrubar o banco, RFC-021 silêncio do feed e kill switch, RFC-023 orçamento da API), em seguida o
funil do paper (RFC-022 ponte e saídas, RFC-024 descoberta e livro do universo rápido, RFC-025
disjuntor `PARAM_CHANGE`), e por fim as telas e a primeira estratégia em sombra (RFC-026 painel
home broker, RFC-027 funil e Sistema, RFC-028 `fast_btc_updown` em sombra, RFC-029 tela Sombra).
Nenhum prompt habilita execução real, afrouxa gate, cria endpoint de escrita ou contorna
disjuntor; a ordem da tabela é a ordem de dependência, cada prompt lista o **contexto mínimo**
que a sessão deve ler (3–8 arquivos) e todo prompt manda re-medir antes de codar. Fora do bloco,
registradas no relatório para depois: persistência do replay por mercado/forma/braço (030), RTDS
por símbolo e feed spot (031), universo estimado e higiene do modelo (032), categoria macro.

## Ordem e status

| # | Prompt | Tipo | Depende de | Status |
|---|--------|------|------------|--------|
| 01 ∥ | [Metadata version missing recorrente](01-hotfix-metadata-version-missing.md) | hotfix | — | **CONCLUÍDO** (PR #61, 31/08 20:45Z) — causa raiz medida, corrigida sem migration, **verificada em produção** (~78/dia → 0, as duas causas confirmadas com o input que as disparava); soak de 24 h confirmatório |
| 02 ∥ | [Nowcasts no calendário macro + sync com retry](02-dados-nowcasts-macro.md) | dado + hardening | — | **CONCLUÍDO com ressalva** (PR #63, 31/08 22:20Z) — nowcast do Cleveland Fed em `cpi-2026-09` (keyed por variável, com fonte); 14 entradas seguem sem consenso **por falta de fonte oficial**, motivo de cada uma no arquivo; sync do calendário agora no job de 10 min. **A medição desmentiu a premissa**: os 22 mercados macro de produção falham em `UNRECOGNIZED_VARIABLE` antes do consenso — são mercados de MUDANÇA de juros e o modelo precifica NÍVEL. Não destrava a categoria; virou decisão do proprietário (ver HANDOFF) |
| 03 | [RFC-016 — horizonte intradia](03-rfc-016-horizonte-intradia.md) | RFC | — | **CONCLUÍDO com o diagnóstico corrigido** (PR #66, 31/08 23:57Z) — a re-medição desmentiu 5 das 7 premissas (a cadência de 10 s já estava ativa desde 23/08; os "558 vencidos" são linhas obsoletas; o cap não morde desde 29/08). O defeito real era outro e maior: o **label store** lia a coluna date-only e a calibração descartava **38.200 de 74.412** estimativas MODEL, **8.063 de 8.063** na última hora de vida. Migration 0017 (`end_ts`), captura nos dois call sites, 11 consumidores auditados, reserva de 25 slots do cap. **Verificado em produção**: labels à meia-noite 94% → 2,9%, pontuáveis 36.212 → 74.412, última hora 0 → 8.063, janelas finas em mercado longo 75% → 0, zero erros. Carimbo do bucket confirmado às 00:27Z (`priority_2_crypto_1d_7d`). Sobra: re-medir a taxa de volume em 48 h e ver se `paper_feature_windows` desce abaixo da quota |
| 04 | [RFC-019 — cobertura de modelo (barreira + updown)](04-rfc-019-cobertura-modelo.md) | RFC | 03 | **CONCLUÍDO com três premissas desmentidas** (PR #70, 01/09) — `event_start_ts` NÃO existe (a D2 da RFC-016 já o tinha medido `null` em 100/100; a abertura da janela passou a ser derivada do fim real menos a duração do título), a resolução real é **candle Binance** e não Chainlink (o "zero basis risk" do prompt caiu; viés registrado, não escondido) e o **RTDS só entrega BTC** (teto de cobertura é a população BTC; investigação do recorder aberta). Entregue como UMA versão, `crypto_updown_gbm@1.1.0`, com barreira + updown, coexistindo em `shadow` com a 1.0.0 intocada. Revisão adversarial de 6 lentes fechou 7 defeitos (2 introduzidos na própria sessão). Parser: **26 → 51** dos 54 mercados vivos; servível: **20 → 41**. Gate intocado; nenhuma promoção |
| 05 | [RFC-017 — shadow replay (dois modos)](05-rfc-017-shadow-replay.md) | RFC | ideal após 04 | **CONCLUÍDO com três premissas desmentidas** (PRs #72 e #73, 01/09) — CLI read-only por construção, os dois modos rodados em produção. (1) O denominador não é o log, são **9,05% dele**: 20.340 de 224.647 linhas chegam à conta, o resto foi decidido por escalar já persistido. (2) `capitalCostAnnual` **não muda nenhuma decisão** em toda a lista até 0,40 — nem além de 100.000% a.a.; o lockup do livro é de horas e a carga fica 200× abaixo do `edgeLiqMin`. A cunhagem da 1.3.0 volta ao proprietário como decisão sobre o UNIVERSO, não sobre a taxa. (3) **Parte das decisões já usa o shadow** — `estimateAsOf` não filtra `status` nem desempata; 5 decisões de 01/09 com `estimate_source='MODEL'` e zero modelos promovidos (nenhuma aceita). Defeito da RFC-010, registrado e fora do escopo. Modo B: o shadow teria agido diferente em **519 linhas (20,1%) / 9 mercados (40,9%)**, com 511 entradas só dele — **PnL contrafactual ainda não medível** (0 de 515 com label final). A própria rodada seca pegou dois defeitos de medição na ferramenta (AÇÃO somada ao MOTIVO; deltas na escala da coluna e não do motor) |
| 06 | [RFC-015 — dashboard do operador](06-rfc-015-dashboard-operador.md) | RFC | ideal após 03 | **CONCLUÍDO** (PR #76, 01/09 23:14Z) — faixa de PnL em todas as abas, aba "Visão geral" default com `GET /overview` + feed keyset `GET /events`, dicionário PT, `unknown` rotulado; perímetro publicado e **verificado no servidor** (401 sem sessão, 404 em todo método errado, escritas seguem 404). **Duas premissas do prompt caíram:** o 500 do `/decisions` era `statement_timeout = 1000 ms` da API contra um seq scan de 715 ms (corrigido: 0,17 ms), e o `/opportunities` tinha o mesmo defeito a 786 ms com sort em disco (corrigido: 24 ms medidos em produção). A aba "Rápidos" entrou (RFC-016 está em produção) e é verificada **vazia na fatia < 6 h**: o universo não tinha nenhum mercado nessa janela. |
| 07 | [RFC-018 — gates e calibração](07-rfc-018-gates-calibracao.md) | RFC | — | **CONCLUÍDO com três premissas desmentidas** (PRs #79–#84, 02/09 01:15Z) — decision log grava só quando o veredito muda: **fator medido 8,6× no log histórico e 8,2× verificado em produção** (91,3 → 11,1 linhas/min), com o painel mantendo a cadência. **(1)** `DATA_STALENESS` NÃO estava por exercitar (58 aberturas desde 28/08) — faltavam dois breakers, não três. **(2)** O TTL de 90 dias continua NÃO sendo o limite que vale: a quota entrega ~19 dias. **(3)** A chave nova do cap **não devolve teto ao livro** — o bucket gigante continua com 81,5%, porque é verdade que 81,5% do universo resolve pelo candle da Binance; o que muda é do que o bucket fala. O `UMA_PROPOSED_OR_DISPUTED` era **defeito**: a metade `proposed` nunca chegava ao módulo, e havia prova real datada (posição sob proposta viva por ~10 ciclos, em silêncio). `RULE_CLARIFICATION` fica esperando dado real **por decisão do proprietário**. `models-cli` fecha o bloqueio do registro de versão. A própria verificação achou órfãos em `portfolio_exposures` que prenderiam o G3 em FAIL (PR #84) |
| 08 | [Redeclaração da quota de book_deltas](08-redeclaracao-quota-book-deltas.md) | decisão + PR | dado fecha ~2026-09-04 | **CONCLUÍDO com a janela encurtada pelo proprietário** (02/09) — a quota foi **redeclarada e MANTIDA em 52 GiB**. O número não muda; o racional muda inteiro: os ~15,3 GB/dia que o justificaram eram taxa **inchada**, e a linha custa **313,67 B vivos** (o arquivo concorda em ~319 B/linha, `n_dead_tup = 0`). No ritmo medido (11,33 / 13,69 / 15,59 M linhas/dia) a quota entrega **15,7 / 13,0 / 11,4 dias** contra o TTL declarado de 14 — quota e TTL convergem pela primeira vez, depois de terem valido 3,4 dias. A janela de observação de 28/08 fechava 04/09 21:06Z e **faltavam 2 d 19 h**: o proprietário dispensou a espera com a série na mesa (registrado). **Achado maior que o escopo:** a poda de `book_deltas` está **TRAVADA** — 161 de 161 tokens presos no próprio minuto mais antigo, **0 linhas liberáveis**; 223 minutos descobertos em 267.635 (**0,08%**) bloqueiam 7,21 GiB, e tolerar o minuto de borda liberaria 24,1 M linhas (7,04 GiB). O gate **se auto-trava** (para no buraco, o buraco vira a borda), provado por controle positivo. O TTL de 14 d morde em ~03/09 01:26Z e vai apagar zero → corrigido no **PR #89** (travessia só da borda, com o teste de regressão verificado falhando no código anterior) |
| 09 | [Checklist pré-live](09-checklist-pre-live.md) | verificação | gates PASS | **CONCLUÍDO — veredito NO-GO** (02/09) — os **seis** gates em `INSUFFICIENT_DATA` (medidos 02/09 13:32:48Z, config 1.2.0), `rfc_009_status` = `BLOCKED`. O relatório (`report_id` 1) **não está velho**: foi cunhado no instante exato do último câmbio de veredito (G3 `FAIL`→`INSUFFICIENT_DATA`, 27/08 03:11:02.307Z) e nenhuma das 190 medições seguintes moveu um veredito. Replay limpo (17× OK, 50/50, zero mismatch); zero erros em 6 dos 7 serviços. **O achado reorganiza o calendário:** o book de paper **nunca fechou uma posição** — 0 eventos `resolution` em toda a história do ledger, 2 fills e 16 cancelamentos em 18 pedidos, 1.201 mercados e 0 `closed`. Não é espera, é defeito: o settlement lê `payload_json.outcomePrices` (`brokerstore.ts:2462`) e o coletor grava em `payload_json.raw.outcomePrices` — `prices=[]` faz o guard de `broker.ts:183` disparar pelo segundo termo e reportar `TOKEN_NOT_IN_MARKET` para um token que é o `clob_token_ids[0]` **e** o `affirmative_token_id`. O mercado BTC resolveu na venue em 01/09 16:37:12Z; o erro repete 1×/min desde então (772 em 24 h, a linha mais antiga retida é 02/09 01:16:05Z). `store.ts:727`, `timeline.ts:73` e `labels.ts:59` já tratam os dois caminhos — só o paper não, e é por isso que o G1 vê 485 resolvidos e o G2 vê 0. **G2/G4 ficam em 0 para sempre até o fix.** Prompt 10 **NÃO liberado** |
| 10 | [RFC-009 — execução real](10-rfc-009-execucao-real.md) | RFC | 09 completo | **BLOQUEADO** — o checklist 09 deu NO-GO; não iniciar |
| 11 | [PR-0 — três hotfixes sem RFC: `/overview` 500, liquidação travada, sombra vazando](11-hotfixes-pr0-overview-settlement-sombra.md) | hotfix (3 PRs) | — (PR-c exige autorização do proprietário no HANDOFF) | **CONCLUÍDO em 2 de 3 — o (c) parou por falta de autorização** (PRs #93 e #94, merge `c14fd53`, 04/09 21:17Z). **O número da sessão: o livro de paper fechou a PRIMEIRA posição da sua história às 21:23:56.924Z** — `event_id` 15543, `outcome_price` 0,000000, perda realizada **US$ −4,6227** em `0x71b5721c…` (a previsão do prompt era ≈ US$ 4,62), e o `PAPER_RESOLUTION_DATA_ERROR` de 1×/min **cessou** (1.440/24 h → 0). `closed_positions = 0` era defeito, não soak: o **G2** estava em 0 para sempre. Na primeira medição posterior ao fechamento (22:23:18.794Z) o **G2 saiu de zero**: `closed_positions` 0 → **1**, `distinct_markets` 0 → **1**, `distinct_close_days` 0 → **1**, `categories` 0 → **1** — segue `INSUFFICIENT_DATA` (1 de 100), porque o que mudou é a **natureza do bloqueio**, não o veredito: de defeito que nenhuma espera resolveria para amostra que acumula. Nenhum limiar tocado. **Uma afirmação do prompt e do checklist 09 cai aqui:** o fix **não** destrava o G4 — `fee_samples` e `slippage_samples` seguem 0 e não olham para fechamento nenhum; `reconcile` (`measure.ts:241`) conta fills takers com referência `VENUE_TRADE_FEED`/`DECISION_BOOK`, e o ledger tem **2 fills** em toda a sua história. O gargalo do G4 é vazão de ordens (kill switch engatado), não liquidação. **(a)** `occurred_at` → `event_ts`; o `logOverviewError` gravava só `error_name`, que para o driver `pg` é a string `"error"` — o reason code era **alarme mudo**, e é por isso que o 500 durou três dias. Novo `overview.pg.test.ts` com pool real: a suíte antiga respondia toda query com pool falso, então coluna inexistente voltava `[]` e a rota dava 200 — o teste concordava com o código contra a realidade. **(b)** além de ler as duas formas do payload, `resolveOutcomeForToken` separou dois defeitos que respondiam o mesmo reason code: o que produção emitia 60×/h era `index >= length` (token presente, preço ausente) reportado como `TOKEN_NOT_IN_MARKET` — agora `RESOLUTION_PRICES_MISSING`. **(c) NÃO ABERTO, zero linhas de código:** o HANDOFF diz "fica como decisão do proprietário", que é registro e não autorização. A re-medição mostra o defeito **crescendo** — 159 → **179** decisões `estimate_source='MODEL'` e **6 → 11 aceitas**, com zero modelos `active`. **Uma armadilha de medição no próprio prompt:** o `grep -c occurred_at` de 24 h devolve **0**, e não porque está corrigido — o `postgres` tinha 7 h de vida (`--force-recreate`) e houve **0 chamadas** ao `/overview` na janela. Zero sem denominador é ausência de medição, não aprovação. Falta só um clique do proprietário: a linha `status_code:200` exige sessão dele |
| 12 | [RFC-020 — deploy que não derruba o banco](12-rfc-020-deploy.md) | RFC (4 PRs) | 11; DP1 e DP2 aprovadas | pendente |
| 13 | [RFC-021 — silêncio do feed com conexões vivas e kill switch honesto](13-rfc-021-feed-kill-switch.md) | RFC (3 PRs) | 12 em produção; P1 decide o rearme | pendente |
| 14 | [RFC-022 — ponte decisão→ordem, graça do runtime e saídas](14-rfc-022-ponte-runtime-saidas.md) | RFC (3 PRs) | 11 (b); P1–P3 | pendente |
| 15 | [RFC-023 — orçamento da API por endpoint, erros com mensagem, `/live-volume`](15-rfc-023-timeout-erros.md) | RFC (3 PRs) | 11 (a); 12 antes do PR 2 | pendente |
| 16 | [RFC-024 — descoberta por série e livro garantido para o universo rápido](16-rfc-024-descoberta-livro.md) | RFC (2–3 PRs) | 12, 13 em produção; P1 e P3 | pendente |
| 17 | [RFC-025 — disjuntor `PARAM_CHANGE` abre em mudança real, não em nascimento](17-rfc-025-param-change.md) | RFC (2–3 PRs) | P1 registrado na RFC | pendente |
| 18 | [RFC-026 — painel home broker (índice das três sessões)](18-rfc-026-painel-home-broker.md) | índice | 11 (a) | pendente |
| 18a | [RFC-026 · PR 1 — Mesa](18a-rfc-026-pr1-mesa.md) | RFC (PR 1) | 11 (a); P3–P5 | pendente |
| 18b | [RFC-026 · PR 2 — Carteira](18b-rfc-026-pr2-carteira.md) | RFC (PR 2) | 18a; P1 | pendente |
| 18c | [RFC-026 · PR 3 — Séries de preço](18c-rfc-026-pr3-series.md) | RFC (PR 3) | 18a; P2 | pendente |
| 19 | [RFC-027 — Decisões como funil e Sistema com natureza do bloqueio](19-rfc-027-funil-sistema.md) | RFC (2 PRs) | 18a; ideal após 15 | pendente |
| 20a | [RFC-028 · Parte A — `fast.json` 0.1.0, policy própria, backtest e migration](20a-rfc-028-estrategia-fast-config-policy.md) | RFC (PRs 1–2) | 11 (b), 14, 17; P1–P5 | pendente |
| 20b | [RFC-028 · Parte B — worker `fast` em sombra, filtro, API GET-only e chip](20b-rfc-028-estrategia-fast-sombra-api.md) | RFC (PRs 3–4) | 20a; 11 (b), 14, 17 em produção; P8 | pendente |
| 21 | [RFC-029 — tela Sombra: shadow replay por job diário](21-rfc-029-tela-sombra.md) | RFC (3 PRs) | 18a; emenda da RFC-017 (P1); P2, P3 | pendente |
| ∥ | Trilha humana: parecer jurídico/tributário, capital real, burn wallet Polygon | proprietário | — | pendente — **pode começar hoje**; maior lead time do caminho |

Calendário **corrigido pela medição de 02/09**: a data de 27/10 é do **G5 apenas** — é a única
com data mecânica (piso de 60 dias desde 28/08 20:38:47Z, `fingerprint_mismatch` vazio). O G2
**não** é datado pelo relógio: precisa de 100 posições fechadas e a taxa realizada é de **2 fills
em 5,2 dias (~0,38/dia)** contra os **2–3/dia** que o próprio `brokerstore.ts:60` diz que o gate
exige — ~6× abaixo, ou ~260 dias, e isso **depois** de destravar o settlement. G4 segue o G2; G1
espera um modelo promovido (os 3 existentes são todos `shadow`). O caminho crítico não é o
calendário: é o settlement travado, a vazão de fills e um modelo com alpha.

## Convenções que todo prompt desta pasta carrega

- **Autorização de SSH** ao servidor de produção (leitura livre; escrita só nos passos de
  deploy/manutenção descritos no próprio prompt).
- Deploy em **três passos** (merge → CD → rebuild de profile); o CD reinicia os containers de
  profile a cada merge **sem trocar a imagem**; a evidência de revisão é
  `/etc/ganso/release-sha` dentro do container.
- Invariantes intocáveis (paper-only, fail-closed, gates não afrouxam, money em texto decimal (colunas `TEXT` nas migrations; nunca `number`),
  migrations aplicadas não mudam) e teste de regressão verificado falhando no código anterior.
- Re-medição antes de codar: os fatos citados foram medidos em 28–31/08 e podem ter mudado.
