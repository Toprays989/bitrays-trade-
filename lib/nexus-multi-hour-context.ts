import type { NexusMarketRegime } from "./nexus-market-regime.ts";

export const NEXUS_MULTI_HOUR_CONTEXT_VERSION =
  "nexus-multi-hour-context-v2" as const;

type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume?: number;
};

type HorizonDirection = "UP" | "DOWN" | "RANGE" | "INSUFFICIENT";

export function analyzeNexusMultiHourContext(input: {
  candles1h: Candle[];
  candles15m: Candle[];
  evaluatedAt?: number;
}) {
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const candles1h = input.candles1h
    .filter(validCandle)
    .filter(
      (candle) =>
        candle.openTime + 60 * 60_000 - 1 <= evaluatedAt,
    )
    .sort((left, right) => left.openTime - right.openTime);
  const candles15m = input.candles15m
    .filter(validCandle)
    .filter(
      (candle) =>
        candle.openTime + 15 * 60_000 - 1 <= evaluatedAt,
    )
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-12);
  const noisePercent = median(
    candles1h.map(
      (candle) =>
        ((candle.high - candle.low) / candle.open) * 100,
    ),
  );
  const directionThresholdPercent = Math.max(
    0.15,
    (noisePercent ?? 0) * 0.25,
  );
  const horizon1h = horizon(candles1h, 1, directionThresholdPercent);
  const horizon2h = horizon(candles1h, 2, directionThresholdPercent);
  const horizon3h = horizon(candles1h, 3, directionThresholdPercent);
  const horizon4h = horizon(candles1h, 4, directionThresholdPercent);
  const displacementPercent =
    candles15m.length > 0
      ? ((candles15m.at(-1)!.close - candles15m[0].open) /
          candles15m[0].open) *
        100
      : null;
  let pathPercent = 0;
  for (let index = 1; index < candles15m.length; index += 1) {
    pathPercent +=
      Math.abs(
        candles15m[index].close - candles15m[index - 1].close,
      ) /
      candles15m[index - 1].close *
      100;
  }
  const directionalEfficiency =
    displacementPercent === null
      ? null
      : pathPercent > 0
        ? Math.abs(displacementPercent) / pathPercent
        : 0;
  const regime = resolveRegime({
    horizon1h: horizon1h.direction,
    horizon2h: horizon2h.direction,
    horizon3h: horizon3h.direction,
    horizon4h: horizon4h.direction,
  });
  const phase =
    candles15m.length < 8 || regime === "INSUFFICIENT"
      ? "INSUFFICIENT"
      : directionalEfficiency !== null &&
          directionalEfficiency <= 0.35
        ? "GRIND"
        : regime === "BULLISH"
          ? "TREND_UP"
          : regime === "BEARISH"
            ? "TREND_DOWN"
            : "TRANSITION";
  const volume = volumeContext(candles15m);
  const priceVolumeBehavior = classifyPriceVolumeBehavior({
    candles: candles15m,
    volumeRatio: volume.relativeRatio,
  });
  const decisionRegime: NexusMarketRegime =
    phase === "GRIND"
      ? "RANGE"
      : phase === "TRANSITION"
        ? "TRANSITION"
        : regime;
  return {
    version: NEXUS_MULTI_HOUR_CONTEXT_VERSION,
    regime,
    decisionRegime,
    phase,
    horizon1h,
    horizon2h,
    horizon3h,
    horizon4h,
    observations1h: candles1h.length,
    observations15m: candles15m.length,
    directionThresholdPercent,
    displacementPercent,
    directionalEfficiency,
    volume,
    priceVolumeBehavior,
    reason:
      phase === "GRIND"
        ? "1/2/3/4小时方向未形成有效推进，15分钟路径反复重叠，处于震荡磨盘"
        : phase === "TREND_UP"
          ? "2/3小时结构向上且4小时未反向，短线仍处于上行推进"
          : phase === "TREND_DOWN"
            ? "2/3小时结构向下且4小时未反向，短线仍处于下行推进"
            : phase === "TRANSITION"
              ? "1/2/3/4小时方向发生分歧，处于趋势转换阶段"
              : "1/2/3/4小时或15分钟背景样本不足",
    orderAffecting: true as const,
  };
}

export function nexusMultiHourContextSummary(
  context: ReturnType<typeof analyzeNexusMultiHourContext>,
) {
  const label = (direction: HorizonDirection) =>
    ({
      UP: "涨",
      DOWN: "跌",
      RANGE: "震荡",
      INSUFFICIENT: "不足",
    })[direction];
  return (
    `目标币方向：1小时${label(context.horizon1h.direction)}` +
    `、2小时${label(context.horizon2h.direction)}` +
    `、3小时${label(context.horizon3h.direction)}` +
    `、4小时${label(context.horizon4h.direction)}` +
    `；阶段：${context.phase === "GRIND" ? "震荡磨盘" : context.phase}` +
    `；15分钟成交量比${formatRatio(context.volume.relativeRatio)}` +
    `；量价行为：${priceVolumeBehaviorLabel(context.priceVolumeBehavior.kind)}` +
    `。${context.reason}`
  );
}

function horizon(
  candles: Candle[],
  hours: number,
  thresholdPercent: number,
) {
  const selected = candles.slice(-hours);
  if (selected.length < hours)
    return {
      hours,
      direction: "INSUFFICIENT" as const,
      returnPercent: null,
      rangePercent: null,
    };
  const start = selected[0].open;
  const end = selected.at(-1)!.close;
  const returnPercent = ((end - start) / start) * 100;
  const high = Math.max(...selected.map((candle) => candle.high));
  const low = Math.min(...selected.map((candle) => candle.low));
  return {
    hours,
    direction:
      returnPercent >= thresholdPercent
        ? ("UP" as const)
        : returnPercent <= -thresholdPercent
          ? ("DOWN" as const)
          : ("RANGE" as const),
    returnPercent,
    rangePercent: ((high - low) / start) * 100,
  };
}

function resolveRegime(input: {
  horizon1h: HorizonDirection;
  horizon2h: HorizonDirection;
  horizon3h: HorizonDirection;
  horizon4h: HorizonDirection;
}): NexusMarketRegime {
  if (
    input.horizon2h === "INSUFFICIENT" ||
    input.horizon3h === "INSUFFICIENT" ||
    input.horizon4h === "INSUFFICIENT"
  )
    return "INSUFFICIENT";
  if (
    input.horizon2h === "UP" &&
    input.horizon3h === "UP" &&
    input.horizon4h !== "DOWN" &&
    input.horizon1h !== "DOWN"
  )
    return "BULLISH";
  if (
    input.horizon2h === "DOWN" &&
    input.horizon3h === "DOWN" &&
    input.horizon4h !== "UP" &&
    input.horizon1h !== "UP"
  )
    return "BEARISH";
  if (
    input.horizon1h === "RANGE" &&
    input.horizon2h === "RANGE" &&
    input.horizon3h === "RANGE" &&
    input.horizon4h === "RANGE"
  )
    return "RANGE";
  return "TRANSITION";
}

function volumeContext(candles: Candle[]) {
  const volumes = candles
    .map((candle) => candle.quoteVolume)
    .filter(
      (value): value is number =>
        Number.isFinite(value) && Number(value) >= 0,
    );
  if (volumes.length < 6)
    return {
      available: false,
      recentAverage: null,
      baselineAverage: null,
      relativeRatio: null,
    };
  const recent = volumes.slice(-2);
  const baseline = volumes.slice(0, -2);
  const recentAverage = average(recent);
  const baselineAverage = average(baseline);
  return {
    available: baselineAverage > 0,
    recentAverage,
    baselineAverage,
    relativeRatio:
      baselineAverage > 0 ? recentAverage / baselineAverage : null,
  };
}

function classifyPriceVolumeBehavior(input: {
  candles: Candle[];
  volumeRatio: number | null;
}) {
  if (input.candles.length < 4 || input.volumeRatio === null)
    return {
      kind: "INSUFFICIENT" as const,
      rangePositionPercent: null,
      recentReturnPercent: null,
    };
  const high = Math.max(...input.candles.map((candle) => candle.high));
  const low = Math.min(...input.candles.map((candle) => candle.low));
  const close = input.candles.at(-1)!.close;
  const recentStart = input.candles.at(-2)!.open;
  const rangePositionPercent =
    high > low ? ((close - low) / (high - low)) * 100 : 50;
  const recentReturnPercent =
    ((close - recentStart) / recentStart) * 100;
  const lastCandle = input.candles.at(-1)!;
  const lastCandleReturnPercent =
    ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100;
  if (input.volumeRatio <= 0.7 && rangePositionPercent <= 25)
    return {
      kind: "LOW_VOLUME_DRY_UP" as const,
      rangePositionPercent,
      recentReturnPercent,
    };
  if (input.volumeRatio <= 0.7 && rangePositionPercent >= 75)
    return {
      kind: "HIGH_VOLUME_DRY_UP" as const,
      rangePositionPercent,
      recentReturnPercent,
    };
  if (input.volumeRatio < 1.5)
    return {
      kind: "NORMAL" as const,
      rangePositionPercent,
      recentReturnPercent,
    };
  if (rangePositionPercent >= 75)
    return {
      kind:
        lastCandleReturnPercent >= 0
          ? ("HIGH_BREAKOUT_ACCEPTED" as const)
          : ("HIGH_REJECTION_DISTRIBUTION" as const),
      rangePositionPercent,
      recentReturnPercent,
    };
  if (rangePositionPercent <= 25)
    return {
      kind:
        lastCandleReturnPercent <= 0
          ? ("LOW_BREAKDOWN_ACCEPTED" as const)
          : ("LOW_RECLAIM_ACCUMULATION" as const),
      rangePositionPercent,
      recentReturnPercent,
    };
  return {
    kind: "ABSORPTION_ROTATION" as const,
    rangePositionPercent,
    recentReturnPercent,
  };
}

function priceVolumeBehaviorLabel(
  kind:
    | "INSUFFICIENT"
    | "NORMAL"
    | "LOW_VOLUME_DRY_UP"
    | "HIGH_VOLUME_DRY_UP"
    | "HIGH_BREAKOUT_ACCEPTED"
    | "HIGH_REJECTION_DISTRIBUTION"
    | "LOW_BREAKDOWN_ACCEPTED"
    | "LOW_RECLAIM_ACCUMULATION"
    | "ABSORPTION_ROTATION",
) {
  return {
    INSUFFICIENT: "样本不足",
    NORMAL: "普通量能",
    LOW_VOLUME_DRY_UP: "低位缩量，抛压衰减，等待价格收回确认",
    HIGH_VOLUME_DRY_UP: "高位缩量，追价动能不足",
    HIGH_BREAKOUT_ACCEPTED: "高位放量后仍站稳",
    HIGH_REJECTION_DISTRIBUTION: "高位放量但冲高回落",
    LOW_BREAKDOWN_ACCEPTED: "低位放量后仍向下",
    LOW_RECLAIM_ACCUMULATION: "低位放量后重新收回",
    ABSORPTION_ROTATION: "放量换手但方向未决",
  }[kind];
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function median(values: number[]) {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validCandle(candle: Candle) {
  return (
    Number.isFinite(candle.openTime) &&
    [candle.open, candle.high, candle.low, candle.close].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    candle.high >= candle.low
  );
}

function formatRatio(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "--"
    : `${value.toFixed(2)}×`;
}
