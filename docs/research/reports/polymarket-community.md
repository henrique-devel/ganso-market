# polymarket-community

## Summary
Community evidence (2024–2026) shows that individual Polymarket bot operators cluster into a few strategy families with very unequal outcomes. The strategies individuals verifiably run and discuss: (1) latency/news sniping on live sports and esports — bots consume official data feeds (Opta/Stats Perform, game-server APIs for LoL/Dota2/CS) that update 3–5s after an event while livestreams lag 30–60s+; the "swisstony" wallet reportedly turned $5 into $3.7M and sports specialist RN1 shows ~$9.2M profit on $609M volume (55% win rate, 127k positions) on public leaderboards; esports-parsing operators on X (e.g. 0xMovez thread) claim $200k+ using the T+45s stream gap. (2) Cross-market/negRisk arbitrage — an academic study found ~$40M of arb profit extracted Apr 2024–Apr 2025 across 7,000+ mispriced markets, but windows compressed from ~12.3s (2024) to ~2.7s (2026) with ~73% captured by sub-100ms bots; simple YES+NO<$1 arb is now considered dead for retail. (3) Market making / liquidity-rewards farming — Polymarket pays daily rewards for two-sided quotes near midpoint (min $1/day payout threshold, no maker fees, maker rebates funded by taker fees); the gabagool22-style hedged MM on 15-minute crypto UP/DOWN markets is the most-cloned individual strategy (Arbigab claims $500k+ realized; an "OpenClaw" agent claimed $115k/week via 47k trades — unverified, no wallet shown). (4) Whale copy-trading via PolyTrack, Polycopy, Polycule, PolyCop, Alphascope, stand.trade and polymarketanalytics.com (polling target wallets every ~4s). (5) Resolution-decay / "bonding" at 95–99c — widely marketed as risk-free but a dissected $11.95M wallet was earning ~3.3% annualized (below T-bills) with 99:1 wipe ratios and UMA tail risk. (6) Weather-model bots (GFS/ECMWF ensembles vs market price, Kalshi KXHIGH + Polymarket) — small verified results (paper-trading $1.8k; "securebet" $7→$640); viral $24k/$65k claims lack wallet evidence. Longshot-bias fading has mixed academic support on Polymarket specifically.

Profitability base rates are brutal and repeatedly cited in the community: a Dune-based study (Apr 2024–Apr 2026) found 15.9% of 2.5M wallets profitable at all, only ~2% ever made >$1,000, 0.033% made >$100k, ~0.26% average >$5k/month, and only ~0.03% sustained $5k+ for three consecutive months; fewer than 0.04% of traders take ~70% of all realized profit. Famous cases split into conviction whales (Théo, the French whale: ~$85M on Trump 2024 across 11 accounts, using commissioned "neighbor-effect" YouGov polling — research edge, not a bot), grinders (Domer, #1 all-time: poker background, $2.5M+ profit over 5,000+ markets, loses more trades than he wins but wins bigger), and latency bots (swisstony, RN1). Cautionary cases: a taker lost $2.36M in 8 days on 53 sports bets; the March 2025 Ukraine-minerals market ($7M) was resolved YES by a UMA whale holding ~25% of active voting power despite no signed deal, with no refunds; a Sept 2024 attempt to manipulate a Kamala-favorability derivative burned ~$7M and failed.

Structural changes in 2025–2026 materially alter the math for a new operator: Polymarket introduced taker fees (Jan–Mar 2026 rollout; crypto theta 0.07, sports 0.03 rising to 0.05 in July 2026, ~$1.00–$1.75 per 100 shares peak at 50c; geopolitics still free; makers pay nothing and receive rebates), added anti-sniping frictions on sports (limit orders auto-cancel at game start, 3-second delay on marketable orders, 1-second taker delay tested on NBA/MLB), and publishes explicit rate limits (V2 allows ~200 orders/s sustained; Cloudflare throttles rather than bans). Community consensus is that durable individual edge now lives on the maker side (liquidity rewards + spread capture with fast cancels) or in genuine information/model edges (domain specialization, weather ensembles, cross-platform Kalshi/Polymarket gaps of 5c+), not in taker-side speed races against colocated firms. Typical capital discussed: $5–50k for cross-platform arb, ~$10k minimum for meaningful market making (pro MM pools run $1–10M), and micro-capital only for reward farming. Note on methodology: Reddit itself blocks Anthropic's crawler, so r/Polymarket threads could not be fetched directly; Reddit sentiment here is reflected through secondary reporting, X threads, Substack/Medium write-ups, GitHub repos, and Discord/Telegram community pages.

## Key findings
- Latency sniping is the best-documented individual bot edge: official data feeds update T+3-5s vs livestreams at T+30-60s; wallet 'swisstony' reportedly turned $5 into $3.7M (740,000% ROI) on sports broadcast lag, and RN1 shows ~$9.18M profit on $609.6M volume, 55% win rate over 127k positions (sports: tennis #7, soccer #8)
- Esports parsing (LoL/Dota2 game-server APIs) gave 30-40s advantages; operators claimed $200k+ profits in late 2025 (X thread by 0xMovez, T=+45s framing)
- Academic study: ~$40M arbitrage profit extracted Apr 2024-Apr 2025 across 7,000+ mispriced markets, but opportunity windows shrank from 12.3s (2024) to 2.7s (2026) and ~73% of arb profit goes to sub-100ms bots; median spread ~0.3% — simple intra-market arb is considered dead for retail takers
- Profitability base rates (Dune on-chain study, Apr 2024-Apr 2026, 2.5M wallets): 15.9% profitable, ~2% ever made >$1,000, 0.32% >$10k, 0.033% >$100k; only ~0.26% average >$5k/month and 0.03% sustain that 3 consecutive months; <0.04% of traders capture ~70% of all realized profits
- Polymarket introduced taker fees Jan-Mar 2026 (crypto theta 0.07, sports 0.03 then 0.05 from July 2026, finance/politics 0.04; peak ~$0.50-$1.75 per 100 shares at 50c price; geopolitics free). Makers pay zero and receive rebates funded by taker fees — a structural push toward maker strategies
- Anti-sniping countermeasures on sports markets: all resting limit orders auto-cancelled at game start, 3-second delay on marketable orders, 1-second taker delay being tested on NBA/MLB
- Liquidity Rewards program pays daily (midnight UTC) for two-sided quotes near midpoint; days earning <$1 are forfeited; per-market min size and max spread parameters. Community treats reward farming as the standard small-capital entry strategy
- The most-cloned individual strategy is gabagool22-style hedged market-making/spread-capture on 15-minute crypto UP/DOWN markets; the Arbigab bot (Rust, VPS-near-servers) claims $500k+ realized profit — but dozens of GitHub 'gabagool bot' clones exist and are likely scam/malware vectors
- OpenClaw agent-framework bots claimed $115k/week (47,000 trades across 31 markets, liquidity provision on 15-min BTC/ETH/SOL/XRP markets) — repeated by Phemex/KuCoin but explicitly unverified by wallet address; treat as marketing
- 99-cent 'theta harvesting'/bonding is widely marketed but a dissected $11.95M wallet earned only ~3.3% annualized (below the 4% T-bill), with 48% concentrated in one Iran market; wipe ratios go 19:1 at 95c to 99:1 at 99c — negative excess return plus UMA tail risk
- UMA oracle risk is the top community complaint: March 2025 Ukraine-minerals market ($7M) resolved YES despite no signed deal after a whale with ~5M UMA (~25% of active voting power) voted it through; Polymarket called it a 'governance attack' but issued no refunds. Later flashpoints: Zelenskyy-suit market ($79M volume), $16M 'Clavicular' dispute (Apr 2026), $60M Strategy-BTC-sale dispute
- Failed manipulation case (Sept 2024): attackers spent ~$7M buying Trump NO to move a 90-minute Kamala-favorability derivative snapshot, needed ~$20M, moved the market for only 4 of 90 minutes — lesson: the oracle market was more liquid than the derivative they held
- Wash trading contaminates community profit signals: Columbia study estimates ~25% of all Polymarket volume (peaking ~60% weekly in Dec 2024) is wash trading, largely airdrop farming; Chaos Labs estimated ~one-third of 2024 presidential-market volume — leaderboards and volume-based whale signals need filtering
- Copy-trading tooling is mature: PolyTrack, Polycopy (premium copy bot), Polycule (Telegram, 1% fee), PolyCop, Alphascope, stand.trade, polymarketanalytics.com; bots poll target wallets ~every 4s. Custody risk is real: Polycule was drained ~$230k in Jan 2026 because it stored user private keys server-side
- Weather bots are a genuine small-scale niche: 31-member GFS ensembles (Open-Meteo), ECMWF, NWS observations vs Kalshi KXHIGH and Polymarket temperature markets; verified results are modest (open-source repo: $1.8k paper profits; 'securebet' $7 to $640 via 3,000 micro-bets); viral $24k/$65k bot claims have no wallet evidence
- Rate limits are documented, not punitive: CLOB ~9,000 req/10s general, POST /order 3,500/10s burst, V2 allows ~200 orders/s sustained; Cloudflare throttles (queues) rather than banning; community guidance is WebSockets over REST polling. No widespread reports of API bans for ordinary bots
- Famous conviction cases are research edges, not bots: Théo (French whale) made ~$85M on Trump 2024 across 11 accounts (Fredi9999, Theo4, PrincessCaro, Michie) using commissioned neighbor-effect YouGov polling; Domer (#1 all-time, ex-poker pro) has $2.5M+ profit over 5,000+ markets and says he loses more trades than he wins but wins bigger
- Cautionary taker case: one trader lost $2.36M in 8 days across 53 US-sports bets (25W/28L), including a $1.36M loss on 2.5M Packers shares at 54c — pure directional taking at size fails fast
- Capital sizes discussed in community material: $5-50k working capital for cross-platform (Kalshi/Polymarket) arb; ~$10k minimum for meaningful market making (example claim: $1,247 on $10k in 3 weeks); professional MM pools $1-10M; strategy-viability table pegs domain specialization at 15-30% annualized as the best retail-viable return
- Maker vs taker verdict from evidence: retail takers overwhelmingly lose (84-92% unprofitable); surviving individuals are either makers (rewards + spread capture with fast cancel logic), latency-informed takers with proprietary feeds, or domain specialists (weather, niche politics); adverse selection is the named killer for naive makers — quotes get picked off on news before cancellation

## Named examples
- **Théo / 'French whale' (Fredi9999, Theo4, PrincessCaro, Michie)**: French ex-banker who made ~$85M on Trump 2024 across 11 accounts using commissioned neighbor-effect YouGov polling; conviction research edge, not a bot; triggered French regulatory scrutiny of Polymarket — https://www.cbsnews.com/news/french-whale-made-over-80-million-on-polymarket-betting-on-trump-election-win-60-minutes/
- **swisstony**: Wallet reported to have turned $5 into $3.7M by exploiting 15-40s sports broadcast lag with direct stadium/API data feeds; cited in community as the archetypal sports latency bot — https://phemex.com/news/article/algorithm-exploits-broadcast-lag-to-turn-5-into-37m-on-polymarket-53969
- **RN1**: Sports-specialist account, ~#6 all-time: ~$9.18M profit on $609.6M volume, 55% win rate, 127k+ positions; community attributes success to executing ~45s faster than stream watchers — https://www.frenflow.com/traders/@RN1
- **Domer**: #1 all-time Polymarket trader by volume/profit ($2.5M+ net over 5,000+ markets, ~$300M volume); ex-online-poker pro; manual full-time grinder, not a bot — interviews describe process/bankroll discipline — https://www.onchaintimes.com/a-chat-with-domer-the-1-trader-on-polymarket/
- **gabagool22 / Arbigab**: Known crypto UP/DOWN market trader whose hedged spread-capture strategy inspired the commercial Arbigab bot (Rust, claims $500k+ realized profit, sold with lifetime license); many GitHub clones of 'gabagool bots' are likely scams — https://gabagool22.com/
- **OpenClaw Polymarket bot**: AI-agent framework bot claimed to net $115k in one week via 47,000 liquidity-provision trades on 15-min crypto markets; widely repeated (Phemex, KuCoin) but unverified by wallet — treat as promotional — https://openclaws.io/blog/polymarket-trading-bot/
- **suislanchez/polymarket-kalshi-weather-bot**: Open-source (FastAPI/React) weather+BTC bot: 31-member GFS ensemble vs Kalshi KXHIGH and Polymarket temperature markets, fractional Kelly (15%), daily $300 circuit breaker; honest about being paper-trading only, best result $1.8k simulated — https://github.com/suislanchez/polymarket-kalshi-weather-bot
- **PolyTrack**: Leading whale tracker/copy-trading platform: real-time whale alerts, wallet P&L, win rates, watchlists; also publishes case studies (French whale) and UMA dispute explainers — https://www.polytrackhq.app/
- **Polycopy**: Whale leaderboard + premium copy-trading bot that mirrors chosen traders' Polymarket positions (polls target wallets ~every 4s, position limits) — https://polycopy.app/
- **Polycule**: Telegram copy-trading bot (1% fee, PCULE rakeback) — drained for ~$230k in Jan 2026 because it stored user private keys on a central server; the canonical custody-risk cautionary tale — https://defipill.xyz/telegram-trading-bots/polycule_review/
- **polymarketanalytics.com**: Trader leaderboard/analytics site (PnL, positions, wins/losses per wallet) used by copy traders to select targets — https://polymarketanalytics.com/traders
- **Poly Research & Robotics (polybots.dev)**: Free Discord collective of 1,000+ prediction-market bot builders; publishes reverse-engineered trader reports (RN1, BONEREAPER, SLIP-ME), free historical data, and tutorials focused on 5/15-min crypto market-making and scalping — https://www.polybots.dev/
- **Awesome-Polymarket-Tools (GitHub)**: Curated list of the ecosystem: py-clob-client, official poly-market-maker, @polybased/sdk WebSocket streams, Dune dashboards, whale trackers, Telegram bots — https://github.com/harish-garg/Awesome-Polymarket-Tools
- **0xMovez esports-parsing thread (X)**: X thread laying out the T=0/T+3s data/T+45s stream latency stack and DIY 'data parser' approach for esports sniping; associated reporting claims $200k+ profits for late-2025 esports parsers — https://x.com/0xMovez/status/2008298059059343819
- **Jacek Jurczynski — 'Picking up nickels at ninety-nine cents' (Medium)**: Individual quant write-up dissecting a real $11.95M theta-harvesting wallet: ~3.3% annualized, below T-bills, 99:1 wipe ratios, LTCM analogy, UMA-underwriting framing — best public takedown of the 'risk-free 99c' strategy — https://medium.com/@jacek.jurczynski/picking-up-nickels-at-ninety-nine-cents-d4308907db2c
- **Mike Platt (podshopguy Substack) — 'Polymarket overprices volatility'**: Individual cross-venue relative-value trade: sell overpriced Polymarket BTC over/under contracts vs cheaper IBIT option spreads; projected 32-131% in 2.5 months; commenters flag basis/expiry risks — https://podshopguy.substack.com/p/polymarket-overprices-volatility
- **Andrey Sergeenkov profitability study**: Dune-based on-chain study (Apr 2024-Apr 2026, 2.5M wallets) that underlies the community's base-rate numbers: 15.9% profitable, 2% >$1k lifetime, 0.03% sustain $5k/month for 3 months — https://sergeenkov.com/polymarket-profitability/
- **CMS Holdings — 'Failed Polymarket Oracle Attack'**: Post-mortem of the Sept 2024 ~$7M failed manipulation of a Kamala-favorability derivative: needed ~$20M, moved market 4 of 90 required minutes; lesson on oracle-vs-derivative liquidity — https://cmsholdings.substack.com/p/failed-polymarket-oracle-attack
- **Polymarket official docs — Liquidity Rewards & Rate Limits**: Primary source for maker-rewards mechanics (daily payouts, $1 minimum, spread/size params) and API limits (CLOB 9,000 req/10s, order-post burst 3,500/10s, Cloudflare throttling) — https://docs.polymarket.com/market-makers/liquidity-rewards

## Pitfalls
- UMA oracle/resolution risk is the single most-cited tail risk: markets have resolved against widely-reported facts (Ukraine minerals, Mar 2025, $7M — resolved YES by a whale with ~25% of active UMA voting power; no refunds), making 95-99c 'risk-free' strategies implicitly short oracle-governance risk with no recovery mechanism
- Taker-side speed strategies are an arms race individuals lose: arb windows are ~2.7s median, 73% of arb profit goes to sub-100ms colocated bots, and sellers of 'arb bots' recommend VPS colocation near Polymarket servers — a solo operator entering in 2026 is the liquidity, not the sniper
- Fee regime changed under everyone's feet in 2026: taker fees (up to ~$1.25-1.75 per 100 shares at mid prices on sports/crypto) erased thin-edge taker strategies that backtested profitably on 2024-2025 zero-fee data; backtests must include the V2 fee schedule and the sports 3s/1s order delays
- Adverse selection kills naive market makers: resting quotes get hit by news-informed flow before cancellation; community guidance is that spread+rewards income must exceed rare catastrophic picks-offs, requiring fast cancel logic and inventory limits — the official liquidity-rewards docs make two-sided quoting near midpoint mandatory to earn
- Profit claims in this niche are mostly unverifiable marketing: OpenClaw's $115k/week, Dev Genius's '$24k weather bots', PolyCue's strategy stats and most 'turned $X into $Y' stories lack wallet addresses; conversely on-chain studies show only ~2% of wallets ever cleared $1,000 — assume survivorship bias and promotional intent by default
- Custody/scam risk in tooling: Telegram copy-bots that hold keys server-side get drained (Polycule, ~$230k, Jan 2026); GitHub is littered with cloned 'gabagool' bot repos that are plausible malware/scams; sold 'lifetime license' bots (Arbigab) are unauditable — never fund keys a third party can see
- Wash trading (~25% of all volume per Columbia; up to 95% weekly in some election markets) poisons volume-based signals: whale-copy and leaderboard-driven strategies must filter airdrop farmers and self-trades or they will copy noise
- Copy-trading has structural lag: bots poll target wallets every ~4 seconds and whales' entries move thin books first, so copiers systematically enter at worse prices — several tools now market 'insider detection' precisely because naive copying underperforms the copied wallet
- Resolution-date value decay ('bonding') often underperforms T-bills once measured properly: a real $11.95M wallet earned ~3.3% annualized with 99:1 loss ratios and 48% concentration in one geopolitical market — capital-weighted returns, not per-trade yields, are what matter
- Reddit could not be crawled directly (reddit.com blocks Anthropic's fetcher), so r/Polymarket and r/sportsbook sentiment is represented here only via secondary sources; treat 'Reddit consensus' claims in this report as second-hand
- Sports-market microstructure now actively fights snipers: resting orders are wiped at game start, marketable orders face a 3s delay (1s taker delay on NBA/MLB in testing) — 2024-2025 latency-sniping profits (swisstony, esports parsers) are structurally harder to replicate in 2026
- Persistence is the hardest problem: 53% of ever-profitable traders made their profit in a single month and 73% went inactive within two months; only 0.03% of wallets sustained $5k+/month for three consecutive months — edges decay fast as they are cloned (weather and 15-min crypto MM niches are visibly crowding through 2026)

## Sources
- https://medium.com/mountain-movers/how-smart-traders-beat-you-on-polymarket-live-markets-6ade71098c5b
- https://phemex.com/news/article/algorithm-exploits-broadcast-lag-to-turn-5-into-37m-on-polymarket-53969
- https://phemex.com/news/article/sports-bot-earns-8-million-on-polymarket-by-exploiting-time-lag-55871
- https://x.com/0xMovez/status/2008298059059343819
- https://www.frenflow.com/traders/@RN1
- https://polymarketanalytics.com/traders
- https://www.cbsnews.com/news/french-whale-made-over-80-million-on-polymarket-betting-on-trump-election-win-60-minutes/
- https://www.entrepreneur.com/business-news/how-trump-whale-theo-made-48-million-neighbor-effect/482539
- https://www.polytrackhq.app/blog/polymarket-french-whale-case-study
- https://www.onchaintimes.com/a-chat-with-domer-the-1-trader-on-polymarket/
- https://www.aicoin.com/en/article/422962
- https://gabagool22.com/
- https://github.com/Lampdevs/Gabagool221
- https://openclaws.io/blog/polymarket-trading-bot/
- https://phemex.com/news/article/openclaw-bot-generates-115k-in-a-week-on-polymarket-57582
- https://1023jack.com/market/are-polymarket-trading-bots-actually-profitable-the-math-behind-2026-s-predictio/
- https://sergeenkov.com/polymarket-profitability/
- https://cointelegraph.com/news/should-you-quit-your-job-trade-full-time-polymarket
- https://financefeeds.com/99-99-of-polymarket-traders-dont-make-enough/
- https://www.opb.org/article/2026/01/17/how-kalshi-and-polymarket-prediction-market-traders-make-money/
- https://finance.yahoo.com/news/arbitrage-bots-dominate-polymarket-millions-100000888.html
- https://medium.com/illumination/beyond-simple-arbitrage-4-polymarket-strategies-bots-actually-profit-from-in-2026-ddacc92c5b4f
- https://www.quantvps.com/blog/automated-trading-polymarket
- https://www.quantvps.com/blog/how-latency-impacts-polymarket-trading-performance
- https://docs.polymarket.com/market-makers/liquidity-rewards
- https://docs.polymarket.com/api-reference/rate-limits
- https://agentbets.ai/guides/polymarket-rate-limits-guide/
- https://igamingbusiness.com/prediction-markets/polymarket-sports-fee-hike-2026/
- https://startpolymarket.com/learn/polymarket-fees/
- https://startpolymarket.com/strategies/market-making/
- https://startpolymarket.com/strategies/bonding/
- https://docs.polymarket.com/polymarket-learn/trading/limit-orders
- https://medium.com/@jacek.jurczynski/picking-up-nickels-at-ninety-nine-cents-d4308907db2c
- https://podshopguy.substack.com/p/polymarket-overprices-volatility
- https://cmsholdings.substack.com/p/failed-polymarket-oracle-attack
- https://thedefiant.io/news/markets/usd85m-polymarket-dispute-over-strategy-s-may-bitcoin-sale-puts-uma-s-token-voting-oracle-on
- https://orochi.network/blog/oracle-manipulation-in-polymarket-2025
- https://www.forbes.com/sites/digital-assets/2026/04/30/inmates-taking-the-asylum-polymarkets-16m-clavicular-bet/
- https://www.coindesk.com/markets/2025/11/07/polymarket-s-trading-volume-may-be-25-fake-columbia-study-finds
- https://finance.yahoo.com/news/exclusive-election-betting-polymarket-gives-142008194.html
- https://github.com/suislanchez/polymarket-kalshi-weather-bot
- https://blog.devgenius.io/found-the-weather-trading-bots-quietly-making-24-000-on-polymarket-and-built-one-myself-for-free-120bd34d6f09
- https://predictandprofit.io/
- https://www.quicknode.com/builders-guide/best/top-10-polymarket-whale-trackers
- https://www.polytrackhq.app/
- https://polycopy.app/polymarket-whale-tracker
- https://defipill.xyz/telegram-trading-bots/polycule_review/
- https://polycopbot.com/
- https://github.com/harish-garg/Awesome-Polymarket-Tools
- https://www.polybots.dev/
- https://www.predictengine.ai/blog/polymarket-discord-telegram
- https://finance.yahoo.com/news/trader-lost-2-million-polymarket-133015895.html
- https://forecasting.substack.com/p/humans-still-crush-bots-at-forecasting
- https://quantpedia.com/systematic-edges-in-prediction-markets/
- https://medium.com/@0xicaruss/the-polymarket-quant-playbook-a-data-driven-framework-for-extracting-edge-in-prediction-markets-d9744d90477d
- https://papers.ssrn.com/sol3/Delivery.cfm/5910522.pdf?abstractid=5910522&mirid=1
