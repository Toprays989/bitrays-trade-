export type BinanceRestCapacitySnapshot = {
  localEstimatedWeight?: number;
  effectiveUsedWeight?: number;
  admissionLimitPerMinute?: number;
  observationEstimatedWeight?: number;
  observationWeightLimitPerMinute?: number;
  observationRemainingWeight?: number;
  binanceObservedWeight?: number;
  globalObservationPauseWeight?: number;
};

export function binanceAnalysisCapacity(input: {
  rest?: BinanceRestCapacitySnapshot | null;
  weightPerSymbol: number;
  configuredMaxSymbols: number;
  /**
   * Keep low-priority broad-market scans from consuming the execution and
   * position-management headroom. This is a runtime traffic reserve only; it
   * does not change any strategy signal, direction or entry condition.
   */
  reservedWeight?: number;
}) {
  const partitionedObservationWeight = Number(
    input.rest?.observationEstimatedWeight,
  );
  const hasPartitionedBudget = Number.isFinite(partitionedObservationWeight);
  const localUsedWeight = Number(input.rest?.localEstimatedWeight);
  const usedWeight = hasPartitionedBudget
    ? partitionedObservationWeight
    : Number.isFinite(localUsedWeight)
      ? localUsedWeight
      : Number(input.rest?.effectiveUsedWeight);
  const admissionLimit = hasPartitionedBudget
    ? Number(input.rest?.observationWeightLimitPerMinute)
    : Number(input.rest?.admissionLimitPerMinute);
  const weightPerSymbol = Math.max(1, Math.trunc(input.weightPerSymbol));
  const configuredMaxSymbols = Math.max(
    0,
    Math.trunc(input.configuredMaxSymbols),
  );
  const reservedWeight = Math.max(
    0,
    Math.trunc(Number(input.reservedWeight) || 0),
  );
  const available =
    Number.isFinite(usedWeight) &&
    usedWeight >= 0 &&
    Number.isFinite(admissionLimit) &&
    admissionLimit > 0;
  const observedGlobalWeight = Number(input.rest?.binanceObservedWeight);
  const globalObservationLimit = Number(
    input.rest?.globalObservationPauseWeight,
  );
  const globalRemaining =
    hasPartitionedBudget &&
    Number.isFinite(observedGlobalWeight) &&
    Number.isFinite(globalObservationLimit)
      ? Math.max(0, globalObservationLimit - observedGlobalWeight)
      : Number.POSITIVE_INFINITY;
  const effectiveReserve = hasPartitionedBudget ? 0 : reservedWeight;
  const remainingAnalysisWeight = available
    ? Math.max(
        0,
        Math.min(
          Math.floor(admissionLimit - usedWeight - effectiveReserve),
          Math.floor(globalRemaining),
        ),
      )
    : 0;
  return {
    available,
    usedWeight: available ? usedWeight : null,
    admissionLimit: available ? admissionLimit : null,
    remainingAnalysisWeight,
    maxSymbols: available
      ? Math.min(
          configuredMaxSymbols,
          Math.floor(remainingAnalysisWeight / weightPerSymbol),
        )
      : 0,
  };
}
