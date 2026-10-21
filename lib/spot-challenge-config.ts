export const SPOT_CHALLENGE_CAPITALS = [100, 200, 500, 1000, 5000, 10000] as const;

export const SPOT_CHALLENGE_DEFAULTS = {
  feeRateBps: 4,
  successPercent: 12,
  failurePercent: 3,
  strategyRiskPercent: 1.8,
  slippageBufferPercent: 0.6,
  liquidationBufferPercent: 0.6,
  maxCapitalUsePercent: 65,
  maxSymbolPositionPercent: 15,
  maxHighVolatilityPositionPercent: 10,
  maxCorrelatedGroupPercent: 35,
  orderTtlMinutes: 180,
  modelVersion: "spot-challenge-v1",
} as const;

export type SpotChallengeStatus =
  | "DRAFT"
  | "RUNNING"
  | "CAUTION"
  | "PROTECT"
  | "REDUCE_ONLY"
  | "SUCCESS_PENDING_CLEAR"
  | "FAILURE_PENDING_CLEAR"
  | "CLEARING"
  | "SUCCEEDED"
  | "FAILED"
  | "ERROR";

export function challengeThresholds(capitalUsdt: number) {
  return {
    successEquityUsdt: capitalUsdt * 1.12,
    failureEquityUsdt: capitalUsdt * 0.97,
  };
}

export function challengeRiskConfig() {
  return {
    strategyRiskPercent: SPOT_CHALLENGE_DEFAULTS.strategyRiskPercent,
    slippageBufferPercent: SPOT_CHALLENGE_DEFAULTS.slippageBufferPercent,
    liquidationBufferPercent: SPOT_CHALLENGE_DEFAULTS.liquidationBufferPercent,
    maxCapitalUsePercent: SPOT_CHALLENGE_DEFAULTS.maxCapitalUsePercent,
    maxSymbolPositionPercent: SPOT_CHALLENGE_DEFAULTS.maxSymbolPositionPercent,
    maxHighVolatilityPositionPercent: SPOT_CHALLENGE_DEFAULTS.maxHighVolatilityPositionPercent,
    maxCorrelatedGroupPercent: SPOT_CHALLENGE_DEFAULTS.maxCorrelatedGroupPercent,
    orderTtlMinutes: SPOT_CHALLENGE_DEFAULTS.orderTtlMinutes,
    thresholds: challengeThresholds(0),
  };
}
