import { describe, expect, it } from "vitest";

import {
  classifyEvidence,
  classifyEvidenceRows,
  EVIDENCE_CLASSIFICATION_VERSION,
} from "../../src/polymarket/evidence-classification.js";

describe("DATA-02 synthetic evidence classification", () => {
  it("excludes the exact sentinel with a version and a reason", () => {
    expect(classifyEvidence({ conditionId: "0xsonda" })).toEqual({
      version: "data-02-synthetic-v1",
      classification: "synthetic",
      reason: "SYNTHETIC_SENTINEL_0XSONDA",
      eligibleForMetrics: false,
    });
  });

  it("keeps missing identity unknown and outside the eligible metric set", () => {
    for (const identity of [
      {},
      { conditionId: null },
      { conditionId: "" },
      { conditionId: " \n " },
    ]) {
      expect(classifyEvidence(identity)).toMatchObject({
        classification: "unknown",
        reason: "MISSING_CONDITION_ID",
        eligibleForMetrics: false,
      });
    }
  });

  it("does not invent aliases or classify arbitrary IDs as the sentinel", () => {
    for (const conditionId of [
      "0xabc123",
      "0xsonda-other",
      "prefix-0xsonda",
      "0xSONDA",
      " 0xsonda ",
    ]) {
      expect(classifyEvidence({ conditionId })).toMatchObject({
        classification: "not_sentinel",
        reason: "CONDITION_ID_NOT_SENTINEL",
        eligibleForMetrics: true,
      });
    }
  });

  it("reconciles exclusions separately and retains every original input", () => {
    const inputs = Object.freeze([
      Object.freeze({ eventId: "a", conditionId: "0xsonda" }),
      Object.freeze({ eventId: "b", conditionId: "0xabc123" }),
      Object.freeze({ eventId: "c", conditionId: null, tokenId: "0xsonda" }),
      Object.freeze({ eventId: "d", conditionId: "0xsonda" }),
    ]);
    const report = classifyEvidenceRows(inputs);
    expect(report.version).toBe(EVIDENCE_CLASSIFICATION_VERSION);
    expect(report.counts).toEqual({
      total: 4,
      eligibleForMetrics: 1,
      excludedSynthetic: 2,
      excludedUnknown: 1,
    });
    expect(report.reasonCounts).toEqual({
      SYNTHETIC_SENTINEL_0XSONDA: 2,
      MISSING_CONDITION_ID: 1,
      CONDITION_ID_NOT_SENTINEL: 1,
    });
    expect(report.entries.map((entry) => entry.input)).toEqual(inputs);
    for (let i = 0; i < inputs.length; i += 1) {
      expect(report.entries[i]?.input).toBe(inputs[i]);
    }
    expect(classifyEvidenceRows(inputs)).toEqual(report);
  });

  it("reports an empty input explicitly without inferring production counts", () => {
    expect(classifyEvidenceRows([]).counts).toEqual({
      total: 0,
      eligibleForMetrics: 0,
      excludedSynthetic: 0,
      excludedUnknown: 0,
    });
  });
});
