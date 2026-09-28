# btc.jev-challenger.v1 — G2-08.2

Backend composition, **disabled by default**. G2-08.2 installed no scheduler,
registration, account/genesis, activation switch, credential or funded budget.
G2-08.3 adds prospective registration, the existing API scheduler and authenticated
observability; see [operational activation](../runbooks/btc-jev-activation.md).
No account, credential or funded budget is created at startup. Each paper
account starts independently with USD6 1000000000; scenarios must never be summed.
The optional consumer cannot enable itself from a key or from an existing budget.
The proposed US$5/month is not available credit or spending authorization.

## Shared candidate and independent eligibility

New baseline decisions retain an account-independent `signal` before account
eligibility: source bars and hashes, 15-minute boundary, policy/manifest/instrument
versions, direction, close, SMA4/12 and ATR14. The hash excludes account identity,
cash and local account clocks. A paused or positioned baseline can still record
this exogenous signal. Historical decisions remain immutable; a record without
the signal cannot be retrofitted into an eligible Jev candidate.

`createChallengerConsumer` reads that exact immutable baseline decision and pins
its evidence graph. It does not reread changed bars to manufacture a different
candidate. The same frozen baseline policy evaluates the challenger's own ledger,
funding, metadata, positions, reservations, pause and risk. Ineligible accounts
record their own reasons with no model call. There is no requirement that the
baseline itself admitted an order. Policy sizing runs against the independent
account **before Jev**; differing cash can produce a different eligible quantity
or refusal, not an artificially paired trade. That proposal's quantity, direction,
price protection and stop are then immutable. Jev cannot size, extend a deadline,
change exits, rearm risk or create capital. ATR stop and six hours from first fill
continue through the existing baseline exit manager.

The entry deadline is the original source decision time + 5s. Challenger decision
latency is still 1000ms and execution still needs a later observed book. Waiting
for Jev consumes that existing window; it never grants a fresh five seconds.

## Ownership, cost and replay

Migration 0045 adds an immutable request envelope per `(account, bar_end_at)`.
It binds the source decision, independent proposal, full input, question,
prompt/model/adapter/origin identity, input hash, deadline and recovery fence.
The request ID derives from the account, exogenous signal hash and model/prompt
versions. First committed input wins. Revisions/config changes cannot send a
second request for that candidate.

A single `prepared -> dispatching` claim commits before the existing adapter
reserves its maximum charge. HTTP runs outside all SQL, retention and account
locks. Every call uses the existing persistent budget/reservation/circuit; cache
never bypasses its accounting. A lost claim COMMIT acknowledgement sends nothing;
a lost reservation COMMIT acknowledgement sends nothing and retains uncertain
cost. A process restart never resends `dispatching`. After deadline it records
an uncertain abstention, preserving any adapter receipt already committed.
There is no automatic refund, retry, circuit reset or model fallback.

The adapter now retains the exact bounded successful HTTP body, including its
original whitespace, plus body hash, full typed input/hash and receipt time.
Malformed/unknown-cost bodies remain evidence but cannot authorize an entry.
HTTP error bodies, headers and credentials are not persisted. Test transports
are explicitly `mock`; object fixtures are serialized once at receipt. Late
completions are ignored and cannot revise the original receipt or reserved cost.
`readChallengerReplay` reads source, proposal, original adapter receipt and final
admission from storage only. It never reconsults the provider or emits an order.

Acceptance requires a durable matching adapter receipt, `allow`, known measured
cost, matching identity/input/deadline, receipt and commit before deadline, and
unchanged recovery fence/registration. Under the account fence, existing policy
and IOC broker revalidate market, intention, risk, collateral and reservations.
Receipt evidence, admission and terminal request outcome commit together. Lost
acknowledgement cannot replay admission. Completed requests cannot be modified,
deleted or truncated, and retention pins protect their input graph.

## Consumer and delivery boundary

`tick()` manages active orders/positions first and launches at most one pending
model attempt without awaiting HTTP. Later ticks continue exit/risk management.
`drain()`/`stop()` are shutdown/testing operations, not heartbeat operations.
Funding accepts the registered challenger purpose through the same existing
reconciliation function. G2-08.3 wires that consumer and funding into an explicitly registered account.
The frozen binding and real coverage are checked again at final admission;
revocation blocks entry without refunding an already incurred or uncertain cost.

Deployment classification is **API + additive migration only**, preserving the
collector and other running services. No test writes production trading records.
Validation uses explicit MOCK responses with the real adapter, SQL cost store,
recovery fences, risk and broker on disposable PostgreSQL. This integration does
not establish model accuracy, live profitability, or availability of paid credit.

## Prospective common window — G2-14.3

New activations require `window: {start_at, end_at, purpose}` in the operator CLI
input. They persist `btc.jev-comparison.v2` with a `btc.comparison-window.v1`
evaluation and `btc.baseline-registration.v2` **for the new challenger only**.
The latter allows an explicitly selected future UTC 15-minute boundary instead
of forcing the next boundary. Original unversioned registrations, their genesis,
and v1 reports retain their original semantics; no upgrade/backfill is performed.

Registration precedes `comparison_start_at`; end is fixed simultaneously, aligned
to 15 minutes and at most 30 days later. `economic_evaluation` requires exactly
30 days; a shorter original-period remainder is `operational_pilot`. The source
registration and, when applicable, a G2-13.3 successor are pinned dependencies.
The source period must cover the **entire** interval, and an economic window
cannot use an operational-pilot successor. Neither the CLI nor the report extends
entry eligibility, resets capital, rearms risk, enables a budget or calls Jev.
A retry with different dates/purpose conflicts; an old v1 registration cannot be
retrofitted with a comparison selected after observing results. Gates still apply
at activation, dispatch and admission; the v2 end blocks entries, while existing
funding, risk and exits keep managing old obligations.

`btc.economic-comparison.v2` keeps the v1 dataset/risk/market hashes and declared
version differences, and adds `registration_evidence_id`. Dates are resolved from
the immutable **captured challenger registration**, not from HTTP query dates.
Reference-mode exports embed the source registration and selected period as well.
Both artifacts must cover the fixed end and have compatible instrument/replay
contracts; older v1 economic comparison continues to require equal starts.
Authenticated `GET /api/trading/experiments` returns `btc.experiments.v2` for the
v2 comparison (and v1 for previous requests); unsupported/missing evidence remains
`not_comparable`, never a fabricated delta. Pure offline entrypoint:
`compareWindowArtifacts(baselineArtifact, challengerArtifact, contract, allocation?)`.

The window report reconstructs opening and closing ledger/reservation prefixes,
including hashes, original financial starts, positions with cost basis, active
reservations, equity/mark quality and original genesis persistence time. Prefixes
end at committed transaction boundaries. Opening includes records known at start;
window attribution is **(start, end] by recorded time**, with each economic timestamp
preserved. A newly born account uses its single contractual genesis as opening
endowment even if its first tick persists it later; that time is disclosed. No
other late event is moved backwards, and no missing market mark is synthesized.
Marks available at each boundary are independently revalidated at that boundary;
a later fresh mark cannot price the earlier opening.

Window PnL = closing equity − opening equity − external flows received in the
window. Realized PnL, fees, funding and change in unrealized PnL are also separate;
closing an old position does not count its pre-window unrealized gain twice.
Late old funding/fees received within the window are included once and identified
as prior obligations. Events received after end remain in the captured account
history and disclosed count; they do not rewrite this as-of result or forgive the
obligation. Reservations are state, not expense; fill prices already include
slippage. Operational bills must allocate exactly this window; absent bills or
marks are unknown. Even offsetting external flows disable a simple return/delta.

Different opening capital/equity, risk, exposure or reservations produce labeled
side-by-side results with no delta. Otherwise the numerical delta is observational;
causal filter contribution is always null. Export AND registered code/policy/
manifest differences must be declared. Risk/market hashes remain declarations,
not an external audit. No account balances or scenario results are summed.

This delivery adds no producer, migration or admission. Existing 4096-row,
4096-observation, 16-MiB and equity-prefix-work limits continue to refuse overflow;
G2-14.4 must cover longer windows with bounded cuts. Window drawdown/coverage are
not inferred from the inception report or two endpoints. G2-17 must assess gaps
and full coverage separately; a pilot is never promoted to a 30-day evaluation.

O escopo vigente de28/09 adia JEV: a publicação deste contrato não seleciona
G2-15 nem torna comparação com IA requisito de aceite BTC.
