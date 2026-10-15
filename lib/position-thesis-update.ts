export const POSITION_THESIS_UPDATE_VERSION = "position-thesis-update-v1" as const;

type JsonRecord = Record<string, unknown>;

export type PositionThesisOutlook =
  | "IMPROVING"
  | "POSITIVE_STABLE"
  | "DETERIORATING"
  | "INVALIDATED"
  | "UNAVAILABLE";

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value: number | null) {
  return value === null ? null : Math.round(value * 1_000) / 1_000;
}

/**
 * Produces a comparable economic update for one position observation.
 *
 * The entry posterior is a frozen reference, not a newly learned probability.
 * This record therefore explains whether the remaining payoff geometry and
 * structure improved or deteriorated, but it never authorizes an order or an
 * exit by itself. Deterministic protection and structure evidence remain the
 * only execution authorities.
 */
export function buildPositionThesisUpdate(input: {
  observedAtMs: number;
  currentRoePercent: number;
  bestRoePercent: number;
  worstRoePercent: number;
  entryThesis?: unknown;
  entryNetExpectancy?: unknown;
  thesisStatus: "STABLE" | "WATCH" | "INVALIDATED" | "UNAVAILABLE";
  managementState: string;
  managementAction: string;
  evidenceComplete: boolean;
}) {
  const entryThesis = record(input.entryThesis);
  const thesisProfitability = record(entryThesis?.profitability);
  const netExpectancy = record(input.entryNetExpectancy);
  const source = netExpectancy ?? thesisProfitability;
  const entryProbabilityPercent = finite(
    source?.posteriorWinProbabilityPercent,
  );
  const expectedProfitRoePercent = finite(
    source?.expectedProfitRoePercent,
  );
  const expectedLossRoePercent = finite(
    source?.expectedLossRoePercent,
  );
  const entryNetExpectancyRoePercent = finite(
    source?.netExpectancyRoePercent,
  );
  const feeCostRoePercent = Math.max(
    0,
    finite(source?.feeCostRoePercent) ?? 0,
  );
  const slippageCostRoePercent = Math.max(
    0,
    finite(source?.slippageCostRoePercent) ?? 0,
  );
  const currentRoePercent = finite(input.currentRoePercent) ?? 0;
  const completeEconomicInputs =
    entryProbabilityPercent !== null &&
    expectedProfitRoePercent !== null &&
    expectedLossRoePercent !== null;
  const probability = completeEconomicInputs
    ? Math.max(0, Math.min(1, entryProbabilityPercent / 100))
    : null;
  const remainingRewardRoePercent = completeEconomicInputs
    ? Math.max(0, expectedProfitRoePercent - currentRoePercent)
    : null;
  const remainingRiskRoePercent = completeEconomicInputs
    ? Math.max(0, expectedLossRoePercent + currentRoePercent)
    : null;
  const conservativeRemainingCostRoePercent = completeEconomicInputs
    ? feeCostRoePercent + slippageCostRoePercent
    : null;
  const referenceRemainingNetExpectancyRoePercent =
    probability !== null &&
      remainingRewardRoePercent !== null &&
      remainingRiskRoePercent !== null &&
      conservativeRemainingCostRoePercent !== null
      ? probability * remainingRewardRoePercent -
        (1 - probability) * remainingRiskRoePercent -
        conservativeRemainingCostRoePercent
      : null;
  const breakEvenContinuationProbabilityPercent =
    remainingRewardRoePercent !== null &&
      remainingRiskRoePercent !== null &&
      conservativeRemainingCostRoePercent !== null &&
      remainingRewardRoePercent + remainingRiskRoePercent > 0
      ? Math.min(
          100,
          Math.max(
            0,
            (remainingRiskRoePercent + conservativeRemainingCostRoePercent) /
              (remainingRewardRoePercent + remainingRiskRoePercent) * 100,
          ),
        )
      : null;
  const deltaFromEntryNetExpectancyRoePercent =
    referenceRemainingNetExpectancyRoePercent !== null &&
      entryNetExpectancyRoePercent !== null
      ? referenceRemainingNetExpectancyRoePercent -
        entryNetExpectancyRoePercent
      : null;

  let outlook: PositionThesisOutlook = "UNAVAILABLE";
  if (input.thesisStatus === "INVALIDATED" || input.managementState === "TREND_INVALIDATED")
    outlook = "INVALIDATED";
  else if (
    input.thesisStatus === "WATCH" ||
    input.managementState === "PROFIT_PROTECT" ||
    input.managementState === "EVIDENCE_DEGRADING" ||
    input.managementAction === "REDUCE_RISK_BY_EVIDENCE" ||
    input.managementAction === "EXIT_OR_REDUCE_BY_RISK_PLAN" ||
    (referenceRemainingNetExpectancyRoePercent !== null &&
      referenceRemainingNetExpectancyRoePercent <= 0)
  ) outlook = "DETERIORATING";
  else if (
    input.evidenceComplete &&
    referenceRemainingNetExpectancyRoePercent !== null &&
    deltaFromEntryNetExpectancyRoePercent !== null &&
    deltaFromEntryNetExpectancyRoePercent > 0.25
  ) outlook = "IMPROVING";
  else if (
    input.evidenceComplete &&
    referenceRemainingNetExpectancyRoePercent !== null
  ) outlook = "POSITIVE_STABLE";

  return {
    schemaVersion: POSITION_THESIS_UPDATE_VERSION,
    observedAtMs: input.observedAtMs,
    executionAuthorizing: false as const,
    probabilitySource: entryProbabilityPercent === null
      ? "UNAVAILABLE" as const
      : "FROZEN_ENTRY_POSTERIOR_REFERENCE" as const,
    probabilityRecalibrated: false as const,
    thesisStatus: input.thesisStatus,
    evidenceComplete: input.evidenceComplete,
    managementState: input.managementState,
    managementAction: input.managementAction,
    outlook,
    currentRoePercent: rounded(currentRoePercent),
    bestRoePercent: rounded(finite(input.bestRoePercent)),
    worstRoePercent: rounded(finite(input.worstRoePercent)),
    entryEconomics: {
      posteriorWinProbabilityPercent: rounded(entryProbabilityPercent),
      expectedProfitRoePercent: rounded(expectedProfitRoePercent),
      expectedLossRoePercent: rounded(expectedLossRoePercent),
      feeCostRoePercent: rounded(feeCostRoePercent),
      slippageCostRoePercent: rounded(slippageCostRoePercent),
      netExpectancyRoePercent: rounded(entryNetExpectancyRoePercent),
    },
    remainingEconomics: {
      rewardRoePercent: rounded(remainingRewardRoePercent),
      riskRoePercent: rounded(remainingRiskRoePercent),
      conservativeCostRoePercent: rounded(
        conservativeRemainingCostRoePercent,
      ),
      breakEvenContinuationProbabilityPercent: rounded(
        breakEvenContinuationProbabilityPercent,
      ),
      referenceNetExpectancyRoePercent: rounded(
        referenceRemainingNetExpectancyRoePercent,
      ),
      deltaFromEntryNetExpectancyRoePercent: rounded(
        deltaFromEntryNetExpectancyRoePercent,
      ),
    },
  };
}
