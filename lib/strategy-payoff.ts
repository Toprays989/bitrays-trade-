export type StrategyTakeProfitStep = {
  profitPercent: number;
  closePercent: number;
};

export function strategyPayoffProfile(input: {
  stopLossRoePercent: number;
  takeProfitSteps: StrategyTakeProfitStep[];
  leverage: number;
  estimatedRoundTripFeePercent?: number;
}) {
  const stopLoss = Number(input.stopLossRoePercent);
  const leverage = Number(input.leverage);
  const roundTripFeePercent = Number(input.estimatedRoundTripFeePercent ?? 0.08);
  if (
    !Number.isFinite(stopLoss) || stopLoss <= 0 ||
    !Number.isFinite(leverage) || leverage <= 0 ||
    !Number.isFinite(roundTripFeePercent) || roundTripFeePercent < 0
  ) return null;

  let remainingPercent = 100;
  let configuredClosePercent = 0;
  let grossRewardRoePercent = 0;
  for (const step of input.takeProfitSteps) {
    if (remainingPercent <= 0) break;
    const profitPercent = Number(step.profitPercent);
    const closePercent = Number(step.closePercent);
    if (!Number.isFinite(profitPercent) || profitPercent <= 0 ||
        !Number.isFinite(closePercent) || closePercent <= 0) continue;
    const allocatedPercent = Math.min(remainingPercent, closePercent);
    grossRewardRoePercent += profitPercent * allocatedPercent / 100;
    configuredClosePercent += allocatedPercent;
    remainingPercent -= allocatedPercent;
  }

  const estimatedFeeRoePercent = roundTripFeePercent * leverage;
  const netRewardRoePercent = grossRewardRoePercent - estimatedFeeRoePercent;
  const netLossRoePercent = stopLoss + estimatedFeeRoePercent;
  const completeExitConfigured = configuredClosePercent >= 100 - 1e-8;
  const netRiskRewardRatio = completeExitConfigured && netRewardRoePercent > 0
    ? netRewardRoePercent / netLossRoePercent
    : null;
  const breakEvenWinRatePercent = netRiskRewardRatio === null
    ? null
    : netLossRoePercent / (netLossRoePercent + netRewardRoePercent) * 100;

  return {
    configuredClosePercent,
    completeExitConfigured,
    grossRewardRoePercent,
    estimatedRoundTripFeePercent: roundTripFeePercent,
    estimatedFeeRoePercent,
    netRewardRoePercent,
    netLossRoePercent,
    netRiskRewardRatio,
    breakEvenWinRatePercent,
  };
}

export function hasCompleteNetProfitPath(
  profile: {
    completeExitConfigured?: unknown;
    netRiskRewardRatio?: unknown;
    breakEvenWinRatePercent?: unknown;
  } | null | undefined,
) {
  if (!profile || profile.completeExitConfigured !== true) return false;
  const netRiskRewardRatio = Number(profile.netRiskRewardRatio);
  const breakEvenWinRatePercent = Number(profile.breakEvenWinRatePercent);
  return (
    Number.isFinite(netRiskRewardRatio) &&
    netRiskRewardRatio > 0 &&
    Number.isFinite(breakEvenWinRatePercent) &&
    breakEvenWinRatePercent > 0 &&
    breakEvenWinRatePercent < 100
  );
}

export function executableRiskPlanPayoffProfile(input: {
  totalQuantity: number;
  takeProfits: Array<{
    triggerPercent: number;
    closeQuantity: number;
  }>;
  stopLossRoePercent: number;
  leverage: number;
  estimatedRoundTripFeePercent?: number;
}) {
  const totalQuantity = Number(input.totalQuantity);
  if (!Number.isFinite(totalQuantity) || totalQuantity <= 0) return null;
  return strategyPayoffProfile({
    stopLossRoePercent: input.stopLossRoePercent,
    takeProfitSteps: input.takeProfits.map((step) => ({
      profitPercent: Number(step.triggerPercent),
      closePercent:
        Number(step.closeQuantity) / totalQuantity * 100,
    })),
    leverage: input.leverage,
    estimatedRoundTripFeePercent: input.estimatedRoundTripFeePercent,
  });
}
