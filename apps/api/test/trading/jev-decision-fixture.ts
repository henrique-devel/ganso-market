import { buildJevContext } from "../../src/storage/jev-context.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { contextFixture } from "./jev-context-fixture.js";
import { jevIdentity } from "./jev-v2-fixture.js";
import {
  buildJevBatch,
  type JevBatch,
} from "../../src/models/jev-decision-contract.js";
export function decisionFixture(at?: number) {
  const f = contextFixture(),
    stress = jevIdentity("stress");
  stress.bindings[0]!.profile.manifest_hash =
    f.identity.bindings[0]!.profile.manifest_hash;
  // Move every origin timestamp equally, preserving bars/windows and source ages.
  const delta =
    at === undefined
      ? 0
      : Math.floor((at - (f.cut % 900000)) / 900000) * 900000 +
        (f.cut % 900000) -
        f.cut;
  const input = JSON.parse(
    JSON.stringify(f.input).replace(
      /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g,
      (s) => new Date(Date.parse(s) + delta).toISOString(),
    ),
  ) as typeof f.input;
  for (const r of [
    input.account,
    input.book!,
    input.mark_funding!,
    ...input.trades,
    ...input.bars,
    input.coverage!,
  ])
    r.payload_hash = jevHash(r.payload);
  const accountInput = structuredClone(input);
  accountInput.account.object_id = "account:stress";
  accountInput.account.payload.scope = jevScope(
    stress.bindings[0]!.binding,
    stress.instrument,
  );
  accountInput.account.payload.position = {
    position_id: "position:stress",
    direction: "short",
    quantity_btc_raw: "1000",
    entry_price_raw: "101000000",
    stop_price_raw: "110000000",
    first_fill_at: input.cut_at,
  };
  accountInput.account.payload_hash = jevHash(accountInput.account.payload);
  const contexts = [
    buildJevContext(f.manifest, f.identity, input),
    buildJevContext(f.manifest, stress, accountInput),
  ];
  const batch = buildJevBatch({
    request_id: "request:1",
    purpose: "operation",
    proposal_id: null,
    manifest: f.manifest,
    model: "jev-1.13.0",
    cut_at: input.cut_at,
    deadline_at: new Date(Date.parse(input.cut_at) + 1500).toISOString(),
    participants: contexts.map((context, i) => ({
      context_id: `context:${i}`,
      context,
    })),
  });
  return { ...f, stress, input, accountInput, batch };
}
const choice = <T extends string>(value: T, options: T[], confidence = 1) => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: Object.fromEntries(
    options.map((k) => [k, k === value ? 1 : 0]),
  ),
});
export function decisionResponse(batch: JevBatch) {
  return {
    model: batch.model,
    usage: { input_tokens: 1000, output_tokens: 100 },
    answers: Object.fromEntries(
      batch.participants.flatMap((p, i) => [
        [
          `a${i}_direction`,
          choice(p.context.account!.position?.direction ?? "long", [
            "long",
            "short",
          ]),
        ],
        [
          `a${i}_intent`,
          choice(p.context.account!.position ? "close" : "open", [
            "open",
            "hold",
            "close",
          ]),
        ],
      ]),
    ),
  };
}
