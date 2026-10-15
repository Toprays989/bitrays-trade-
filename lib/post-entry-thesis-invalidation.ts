export type EntryThesisInvalidation = {
  status: "STABLE" | "WATCH" | "INVALIDATED" | "UNAVAILABLE";
  positionSide: "LONG" | "SHORT";
  structuralLevel: number | null;
  invalidBoundary: number | null;
  consecutiveClosedMinutesBeyondBoundary: number;
  requiredClosedMinutes: number;
  reason: string;
};

type ClosedMinute = {
  closeTime: number;
  close: number;
};

/**
 * Confirms that the exact entry structure has failed.
 *
 * A live mark crossing the boundary is only a warning.  An invalidation needs
 * consecutive completed one-minute closes beyond the ATR-buffered structure,
 * so one thin wick cannot turn into a forced exit.
 */
export function analyzeEntryThesisInvalidation(input: {
  positionSide: "LONG" | "SHORT";
  structuralLevel: number | null;
  atr5m: number | null;
  explicitInvalidBoundary?: number | null;
  currentMarkPrice: number;
  openedAtMs: number;
  observedAtMs: number;
  closedMinutes1m: ClosedMinute[];
  boundaryBufferAtr?: number;
  requiredClosedMinutes?: number;
}): EntryThesisInvalidation {
  const requiredClosedMinutes = Math.max(
    2,
    Math.trunc(input.requiredClosedMinutes ?? 2),
  );
  const structuralLevel = positive(input.structuralLevel);
  const atr5m = positive(input.atr5m);
  const explicitInvalidBoundary = positive(input.explicitInvalidBoundary);
  const common = {
    positionSide: input.positionSide,
    structuralLevel,
    invalidBoundary: null,
    consecutiveClosedMinutesBeyondBoundary: 0,
    requiredClosedMinutes,
  };
  if (
    (explicitInvalidBoundary === null &&
      (structuralLevel === null || atr5m === null)) ||
    !Number.isFinite(input.currentMarkPrice) ||
    input.currentMarkPrice <= 0
  )
    return {
      ...common,
      status: "UNAVAILABLE",
      reason: "入场结构、5分钟ATR或当前标记价格不完整，不据此退出。",
    };

  const bufferAtr = Math.max(
    0.05,
    Number.isFinite(input.boundaryBufferAtr)
      ? Number(input.boundaryBufferAtr)
      : 0.1,
  );
  const invalidBoundary = explicitInvalidBoundary ??
    (input.positionSide === "LONG"
      ? structuralLevel! - atr5m! * bufferAtr
      : structuralLevel! + atr5m! * bufferAtr);
  const beyond = (price: number) =>
    input.positionSide === "LONG"
      ? price < invalidBoundary
      : price > invalidBoundary;
  const closes = input.closedMinutes1m
    .filter(
      (candle) =>
        Number.isFinite(candle.closeTime) &&
        Number.isFinite(candle.close) &&
        candle.closeTime >= input.openedAtMs &&
        candle.closeTime <= input.observedAtMs,
    )
    .sort((left, right) => left.closeTime - right.closeTime);
  let consecutiveClosedMinutesBeyondBoundary = 0;
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    if (!beyond(closes[index].close)) break;
    consecutiveClosedMinutesBeyondBoundary += 1;
  }
  const detail = {
    ...common,
    invalidBoundary,
    consecutiveClosedMinutesBeyondBoundary,
  };
  if (
    consecutiveClosedMinutesBeyondBoundary >= requiredClosedMinutes
  )
    return {
      ...detail,
      status: "INVALIDATED",
      reason:
        `连续 ${consecutiveClosedMinutesBeyondBoundary} 根完整1分钟收盘越过入场结构失效边界，原方向假设已失效。`,
    };
  if (beyond(input.currentMarkPrice))
    return {
      ...detail,
      status: "WATCH",
      reason: "当前价格已越过结构失效边界，等待完整1分钟收盘确认。",
    };
  return {
    ...detail,
    status: "STABLE",
    reason: "价格仍在入场结构有效范围内。",
  };
}

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
