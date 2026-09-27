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
SHA, reducer versions, all captured outputs and the declared evidence profile
(embedded closure or immutable pinned references). Registration evidence includes original policy/code/manifest/contract;
market evidence includes original source/parser/build versions and timestamps.
Financial values retain USD6, BTC8, USD_PER_BTC6 and USD14 cost basis.
Canonical JSON sorts object keys, preserves array order and accepts finite
nonfinancial JSON numbers (including captured Jev probabilities). Monetary
amounts still pass the existing decimal-string/unit validators; raw model
response bytes remain captured verbatim in their original response fields.

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

A bounded explicit decision selection is also supported. `decision_selection`
records either `all` or the exact requested IDs; unknown/duplicate IDs fail.
Financial streams still cover the whole account from genesis to snapshot. Their
PnL must not be attributed to only the selected decisions. Execution/financial
dependencies remain complete even if they reference unselected decisions. This
mode avoids silently truncating a large history; any selected closure that still
exceeds a bound is refused without increasing limits. Original v1 exports without
the selection field mean `all`.

### Reference manifest for large raw closures

`capture-references` explicitly stores a reference manifest within the same
16 MiB cap. It embeds the selected decisions and registrations, full financial
streams and captured Jev outcomes. Every present decision input and financial
root is a direct dataset dependency; the existing SQL graph/pins protect all
transitive dependencies without loading/copying the raw closure. The manifest
records original `recorded_at` and producer hashes where the decision provided
them. Other immutable financial roots expose `payload_hash: null` until resolved.

Replay declares `evidence_mode: references`, the number of retained inputs not
embedded, and `input_audit: resolve_retained_inputs_to_verify_payload_hash_and_source_time`.
That is metadata/as-of validation, not a claim that external raw payloads have
been independently audited offline. Truly absent inputs remain missing. The
`evidence` CLI resolves one declared root/input, verifies timestamp and any
producer hash, and returns the payload, digest and dependency IDs. It never
contacts the venue/model. Transitive raw closure stays in the pinned source;
this manifest is not a self-contained raw-data archive or backup.

Embedded mode retains its full closure checks/depth limit. Reference mode bounds
manifest roots to 16,384 and each evidence resolution to 16 MiB, with the existing
SQL budgets. Both modes hash their declarations and refuse implicit comparisons.

## On-demand CLI (workdir `/workspace/apps/api` inside the deployed API)

- `node dist/btc-replay-cli.js version`: inspect runner/contracts/limits, no DB.
- `node dist/btc-replay-cli.js capture baseline`: capture and pin one dataset;
  stdout is the product JSON export, not an administrative evidence report.
- `node dist/btc-replay-cli.js capture baseline <decision-id> [<decision-id> ...]`:
  explicitly capture only those decision outputs, keeping the full account ledger.
- `node dist/btc-replay-cli.js capture-references baseline <decision-id>`:
  retain a declared reference manifest when embedding the raw tree is too large.
- `node dist/btc-replay-cli.js evidence <dataset-id> <object-id>`:
  resolve one declared root/input, under the same byte/SQL bounds.
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
