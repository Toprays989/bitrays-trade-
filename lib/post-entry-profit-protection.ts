export type PostEntryProfitProtection = {
  armed: boolean;
  feeCoveredFloorRoePercent: number | null;
  configuredTrailingFloorRoePercent: number | null;
  effectiveFloorRoePercent: number | null;
  hit: boolean;
  reason: string;
};

/**
 * Once a real partial take profit has executed, never let the remainder turn
 * into a fee-negative round trip.  The floor is deliberately based on a
 * conservative round-trip notional cost and leverage, not on an optimistic
 * zero-fee breakeven.
 */
export function postFirstTakeProfitProtection(input: {
  leverage: number;
  completedTakeProfitLevels: number;
  realizedPnlUsdt: number;
  currentRoePercent: number;
  configuredTrailingFloorRoePercent: number | null;
  estimatedRoundTripCostRatePercent?: number;
  extraBufferRoePercent?: number;
}): PostEntryProfitProtection {
  if (
    input.completedTakeProfitLevels <= 0 ||
    !Number.isFinite(input.realizedPnlUsdt) ||
    input.realizedPnlUsdt <= 0 ||
    !Number.isFinite(input.currentRoePercent)
  )
    return {
      armed: false,
      feeCoveredFloorRoePercent: null,
      configuredTrailingFloorRoePercent:
        finite(input.configuredTrailingFloorRoePercent),
      effectiveFloorRoePercent: null,
      hit: false,
      reason:
        input.completedTakeProfitLevels > 0 &&
        Number.isFinite(input.realizedPnlUsdt) &&
        input.realizedPnlUsdt <= 0
          ? "分批减仓实际净收益未盈利，禁止把亏损减仓当作止盈启动保本保护。"
          : "尚无真实盈利的分批止盈成交，保本保护未启动。",
    };
  const leverage = Math.max(1, finite(input.leverage) ?? 1);
  const roundTripCostRatePercent = Math.max(
    0,
    finite(input.estimatedRoundTripCostRatePercent) ?? 0.1,
  );
  const extraBufferRoePercent = Math.max(
    0,
    finite(input.extraBufferRoePercent) ?? 0.1,
  );
  const feeCoveredFloorRoePercent =
    roundTripCostRatePercent * leverage + extraBufferRoePercent;
  const configuredTrailingFloorRoePercent =
    finite(input.configuredTrailingFloorRoePercent);
  const effectiveFloorRoePercent = Math.max(
    feeCoveredFloorRoePercent,
    configuredTrailingFloorRoePercent ?? Number.NEGATIVE_INFINITY,
  );
  const hit = input.currentRoePercent <= effectiveFloorRoePercent;
  return {
    armed: true,
    feeCoveredFloorRoePercent,
    configuredTrailingFloorRoePercent,
    effectiveFloorRoePercent,
    hit,
    reason: hit
      ? `首档止盈后ROE回落至费用覆盖保护线 ${effectiveFloorRoePercent.toFixed(2)}%，保护剩余仓位。`
      : `首档止盈后剩余仓位保护线为 ${effectiveFloorRoePercent.toFixed(2)}% ROE。`,
  };
}

function finite(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
