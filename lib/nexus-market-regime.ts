export type NexusMarketRegime =
  | "BULLISH"
  | "BEARISH"
  | "TRANSITION"
  | "RANGE"
  | "INSUFFICIENT";

export function nexusMarketRegimeLabel(regime: NexusMarketRegime) {
  return {
    BULLISH: "多头趋势",
    BEARISH: "空头趋势",
    TRANSITION: "趋势转换",
    RANGE: "均线缠绕震荡",
    INSUFFICIENT: "趋势样本不足",
  }[regime];
}

export type NexusMarketRegimeResult = {
  regime: NexusMarketRegime;
  fastEma: number | null;
  slowEma: number | null;
  previousFastEma: number | null;
  previousSlowEma: number | null;
  fastSlope: number | null;
  slowSlope: number | null;
  separationAtr: number | null;
  reason: string;
};

export type NexusRegimeCandle = {
  openTime: number;
  high: number;
  low: number;
  close: number;
};

export function exponentialMovingAverage(
  values: number[],
  period: number,
): number | null {
  if (
    !Number.isInteger(period) ||
    period < 2 ||
    values.length < period ||
    values.some((value) => !Number.isFinite(value) || value <= 0)
  )
    return null;
  const multiplier = 2 / (period + 1);
  let value =
    values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < values.length; index += 1)
    value = values[index] * multiplier + value * (1 - multiplier);
  return value;
}

export function classifyNexusMarketRegime(input: {
  closedPrices: number[];
  fastPeriod: number;
  slowPeriod: number;
  atr: number;
  minimumSeparationAtr?: number;
}): NexusMarketRegimeResult {
  const minimumSeparationAtr = Math.max(
    0,
    input.minimumSeparationAtr ?? 0.08,
  );
  const prices = input.closedPrices;
  const currentPrice = prices.at(-1);
  const previousPrices = prices.slice(0, -1);
  const fastEma = exponentialMovingAverage(prices, input.fastPeriod);
  const slowEma = exponentialMovingAverage(prices, input.slowPeriod);
  const previousFastEma = exponentialMovingAverage(
    previousPrices,
    input.fastPeriod,
  );
  const previousSlowEma = exponentialMovingAverage(
    previousPrices,
    input.slowPeriod,
  );
  if (
    !Number.isFinite(currentPrice) ||
    fastEma === null ||
    slowEma === null ||
    previousFastEma === null ||
    previousSlowEma === null ||
    !Number.isFinite(input.atr) ||
    input.atr <= 0
  )
    return {
      regime: "INSUFFICIENT",
      fastEma,
      slowEma,
      previousFastEma,
      previousSlowEma,
      fastSlope: null,
      slowSlope: null,
      separationAtr: null,
      reason: "闭合价格或ATR证据不足",
    };
  const fastSlope = fastEma - previousFastEma;
  const slowSlope = slowEma - previousSlowEma;
  const separationAtr = Math.abs(fastEma - slowEma) / input.atr;
  const crossed =
    (previousFastEma <= previousSlowEma && fastEma > slowEma) ||
    (previousFastEma >= previousSlowEma && fastEma < slowEma);
  if (crossed)
    return {
      regime: "TRANSITION",
      fastEma,
      slowEma,
      previousFastEma,
      previousSlowEma,
      fastSlope,
      slowSlope,
      separationAtr,
      reason: "快慢均线刚发生交叉，等待闭合K线与量价确认",
    };
  if (separationAtr < minimumSeparationAtr)
    return {
      regime: "RANGE",
      fastEma,
      slowEma,
      previousFastEma,
      previousSlowEma,
      fastSlope,
      slowSlope,
      separationAtr,
      reason: "均线间距相对ATR过小，判定为缠绕震荡",
    };
  if (
    currentPrice! > fastEma &&
    fastEma > slowEma &&
    fastSlope > 0 &&
    slowSlope > 0
  )
    return {
      regime: "BULLISH",
      fastEma,
      slowEma,
      previousFastEma,
      previousSlowEma,
      fastSlope,
      slowSlope,
      separationAtr,
      reason: "价格位于两条均线上方且快慢线同步上行",
    };
  if (
    currentPrice! < fastEma &&
    fastEma < slowEma &&
    fastSlope < 0 &&
    slowSlope < 0
  )
    return {
      regime: "BEARISH",
      fastEma,
      slowEma,
      previousFastEma,
      previousSlowEma,
      fastSlope,
      slowSlope,
      separationAtr,
      reason: "价格位于两条均线下方且快慢线同步下行",
    };
  return {
    regime: "TRANSITION",
    fastEma,
    slowEma,
    previousFastEma,
    previousSlowEma,
    fastSlope,
    slowSlope,
    separationAtr,
    reason: "价格位置、均线顺序与斜率尚未形成一致趋势",
  };
}

export function classifyNexusMarketRegimeFromCandles(input: {
  candles: NexusRegimeCandle[];
  fastPeriod?: number;
  slowPeriod?: number;
  atrPeriod?: number;
  minimumSeparationAtr?: number;
}) {
  const fastPeriod = Math.max(2, Math.trunc(input.fastPeriod ?? 9));
  const slowPeriod = Math.max(
    fastPeriod + 1,
    Math.trunc(input.slowPeriod ?? 21),
  );
  const atrPeriod = Math.max(2, Math.trunc(input.atrPeriod ?? 14));
  const candles = input.candles
    .filter(
      (row) =>
        Number.isFinite(row.openTime) &&
        [row.high, row.low, row.close].every(
          (value) => Number.isFinite(value) && value > 0,
        ) &&
        row.high >= row.low,
    )
    .sort((left, right) => left.openTime - right.openTime);
  const atr = wilderAverageTrueRange(candles, atrPeriod);
  const result = classifyNexusMarketRegime({
    closedPrices: candles.map((row) => row.close),
    fastPeriod,
    slowPeriod,
    atr: atr ?? Number.NaN,
    minimumSeparationAtr: input.minimumSeparationAtr,
  });
  return {
    ...result,
    atr,
    fastPeriod,
    slowPeriod,
    atrPeriod,
    observations: candles.length,
    orderAffecting: false as const,
  };
}

export function wilderAverageTrueRange(
  candles: NexusRegimeCandle[],
  period: number,
) {
  const normalizedPeriod = Math.max(2, Math.trunc(period));
  if (candles.length < normalizedPeriod + 1) return null;
  const ranges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }
  let atr =
    ranges
      .slice(0, normalizedPeriod)
      .reduce((total, value) => total + value, 0) / normalizedPeriod;
  for (const range of ranges.slice(normalizedPeriod))
    atr = (atr * (normalizedPeriod - 1) + range) / normalizedPeriod;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}
