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


## Paged window extension — G2-14.4

`btc.replay.paged.v1` adds a separate `btc.replay-manifest.v1` export. The v1/v2
commands, IDs, hashes and financial meanings remain supported. No migration or
continuous replay worker is added. This BTC runner needs no JEV access or new
provider call; any existing response is copied with its original state/origin.

`capture-window ACCOUNT START END` records an explicit UTC window, aligned to
15 minutes, at most 30 days, within the financial lifetime and no later than the
actual capture. A window is a reporting selection, not a prospective experiment
registration or proof of coverage. Its ledger and reservations retain the entire
bounded prefix from genesis to snapshot, including old positions and obligations.
An account exceeding the total bounds is refused; no invented opening state,
truncation, dropped funding or reset of capital is permitted.

Capture uses one REPEATABLE READ transaction, the existing retention/account lock
order, a 30-second total work limit, 5-second SQL and 2-second lock limits. Source
cursors fetch 16 rows at a time; JSON size is checked on the server before transfer.
Evidence batches stay within 16 MiB. All immutable pages, manifest, source edges
and final pin commit together. Failure/restart before commit rolls back everything.
After commit, restart **export of the same dataset ID**; a new capture is a new cut.
No exported database snapshot or mutable cursor survives the transaction. Decisions/responses are selected by bar end in (START, END]; equity samples by observed time in [START, END]. Financial roots and their older dependencies remain retained. Original response arrival times still belong to the captured snapshot, not an assertion that every response was available by END.

Pages have a snapshot hash, sequential index, stream, offset and their own content
hash. The manifest binds their order, hashes, counts, bytes, financial high waters,
identity, code SHA, contracts and window. Offline verification rejects missing,
repeated, reordered, altered and mixed pages before yielding any report. Cross-page
transactions and reservations are reconstructed globally, not settled per page.

Limits are **256 rows / 1 MiB per page**, **2,048 pages**, **64 MiB total encoded
pages**, 65,536 rows per financial/observation stream, 4,096 decisions/responses,
65,536 evidence objects/references and graph depth 32. The manifest is at most
1 MiB; an indivisible row too large for a page is refused. Internal assembly is
bounded by the total size; this is not an unlimited streaming archive. The legacy
16 MiB/4,096-row/256-decision export remains unchanged. Dense actual histories may
still exceed the new finite envelope and must report the specific failed bound.

Equity verification hashes canonical prefixes incrementally and carries the same
ledger/cost-basis reducers forward; the former repeated-prefix work ceiling is
replaced by bounded linear event processing. Financial amounts, hashes and USD14
rounding remain identical. A global drawdown uses one ordered curve and carries
its peak; percentages and chunk drawdowns are never summed. Incomplete samples
leave the complete maximum null and expose only the observed lower bound. Absent
marks remain unknown for open exposure. Five-minute coverage, 15-minute window
count and independent economic observations are distinct; intrabar extrema and
independent sample size remain unknown.

The `window` report includes opening/closing financial state and held reserves,
external flows, exact ledger incidences in **(START, END]**, prior obligations and
late funding IDs. Net PnL requires equity at both exact boundaries and subtracts
external flows. Top-level financials retain genesis-to-snapshot semantics; events
received after END do not change window incidence. Reserve remains a hold and
slippage remains in actual fill prices. No causal attribution is added.

Reference mode pins the original transitive source graph through root pages;
it does not copy the raw archive. `window-evidence` resolves one declared embedded
or retained reference by page index, timestamp and producer hash when present.
Unverified raw dependencies and truly missing inputs retain their explicit status.

### Commands and capacity

- `capture-window ACCOUNT START END`: returns only the pinned manifest.
- `manifest DATASET_ID`: retrieve that immutable manifest again.
- `page DATASET_ID INDEX`: retrieve one exact page, safely repeatable after restart.
- `window-evidence DATASET_ID PAGE_INDEX OBJECT_ID`: resolve a declared reference.
- `replay-window DIRECTORY`: offline; reads `manifest.json` and `0.json`, `1.json`,
  etc., one bounded file at a time, then validates the complete set.

Capture reserves 128 MiB below the existing 6 GiB logical / 4 GiB physical replay
worker ceilings and checks the existing 25% disk floor plus 1 GiB reserve. It does
not relax HOLD, quotas, pins, collection admission, RAM/capital caps or budget.
The large CLI capture also requires an existing-capacity, isolated Linux cgroup
with a finite memory limit of 768 MiB–1 GiB; it refuses the serving API's 384 MiB
container or an unlimited host. No container/service is provisioned automatically.
Preflight host RAM/CPU/WAL/filesystem and current protected source volume before
running an ephemeral job; the total host RAM budget stays below 13 GiB. Offline
large replay should likewise run in an isolated bounded process. Oversized work
may fail safely at a resource bound; the volume cap is not a memory guarantee.

The disposable corpus covers 2,880 synthetic decisions, 8,641 five-minute equity
observations and 6,005 ledger events, with transfers, fills, fee and late funding.
It is a correctness/resource fixture, not production coverage, trading performance,
a billing receipt or proof of 90-day sustainability. Production capture remains
conditional on current capacity and the existing total US$80/month budget; unknown
coverage of billing is not zero cost.
