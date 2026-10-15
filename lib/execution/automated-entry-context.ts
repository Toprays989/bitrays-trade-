import type {
  StrategyExecutionDirection,
} from "../strategy-execution-direction.ts";

export const AUTOMATED_ENTRY_EXECUTION_CONTEXT_VERSION =
  "automated-entry-execution-context-v1" as const;

export function buildAutomatedEntryDirectionEvidence(
  direction: StrategyExecutionDirection,
) {
  return {
    brainDecisionDirection: direction.brainDirection,
    tradeDirection: direction.tradeDirection,
    executionDirection: direction,
    inverseStrategySample: direction.inverted,
    learningIsolation: direction.inverted
      ? "INDEPENDENT_INVERSE_STRATEGY" as const
      : "STANDARD_STRATEGY" as const,
  };
}

export type BinanceRestCapacityMetrics = {
  projectRemainingWeight?: number | null;
  hardLimitPerMinute?: number | null;
  localEstimatedWeight?: number | null;
};

export function projectRemainingRestWeight(
  rest: BinanceRestCapacityMetrics | null | undefined,
) {
  const direct = Number(rest?.projectRemainingWeight);
  if (Number.isFinite(direct)) return Math.max(0, direct);
  const hardLimit = Number(rest?.hardLimitPerMinute);
  const localWeight = Number(rest?.localEstimatedWeight);
  return Number.isFinite(hardLimit) && Number.isFinite(localWeight)
    ? Math.max(0, hardLimit - localWeight)
    : Number.NaN;
}

export function evaluateAutomatedEntryRestCapacity(input: {
  rest: BinanceRestCapacityMetrics | null | undefined;
  requiredRemainingWeight: number;
}) {
  const remainingRestWeight = projectRemainingRestWeight(input.rest);
  const requiredRemainingWeight = Math.max(
    0,
    Number(input.requiredRemainingWeight),
  );
  return {
    version: AUTOMATED_ENTRY_EXECUTION_CONTEXT_VERSION,
    allowed:
      Number.isFinite(remainingRestWeight) &&
      Number.isFinite(requiredRemainingWeight) &&
      remainingRestWeight >= requiredRemainingWeight,
    remainingRestWeight: Number.isFinite(remainingRestWeight)
      ? remainingRestWeight
      : null,
    requiredRemainingWeight: Number.isFinite(requiredRemainingWeight)
      ? requiredRemainingWeight
      : null,
  };
}
