export const THREE_MINUTE_OBSERVE_ONLY_SHADOW_RESULT_CODE =
  "THREE_MINUTE_OBSERVE_ONLY_SHADOW" as const;

export const THREE_MINUTE_OBSERVE_ONLY_CAUSAL_EVIDENCE =
  "THREE_MINUTE_OBSERVE_ONLY_CAUSAL" as const;

export function isThreeMinuteObserveOnlyShadowTrace(
  resultCode: string | null | undefined,
) {
  return resultCode === THREE_MINUTE_OBSERVE_ONLY_SHADOW_RESULT_CODE;
}

export function threeMinuteShadowNetRoeEstimate(input: {
  grossRoePercent: number;
  leverage: number;
  estimatedCostBps: number;
}) {
  if (
    !Number.isFinite(input.grossRoePercent) ||
    !Number.isFinite(input.leverage) ||
    input.leverage <= 0 ||
    !Number.isFinite(input.estimatedCostBps) ||
    input.estimatedCostBps < 0
  ) return null;
  return input.grossRoePercent - input.estimatedCostBps * input.leverage / 100;
}

export type ThreeMinuteShadowOutcome = {
  selectedProbabilityPercent: number;
  netEdgeBps: number;
  estimatedNetRoePercent: number;
};

export function summarizeThreeMinuteShadowOutcomes(
  rows: readonly ThreeMinuteShadowOutcome[],
) {
  const samples = rows.filter((row) =>
    Number.isFinite(row.selectedProbabilityPercent) &&
    Number.isFinite(row.netEdgeBps) &&
    Number.isFinite(row.estimatedNetRoePercent)
  );
  if (!samples.length) return null;
  const wins = samples.filter((row) => row.estimatedNetRoePercent > 0).length;
  const estimatedNetRoeTotal = samples.reduce(
    (sum, row) => sum + row.estimatedNetRoePercent,
    0,
  );
  return Object.freeze({
    sampleCount: samples.length,
    wins,
    losses: samples.length - wins,
    winRatePercent: wins / samples.length * 100,
    meanEstimatedNetRoePercent: estimatedNetRoeTotal / samples.length,
    averageSelectedProbabilityPercent: samples.reduce(
      (sum, row) => sum + row.selectedProbabilityPercent,
      0,
    ) / samples.length,
    averageNetEdgeBps: samples.reduce(
      (sum, row) => sum + row.netEdgeBps,
      0,
    ) / samples.length,
    exactNetAvailable: false,
    orderAffecting: false,
  });
}
