import { challengeThresholds, SPOT_CHALLENGE_DEFAULTS, type SpotChallengeStatus } from "./spot-challenge-config.ts";

export type SpotRiskPosition = {
  symbol: string;
  notionalUsdt: number;
  pressureLossPercent: number;
  volatility24hPercent?: number;
  correlationGroup?: string;
};

export type SpotRiskOrder = {
  symbol: string;
  reservedNotionalUsdt: number;
  pressureLossPercent: number;
  correlationGroup?: string;
};

export type SpotChallengeRiskInput = {
  capitalUsdt: number;
  equityUsdt: number;
  positions: SpotRiskPosition[];
  pendingOrders: SpotRiskOrder[];
  successProbability?: number;
  failureProbability?: number;
  stressFailureProbability?: number;
  volatility24hPercent?: number;
  websocketAgeMs?: number;
};

export type SpotChallengeRiskResult = {
  status: SpotChallengeStatus;
  netPnlUsdt: number;
  netPnlPercent: number;
  distanceToSuccessUsdt: number;
  distanceToFailureUsdt: number;
  pressureLossUsdt: number;
  riskUsedPercent: number;
  reservedNotionalUsdt: number;
  successProbability: number | null;
  failureProbability: number | null;
  stressFailureProbability: number | null;
  reasons: string[];
};

function finite(value: number | undefined | null, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function maxGroupExposure(items: Array<{ symbol: string; notionalUsdt: number; correlationGroup?: string }>) {
  const groups = new Map<string, number>();
  for (const item of items) {
    const key = item.correlationGroup || `symbol:${item.symbol}`;
    groups.set(key, (groups.get(key) || 0) + Math.max(0, finite(item.notionalUsdt)));
  }
  return Math.max(0, ...groups.values());
}

function clampProbability(value: number) {
  return Math.max(0, Math.min(1, value));
}

function dynamicProbabilities(input: {
  netPnlPercent: number;
  riskUsedPercent: number;
  volatility24hPercent?: number;
  websocketAgeMs?: number;
  status: SpotChallengeStatus;
}) {
  const volatilityPenalty = Math.max(0, finite(input.volatility24hPercent) - 4) * 0.025;
  const latencyPenalty = finite(input.websocketAgeMs) > 3_000 ? 0.18 : 0;
  const pressurePenalty = Math.max(0, input.riskUsedPercent - 1) * 0.08;
  const progress = (input.netPnlPercent + 3) / 15;
  const success = clampProbability(0.5 + progress * 0.42 - volatilityPenalty - latencyPenalty - pressurePenalty);
  const failure = clampProbability(0.5 - progress * 0.42 + volatilityPenalty + latencyPenalty + pressurePenalty);
  const stressFailure = clampProbability(failure + volatilityPenalty * 0.6 + (input.status === "PROTECT" || input.status === "REDUCE_ONLY" ? 0.12 : 0));
  return { success, failure, stressFailure };
}

export function evaluateSpotChallengeRisk(input: SpotChallengeRiskInput): SpotChallengeRiskResult {
  const capital = Math.max(0, finite(input.capitalUsdt));
  const equity = Math.max(0, finite(input.equityUsdt));
  const thresholds = challengeThresholds(capital);
  const netPnlUsdt = equity - capital;
  const netPnlPercent = capital > 0 ? (netPnlUsdt / capital) * 100 : 0;
  const pressureLossUsdt = [
    ...input.positions.map((item) => Math.max(0, finite(item.notionalUsdt)) * Math.max(0, finite(item.pressureLossPercent)) / 100),
    ...input.pendingOrders.map((item) => Math.max(0, finite(item.reservedNotionalUsdt)) * Math.max(0, finite(item.pressureLossPercent)) / 100),
  ].reduce((sum, value) => sum + value, 0);
  const reservedNotionalUsdt = input.positions.reduce((sum, item) => sum + Math.max(0, finite(item.notionalUsdt)), 0)
    + input.pendingOrders.reduce((sum, item) => sum + Math.max(0, finite(item.reservedNotionalUsdt)), 0);
  const riskUsedPercent = capital > 0 ? (pressureLossUsdt / capital) * 100 : 0;
  const reasons: string[] = [];
  let status: SpotChallengeStatus = "RUNNING";

  if (equity >= thresholds.successEquityUsdt) {
    status = "SUCCESS_PENDING_CLEAR";
    reasons.push("账户净权益达到成功阈值");
  } else if (equity <= thresholds.failureEquityUsdt) {
    status = "FAILURE_PENDING_CLEAR";
    reasons.push("账户净权益达到失败阈值");
  } else if (netPnlPercent <= -2.5) {
    status = "REDUCE_ONLY";
    reasons.push("接近挑战失败线，进入强制减仓保护");
  } else if (netPnlPercent <= -2) {
    status = "PROTECT";
    reasons.push("达到移动止损保护区");
  } else if (netPnlPercent <= -1.5) {
    status = "PROTECT";
    reasons.push("禁止普通加仓");
  } else if (netPnlPercent <= -1) {
    status = "CAUTION";
    reasons.push("新增订单金额减半");
  }

  if (riskUsedPercent >= 2.4) {
    status = "REDUCE_ONLY";
    reasons.push("压力风险超过紧急缓冲上限");
  } else if (riskUsedPercent >= 1.8 && status === "RUNNING") {
    status = "CAUTION";
    reasons.push("压力风险达到策略风险预算");
  }
  if (finite(input.volatility24hPercent) > 12) {
    status = "REDUCE_ONLY";
    reasons.push("波动率超过极端阈值");
  } else if (finite(input.volatility24hPercent) > 8 && status === "RUNNING") {
    status = "PROTECT";
    reasons.push("波动率进入保护区");
  } else if (finite(input.volatility24hPercent) > 5 && status === "RUNNING") {
    status = "CAUTION";
    reasons.push("波动率进入警戒区");
  }
  if (finite(input.websocketAgeMs) > 3_000) {
    status = "REDUCE_ONLY";
    reasons.push("实时行情超过允许延迟");
  }
  const groupExposure = maxGroupExposure([
    ...input.positions,
    ...input.pendingOrders.map((item) => ({
      symbol: item.symbol,
      notionalUsdt: item.reservedNotionalUsdt,
      correlationGroup: item.correlationGroup,
    })),
  ]);
  if (groupExposure > capital * (SPOT_CHALLENGE_DEFAULTS.maxCorrelatedGroupPercent / 100)) {
    status = status === "RUNNING" ? "CAUTION" : status;
    reasons.push("高相关资产组合暴露超过上限");
  }

  const probabilities = dynamicProbabilities({
    netPnlPercent,
    riskUsedPercent,
    volatility24hPercent: input.volatility24hPercent,
    websocketAgeMs: input.websocketAgeMs,
    status,
  });

  return {
    status,
    netPnlUsdt,
    netPnlPercent,
    distanceToSuccessUsdt: Math.max(0, thresholds.successEquityUsdt - equity),
    distanceToFailureUsdt: Math.max(0, equity - thresholds.failureEquityUsdt),
    pressureLossUsdt,
    riskUsedPercent,
    reservedNotionalUsdt,
    successProbability: input.successProbability == null ? probabilities.success : finite(input.successProbability),
    failureProbability: input.failureProbability == null ? probabilities.failure : finite(input.failureProbability),
    stressFailureProbability: input.stressFailureProbability == null ? probabilities.stressFailure : finite(input.stressFailureProbability),
    reasons: [...new Set(reasons)],
  };
}
