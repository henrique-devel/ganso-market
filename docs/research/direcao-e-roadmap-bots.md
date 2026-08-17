# Direção e Roadmap — Bots Polymarket e Solana

**Data:** 2026-08-15
**Tipo:** análise estratégica e roadmap (não é RFC; alimenta futuras emendas de PRD/RFC)
**Base:** estado atual do repositório (RFC-001 implementada e em produção) + pesquisa profunda de mercado (8 relatórios, ~350 fontes de 2024–2026: GitHub, Reddit via fontes secundárias, Telegram, X, Substack, papers acadêmicos, docs oficiais)

> **Atualização (2026-08-15) — decisão tomada.** O proprietário decidiu perseguir execução real na Polymarket a partir de um servidor na Alemanha, com burn wallet na Polygon, **assumindo o risco jurisdicional e tributário**. Os documentos foram atualizados: PRD emendado, RFC-006/007/008 revisadas e criada a RFC-009 (execução Polymarket maker-side). Os riscos residuais descritos na seção 6 permanecem válidos e a validar com assessoria profissional — a decisão os aceita, não os elimina. A "Fase 6 condicional" abaixo passa a ser a RFC-009, cujas pré-condições incluem os gates da RFC-007 e o parecer jurídico/tributário.

> **Aviso obrigatório.** Este documento é análise técnica e de mercado para engenharia de software. Não é aconselhamento financeiro, jurídico ou tributário. Os números de retorno citados são relatos de terceiros, na maioria não auditados. A regra do PRD permanece: o sistema **não promete lucro**, e resultado positivo em paper trading **não é evidência suficiente de lucro futuro**. As questões de jurisdição e imposto exigem advogado e contador — este documento apenas mapeia os fatos encontrados.

---

## 1. Sumário executivo

**Onde estamos.** A fundação (RFC-001) está pronta, verificada e em produção no Hetzner com CI/CD. O PRD e as RFCs 002–008 já desenham exatamente os dois bots pedidos — e a pesquisa externa confirma que o desenho existente (paper-first, gates objetivos, risk guard determinístico, signer isolado) é o mesmo padrão que separa os poucos operadores individuais sobreviventes da maioria que quebra. **A direção não precisa mudar; precisa ser atualizada com os fatos de 2026 e sequenciada.**

**As cinco conclusões que mandam no roadmap:**

1. **Brasil está formalmente bloqueado na Polymarket desde abril/maio de 2026** (Resolução CMN 5.298/2026 + posição da SPA/Fazenda + bloqueio Anatel; o Help Center oficial lista BR como jurisdição bloqueada). A restrição da RFC-007 ("analytics/paper enquanto a operação partir do Brasil") deixou de ser cautela e virou obrigação legal e de ToS. Execução real na Polymarket só entra no roadmap como **fase condicional**, atrás de residência genuína em jurisdição permitida + parecer profissional. VPS no exterior com o operador no Brasil **não** resolve elegibilidade — e a ToS (seção 2.1.4) trata contorno de geoblock como violação autônoma, com contas suspensas e fundos congelados.
2. **A Polymarket mudou estruturalmente em 2026**: CLOB V2 (28/abr/2026, contratos novos, SDKs antigos arquivados), colateral pUSD no lugar de USDC.e, e **taxas taker** por categoria (pico ~1,80% em crypto; geopolítica segue grátis) com **makers pagando zero e recebendo rebates + liquidity rewards**. Todo código e backtest pré-2026 está quebrado ou superestimado. A economia da plataforma agora empurra o operador individual para o **lado maker e para nichos de modelo**, não para corridas de latência.
3. **Quem sobrevive individualmente, sobrevive por seleção, não por velocidade.** Nos dois ecossistemas, ~73% do lucro de arbitragem na Polymarket vai para bots sub-100ms, e o sniping lucrativo no Pump.fun é majoritariamente de insiders financiados pelo próprio deployer (87% de win rate). As taxas-base são brutais: ~16% das carteiras Polymarket já foram lucrativas e só ~2% passaram de US$ 1.000; ~96% das carteiras Pump.fun perdem ou ganham menos de US$ 500. Os sobreviventes documentados são makers disciplinados, especialistas de domínio (clima, macro) e operadores com filtros duros — exatamente o desenho das RFCs 006/007.
4. **O gravador de dados vem antes da estratégia.** Não existe histórico L2 profundo da Polymarket antes de ago/2025 e o endpoint oficial degrada para ~12h de granularidade em mercados resolvidos; no Pump.fun, os regimes de taxa/graduação mudam a cada poucos meses (graduação foi de 0,63% → 0,20% → ~6,7% pós-BOOST em jul/2026). O padrão da comunidade é "record-your-own": gravar livro/eventos desde o dia 1 e fazer replay determinístico — que já é o desenho das RFCs 003/004/007.
5. **Solana pode andar já; Polymarket live é condicional.** Trade de DEX com capital próprio não é atividade regulada no Brasil (a regulação BCB 519/520/521 alcança prestadores de serviço, não indivíduos), restando obrigações de **reporte** (IN 1888 → DeCripto a partir de jul/2026, limiar R$ 35 mil/mês que um bot cruza imediatamente) e de imposto. Portanto: **a trilha Solana (RFC-002→008) segue no ritmo planejado; a trilha Polymarket segue completa até paper (RFC-007) e ganha uma RFC-009 condicional de execução**.

**Roadmap em uma linha:** Fase 0 (emendas de docs, ~1 semana) → RFC-002 auth → RFC-003/004 ingestão+eventos Solana **+ recorder Polymarket em paralelo** → RFC-007 paper Polymarket (maker-sim, clima/macro, calibração) e RFC-005/006 risco+paper Solana → gates de 14 dias → RFC-008 micro-live Solana → (condicional à jurisdição) RFC-009 Polymarket live maker-side.

---

## 2. Estado atual do projeto (o que o repositório já resolve)

| Camada | Estado | Evidência |
|---|---|---|
| Fundação/runtime (Rust engine, API Fastify, web, worker Python, Postgres, Nginx) | **Implementada e em produção** | `docs/test-results/RFC-001.md`, deploy CI/CD ativo em `http://178.105.65.251/` |
| Autenticação (RFC-002) | Draft a reescrever — **bloqueia qualquer dado privado no painel** | `docs/rfcs/RFC-002-auth-ip-http.md` |
| Ingestão Yellowstone (RFC-003) | Não iniciada; credencial nova pendente | `docs/HANDOFF.md` |
| Eventos/persistência (RFC-004) | Não iniciada | — |
| Wallet/risk/signer (RFC-005) | Não iniciada; recuperação offline da wallet pendente de comprovação | — |
| Paper + modelos + gates (RFC-006) | Não iniciada | — |
| Polymarket analytics/paper (RFC-007) | Não iniciada | — |
| Execução beta Solana (RFC-008) | Proibida antes das gates | — |

O que a pesquisa **valida** no desenho atual (não mudar):

- **Paper-first com o mesmo `TransactionIntent` e risk guard do live** — a literatura quant mostra que Sharpe de backtest tem poder preditivo quase nulo (R² < 0,025 em 888 estratégias reais) e haircut típico de 20–50% ao vivo; simulação forward contra feeds reais é o único teste honesto em memecoins.
- **Limites do PRD (2% por entrada, 5% por ativo, 3% perda diária, 10% drawdown)** — coincidem com as regras que operadores sobreviventes relatam (1–5% por posição, perda diária 2–3%, parada após 3 perdas seguidas) e são mais conservadores que o Kelly fracionário padrão (0,25–0,5x), o que é correto dado erro de estimativa.
- **Hard vetoes antes de score, alvos separados (sellability, rug, graduação), dataset com tokens mortos** — é exatamente onde o único build-log honesto de sniper encontrado (caso "Moonshot", fev/2026) ganhou: filtros elevaram win rate de 13% para 36%; sem eles, perdeu 44% do capital no primeiro dia.
- **Signer isolado que redecodifica bytes** — o ecossistema está infestado de repositórios-armadilha que roubam chaves (caso SlowMist: `solana-pumpfun-bot` falso com dependência npm maliciosa; Polycule drenado em ~US$ 230 mil por guardar chaves no servidor). A fronteira de assinatura local é o diferencial de segurança do projeto.

O que **falta** no desenho atual (emendas propostas na seção 7):

1. RFC-007 assume USDC.e e fee schedule antigos — precisa de emenda V2/pUSD/taxas 2026.
2. RFC-006 não cita explicitamente **detecção de bundle/insider** (compras same-block coordenadas, clusters de funding, snapshot de RugCheck no momento da detecção) — hoje isso é o estado da arte de filtro, mais importante que checks de authority isolados.
3. Não existe decisão registrada sobre **estratégia Polymarket preferida** — a pesquisa aponta maker/rewards + nichos de modelo (abaixo).
4. Não existe trilha formal para a **questão jurisdicional** (residência, saída fiscal, pareceres) — precisa virar um gate documentado da futura RFC-009.

---

## 3. O que mudou no mundo em 2025–2026 (fatos que invalidam suposições antigas)

### 3.1 Polymarket

- **CLOB V2 em 28/abr/2026**: contratos novos (`ctf-exchange-v2`), livros zerados na virada, assinatura EIP-712 alterada (domínio Exchange v2; campos `nonce`/`feeRateBps`/`taker` removidos; `timestamp`/`metadata`/`builder` adicionados). `py-clob-client` e `clob-client` V1 foram **arquivados**; os pontos de entrada atuais são `Polymarket/py-sdk`, `Polymarket/ts-sdk`, `py-clob-client-v2`/`clob-client-v2` e o CLI oficial em Rust (`Polymarket/polymarket-cli`, ~2,8k estrelas, com modo JSON para agentes — melhor referência de assinatura V2 em Rust para o nosso monorepo).
- **Colateral agora é pUSD** (ERC-20 na Polygon, lastreado 1:1 em USDC nativo). Qualquer código/documentação assumindo USDC.e está desatualizado.
- **Taxas**: plataforma foi grátis até 2025; taker fees entraram por fases (crypto jan/2026, sports fev, quase tudo mar/2026). Fórmula dinâmica com pico em preço 0,50: crypto ~1,80%, economia 1,50%, política/finanças 1,00%, sports 0,75% — **geopolítica permanece grátis**. **Makers pagam zero** e recebem: (a) *Maker Rebates* (20–50% das taker fees redistribuídas diariamente) e (b) *Liquidity Rewards* (pagamento diário por quotes dos dois lados perto do midpoint, scoring quadrático, penalidade 3x por quote unilateral, mínimo US$ 1/dia não cumulativo).
- **Anti-sniping em sports**: ordens em descanso canceladas no início do jogo, atraso de 3s em ordens marketáveis, teste de 1s de taker delay em NBA/MLB. Estratégias de latência de 2024–2025 ficaram estruturalmente mais difíceis.
- **Rate limits documentados** (Cloudflare, janelas deslizantes): global 15.000 req/10s; POST /order 3.500/10s burst; Gamma 4.000/10s; Data API 1.000/10s. Bots são **explicitamente permitidos** pela ToS; o proibido é wash trading/spoofing — e a elegibilidade jurisdicional do operador.
- **EUA agora têm entidade própria** (QCX/“Polymarket US”, DCM regulada pela CFTC, KYC com SSN). Não confundir os docs/fee schedules de `docs.polymarket.us` com a plataforma internacional.

### 3.2 Brasil (crítico)

- **Resolução CMN 5.298/2026** (vigor 04/05/2026): proíbe ofertar/negociar derivativos com underlying em eventos esportivos, de jogos virtuais, políticos, eleitorais, sociais, culturais ou de entretenimento que não sejam referenciais econômico-financeiros.
- **SPA/Ministério da Fazenda** (Nota Técnica SEI 2958/2026/MF): prediction markets reproduzem aposta de quota fixa (Lei 14.790/2023) → operação sem licença (R$ 30 mi + sede no Brasil) é exploração ilegal de loteria. **Anatel bloqueou 27–28 plataformas, incluindo Polymarket e Kalshi.**
- **Polymarket lista o Brasil como jurisdição bloqueada** no Help Center oficial (atualizado em 14/08/2026); trackers reportam modo close-only desde o fim de abril/2026.
- **TSE Resolução 23.735/2024**: aposta em resultado eleitoral é território de ilícito eleitoral — categoria a excluir por completo para quem tem vínculos com o Brasil.
- Enforcement oficial até agora mira **operadores**, não usuários individuais; a exposição do usuário (ex.: contravenção do art. 50 da LCP) é questão em aberto **para advogado**, não risco descartado.

### 3.3 Pump.fun / Solana

- **Economia hostil e mutável**: ~98,6% dos lançamentos com características de pump-and-dump (Solidus Labs); taxa de graduação caiu a ~0,20% (mai–jun/2026) e saltou para ~6,7% depois do mecanismo BOOST (21/jul/2026) — uma oscilação de >30x no ano. Fees mudaram várias vezes (Project Ascend set/2025 com creator fee dinâmico de até 0,95%; PumpSwap 0,30% pós-graduação). **Backtests precisam ser particionados por regime** (Raydium→PumpSwap mar/2025; Ascend set/2025; BOOST jul/2026).
- **Infra padrão 2026**: Yellowstone gRPC para detecção (Helius LaserStream, Shyft ~US$ 199/mês unmetered, QuickNode, Triton); envio por conexões staked (swQoS) + bundles Jito (mín. 1.000 lamports de tip, expiração ~2 slots). **Achado contraintuitivo (estudo Chorus One)**: tamanho de priority fee e de tip Jito quase não muda latência de inclusão; o que muda é swQoS — ou seja, pagar infra certa, não superpagar taxa.
- **MEV**: sanduíches extraíram US$ 370–500 mi em 16 meses; usuários de bots de Telegram com slippage alto são a presa típica. Mitigação: envio privado via Jito, caps de slippage.
- **Bots comerciais** (Axiom dominante com ~44% do volume de terminais; Trojan, BonkBot, GMGN, Banana Gun…) cobram ~1% por lado — esse 1% é o benchmark de custo que um bot próprio economiza; bot próprio compensa quando `volume mensal × ~2% ida-e-volta > custo de infra` (US$ 99–499/mês de gRPC compartilhado).
- **Plataformas morrem**: BullX pausou trading em jun/2026 com ~US$ 203 mi em fees coletadas e airdrop não entregue. Não criar dependência dura de nenhum agregador/bot comercial.

---

## 4. O que operadores individuais realmente fazem (evidência de comunidade)

### 4.1 Polymarket — cinco famílias de estratégia e o veredito de cada uma

| # | Estratégia | Evidência | Veredito para nós |
|---|---|---|---|
| 1 | **Arb intra-mercado** (YES+NO<US$ 1; rebalanceio negRisk) | Estudo IMDEA (86M apostas, abr/24–abr/25): US$ 39,6 mi extraídos, 73% via negRisk; janelas caíram de 12,3s para 2,7s; ~73% do lucro para bots sub-100ms | **Morto para retail taker.** Útil apenas como detector (sinal de mispricing), não como estratégia |
| 2 | **Arb cross-venue** (Kalshi, bookmakers de-vig) | `kachence/polymm`: ~US$ 5 mil líquidos e aposentado ("Python lento demais para defender o edge"); +US$ 8,3 mil de arb teórico corroído por −US$ 3,2 mil de adverse selection | Reproduzível barato (Odds API US$ 30–59/mês) mas edge decadente; só faz sentido **maker-side** e com hedge |
| 3 | **Market making / reward+rebate farming** | `warproxxx/poly-maker` (1,4k★, detecção de regime, kill switch, paper mode); rewards exigem quote bilateral perto do mid | **Candidata principal.** Único lado com taxa zero + renda de rewards/rebates; risco dominante = adverse selection (quotes são atingidas por fluxo informado antes do cancel) |
| 4 | **Latência/news** (sports, esports, crypto up/down) | swisstony (US$ 5→US$ 3,7 mi), RN1 (~US$ 9,2 mi, 55% WR), esports T+45s; MAS: anti-sniping 2026, feeds de esports agora enterprise-gated (GRID/PandaScore proíbem uso de aposta no self-serve), crypto tem a maior taker fee (1,80%) | **Não perseguir.** É corrida armamentista contra firmas colocadas; nós seríamos a liquidez, não o sniper |
| 5 | **Modelos de domínio** (clima, macro agendado) | Bots de clima com ensemble GFS/ECMWF vs mercados de temperatura (`suislanchez/polymarket-kalshi-weather-bot`, Kelly fracionário, honesto: US$ 1,8 mil em paper); dados grátis/CC-BY (ECMWF abriu o catálogo real-time) | **Candidata principal.** Edge de informação reproduzível, dados abertos, baixa competição por velocidade; encaixa no universo "macro agendado" da RFC-007 |

**Taxas-base (estudo Dune, 2,5 mi de carteiras, abr/24–abr/26):** 15,9% lucrativas; ~2% passaram de US$ 1.000; 0,033% passaram de US$ 100 mil; só 0,03% sustentaram US$ 5 mil+/mês por 3 meses seguidos. Os grandes vencedores célebres **não são bots**: Théo (~US$ 85 mi em 2024) usou pesquisa proprietária de polling; Domer (nº 1 histórico) é grinder manual com disciplina de banca.

**Riscos estruturais confirmados:** oráculo UMA já resolveu mercado contra fato amplamente noticiado (Ukraine-minerals, mar/2025, US$ 7 mi, sem reembolso) — estratégias de "juntar centavos a 99¢" carregam esse tail risk e um caso dissecado rendia ~3,3% a.a., abaixo de T-bill; **wash trading** contamina ~25% do volume (não copiar leaderboards sem filtro); **copy-trading** tem lag estrutural de ~4s de polling e ferramentas custodiais já foram drenadas.

### 4.2 Solana — o caminho que os operadores tomaram

O funil documentado: **manual (Phantom) → bot de Telegram (1%/lado) → terminal web (Axiom, sub-400ms colocado) → bot próprio** para uma minoria — quando o fee drag supera o custo de infra e quando se precisa de filtros que os comerciais não expõem. "90% dos snipers DIY falham" por infraestrutura (RPC público, rate limits, slot drift), não por lógica.

Números que calibram expectativa:

- Sniping same-block é **jogo de insider**: >50% dos tokens são snipados no bloco de criação, mas por carteiras financiadas pelo próprio deployer (4.600+ carteiras, 87% de win rate, saída de 85% das posições em 5 min). Sniper de fora compra o que os insiders descartaram (seleção adversa). Nosso PRD já exclui first-slot sniping — **correto, manter**.
- **Copy-trading decai com latência**: melhor plataforma ~15% de cópias no mesmo bloco; hold mediano de memecoin caiu para ~100 segundos; carteiras "lucrativas" farmam os próprios copiadores (paper da ACM WWW 2026). Leaderboards contam transferência/airdrop como PnL.
- **Regras de risco repetidas pelos sobreviventes** (Trojan blog, Altrady, edgeflo): posição 1–5% da banca (1–2% mais citado); banca de memecoin separada e fixa; ladder de take-profit vendendo ~25% a 2x/3x/5x/10x; trailing stop ~30% do pico após 2x; stop inicial −30 a −50%; saída por tempo; perda diária 2–3%; parada dura após 3 perdas seguidas.
- **Filtros são a estratégia**: liquidez mínima, holders mínimos, concentração máxima do top holder, authorities, e — estado da arte 2025/26 — **detecção de bundle/insider** (compras coordenadas no bloco de criação, clusters de carteiras com mesma fonte de funding; ferramentas: Trench Bot, GMGN insider ratio, RugCheck insider-graph, Bubblemaps).

---

## 5. Direção recomendada

### 5.1 Bot Polymarket (módulo `polymarket` do monorepo)

**Fase paper (RFC-007, do Brasil, sem execução real — obrigatório):**

1. **Universo inicial**: manter "crypto up/down + macro agendado" da RFC-007 e **adicionar mercados de clima/temperatura** — é o nicho com dados abertos (ECMWF CC-BY, Open-Meteo, NWS), evidência de edge reproduzível e pouca competição de latência. Excluir eleições (TSE) e live sports (anti-sniping + feeds gated).
2. **Baseline e calibração como gate central**: a Polymarket é bem calibrada na média (erro médio ~2,1 p.p.; Brier da plataforma ~0,084). Um modelo que "discorda do mercado" com frequência provavelmente está errado. Meta objetiva antes de confiar em sinais: **Brier < 0,20 em 100+ mercados resolvidos**, com regressão logística/GBM só se não piorar o baseline (já é o critério da RFC-007 — manter).
3. **Estratégias simuladas em ordem de prioridade**: (a) **maker/liquidity-rewards + rebates** com controle de adverse selection (cancel rápido, inventory caps, detecção de regime — usar `poly-maker` como referência de arquitetura, nunca como código a rodar com chave); (b) **modelo de clima** (ensemble → probabilidade por bucket vs preço); (c) **tilt anti-longshot** estrutural: contratos <10¢ perdem 60%+ em média — o bot deve ser estruturalmente enviesado contra comprar loteria e a favor de favoritos/NO (evidência de 300 mil contratos Kalshi).
4. **Simulador com custos V2**: fee schedule por categoria versionado, book-walk contra profundidade real (o PolyBench mostrou lucros a US$ 10/lote virando prejuízo a US$ 1.000/lote só por slippage), resolução 0/1/0,5 e buffer de risco de regra/UMA.
5. **Dados**: começar a **gravar o firehose próprio** (WS de mercado, top-10 do livro, trades) no dia 1 do módulo; backfill de metadados/resolução via Gamma + Dune (grátis); 1 mês de DepthFeed (US$ 29) para calibrar o modelo de slippage contra ladders reais; tratar 28/04/2026 como fronteira de regime.
6. **Sizing**: Kelly fracionário (¼ a ½), tratado como teto; agrupar mercados correlacionados (mesmo evento/noite) e dimensionar o grupo como uma aposta só, cap de 20–25% da banca por grupo — dentro dos limites já definidos no PRD.

**Fase live (RFC-009, condicional):** só com (a) residência/estabelecimento genuíno em jurisdição permitida, verificada contra o Help Center oficial na data, (b) KYC com identidade real, (c) parecer jurídico/tributário, (d) gates de paper cumpridos. Começar maker-side com capital pequeno, VPS em Dublin/Amsterdã pela latência (14–23ms), 1–2 vCPU bastam. A ToS permite bots; o que decide é a elegibilidade do operador.

### 5.2 Bot Solana (Pump/PumpSwap — RFCs 003→008)

1. **Manter as duas estratégias da RFC-006** (pós-validação e graduação/reteste) — a pesquisa confirma que entrar depois de evidência de sellability/migração canônica é o oposto do jogo de insider que mata snipers de fora.
2. **Emendar a RFC-006 com features de bundle/insider** como hard veto e feature de modelo: % de supply comprada no bloco de criação, nº de carteiras same-block, clusters por fonte de funding, histórico do creator (ATH dos tokens anteriores), snapshot de RugCheck/SolSniffer **no momento da detecção** (guardar o verdict histórico para não vazar label).
3. **Priors de graduação com dataset RED-PUMP** (Zenodo, CC-BY-4.0, 860 mil lançamentos com outcomes; achados: presença de Telegram multiplica graduação por ~8,9x, três socials por ~17x, self-buy >30 SOL é hazard 4,5x). **Não usar MELT para treino** (licença CC BY-NC, incompatível com bot de lucro) — só como leitura.
4. **Custos reais no simulador**: 1% de referência de fee de bot (nosso é ~0), priority fee + tip Jito (0,1–0,3%), slippage 0,5–2%, taxa de falha de transação 20–45% em congestão (falha ainda queima priority fee), fees do Pump por regime.
5. **Execução (RFC-008)**: envio privado (bundle Jito/sender staked) contra sanduíche; swQoS em vez de superpagar fees; canário a 10–25% do tamanho-alvo com veto por drawdown.
6. **Infra**: manter o endpoint Yellowstone externo já contratado; se precisar de segundo provedor, Shyft (~US$ 199/mês unmetered) é o benchmark de custo; backfill profundo grátis via Old Faithful (Triton/Solana Foundation) se um dia for necessário.

### 5.3 O que explicitamente NÃO fazer (antipadrões documentados)

- **Não** competir em latência pura (arb taker, sniping de primeiro slot, news-taking em crypto up/down) — é onde 73% do lucro vai para sub-100ms e onde as taxas de 2026 mais doem.
- **Não** rodar repositório de bot de terceiros contra carteira com fundos (malware documentado; auditar tudo que toca chave).
- **Não** copiar carteiras por leaderboard sem filtro de wash/insider/copier-farming.
- **Não** comprar longshots (<10¢) sistematicamente; **não** confiar em "renda segura a 99¢" (rende menos que T-bill com tail risk de oráculo UMA).
- **Não** usar Kelly cheio nem confiança auto-reportada de LLM como input de sizing (usar dispersão de ensemble; LLM explica decisão, não inventa probabilidade — já é regra do PRD).
- **Não** validar estratégia por backtest de memecoin (inválido por construção: sobrevivência, wash, rug não modelável) — só forward paper contra feed real.
- **Não** usar VPN/artifício para acessar a Polymarket do Brasil, e **não** presumir que VPS fora resolve elegibilidade — violação de ToS com histórico de fundos congelados, além do quadro regulatório brasileiro.

---

## 6. Jurisdição, impostos e compliance (fatos a validar com profissionais)

**Polymarket:**
- Brasil: bloqueado (política da plataforma + CMN 5.298/2026 + SPA/Anatel). Operação legítima "do exterior" = **presença/residência real** em jurisdição servida (lista oficial muda com frequência — França, UK, Alemanha, Holanda, Portugal etc. também caíram em 2025–26; re-checar o Help Center a cada milestone), KYC com identidade real quando exigido (traders de alto volume/API passam por verificação), e aceitar que a lista pode virar close-only com pouco aviso — projetar wind-down ordenado de posições.
- Residência fiscal: enquanto não houver **Saída Definitiva** formalizada (Comunicação + Declaração), o residente fiscal brasileiro tributa renda mundial. Lei 14.754/2023 + IN RFB 2.180/2024: cripto custodiada/negociada via instituição no exterior = "aplicação financeira no exterior" → 15% flat anual (sem isenção de R$ 35 mil). Classificação de saldos em plataforma estrangeira (ex.: pUSD na Polymarket) tende a cair aqui — **confirmar com contador**.
- Eleições: excluir a categoria por completo (TSE 23.735/2024).

**Solana:**
- Negociar em DEX com capital próprio não é atividade regulada no Brasil (Lei 14.478/2022 e Resoluções BCB 519/520/521 regulam prestadores). Autocustódia segue o regime doméstico de ganho de capital (isenção R$ 35 mil/mês em alienações totais; 15–22,5% progressivo — MP 1.303/2025 caducou, regras antigas valem em 2026, re-verificar a cada ano).
- **Reporte**: IN 1888 (até 30/06/2026) e **DeCripto/IN 2.291** (a partir de jul/2026, limiar R$ 35 mil/mês) — um bot de frequência cruza o limiar no primeiro mês; o reporte mensal é obrigação mesmo sem imposto devido. Automatizar a extração de relatórios do ledger próprio (o desenho de ledger auditável das RFCs 004/006 já serve para isso).
- Pump.fun: sem licença em qualquer jurisdição, já geobloqueou o UK sob demanda do regulador e responde a class action nos EUA — mais um motivo para o sistema não depender de o Pump.fun continuar existindo do jeito que é (o desenho por allowlist versionada já acomoda isso).

---

## 7. Roadmap proposto

A sequência de RFCs existente permanece válida. As mudanças são: (i) emendas documentais antes de codificar, (ii) o recorder Polymarket antecipado para rodar em paralelo à trilha Solana, (iii) uma RFC-009 condicional nova, (iv) gates numéricos de promoção de modelo.

### Fase 0 — Emendas e decisões (≈1 semana, sem código de mercado)

1. **Emenda RFC-007**: V2/pUSD, fee schedule 2026 versionado por categoria, SDKs novos (`py-sdk`/`ts-sdk`; `polymarket-cli` como referência Rust), universo = crypto up/down + macro agendado + **clima**, exclusão explícita de eleições e live sports, estratégia maker-sim + modelo de clima + tilt anti-longshot.
2. **Emenda RFC-006**: features/vetoes de bundle/insider; snapshot de verdicts de risco no momento da detecção; partição de datasets por regime de fee/graduação; custos de execução reais (falha, tip, slippage) no simulador.
3. **Emenda PRD**: registrar o quadro jurisdicional 2026 (CMN 5.298, SPA, ToS 2.1.4), a decisão "Polymarket live = RFC-009 condicional" e o requisito de reporte fiscal automatizável (DeCripto).
4. **Decisão de orçamento de dados/infra** (ver §8) e abertura da trilha profissional (advogado/contador) — corre em paralelo, não bloqueia nada de paper.

### Fase 1 — RFC-002: autenticação e perímetro (bloqueante para dados privados)

Reescrever para o perímetro standalone atual e implementar. Sem ela, nenhum dado de posição/decisão pode ir ao painel público.

### Fase 2 — Ingestão e gravação (as duas trilhas em paralelo)

- **Solana**: RFC-003 (Yellowstone filtrado Pump/PumpSwap; confirmar credencial e slots avançando — bloqueio registrado no HANDOFF) → RFC-004 (decoders, event log, TTL).
- **Polymarket**: antecipar do escopo da RFC-007 apenas o **coletor/recorder** (Gamma 10 min, snapshot REST, WS do universo selecionado, top-10 a cada 2–5s) — só APIs públicas, sem auth, compatível com a restrição Brasil. Cada dia sem gravar é dado perdido para sempre (não existe L2 histórico barato).

### Fase 3 — Paper trading dos dois módulos

- **RFC-007 completa** (registry, features, baseline, EV com custos V2, simulador book-walk, ledger, dashboard). Meta de saída: 60–90 dias de paper com relatório de calibração (Brier/log-loss vs baseline de mercado), P&L líquido simulado por estratégia e por categoria de fee.
- **RFC-005** (signer/risk guard — sem broadcast) e **RFC-006** (replay determinístico, paper broker, duas estratégias, modelos com walk-forward). Priors iniciais do RED-PUMP; depois, treino apenas com dados gravados pelos nossos coletores.

### Fase 4 — Gates de readiness (objetivos, não julgamento)

Manter os gates da RFC-006 (14 dias contínuos de shadow, ledger conciliado, zero duplicidade, replay determinístico, sem look-ahead) e **adicionar os numéricos da literatura**: ≥100 trades paper por estratégia (200–500 preferível), walk-forward efficiency ≥ 50%, Sharpe deflacionado pelo nº de variantes testadas, e orçamento go/no-go assumindo haircut de 20–50% sobre o resultado de paper. Sem evidência → `NO_EVIDENCE_OF_ALPHA` e permanece em paper (regra já existente — manter à risca).

### Fase 5 — RFC-008: micro-live Solana (canário)

Somente após a Fase 4 e aprovação manual: canário a 10–25% do tamanho-alvo, limite absoluto definido pelo proprietário, envio privado (Jito/staked), circuit breakers da RFC (lag, fee spike, saldo divergente, perda diária), relatório por operação. Escalar tamanho só depois de N operações reconciliadas sem divergência.

### Fase 6 — RFC-009 (nova, condicional): execução Polymarket

Pré-condições **todas** obrigatórias: (a) residência/presença genuína em jurisdição permitida verificada na data; (b) parecer jurídico e tributário; (c) RFC-007 com gates de calibração e P&L simulado positivo líquido de custos; (d) desenho de wind-down para mudança de lista de países. Escopo: auth L1/L2 V2, pUSD, ordens maker-first (GTC pós-only na prática via preços passivos), caps por mercado/evento, kill switch, começar com capital pequeno e VPS UE. Enquanto (a)–(b) não existirem, esta fase **não entra em desenvolvimento** — apenas o paper continua.

**Sequência visual:**

```
Fase 0   Emendas PRD/RFC-006/RFC-007 + orçamento + trilha jurídica (paralela)
Fase 1   RFC-002 auth
Fase 2   RFC-003 → RFC-004 (Solana)        ║  Recorder Polymarket (públicas)
Fase 3   RFC-005 → RFC-006 (paper Solana)  ║  RFC-007 (paper Polymarket)
Fase 4   Gates numéricos (14d shadow, Brier, WFE, deflated Sharpe)
Fase 5   RFC-008 micro-live Solana (canário)
Fase 6   [condicional jurisdição] RFC-009 Polymarket live maker-side
```

Estimativa grosseira (um desenvolvedor + IA, ritmo atual do projeto): Fases 0–2 em 4–7 semanas; Fase 3 em 6–10 semanas de engenharia + 60–90 dias de coleta/paper correndo em paralelo; micro-live Solana viável em ~4–6 meses. Polymarket live não tem data — depende da condição jurisdicional, não de código.

---

## 8. Orçamento operacional estimado (fase paper)

| Item | Custo mensal | Quando |
|---|---|---|
| Servidor Hetzner CPX42 (existente) | já contratado | sempre |
| Endpoint Yellowstone externo (existente) | já contratado | Fase 2+ |
| Dune (tabelas curadas Polymarket + Pump) | US$ 0 (free tier) | Fase 2+ |
| Backfill Polymarket via HyperSync (`poly_data`) | US$ 0 | Fase 2, uma vez |
| DepthFeed (calibração de slippage com L2 real) | US$ 29 (1–2 meses apenas) | Fase 3 |
| Clima: ECMWF open data (CC-BY) + NWS | US$ 0 | Fase 3 |
| Open-Meteo licença comercial (ensemble) | ~€29–99 (verificar) | Fase 3 |
| The Odds API (só se ativar trilha sports de-vig) | US$ 30–59 (adiável) | opcional |
| Segundo provedor gRPC (Shyft) — só se necessário | US$ 199 (adiável) | opcional |
| **Total típico da fase paper** | **~US$ 30–130/mês** além do já contratado | |
| VPS UE 1–2 vCPU (só na RFC-009) | ~US$ 10–30 | Fase 6 |

---

## 9. Riscos principais e mitigação

| Risco | Severidade | Mitigação no desenho |
|---|---|---|
| Operar Polymarket de jurisdição inelegível (conta suspensa, fundos congelados) | Alta | RFC-009 condicional; paper-only até resolução; zero código de evasão (já é condição de parada da RFC-007) |
| Lista de países da Polymarket muda de novo | Alta | Re-check do Help Center a cada milestone; desenho de wind-down; não acumular capital grande na plataforma |
| Adverse selection no market making | Alta | Cancel rápido, inventory caps, detecção de regime, medir "pick-off cost" separado no ledger paper antes de qualquer live |
| Resolução UMA contra fato (tail risk) | Média | Buffer de risco de resolução no EV (já na RFC-007); evitar mercados de regra ambígua; cap por mercado |
| Rug/insider no Pump.fun (~98% dos lançamentos) | Alta | Hard vetoes + bundle/insider detection + estratégia pós-validação; nunca first-slot |
| MEV sanduíche na execução | Média | Envio privado (Jito), caps de slippage (2% já no PRD) |
| Overfitting/backtest inválido | Alta | Forward paper only para memecoin; gates numéricos; haircut 20–50% no go/no-go |
| Supply chain / repos maliciosos | Alta | Nenhum código de terceiros com acesso a chave; signer isolado redecodifica tudo (RFC-005) |
| Mudança de regime de fees (Polymarket/Pump) | Média | Fee schedules versionados como dado, não constante; partição de datasets por regime |
| Obrigações fiscais de reporte (DeCripto jul/2026) | Média | Ledger auditável já previsto; gerar relatório mensal exportável; contador |

---

## 10. Fontes principais (curadoria)

**Oficiais Polymarket:** [Geographic Restrictions](https://help.polymarket.com/en/articles/13364163-geographic-restrictions) · [V2 Migration](https://docs.polymarket.com/v2-migration) · [Upgrade 28/abr/2026](https://help.polymarket.com/en/articles/14762452-polymarket-exchange-upgrade-april-28-2026) · [Liquidity Rewards](https://docs.polymarket.com/market-makers/liquidity-rewards) · [py-sdk](https://github.com/Polymarket/py-sdk) · [ts-sdk](https://github.com/Polymarket/ts-sdk) · [polymarket-cli (Rust)](https://github.com/Polymarket/polymarket-cli) · [agent-skills](https://github.com/Polymarket/agent-skills)

**Bots/dados de referência (ler, não rodar com chave):** [warproxxx/poly-maker](https://github.com/warproxxx/poly-maker) · [warproxxx/poly_data](https://github.com/warproxxx/poly_data) · [guberm/polymarket-bot](https://github.com/guberm/polymarket-bot) (journaling + Kelly capado + caps em camadas) · [kachence/polymm](https://github.com/kachence/polymm) (post-mortem honesto de MM) · [suislanchez weather bot](https://github.com/suislanchez/polymarket-kalshi-weather-bot) · [chainstacklabs/pump-fun-bot](https://github.com/chainstacklabs/pump-fun-bot) · [pump-public-docs](https://github.com/pump-fun/pump-public-docs) · [RED-PUMP dataset (CC-BY)](https://zenodo.org/doi/10.5281/zenodo.20633486)

**Estudos e evidência:** IMDEA arbitragem 86M apostas ([arXiv 2508.03474](https://arxiv.org/abs/2508.03474)) · base rates Polymarket ([sergeenkov.com](https://sergeenkov.com/polymarket-profitability/)) · Kelly em prediction markets ([arXiv 2412.14144](https://arxiv.org/pdf/2412.14144)) · backtest vs live ([SSRN 2745220](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2745220)) · PolyBench LLMs ([arXiv 2604.14199](https://arxiv.org/html/2604.14199v1)) · Pine Analytics "Exit Liquidity Machines" ([substack](https://pineanalytics.substack.com/p/exit-liquidity-machines)) · Solidus Labs rug report · Chorus One latência Solana ([chorus.one](https://chorus.one/reports-research/transaction-latency-on-solana-do-swqos-priority-fees-and-jito-tips-make-your-transactions-land-faster)) · SlowMist malware em bots ([medium](https://slowmist.medium.com/threat-intelligence-an-analysis-of-a-malicious-solana-open-source-trading-bot-ab580fd3cc89)) · caso Moonshot sniper ([modern-managed.com](https://modern-managed.com/2026/02/building-a-solana-sniper-bot-in-3-days-an-ai-pair-programming-war-story/))

**Brasil/jurisdição:** [CMN 5.298/2026 (alerta Lefosse)](https://lefosse.com/en/news/alerts/prediction-markets-in-brazil-what-changes-with-the-new-rules-issued-by-the-national-monetary-council-and-the-secretariat-for-prizes-and-betting/) · [SPA/Anatel (iGB)](https://igamingbusiness.com/legal-compliance/compliance/brazil-prediction-markets-illegal/) · [IN RFB 2.180/2024](https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2024/marco/receita-federal-edita-norma-que-regulamenta-a-tributacao) · [DeCripto/IN 2.291 (KPMG)](https://kpmg.com/us/en/taxnewsflash/news/2025/12/tnf-brazil-implementation-of-decripto-for-cryptoasset-reporting-under-carf.html) · [BCB 519/520/521 (Notabene)](https://notabene.id/post/brazils-central-bank-regulates-virtual-asset-service-providers-what-bcb-resolutions-mean-for-crypto-compliance)

Os oito relatórios completos de pesquisa (com todas as ~350 fontes) ficaram gravados na sessão e podem ser versionados em `docs/research/reports/` se desejado.
