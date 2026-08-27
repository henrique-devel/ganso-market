import { describe, expect, it } from "vitest";

import {
  approvalRecord,
  checkApproval,
  type GateReportSummary,
} from "../../../src/polymarket/portfolio/approval.js";
import {
  CALIBRATED_EXPECTATION,
  MIN_REVIEW_NOTE_LENGTH,
} from "../../../src/polymarket/portfolio/gates.js";

const REVIEW =
  "Li o relatório inteiro, incluindo a expectativa calibrada, e aceito a " +
  "evidência registrada como suficiente para esta decisão.";

const ALL_PASS: GateReportSummary = {
  reportId: 7,
  overallStatus: "READY_FOR_OWNER_REVIEW",
  gates: [
    { gate: "G1", status: "PASS" },
    { gate: "G2", status: "PASS" },
    { gate: "G3", status: "PASS" },
    { gate: "G4", status: "PASS" },
    { gate: "G5", status: "PASS" },
    { gate: "G6", status: "INSUFFICIENT_DATA" },
  ],
  alreadyApproved: false,
};

const REQUEST = {
  reportId: 7,
  reviewer: "owner",
  note: REVIEW,
  acknowledgedExpectation: true,
};

function check(
  overrides: {
    report?: GateReportSummary | null;
    currentReportId?: number | null;
    request?: Partial<typeof REQUEST>;
  } = {},
) {
  return checkApproval({
    request: { ...REQUEST, ...overrides.request },
    report: overrides.report === undefined ? ALL_PASS : overrides.report,
    currentReportId:
      overrides.currentReportId === undefined ? 7 : overrides.currentReportId,
  });
}

describe("G6 approval — what may be recorded", () => {
  it("accepts a written review of the current, all-PASS report", () => {
    expect(check()).toEqual({ ok: true });
  });

  it("refuses a report that does not exist", () => {
    const result = check({ report: null });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasonCode).toBe("REPORT_NOT_FOUND");
  });

  it("refuses a review of anything but the CURRENT report", () => {
    // The engine mints a new report the moment any verdict changes, so a stale
    // id means the numbers moved. Approving them anyway would be approving
    // something that is no longer on the table.
    const result = check({ currentReportId: 9 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasonCode).toBe("REPORT_NOT_CURRENT");
  });

  it("refuses when no report exists at all", () => {
    const result = check({ currentReportId: null });
    expect(result.ok === false && result.reasonCode).toBe("REPORT_NOT_CURRENT");
  });

  it("refuses to overwrite an approval already on record", () => {
    const result = check({
      report: { ...ALL_PASS, alreadyApproved: true },
    });
    expect(result.ok === false && result.reasonCode).toBe(
      "REPORT_ALREADY_APPROVED",
    );
  });

  it("refuses to approve a report whose measured gates are not all PASS", () => {
    // "Nunca afrouxar o gate na mesma config" — least of all in advance. A
    // signature banked against numbers that have not happened yet is a gate
    // waiting for the arithmetic to catch up to it.
    const result = check({
      report: {
        ...ALL_PASS,
        overallStatus: "BLOCKED",
        gates: ALL_PASS.gates.map((gate) =>
          gate.gate === "G2"
            ? { gate: gate.gate, status: "INSUFFICIENT_DATA" as const }
            : gate,
        ),
      },
    });
    expect(result.ok === false && result.reasonCode).toBe("GATES_NOT_READY");
    expect(result.ok === false && result.detail).toContain(
      "G2:INSUFFICIENT_DATA",
    );
  });

  it("does NOT hold G6's own status against the approval being written", () => {
    // G6 is INSUFFICIENT_DATA precisely because this review does not exist yet.
    expect(check().ok).toBe(true);
  });

  it("refuses a signature with no written record behind it", () => {
    const result = check({ request: { note: "ok" } });
    expect(result.ok === false && result.reasonCode).toBe("EMPTY_NOTE");
    expect(REVIEW.length).toBeGreaterThanOrEqual(MIN_REVIEW_NOTE_LENGTH);
  });

  it("refuses whitespace dressed as a review", () => {
    const result = check({ request: { note: " ".repeat(200) } });
    expect(result.ok === false && result.reasonCode).toBe("EMPTY_NOTE");
  });

  it("refuses an unnamed reviewer", () => {
    expect(check({ request: { reviewer: "" } }).ok).toBe(false);
    const injected = check({ request: { reviewer: "owner; DROP TABLE" } });
    expect(injected.ok === false && injected.reasonCode).toBe(
      "INVALID_REVIEWER",
    );
  });

  it("refuses until the calibrated expectation is acknowledged explicitly", () => {
    // The RFC requires the expectation printed on the report so nobody reads a
    // row of PASSes as a promise. Requiring it back makes that bite.
    const result = check({ request: { acknowledgedExpectation: false } });
    expect(result.ok === false && result.reasonCode).toBe(
      "EXPECTATION_NOT_ACKNOWLEDGED",
    );
    expect(result.ok === false && result.detail).toContain("84%");
  });
});

describe("G6 approval — what gets written", () => {
  it("records the reviewer, the instant, the trimmed note and the expectation", () => {
    const reviewedAt = new Date("2026-09-01T10:00:00Z");
    const record = approvalRecord({
      request: { ...REQUEST, note: `  ${REVIEW}  ` },
      reviewedAt,
    });
    expect(record).toEqual({
      reviewed_at: "2026-09-01T10:00:00.000Z",
      reviewer: "owner",
      note: REVIEW,
      acknowledged_expectation: CALIBRATED_EXPECTATION,
    });
  });
});
