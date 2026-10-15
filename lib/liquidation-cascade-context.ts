export const LIQUIDATION_CASCADE_CONTEXT_VERSION =
  "liquidation-cascade-context-v1" as const;

export type LiquidationCascadePhase =
  | "INSUFFICIENT_HISTORY"
  | "CONTINUATION_RISK"
  | "EXHAUSTION_WATCH"
  | "RANGE_NOISE";

export type LiquidationCascadeEvent = {
  eventAtMs: number;
  liquidationPrice: number;
  liquidationNotional: number;
};

export function shouldSupersedeLiquidationAnalysis(input: {
  liquidationSide: "BUY" | "SELL";
  currentState: string;
  previousEventAtMs: number;
  latestEventAtMs: number;
  previousLiquidationPrice: number;
  latestLiquidationPrice: number;
  minimumExtensionPercent?: number;
}) {
  const minimumExtensionPercent = Math.max(
    0,
    input.minimumExtensionPercent ?? 0.1,
  );
  if (!["ANALYZING", "ARMED"].includes(input.currentState)) return false;
  if (input.latestEventAtMs <= input.previousEventAtMs) return false;
  if (
    !Number.isFinite(input.previousLiquidationPrice) ||
    !Number.isFinite(input.latestLiquidationPrice) ||
    input.previousLiquidationPrice <= 0 ||
    input.latestLiquidationPrice <= 0
  )
    return false;

  const extensionRatio = minimumExtensionPercent / 100;
  return input.liquidationSide === "SELL"
    ? input.latestLiquidationPrice <
        input.previousLiquidationPrice * (1 - extensionRatio)
    : input.latestLiquidationPrice >
        input.previousLiquidationPrice * (1 + extensionRatio);
}

/**
 * 连续爆仓只负责回答“现在仍在下探，还是值得等待反弹确认”。
 * 它绝不直接把某一笔大额爆仓解释成底部，也不直接创建订单。
 */
export function analyzeLiquidationCascadeContext(input: {
  events: LiquidationCascadeEvent[];
  liquidationSide: "BUY" | "SELL";
}) {
  const events = input.events
    .filter(
      (event) =>
        Number.isFinite(event.eventAtMs) &&
        Number.isFinite(event.liquidationPrice) &&
        event.liquidationPrice > 0 &&
        Number.isFinite(event.liquidationNotional) &&
        event.liquidationNotional > 0,
    )
    .sort((left, right) => left.eventAtMs - right.eventAtMs);
  const prices = events.map((event) => event.liquidationPrice);
  const notionals = events.map((event) => event.liquidationNotional);
  const firstPrice = prices[0] ?? null;
  const latestPrice = prices.at(-1) ?? null;
  const totalMovePercent =
    firstPrice !== null && latestPrice !== null
      ? ((latestPrice - firstPrice) / firstPrice) * 100
      : null;
  const expectedContinuationDirection =
    input.liquidationSide === "SELL" ? "DOWN" : "UP";
  const continuationComparisons = prices.slice(1).filter((price, index) =>
    expectedContinuationDirection === "DOWN"
      ? price < prices[index]
      : price > prices[index],
  ).length;
  const latestIsExtreme =
    latestPrice !== null &&
    (expectedContinuationDirection === "DOWN"
      ? latestPrice <= Math.min(...prices)
      : latestPrice >= Math.max(...prices));
  const previousNotionals = notionals.slice(0, -1).sort((a, b) => a - b);
  const medianPreviousNotional =
    previousNotionals.length === 0
      ? null
      : previousNotionals.length % 2 === 1
        ? previousNotionals[Math.floor(previousNotionals.length / 2)]
        : (previousNotionals[previousNotionals.length / 2 - 1] +
            previousNotionals[previousNotionals.length / 2]) /
          2;
  const latestNotionalRatio =
    medianPreviousNotional && medianPreviousNotional > 0
      ? notionals.at(-1)! / medianPreviousNotional
      : null;
  const directionalConsistency =
    prices.length > 1
      ? continuationComparisons / (prices.length - 1)
      : 0;
  const directionalCascade =
    events.length >= 3 &&
    latestIsExtreme &&
    directionalConsistency >= 0.6;
  const outsizedLatestLiquidation =
    directionalCascade &&
    latestNotionalRatio !== null &&
    latestNotionalRatio >= 1.5;

  const phase: LiquidationCascadePhase =
    events.length < 3
      ? "INSUFFICIENT_HISTORY"
      : outsizedLatestLiquidation
        ? "EXHAUSTION_WATCH"
        : directionalCascade
          ? "CONTINUATION_RISK"
          : "RANGE_NOISE";
  const reason =
    phase === "EXHAUSTION_WATCH"
      ? "价格仍处于连续爆仓方向的极值，但最新爆仓明显放大；只进入衰竭观察，必须等待结构收回和独立量能确认。"
      : phase === "CONTINUATION_RISK"
        ? "连续爆仓价格仍沿原方向推进，继续下探/上冲风险未解除，禁止提前把爆仓当成反转。"
        : phase === "RANGE_NOISE"
          ? "爆仓价格未形成一致推进，暂按区间噪音处理。"
          : "同合约历史爆仓样本不足，不能判断延续或衰竭。";

  return {
    version: LIQUIDATION_CASCADE_CONTEXT_VERSION,
    phase,
    eventCount: events.length,
    firstPrice,
    latestPrice,
    totalMovePercent,
    continuationComparisons,
    directionalConsistency,
    latestIsExtreme,
    latestNotional: notionals.at(-1) ?? null,
    medianPreviousNotional,
    latestNotionalRatio,
    requiresReboundConfirmation:
      phase === "CONTINUATION_RISK" || phase === "EXHAUSTION_WATCH",
    directEntryAllowed: false as const,
    orderAffecting: true as const,
    reason,
  };
}
