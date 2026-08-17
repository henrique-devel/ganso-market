# solana-tech

## Summary
The Solana memecoin bot ecosystem in 2025-2026 is mature and highly commoditized at the retail layer. Commercial terminals/Telegram bots (Axiom, Trojan, BonkBot, Maestro, Banana Gun, GMGN, Photon, MEVX, Padre/Terminal, Nova) all converge on the same feature set — new-pair sniping, copy-trading, limit orders/TP-SL ladders, Jito-routed anti-MEV execution, and built-in rug scanning — and almost all charge ~1% per trade (Axiom 0.75-0.95%, Trojan 0.9% w/ referral, BonkBot 1% down to 0.75%, GMGN flat 1%). Axiom became the dominant venue by mid-2026 (~$51.5M/day, ~44.6% category share, $200M cumulative fees reached faster than any prior app), while BullX abruptly paused trading June 1, 2026, illustrating platform risk. For a solo developer, these bots are the competitive benchmark: their edge is speed (co-located infra, Jito bundles, shred-level data), not strategy sophistication.

On the open-source side, genuinely useful reference code exists but is a minefield. The highest-quality maintained references are chainstacklabs' pump-fun bot (Python, ~970 stars, Apache 2.0, multiple listener implementations incl. Geyser/gRPC, bonding-curve decoding, PumpSwap migration detection, extensive learning-examples) and warp-id/solana-trading-bot (TypeScript, ~2.3k stars, Raydium listener with burn/renounce/metadata filters, TP/SL, Jito executor). Beyond those, the GitHub landscape is dominated by lead-generation repos from dev-for-hire accounts and outright malware: SlowMist documented a fake "solana-pumpfun-bot" (account zldp2002) with inflated stars and a malicious npm dependency (crypto-layout-utils) that exfiltrated private keys — treat every trading repo as hostile until audited and never run one against a funded wallet.

Infrastructure-wise, the standard 2026 stack for a Pump.fun-focused bot is: Yellowstone gRPC (Geyser) streaming for event detection (sub-50ms claims; originally built by Triton, offered by Helius LaserStream since June 2025, Shyft from $199/mo unmetered, QuickNode as add-on), plus dual-path transaction submission through staked-connection senders (Helius Sender routes via SWQoS + Jito simultaneously) and Jito bundles (max 5 txs, atomic, min tip 1,000 lamports, 8 tip accounts, tip-floor REST/WS APIs, ~50ms auction ticks). Notably, a Chorus One measurement study (Nov 2024) found priority-fee size and Jito tip size do NOT meaningfully reduce time-to-inclusion — access to swQoS/staked connections matters far more — while bundle inclusion is a pay-to-win auction where searchers tip 50-70% of expected profit. Rug detection is now API-driven: RugCheck (api.rugcheck.xyz, insider-graph endpoint), SolSniffer (0-100 Snifscore, 20+ indicators), GoPlus Solana Token Security API (mint/freeze authority, mutable metadata, balance-mutability), Bubblemaps clustering, and bundle-detection tools (Trench Bot/TrenchRadar) that detect same-block coordinated buys and shared-funding-source wallet clusters — the 2025-2026 state of the art focuses on bundled-supply and insider-cluster detection rather than simple authority checks.

Pump.fun itself remains the dominant launchpad but with brutal economics for buyers: the bonding curve is a constant-product curve with virtual reserves (30 SOL virtual SOL, 1.073e15 virtual token units, 793.1M tokens sellable of 1B supply), graduating at ~85 SOL raised (~$69K market cap) with free instant migration to PumpSwap (LP burned) since March 2025. Fees changed repeatedly: ~1% on curve trades historically, "Project Ascend" dynamic creator fees (Sept 2025) paying creators up to 0.95% on sub-$300K tokens, PumpSwap 0.30% total post-graduation (0.20% LP / 0.05% protocol / 0.05% creator). Activity in 2026: hundreds of thousands of launches per month but graduation rate collapsed to ~0.2-0.26% (June 2026 study: 832,941 launches, 0.198% graduated in 24h) before the July 21, 2026 BOOST incentive change lifted it to ~6.7%; platform revenue ~$800K-$1M/day, down from ~$3M peak. Any probability/risk bot must price in that ~99.8% of curve launches never graduate.

## Key findings
- Fee convergence: virtually all commercial Solana bots charge ~1% per successful trade — Trojan 1% (0.9% with referral), BonkBot 1% (0.75% at top cashback tier), GMGN flat 1%, Banana Gun 1%, Axiom 0.75-0.95% by tier plus 0.05-0.25% SOL cashback. This 1% is the implicit cost benchmark a self-built bot saves.
- Volume/scale (2026): Axiom is #1 with ~$51.5M/day and 44.6% category share (June 4, 2026), $200M cumulative fees reached faster than any app, ~$1.75M fees on an active day in July 2026; Trojan claims $25B+ lifetime volume and 2M+ users; Maestro $12.8B lifetime across 14 chains; BonkBot ~$14M daily volume and ~$4.35M monthly fees (100% used to buy-and-burn BONK); BullX had ~260K MAU and $12B+ cumulative volume before pausing trading June 1, 2026 with no timeline.
- Pump.fun bonding curve constants (program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P, mainnet+devnet): constant-product x*y=k over virtual reserves — initial virtual token reserves 1,073,000,000,000,000, virtual SOL reserves 30 SOL (30e9 lamports), real sellable reserves 793.1M of 1B total supply; graduation at ~85 SOL collected / ~$69K market cap; official IDL and docs in pump-fun/pump-public-docs on GitHub.
- PumpSwap (program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) replaced Raydium as graduation venue March 2025: migration is instant and free (Raydium era cost ~6 SOL), LP tokens are burned automatically; post-graduation fee 0.30% total = 0.20% LP + 0.05% protocol + 0.05% creator (creator revenue-share added ~May 2025).
- Pump.fun fee history matters for backtests: ~1% curve swap fee historically; 'Project Ascend' (Sept 2025) introduced Dynamic Fees paying creators up to 0.95%/trade below $300K MC tapering to 0.05% past $20M; Creator Fee Sharing (Jan 2026) splits fee income across up to 10 wallets.
- 2026 activity: graduation rate collapsed to ~0.26% (mid-June 2026); an academic-style study of 832,941 launches (May 8-June 10, 2026) found only 1,651 (0.198%) graduated within 24h; platform revenue ~$800K-$1M/day (down from ~$3M in Sept 2025); BOOST mechanism (July 21, 2026) lifted graduation rate to ~6.7% — 8x June average. Token creation still runs thousands/hour across Solana.
- Yellowstone gRPC (Geyser) is the standard detection layer: typed protobuf streams with sub-50ms latency claims, data from validator memory; REST polling misses most blocks. Providers: Helius LaserStream (launched June 18, 2025; shred-level ingestion, 24h replay, multi-region, notifications surface mid-slot enabling same-slot 'zero-slot' reaction), Shyft ($199/mo unmetered, 7 regions, dedicated gRPC nodes), QuickNode ($49/mo base + Yellowstone add-on, Lil'JIT, Transaction Fastlane), Triton (original Yellowstone authors; per-call + $0.08/GB pricing or flat dedicated nodes).
- Jito mechanics: bundles = max 5 transactions, sequential and atomic; minimum tip 1,000 lamports; 8 tip accounts (getTipAccounts); public tip-floor percentiles at bundles.jito.wtf/api/v1/bundles/tip_floor (REST) and /tip_stream (WS); default rate limit 1 req/s/IP/region; auction runs on 50ms ticks; bundle expiry ~2 slots (~800ms); for sendTransaction Jito recommends 70/30 priority-fee/tip split; competitive searchers tip 50-70% of expected profit. Jito tips are 60%+ of Solana priority-fee volume in 2025-2026; BAM (TEE-based block assembly) activated mainnet Sept 25, 2025.
- Counterintuitive latency finding (Chorus One study, Nov 18-25, 2024): priority-fee size generally does NOT influence time-to-inclusion, and Jito tip size does not significantly impact latency either; swQoS (stake-weighted QoS via staked connections) was the only intervention with a large effect (~3x better inclusion probability within 13s). Implication: pay for staked-connection senders (Helius Sender, Shyft staked RPC, Nextblock-style services), don't overspend on fees for latency.
- Solana fee formula: base fee 5,000 lamports/signature; priority fee = ceil(cu_price x cu_limit / 1e6), paid to leader; durable nonce accounts remove the 150-slot (~90s) blockhash expiry for sign-now-send-later flows (useful for retry queues, not for latency).
- Rug-detection APIs (2025-2026 SOTA): RugCheck (free scanner; REST API at api.rugcheck.xyz with Swagger, X-API-KEY auth, token report + /tokens/{id}/insiders/graph insider-network endpoint); SolSniffer (0-100 Snifscore from 20+ indicators, severe/moderate/minor findings, API); GoPlus Token Security API for Solana (mint/freeze authority, metadata mutability, balance-mutability, LP locker coverage incl. Streamflow); Bubblemaps (wallet-cluster visualization; reported acquired by Etherscan).
- Bundled-supply/insider detection is the 2025-2026 frontier: Trench Bot (@TrenchScannerBot, trench.bot) scans the token's creation block, counts same-block buyer wallets, computes % of supply they took and whether they sold; TrenchRadar renders bubble-map bundle views for Pump.fun tokens; funding-source clustering (N wallets funded from one source pre-launch = insider cluster) is the core heuristic. GMGN computes insider/rat ratio, bundle-buy ratio, dev-holdings %, and top-10 concentration in-terminal, plus dev-wallet launch history with ATH market cap per prior token.
- Best open-source references: chainstacklabs pump-fun bot (Python 3.11+, ~970 stars, Apache 2.0, listener comparison — Geyser gRPC vs logsSubscribe vs blockSubscribe vs PumpPortal — bonding-curve decode, migration detection, 'extreme fast mode' zero-RPC buys from CreateEvent data) and warp-id/solana-trading-bot (TypeScript, ~2.3k stars/988 forks, Raydium pool listener, filters for LP burn/mint renounce/metadata, TP/SL, Jito or Warp executors). 1fge/pump-fun-sniper-bot (Go) is explicitly archived.
- Open-source bundlers exist that replicate the insider behavior your safety layer must detect: cicere/pumpfun-bundler (create token + 25 same-block buys), Rabnail-SOL/Solana-PumpFun-Bundler (20 wallets via Jito bundle), PUMPFUNSCRIPT/pumpfun-bundler (21 wallets, same block) — useful as adversary models, not for use.
- GitHub supply-chain attacks target exactly this niche: SlowMist analyzed zldp2002/solana-pumpfun-bot (July 2025) — fake stars/forks, malicious npm package crypto-layout-utils (pulled from a non-registry GitHub URL) scanning disk for wallet keys and exfiltrating; multiple mirror accounts publish slightly-modified clones.

## Named examples
- **Axiom Trade**: Dominant Solana web trading terminal in 2026 (~$51.5M/day, 44.6% share; 0.75-0.95% fees; Pulse launch discovery, wallet tracking, MEV modes, Hyperliquid perps; Feb 2026 ZachXBT-reported internal-data-misuse incident) — https://coinbureau.com/review/axiom-trade-review
- **Trojan**: Top Solana Telegram bot by lifetime volume ($25B+, 2M+ users); 1% fee (0.9% with referral); sniping, copy-trade, limit orders — https://telegramtrading.net/trojan-telegram-bot-review/
- **BonkBot**: Solana Telegram bot, ~$14M daily volume, ~$4.35M monthly fees, 1% fee (0.75% top tier), fees buy-and-burn BONK — https://www.coingecko.com/learn/solana-telegram-trading-bots
- **Banana Gun / Banana Pro**: Telegram bot + Solana-native web app; 1% fee; Jito MEV-protected routing, anti-rug guards, limit orders, copy trading — https://solanacompass.com/projects/banana-gun
- **GMGN.ai**: Multi-chain terminal + Telegram bot; flat 1% fee; smart-money copy trading, SnipeX sniping, in-terminal insider/bundle/dev-holdings/top-10 metrics; late-2025 phishing wave hit users for $700K+ — https://coincodecap.com/gmgn-review
- **BullX**: Web terminal ($12B+ cumulative volume, ~260K MAU mid-2025) that paused trading June 1, 2026 with unresolved points/airdrop program — case study in platform risk — https://ourcryptotalk.com/news/bullx-shutdown-trading-airdrop
- **Maestro**: Multi-chain Telegram bot (14 chains, $12.8B lifetime volume, 573K users), cashback up to 30% — https://solanatradingbots.com/
- **MEVX / Padre (Terminal) / Nova**: 2025-2026 newer terminals: MEVX web+extension+TG multi-chain; Padre rebranded to Terminal with cashback fee model; Nova TG sniping/copy bot — https://solanatradingbots.com/mevx-how-to-use/
- **chainstacklabs pump-fun bot (pumpfun-bonkfun-bot)**: Best-maintained educational Pump.fun sniper: Python, ~970 stars, Apache 2.0, Geyser/logs/blocks/PumpPortal listeners, bonding-curve math, PumpSwap migration detection, learning-examples directory — https://github.com/chainstacklabs/pump-fun-bot
- **warp-id/solana-trading-bot**: TypeScript Raydium sniper, ~2.3k stars/988 forks; buy filters (LP burn, mint renounced, mutable metadata, pool size), TP/SL auto-sell, Jito/Warp executors; beta but active — https://github.com/warp-id/solana-trading-bot
- **1fge/pump-fun-sniper-bot**: Go-based Pump.fun sniper replicating a known profitable wallet's strategy — explicitly archived/abandoned (useful reference only) — https://github.com/1fge/pump-fun-sniper-bot
- **TreeCityWes/Pump-Fun-Trading-Bot-Solana**: Open-source Pump.fun sniper/trader using market-cap change and bonding-curve progress rules — https://github.com/TreeCityWes/Pump-Fun-Trading-Bot-Solana
- **cicere/pumpfun-bundler**: Open-source Pump.fun bundler: create token + 25 same-block buys via Jito — adversary model for bundled-supply detection — https://github.com/cicere/pumpfun-bundler
- **ChainBuff**: GitHub org with fully open-source Solana gRPC trading/copy-trading bots and a jito-landing-benchmark repo measuring landing rate and slot gap — https://github.com/orgs/ChainBuff/repositories
- **soltrade**: Python Jupiter-based swing bot using EMA/RSI/Bollinger indicators — the archetypal indicator-driven (non-sniper) open-source Solana bot — https://github.com/noahtheprogrammer/soltrade
- **Helius LaserStream + Sender**: Yellowstone-compatible gRPC with shred-level ingestion (launched June 18, 2025), 24h replay, multi-region; Sender submits via SWQoS+Jito simultaneously, lands most txs within a single slot, 6 TPS default free tier — https://www.helius.dev/blog/zero-slot
- **Shyft**: Trader-focused Solana infra: unmetered Yellowstone gRPC from $199/mo, 7 regions, dedicated gRPC nodes, staked RPCs, RabbitStream shreds — https://shyft.to/solana-yellowstone-grpc
- **Jito Block Engine docs**: Authoritative bundle/tip mechanics: min tip 1,000 lamports, 5-tx atomic bundles, 8 tip accounts, tip_floor/tip_stream APIs, 50ms auction ticks, 1 req/s default rate limit — https://docs.jito.wtf/lowlatencytxnsend/
- **Chorus One latency study**: Empirical Nov 2024 measurement: swQoS ~3x inclusion improvement; priority-fee size and Jito tip size showed no significant latency effect — https://chorus.one/reports-research/transaction-latency-on-solana-do-swqos-priority-fees-and-jito-tips-make-your-transactions-land-faster
- **RugCheck**: Free Solana token scanner with public REST API (api.rugcheck.xyz, Swagger, X-API-KEY), risk scoring, insider-network graph endpoint; Python wrapper ccan23/rugcheck — https://solanacompass.com/projects/rugcheck
- **SolSniffer**: Solana token auditor: 0-100 Snifscore from 20+ indicators (mint/freeze risk, holder concentration, liquidity, metadata immutability), API for integration — https://solsniffer.com/blog/solsniffer-apis-features-and-use-cases
- **GoPlus Token Security API (Solana)**: Free-tier security API returning mint/freeze authority, metadata mutability, balance-mutability, locker data (Streamflow) for Solana tokens — https://docs.gopluslabs.io/changelog/token-security-api-for-solana
- **Trench Bot / TrenchRadar**: Telegram bundle scanner + bubble-map viewer for Pump.fun: detects same-block coordinated buys, shared-funding insider clusters, % of supply bundled and sold — https://docs.trench.bot/bundle-tools/bubblemap-bundle-viewer
- **Bubblemaps**: Wallet-cluster visualization for holder-concentration/insider analysis; reported acquired by Etherscan — https://smithii.io/en/top-3-solana-rug-pull-detection-tools/
- **pump-fun/pump-public-docs**: Official Pump.fun program docs + IDL: Pump program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P, PumpSwap pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA, bonding-curve mechanism — https://github.com/pump-fun/pump-public-docs
- **SlowMist malware analysis**: Threat-intel writeup of the zldp2002/solana-pumpfun-bot GitHub malware (malicious crypto-layout-utils npm dep, fake stars, private-key exfiltration) — required reading before running any third-party bot repo — https://slowmist.medium.com/threat-intelligence-an-analysis-of-a-malicious-solana-open-source-trading-bot-ab580fd3cc89

## Pitfalls
- GitHub bot repos are an active malware vector: SlowMist documented private-key-stealing 'open-source' Solana bots with faked stars/forks and malicious npm dependencies (crypto-layout-utils); many high-ranking 'pumpfun sniper/bundler/copy-trading' repos (rotating single-purpose accounts) are lead-gen for dev-for-hire or unsafe clones. Audit dependencies, run in a sandbox, and never load a funded key into unreviewed code.
- Paying more does not make you faster: the Chorus One study found priority-fee size and Jito tip size have no significant effect on time-to-inclusion — latency comes from swQoS/staked connections and shred-level data feeds. Budget for infrastructure (gRPC + staked sender, roughly $50-500/mo) rather than fee overspend; public/free RPC is explicitly insufficient for this workload.
- Jito bundle economics squeeze margins: bundles are a competitive auction (searchers tip 50-70% of expected profit; too low = never lands, ~2-slot expiry, 1 req/s default rate limit). A solo bot competing on pure speed against co-located firms on Pump.fun launches is structurally disadvantaged — edge must come from selection (safety filters, probability models), not latency.
- Base rates are brutal: only ~0.2-0.26% of Pump.fun launches graduated in mid-2026 (0.198% within 24h across 832,941 launches); the overwhelming majority of curve tokens are rugs, bundled-insider launches, or instant deadweight. Any strategy must survive a ~99.8% failure base rate, and bundled-supply/insider-cluster detection (same-block buys, shared funding source) is as important as mint/freeze/LP checks.
- Fee regimes change frequently and break backtests: Pump.fun moved graduation venue (Raydium to PumpSwap, March 2025), added creator revenue share (May 2025), rebuilt fees entirely under Project Ascend (Sept 2025, dynamic 0.05-0.95% creator fees), added fee splitting (Jan 2026), and changed launch incentives with BOOST (July 2026, graduation rate jumped 8x). Hard-coding fee/graduation assumptions is a recurring failure mode.
- Platform and account risk is real even for tooling you depend on: BullX paused trading June 1, 2026 with no timeline (users' points/airdrop stranded); X mass-suspended memecoin-sector accounts (Pump.fun, BullX, GMGN, Bloom) in June 2025; GMGN users lost $700K+ to fake-site phishing in late 2025. Don't build hard dependencies on any single commercial bot, aggregator API (e.g. PumpPortal), or social data source.
- Conflicting/uncertain claims found in sources (treat with care): one source claims Photon rebranded into Axiom while Coin Bureau treats them as separate competitors (uncertain — verify before citing); Jito-client stake share is variously reported as ~70% and 95%+; commercial-bot volume figures are mostly self-reported or from affiliate review sites and should be sanity-checked against Dune/DefiLlama before use in the roadmap.
- Copy-trading execution quality is a known weak point even on commercial platforms (GMGN reviews flag significant slippage/latency on mirrored fills); follower slippage vs the leader wallet is the core engineering problem, not wallet discovery.
- Durable nonces solve transaction expiry (150 slots / ~90s), not latency — useful for retry/queue architecture but irrelevant to sniping speed; conversely 'zero-slot' claims (Helius Sender/LaserStream) describe best-case same-slot landing, with no guaranteed-latency SLA published.

## Sources
- https://www.coingecko.com/learn/solana-telegram-trading-bots
- https://solanatradingbots.com/
- https://telegramtrading.net/trojan-telegram-bot-review/
- https://www.dextools.io/tutorials/best-telegram-bots-for-solana-2026
- https://coinbureau.com/review/axiom-trade-review
- https://coinspot.io/en/reviews/axiom-crypto-trading-platform/
- https://memegateway.com/academy/axiom-trading-bot-guide/
- https://solanacompass.com/projects/banana-gun
- https://coincodecap.com/gmgn-review
- https://ourcryptotalk.com/news/bullx-shutdown-trading-airdrop
- https://crypto.news/bullx-pauses-meme-trading-tool-but-keeps-wallet-access-open/
- https://solanatradingbots.com/mevx-how-to-use/
- https://madeonsol.com/blog/how-to-use-padre-solana-trading
- https://github.com/warp-id/solana-trading-bot
- https://github.com/chainstacklabs/pump-fun-bot
- https://github.com/1fge/pump-fun-sniper-bot
- https://github.com/TreeCityWes/Pump-Fun-Trading-Bot-Solana
- https://github.com/cicere/pumpfun-bundler
- https://github.com/Rabnail-SOL/Solana-PumpFun-Bundler
- https://github.com/orgs/ChainBuff/repositories
- https://github.com/noahtheprogrammer/soltrade
- https://slowmist.medium.com/threat-intelligence-an-analysis-of-a-malicious-solana-open-source-trading-bot-ab580fd3cc89
- https://www.cryptotimes.io/2025/07/04/crypto-stealing-solana-trading-bot-on-github-exposed/
- https://www.helius.dev/docs/grpc
- https://www.helius.dev/blog/zero-slot
- https://www.helius.dev/blog/solana-shreds
- https://shyft.to/solana-yellowstone-grpc
- https://blog.quicknode.com/best-solana-rpc-providers-2026/
- https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/
- https://docs.jito.wtf/lowlatencytxnsend/
- https://rpcfast.com/blog/jito-explained-bundles-tips-mev-solana
- https://chorus.one/reports-research/transaction-latency-on-solana-do-swqos-priority-fees-and-jito-tips-make-your-transactions-land-faster
- https://rpcfast.com/blog/solana-transaction-fees-explained
- https://solana.com/docs/core/transactions/durable-nonces
- https://solanacompass.com/projects/rugcheck
- https://apidog.com/blog/rugcheck-api/
- https://github.com/ccan23/rugcheck
- https://solsniffer.com/blog/solsniffer-apis-features-and-use-cases
- https://docs.gopluslabs.io/changelog/token-security-api-for-solana
- https://docs.trench.bot/bundle-tools/bubblemap-bundle-viewer
- https://trench.bot/
- https://smithii.io/en/top-3-solana-rug-pull-detection-tools/
- https://www.dextools.io/tutorials/how-to-use-gmgn-smart-money-analytics-tutorial-2026
- https://github.com/pump-fun/pump-public-docs
- https://deepwiki.com/pump-fun/pump-public-docs/3.1-pump-bonding-curve-mechanism
- https://gist.github.com/rubpy/6c57e9d12acd4b6ed84e9f205372631d
- https://pump.fun/docs/fees
- https://www.blocmates.com/news-posts/pump-fun-s-dex-pumpswap-launches-0-05-creator-fee-on-transactions
- https://www.theblock.co/post/354038/pumpswap-revenue-tokens
- https://www.dextools.io/news/pump-fun-graduation-collapse-solana-fees-2026
- https://www.theblock.co/post/375352/pump-fun-dominates-token-launches-1-million-daily-despite-market-slowdown
- https://www.theblock.co/amp/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives
- https://defillama.com/protocol/pumpswap
