# BTC metrics v1 — G2-09.2

`accountMetrics` in `apps/api/src/storage/metrics.ts` is the reusable read-only
projection for the next API/panel slice. It validates an immutable captured replay
artifact first. No strategy execution, SQL, model call, writes, timer or raw scan.
No new schema. CLI in the API image:

```sh
node dist/btc-metrics-cli.js version
node dist/btc-metrics-cli.js report < request.json
```

The request contains `baseline: ReplayArtifact`, optional `challenger`, optional
`allocation: CostAllocation`, optional `comparison: EconomicComparison`, and up
to eight `references: ReferenceInput[]`. Export an existing pin with the replay
CLI; wrap the artifact as `baseline`. An absent challenger is a valid report.
The stdin bound is two 16 MiB replay artifacts plus 2 MiB. Each artifact inherits
the replay limits and fidelity checks. Financial processing is bounded by 4096
events. It neither resolves external references nor claims their audit; the
replay `input_audit` is propagated unchanged.

## Financial window and formulas

Only inception to captured cut is supported in v1. Ledger covers the **whole
account**, irrespective of selected decisions. Decision/veto/AI capture counts
cover only that selection. UTC ISO timestamps with milliseconds are mandatory.
Amounts use integer strings, USD6/BTC8; ratios are signed ppm with floor division.

- Trading realized net = realized PnL + signed fees + signed funding. Reservations
  are not expenses. Final net includes unrealized PnL only when known: v1 exposes
  final net for flat accounts; open positions return null, never a current mark
  masquerading as historical equity.
- Return = trading net / initial capital. Nonpositive denominator yields null.
  Capital transfers are excluded from profit and disable the simple return and
  capital-normalized turnover (no unimplemented time-weighted claim).
- Drawdown = maximum prior peak minus equity; percentage uses that positive
  peak. It can exceed 100%; nonpositive peaks have no percentage. Missing equity
  invalidates drawdown. Account v1 provides it only when never exposed, at committed
  ledger transaction boundaries, removing capital flows. Any intratrade exposure
  makes it unavailable even if later closed. No fabricated historical marks.
- Exposure is the UTC duration with any nonzero position divided by window
  duration, using economic fill times; hedge positions do not cancel. Nonmonotonic
  economic fill timestamps make exposure unknown, without reordering the ledger.
- Turnover is the sum of absolute fill notionals, both opening and closing legs;
  USD14 products aggregate before USD6 floor. Dividing by initial capital gives
  the reported multiple. Liquidation markers do not duplicate their recorded fill.
- Funding follows immutable ledger amounts (paper approximation, not venue oracle).
  Arrival determines availability; occurred-at determines the UTC cost day. Late
  funding never rewrites an earlier captured cut. Missing upstream funding/history
  is not certified complete by a zero ledger total.

## Operational cost ownership

`btc.cost-allocation.v1` declares exactly the report window, `complete: true`, a
nonempty accounting basis, and bills identified uniquely. Each bill is AI or
infrastructure and contains the full total plus explicit account shares. Shares
must be nonnegative and sum exactly to the bill total; duplicates are rejected.
Use the same allocation document for both accounts. No budget/reservation is a
realized invoice. Omission means unknown; explicit complete empty bills means
known zero under the supplied attestation, not independently audited billing.

After-operational net = trading net minus this account's AI and infrastructure
shares exactly once. Captured real Jev costs are informational subtotals of unique
origin/request IDs in selected decisions, **not another debit**. Unknown attempted
costs remain explicit. Mock costs are not real charges. Missing Jev does not prove
zero account-wide AI expense. Allocation hash/basis are carried into the report.

## References and comparison

Cash (0%), spot (25%/100%), and perpetual (25%/100%) references are individually
reported, never summed. For fixed quantity, BTC8 quantity is initial capital ×
exposure / initial price rounded down, and gross PnL is quantity × price change.
Fees and funding are explicit signed amounts; spot/cash funding must be zero;
unknown perpetual funding or fees makes net unknown. Cash assumes no interest.
No rebalancing or unprovided financing/slippage assumption. Endpoint prices need
their exact UTC observation time and evidence ID; missing data stays null. These
are supplied observations, not an external audit. CLI requires the same window
and capital as the baseline. There is no reference drawdown without a price path.

`btc.economic-comparison.v1` explicitly binds baseline/challenger dataset IDs and
declares shared market dataset and each risk-manifest hash. Different accounts
are required, with identical window, instrument and accounting contract versions;
code/strategy/experiment-manifest differences must be enumerated explicitly.
Different risk or capital yields side-by-side results and no delta. Otherwise net
deltas are observational, never causal filter attribution. Operational delta uses
the same complete allocation request; no summing the scenarios. The manifest's
market/risk identities are caller declarations, not independently audited data.
`requireSameReplayDataset` remains the stricter identity check for reproducing
one captured replay and is not the economic comparison contract.

Filter veto counts require final successful captured Jev outcomes, separate real
from mock, deduplicate requests, and distinguish generic baseline rejection states.
They do not mean avoided losses. Same bar decisions form market clusters across
accounts; even distinct bars are not claimed statistically independent. Independent
sample size and causal contribution remain null. No lookahead, counterfactual fills,
loss exclusions, statistical significance or 7/30-day maturity claim is inferred.
