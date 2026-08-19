# Pesquisa profunda — motor Polymarket (2026-08)

> Relatório de síntese do corpus de pesquisa (docs oficiais, docs de dados, resolução UMA, GitHub, Reddit, X/Truth Social, literatura quant, incidentes). Data de referência: 2026-08-18.
>
> **Convenção de confiança**: cada afirmação relevante é marcada como **[alta]** (documentação oficial ou múltiplas fontes independentes), **[média]** (fonte única razoável, estudo não peer-reviewed, ou snippet não lido na íntegra) ou **[baixa/anedota]** (relato de usuário, auto-reportado, não auditado). Nada abaixo foi inventado além do corpus; lacunas e conflitos entre fontes estão explicitados.

---

## 1) Sumário executivo

**Regime novo, literatura velha.** A Polymarket migrou para o CLOB V2 em **28/abr/2026 ~11:00 UTC** (~1h de downtime; todas as ordens pré-cutover apagadas) **[alta]**. Quase toda a evidência empírica disponível (papers, datasets, bots open-source) usa dados do regime antigo — vieses comportamentais tendem a persistir, mas **números de microestrutura (spreads, latência, fees, profundidade) precisam ser re-medidos no V2** antes de calibrar qualquer modelo **[alta]**. Relatos da comunidade confirmam mortalidade de estratégia na semana do upgrade **[média/anedota]**.

**A economia virou maker-first.** Taker fees por categoria (fórmula `fee = C × feeRate × p × (1−p)`) com **crypto na taxa mais cara (0,07; pico ~$1,75/100 shares a p=0,5)**; maker paga zero e ainda recebe rebates (20% do pool em crypto, 25% em economics/finance) + liquidity rewards com scoring quadrático e programa TWAP de **$1M/mês em crypto** (ago/2026) **[alta]**. As fees dinâmicas foram desenhadas explicitamente para matar latency arbitrage Binance→Polymarket **[alta]**. Consequência para o motor: **execução default GTC+postOnly; cruzar spread só quando o edge do modelo fundamental exceder fee+spread**.

**O preço é um baseline brutalmente forte.** Brier ~0,074 com termo de calibração ~0,0005 (2024) **[média]**; BSS ≈ 0,231 vs climatologia em 24h **[média]**; livro de 5-min cripto calibrado ("preço = probabilidade") **[média/anedota]**. Backtest comunitário de 10 estratégias com custos reais e CI 95%: **zero edge direcional sobrevive a ~2% de round-trip**, e o favorite-longshot bias **não** aparece na Polymarket (em tensão com a literatura de Kalshi/corridas — ver §7) **[média]**. O gate de ativação do modelo fundamental precisa exigir que ele **bata o próprio preço** em Brier/log-loss.

**O maior risco não é execução, é resolução.** Casos documentados de manipulação/resolução contestada em mercados de $7M (Ucrânia-minerais), ~$160–237M (Zelensky), $16M (UFO/Clavicular) e $60M (Strategy/BTC — **regime atual**), com >50–60% dos votos em disputas concentrados nas maiores carteiras UMA e **precedente de não-reembolso** **[alta]**. A reforma MOOv2 (37 proponentes whitelisted, nov/2025) reduziu spam mas não o risco de voto por token **[média]**. Isso valida o 4º modelo (risco de resolução) como componente de primeira ordem, com features computáveis via Gamma API (§4).

**Dados: o recorder próprio é obrigatório.** Não existe histórico oficial de book L2 — WSS sem replay, RTDS sem replay, `/prices-history` só retorna (t,p) **[alta]**. Quem grava profissionalmente reporta picos de ~1.000 updates/s e WebSocket que dropa mensagens (uma conexão não basta) **[média/anedota]**. Para fills históricos, o caminho pós-V2 é ler `OrderFilled` on-chain do CTF Exchange V2 via Envio HyperSync (o subgraph Goldsky antigo ficou incompleto) **[alta]**.

**Categorias-alvo (crypto e macro agendado) têm bom fit, com ressalvas.** Crypto-preço é a categoria de **menor taxa de disputa (0,6%)** graças a fontes objetivas — e o feed Chainlink TWAP 30/60s que resolve os mercados está disponível via RTDS, eliminando basis risk **[alta]**. Macro (Fed/CPI) resolve por fonte oficial **[média]**, tem evidência acadêmica de sub-reação pós-anúncio (~0,64-por-1 com drift) **[média]**, mas books finos em props financeiros diários exigem sizing pela profundidade gravada, não pelo mid **[baixa/anedota]**. Crypto é também a categoria com **menos wash trading (3% vs 45% em sports)** **[alta]**.

**Sobriedade**: ~16% das carteiras rastreáveis estão em lucro (84% em PnL negativo, dados Dune citados no X) **[média]**; o trader médio perde ~2,7% ≈ o vig **[média]**. O bot precisa provar estar no decil superior em paper antes de tocar capital real.

---

## 2) Plataforma V2 (fatos verificados)

### 2.1 Migração — o que mudou **[alta]**

- **Go-live**: 28/abr/2026 ~11:00 UTC, ~1h de downtime; **todas as ordens pré-cutover apagadas**. — https://docs.polymarket.com/v2-migration
- **Removido do struct EIP-712**: `nonce` (→ `timestamp` em **milissegundos**), `feeRateBps` (fee agora decidida pelo protocolo no match), `taker`, e `expiration` (saiu do struct assinado; permanece no wire body para GTD).
- **Adicionado**: `metadata` (bytes32, hoje zerado) e `builder` (bytes32, builder code público onchain).
- **Domain version do Exchange**: "1" → "2". Auth L1/L2 **inalterada** (`ClobAuthDomain` continua version "1").
- **SDKs novos**: `@polymarket/clob-client-v2` (TS), `py-clob-client-v2` (Python); recomendado para projetos novos: `py-sdk` (PyPI `polymarket-client`). Qualquer material pré-28/abr/2026 sobre assinatura de ordens é regime antigo.
- Backend reescrito corrigiu "ghost fills" do V1 **[média]** — https://www.quantvps.com/blog/polymarket-fixes-ghost-fills-clob-v2-upgrade

### 2.2 Struct de ordem e contratos **[alta]**

Campos assinados: `salt, maker, signer, tokenId, makerAmount, takerAmount (6 decimais como inteiros), side (0=BUY/1=SELL), signatureType, timestamp (Unix ms), metadata, builder`. `signatureType`: 0=EOA (allowlisted), 1=Proxy, 2=Safe (legados), 3=Deposit Wallet (padrão atual, TypedDataSign wrapping). — https://docs.polymarket.com/trading/place-orders

| Contrato                   | Endereço (Polygon, chain 137)                |
| -------------------------- | -------------------------------------------- |
| CTF Exchange V2 (standard) | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Neg Risk CTF Exchange      | `0xe2222d279d744050d28e00520010520000310F59` |
| Conditional Tokens (CTF)   | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| pUSD (proxy)               | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| CollateralOnramp           | `0x93070a847efEf7F70739046A929D47a521F5B8ee` |
| CollateralOfframp          | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` |
| UMA Adapter                | `0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74` |
| Deposit Wallet Factory     | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` |

**Regra operacional**: o Exchange correto vem do flag `neg_risk` retornado por `GET /book?token_id` — **ler por mercado antes de assinar, nunca hardcodar**. Neg Risk Adapter v1 (`0xd91E...5296`) foi **deprecado em 14/jul/2026**. — https://docs.polymarket.com/resources/contracts

### 2.3 Tipos de ordem e ciclo de vida **[alta]**

- **GTC** (expiration="0"), **GTD** (expiration em Unix **segundos** — atenção: timestamp do struct é em **ms**), **FOK**, **FAK**, flag **postOnly** (rejeita se cruzaria o spread).
- **Buffer GTD**: expira **1 minuto antes** do horário declarado (vida útil de N s ⇒ usar `now + 60 + N`); mínimo **3 minutos** no futuro.
- **Taker delay de 250ms** para ordens marketáveis em crypto/finance (sports tem delay próprio); **cancelamento bloqueado durante o delay** — adverse selection para o taker.
- Estados de ordem: `live/matched/delayed/unmatched`. Estados de trade: `MATCHED, MINED, RETRYING` (não-terminais), `CONFIRMED, FAILED` (terminais) — o motor de posições deve tratar `RETRYING` sem duplicar fills. Fills parciais não são canceláveis (só a porção restante). Settlement atômico onchain.
- Endpoints: `POST /order` (single), `POST /orders` (batch 1–15). Desde 17/jul/2026, matches FAK/FOK **não retornam transactionHashes** — retornam tradeIDs; hash onchain via polling de `GET /trades`.
- — https://docs.polymarket.com/concepts/order-lifecycle, https://docs.polymarket.com/trading/place-orders

### 2.4 Taxas, rebates e rewards **[alta, salvo indicado]**

**Taker fee**: `fee = C × feeRate × p × (1−p)`, cobrada no match, pico em p=0,5, simétrica; **maker nunca paga**; fee mínima 0,00001 USDC.

| Categoria                       | feeRate taker          | Pico por 100 shares (p=0,5) | Maker rebate (share do pool) |
| ------------------------------- | ---------------------- | --------------------------- | ---------------------------- |
| Crypto                          | **0,07** (a mais cara) | ~$1,75                      | 20%                          |
| Economics/Culture/Weather/Other | 0,05                   | ~$1,25                      | 25%                          |
| Sports                          | 0,05                   | ~$1,25                      | 15%                          |
| Finance/Politics/Tech/Mentions  | 0,04                   | ~$1,00                      | 25%                          |
| Geopolítica                     | 0 (fee-free)           | —                           | sem rebate                   |

- Consulta em tempo real: `GET /fee-rate?token_id` → `base_fee` em bps (consultivo; valor efetivo decidido no match). O evento WS `last_trade_price` traz `fee_rate_bps` real — **usar para reconciliação no paper trading**. Consulta onchain: `getClobMarketInfo(conditionID)` → estrutura `fd`. — https://docs.polymarket.com/api-reference/market-data/get-fee-rate
- **Maker rebates**: pagos diariamente em pUSD (mínimo $1), proporcionais por fee-equivalent `C × feeRate × p(1−p)`. Sem endpoint documentado para consultar earnings. — https://docs.polymarket.com/programs/maker-rebates
- **Liquidity rewards**: score por ordem `S(v,s) = ((v−s)/v)² × b`; midpoint em [0,10, 0,90] permite one-sided (÷3,0); **fora dessa faixa exige two-sided**. Payout diário 00:00 UTC, mínimo $1. Programa TWAP crypto de ago/2026: **$1M** (5min: $550k, com BTC $300k; 15min: $350k; 4h: $100k) — incentivo pesado de MM em crypto de curto prazo agora. — https://docs.polymarket.com/programs/liquidity-rewards
- **Taker rebates** **[média]**: live desde 28/mai/2026; Weighted Volume = size × (1−preço) × peso (crypto 2,3, o maior) × bônus; tiers Bronze $2k→3% até Obsidian $10M+→50%. Nota: a página fala em "sete tiers" mas a tabela extraída lista seis — verificar antes de citar em RFC. Há relato de não-pagamento a usuário Bronze **[baixa/anedota]** — tratar rebate taker como upside não-confiável. — https://docs.polymarket.com/programs/taker-rebates, https://www.reddit.com/r/Polymarket/comments/1ukqe03/
- Fees **mudam ao longo do tempo** por categoria (ex.: sports 10/jul/2026: taker→0,05, maker rebate→15%) — **gravar `feeSchedule` versionado por mercado** **[alta]**. — https://docs.polymarket.com/changelog/predictions

### 2.5 pUSD (colateral) **[alta]**

ERC-20 na Polygon, 6 decimais, lastreado 1:1 em USDC com enforcement onchain. Wrap: approve USDC.e (`0x2791Bca1...4174`) para o CollateralOnramp e chamar `wrap(_asset,_to,_amount)`; unwrap via Offramp. O site faz wrap automático; **traders API-only fazem manualmente**. Cada par YES/NO é lastreado por $1 travado no CTF; operações `split` ($1→1 YES+1 NO), `merge` (par→$1) e `redeem` (vencedor→$1). — https://docs.polymarket.com/concepts/pusd

### 2.6 Auth L1/L2 **[alta]**

- **L1**: EIP-712, domain `{name:"ClobAuthDomain", version:"1", chainId:137}` (continua version 1); message `ClobAuth {address, timestamp (s), nonce, message:"This message attests that I control the given wallet"}`; headers `POLY_ADDRESS/SIGNATURE/TIMESTAMP/NONCE`.
- **L2**: `/auth/api-key` ou `/auth/derive-api-key` → `{apiKey, secret, passphrase}`; `POLY_SIGNATURE = HMAC-SHA256(timestamp + method + path + body)`. **Credenciais pré-V2 continuam válidas.** — https://docs.polymarket.com/trading/wallets-auth

### 2.7 negRisk **[alta]**

Em eventos multi-outcome onde só um vence: **1 share NO de qualquer mercado converte em 1 share YES de todos os outros** (Neg Risk Adapter) — base para arbitragem interna de inventário. Restrição dura: resultado 50/50 (`[1,1]`) do UmaCtfAdapter é **inválido no NegRiskAdapter (reverte)** — mercados negRisk têm risco 50/50 estruturalmente eliminado, mas herdam risco de resolução conjunta do evento. **Augmented negRisk**: só operar outcomes **nomeados**; ignorar placeholders. — https://docs.polymarket.com/concepts/negative-risk, https://github.com/Polymarket/neg-risk-ctf-adapter/blob/main/docs/index.md

### 2.8 Tick size, tamanho mínimo e validação **[alta]**

`GET /tick-size?token_id` → `minimum_tick_size`; `GET /book?token_id` retorna `tick_size`, `min_order_size` e `neg_risk` juntos — **um call resolve validação completa**. Precisão por tick (price/size/amount decimals): 0,1→1/2/3; 0,01→2/2/4; 0,005→3/2/5; 0,0025→4/2/6; 0,001→3/2/5; 0,0001→4/2/6. Arredondamento: preço para baixo, shares para baixo, depois valor USD (até Amount+4 para cima, depois para baixo até Amount) — **o validador do bot deve replicar exatamente essa sequência**. Evento WS `tick_size_change` sinaliza mudanças. — https://docs.polymarket.com/api-reference/market-data/get-tick-size

---

## 3) Inventário de dados disponíveis e lacunas

### 3.1 As cinco fontes oficiais **[alta]**

| Fonte          | URL base                                             | O que dá                                                                                                                                                                                                                                                                                                        | Notas                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gamma API**  | gamma-api.polymarket.com                             | Metadados: `question`, `description` (as REGRAS), `conditionId`, `clobTokenIds`, `outcomes/outcomePrices`, `spread`, `bestBid/bestAsk`, `volume24hr/1wk/1mo`, `feeSchedule`, campos UMA (`umaResolutionStatus`, `umaBond`, `umaReward`, `customLiveness`), `negRisk`, `resolvedBy`, `automaticallyResolved`     | Paginação **keyset** (`/markets/keyset`, `/events/keyset`, máx 100/página, desde 14/mai/2026) — usar keyset, não offset                                                                   |
| **CLOB REST**  | clob.polymarket.com                                  | `/book`, `/price(s)`, `/midpoint(s)`, `/spread(s)`, `/prices-history` (só pares t,p), `/fee-rate`, `/tick-size`, e o novo `GET /clob-markets/{condition_id}`                                                                                                                                                    | `/clob-markets` consolida `mts` (tick), `mos` (min size), `mbf/tbf` (fees), `fd` (curva de fee), `oas`, `itode` (delay 250ms) — **coletar e versionar junto com as regras**               |
| **WSS market** | wss://ws-subscriptions-clob.polymarket.com/ws/market | `book` (snapshot completo + hash), `price_change` (delta com size agregado por nível; 0=remove), `last_trade_price` (com `fee_rate_bps`, `transaction_hash`), `tick_size_change`; com `custom_feature_enabled`: `best_bid_ask`, `new_market` (descoberta em tempo real), `market_resolved` (`winning_asset_id`) | PING a cada 10s; parâmetro `level` (1–3); sub/unsub dinâmico; limite de assets por conexão **não documentado**                                                                            |
| **Data API**   | data-api.polymarket.com                              | `/trades` (~3 anos por mercado; `takerOnly` default **true**), `/positions`, `/holders` (top holders por outcome), `/oi` (OI atual), `/live-volume`, `/v1/leaderboard`                                                                                                                                          | `/trades`: limit clampado a 10.000 e offset máx 10.000 — backfill profundo exige **janelamento por timestamp**; `/positions` traz `grossInitialValue` e `entryFeesUsdc` desde 10/ago/2026 |
| **RTDS**       | wss://ws-live-data.polymarket.com                    | `crypto_prices` (Binance spot), `crypto_prices_chainlink`, `crypto_prices_twap_thirty/sixty` (**TWAP Chainlink 30/60s — o dado que resolve os mercados cripto**), `equity_prices` (Pyth), `comments`                                                                                                            | Sem credenciais; PING 5s; **sem replay/snapshot pós-desconexão** (exceto equities) — gravar continuamente                                                                                 |

- **Chainlink TWAP**: também direto em `wss://ws.dataengine.chain.link` / REST `api.dataengine.chain.link`; payload com `full_accuracy_value` (E18 fixed-point). Consumir exatamente este feed **elimina basis risk** entre preço observado e preço de resolução. — https://docs.polymarket.com/market-data/chainlink-twap
- **Preço exibido no site** = midpoint, mas se spread > $0,10 mostra last trade — **o modelo deve usar o book cru** **[alta]**.

### 3.2 Rate limits (números oficiais) **[alta]**

Global 15.000 req/10s. Gamma: `/markets` 300/10s, `/events` 500/10s. CLOB: `/book`, `/price`, `/midpoint` 1.500/10s; batches 500/10s; `/prices-history` 1.000/10s. Data API: `/trades` 200/10s, `/positions` 150/10s. Trading: `POST /order` 5.000/10s burst + 120.000/10min. Exceder = **throttling, não ban**. Para single-user o gargalo é design de polling, não limite. — https://docs.polymarket.com/api-reference/rate-limits

### 3.3 Lacunas confirmadas (o que NÃO existe oficialmente) **[alta]**

1. **Histórico de book L2**: inexistente — WSS sem replay, RTDS sem replay, `/prices-history` só (t,p). **O recorder próprio é a única fonte de microestrutura histórica.**
2. **OHLC/candles** para prediction markets: não há (klines só em Perps, produto separado).
3. **Série histórica de OI, spread e holders**: endpoints só dão valor corrente — amostrar e persistir.
4. **Feed de clarificações de regras**: não existe; mudanças aparecem como edição de `description` no Gamma — **diff via polling + versionamento local** (`description` + `updatedAt`).
5. **Endpoint de disputas UMA**: não existe na API Polymarket — rastrear onchain (UMA Adapter `0x6A9D...4F74`) ou oracle.uma.xyz (semi-oficial).
6. **Atribuição maker por ordem**: `/trades` com `takerOnly=false` ajuda, mas não há book-event-level trade attribution.
7. **Endpoint de earnings de rebates/rewards**: não documentado.

### 3.4 On-chain e backfill **[alta]**

- On-chain cobre fills liquidados, resolução (CTF), fluxos pUSD e redemptions — **nunca o estado do book** (off-chain). Doc oficial aponta Goldsky, Dune, Allium, CryptoHouse. Eventos exatos dos contratos V2 não enumerados na doc — verificar ABI antes de indexar **[média]**. — https://docs.polymarket.com/resources/blockchain-data
- **Pegadinha crítica** (warproxxx/poly_data): o subgraph Goldsky antigo **não retorna dados completos pós-V2**; o caminho é stream de `OrderFilled` do CTF Exchange V2 via **Envio HyperSync** (token grátis obrigatório desde nov/2025), com join contra metadados da CLOB API. — https://github.com/warproxxx/poly_data
- Relato comunitário sobre recording profissional **[média/anedota]**: picos de ~1.000 updates/s, WS que **dropa mensagens** (uma conexão não basta), múltiplas VMs + snapshot de reconexão + LOCF; validação de sync via `hash` do book. — https://www.reddit.com/r/PredictionMarkets/comments/1shr3jc/
- Fragilidade de fontes de terceiros: archive.pmxt.dev foi forçado a desligar (~jul/26) **[média]** — **não depender de arquivos de terceiros; gravar o próprio dado**. — https://www.reddit.com/r/algotrading/comments/1u8fsg7/

---

## 4) Resolução UMA e riscos (com features mensuráveis)

### 4.1 Mecânica do processo **[alta]**

1. **Proposta**: qualquer proponente (pós-MOOv2: restrito a **37 endereços whitelisted**, nov/2025 **[média]**) posta bond ~**$750** e propõe 0 (NO), 1 (YES) ou 0,5 (50/50). — https://docs.polymarket.com/concepts/resolution
2. **Janela de disputa (liveness)**: **2 horas**. Sem disputa → resolve; proponente recebe bond + reward.
3. **1ª disputa**: o UmaCtfAdapter **reseta** a questão e cria novo request (não vai direto a voto) — filtra disputas frívolas, mas **reinicia o relógio**. — https://0xkowloon.gitbook.io/the-polymarket-book/market-resolution
4. **2ª disputa**: escala ao **DVM** da UMA — voto commit-reveal em rounds de **48h**; quóruns GAT = 5M UMA e SPAT = 65%; sem quórum rola ao próximo round; slashing ~0,1%. Disputa contestada: 48–96h de voto; total típico **4–6 dias**. Opções: P1=NO, P2=YES, P3=desconhecido/50-50, P4=proposta prematura (proponente perde o bond). — https://docs.uma.xyz/using-uma/voting-walkthrough/dvm-2.0.md, https://blog.uma.xyz/articles/what-is-p4
5. Máximo **2 requests por questão**; depois só `resolveManually` (admin).
6. **50/50 (P3)**: cada share paga $0,50 — quem comprou YES a 80¢ recebe 50¢. Raro, mas risco de cauda para posições de alta convicção. Inválido em negRisk (adapter reverte).
7. **Resolução antecipada**: requests são event-based — mercados "will X by DATE" podem resolver quando o evento ocorre; propor cedo demais = P4.
8. **Clarificações**: publicadas onchain via bulletin board contract; não podem mudar a intenção fundamental. **Detectável como diff de `description` entre snapshots do Gamma.**

### 4.2 Números (frequência e prazos)

- **[alta]** UMA (jul/2024): 217 disputas em 11.093 mercados (~2%; 98% sem disputa). — https://blog.uma.xyz/articles/unpacking-polymarkets-meteoric-rise-in-numbers
- **[média]** Estudo polysyncer (18.427 mercados, mai/2025–mai/2026, logs SettleEvent; fonte comercial, não peer-reviewed): **1,0% disputados**; mediana evento→resolução **41 min**, P90 **6h24m**, P99 **4d5h**, P99,9 **11 dias**; disputa adiciona **~49h** na mediana. Por categoria: NBA 0,2%/22min; **cripto-preço 0,6%/38min**; politics-policy 3,4%/4h22m; geopolítica 4,8%/5h16m. Causas: **43% wording ambíguo**, 22% conflito de fontes, 14% reversões tardias. — https://www.polysyncer.com/blog/polymarket-resolution-time-2026
- **[baixa — número conflitante]** Paper em Economics Letters cita **>1.150 mercados disputados no 1º semestre de 2026** — ordem de grandeza acima do estudo polysyncer; provável diferença de contagem ou explosão de mercados pós-V2. **Não conciliado — medir a taxa real no pipeline próprio.** — https://www.sciencedirect.com/science/article/abs/pii/S0165176526003721
- **[média]** Achado acadêmico central: durante a janela proposta→voto, o preço reflete expectativa sobre a **adjudicação**, não só o evento — a distância do preço a 0/1 com evento já conhecido **mede o risco de resolução implícito** (feature direta). — mesma fonte acima.

### 4.3 Casos e risco de governança

- **[média]** Ukraine mineral deal (mar/2025, regime antigo): whale com ~5M UMA em 3 wallets (~25% dos votos) certificou YES falso em mercado de ~$7M; Polymarket chamou de "governance attack" e **não reembolsou**. — https://www.theblock.co/post/348171/polymarket-says-governance-attack-by-uma-whale-to-hijack-a-bets-resolution-is-unprecedented, https://orochi.network/blog/oracle-manipulation-in-polymarket-2025
- **[alta]** Zelensky suit (jul/2025, ~$160–237M): resolveu NO contra reporting amplo ("falta de credible reporting consensus") — critério subjetivo + voto por token. — https://decrypt.co/329210/polymarket-rules-no-237m-bet-zelenskyys
- **[média]** Strategy/BTC (jun/2026, **regime atual**, $60M): execução da venda 26–31/mai vs 8-K de 1º/jun — ambiguidade execução-vs-disclosure; duas resoluções NO contestadas, foi a voto. WSJ (via The Defiant): **>50% dos votos em disputas vêm das 10 maiores carteiras**; >60% dos votantes UMA ativos tinham contas Polymarket. — https://thedefiant.io/news/markets/usd85m-polymarket-dispute-over-strategy-s-may-bitcoin-sale-puts-uma-s-token-voting-oracle-on
- **[média]** Pós-MOOv2 e pós-V2 o risco persiste: "Trump falou com Xi" 17%→95% (mar/2026); "Clavicular pregnancy" $16M em disputa pública (abr/2026; Forbes retornou 403 — detalhes de fontes secundárias). — https://www.forbes.com/sites/digital-assets/2026/04/30/inmates-taking-the-asylum-polymarkets-16m-clavicular-bet/
- **[média]** MOOv2/UMIP-189 (nov/2025): propostas restritas a 37 endereços whitelisted; disputas seguem abertas; **não elimina** concentração de voto no DVM. — https://www.theblock.co/post/366507/polymarket-uma-oracle-update
- **[baixa/anedota]** Relatos Reddit: "UMA rug pulls", mercados long-tail sem resolver porque ninguém propõe (jogo uruguaio; primária de Wisconsin), cláusulas fallback idênticas em massa ("cannot be determined → NO") como risco correlacionado não precificado. — https://www.reddit.com/r/Polymarket/comments/1u8had3/, https://www.reddit.com/r/Polymarket/comments/1vfsrzs/

### 4.4 Features mensuráveis para o modelo de risco de resolução **[alta para disponibilidade dos campos; média para o desenho]**

Via Gamma API por mercado: `umaBond`, `umaReward`, `umaResolutionStatus(es)` (detectar proposed/disputed em tempo real), `umaEndDate` vs `endDate`, `resolvedBy`, `resolutionSource`, `negRisk/negRiskOther`, `automaticallyResolved`, `customLiveness`, `description`.

1. **Flag de disputa ativa** (`umaResolutionStatus`) → circuit breaker: congelar entradas, reavaliar posições.
2. **Bond acima de $750** como proxy de sensibilidade.
3. **Delta endDate vs umaEndDate**.
4. **Diff do texto de rules entre snapshots** = clarificação emitida → red flag.
5. **Rule-precision score por NLP** (43% das disputas = wording): fonte primária única e objetiva (explica os 0,6% de cripto) vs termos subjetivos ("significant", "officially", "agrees to"), múltiplas condições, dependência disclosure-vs-ocorrência (caso Strategy), forma "by DATE" (elegível a resolução antecipada e P4).
6. **Payoff trinário** (YES/NO/50-50) com P(50/50) estimada; em negRisk o 50/50 é estruturalmente impossível.
7. **Custo de capital travado**: distribuição bimodal — caso base ~41min–2h; cauda 49h–6 dias se disputado, ponderada pela taxa da categoria (cripto 0,6%, macro/policy ~3,4%). Incluir E[lockup] no hurdle por trade.
8. **Prêmio de adjudicação**: distância do preço a 0/1 na settlement window com evento conhecido.

**Lacunas honestas [alta]**: não há estatística independente sobre (a) taxa de sucesso de disputas / distribuição P1–P4; (b) frequência exata de 50/50; (c) confirmação explícita de que a camada UMA não mudou com o V2 (evidência indica que não mudou). Medir (a) e (b) dos logs onchain no pipeline próprio.

---

## 5) Ecossistema open-source (repos e lições)

### 5.1 Tabela de repositórios

| Repo                                                                                                                  | ★     | Status/Regime                                      | Utilidade para o projeto                                                                                                                                                                                                             | Conf. |
| --------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| [Polymarket/py-clob-client](https://github.com/Polymarket/py-clob-client)                                             | 1,2k  | **ARQUIVADO**, "no longer functional"              | Nenhuma (migração obrigatória)                                                                                                                                                                                                       | alta  |
| [Polymarket/py-clob-client-v2](https://github.com/Polymarket/py-clob-client-v2)                                       | —     | Ativo, V2                                          | Cliente CLOB oficial (EIP-712, L1+L2, GTC/FOK/FAK)                                                                                                                                                                                   | alta  |
| [Polymarket/py-sdk](https://github.com/Polymarket/py-sdk) (`pip install polymarket-client`)                           | —     | Ativo (push 17/ago/2026)                           | **Ponto de entrada recomendado** (REST+WS unificado)                                                                                                                                                                                 | alta  |
| [Polymarket/polymarket-cli](https://github.com/Polymarket/polymarket-cli)                                             | 2,8k  | Rust, experimental                                 | Tooling operacional com saída JSON                                                                                                                                                                                                   | alta  |
| [Polymarket/real-time-data-client](https://github.com/Polymarket/real-time-data-client)                               | 226   | Ativo                                              | Wrapper oficial do RTDS para o recorder                                                                                                                                                                                              | alta  |
| [Polymarket/agents](https://github.com/Polymarket/agents)                                                             | 3,8k  | **Obsoleto** (nov/2024, sobre v1)                  | Só referência de arquitetura de agente                                                                                                                                                                                               | alta  |
| [Polymarket/poly-market-maker](https://github.com/Polymarket/poly-market-maker)                                       | 322   | **Obsoleto** (mar/2024)                            | Referência histórica de keeper                                                                                                                                                                                                       | alta  |
| [Polymarket/agent-skills](https://github.com/Polymarket/agent-skills)                                                 | 181   | Ativo (ago/2026)                                   | Sucessor espiritual dos agents                                                                                                                                                                                                       | alta  |
| [YichengYang-Ethan/oracle3](https://github.com/YichengYang-Ethan/oracle3)                                             | 247   | Push 08/mai/2026 (execução pode exigir porting V2) | **Grafo de consistência lógica existe**: 6 arbitragens por axiomas (exclusividade, implicação, condicional, soma=1, cross-market, estrutural) + Wang Transform calibrado (λ̂=0,183, 291k contratos); executor com unwind LIFO         | alta  |
| [alfabrandao324/polymarket-arbitrage-trading-bot](https://github.com/alfabrandao324/polymarket-arbitrage-trading-bot) | 15    | README SEO-spam, código real                       | constraintGraph + projeção de Bregman/Frank-Wolfe + sizing por book-walk; **auditar as ideias, não confiar no código**                                                                                                               | média |
| [warproxxx/poly-maker](https://github.com/warproxxx/poly-maker)                                                       | 1,45k | **Explicitamente CLOB V2** (jul/2026)              | **Melhor blueprint de MM**: microprice + inventory skew, spread por vol/toxicidade (markout), máquina de regimes QUIET/TRENDING/EVENT/REDUCE_ONLY/HALTED farmando rewards, kill switches, heartbeat dead-man, journal WS para replay | alta  |
| [warproxxx/poly_data](https://github.com/warproxxx/poly_data)                                                         | 2,3k  | V2                                                 | Pipeline `OrderFilled` onchain via Envio HyperSync (pegadinha do Goldsky documentada)                                                                                                                                                | alta  |
| [Jon-Becker/prediction-market-analysis](https://github.com/Jon-Becker/prediction-market-analysis)                     | 3,8k  | Ativo (10/ago/2026)                                | **Maior dataset público** (36GiB, Polymarket+Kalshi) para calibração do modelo fundamental                                                                                                                                           | alta  |
| [SII-WANGZJ/Polymarket_data](https://github.com/SII-WANGZJ/Polymarket_data)                                           | 797   | Não inspecionado em detalhe                        | Alega 1,1 bi de trades                                                                                                                                                                                                               | média |
| [evan-kolberg/prediction-market-backtesting](https://github.com/evan-kolberg/prediction-market-backtesting)           | 1,1k  | Push mai/2026                                      | **Backtesting mais maduro**: NautilusTrader + replay de deltas de book; MIT+LGPL                                                                                                                                                     | alta  |
| [agent-next/polymarket-paper-trader](https://github.com/agent-next/polymarket-paper-trader)                           | 372   | Ativo (15/ago/2026)                                | Paper trading contra books reais (MCP/CLI); fills otimistas — motor próprio precisará de simulação mais realista                                                                                                                     | alta  |
| [pmxt-dev/pmxt](https://github.com/pmxt-dev/pmxt)                                                                     | 2,1k  | Jovem, 1.100 issues                                | "CCXT dos prediction markets" — só se roadmap incluir cross-venue                                                                                                                                                                    | média |
| [matthewnyc2/arbitrage](https://github.com/matthewnyc2/arbitrage)                                                     | 3     | Push 19/ago/2026, mas sobre v1                     | Scanner negRisk (Σ asks < $1) com simulação de latência — exigiria porting                                                                                                                                                           | média |
| [suislanchez/polymarket-kalshi-weather-bot](https://github.com/suislanchez/polymarket-kalshi-weather-bot)             | 591   | Último push mar/2026 (regime antigo)               | **Playbook transplantável para macro**: ensemble GFS 31 membros → P(evento), edge >8%, Kelly fracionário 15%, calibração Brier                                                                                                       | alta  |
| [yangyuan-zhen/PolyWeather](https://github.com/yangyuan-zhen/PolyWeather)                                             | 274   | Ativo (16/ago/2026)                                | Mesmo nicho, vivo                                                                                                                                                                                                                    | alta  |
| [humanplane/cross-market-state-fusion](https://github.com/humanplane/cross-market-state-fusion)                       | 384   | Jan/2026, regime antigo, paper-only                | PPO fundindo flow Binance + book Polymarket; exemplarmente honesto sobre limitações (fills a mid são fantasia; degradação 20–50% live)                                                                                               | alta  |
| [harrywinter06-code/polymarket-edge](https://github.com/harrywinter06-code/polymarket-edge)                           | 0     | Push 18/ago/2026                                   | **Padrão-ouro de honestidade estatística**: walk-forward 20 janelas, block-bootstrap CI 95%, disclosure de Sharpe negativo pós-custos — template para os gates de validação                                                          | média |
| [ent0n29/polybot](https://github.com/ent0n29/polybot)                                                                 | 933   | Fev/2026, pré-V2                                   | Arquitetura de ingestão ClickHouse+Redpanda e "replication scoring" de wallets                                                                                                                                                       | média |

### 5.2 Lições transversais

1. **[alta]** Divisor de águas V1/V2: repos famosos (agents, poly-market-maker) são regime antigo; verificar sempre a data do último push vs 28/abr/2026.
2. **[alta]** As duas perguntas-chave do dono têm resposta positiva: **grafo de consistência lógica existe** (oracle3; Bregman/Frank-Wolfe no repo alternativo) e **MM com rewards existe e é V2** (poly-maker).
3. **[alta]** **Macro agendado (CPI/FOMC) é espaço aberto** — nenhum repo maduro encontrado; o playbook dos weather bots (distribuição de ensemble → probabilidade → edge threshold → Kelly fracionário) é transplantável.
4. **[alta]** **ALERTA de segurança**: nicho infestado de typosquatting e estrelas botadas — usuário "dev-polymarket" clonando nomes oficiais (506★); TG-Polymarket-bot com 1.049★/530 forks em 3 semanas e 0 issues (padrão de malware/drainer); "bots" que são anúncios de venda via Telegram. **Regra: instalar SDKs somente de github.com/Polymarket; nunca rodar bot de terceiro com a PK real; desconfiar de estrelas desproporcionais a issues/watchers/histórico.**

---

## 6) O que a comunidade aprendeu (Reddit/X)

> **Nota de método [importante]**: reddit.com bloqueia o crawler; coleta via espelho Redlib com permalinks canônicos reconstruídos. Conteúdo de X atrás de login wall — vários itens vêm de snippets indexados. **Tudo nesta seção é relato de usuário/dado não verificado, salvo indicação**; confiança marcada por item.

### 6.1 O que NÃO funciona (evidência convergente)

- **[média]** **Direcional retail em cripto 5-min está morto**: post-mortem de 7 meses (1,7M candles + 4.604 janelas com book gravado) — o livro é calibrado (lado a 0,65 vence ~60–63%); nenhuma banda bate "preço+taxa"; momentum inverte (run≥5 → 46,1% de continuação); stops/TP não salvam entrada sem edge. Única anomalia: fade de moves estendidos ~54–55% — tese, não estratégia. — https://www.reddit.com/r/Polymarket/comments/1un85mg/
- **[média]** **Backtest comunitário de 10 estratégias (set/25–jul/26, 648 mercados líquidos, custos reais + CI 95%): zero edge sobrevive.** Destaques: FLB **não existe** na Polymarket (longshots ≤0,20: implícito 0,73% vs real 1,15% — levemente **sub**precificados); base rate ~17% YES; Dutch book negRisk: vazio; momentum era lookahead (84%→54,1% corrigido); swarm de 8 LLMs: Brier 0,38 vs 0,30 do mercado; desconto de settlement-lag (0,3–1,7%) < custo (~2%). Código reproduzível publicado. — https://www.reddit.com/r/PredictionMarkets/comments/1ubletl/
- **[média]** **Copy-trade de leaderboard é armadilha**: correlação de skill 1ª→2ª metade = 0,035; top-15 copiados perderam −13,6% out-of-sample; ranking por win rate seleciona farmers de 90–99¢; feed público só mostra o lado taker; >50% das wallets têm um único mercado com >40% do PnL. — https://www.reddit.com/r/Polymarket/comments/1v73282/
- **[média]** **Arb taker Binance→Polymarket**: lead-lag existe (~200–250ms, estável), mas markout taker +1s é negativo em todos os símbolos (−0,4 a −0,5¢); spread ~1¢ é o piso. Armadilha metodológica: offset estrutural Binance↔Chainlink (~0,12% em ETH) criou falso sinal de +$456. — https://www.reddit.com/r/Polymarket/comments/1udy8xe/
- **[média/anedota]** **Case esports com PnL público (wallet b00k13)**: arb +$8.293, residual −$3.184, net ~$5k/3 meses; decadência documentada (fill rate 37%→1% jan→abr; lucro de arb $4.158→$17). Autópsia: quotes stale (odds com 30min de atraso), devig nunca validado, expansão sem odds frescas. Reescrita em Rust + odds frescas de ~10 books a cada 5min voltou a ~+$650/mês. Lição: **frescor do sinal > código**. — https://www.reddit.com/r/algotrading/comments/1u17e2v/, https://www.reddit.com/r/algotrading/comments/1ujsw6m/, https://www.reddit.com/r/algotrading/comments/1va6s13/
- **[média/anedota]** **Migração V2 = mortalidade de estratégia**: bot de MM que rendia 3–8%/mês "devolveu tudo" na semana do upgrade; edge em 5-min BTC sumiu no mesmo período. **Gate de re-validação após qualquer mudança da venue.** — https://www.reddit.com/r/algotrading/comments/1t1tg30/
- **[baixa/anedota]** **Macro agendado com books finos**: "a aposta de 20¢ sai em média a 80¢" ao colocar mais que alguns dólares — dimensionar pela profundidade gravada, não pelo mid. — https://www.reddit.com/r/algotrading/comments/1t1tg30/

### 6.2 O que funciona (com ressalvas)

- **[média/anedota]** **Supply-side industrial**: análise onchain de wallets do leaderboard (~$143K/mês, ~39k predições) — nenhuma prevê direção; mecânica = SPLIT + venda dos dois lados como maker (~2%/par), buy-both-and-merge quando Up+Down < $1, varredura dos extremos; 3 receitas empilhadas (spread + fee zero + liquidity rewards). Edge de 1–3¢/par — **só em escala 24/7**. — https://www.reddit.com/r/Polymarket/comments/1un85mg/
- **[média]** **Uso defensivo do sinal externo**: quando o fair da Binance move contra sua quote, markout passivo −0,7 a −1,7¢ vs +0,7/+1,0¢ quando não move — o feed serve para **cancelar quotes stale**, não para atacar. — https://www.reddit.com/r/Polymarket/comments/1udy8xe/
- **[média]** **Liquidity rewards são renda real do lado maker**, mas favorecem tamanho e presença 24/7; "em size pequeno não paga seu tempo"; nenhum relato de single-user pequeno vivendo só de rewards pós-V2. — https://www.reddit.com/r/Polymarket/comments/1tr5310/
- **[baixa/anedota]** **"Certeza estrutural" (NO em eventos institucionalmente quase impossíveis)**: filtro de 6 passos + LLM + Gamma API + Kelly fracionário com penalidade de 3–5pp; auto-reportado +15% em 60 dias, 23/24 wins, hold ~17d. Amostra pequena, não auditada — mas coerente com base rate ~17% YES. — https://www.reddit.com/r/Polymarket/comments/1ui38x4/
- **[alta]** **Grandes vencedores tinham edge fundamental proprietário, não velocidade**: Théo (~$85M, eleições 2024, regime antigo) com "neighbor polling" encomendado — https://www.cbsnews.com/news/french-whale-made-over-80-million-on-polymarket-betting-on-trump-election-win-60-minutes/; Domer (#1 do leaderboard): "bet in accordance with your edge; if you don't find an edge, don't bet", sizing proporcional ao edge, preferência por mercados novos, alerta de que alta liquidez induz overbetting, e crítica ao desalinhamento dos votantes UMA — https://www.onchaintimes.com/a-chat-with-domer-the-1-trader-on-polymarket/

### 6.3 Execução e operação (relatos)

- **[média/anedota]** Falhas concretas do CLOB: FAK com partial-fill e reprice; corridas de "not enough balance/allowance"; "phantom fills" (API diz filled, chain diz que não) — **reconciliar posição contra saldo onchain**; fills reais 2–10¢ piores que o book visto; janelas de manutenção confirmadas (jun/26). Cobertura técnica diz que o V2 corrigiu ghost fills **[média]** — reconciliar mesmo assim. — https://www.reddit.com/r/Polymarket/comments/1tuzuei/, https://www.quantvps.com/blog/polymarket-fixes-ghost-fills-clob-v2-upgrade
- **[média]** Paper trading com realismo de execução muda tudo: com slippage/degradação de fill/stress, "PnL agregado vira negativo; muito do que parecia lucrativo era otimismo de execução"; mediana de idade de quote ~1,7s mas p95 50s+. — https://www.reddit.com/r/algotrading/comments/1tv6vug/
- **[média]** Gateway US ≠ CLOB internacional: rejeições sistemáticas não documentadas em in-play — **a venue tem regras de execução que só se descobrem empiricamente**. — https://www.reddit.com/r/Polymarket/comments/1v3jd4o/
- **[baixa]** Wash trading/sybil: ~25% do volume estimado como wash (ver §8); clusters por funder (27 wallets de um funder, 92% WR); **filtrar por cluster de funding antes de usar fluxo como feature**. — https://www.reddit.com/r/Polymarket/comments/1sz2a22/
- **[baixa]** negRisk: teste de Dutch book deu vazio; nº1 all-time (swisstony, 163k trades) descrito como bot de arbitragem — nicho ocupado por bots rápidos. Ponto operacional: **split/merge em negRisk gera PnL errado na UI/API** — relevante para reconciliação contábil. — https://www.reddit.com/r/PredictionMarkets/comments/1vrwsyl/
- **[média]** Smart-money tracking quebrou no V2 (novos endereços via deposit wallets/pUSD) — remapear identidades pós-28/abr/2026. — https://x.com/riyuexiaochu/status/2054554691057655875
- **[média]** Yield de 4% a.a. pago diariamente em posições abertas de mercados selecionados de longo prazo (tweet oficial) — reduz custo de carregamento em macro distante; verificar elegibilidade pós-V2. — https://x.com/Polymarket/status/1970886833153184127
- **[alta]** **Truth Social — achado negativo honesto**: nenhum conteúdo técnico de traders lá; só mercados SOBRE o Truth Social e a parceria abortada Trump Media/Crypto.com. A conversa técnica está no X, Substack/blogs e GitHub. — https://gamingamerica.com/news/1094894/crypto-com-breaks-things-off-with-truth-social-on-prediction-markets
- **[média — leads a validar]** Threads no X para leitura direta (não lidas na íntegra): 0xMovez "Top 10 strategies" (https://x.com/0xMovez/status/2004570871294239187), DeRonin_ farming de rewards (https://x.com/DeRonin_/status/1993009781716709753), RCOM double farming LP (https://x.com/rcom1337/status/2040832134823223424), Eli5DeFi sobre o stack V2 (https://x.com/Eli5defi/status/2041396329654677990), dunik mapa de repos oficiais (https://x.com/dunik_7/status/2004512366675829093).

---

## 7) Evidência quant (com números)

### 7.1 Favorite-longshot bias — evidência em tensão

| Fonte                                                                                                                                                                                | Achado                                                                                                                                                                                                                                                              | Conf.                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Snowberg & Wolfers (JPE 2010) — http://users.nber.org/~jwolfers/papers/Favorite_Longshot_Bias.pdf                                                                                    | Longshots 100/1 retornam ~**−61%**; favoritos ~−5,5%; causa: mispercepção de probabilidade                                                                                                                                                                          | alta                                                 |
| Bürgi, Deng & Whelan (CESifo/CEPR 2026, Kalshi, 300k+ contratos) — https://www.ifo.de/en/cesifo/publications/2026/working-paper/makers-and-takers-economics-kalshi-prediction-market | Contratos 5–20¢ vencem menos que o preço implica; 80–95¢ vencem mais (retorno positivo pequeno); acurácia melhora perto do fechamento                                                                                                                               | alta                                                 |
| arXiv 2606.19517 (Polymarket crypto, dados 2023) — https://arxiv.org/abs/2606.19517                                                                                                  | Thresholds de BTC negociaram **5,6pp acima** da implícita por opções Binance (t=6,46) e **~11pp** vs Deribit; concentrado em prob. baixas e maturidades longas; **half-life de reversão ~4h**; proxy delta-hedged: win rate 69% em 16 trades (alpha 0,067, p=0,053) | alta (direção); magnitudes exigem revalidação pós-V2 |
| Backtest comunitário Reddit (set/25–jul/26) — https://www.reddit.com/r/PredictionMarkets/comments/1ubletl/                                                                           | **FLB NÃO existe na Polymarket**: longshots ≤0,20 levemente **sub**precificados (implícito 0,73% vs real 1,15%); apostar NO em todos os cortes: CI −1,5% a +0,4%                                                                                                    | média                                                |

**Leitura honesta**: a literatura clássica e Kalshi apontam FLB; o único estudo com custos reais na Polymarket pós-fees não o encontra; e o sinal específico de crypto (sobrepreço vs opções) é de 2023. **Não assumir FLB como edge — medi-lo por categoria no pipeline próprio** (o dataset de Jon-Becker e o modelo hierárquico do oracle3, λᵢ = 0,259 − 0,072·ln(1+V) + 0,143·ln(1+D) − 0,477·|p−0,5|, são pontos de partida) **[média]**.

### 7.2 Calibração — a barra que o modelo fundamental tem de pular

- **[média]** Follymarket (Polymarket 2024, intervalos de 10min): **Brier 0,074** não ponderado / 0,13 ponderado; **termo de calibração ~0,0005** — o erro vem de refinement, não de calibração. — https://nickhaubri.ch/blog/follymarket-polymarket-forecast-assessment/
- **[média]** Benchmark comunitário (13,4M pontos, ~46.910 mercados ≥$200k): **BSS = 0,231 [0,215–0,246]** vs climatologia em 24h; miscalibração 0,0005–0,0034. Alerta: incluir mercados degenerados (>0,99/<0,01) infla métricas (BSS salta a 0,428); `closedTime` da UMA chega **depois** de o desfecho ser público — **cuidado com leakage em labels**. — https://www.reddit.com/r/PredictionsMarkets/comments/1v78k3i/
- **[alta]** Page & Clemen (Economic Journal 2013): miscalibração **cresce com tempo-até-expiração** — favorece operar perto da resolução e tratar preços longos como menos informativos. — https://onlinelibrary.wiley.com/doi/10.1111/j.1468-0297.2012.02561.x
- **[média]** Macro: sub-reação a sinal público (~**0,64-por-1**) com drift previsível nos minutos seguintes, maior com liquidez baixa — nowcast benchmark + operar drift residual pós-release tem suporte empírico (plataforma exata não confirmada no abstract). — https://arxiv.org/abs/2606.07811

### 7.3 Kelly e portfólio

- **[alta]** Baker & McHale (Decision Analysis 2013): sob incerteza de estimativa, a fração de Kelly ótima é **encolhida**, com shrinkage crescendo na variância da estimativa; ~meio-Kelly aproxima o ótimo com barras de erro realistas (Downey); extensão a múltiplos desfechos em arXiv 1701.02814. Justifica Kelly fracionário 0,25–0,5 ligado à incerteza do modelo. — https://pubsonline.informs.org/doi/abs/10.1287/deca.2013.0271
- **[média]** Correlação entre mercados é **moderada a extrema** (mesmo tema/entidade) — quebra a premissa de independência: **dimensionar no nível do fator** (preço do BTC, decisão do Fed), não do mercado. — https://nickhaubri.ch/blog/follymarket-polymarket-forecast-assessment/

### 7.4 Microestrutura

- **[alta]** "Anatomy of the Polymarket Order Book" (arXiv 2604.24366; 52 dias fev–abr/2026, 30,3 bi eventos WS + 255,4 mi OrderFilled onchain, **pré-V2**): half-spread cotado mediano **~400bps** em 40–60¢ e **1.300–1.800bps** abaixo de 10¢; top-of-book carrega só **~13,6%** do top-10 de profundidade; **~32 makers efetivos** por mercado (HHI 0,031); wash mediano 0,97% (máx 22%). — https://arxiv.org/html/2604.24366v2
- **[alta — armadilha de engenharia]** Mesmo paper: o campo de direção do feed WS público concorda só **~59%** com a direção real do agressor onchain; Kyle lambda inferido do feed inverte sinal em 43–60% das janelas. **Features dependentes de direção (OFI, VPIN, lambda) devem vir de `OrderFilled` onchain, não do feed.**
- **[alta]** Glosten-Milgrom (JFE 1985) é formulado para ativo binário: spread = compensação por fluxo informado; adverse selection é pior perto de eventos informacionais — **alargar/puxar cotações antes de releases e resoluções**. — https://www.sciencedirect.com/science/article/pii/0304405X85900443
- **[alta]** Kalshi (Whelan et al.): **makers ganham (pequeno), takers perdem sistematicamente**; na Polymarket, componentes de adverse selection medianos ~0 nos top-100 — favorece execução passiva como default. — https://cepr.org/publications/dp20631
- **[média]** Não existe adaptação publicada de **Avellaneda-Stoikov para livros binários** — lacuna real; adaptações necessárias: preço em [0,1], payoff terminal com salto na resolução, inventário que expira. — https://pmc.ncbi.nlm.nih.gov/articles/PMC9767337/
- **[baixa]** Spread largo em nicho pode sinalizar contraparte informada, não edge (efeito de seleção; baseado em resumo, paper não lido na íntegra). — https://arxiv.org/pdf/2605.00493

### 7.5 Coerência lógica e arbitragem

- **[alta]** Histórico: **~US$40M** extraídos de violações de coerência (rebalancing + combinatória) na Polymarket (AFT 2025); janelas caíram de ~12,3s para ~2,7s, ~73% dos lucros para bots sub-100ms **[média]**. — https://arxiv.org/abs/2508.03474, https://suarez-tangil.networks.imdea.org/papers/2025aft-arbitrage.pdf
- **[alta]** Estado atual (NBA, fev–mar/2026, 75 mi snapshots): arb single-market praticamente extinta (**7 episódios em 3.042 mercados, mediana 3,6s, 0,0001% do tempo**); combinatória mais frequente (290 episódios, ~101bps mediano) mas **76,9% limitada a ~14,8 shares executáveis — lucro total ~US$560 no mês**. — https://arxiv.org/html/2605.00864v1
- **[alta]** **Cuidado com falso edge em quase-certezas**: ajustar pelo "annualized settlement wedge" (capital travado até o oráculo) elimina **48–88%** do gradiente de horizonte — comprar 97–99¢ "garantidos" rende em grande parte custo de capital; conversão negRisk comprime o desconto. — https://arxiv.org/abs/2605.31431
- **Conclusão**: o grafo de coerência serve como **validador de preços e trigger de re-cotação/sanity-check**, não como fonte primária de PnL.

### 7.6 Datasets e validade externa

- **[alta]** **Polymarket-v1 Database** (arXiv 2606.04217): 1,20 bi de trades, 1,30 mi de mercados, 21/nov/2022 a **28/abr/2026** (termina na migração), ~$61 bi de volume, **direção do agressor ground-truth** — huggingface.co/datasets/TimeSeventeen/Polymarket-v1. Ideal para backtest do regime antigo.
- **[alta]** Dataset CC0 comunitário: top-of-book segundo-a-segundo de mercados 5-min cripto (~89k mercados, ~26,8M amostras, mar–mai/2026, parcialmente já V2) **[média]**. — https://www.reddit.com/r/algotrading/comments/1u8fsg7/
- **[alta]** **Validade externa**: praticamente toda a evidência empírica específica é pré-V2. Vieses comportamentais tendem a persistir; **números de microestrutura precisam ser re-medidos no V2**. Nenhum paper com dados pós-V2 encontrado até ago/2026.

---

## 8) Incidentes e defesas automáticas

### 8.1 Incidentes por eixo

**Oráculo/resolução** (ver §4.3 para detalhes): Ukraine mineral deal ($7M, mar/2025), Zelensky suit (~$160–237M, jul/2025), Strategy/BTC ($60M, jun/2026, regime atual), Trump-Xi 17%→95% (mar/2026), Clavicular $16M (abr/2026). **Precedente: sem reembolso por resolução manipulada** **[alta]**. — https://www.coindesk.com/markets/2025/03/27/polymarket-uma-communities-lock-horns-after-usd7m-ukraine-bet-resolves

**Wash trading** **[alta]**: estudo de Columbia (nov/2025) estima **~~25% do volume total (~~$4,5B)** como suspeito; pico ~60% semanal em dez/2024 (farming de airdrop); por categoria: **sports 45%, elections 17%, politics 12%, crypto 3%**. Favorável às categorias-alvo, mas **invalida volume bruto como proxy de liquidez**. — https://www.coindesk.com/markets/2025/11/07/polymarket-s-trading-volume-may-be-25-fake-columbia-study-finds

**Segurança** **[alta]**: 26/jun/2026 — vendor de autenticação comprometido injetou script no frontend, drenando **~$2,9–3,1M** em pUSD de wallets de usuários (reembolsado; dependência removida); mai/2026 — $700K de ops wallet via chave privada antiga. Um bot que assina localmente via API **fica fora do vetor principal**, mas o ataque foi supply-chain — pin de dependências obrigatório. — https://www.coindesk.com/markets/2026/06/27/polymarket-hack-updated-to-usd3-1-million-days-after-the-platform-promised-users-full-refunds

**Regulatório/geoblock**: CFTC multou $1,4M e forçou bloqueio dos EUA em 2022; relançamento aprovado nos EUA em 2026 **[alta]** — https://www.cftc.gov/PressRoom/PressReleases/8478-22; França/ANJ: bloqueio de transações nov/2024 → bloqueio por ISPs jul/2026 **[alta]** — https://cryptoslate.com/polymarket-blocked-french-transactions-but-578751-users-later-france-blocked-the-entire-site/; regimes "close-only" (Singapura, Taiwan, Polônia, Tailândia) com janelas de unwind às vezes de **48h**; VPN pode congelar conta com fundos travados **[média — agregador comercial]** — https://www.datawallet.com/crypto/polymarket-restricted-countries

**Custódia** **[média]**: proxy wallet (contrato 1-of-1 na Polygon) — não-custodial onchain, mas a plataforma pode bloquear conta/interface; login Magic (email) é ponto único de falha; resgate com conta banida exige interação direta com contratos. — https://polyflux.io/blog/polymarket-wallet-types/

**Concentração de fluxo como risco de sinal** **[alta]**: caso Théo — 4 contas, >$30M, moveu sozinho o preço do mercado eleitoral 2024; **preço não é probabilidade agregada quando a concentração de holders é alta**. — https://www.cbsnews.com/news/french-whale-made-over-80-million-on-polymarket-betting-on-trump-election-win-60-minutes/

### 8.2 Pipeline de defesa automática (síntese consolidada do corpus)

**PRÉ-TRADE (modelo de risco de resolução)**

- Rule-precision score (NLP) do texto da regra; **veto** se fonte de verificação subjetiva/"consenso de mídia"/critério estético, prazo vs. disclosure ambíguo, ou múltiplas condições encadeadas.
- Payoff **trinário** com P(50/50); elegibilidade restrita a resolução objetivamente verificável (feed de preço, dado onchain, publicação oficial datada).

**INTRA-TRADE (circuit breakers)**

- Congelar entradas e reavaliar saída quando: (i) mercado entra em disputa UMA (`umaResolutionStatus`); (ii) preço salta além de limiar sem notícia correspondente (padrões 17%→95% e 9%→100%); (iii) clarificação detectada (diff de rules); (iv) mudança de status do mercado/categoria. **Nunca aumentar posição durante janela de disputa.**

**MICROESTRUTURA**

- Liquidez via **profundidade de book e spread efetivo, nunca volume** (25% pode ser wash).
- Features de concentração: share dos top-N holders (`/holders`), detecção de wallets correlacionadas/cluster de funding.
- Direção de fluxo só de `OrderFilled` onchain (feed WS erra ~41% das direções).

**PLATAFORMA/OPERAÇÃO**

- Caps por mercado e agregados **assumindo perda total em resolução manipulada**; cap worst-case por grupo negRisk.
- EOA própria (sem Magic/email); allowance de pUSD no mínimo operacional (sem approve infinito); hot wallet só com capital do dia + sweep automático para cold; alertas onchain para approvals/transferências não originadas pelo bot.
- Pin e auditoria de dependências (lição do hack supply-chain); SDKs só do org oficial (lição do typosquatting).
- Kill switch regulatório: monitor do status do país do servidor; ao detectar mudança, modo close-only interno imediato e **plano de unwind em 48h**; IP estável, nunca VPN.
- Kill switches de trading (blueprint poly-maker): perda diária, heartbeat dead-man da exchange, halt por WS stale.

---

## 9) Implicações diretas para as nossas RFCs (lista acionável)

**Execução / microestrutura**

1. **Default maker**: GTC + `postOnly` com repricing; FAK/FOK apenas quando edge do modelo fundamental > fee taker + spread medido. Em crypto a fee taker é a mais cara (0,07; ~1,75¢/share a p=0,5) e o subsídio maker é o mais pesado ($1M/mês TWAP + 20% de rebate pool) **[alta]**.
2. **Validador de ordens local**: replicar exatamente a sequência de arredondamento tick/size/amount da doc; um call a `GET /book` resolve `tick_size` + `min_order_size` + `neg_risk` antes de assinar; **nunca hardcodar o Exchange** — decidir standard vs negRisk pelo flag **[alta]**.
3. **Semânticas não óbvias a codificar**: timestamp do struct em **ms** vs expiration GTD em **s**; buffer GTD (−1 min; mínimo +3 min); taker delay de 250ms com cancelamento bloqueado; `RETRYING` sem duplicar fills; FAK/FOK sem transactionHashes (usar tradeIDs + polling `/trades`) **[alta]**.
4. **Reconciliação**: fee real via `fee_rate_bps` do WS `last_trade_price`; posição contra saldo onchain (phantom fills são regime antigo em tese, mas reconciliar mesmo assim) **[alta/média]**.
5. **Sinal externo (Binance/Chainlink) com uso defensivo**: cancelar quotes stale quando o fair move contra (markout −0,7 a −1,7¢) em vez de atacar como taker (markout negativo) **[média]**. Cuidado com o offset estrutural Binance↔Chainlink (~0,12% em ETH) **[média]**.
6. **Adverse selection**: alargar/puxar cotações antes de releases (macro) e perto de resoluções (Glosten-Milgrom) **[alta]**.

**Dados / recorder** 7. **O recorder é a única fonte de microestrutura histórica** — dimensionar para bursts de ~1.000 updates/s, múltiplas conexões WS com dedupe, re-sync via REST `/book` + verificação por `hash`, gravação contínua do RTDS (sem replay) **[alta + média]**. 8. **Versionar**: `description` (regras) + `updatedAt`, `feeSchedule`/`/clob-markets/{condition_id}`, tick size (evento `tick_size_change`); amostrar e persistir OI/spread/holders (só há valor corrente) **[alta]**. 9. **Backfill de fills**: `OrderFilled` onchain via Envio HyperSync (Goldsky antigo incompleto pós-V2); features de direção **somente** de dados onchain **[alta]**. 10. **Usar keyset pagination** no Gamma; `takerOnly=false` no `/trades` quando quiser pernas maker; janelamento por timestamp para backfill profundo **[alta]**. 11. **Chainlink TWAP 30/60s como insumo direto do modelo fundamental de crypto** — é o dado que resolve os mercados; zero basis risk **[alta]**.

**Modelo fundamental** 12. **Gate de ativação**: bater o Brier/log-loss do próprio preço em backtest (preço tem Brier ~0,074 e BSS ~0,23) — barra alta e explícita **[média]**. 13. **Não assumir FLB como edge** — evidência em conflito (Kalshi sim; Polymarket pós-fees não); medir por categoria no pipeline; sinal crypto-vs-opções (5,6–11pp, half-life 4h) é o candidato mais promissor, mas é de 2023 e exige revalidação **[média]**. 14. **Descontar settlement wedge** (tempo-até-resolução) antes de declarar edge em quase-certezas — 48–88% do "edge" some **[alta]**. 15. **Macro agendado**: nowcast benchmark + drift pós-anúncio (~0,64-por-1) é a hipótese com suporte; competição informada (CME FedWatch); espaço open-source aberto — playbook dos weather bots é transplantável **[média]**. 16. Concentrar exposição perto da resolução (miscalibração cresce com horizonte) **[alta]**.

**Modelo de risco de resolução (4º modelo — validado como primeira ordem)** 17. Implementar as 8 features do §4.4 (status/disputa, bond, diffs de regra, NLP de ambiguidade, payoff trinário, lockup bimodal, prêmio de adjudicação) **[alta/média]**. 18. Circuit breaker de disputa + proibição de aumentar posição em disputa + assumir perda total possível (precedente de não-reembolso) **[alta]**. 19. Medir no pipeline próprio (logs SettleEvent/priceDisputed): taxa de sucesso de disputas, distribuição P1–P4, frequência de 50/50 — não existem estatísticas independentes **[alta]**.

**Portfólio / sizing** 20. Kelly fracionário (0,25–0,5) com shrinkage ligado à variância da estimativa; **dimensionar no nível do fator** (BTC, Fed), não do mercado — correlações são altas **[alta/média]**. 21. Sizing pela **profundidade executável gravada** (book-walk), nunca pelo mid — especialmente em macro (books finos) **[média/baixa]**. 22. Hurdle por trade incluindo E[lockup] e cenário 50/50 como perda de cauda; negRisk elimina 50/50 mas concentra risco de resolução conjunta **[média]**. 23. Grafo de coerência lógica: implementar como **validador/sanity-check e trigger de re-cotação** (referências: oracle3; Bregman/Frank-Wolfe), não como fonte primária de PnL (arb esgotada em líquidos: ~$560/mês no estudo NBA) **[alta]**.

**Gates de validação e operação** 24. **Paper trading com realismo de execução** (slippage, degradação de fill, latência, stress) — fills a mid são fantasia; degradação esperada 20–50% live **[média]**. Template metodológico: walk-forward + block-bootstrap com CI 95% (polymarket-edge) **[média]**. 25. **Gate de re-validação após qualquer mudança da venue** (fees mudam por categoria ao longo do tempo; V2 matou estratégias vivas) **[alta/média]**. 26. **Segurança**: SDKs só do org Polymarket; nunca PK em bot de terceiro; EOA própria; allowance mínima; sweeps; pin de dependências; kill switch regulatório com unwind em 48h **[alta]**. 27. **Expectativa calibrada**: 84% das carteiras em PnL negativo; trader médio perde ~o vig — o gate paper→real deve exigir evidência de decil superior **[média]**. 28. Tratar rebates taker como upside não-confiável (relato de não-pagamento; "sete tiers" vs seis na tabela — verificar) **[média/baixa]**.

---

## 10) Fontes completas

### Documentação oficial Polymarket (core + dados)

- https://docs.polymarket.com/v2-migration
- https://docs.polymarket.com/trading/fees
- https://docs.polymarket.com/trading/place-orders
- https://docs.polymarket.com/trading/wallets-auth
- https://docs.polymarket.com/concepts/prices-orderbook
- https://docs.polymarket.com/concepts/order-lifecycle
- https://docs.polymarket.com/concepts/positions-tokens
- https://docs.polymarket.com/concepts/pusd
- https://docs.polymarket.com/concepts/negative-risk
- https://docs.polymarket.com/concepts/resolution
- https://docs.polymarket.com/programs/liquidity-rewards
- https://docs.polymarket.com/programs/maker-rebates
- https://docs.polymarket.com/programs/taker-rebates
- https://docs.polymarket.com/api-reference/market-data/get-fee-rate
- https://docs.polymarket.com/api-reference/market-data/get-tick-size
- https://docs.polymarket.com/api-reference/market-data/get-order-book
- https://docs.polymarket.com/api-reference/markets/list-markets
- https://docs.polymarket.com/api-reference/markets/get-market-by-id
- https://docs.polymarket.com/api-reference/markets/get-clob-market-info
- https://docs.polymarket.com/api-reference/markets/get-prices-history
- https://docs.polymarket.com/api-reference/events/list-events
- https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets
- https://docs.polymarket.com/api-reference/core/get-current-positions-for-a-user
- https://docs.polymarket.com/api-reference/rate-limits
- https://docs.polymarket.com/api-reference/wss/market
- https://docs.polymarket.com/market-data/overview
- https://docs.polymarket.com/market-data/realtime-data
- https://docs.polymarket.com/market-data/chainlink-twap
- https://docs.polymarket.com/market-data/public-analytics
- https://docs.polymarket.com/resources/blockchain-data
- https://docs.polymarket.com/resources/contracts
- https://docs.polymarket.com/changelog/predictions
- https://docs.polymarket.com/llms.txt
- https://docs.polymarket.com/advanced/neg-risk
- https://docs.polymarket.com/polymarket-101
- https://help.polymarket.com/en/articles/13364551-how-are-markets-disputed
- https://help.polymarket.com/en/articles/13364163-geographic-restrictions
- https://ambcrypto.com/polymarket-rolls-out-pusd-migration-with-clob-v2-exchange-upgrade/

### Resolução UMA

- https://docs.uma.xyz/using-uma/voting-walkthrough/dvm-2.0.md
- https://blog.uma.xyz/articles/what-is-p4
- https://blog.uma.xyz/articles/unpacking-polymarkets-meteoric-rise-in-numbers
- https://0xkowloon.gitbook.io/the-polymarket-book/market-resolution
- https://github.com/Polymarket/uma-ctf-adapter
- https://github.com/Polymarket/neg-risk-ctf-adapter/blob/main/docs/index.md
- https://www.polysyncer.com/blog/polymarket-resolution-time-2026
- https://www.sciencedirect.com/science/article/abs/pii/S0165176526003721
- https://arxiv.org/pdf/2604.15674
- https://poly-sim.com/wiki/polymarket-resolution-explained.html

### GitHub / ecossistema open-source

- https://github.com/Polymarket/py-clob-client
- https://github.com/Polymarket/py-clob-client-v2
- https://github.com/Polymarket/py-sdk
- https://github.com/Polymarket/polymarket-cli
- https://github.com/Polymarket/real-time-data-client
- https://github.com/Polymarket/poly-market-maker
- https://github.com/Polymarket/agents
- https://github.com/Polymarket/agent-skills
- https://github.com/Polymarket/neg-risk-ctf-adapter
- https://github.com/Polymarket/ctf-exchange-v2
- https://github.com/warproxxx/poly-maker
- https://github.com/warproxxx/poly_data
- https://github.com/YichengYang-Ethan/oracle3
- https://github.com/YichengYang-Ethan/prediction-market-pricing
- https://github.com/Jon-Becker/prediction-market-analysis
- https://github.com/evan-kolberg/prediction-market-backtesting
- https://github.com/agent-next/polymarket-paper-trader
- https://github.com/pmxt-dev/pmxt
- https://github.com/ent0n29/polybot
- https://github.com/humanplane/cross-market-state-fusion
- https://github.com/suislanchez/polymarket-kalshi-weather-bot
- https://github.com/yangyuan-zhen/PolyWeather
- https://github.com/matthewnyc2/arbitrage
- https://github.com/harrywinter06-code/polymarket-edge
- https://github.com/alfabrandao324/polymarket-arbitrage-trading-bot
- https://github.com/ImMike/polymarket-arbitrage
- https://github.com/SII-WANGZJ/Polymarket_data
- https://github.com/mothparkzo6249/TG-Polymarket-bot
- https://github.com/dev-polymarket
- https://github.com/learningworship/polymarket-latency-bot

### Reddit (relatos de comunidade — coletados via espelho Redlib)

- https://www.reddit.com/r/Polymarket/comments/1un85mg/
- https://www.reddit.com/r/Polymarket/comments/1tgrx6l/
- https://www.reddit.com/r/Polymarket/comments/1ukqe03/
- https://www.reddit.com/r/Polymarket/comments/1tjvh98/
- https://www.reddit.com/r/Polymarket/comments/1udy8xe/
- https://www.reddit.com/r/algotrading/comments/1t1tg30/
- https://www.reddit.com/r/algotrading/comments/1u17e2v/
- https://www.reddit.com/r/algotrading/comments/1ujsw6m/
- https://www.reddit.com/r/algotrading/comments/1va6s13/
- https://www.reddit.com/r/algotrading/comments/1v2oyv1/
- https://www.reddit.com/r/algotrading/comments/1u8fsg7/
- https://www.reddit.com/r/algotrading/comments/1vc2qt7/
- https://www.reddit.com/r/algotrading/comments/1uo6uhz/
- https://www.reddit.com/r/algotrading/comments/1uo4cin/
- https://www.reddit.com/r/algotrading/comments/1tv6vug/
- https://www.reddit.com/r/algotrading/comments/1u0cz4n/
- https://www.reddit.com/r/PredictionMarkets/comments/1ubletl/
- https://www.reddit.com/r/PredictionsMarkets/comments/1v78k3i/
- https://www.reddit.com/r/PredictionMarkets/comments/1shr3jc/
- https://www.reddit.com/r/PredictionMarkets/comments/1vrwsyl/
- https://www.reddit.com/r/Polymarket/comments/1vr6bkx/
- https://www.reddit.com/r/Polymarket/comments/1u8had3/
- https://www.reddit.com/r/Polymarket/comments/1ukzeag/
- https://www.reddit.com/r/Polymarket/comments/1vfsrzs/
- https://www.reddit.com/r/Polymarket/comments/1vn4qdc/
- https://www.reddit.com/r/Polymarket/comments/1uj713z/
- https://www.reddit.com/r/Polymarket/comments/1v73282/
- https://www.reddit.com/r/Polymarket/comments/1t5qlhn/
- https://www.reddit.com/r/Polymarket/comments/1sz2a22/
- https://www.reddit.com/r/Polymarket/comments/1rx0041/
- https://www.reddit.com/r/Polymarket/comments/1v3jd4o/
- https://www.reddit.com/r/Polymarket/comments/1v6ag7w/
- https://www.reddit.com/r/Polymarket/comments/1ui38x4/
- https://www.reddit.com/r/Polymarket/comments/1va3c8v/
- https://www.reddit.com/r/Polymarket/comments/1tr5310/
- https://www.reddit.com/r/Polymarket/comments/1ueiybh/
- https://www.reddit.com/r/Polymarket/comments/1tuzuei/
- https://www.reddit.com/r/Polymarket/comments/1txjiv5/
- https://www.reddit.com/r/Polymarket/comments/1vfe34b/
- https://www.reddit.com/r/Polymarket/comments/1s72zh4/
- https://www.reddit.com/r/Polymarket/comments/1t5qwgp/

### X / cobertura secundária

- https://x.com/PolymarketDevs/status/2045173502328594677
- https://x.com/riyuexiaochu/status/2054554691057655875
- https://x.com/Eli5defi/status/2041396329654677990
- https://x.com/Mikey0x_/status/1818327819266757069
- https://x.com/recallnet/status/2031392209585811761
- https://x.com/DeRonin_/status/1993009781716709753
- https://x.com/rcom1337/status/2040832134823223424
- https://x.com/Polymarket/status/2036225958034772014
- https://x.com/Polymarket/status/1970886833153184127
- https://x.com/CryptoRank_io/status/1993331676588499353
- https://x.com/maybeYonas/article/2087908930945216753
- https://x.com/0xMovez/status/2004570871294239187
- https://x.com/dunik_7/status/2004512366675829093
- https://x.com/lunatik_corp/status/1985665170413178989
- https://www.cryptotimes.io/2026/04/30/polymarket-tvl-crosses-500m-following-clob-v2-rollout/
- https://crypto.news/polymarket-rolls-out-clob-v2-with-1m-liquidity-rewards-to-harden-prediction-markets/
- https://www.quantvps.com/blog/polymarket-fixes-ghost-fills-clob-v2-upgrade
- https://www.quantvps.com/blog/binance-to-polymarket-arbitrage-strategies
- https://laikalabs.ai/prediction-markets/polymarket-v2-migration
- https://www.crowdfundinsider.com/2026/03/268884-polymarket-to-impose-taker-fees-on-nearly-all-trading-categories/
- https://startpolymarket.com/learn/polymarket-fees/
- https://startpolymarket.com/learn/converting-negative-risk/
- https://www.financemagnates.com/cryptocurrency/polymarket-introduces-dynamic-fees-to-curb-latency-arbitrage-in-short-term-crypto-markets/
- https://unchainedcrypto.com/polymarket-introduces-taker-fees-in-15-minute-markets/
- https://www.cbsnews.com/news/french-whale-made-over-80-million-on-polymarket-betting-on-trump-election-win-60-minutes/
- https://www.theblock.co/post/324996/french-polymarket-whale-us-election-profit-france-ban
- https://www.entrepreneur.com/business-news/how-trump-whale-theo-made-48-million-neighbor-effect/482539
- https://www.onchaintimes.com/a-chat-with-domer-the-1-trader-on-polymarket/
- https://www.tradetheoutcome.com/fed-decision-september-2026-polymarket-analysis/
- https://polymarket.com/event/fed-decision-in-september-762
- https://www.polytrackhq.app/blog/polymarket-french-whale-case-study
- https://polycopy.app/polymarket-wallet-tracker
- https://gamingamerica.com/news/1094894/crypto-com-breaks-things-off-with-truth-social-on-prediction-markets
- https://polymarkets.co.il/en/guide/uma-disputes/

### Literatura quant / acadêmica

- http://users.nber.org/~jwolfers/papers/Favorite_Longshot_Bias.pdf
- https://www.journals.uchicago.edu/doi/abs/10.1086/655844
- https://www.ifo.de/en/cesifo/publications/2026/working-paper/makers-and-takers-economics-kalshi-prediction-market
- https://cepr.org/publications/dp20631
- https://www2.gwu.edu/~forcpgm/2026-001.pdf
- https://arxiv.org/abs/2606.19517
- https://arxiv.org/html/2606.19517v1
- https://nickhaubri.ch/blog/follymarket-polymarket-forecast-assessment/
- https://onlinelibrary.wiley.com/doi/10.1111/j.1468-0297.2012.02561.x
- https://pubsonline.informs.org/doi/abs/10.1287/deca.2013.0271
- https://arxiv.org/abs/1701.02814
- https://matthewdowney.github.io/uncertainty-kelly-criterion-optimal-bet-size.html
- https://www.sfu.ca/~tswartz/papers/kelly.pdf
- https://arxiv.org/html/2604.24366v2
- https://www.sciencedirect.com/science/article/pii/0304405X85900443
- https://pmc.ncbi.nlm.nih.gov/articles/PMC9767337/
- https://arxiv.org/pdf/2606.01477
- https://arxiv.org/abs/2508.03474
- https://arxiv.org/html/2605.00864v1
- https://arxiv.org/abs/2605.31431
- https://arxiv.org/abs/2606.07811
- https://arxiv.org/abs/2606.04217
- https://huggingface.co/datasets/TimeSeventeen/Polymarket-v1
- https://arxiv.org/abs/2605.11640
- https://arxiv.org/pdf/2605.00493
- https://arxiv.org/pdf/2601.01706
- https://suarez-tangil.networks.imdea.org/papers/2025aft-arbitrage.pdf

### Incidentes / regulatório / segurança

- https://www.coindesk.com/markets/2025/03/27/polymarket-uma-communities-lock-horns-after-usd7m-ukraine-bet-resolves
- https://www.theblock.co/post/348171/polymarket-says-governance-attack-by-uma-whale-to-hijack-a-bets-resolution-is-unprecedented
- https://thedefiant.io/news/defi/polymarket-s-usd7m-ukraine-mineral-deal-debacle-traced-to-oracle-whale
- https://thedefiant.io/news/markets/usd85m-polymarket-dispute-over-strategy-s-may-bitcoin-sale-puts-uma-s-token-voting-oracle-on
- https://decrypt.co/329210/polymarket-rules-no-237m-bet-zelenskyys
- https://www.coindesk.com/markets/2025/07/07/polymarket-embroiled-in-usd160m-controversy-over-whether-zelensky-wore-a-suit-at-nato
- https://cryptoslate.com/polymarket-faces-backlash-over-disputed-200m-zelensky-suit-market/
- https://cryptoslate.com/polymarket-faces-major-credibility-crisis-after-whales-forced-a-yes-ufo-vote-without-evidence/
- https://www.theblock.co/post/366507/polymarket-uma-oracle-update
- https://www.forbes.com/sites/digital-assets/2026/04/30/inmates-taking-the-asylum-polymarkets-16m-clavicular-bet/
- https://orochi.network/blog/oracle-manipulation-in-polymarket-2025
- https://coinmarketcap.com/academy/article/polymarket-reports-unprecedented-governance-attack-by-uma-whale-on-bet-resolution
- https://www.cryptopolitan.com/polymarket-community-protests-oracle-vote-by-uma-whales-claims-market-manipulation/
- https://cryptonews.com/news/polymarket-oracle-risk-cftc-regulatory-scrutiny/
- https://www.coindesk.com/markets/2025/11/07/polymarket-s-trading-volume-may-be-25-fake-columbia-study-finds
- https://decrypt.co/347842/columbia-study-25-polymarket-volume-wash-trading
- https://www.coindesk.com/markets/2026/06/27/polymarket-hack-updated-to-usd3-1-million-days-after-the-platform-promised-users-full-refunds
- https://www.theblock.co/post/383711/polymarket-third-party-vulnerability-hack
- https://www.cftc.gov/PressRoom/PressReleases/8478-22
- https://www.dlapiper.com/en-us/insights/publications/2022/1/cftc-settles-enforcement-action-against-defi-platform-polymarket
- https://cryptoslate.com/polymarket-blocked-french-transactions-but-578751-users-later-france-blocked-the-entire-site/
- https://www.engadget.com/2218130/france-doubles-down-on-restricting-access-to-polymarket/
- https://www.datawallet.com/crypto/polymarket-restricted-countries
- https://polyflux.io/blog/polymarket-wallet-types/
- https://www.nbcnews.com/business/markets/french-trader-bet-28-million-trump-election-win-4-polymarket-accounts-rcna177106
