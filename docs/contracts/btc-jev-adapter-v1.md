# btc.jev-adapter.v1 — G2-08.1

Backend library only, disabled by default. No scheduler, challenger registration,
account, endpoint, environment switch, secret, funded budget or real call is
created by this delivery. G2-08.2/3 own candidate admission and activation.
Baseline fingerprint, financial policy, ledger, exits and risk remain unchanged.
See [S2 challenger contract](btc-jev-challenger-v1.md) for candidate ownership and replay.

`apps/api/src/models/jev.ts` lives outside the pure `src/trading` boundary.
`createJevAdapter` accepts a replaceable `JevTransport` and `JevStore`. The
production store uses the existing `DatabasePool.transaction` helper. The
TypeSafe HTTP transport uses a backend `SecretValue`, pinned model, fixed HTTPS
endpoint, no redirect and **zero retries**. Injecting test HTTP automatically
sets origin `mock`. Custom transports must declare origin honestly and perform
exactly one attempt; they must not retry internally.

Input is a closed record: candidate hash, candidate direction and four observed
USD_PER_BTC6 values (close, fast/slow means, ATR). It is copied before any await
and hashed with the existing canonical fingerprint helper. The fixed versioned
question asks only about trend continuation; output is exactly
`allow | veto | abstain`, a normalized class distribution and confidence. Extra
fields, invalid distributions, model changes and malformed usage fail closed.
Confidence is not profit probability. This library cannot emit an order or
change size, direction, leverage, risk or exits. It does not establish market
freshness; the future consumer must validate eligibility and deadline again.

## Billing contract and interruption

A caller must explicitly enable the adapter, supply a versioned unexpired tariff
and separately provision a protected `btc_jev_budgets` row. No default price or
US$5 credit exists. Provisioning is an operator action under the later activation
scope and requires actual coverage, not this document. `provision_reference`
identifies that coverage without storing credentials. The row's tariff hash
must match the supplied tariff. One real provider pool is shared across all
accounts/processes/models; mock uses a separate, clearly synthetic pool.

USD6 arithmetic uses BigInt/SQL NUMERIC. Each attempt reserves
`ceil(max_billable_input_tokens * input_usd6_per_million / 1,000,000)` atomically
under the provider budget row lock, before network I/O. The cap is explicit and
at most 5,000,000 USD6 per UTC dispatch month. Committed cost includes every
pending or uncertain attempt. SQL commits before sending. Complete usage can
reduce that hold to the rounded measured cost; billing uncertainty never frees
it. A valid tariff must explicitly attest a **total billable** token upper bound
(including errors/overhead), at least 65,536, and zero output-token price. An
estimate of expected prompt tokens is insufficient. Without a supported upper
bound and covered, current tariff, keep real calls disabled. Provider tariff
violations cannot be prevented retroactively by local accounting; an unexpected
model/usage/upper-bound violation abstains and opens the persistent circuit.

The store uses database time, refuses absent/disabled budgets, expired months,
insufficient balance and deadlines outside 30 seconds or the current UTC month.
There is no automatic monthly refill or circuit reset. Three failed attempts
open the durable circuit; successful calls do not replenish this failure budget.
Unknown response billing or recovered abandoned attempts open it immediately.
These controls supplement a provider-side hard spending cap if one is available;
no provider cap was configured or verified in this delivery.

Each `(origin, request_id)` has one durable attempt and a UUID completion fence.
A retry of that ID returns abstain/duplicate; a changed fingerprint conflicts.
There is no remote idempotency assumption, automatic resend, cache hit presented
as a fresh judgment, or refund based on cancellation. New request IDs are new
reservations subject to the same shared cap. S2 must bind IDs to candidates.

Timeout/cancellation abort HTTP and settle conservatively. A transport that
ignores abort can resolve or reject late; handlers consume that completion but
cannot revise the receipt, decision or charge. A response that reaches storage
after the deadline also abstains. On process failure, pending charges remain
reserved; the next new reservation recovers expired attempts as uncertain and
opens the circuit. Rollover is prohibited while attempts remain pending. A lost
COMMIT acknowledgement returns `storage_error` and never initiates a compensating
resend/refund. Operator reconciliation must use actual billing evidence; it is
not implemented as an automatic rearm or release in S1.

`btc_jev_calls.result` records adapter/prompt/model/tariff identity, prompt/input
hashes, origin, start/deadline/duration, reserved amount, measured cost or null,
usage, validated answer and failure reason. Finalized receipts are immutable.
A pending record conservatively says `recovered_uncertain`; `finished_at IS NULL`
distinguishes it. Duration measures adapter elapsed time through response
handling, including reservation; it is not a provider latency assertion. S2 additionally persists the full input, exact bounded successful HTTP body,
body hash and original receipt time, including malformed/unknown-cost evidence.
Candidate replay/admission is specified in the S2 contract. Error bodies and credentials are never
logged or persisted. Zero cost on a pre-dispatch refusal is distinguishable from
unknown potentially incurred cost (`null`) after an attempt.

## External reference and validation

Official references checked 2026-09-26:
[HTTP contract](https://docs.typesafe.ai/api),
[models/billing](https://docs.typesafe.ai/models). At that check the documented
pinned model was `jev-1.13.0`, the input price was US$0.042/Mtoken, output free,
and the request context maximum was 64k tokens. Those facts are not a purchased
balance, permanent tariff guarantee or authorization to send. Revalidate before
any real activation. Direct HTTP needs no new SDK or lockfile change.

All fixtures are declared mocks. Unit tests cover wire validation, unexpected
fields, billing unknown, transport errors, timeout/late completion, cancellation,
input mutation, deadlines and default-off behavior. PostgreSQL tests use a
disposable database and the production transaction helper to exercise concurrent
reservations at the ceiling, unknown cost, durable circuit, idempotency,
rollback, recovery and immutable finalization. Production deploy selects only
API and migration 0044, preserving the collector and other services. No trading
account or budget is seeded by that migration.
