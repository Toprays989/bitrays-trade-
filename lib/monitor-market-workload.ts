export function resolveMonitorMarketWorkload(input: {
  triggerKinds: readonly string[];
  hasActiveNonRollingTrace: boolean;
}) {
  const rollingOnly = input.triggerKinds.length > 0 &&
    input.triggerKinds.every((kind) => kind === "THREE_MINUTE_PROBABILITY");
  return {
    rollingOnly,
    loadLiquidationBackground:
      !rollingOnly || input.hasActiveNonRollingTrace,
  };
}

export function monitorMemoryPressureBlocksAnalysis(input: {
  pressureActive: boolean;
  workload: ReturnType<typeof resolveMonitorMarketWorkload>;
}) {
  return input.pressureActive && input.workload.loadLiquidationBackground;
}
