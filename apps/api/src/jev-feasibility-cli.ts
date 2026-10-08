import { readFile } from "node:fs/promises";
import {
  estimateJevFeasibility,
  type JevCorpusSample,
} from "./storage/jev-feasibility.js";
/** Offline estimator only. No app config/secret/transport import, no writes. */
const [path, logical, allocated, ...extra] = process.argv.slice(2);
if (!path || !logical || !allocated || extra.length)
  throw new Error(
    "Usage: jev-feasibility <fixture-sample.json> <baseline-logical-bytes> <baseline-allocated-bytes>",
  );
const value = JSON.parse(await readFile(path, "utf8")) as
  JevCorpusSample | { sample: JevCorpusSample };
console.log(
  JSON.stringify(
    estimateJevFeasibility(
      "sample" in value ? value.sample : value,
      logical,
      allocated,
    ),
    null,
    2,
  ),
);
