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

## Authenticated panel reads — G2-09.3

The single-user desk now exposes GET-only `/trading/experiment-datasets`
(50 immutable IDs per keyset page, optional `after`), `/trading/experiments`
(required `account_id`, `dataset_id`; optional `challenger_id`, `comparison` JSON,
maximum 2048 characters per parameter), and `/trading/experiment-system`
(20 recovery accounts per page, optional `after`). Nginx publishes only these
exact paths under `/api`. All use the existing owner session and no-store.
The report loads only the explicitly selected captured artifacts, never captures,
pins, queries providers or resolves external input references. Only one report
runs per API instance at a time. A missing/invalid comparison declaration yields
side-by-side metrics with a reason and no delta. Costs without an allocation
remain unknown; this UI does not submit billing attestations.

Additive metrics fields: `equity_curve` contains timestamped observations at
committed ledger boundaries (including capital transfers), never an interpolated
price path. All observations after the first exposure are null without historical
marks, even after closing. The existing drawdown remains capital-flow adjusted.
`decisions.by_reason` counts recorded reasons in the selected decisions.

System diagnostics read the market singleton, quota counters, relation sizes and
indexed recovery heads/latest checkpoints. A capture older than 60 seconds is
labelled stale; a recent capture does not certify per-channel freshness or
continuity. Docker status/restarts and host filesystem capacity are unavailable
in this API and stay null. Worker ceilings and SQL quotas are shown separately.
Opening these screens does not restart a collector or reconcile an account.


## Persisted equity observations — G2-14.1

`btc.equity-observation.v1` is independent of the v1 report/replay artifact.
G2-14.2/4 integrate the curve and window export; existing artifacts keep their
original meaning. `verifyEquityObservation` verifies a stored cut with immutable
ledger/reservation prefixes and retained context/capture; it does not manufacture
missing observations or use current prices. No data discard is enabled.

The existing API consumer schedules at most one sampling task every five minutes,
with two sequential accounts maximum, without delaying its trading loop. No new
service, external call or paid API. Migration 0048 seeds **no admissions**.
`btc_equity_admissions` is an operational gate, not a risk permission. Production
activation is blocked by G2-12.3. A future admitted window must be prospective,
no longer than 90 days, name its approved capacity basis, and cover total logical,
physical, pinned-source and WAL costs. Removing an admission stops new samples
without deleting observations; it never rearms trading. No public write route.

Each sample belongs to the UTC five-minute slot in which it was actually taken;
`observed_at` is its actual database clock, not an invented slot-boundary mark.
Only the first committed observation per account/slot survives retries. A crash
rolls back sample, charge, edges and pin together. Restart skips elapsed slots.
No interpolation, backfill, resampling after a late cost or current-price fallback.

Knowledge is the REPEATABLE READ visible snapshot, recorded as immutable ledger
and reservation sequence prefixes plus canonical hashes. Timestamp alone does
not imply a concurrent transaction was visible/committed. The entire visible
prefix is accepted or refused (future economic/recorded events are refused),
never part of a transaction. Both prefixes are bounded to 4096 events; overflow
fails explicitly and leaves a missing slot. Later funding/fees, even with earlier
economic times, cannot change a stored cut. Ledger/reservation SQL tables are
append-only; their prefixes are retained without copying them every five minutes.

Amounts remain fixed-point USD6/BTC8. Equity = initial capital + external flows
+ realized PnL + signed fees + signed funding + marked unrealized PnL. Reservations
are separately reported holds, never debited again. Funding is the known paper
ledger approximation, not proof of complete venue settlement. Mark carries source,
receipt, freshness basis and pinned context/capture; HTTP Date is snapshot evidence,
not venue event time. Missing, stale, future or gap-affected mark gives null equity
for open positions. Flat equity needs no mark; mark quality remains explicit.

Financial inception is unchanged. A sample links the selected prospective
baseline successor (and its pilot/evaluation purpose) when present, and the
original registration. Original purpose remains unspecified rather than inferred
as an economic evaluation. Manual inception is the account experiment's start.
Sampling cannot reset a balance, shorten an original period or hide its losses.

### Capacity and rollout

The original plan reserves 491,520 B/h for two accounts × 60 × 4096 B. Actual
retention charging includes 1024 B per dependency edge; a 4096 B sample cap is
therefore insufficient. This implementation instead caps the **complete new root
charge** at 12,288 B per account/five-minute slot, refusing larger samples without
truncation. Maximum two-account root rate: 294,912 B/h; 49,545,216 B/7 days,
212,336,640 B/30 days, 637,009,920 B/90 days. This is below the plan's root reserve;
it is **not** the total storage cost or a sustainability claim.

Pinned existing mark/capture/metadata closure extends retention beyond normal raw
expiry and must be added to the admission calculation (shared dependencies only
once). Index pages, WAL, temporary work and filesystem headroom also require their
own measurement. Root writes check the 6 GiB worker logical guard, retaining the
existing SQL quotas, HOLD and pins. Fiscal coverage and filesystem admission are
external prerequisites, not inferred from the SQL guard. No production admission
is created by code, startup, migration or this delivery.

Deploy schema48 then the API, leaving admissions empty. Validate module presence,
zero observations/admissions, health, HOLD and existing service identities.
Rollback first disables admissions, then restores the previous API; keep schema48
and all observations/pins. Projection/schema46 and baseline/schema47 compatibility
requirements remain. Production remains unactivated until actual admission.

Disposable PostgreSQL fixtures (synthetic HTTP mark) measured a 5,048 B root
charge and 20,455 B complete pinned closure, including preexisting source objects.
Physical retained row sizes were about 7.3–7.7 kB and root transaction WAL about
3.9–4.5 kB in these small fixtures; neither includes a sustained-load filesystem
projection. At twelve slots/hour, two unshared fixture closures would be
490,920 B/h before other workloads; real source payloads can be larger. This is
why lower root cadence alone does not establish the 90-day storage gate.
