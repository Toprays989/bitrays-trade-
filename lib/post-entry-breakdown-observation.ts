export type PostEntryBreakdownStatus =
  | "STABLE"
  | "WATCH"
  | "BREAKDOWN_PRESSURE"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE";

export type PostEntryBreakdownObservation = {
  status: PostEntryBreakdownStatus;
  label: string;
  observationOnly: true;
  support: number | null;
  invalidBoundary: number | null;
  currentMarkPrice: number;
  currentBelowBoundary: boolean;
  consecutiveClosedMinutesBelowBoundary: number;
  requiredClosedMinutes: number;
  sellLiquidationPressure: boolean;
  sellLiquidationNotional: number;
  sellLiquidationEventCount: number;
  sellLiquidationTriggerMode: string | null;
  reason: string;
};

type ClosedMinute = {
  closeTime: number;
  close: number;
};

export function analyzePostEntryBreakdownObservation(input: {
  positionSide: "LONG" | "SHORT";
  currentMarkPrice: number;
  priorSupport: number | null;
  atr5m: number | null;
  openedAtMs: number;
  observedAtMs: number;
  closedMinutes1m: ClosedMinute[];
  supportBufferAtr?: number;
  requiredClosedMinutes?: number;
  sellLiquidationPressure?: {
    triggered: boolean;
    notional: number;
    eventCount: number;
    triggerMode?: string | null;
  } | null;
}): PostEntryBreakdownObservation {
  const requiredClosedMinutes = Math.max(
    1,
    Math.trunc(input.requiredClosedMinutes ?? 2),
  );
  const sellPressure = input.sellLiquidationPressure;
  const common = {
    observationOnly: true as const,
    support: finitePositive(input.priorSupport),
    invalidBoundary: null,
    currentMarkPrice: input.currentMarkPrice,
    currentBelowBoundary: false,
    consecutiveClosedMinutesBelowBoundary: 0,
    requiredClosedMinutes,
    sellLiquidationPressure: Boolean(sellPressure?.triggered),
    sellLiquidationNotional: finiteNonNegative(sellPressure?.notional),
    sellLiquidationEventCount: Math.max(
      0,
      Math.trunc(finiteNonNegative(sellPressure?.eventCount)),
    ),
    sellLiquidationTriggerMode:
      typeof sellPressure?.triggerMode === "string"
        ? sellPressure.triggerMode
        : null,
  };
  if (input.positionSide !== "LONG")
    return {
      ...common,
      status: "NOT_APPLICABLE",
      label: "非多仓不适用",
      reason: "当前策略的破位杀盘观察只用于多仓，不改变空仓逻辑。",
    };

  const support = finitePositive(input.priorSupport);
  const atr5m = finitePositive(input.atr5m);
  if (
    support === null ||
    atr5m === null ||
    !Number.isFinite(input.currentMarkPrice) ||
    input.currentMarkPrice <= 0
  )
    return {
      ...common,
      status: "UNAVAILABLE",
      label: "破位证据不足",
      reason: "入场支撑位、5分钟ATR或当前标记价格不足，只记录盈亏，不推断杀盘。",
    };

  const supportBufferAtr = Math.max(
    0,
    Number.isFinite(input.supportBufferAtr)
      ? Number(input.supportBufferAtr)
      : 0.1,
  );
  const invalidBoundary = support - atr5m * supportBufferAtr;
  const closes = input.closedMinutes1m
    .filter(
      (candle) =>
        Number.isFinite(candle.closeTime) &&
        Number.isFinite(candle.close) &&
        candle.closeTime >= input.openedAtMs &&
        candle.closeTime <= input.observedAtMs,
    )
    .sort((left, right) => left.closeTime - right.closeTime);
  let consecutiveClosedMinutesBelowBoundary = 0;
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    if (closes[index].close >= invalidBoundary) break;
    consecutiveClosedMinutesBelowBoundary += 1;
  }
  const currentBelowBoundary = input.currentMarkPrice < invalidBoundary;
  const priceBreakConfirmed =
    consecutiveClosedMinutesBelowBoundary >= requiredClosedMinutes;
  const pressureConfirmed =
    priceBreakConfirmed && Boolean(sellPressure?.triggered);
  const detail = {
    ...common,
    support,
    invalidBoundary,
    currentBelowBoundary,
    consecutiveClosedMinutesBelowBoundary,
  };
  if (pressureConfirmed)
    return {
      ...detail,
      status: "BREAKDOWN_PRESSURE",
      label: "破位杀盘压力",
      reason:
        `连续 ${consecutiveClosedMinutesBelowBoundary} 根完整1分钟收盘低于失效边界，` +
        `同时出现 ${common.sellLiquidationNotional.toFixed(2)} USDT SELL强平压力；` +
        "该状态仅记录，用真实后续盈亏验证是否值得提前退出。",
    };
  if (
    priceBreakConfirmed ||
    currentBelowBoundary ||
    Boolean(sellPressure?.triggered)
  )
    return {
      ...detail,
      status: "WATCH",
      label: "破位观察",
      reason: priceBreakConfirmed
        ? `连续 ${consecutiveClosedMinutesBelowBoundary} 根完整1分钟收盘失守，但尚无同步SELL强平确认。`
        : currentBelowBoundary
          ? "当前标记价格跌破失效边界，等待完整1分钟收盘确认。"
          : "出现SELL强平压力，但价格尚未连续收盘失守入场支撑。",
    };
  return {
    ...detail,
    status: "STABLE",
    label: "支撑仍有效",
    reason: "价格未连续收盘跌破入场支撑失效边界，暂未观察到破位杀盘状态。",
  };
}

function finitePositive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function finiteNonNegative(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}
