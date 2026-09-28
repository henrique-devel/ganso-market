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
side-by-side metrics with a reason and no delta. Costs without an allocation remain unknown. The original GET has no billing
body; G2-14.5 adds a private read-only POST calculation below.

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

## Observed curve and drawdown — G2-14.2

New captures use `btc.replay.captured.v2` and the required
`btc.replay-equity.v1` extension; reports use `btc.metrics.v2`. Readers still
accept unmodified v1 artifacts and keep their original null fields/results.
The CLI version response lists both supported report versions. Older binaries
must not read v2 captures; rollback keeps this reader when v2 artifacts exist.
No migration, new producer, historical rewrite or production admission is added.

The bounded capture includes all persisted observations visible at its snapshot
(up to 4096, failing rather than truncating), their context and capture evidence,
also in reference mode. The existing 16 MiB, object, time and financial prefix
bounds remain. This is not the multi-cut export of G2-14.4. A missing slot remains
missing. New roots/dependencies are charged and pinned under existing gates;
this delivery does not establish capacity or authorize capture in production.

Offline replay verifies each observation's account/inception, ordered unique
five-minute slot, timestamp, immutable ledger/reservation prefix hashes, complete
transaction boundary and recomputed financial values. Verification refuses more
than 262,144 cumulative prefix events (ledger plus reservations), bounding CPU
work even when many samples share long prefixes. It uses the embedded mark
and capture at the observation time; missing evidence fails verification, while
an explicitly unavailable mark retains null equity. Reservations are holds, not
expenses; slippage is already in actual fill prices. Late funding affects only
prefixes that contain it, retaining the earlier observations unchanged.

The curve reports actual observation times, equity, unrealized PnL and equity
minus cumulative external flows. Drawdown includes the verified initial allocation as its opening anchor and
uses the adjusted samples, USD6 differences and
positive-peak ppm; zero/negative equity is preserved and loss may exceed 100%.
Simple returns remain null when external flows exist (no time-weighted return
claim). Operational bills remain separate and unknown without allocation.

Coverage counts slots from unchanged financial inception through capture cut,
including the partial first/last slots. Any absent or unavailable slot makes the
full-window drawdown incomplete/null. `observed_max_usd_raw` and
`observed_max_ppm` retain lower bounds from known samples, including across gaps;
they are not a complete-window maximum. Even complete slot coverage observes only
the sample cadence, never the intrabar extreme (`intrabar_extreme: null`).
No interpolation, resampling or removal of prior losses is performed.

Final open PnL is recomputed from the final ledger using the latest observation's
embedded mark/capture **at the final cut**, with the existing freshness and gap
checks. A stale terminal mark returns null even if the last stored sample was
valid. A closed account needs no mark. This read makes no SQL/provider calls,
creates no financial activity and confers no risk authorization. API and CLI use
the same projection. Pilot/evaluation periods do not reset financial inception.


## Costs, references and evaluation panel — G2-14.5

The existing authenticated `/trading/experiments` path additionally accepts POST
with the same query selection as GET and a **32 KiB private JSON body**. This is
an ephemeral calculation: it uses only the bounded READ ONLY pool, does not store
inputs, mutate ledger/pins, create a capture, invoke AI or query prices/providers.
The bearer session and no-store policy remain mandatory. Unsupported methods and
unknown routes remain closed. Inputs are not URL parameters or request-log fields.
Do not supply invoice documents, credentials, customer identifiers or private
billing details. Keep the operator's source records outside Git. There is no new
migration, collector, model activation, capital allocation or cost commitment.

`btc.evaluation-input.v1` accepts optional `allocation` (the existing complete
cost-allocation v1 contract) and `references`. Unknown fields, incomplete
attestations, duplicate bills/owners/references, negative shares, nonconserving
allocations, unsupported versions and mismatched windows/capital fail explicitly.
Limits: 64 bills, 32 shares per bill, eight references, and the overall body bound.
The hash of the complete input and allocation basis identify the exact calculation;
changing a cost changes the hash, never historical ledger or older reports.
Omitting allocation is unknown. An explicit complete empty bill list is an
operator attestation of zero, **not** independent proof of billing completeness.
Reserved model credit, mock costs and captured real model subtotals are not
additional debits. JEV remains deferred and unnecessary for BTC evaluation.

A synthetic example (USD6 strings, not a real invoice):

```json
{
  "schema_version": "btc.evaluation-input.v1",
  "allocation": {
    "schema_version": "btc.cost-allocation.v1",
    "window": {"start":"2026-09-01T00:00:00.000Z","end":"2026-09-02T00:00:00.000Z"},
    "complete": true,
    "basis": "Synthetic settled infrastructure cost for this exact interval",
    "bills": [{"id":"opaque-example-1","kind":"infrastructure","total_usd_raw":"2000000",
      "shares":[{"account_id":"baseline","usd_raw":"2000000"}]}]
  },
  "references": [{
    "kind":"perpetual","exposure_bps":2500,"capital_usd_raw":"1000000000",
    "window":{"start":"2026-09-01T00:00:00.000Z","end":"2026-09-02T00:00:00.000Z"},
    "prices":null,"fees_usd_raw":null,"funding_usd_raw":null,
    "source":"Historical BTC perpetual observations unavailable",
    "fee_basis":null,"funding_basis":null
  }]
}
```

Each supplied reference additionally requires `source`, `fee_basis` and
`funding_basis` (the latter two are null exactly when that cost is unknown).
Endpoint prices carry their observation times and evidence IDs as in v1. These
are supplied observations, never automatically fetched or independently audited.
The baseline's exact window and initial window capital are required; in common
window v2 this is **opening equity**, not an invented new genesis. Cash defaults
to the explicit no-interest/no-transaction assumption. The passive BTC perpetual
25% comparator defaults to unknown price/fee/funding until supplied; it never
silently substitutes spot or current prices. Optional spot stays in a separate
row. Benchmark trading net includes signed fees/funding, not infrastructure/AI;
no causal delta against a strategy with different risk/exposure is inferred.
Unknown or nonpositive opening equity leaves reference capital unavailable.

The panel supports both inception metrics and persisted common-window metrics,
showing original financial starts, boundary equity/positions/reservations, open
PnL, prior obligations, window-scoped observed curves/drawdown and differences
in risk/capital/exposure. Window drawdown is complete only with all exact
five-minute boundary slots; observed lower bounds include known boundary values
and preserve gaps. No curve bridges missing observations. Neither coverage nor
zero-trade results establish maturity or operational readiness. G2-13.1 system
telemetry remains available, with no new polling or provider calls.

### Paged windows and offline full evaluation

`experiment-datasets?kind=window` lists immutable paged-window IDs separately by
indexed keyset (50/page). GET `experiments?account_id=...&dataset_id=btc-replay-window:...`
returns `btc.paged-coverage.v1`: validated manifest window/counts, page count and
bytes. Optional `page=N` verifies exactly one page's hash and reports its stream
and row count. Financial metrics remain null: a manifest or one page is not a
complete replay. The API never assembles the 64 MiB dataset in its serving budget.
Allocation/comparison input is rejected for this manifest-only route.

After exporting the immutable manifest and every `N.json` page with the existing
replay CLI, run in an isolated offline environment with adequate memory:

```sh
node dist/btc-metrics-cli.js report-window /private/export-directory < /private/evaluation-input.json > /private/evaluation-report.json
# Without cost/reference inputs: use an empty stdin, and costs remain unknown.
```

The CLI enforces bounded files, validates every page and the full replay before
emitting `btc.paged-evaluation.v1`. Missing/corrupt/reordered pages fail; no partial
metric escapes. Window PnL/flows and drawdown are from the global replay, never a
sum of page returns. Operational allocation is applied once for the complete
window. The CLI uses no database/provider; it does not create a productive export.
The existing `report` action also accepts the persisted v2 comparison contract.

Open the resulting report via **Abrir avaliação de replay completo** in the panel.
The file stays in browser memory (maximum 8 MiB); there is no server upload or
persistent storage. Import validates structure, account and numeric values,
**not** the original replay or the producer's authenticity. It is visibly labelled
operator-supplied offline output. Keep the verified export and input alongside it
for reproduction. This separation is intentional: increasing serving-API memory,
creating productive captures or claiming that an imported file was server-audited
are outside this delivery. Fees/infrastructure remain unknown without inputs.

Rollout affects API/web and the exact gateway method rule only. Preserve existing
schema/pins and leave collection/equity admissions and paid consumption unchanged.
Rollback may restore the prior API/web/gateway together; no schema downgrade or
financial rewrite is needed. Production invoice completeness, current capacity,
source freshness and full operational/economic acceptance remain independent.
