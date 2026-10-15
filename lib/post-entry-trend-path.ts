export const POST_ENTRY_TREND_PATH_VERSION =
  "post-entry-trend-path-v1" as const;

export type PostEntryTrendPathStatus =
  | "UNAVAILABLE"
  | "EARLY_PROBE"
  | "RANGE"
  | "CONTINUATION_CONFIRMED"
  | "MOMENTUM_DECAY"
  | "RECOVERY_CONFIRMED"
  | "REVERSAL_PRESSURE";

type ClosedCandle = {
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
  close: number;
};

export type PostEntryTrendPath = {
  version: typeof POST_ENTRY_TREND_PATH_VERSION;
  status: PostEntryTrendPathStatus;
  positionSide: "LONG" | "SHORT";
  closedCandleCount: number;
  consecutiveFavorableCloses: number;
  consecutiveAdverseCloses: number;
  continuationBoundaryHeld: boolean | null;
  invalidationBoundaryHeld: boolean | null;
  favorableExtremeImproving: boolean | null;
  adverseExtremeExpanding: boolean | null;
  givebackAtr: number | null;
  recoveryAtr: number | null;
  summary: string;
};

/**
 * Interpret only already-closed 5-minute candles. The result describes the
 * path after entry; it never predicts a future high/low and never places an
 * order. Rules are sequential rather than score based:
 * two closes establish direction, while swing extremes prove whether the move
 * is holding or deteriorating.
 */
export function analyzePostEntryTrendPath(input: {
  positionSide: "LONG" | "SHORT";
  observedAtMs: number;
  currentRoePercent: number;
  atr5m: number | null | undefined;
  continuationBoundary: number | null | undefined;
  invalidationBoundary: number | null | undefined;
  closed5m: ClosedCandle[];
}): PostEntryTrendPath {
  const atr = positive(input.atr5m);
  const continuationBoundary = positive(input.continuationBoundary);
  const invalidationBoundary = positive(input.invalidationBoundary);
  const candles = input.closed5m
    .filter(
      (candle) =>
        finite(candle.openTime) &&
        finite(candle.closeTime) &&
        candle.closeTime <= input.observedAtMs &&
        positive(candle.high) !== null &&
        positive(candle.low) !== null &&
        positive(candle.close) !== null &&
        candle.high >= candle.low,
    )
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-12);
  const common = {
    version: POST_ENTRY_TREND_PATH_VERSION,
    positionSide: input.positionSide,
    closedCandleCount: candles.length,
  };
  if (
    atr === null ||
    continuationBoundary === null ||
    invalidationBoundary === null ||
    !finite(input.observedAtMs) ||
    !finite(input.currentRoePercent)
  )
    return unavailable(common, "入场结构、ATR或观察时间不足，暂不解释持仓波段路径。");
  if (candles.length < 3)
    return {
      ...emptyDetail(common),
      status: "EARLY_PROBE",
      summary: "闭合5分钟K线不足3根，仍处于早期探针阶段，不判断延续、衰减或触底。",
    };

  const recent = candles.slice(-3);
  const favorable = (left: ClosedCandle, right: ClosedCandle) =>
    input.positionSide === "LONG"
      ? right.close > left.close
      : right.close < left.close;
  const adverse = (left: ClosedCandle, right: ClosedCandle) =>
    input.positionSide === "LONG"
      ? right.close < left.close
      : right.close > left.close;
  const favorableExtreme = (left: ClosedCandle, right: ClosedCandle) =>
    input.positionSide === "LONG"
      ? right.low >= left.low
      : right.high <= left.high;
  const adverseExtreme = (left: ClosedCandle, right: ClosedCandle) =>
    input.positionSide === "LONG"
      ? right.low < left.low
      : right.high > left.high;
  const consecutiveFavorableCloses = trailingTransitions(recent, favorable);
  const consecutiveAdverseCloses = trailingTransitions(recent, adverse);
  const favorableExtremeImproving = recent
    .slice(1)
    .every((candle, index) => favorableExtreme(recent[index]!, candle));
  const adverseExtremeExpanding = recent
    .slice(1)
    .every((candle, index) => adverseExtreme(recent[index]!, candle));
  const latest = recent.at(-1)!;
  const previous = recent.at(-2)!;
  const continuationBoundaryHeld = input.positionSide === "LONG"
    ? previous.close > continuationBoundary &&
      latest.close > continuationBoundary
    : previous.close < continuationBoundary &&
      latest.close < continuationBoundary;
  const invalidationBoundaryHeld = input.positionSide === "LONG"
    ? previous.close < invalidationBoundary &&
      latest.close < invalidationBoundary
    : previous.close > invalidationBoundary &&
      latest.close > invalidationBoundary;
  const favorableExtremePrice = input.positionSide === "LONG"
    ? Math.max(...candles.map((candle) => candle.high))
    : Math.min(...candles.map((candle) => candle.low));
  const adverseExtremePrice = input.positionSide === "LONG"
    ? Math.min(...candles.map((candle) => candle.low))
    : Math.max(...candles.map((candle) => candle.high));
  const givebackAtr = input.positionSide === "LONG"
    ? Math.max(0, favorableExtremePrice - latest.close) / atr
    : Math.max(0, latest.close - favorableExtremePrice) / atr;
  const recoveryAtr = input.positionSide === "LONG"
    ? Math.max(0, latest.close - adverseExtremePrice) / atr
    : Math.max(0, adverseExtremePrice - latest.close) / atr;
  const detail = {
    ...common,
    consecutiveFavorableCloses,
    consecutiveAdverseCloses,
    continuationBoundaryHeld,
    invalidationBoundaryHeld,
    favorableExtremeImproving,
    adverseExtremeExpanding,
    givebackAtr: round(givebackAtr),
    recoveryAtr: round(recoveryAtr),
  };

  if (
    invalidationBoundaryHeld &&
    consecutiveAdverseCloses >= 2 &&
    adverseExtremeExpanding
  )
    return {
      ...detail,
      status: "REVERSAL_PRESSURE",
      summary: "连续两根闭合5分钟K线沿持仓反方向运行并扩大不利极值，且持续越过入场失效边界。",
    };
  if (
    input.currentRoePercent > 0 &&
    continuationBoundaryHeld &&
    consecutiveFavorableCloses >= 2 &&
    favorableExtremeImproving
  )
    return {
      ...detail,
      status: "CONTINUATION_CONFIRMED",
      summary: "连续两根闭合5分钟K线沿持仓方向推进、改善防守极值，并持续站在延续边界之外。",
    };
  if (
    input.currentRoePercent > 0 &&
    consecutiveAdverseCloses >= 2 &&
    adverseExtremeExpanding &&
    givebackAtr >= 0.5
  )
    return {
      ...detail,
      status: "MOMENTUM_DECAY",
      summary: `盈利仓连续两根闭合5分钟K线逆向运行，回撤已达到 ${round(givebackAtr)} ATR，波段动能正在衰减。`,
    };
  if (
    input.currentRoePercent < 0 &&
    consecutiveFavorableCloses >= 2 &&
    favorableExtremeImproving &&
    recoveryAtr >= 0.5
  )
    return {
      ...detail,
      status: "RECOVERY_CONFIRMED",
      summary: `亏损仓连续两根闭合5分钟K线沿持仓方向修复，防守极值改善且已从不利极值恢复 ${round(recoveryAtr)} ATR。`,
    };
  if (
    input.currentRoePercent < 0 &&
    consecutiveAdverseCloses >= 2 &&
    adverseExtremeExpanding
  )
    return {
      ...detail,
      status: "REVERSAL_PRESSURE",
      summary: "亏损仓连续两根闭合5分钟K线逆向运行且不利极值继续扩大，尚未形成修复路径。",
    };
  return {
    ...detail,
    status: "RANGE",
    summary: "闭合5分钟路径尚未连续证明延续、衰减、修复或反转，按正常波动处理。",
  };
}

function trailingTransitions(
  candles: ClosedCandle[],
  predicate: (left: ClosedCandle, right: ClosedCandle) => boolean,
) {
  let count = 0;
  for (let index = candles.length - 1; index > 0; index -= 1) {
    if (!predicate(candles[index - 1]!, candles[index]!)) break;
    count += 1;
  }
  return count;
}

function unavailable(
  common: Pick<PostEntryTrendPath, "version" | "positionSide" | "closedCandleCount">,
  summary: string,
): PostEntryTrendPath {
  return {
    ...emptyDetail(common),
    status: "UNAVAILABLE",
    summary,
  };
}

function emptyDetail(
  common: Pick<PostEntryTrendPath, "version" | "positionSide" | "closedCandleCount">,
) {
  return {
    ...common,
    consecutiveFavorableCloses: 0,
    consecutiveAdverseCloses: 0,
    continuationBoundaryHeld: null,
    invalidationBoundaryHeld: null,
    favorableExtremeImproving: null,
    adverseExtremeExpanding: null,
    givebackAtr: null,
    recoveryAtr: null,
  };
}

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function finite(value: unknown) {
  return Number.isFinite(Number(value));
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}
