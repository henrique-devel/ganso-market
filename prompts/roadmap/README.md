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

## Ordem e status

| # | Prompt | Tipo | Depende de | Status |
|---|--------|------|------------|--------|
| 01 ∥ | [Metadata version missing recorrente](01-hotfix-metadata-version-missing.md) | hotfix | — | **CONCLUÍDO** (PR #61, 31/08 20:45Z) — causa raiz medida, corrigida sem migration, **verificada em produção** (~78/dia → 0, as duas causas confirmadas com o input que as disparava); soak de 24 h confirmatório |
| 02 ∥ | [Nowcasts no calendário macro + sync com retry](02-dados-nowcasts-macro.md) | dado + hardening | — | **CONCLUÍDO com ressalva** (PR #63, 31/08 22:20Z) — nowcast do Cleveland Fed em `cpi-2026-09` (keyed por variável, com fonte); 14 entradas seguem sem consenso **por falta de fonte oficial**, motivo de cada uma no arquivo; sync do calendário agora no job de 10 min. **A medição desmentiu a premissa**: os 22 mercados macro de produção falham em `UNRECOGNIZED_VARIABLE` antes do consenso — são mercados de MUDANÇA de juros e o modelo precifica NÍVEL. Não destrava a categoria; virou decisão do proprietário (ver HANDOFF) |
| 03 | [RFC-016 — horizonte intradia](03-rfc-016-horizonte-intradia.md) | RFC | — | **CONCLUÍDO com o diagnóstico corrigido** (PR #66, 31/08 23:57Z) — a re-medição desmentiu 5 das 7 premissas (a cadência de 10 s já estava ativa desde 23/08; os "558 vencidos" são linhas obsoletas; o cap não morde desde 29/08). O defeito real era outro e maior: o **label store** lia a coluna date-only e a calibração descartava **38.200 de 74.412** estimativas MODEL, **8.063 de 8.063** na última hora de vida. Migration 0017 (`end_ts`), captura nos dois call sites, 11 consumidores auditados, reserva de 25 slots do cap. **Verificado em produção**: labels à meia-noite 94% → 2,9%, pontuáveis 36.212 → 74.412, última hora 0 → 8.063, janelas finas em mercado longo 75% → 0, zero erros. Carimbo do bucket confirmado às 00:27Z (`priority_2_crypto_1d_7d`). Sobra: re-medir a taxa de volume em 48 h e ver se `paper_feature_windows` desce abaixo da quota |
| 04 | [RFC-019 — cobertura de modelo (barreira + updown)](04-rfc-019-cobertura-modelo.md) | RFC | 03 | **CONCLUÍDO com três premissas desmentidas** (PR #70, 01/09) — `event_start_ts` NÃO existe (a D2 da RFC-016 já o tinha medido `null` em 100/100; a abertura da janela passou a ser derivada do fim real menos a duração do título), a resolução real é **candle Binance** e não Chainlink (o "zero basis risk" do prompt caiu; viés registrado, não escondido) e o **RTDS só entrega BTC** (teto de cobertura é a população BTC; investigação do recorder aberta). Entregue como UMA versão, `crypto_updown_gbm@1.1.0`, com barreira + updown, coexistindo em `shadow` com a 1.0.0 intocada. Revisão adversarial de 6 lentes fechou 7 defeitos (2 introduzidos na própria sessão). Parser: **26 → 51** dos 54 mercados vivos; servível: **20 → 41**. Gate intocado; nenhuma promoção |
| 05 | [RFC-017 — shadow replay (dois modos)](05-rfc-017-shadow-replay.md) | RFC | ideal após 04 | **CONCLUÍDO com três premissas desmentidas** (PRs #72 e #73, 01/09) — CLI read-only por construção, os dois modos rodados em produção. (1) O denominador não é o log, são **9,05% dele**: 20.340 de 224.647 linhas chegam à conta, o resto foi decidido por escalar já persistido. (2) `capitalCostAnnual` **não muda nenhuma decisão** em toda a lista até 0,40 — nem além de 100.000% a.a.; o lockup do livro é de horas e a carga fica 200× abaixo do `edgeLiqMin`. A cunhagem da 1.3.0 volta ao proprietário como decisão sobre o UNIVERSO, não sobre a taxa. (3) **Parte das decisões já usa o shadow** — `estimateAsOf` não filtra `status` nem desempata; 5 decisões de 01/09 com `estimate_source='MODEL'` e zero modelos promovidos (nenhuma aceita). Defeito da RFC-010, registrado e fora do escopo. Modo B: o shadow teria agido diferente em **519 linhas (20,1%) / 9 mercados (40,9%)**, com 511 entradas só dele — **PnL contrafactual ainda não medível** (0 de 515 com label final). A própria rodada seca pegou dois defeitos de medição na ferramenta (AÇÃO somada ao MOTIVO; deltas na escala da coluna e não do motor) |
| 06 | [RFC-015 — dashboard do operador](06-rfc-015-dashboard-operador.md) | RFC | ideal após 03 | **CONCLUÍDO** (PR #76, 01/09 23:14Z) — faixa de PnL em todas as abas, aba "Visão geral" default com `GET /overview` + feed keyset `GET /events`, dicionário PT, `unknown` rotulado; perímetro publicado e **verificado no servidor** (401 sem sessão, 404 em todo método errado, escritas seguem 404). **Duas premissas do prompt caíram:** o 500 do `/decisions` era `statement_timeout = 1000 ms` da API contra um seq scan de 715 ms (corrigido: 0,17 ms), e o `/opportunities` tinha o mesmo defeito a 786 ms com sort em disco (corrigido: 24 ms medidos em produção). A aba "Rápidos" entrou (RFC-016 está em produção) e é verificada **vazia na fatia < 6 h**: o universo não tinha nenhum mercado nessa janela. |
| 07 | [RFC-018 — gates e calibração](07-rfc-018-gates-calibracao.md) | RFC | — | pendente |
| 08 | [Redeclaração da quota de book_deltas](08-redeclaracao-quota-book-deltas.md) | decisão + PR | dado fecha ~2026-09-04 | pendente |
| 09 | [Checklist pré-live](09-checklist-pre-live.md) | verificação | gates PASS | pendente |
| 10 | [RFC-009 — execução real](10-rfc-009-execucao-real.md) | RFC | 09 completo | pendente |
| ∥ | Trilha humana: parecer jurídico/tributário, capital real, burn wallet Polygon | proprietário | — | pendente — **pode começar hoje**; maior lead time do caminho |

Calendário: o piso de 60 dias do G2/G5 corre desde 28/08 20:38Z (melhor caso ≈ 27/10);
gates PASS realista ~novembro/2026; live ~dezembro/2026 — condicionado a um modelo com alpha
(prompt 04), o único item sem data mecânica.

## Convenções que todo prompt desta pasta carrega

- **Autorização de SSH** ao servidor de produção (leitura livre; escrita só nos passos de
  deploy/manutenção descritos no próprio prompt).
- Deploy em **três passos** (merge → CD → rebuild de profile); o CD reinicia os containers de
  profile a cada merge **sem trocar a imagem**; a evidência de revisão é
  `/etc/ganso/release-sha` dentro do container.
- Invariantes intocáveis (paper-only, fail-closed, gates não afrouxam, money em bigint,
  migrations aplicadas não mudam) e teste de regressão verificado falhando no código anterior.
- Re-medição antes de codar: os fatos citados foram medidos em 28–31/08 e podem ter mudado.
