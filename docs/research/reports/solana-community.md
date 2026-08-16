# solana-community

## Summary
Community and on-chain evidence from 2024-2026 paints a consistent picture: the overwhelming majority of individual Solana memecoin bot operators lose money, and the profitable minority is dominated by insiders and infrastructure owners rather than outside retail bot users. Dune/CoinGecko data on Pump.fun shows the share of profitable wallets rarely exceeded 50% from April 2024 through late 2025 (bottoming at 30.1% in June 2025); ~96% of wallets in March 2026 either lost money or made under $500; and only 55,296 of 13.55M wallets (0.4%) ever realized more than $10,000 in profit. The token side is equally hostile: Solidus Labs classified 98.6% of Pump.fun launches as pump-and-dumps/fraud, an academic study (arXiv 2603.24625) found ~55% of new Solana tokens exhibit rug behavior with a median rug lifespan of 0.01 days, and 93% of 388k Raydium pools showed soft-rug characteristics. Notably, CoinGecko data shows profitability recovered in 2026 (70-73% of remaining traders profitable by Mar-Apr 2026) — but only after monthly active wallets collapsed from 5.2M to 1.8M, i.e., the losers left rather than the game getting easier.

Sniping and copy-trading edges are both structurally degraded by insiders. Pine Analytics' "Exit Liquidity Machines" report found >50% of Pump.fun tokens are now sniped in their creation block, but the winners are deployer-funded sniper wallets (4,600+ wallets tied to 10,400+ deployers) with an 87% win rate extracting 15,000+ SOL/month, exiting 85% of positions within 5 minutes — outside "spray and pray" snipers face pure adverse selection, and Jito-bundled launches (mint + 20-25 buys in one atomic block) remove the window snipers rely on entirely. The one honest independent build log found (Moonshot, a Python Pump.fun sniper) recorded a 22% overall win rate (13% unfiltered, 36% with quality filters), 14% of positions rugged, and -44% of capital lost on day one. For copy trading, even the fastest commercial platform (OdinBot) claims only 15% of copies land in the same block with rivals at 1-2 seconds behind — fatal when median memecoin hold time has collapsed to ~100 seconds — and an ACM WWW 2026 paper documents bot wallets that deliberately front-run copiers, conceal positions, and fabricate sentiment, "systematically extracting value from naive copiers at scale." Wallet-finding leaderboards (GMGN, SolanaTracker, Cielo) are gameable: trackers count transfers/airdrops as PnL, insiders show profits with no purchase history, and "instant-sell" wallets farm their own copiers.

MEV and scams are first-order costs, not edge cases. Sandwich bots extracted an estimated $370-500M over 16 months; one bot (B91) sandwiched ~78,800 victims in 30 days, and Telegram-bot users with high slippage settings are the primary prey — a Helius analysis found sandwich attacks in 112 of 150 DeFi tokens in one week, with roughly half of victims' trades break-even or losing even at 2% slippage. Users now pay Jito ~$9M/week in tips for private bundles as mitigation, and coordinated validator blacklisting cut sandwich profitability 60-70% in 2025, though $3.2M was still extracted in October 2025. The operator-targeting scam layer is thick: Solareum (TG bot) drained $523K from users and shut down; a fake "solana-pumpfun-bot" GitHub repo with real-looking stars/forks drained wallets via a hidden NPM dependency; DogWifTools' supply-chain RAT stole ~$10M; and BullX froze trading in June 2026 after collecting ~$203M in fees against an airdrop that never came. The typical operator path is manual Phantom trading -> Telegram bots (BonkBot/Trojan/Photon, 1% per side, 2024) -> web terminals (Axiom, ~50-74% of Solana terminal volume, sub-400ms colocated execution, 2025-26) -> custom bots for a small minority. Community consensus on when custom is worth it: when 1%-per-side fee drag exceeds infra cost ($99-499/month shared gRPC/Yellowstone, ~$2,900/month dedicated node) and when you need filters/strategies commercial bots don't expose; the repeated warning is that "90% of DIY snipers fail" on infrastructure (public RPC rate limits, slot drift), and that selection/filtering matters more than raw speed for anyone who is not fighting for slot zero.

## Key findings
- Pump.fun base rates: >60% of wallets lost money as of mid-2025 (BeInCrypto/Dune); ~96% of wallets in March 2026 lost money or made <$500; only 0.4% of 13.55M wallets ever realized >$10k profit; profitable-wallet share bottomed at 30.1% in June 2025 and only recovered to 70-73% in Mar-Apr 2026 after active wallets fell from 5.2M to 1.8M (loser exodus, not easier markets)
- Rug rates: 98.6% of Pump.fun launches classified as pump-and-dump/fraud (Solidus Labs); ~55% of all new Solana tokens show rug behavior with median rug lifespan 0.01 days and 75th percentile under 5 hours (arXiv 2603.24625); 93% of 388k Raydium pools showed soft-rug traits, median victim loss $2,832; 78 organized rug syndicates identified (median 36 members, 16-219 tokens each)
- Sniper economics are insider-dominated: >50% of Pump.fun tokens now sniped in the creation block, but deployer-FUNDED snipers (4,600+ wallets, 10,400+ deployers) hit 87% win rate and 15,000+ SOL/month profit, exiting 85% of positions within 5 minutes (Pine Analytics 'Exit Liquidity Machines'); independent snipers face adverse selection; Jito bundlers let devs mint + buy with up to 21-25 wallets atomically in one block, eliminating the sniper window and letting devs hold 30-40% of supply disguised as organic holders
- Honest independent sniper build log (Moonshot case study, Feb 2026): 22% overall win rate — 13% on unfiltered WebSocket snipes vs 36% with quality filters (min $5k liquidity, min 15 holders, max 30% top-holder concentration, mint/freeze authority checks, 20-30s velocity confirmation); 14% of positions rugged; lost 44% of a 4.21 SOL bankroll on day one; bot broke silently when Pump.fun migrated from Raydium to PumpSwap
- Copy-trading latency decay: best-in-class OdinBot lands only ~15% of copies same-block ('zero block latency'); typical platforms copy 1-2 seconds late; median Solana memecoin hold time collapsed to ~100 seconds (from ~300s a year earlier), so 1-2s of copy latency consumes most of the copied edge
- Copy-trading manipulation is systematic: ACM WWW 2026 paper (arXiv 2601.08641) documents manipulative wallets that front-run their copiers, conceal positions, and fabricate sentiment; a defensive LLM multi-agent filter still only achieved ~3% average return per meme coin trade under realistic frictions; red flags include wallets selling 15-20%+ of trades within 5 seconds (copier-farming) and 'profitable' wallets with no purchase history (insider allocations)
- Wallet-finder tools have poor community trust: GMGN scores 2.1/5 on Trustpilot with recurring complaints of copy-trade failures, fees charged on failed transactions, and 0.006 SOL default priority fee disproportionately eating small copies; PnL leaderboards inflated by transfers/airdrops/wash trades; top traders rotate/abandon wallets specifically to shake copiers
- MEV on Solana: sandwich bots extracted $370-500M over 16 months; bot 'arsc' made ~$30M in 2 months; bot B91 executed 82,000+ sandwiches on ~78,800 victims for ~6,900 SOL in 30 days; Helius found sandwiches in 112 of 150 sampled DeFi tokens in one week and 0.72% of blocks over 60 days; memecoin Telegram-bot users with high slippage are the primary victims; ~half of sandwiched trades were break-even or losing for the victim even at 2% slippage
- MEV mitigation that operators actually use: Jito private bundles/tips (~$0.04/trade typical; users paying ~$9.3M/week at peak), Jito ShredStream for pre-block visibility, BAM (Block Assembly Marketplace, July 2025) for private ordering; validator blacklisting (Marinade/Jito/Solana Foundation, 50+ validators) cut sandwich profitability an estimated 60-70% in 2025, but $3.2M was still extracted in Oct 2025
- Fee drag kills marginal edges: Telegram bots charge ~1% per side (BonkBot, Trojan, GMGN) plus priority fees plus Jito tips plus slippage; one documented congestion case turned a $500 gross profit into a $100 net loss; bots/terminals collectively earned hundreds of millions (BullX alone ~$203M in fees) while ~96% of their users made <$500 or lost
- Risk rules repeatedly cited by surviving operators (Trojan blog, Altrady, Gate Learn, edgeflo): position size 1-5% of bankroll (1-2% most cited); memecoin bankroll as a fixed dollar amount fully separated from main portfolio; take-profit ladder selling ~25% at 2x/3x/5x/10x; trailing stop ~30% from peak after 2x; initial stop -30% to -50%; time-based exit if flat for 24h (much shorter intraday for Pump.fun scalps); daily loss limit 2-3% of account / weekly 5-6%; hard stop after 3 consecutive losses (anti-tilt); adaptive size reduction after loss streaks ('heat system')
- Typical operator path confirmed by market-share data: manual DEX/Phantom -> Telegram bots (2024 peak: BonkBot $5B+ lifetime volume, Trojan $1.9B, 1% fees) -> web terminals in 2025-26 (Axiom captured ~50-74% of Solana terminal volume with colocated sub-400ms execution) -> custom bots for a minority; custom becomes rational when monthly volume x 2% round-trip fee exceeds infra cost: shared Yellowstone gRPC $99-499/month (Subglow, Shyft, rpcedge), dedicated node ~$2,900/month; '90% of DIY sniper bots fail' is attributed to infrastructure (public RPC rate limits, slot drift, congestion), not strategy logic
- Insider/manipulation context individuals compete against: UCL research found 489 individuals generated $3.2T in pump-and-dump-linked volume (~40% of observed activity) making $250M profit in 2023; PumpCell Telegram ring made ~$800k in Oct 2025 alone via synchronized launches + sniper buys; >60% of Telegram signal-group participants lose money; 76% of KOL-endorsed tokens drop >90% within 3 months

## Named examples
- **Pine Analytics — 'Exit Liquidity Machines' report**: On-chain study of deployer-funded same-block sniping on Pump.fun: 15,000+ tokens sniped by 4,600+ insider wallets with 87% win rate and 15,000+ SOL/month extracted; the key evidence that profitable 'sniping' is mostly an insider game — https://pineanalytics.substack.com/p/exit-liquidity-machines
- **Moonshot sniper bot case study (modern-managed.com)**: Rare honest first-person build log of a custom Pump.fun sniper (Python, Jupiter/PumpSwap): 22% win rate, 14% rug rate, -44% day-one drawdown, filters raised win rate 13%->36%; documents production bugs and the Raydium->PumpSwap migration breaking the bot — https://modern-managed.com/2026/02/building-a-solana-sniper-bot-in-3-days-an-ai-pair-programming-war-story/
- **Helius Solana MEV Report**: Infrastructure-provider research quantifying sandwich attacks on Solana, showing Telegram-bot memecoin traders with high slippage as primary victims — https://www.helius.dev/blog/solana-mev-report
- **B91 sandwich bot**: Case-studied Solana MEV bot: 82,000+ sandwich attacks victimizing ~78,800 retail traders for ~6,900 SOL in 30 days — https://medium.com/@joel_28760/breaking-down-mev-sandwich-attacks-on-solana-the-b91-bot-case-study-3e1c1ba35556
- **GMGN.ai**: Leading wallet-finder/copy-trade tool (once >$700k/day revenue) with 2.1/5 Trustpilot — recurring complaints: copy-trade failures, fees on failed transactions, locked funds — https://www.trustpilot.com/review/gmgn.ai
- **OdinBot**: Copy-trading platform whose marketing inadvertently quantifies edge decay: only ~15% of copies land same-block even with predictive execution; rivals lag 1-2 seconds — https://decrypt.co/314700/how-solana-copy-trading-platform-odinbot-is-achieving-zero-block-latency
- **Cielo Finance**: Multichain wallet-tracker used for alert-driven manual/semi-auto copying; public Telegram bots suffer alert delays under load, pushing serious users to paid private bots — https://docs.cielo.finance/faq
- **Solana Tracker**: Wallet PnL/leaderboard tool with plans up to $2,297/month; illustrates the paid data-API tier individual operators buy into — https://www.solanatracker.io/wallet
- **Solareum**: Solana Telegram trading bot that shut down April 2024 after ~$523K was drained from 300+ user wallets — canonical custodial-TG-bot failure — https://decrypt.co/224371/solana-telegram-trading-bot-shut-down-users-drained-523k
- **Fake 'solana-pumpfun-bot' GitHub repo (SlowMist alert, July 2025)**: Spoofed open-source trading bot with real-looking stars/forks that exfiltrated private keys via a hidden non-NPM dependency; representative of a whole class of drainer repos posing as profitable bots — https://www.cryptotimes.io/2025/07/04/crypto-stealing-solana-trading-bot-on-github-exposed/
- **DogWifTools supply-chain hack (Jan 2025)**: RAT injected into a tool used by rug-pull operators drained ~$10M — evidence of both the insider-tooling ecosystem and supply-chain risk for bot operators — https://www.halborn.com/blog/post/explained-the-dogwiftools-hack-january-2025
- **BullX trading freeze (June 2026)**: Major Solana terminal paused trading after collecting ~$203M in fees with promised airdrop undelivered; community called it a 'robbery' — trust risk of fee-farming platforms — https://cryptoadventure.com/bullx-app-pause-turns-203m-fee-machine-into-user-exit-warning/
- **QUANT live-stream rug (Nov 2024)**: Teen rugged his own Pump.fun token for $30K on livestream, then rugged two more (LUCY, SORRY) for 103 SOL; community revenge-pumped QUANT 71,000% — emblematic of dev-insider games and reflexive chaos snipers face — https://99bitcoins.com/news/ruthless-gen-z-kid-rugs-quant-for-30k-profit-on-livestream/
- **PumpCell Telegram ring (Solidus Labs, Dec 2025)**: Coordinated pump-and-dump network using synchronized launches and sniper-bot buys, ~$800K profit in October 2025 alone — https://www.coindesk.com/business/2025/12/09/telegram-ring-ran-pump-and-dump-network-that-netted-usd800k-in-a-month-solidus-labs
- **arXiv 2601.08641 — 'Resisting Manipulative Bots in Meme Coin Copy Trading'**: ACM Web Conference 2026 paper: manipulative wallets front-run copiers, conceal positions, fabricate sentiment; defensive multi-agent LLM filter achieved ~3% average per-trade return under realistic frictions — https://arxiv.org/abs/2601.08641
- **arXiv 2603.24625 — 'From Hype to Collapse: Investigating Rug Pull Scams on Solana'**: Academic measurement: ~55% of new tokens rug, median rug lifespan 0.01 days, $151M+ direct losses, 78 fraud syndicates — https://arxiv.org/html/2603.24625v2
- **Trojan bot risk-management blog**: First-party risk guide from a top Solana Telegram bot: 1-5% position sizing, 2x/3x/5x/10x take-profit ladders selling 25% per rung, trailing stops, 24h time-based exits — https://trojan.com/blog/solana-memecoin-risk-management
- **fdundjer/solana-sniper-bot**: One of the few legitimate open-source Solana sniper proof-of-concepts (vs the many drainer clones); useful as a reference implementation, explicitly labeled PoC — https://github.com/fdundjer/solana-sniper-bot
- **CoinGecko Research — 'Pump.fun Traders Are Making a Comeback'**: Monthly profitability series Apr 2024-Apr 2026: profitable share bottomed 30.1% (Jun 2025), recovered to 73.3% (Apr 2026) only after active wallets fell 5.2M->1.8M — https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback
- **Axiom**: Web trading terminal that displaced Telegram bots as the dominant execution layer (~50-74% of Solana terminal volume; colocated RPC, sub-400ms) — the middle step operators take before going custom — https://coinbureau.com/review/axiom-trade-review

## Pitfalls
- Copy-trading edge decays with latency: even the best platform lands only ~15% of copies same-block and typical copies execute 1-2s late, against a ~100-second median memecoin hold time; assume most of a copied wallet's paper edge is gone by fill time
- Copy-trade farming: wallets with attractive PnL deliberately bait copiers — they buy, let copiers pump the price, and dump within seconds; wallets selling 15-20%+ of positions within 5 seconds of entry are farming their followers
- Leaderboard PnL is unreliable: trackers count transfers, airdrops, and insider allocations as trading profit; wash trading inflates volume; profitable-looking wallets may have received tokens at launch with no buy history; top traders rotate wallets specifically to evade copiers
- Same-block sniping is an insider market: deployer-funded wallets with advance notice win 87% of the time; an outside sniper systematically buys the launches insiders skipped (adverse selection); Jito-bundled launches remove the snipe window entirely and fake 30-40% insider supply as organic holders
- Fee stack destroys thin edges: ~1% bot fee per side + priority fees + Jito tips + slippage; GMGN charges fees even on failed transactions; documented case of $500 gross profit becoming a $100 net loss under congestion
- High slippage settings (common in TG bots for fill reliability) make you sandwich-bot prey; ~half of sandwiched trades lose or break even for the victim even at 2% slippage — use private submission (Jito bundles) and slippage caps
- Most 'profitable open-source Solana bot' GitHub repos are scam lures: spoofed forks with fake stars and hidden malicious dependencies that exfiltrate private keys (SlowMist-documented); never run bot code against a funded wallet without dependency audit and sandboxing
- Custodial Telegram bots hold your keys: Solareum drained $523K and died; Banana Gun users drained $1.9M; BullX froze trading after harvesting $203M in fees — keep only working capital in bot wallets and withdraw profits continuously
- Rug base rate ~98.6% on Pump.fun means filters are the strategy, not an add-on: the one honest case study nearly tripled win rate (13%->36%) with liquidity/holder-concentration/authority checks, and still lost 44% of bankroll on day one from a filter-bypass bug
- Ecosystem migration risk: Pump.fun's move from Raydium graduation to PumpSwap silently broke deployed bots; the platform-vs-bot arms race (anti-sniper measures, fee changes) requires continuous maintenance a solo dev must budget for
- Survivorship and marketing bias: vendor blogs claiming '69% win rates' or '10-30% monthly returns' are unverified marketing; the verified base rate is ~96% of wallets making <$500/month or losing; the $6.8M/month sniper bot is a single on-chain outlier, not an expectation
- Public RPC infrastructure guarantees failure for latency-sensitive strategies (rate limits, slot drift); real infra costs $99-499/month shared gRPC or ~$2,900/month dedicated — size expected volume against this fixed cost before building custom
- Tilt is the documented account-killer: community discipline rules exist because operators blow up via revenge trading — hard daily loss limits (2-3%), 3-consecutive-loss stops, and fixed segregated memecoin bankrolls are the repeatedly cited survival mechanisms
- Uncertainty caveats: Reddit is blocked to this crawler so subreddit sentiment here comes via secondary reporting; OdinBot latency figures and the '$400 to $60,000' anecdote are vendor-supplied; 2026 Pump.fun profitability recovery data comes from CoinGecko/Dune aggregations whose PnL methodology (transfers, unrealized positions) is imperfect

## Sources
- https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback
- https://beincrypto.com/pump-fun-trading-data-majority-lose-money/
- https://finance.yahoo.com/news/99-6-pump-fun-traders-074204251.html
- https://coinjournal.net/news/over-60-of-pump-fun-wallets-lost-money-report/
- https://coinpedia.org/news/over-50-of-pump-fun-traders-lost-money-this-month-while-2-wallets-made-over-1m/
- https://news.bitcoin.com/report-exposes-98-6-of-solana-meme-coins-on-pump-fun-as-fraudulent/
- https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance
- https://arxiv.org/html/2603.24625v2
- https://arxiv.org/abs/2601.08641
- https://pineanalytics.substack.com/p/exit-liquidity-machines
- https://beincrypto.com/pump-fun-meme-coin-snipers-systematic-problem/
- https://bitcoinethereumnews.com/crypto/report-alleges-massive-meme-coin-sniping-on-pump-fun/
- https://www.panewslab.com/en/articles/416583xr
- https://modern-managed.com/2026/02/building-a-solana-sniper-bot-in-3-days-an-ai-pair-programming-war-story/
- https://yavorovych.medium.com/how-to-build-a-solana-sniper-bot-and-why-90-fail-the-infra-hack-that-wins-0cbfbbf76a8d
- https://www.cryptopolitan.com/pump-fun-bot-profit-memecoin-sniping/
- https://smithii.io/en/pump-fun-bundler-bot/
- https://github.com/PUMPFUNSCRIPT/pumpfun-bundler
- https://www.helius.dev/blog/solana-mev-report
- https://medium.com/@joel_28760/breaking-down-mev-sandwich-attacks-on-solana-the-b91-bot-case-study-3e1c1ba35556
- https://solanacompass.com/learn/accelerate-25/scale-or-die-at-accelerate-2025-the-state-of-solana-mev
- https://www.dlnews.com/articles/defi/solana-users-use-jito-to-stop-sandwich-attacks-and-mev/
- https://99bitcoins.com/news/altcoins/sandwich-attacks-spiraling-out-of-control-on-solana-over-3-2m-of-sol-crypto-extracted-in-october/
- https://www.coindesk.com/business/2024/06/10/solana-heavyweights-wage-war-against-private-mempool-operators
- https://www.fxstreet.com/cryptocurrencies/news/solana-sandwich-bot-makes-30m-from-mev-arbitrage-in-two-months-202406170451
- https://dl.acm.org/doi/10.1145/3730567.3764493
- https://decrypt.co/314700/how-solana-copy-trading-platform-odinbot-is-achieving-zero-block-latency
- https://www.trustpilot.com/review/gmgn.ai
- https://coincodecap.com/gmgn-review
- https://docs.cielo.finance/faq
- https://www.solanatracker.io/wallet
- https://www.walletmaster.tools/blog/best-solana-copy-trading-tools/
- https://nansen.ai/post/how-to-track-solana-wallets-complete-guide-for-smart-money-analysis
- https://decrypt.co/224371/solana-telegram-trading-bot-shut-down-users-drained-523k
- https://amlcrypto.io/blog/telegram_trading_bot_on_solana_network_stopped_working
- https://www.cryptotimes.io/2025/07/04/crypto-stealing-solana-trading-bot-on-github-exposed/
- https://www.halborn.com/blog/post/explained-the-dogwiftools-hack-january-2025
- https://www.bleepingcomputer.com/news/security/solana-pumpfun-tool-dogwiftool-compromised-to-drain-wallets/
- https://99bitcoins.com/news/ruthless-gen-z-kid-rugs-quant-for-30k-profit-on-livestream/
- https://news.bitcoin.com/gen-z-traders-30k-heist-backfires-as-crypto-community-rallies-token-to-56m-market-cap/
- https://www.coindesk.com/business/2025/12/09/telegram-ring-ran-pump-and-dump-network-that-netted-usd800k-in-a-month-solidus-labs
- https://medium.com/coinmonks/cryptos-3-2-trillion-scam-just-489-people-behind-massive-telegram-pump-and-dump-9486c39cc6e3
- https://cryptoadventure.com/bullx-app-pause-turns-203m-fee-machine-into-user-exit-warning/
- https://ourcryptotalk.com/news/bullx-shutdown-trading-airdrop
- https://coinbureau.com/review/axiom-trade-review
- https://www.crypto-reporter.com/press-releases/the-state-of-memecoin-trading-bots-in-2026-volume-fee-capture-and-market-share-across-the-top-8-126770/
- https://bonkbot.io/library/trojan-vs-photon-review
- https://trojan.com/blog/solana-memecoin-risk-management
- https://www.altrady.com/blog/crypto-trading-strategies/how-to-trade-memecoins
- https://www.gate.com/learn/articles/stop-roundtripping-your-massive-memecoin-gains-this-is-how/3948
- https://www.edgeflo.com/blog/three-loss-rule-trading
- https://chainplay.gg/blog/state-of-memecoin-2024/
- https://bitpinas.com/cryptocurrency/president-meme-coins-lose-money/
- https://dysnix.com/blog/solana-rpc-strategy-and-infrastructure-for-hft-bots
- https://subglow.io/solana-grpc-providers
- https://rpcfast.com/blog/pillars-of-choosing-a-solana-rpc-provider-for-trading-bots
- https://github.com/fdundjer/solana-sniper-bot
- https://cryptolinks.com/2900/rcryptomoonshots
- https://wublock.substack.com/p/how-did-gmgn-a-meme-tool-with-a-daily
