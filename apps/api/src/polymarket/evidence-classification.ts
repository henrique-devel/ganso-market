/**
 * DATA-02: auditable, read-only sentinel classification. Consumers opt in in
 * their own blocks; this module does not change historical rows or metrics.
 * A token-only row must resolve its condition before this rule can include it.
 */
export const EVIDENCE_CLASSIFICATION_VERSION = "data-02-synthetic-v1";

export interface EvidenceIdentity {
  readonly conditionId?: string | null;
}

export type EvidenceClassificationReason =
  | "SYNTHETIC_SENTINEL_0XSONDA"
  | "MISSING_CONDITION_ID"
  | "CONDITION_ID_NOT_SENTINEL";

export interface EvidenceClassification {
  readonly version: typeof EVIDENCE_CLASSIFICATION_VERSION;
  readonly classification: "synthetic" | "unknown" | "not_sentinel";
  readonly reason: EvidenceClassificationReason;
  /** Eligibility under this rule alone, not proof of any other metric gate. */
  readonly eligibleForMetrics: boolean;
}

export function classifyEvidence(
  identity: EvidenceIdentity,
): EvidenceClassification {
  if (identity.conditionId === "0xsonda") {
    return {
      version: EVIDENCE_CLASSIFICATION_VERSION,
      classification: "synthetic",
      reason: "SYNTHETIC_SENTINEL_0XSONDA",
      eligibleForMetrics: false,
    };
  }
  if (
    identity.conditionId === undefined ||
    identity.conditionId === null ||
    identity.conditionId.trim().length === 0
  ) {
    return {
      version: EVIDENCE_CLASSIFICATION_VERSION,
      classification: "unknown",
      reason: "MISSING_CONDITION_ID",
      eligibleForMetrics: false,
    };
  }
  // Exact sentinel equality only: do not normalize, use substrings, or claim
  // that a different ID proves real-world provenance beyond this narrow rule.
  return {
    version: EVIDENCE_CLASSIFICATION_VERSION,
    classification: "not_sentinel",
    reason: "CONDITION_ID_NOT_SENTINEL",
    eligibleForMetrics: true,
  };
}

export interface EvidenceClassificationReport<T extends EvidenceIdentity> {
  readonly version: typeof EVIDENCE_CLASSIFICATION_VERSION;
  readonly counts: {
    readonly total: number;
    readonly eligibleForMetrics: number;
    readonly excludedSynthetic: number;
    readonly excludedUnknown: number;
  };
  readonly reasonCounts: Readonly<Record<EvidenceClassificationReason, number>>;
  readonly entries: readonly {
    readonly input: T;
    readonly classification: EvidenceClassification;
  }[];
}

/** Preserve all inputs, including exclusions, alongside their audit reason. */
export function classifyEvidenceRows<T extends EvidenceIdentity>(
  inputs: readonly T[],
): EvidenceClassificationReport<T> {
  const reasonCounts: Record<EvidenceClassificationReason, number> = {
    SYNTHETIC_SENTINEL_0XSONDA: 0,
    MISSING_CONDITION_ID: 0,
    CONDITION_ID_NOT_SENTINEL: 0,
  };
  const entries = inputs.map((input) => {
    const classification = classifyEvidence(input);
    reasonCounts[classification.reason] += 1;
    return { input, classification };
  });
  return {
    version: EVIDENCE_CLASSIFICATION_VERSION,
    counts: {
      total: inputs.length,
      eligibleForMetrics: reasonCounts.CONDITION_ID_NOT_SENTINEL,
      excludedSynthetic: reasonCounts.SYNTHETIC_SENTINEL_0XSONDA,
      excludedUnknown: reasonCounts.MISSING_CONDITION_ID,
    },
    reasonCounts,
    entries,
  };
}
