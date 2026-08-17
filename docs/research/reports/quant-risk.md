# quant-risk

## Summary
Bankroll math for the two bots converges on the same consensus: fractional Kelly (0.25x–0.5x) is the standard for binary-outcome prediction-market betting, with full Kelly treated as an upper bound because it assumes perfectly calibrated probability estimates — which no model has. The canonical formulas are f* = (p·b − q)/b with b = (1−price)/price for Polymarket shares, edge = your_probability − market_price, and EV/share = p_true×(1−cost) − (1−p_true)×cost. An arXiv paper specifically on Kelly for prediction markets (2412.14144) shows fees and estimation error should shrink positions well below raw Kelly. For correlated positions (many markets resolving on the same event — elections, Fed nights), practitioner guidance is to group correlated markets and Kelly-size the group as one bet, capping combined same-event exposure at ~20–25% of bankroll; exact multi-bet Kelly is O(2^N) and needs numerical methods. A real solo-scale reference implementation (guberm/polymarket-bot) layers exactly the controls the roadmap needs: per-position 15%, per-event 30%, daily stop-loss 20%, max drawdown 50%, half-Kelly cap in live mode, paper-trading default, and full decision journaling with offline Brier/calibration replay.

On the prediction-market quant side, the sobering finding is that Polymarket is well-calibrated on average (mean absolute calibration error ~2.1pp across 28,407 resolved markets Jan 2024–May 2026; platform Brier ~0.084), so a naive "my model disagrees with the market" signal mostly measures your own miscalibration. The documented, persistent exploitable structure is the favorite-longshot bias: across 300,000+ Kalshi contracts, sub-10¢ contracts lose 60%+ on average and NO-longshots outperform YES-longshots by up to ~64pp — i.e., systematically selling/avoiding overpriced longshots and buying favorites/NO-sides is the empirically grounded edge family. Fee math changed materially in Jan–Mar 2026: Polymarket now charges taker fees on nearly all categories (crypto 1.80%, politics 1.00%, sports 0.75%, fee = shares × rate × price × (1−price), maximal near 50¢, makers free with rebates), which invalidates pre-2026 backtests of thin-edge strategies and pushes solo operators toward maker-side execution. LLM-pipeline evidence is mixed but informative: PolyBench found only 2 of 7 frontier LLMs profitable on live Polymarket data, with profits collapsing when lot size scaled from $10 to $1,000 due to book slippage; the "Beyond Accuracy" paper found the best LLM's edge comes from losing less when wrong, and ensemble-agreement filters (trade only when a diverse LLM crowd agrees) improve realized returns. Classical ML guidance for small operators: gradient boosting (LightGBM/XGBoost) on engineered features beats deep learning on tabular financial data, logistic regression as the mandatory baseline, walk-forward validation only (k-fold leaks future data).

Backtesting-pitfall literature gives hard numbers for the roadmap's governance gates: Quantopian's study of 888 real strategies found backtest Sharpe has essentially no predictive power for out-of-sample results (R² < 0.025), with a 26% average in-sample→out-of-sample decay and a 20–50% live haircut being typical. For memecoins the problem is categorically worse: ~58% of all tokens ever listed on CoinMarketCap are dead, only ~1–2% of Pump.fun launches graduate the bonding curve while ~98% stagnate or rug, wash-trading bots inflate historical volume so recorded liquidity was never real, and no backtest can model being the exit liquidity in a rug — so any Pump.fun backtest built on graduated/surviving tokens is structurally invalid, and live simulation (forward paper trading against real feeds) is the only honest test. Live Solana costs compound this: 20–45% network-wide transaction failure rates during congestion (failed txs still burn priority fees), competitive searchers surrendering 50–70% of expected profit to Jito tips, and per-trade all-in costs of roughly 1.0% bot fee + 0.1–0.3% priority/Jito + 0.5–2% slippage.

For ops, the practical solo-operator pattern found in real projects: journal every decision (guberm writes each estimate + rationale + market state to estimates.jsonl for deterministic offline replay and Brier scoring), Prometheus/Grafana with Telegram alerting for drawdown/anomaly alerts, lock files to prevent two processes trading one wallet, multi-layered kill switches targeting distinct failure modes (cumulative P&L loss, abnormal order rate signaling a software loop, price deviation beyond expected range), and a promotion pipeline with numeric gates: 100-trade minimum (200–500 preferred) for statistical significance, walk-forward efficiency ≥50%, deflated-Sharpe adjustment for the number of variants tried, a 2–4 week paper-trading bridge, then canary deployment at 10–25% of intended size with a drawdown veto before scaling.

## Key findings
- Fractional Kelly consensus: professionals use 0.25x-0.5x Kelly; full Kelly carries ~33% probability of halving bankroll before doubling it; half-Kelly cuts variance ~75% while sacrificing only ~25% of long-run growth rate (multiple sources incl. Prevayo, poly-sim wiki, arXiv 2412.14144)
- Core formulas for binary shares: f* = (p*b - q)/b with b = (1-price)/price on Polymarket; edge = estimated_probability - market_price; EV per share = p_true*(1-cost_per_share) - (1-p_true)*cost_per_share; worked example: 75% estimate on a 60c YES gives 37.5% full-Kelly / 18.75% half-Kelly (poly-sim.com wiki)
- arXiv 2412.14144 ('Application of the Kelly Criterion to Prediction Markets'): market prices are not probabilities; ~2% fees meaningfully reduce optimal sizing; recommends treating theoretical Kelly values as upper bounds, not targets
- Correlated-bet handling: exact simultaneous Kelly is O(2^N) in joint outcomes; practical rule is to group correlated markets, Kelly-size the group as a single bet, and cap combined same-event-night exposure at 20-25% of bankroll (arXiv 2402.15588, 2604.24723; Prevayo advanced Kelly guide). Polymarket's negRisk structure links mutually exclusive outcomes with up to 9.5x capital efficiency for NO baskets
- Favorite-longshot bias is the best-documented systematic edge: Buergi/Deng/Whelan analyzed 300,000+ Kalshi contracts - sub-10-cent contracts lose 60%+ on average; NO longshots outperform YES longshots by up to 64pp; contracts above 50c earned ~+2.6% for makers pre-fee. QuantPedia cites -3.64% avg for favorites vs -26.08% for underdogs across 12,084 sports matches
- Polymarket is well-calibrated on average: mean absolute calibration error ~2.1pp across 28,407 resolved markets Jan 2024-May 2026; platform-wide Brier ~0.0843 - so raw model-vs-market disagreement mostly measures your own miscalibration; Brier benchmarks: 0.05-0.15 expert, 0.25 = always-50% baseline; track own Brier over 100+ trades, <0.20 suggests real calibration
- Fee regime changed Jan-Mar 2026: Polymarket taker fees now on nearly all categories (crypto 1.80%, economics 1.50%, politics 1.00%, sports 0.75%; geopolitics still free); fee = shares x feeRate x price x (1-price), maximal at 50c, tapering to ~0 at extremes; makers trade free and earn rebates (20% of taker fees on crypto markets). Total round-trip cost = taker fee + spread + gas + resolution risk; spread is often the largest item in thin books
- Backtest-to-live degradation is quantified: Wiecki et al. (SSRN 2745220) on 888 Quantopian algos found backtest Sharpe predicts OOS performance at R^2 < 0.025; 26% average in-sample-to-OOS decay across 97 published strategies plus 58% further post-publication decline (via Turbine blog citing McLean & Pontiff); 20-50% live-performance haircut is the commonly cited range
- Memecoin backtests are structurally invalid: ~98-99% of Pump.fun launches show rug/pump-dump patterns and only 1-2% graduate; ~14,000 of ~24,000 CMC-listed tokens are dead (58%+); wash-trading bots fabricate historical volume so backtested liquidity never existed; bonding-curve convexity guarantees the average buyer loses; vendor claims of 200-400% backtest return inflation from survivorship alone (StratBase - uncertain, vendor figure)
- Live Solana execution costs that paper trading must model: 20-45.5% network transaction failure rates during 2025 congestion (avg ~39%); failed transactions still burn 0.001-0.05 SOL in priority fees; competitive searchers surrender 50-70% of expected profit to Jito tips; realistic per-trade cost ~1.0% bot fee + 0.1-0.3% priority/Jito + 0.5-2% slippage
- LLM pipelines: PolyBench (arXiv 2604.14199) tested 7 frontier LLMs on 38,666 live Polymarket markets - only 2 were profitable (MiMo-V2-Flash +17.6% CWR, Gemini-3-Flash +6.2%); losers ranged -9.2% to -25.2% despite uniformly high stated confidence; profits at $10 lots 'violently contracted' at $1,000 lots due to slippage. 'Beyond Accuracy' (OpenReview TSA5kRUKZv): best LLM's edge comes entirely from losing less when wrong; using within-crowd agreement of a diverse LLM ensemble as a confidence filter improves returns. Turtel et al. 2025 fine-tuned on 12,100 resolved Polymarket questions; SOTA LLM Brier ~0.122-0.136 vs superforecaster 0.096
- Classical ML for small operators: gradient boosting (LightGBM/XGBoost) on engineered tabular features generally beats deep learning in financial literature; logistic regression is the standard baseline to test whether nonlinearity adds value; walk-forward validation is mandatory - k-fold CV leaks future data and produces optimistically biased results; typical anti-overfit hyperparameters: depth ~6, LR ~0.03, early stopping on a temporally held-out fold
- Go-live model gates found in practice: minimum 100 trades for basic significance (200-500 preferred); walk-forward efficiency >= 50%; deflated Sharpe ratio adjusting for number of variants tested; probability-of-backtest-overfitting test; 2-4 week paper-trading bridge; canary deployment at 10-25% of intended size (Turbine says 10-20% of capital, TradersPost says start at 25-50% position size) with drawdown limits before scaling; gates should be numeric PASS/FAIL, not judgment calls
- Kill-switch design: multi-layered switches targeting distinct failure modes - cumulative/daily loss limits (typical 2-5% of equity/day), max-drawdown circuit breaker pausing new entries, abnormal order-rate detection (signals a software loop), and price-deviation-beyond-range checks; on trigger, flatten all positions with market orders and halt until manual reset. Real example (guberm/polymarket-bot): per-position cap 15%, per-event 30%, per-category 80%, daily stop-loss 20%, max drawdown 50%, half-Kelly cap in live mode, 2-cycle cooldown after closing a position
- Solo-operator ops pattern: journal every decision with inputs and rationale (guberm writes estimates.jsonl with market price, rationale, and model IDs, enabling deterministic offline replay, Brier scoring, and calibration validation); Prometheus + Grafana dashboards with Telegram contact points for drawdown/anomaly alerts; lock file (bot.lock) prevents two processes trading the same wallet; reconciliation = comparing internal state vs exchange API positions on a schedule; paper-trading-by-default with live trading behind an explicit config flag

## Named examples
- **guberm/polymarket-bot**: Autonomous Polymarket bot: LLM-ensemble probability estimation (trimmed mean, skips markets when ensemble std dev >10%), fractional Kelly capped at half-Kelly live, six layered risk caps (15% position / 30% event / 80% category / 20% daily stop / 50% max DD), paper-trading default, estimates.jsonl decision journal with offline Brier/calibration replay - the closest existing blueprint to the roadmap's Polymarket bot — https://github.com/guberm/polymarket-bot
- **djienne/Polymarket-bot**: Dual-strategy Polymarket HFT bot (YES/NO pair arbitrage below $0.975 combined + BTC 15-min momentum) with configurable 1/8 to full Kelly, circuit breaker after 5 consecutive failures, separate capital pools per strategy, health-check API and web dashboard — https://github.com/djienne/Polymarket-bot
- **suislanchez/polymarket-kalshi-weather-bot**: Multi-platform weather-market bot (Kalshi + Polymarket) using 31-member GFS ensemble forecasts, Kelly sizing, and signal calibration; claims $1.8k highest profit - example of a narrow, data-driven edge domain for a solo operator — https://github.com/suislanchez/polymarket-kalshi-weather-bot
- **ventry089/weatherbot**: Polymarket weather bot with Kelly + EV + paper-trading-by-default + dashboard; runs locally — https://github.com/ventry089/weatherbot
- **TreeCityWes/Pump-Fun-Trading-Bot-Solana**: Free open-source Pump.fun trading bot with concrete exit ladder (sell 50% at +25%, 75% of remainder at next +25%, stop-loss on -10% market cap) - reference for memecoin TP/SL structure — https://github.com/TreeCityWes/Pump-Fun-Trading-Bot-Solana
- **bitman09/pumpfun-sniper-bot**: Pump.fun sniper with anti-rug filters: creator-history scoring, mint-authority checks, dev-wallet concentration limits, liquidity floor enforcement, slippage cap, allow/deny lists by creator address — https://github.com/bitman09/pumpfun-sniper-bot
- **Bagtester**: MCP-native backtesting service specifically for Polymarket bots - relevant tooling for the paper-trading-first governance requirement — https://bagtester.com/
- **PolyBench (arXiv 2604.14199)**: Benchmark of 7 frontier LLMs on 38,666 live Polymarket markets with exact CLOB state; only 2/7 profitable; demonstrates slippage kills LLM edge at $1,000 lot sizes — https://arxiv.org/html/2604.14199v1
- **Beyond Accuracy: Can LLM Forecasters Profit on Prediction Markets?**: Shows best LLM forecaster matches market accuracy but earns higher returns by losing less when wrong; LLM-crowd agreement as confidence filter — https://openreview.net/forum?id=TSA5kRUKZv
- **Application of the Kelly Criterion to Prediction Markets (arXiv 2412.14144)**: Academic treatment of Kelly for prediction markets: prices are not probabilities, fees shrink optimal size, Kelly values are upper bounds — https://arxiv.org/pdf/2412.14144
- **All That Glitters Is Not Gold (Wiecki et al., SSRN 2745220)**: 888 real Quantopian strategies: backtest Sharpe predicts out-of-sample at R^2 < 0.025; more backtesting iterations = bigger live gap - the key citation for model gates — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2745220
- **Makers and Takers: The Economics of the Kalshi Prediction Market (Buergi, Deng, Whelan, UCD)**: 300,000+ contract study quantifying favorite-longshot bias: sub-10c contracts lose 60%+; the empirical basis for a longshot-avoidance/favorite-tilt strategy — https://nexteventhorizon.substack.com/p/what-five-new-academic-papers-say-prediction-markets
- **QuantPedia: Systematic Edges in Prediction Markets**: Survey of inter/intra-exchange arbitrage and longshot bias with return numbers; notes arb windows last seconds-to-minutes and transaction costs eat most profit — https://quantpedia.com/systematic-edges-in-prediction-markets/
- **Turbine: Why Backtests Lie (prediction market overfitting)**: Practitioner writeup with degradation numbers (26% OOS decay, 33-44% Sharpe degradation), thin-book fill pitfalls near resolution, and the walk-forward/deflated-Sharpe/canary remedy stack — https://www.turbinefi.com/blog/why-backtests-lie-prediction-market-overfitting-2026
- **poly-sim.com wiki: Probability & Odds Explained**: Compact reference for EV/Kelly/Brier formulas with Polymarket-specific worked examples and benchmarks — https://poly-sim.com/wiki/probability-odds-explained.html
- **Snowberg & Wolfers: Explaining the Favorite-Long Shot Bias**: Classic academic paper establishing the bias stems from probability misperception rather than risk-love - theoretical grounding for why the bias persists — https://www.researchgate.net/publication/227354847_Explaining_the_Favorite-Long_Shot_Bias_Is_it_Risk-Love_or_Misperceptions

## Pitfalls
- Full Kelly with estimated (not true) probabilities systematically overbets: estimation error makes the realized Kelly fraction too large, so cap at half-Kelly or quarter-Kelly and treat computed Kelly as an upper bound (arXiv 2412.14144; guberm bot enforces half-Kelly cap in live mode)
- Sizing each Polymarket position independently ignores correlation: many positions resolving on the same event/night (election, Fed decision) can all lose simultaneously; group them and cap combined group exposure at 20-25% of bankroll
- Polymarket is well-calibrated on average (2.1pp mean calibration error), so a model that frequently 'disagrees with the market' is more likely miscalibrated itself than finding edge - require a calibration track record (Brier < ~0.20 over 100+ resolved trades) before trusting model-vs-market deltas
- Buying longshots is the documented losing side: sub-10c contracts lose 60%+ on average; retail disproportionately buys YES-longshots - the roadmap's bot must be structurally biased against cheap-lottery-ticket buys
- Pre-2026 Polymarket backtests are invalidated by the Jan-Mar 2026 taker-fee rollout (0.75-1.80% by category, maximal near 50c prices); thin-edge strategies that backtested profitable as takers may now only work as makers
- Backtests using mid-quote fills overstate returns badly in thin books - Polymarket orderbooks thin dramatically near resolution, and PolyBench showed returns positive at $10 lots turning negative at $1,000 lots from slippage alone; model fills against actual book depth or assume worst-touch
- Memecoin backtests cannot model rug pulls or exit liquidity: ~98% of Pump.fun launches fail or rug, historical volume is heavily wash-traded (recorded liquidity never really existed), and datasets built from graduated/surviving tokens carry extreme survivorship bias - treat any Pump.fun backtest as an upper-bound fiction and rely on forward paper trading against live feeds
- Solana live execution differs from simulation: 20-45% transaction failure rates under congestion, failed transactions still burn priority fees (0.001-0.05 SOL each), and Jito tips consume 50-70% of expected profit for competitive strategies - paper trading must charge these costs or it will overstate returns
- k-fold cross-validation on time series leaks future data into training and produces optimistic results; only walk-forward validation respects temporal ordering
- Backtest Sharpe has near-zero predictive power for live performance (R^2 < 0.025 across 888 real strategies), and running many backtest variants then picking the best is selection noise - track the number of trials and apply a deflated Sharpe ratio
- Expect a 20-50% performance haircut going from backtest to live even for honest strategies; budget the go/no-go economics assuming the worse end
- LLMs state uniformly high confidence regardless of actual accuracy (PolyBench); never use an LLM's self-reported confidence as a sizing input - use ensemble dispersion/agreement instead (guberm skips markets when ensemble std dev > 10%)
- Kill switches that only watch P&L miss software failure modes: add abnormal-order-rate and price-deviation triggers to catch runaway loops, and use a lock file so two processes can never trade the same wallet
- Arbitrage-style edges (negRisk baskets, cross-platform) exist for seconds to minutes and are mostly consumed by transaction costs and capital lockup - not a reliable solo-operator staple
- Vendor-blog numbers (e.g., '200-400% survivorship inflation', 'Coinbase 17-22% annual inflation') could not be traced to primary sources and should be treated as directional, not precise (marked uncertain)

## Sources
- https://arxiv.org/pdf/2412.14144
- https://poly-sim.com/wiki/probability-odds-explained.html
- https://www.prevayo.com/blog/advanced-kelly-criterion-fractional-multi-market-prediction-markets
- https://managebankroll.com/blog/polymarket-kelly-criterion-position-sizing
- https://arxiv.org/html/2402.15588v1
- https://arxiv.org/pdf/2604.24723
- https://quantpedia.com/systematic-edges-in-prediction-markets/
- https://nexteventhorizon.substack.com/p/what-five-new-academic-papers-say-prediction-markets
- https://www.researchgate.net/publication/227354847_Explaining_the_Favorite-Long_Shot_Bias_Is_it_Risk-Love_or_Misperceptions
- https://papers.ssrn.com/sol3/Delivery.cfm/5910522.pdf?abstractid=5910522&mirid=1
- https://fensory.com/intelligence/predict/polymarket-accuracy-analysis-track-record-2026
- https://www.tradetheoutcome.com/polymarket-accuracy-report-data/
- https://nickhaubri.ch/blog/follymarket-polymarket-forecast-assessment/
- https://www.crypticorn.com/polymarket-fees-explained/
- https://www.oddsshopper.com/articles/betting-101/polymarket-fees
- https://www.tradetheoutcome.com/polymarket-fees/
- https://docs.polymarket.com/advanced/neg-risk
- https://startpolymarket.com/learn/converting-negative-risk/
- https://www.turbinefi.com/blog/why-backtests-lie-prediction-market-overfitting-2026
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2745220
- https://stratbase.ai/en/blog/survivorship-bias-crypto
- https://www.coinapi.io/blog/how-to-eliminate-survivorship-bias-in-crypto-backtesting
- https://concretumgroup.com/building-a-survivorship-bias-free-crypto-dataset-with-coinmarketcap-api/
- https://crypto.news/how-meme-coins-are-made-bonding-curves-pump-fun-rug-pulls/
- https://storm.partners/blog-post/meme-coin-mania-on-pump-fun-an-economic-and-legal-analysis
- https://www.assuredefi.com/blog/meme-coin-rug-pulls-pump-dumps-how-to-spot-and-prevent-fraud
- https://arxiv.org/html/2604.14199v1
- https://openreview.net/forum?id=TSA5kRUKZv
- https://arxiv.org/pdf/2502.05253
- https://arxiv.org/html/2607.14051v1
- https://blog.quantinsti.com/walk-forward-optimization-python-xgboost-stock-prediction/
- https://www.mdpi.com/2079-9292/15/6/1334
- https://arxiv.org/pdf/2512.12924
- https://github.com/guberm/polymarket-bot
- https://github.com/djienne/Polymarket-bot
- https://github.com/suislanchez/polymarket-kalshi-weather-bot
- https://github.com/ventry089/weatherbot
- https://github.com/TreeCityWes/Pump-Fun-Trading-Bot-Solana
- https://github.com/bitman09/pumpfun-sniper-bot
- https://bagtester.com/
- https://www.mql5.com/en/blogs/post/767321
- https://3commas.io/blog/ai-trading-bot-risk-management-guide-2025
- https://tickerly.net/how-to-manage-risk-in-trading-bots-effectively/
- https://saintquant.com/blog/161-how-to-build-a-profitable-crypto-trading-bot-in-2026-a-quantitative-guide-for-algorithmic-traders
- https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/configure-telegram/
- https://blog.traderspost.io/article/paper-trading-strategy-development-guide
- https://stratbase.ai/en/blog/complete-backtesting-checklist-before-going-live
- https://www.backtestbase.com/education/how-many-trades-for-backtest
- https://rpcfast.com/blog/why-do-solana-transactions-get-dropped
- https://chorus.one/reports-research/transaction-latency-on-solana-do-swqos-priority-fees-and-jito-tips-make-your-transactions-land-faster
- https://yavorovych.medium.com/solana-transaction-fees-explained-for-trading-bots-2026-35ebdde7af4c
- https://solanatools.io/solana-trading-bot-fees
- https://www.pineconnector.com/blogs/pico-blog/backtesting-vs-live-trading-bridging-the-gap-between-strategy-and-reality
- https://referentiallabs.com/blog/backtesting-vs-paper-trading/
