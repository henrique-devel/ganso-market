# BTC captured replay dataset v1 — G2-09.1

`btc.replay.captured.v1` exports one finite paper account from genesis through a
locked database snapshot. This is captured-event replay: it recalculates ledger,
weighted-cost realized PnL and reservations, restores captured decisions and Jev
outcomes, and verifies their available input hashes/as-of timestamps. It does not
rerun strategy admission, invoke a current model, generate hypothetical fills or
claim an independent policy backtest. Missing historical inputs remain explicit
in per-decision fidelity; a missing dependency of a retained object is an error.

## Identity and clocks

The content-addressed `dataset_id` hashes the whole canonical payload: cut UTC,
ledger/reservation high-water sequences, immutable identity/genesis, exporter code
SHA, reducer versions, all captured outputs and the complete retained evidence
closure. Registration evidence includes original policy/code/manifest/contract;
market evidence includes original source/parser/build versions and timestamps.
Financial values retain USD6, BTC8, USD_PER_BTC6 and USD14 cost basis.

Capture uses repeatable read and the existing retention → account lock order.
Only the current snapshot can be captured; export reopens that immutable cut.
Ledger and reservation streams preserve committed sequence and recorded arrival.
Economic timestamps never reorder late funding into an earlier observed state.
Decision inputs must have been recorded/received by decision time. No global
causal order is inferred between independent streams sharing timestamps.

The funding approximation `btc.funding.paper-precut.v2` and its captured parser,
rounding, selected candidates and gaps are preserved, not recalculated against a
current provider. Open-position mark equity is not invented; replay returns cost
basis and realized financials, not zero-filled missing marks. Reserve is a hold,
not an expense. Each account retains its independent fictitious USD 1,000 genesis.

## Persistence and limits

The artifact is an immutable experiment retention object, pinned atomically with
edges to evidence roots. Existing dependency protection preserves the transitive
closure. No new migration, endpoint, timer, model call or collector is installed.
Jev request/outcome capture is snapshot-only; absent or unfinished calls are
`not_captured`/`response_missing`, and real/mock origin remains visible.

One invocation: at most 4,096 ledger/reservation/source rows per table, 256
decisions/Jev requests, 16,384 evidence objects, depth 32, 16 MiB canonical dataset,
5-second SQL statements, 2-second lock waits and a 10-second work budget. Queries
use account indexes and explicit dependency IDs, never a raw-market history scan.
Exceeding a bound fails the capture transaction without a partial pin or silent
truncation. The runner conservatively reserves 32 MiB below existing 6 GiB logical
and 4 GiB physical worker ceilings; it never increases a quota or disables HOLD.
The infrastructure's existing disk floor and resource budgets still apply.

## On-demand CLI (inside the deployed API)

- `node dist/btc-replay-cli.js version`: inspect runner/contracts/limits, no DB.
- `node dist/btc-replay-cli.js capture baseline`: capture and pin one dataset;
  stdout is the product JSON export, not an administrative evidence report.
- `node dist/btc-replay-cli.js export btc-replay:<sha256>`: load the pinned export.
- `node dist/btc-replay-cli.js replay < dataset.json`: offline replay, no DB/config.
- `node dist/btc-replay-cli.js compare < pair.json`: requires exactly two artifacts
  with identical dataset identity before returning the replay. Different cuts,
  accounts, inputs or versions fail `BTC_REPLAY_INCOMPATIBLE_DATASETS`; subsequent
  economic comparison must explicitly declare its own compatibility contract.

Capture is an explicit operator action. Re-export the ID to retry a cut; a new
capture has a new timestamp/identity. No account, event, decision, budget, risk
state, registration or funding receipt is rewritten. Baseline can be replayed
without a challenger or Jev credentials.
