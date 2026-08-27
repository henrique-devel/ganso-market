// RFC-013 task 9, gate G6: registering the owner's written review.
//
// G6 is the only gate a computation cannot pass, which is exactly why it needs
// the most machinery around it. Everything here exists to make the record of a
// human decision as hard to fake, and as easy to invalidate, as the five
// measured gates:
//
//   - the review is written against a REPORT, and a report is a frozen snapshot
//     of the six verdicts. The engine mints a new one the moment any verdict
//     changes, so an approval survives exactly as long as the numbers it read;
//   - a review of anything other than the current report does not carry. Not
//     "carries with a warning" — G6 goes back to INSUFFICIENT_DATA;
//   - a report can be approved once. Changing your mind means new numbers, and
//     new numbers mean a new report;
//   - the other five gates must already be PASS. Approving a BLOCKED report is
//     a signature waiting for the arithmetic to catch up to it, and the RFC's
//     rule is that a failed gate is never "afrouxado" — least of all in
//     advance;
//   - the written record has to exist, and the calibrated expectation has to be
//     acknowledged explicitly. The RFC requires that expectation to be printed
//     on the report precisely so nobody reads a row of PASSes as a promise.
//
// None of this can make a human review good. It can only make sure that what is
// on record is a review of the numbers actually on the table.

import { CALIBRATED_EXPECTATION, MIN_REVIEW_NOTE_LENGTH } from "./gates.js";
import type { GateId, GateStatus } from "./types.js";

/** The frozen snapshot a review is written against. */
export interface GateReportSummary {
  readonly reportId: number;
  readonly overallStatus: "BLOCKED" | "READY_FOR_OWNER_REVIEW";
  readonly gates: readonly {
    readonly gate: GateId;
    readonly status: GateStatus;
  }[];
  readonly alreadyApproved: boolean;
}

export interface ApprovalRequest {
  readonly reportId: number;
  readonly reviewer: string;
  readonly note: string;
  /** The owner typed back the calibrated expectation acknowledgement. */
  readonly acknowledgedExpectation: boolean;
}

export type ApprovalCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reasonCode: string;
      readonly detail: string;
    };

const REVIEWER_PATTERN = /^[\w][\w.@-]{0,63}$/;

/**
 * Decide whether an approval may be recorded, and say precisely why not.
 *
 * A pure function on purpose: the CLI does IO, this does the refusing, and the
 * refusing is what the tests are about.
 */
export function checkApproval(input: {
  readonly request: ApprovalRequest;
  readonly report: GateReportSummary | null;
  readonly currentReportId: number | null;
}): ApprovalCheck {
  if (input.report === null) {
    return {
      ok: false,
      reasonCode: "REPORT_NOT_FOUND",
      detail: `no gate report with id ${String(input.request.reportId)}`,
    };
  }
  if (
    input.currentReportId === null ||
    input.report.reportId !== input.currentReportId
  ) {
    return {
      ok: false,
      reasonCode: "REPORT_NOT_CURRENT",
      detail:
        `report ${String(input.report.reportId)} is not the current one ` +
        `(${String(input.currentReportId)}): the numbers moved since it was ` +
        "generated, so a review of it is a review of something else",
    };
  }
  if (input.report.alreadyApproved) {
    return {
      ok: false,
      reasonCode: "REPORT_ALREADY_APPROVED",
      detail:
        `report ${String(input.report.reportId)} already carries a written ` +
        "review; an approval is not edited in place",
    };
  }
  const notPassing = input.report.gates
    .filter((entry) => entry.gate !== "G6" && entry.status !== "PASS")
    .map((entry) => `${entry.gate}:${entry.status}`);
  if (notPassing.length > 0) {
    return {
      ok: false,
      reasonCode: "GATES_NOT_READY",
      detail:
        "the measured gates are not all PASS, so there is nothing for a " +
        `review to unlock: ${notPassing.join(", ")}`,
    };
  }
  if (!REVIEWER_PATTERN.test(input.request.reviewer)) {
    return {
      ok: false,
      reasonCode: "INVALID_REVIEWER",
      detail: "reviewer must be 1-64 chars of [A-Za-z0-9_.@-]",
    };
  }
  if (input.request.note.trim().length < MIN_REVIEW_NOTE_LENGTH) {
    return {
      ok: false,
      reasonCode: "EMPTY_NOTE",
      detail:
        `the written review must be at least ${String(MIN_REVIEW_NOTE_LENGTH)} ` +
        "characters: G6 is the written record, not the act of approving",
    };
  }
  if (!input.request.acknowledgedExpectation) {
    return {
      ok: false,
      reasonCode: "EXPECTATION_NOT_ACKNOWLEDGED",
      detail:
        "the calibrated expectation has to be acknowledged explicitly: " +
        CALIBRATED_EXPECTATION,
    };
  }
  return { ok: true };
}

/** The JSON written into `portfolio_gate_reports.approval_json`. */
export function approvalRecord(input: {
  readonly request: ApprovalRequest;
  readonly reviewedAt: Date;
}): Record<string, unknown> {
  return {
    reviewed_at: input.reviewedAt.toISOString(),
    reviewer: input.request.reviewer,
    note: input.request.note.trim(),
    acknowledged_expectation: CALIBRATED_EXPECTATION,
  };
}
