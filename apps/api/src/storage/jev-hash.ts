import { createHash } from "node:crypto";
import { assertEvidenceJson } from "../trading/retention.js";
import { canonicalFingerprint } from "../trading/replay.js";
export const jevHash = (value: unknown) => {
  assertEvidenceJson(value);
  return createHash("sha256").update(canonicalFingerprint(value)).digest("hex");
};
