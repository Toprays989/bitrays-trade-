import { createNexusMarketFact } from "./nexus-market-facts.ts";

export const NEXUS_PRICE_IMPULSE_VERSION =
  "nexus-price-impulse-v3" as const;

export type NexusImpulseCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume?: number;
};

export function analyzeNexusLiquidationPriceImpulse(input: {
  candles: NexusImpulseCandle[];
  triggerEventAt: number;
  triggerPrice?: number | null;
  liquidationSide: "BUY" | "SELL";
  evaluatedAt?: number;
  contextMinutes?: number;
  minimumContextObservations?: number;
  windowMinutes?: number;
  minimumMovePercent?: number;
  noiseMultiplier?: number;
}) {
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const contextMinutes = Math.min(
    60,
    Math.max(10, Math.trunc(input.contextMinutes ?? 30)),
  );
  const minimumContextObservations = Math.min(
    contextMinutes,
    Math.max(
      10,
      Math.trunc(
        input.minimumContextObservations ??
          Math.ceil(contextMinutes * (2 / 3)),
      ),
    ),
  );
  const windowMinutes = Math.min(
    5,
    Math.max(1, Math.trunc(input.windowMinutes ?? 3)),
  );
  const windowMs = windowMinutes * 60_000;
  const contextCandles = input.candles
    .filter(validCandle)
    .filter(
      (candle) =>
        candle.openTime + 60_000 - 1 <= input.triggerEventAt &&
        candle.openTime >=
          input.triggerEventAt - contextMinutes * 60_000 &&
        candle.openTime <= input.triggerEventAt,
    )
    .sort((left, right) => left.openTime - right.openTime);
  const timingCandles = contextCandles.filter(
    (candle) => candle.openTime >= input.triggerEventAt - windowMs,
  );
  const expectedDirection =
    input.liquidationSide === "SELL" ? "DOWN" : "UP";
  const triggerPrice =
    Number.isFinite(input.triggerPrice) && Number(input.triggerPrice) > 0
      ? Number(input.triggerPrice)
      : null;
  const referencePrice = timingCandles.at(0)?.open ?? null;
  const extremePrice =
    referencePrice === null || timingCandles.length === 0
      ? null
      : expectedDirection === "DOWN"
        ? Math.min(
            ...timingCandles.map((candle) => candle.low),
            triggerPrice ?? Number.POSITIVE_INFINITY,
          )
        : Math.max(
            ...timingCandles.map((candle) => candle.high),
            triggerPrice ?? Number.NEGATIVE_INFINITY,
          );
  const signedMovePercent =
    referencePrice !== null && extremePrice !== null
      ? ((extremePrice - referencePrice) / referencePrice) * 100
      : null;
  const magnitudePercent =
    signedMovePercent === null ? null : Math.abs(signedMovePercent);
  const noisePercent = recentMedianAbsoluteReturnPercent(
    contextCandles.filter(
      (candle) => candle.openTime < input.triggerEventAt - windowMs,
    ),
  );
  const thresholdPercent = Math.max(
    0.2,
    input.minimumMovePercent ?? 0,
    (noisePercent ?? 0) * Math.max(1, input.noiseMultiplier ?? 2),
  );
  const directionMatched =
    signedMovePercent !== null &&
    (expectedDirection === "DOWN"
      ? signedMovePercent < 0
      : signedMovePercent > 0);
  const contextComplete =
    contextCandles.length >= minimumContextObservations;
  const priceImpulseConfirmed =
    timingCandles.length > 0 &&
    directionMatched &&
    magnitudePercent !== null &&
    magnitudePercent >= thresholdPercent;
  const contextQuoteVolume = sumQuoteVolume(contextCandles);
  const timingQuoteVolume = sumQuoteVolume(timingCandles);
  const baselineCandles = contextCandles.filter(
    (candle) => candle.openTime < input.triggerEventAt - windowMs,
  );
  const baselineQuoteVolume = sumQuoteVolume(baselineCandles);
  const timingAverageQuoteVolume =
    timingQuoteVolume !== null && timingCandles.length > 0
      ? timingQuoteVolume / timingCandles.length
      : null;
  const baselineAverageQuoteVolume =
    baselineQuoteVolume !== null && baselineCandles.length > 0
      ? baselineQuoteVolume / baselineCandles.length
      : null;
  const timingVolumeRatio =
    timingAverageQuoteVolume !== null &&
    baselineAverageQuoteVolume !== null &&
    baselineAverageQuoteVolume > 0
      ? timingAverageQuoteVolume / baselineAverageQuoteVolume
      : null;
  const timingVolumeSharePercent =
    timingQuoteVolume !== null &&
    contextQuoteVolume !== null &&
    contextQuoteVolume > 0
      ? (timingQuoteVolume / contextQuoteVolume) * 100
      : null;
  const volumeConcentrated =
    timingVolumeRatio !== null &&
    timingVolumeSharePercent !== null &&
    timingVolumeRatio >= 1.5 &&
    timingVolumeSharePercent >= 15;
  const confirmed = contextComplete && priceImpulseConfirmed;
  const opportunityPoolEligible =
    confirmed && volumeConcentrated;
  const contextStartPrice = contextCandles.at(0)?.open ?? null;
  const contextEndPrice =
    triggerPrice ?? contextCandles.at(-1)?.close ?? null;
  const contextReturnPercent =
    contextStartPrice !== null && contextEndPrice !== null
      ? ((contextEndPrice - contextStartPrice) / contextStartPrice) * 100
      : null;
  const contextHigh =
    contextCandles.length > 0
      ? Math.max(
          ...contextCandles.map((candle) => candle.high),
          triggerPrice ?? Number.NEGATIVE_INFINITY,
        )
      : null;
  const contextLow =
    contextCandles.length > 0
      ? Math.min(
          ...contextCandles.map((candle) => candle.low),
          triggerPrice ?? Number.POSITIVE_INFINITY,
        )
      : null;
  const contextRangePercent =
    contextStartPrice !== null &&
    contextHigh !== null &&
    contextLow !== null
      ? ((contextHigh - contextLow) / contextStartPrice) * 100
      : null;
  const contextPricePositionPercent =
    contextEndPrice !== null &&
    contextHigh !== null &&
    contextLow !== null &&
    contextHigh > contextLow
      ? ((contextEndPrice - contextLow) /
          (contextHigh - contextLow)) *
        100
      : null;
  const contextTrend = classifyContextTrend({
    contextReturnPercent,
    noisePercent,
  });
  const priorEndPrice =
    contextCandles
      .filter(
        (candle) =>
          candle.openTime < input.triggerEventAt - windowMs,
      )
      .at(-1)?.close ?? contextStartPrice;
  const priorMovePercent =
    contextStartPrice !== null && priorEndPrice !== null
      ? ((priorEndPrice - contextStartPrice) / contextStartPrice) *
        100
      : null;
  const timingEndPrice =
    triggerPrice ?? timingCandles.at(-1)?.close ?? null;
  const timingStartPrice = timingCandles.at(0)?.open ?? null;
  const timingReturnPercent =
    timingStartPrice !== null && timingEndPrice !== null
      ? ((timingEndPrice - timingStartPrice) / timingStartPrice) *
        100
      : null;
  const contextPhase = classifyContextPhase({
    contextTrend,
    priorMovePercent,
    priorMinutes: Math.max(1, contextMinutes - windowMinutes),
    timingReturnPercent,
    timingMinutes: windowMinutes,
  });
  const candidateScenarios = liquidationCandidateScenarios({
    liquidationSide: input.liquidationSide,
    contextTrend,
    contextPhase,
  });
  return {
    version: NEXUS_PRICE_IMPULSE_VERSION,
    confirmed,
    expectedDirection,
    observedDirection:
      signedMovePercent === null || signedMovePercent === 0
        ? "UNKNOWN"
        : signedMovePercent > 0
          ? "UP"
          : "DOWN",
    liquidationSide: input.liquidationSide,
    triggerEventAt: input.triggerEventAt,
    evaluatedAt,
    contextMinutes,
    contextComplete,
    contextObservations: contextCandles.length,
    minimumContextObservations,
    contextStartPrice,
    contextEndPrice,
    contextReturnPercent,
    contextHigh,
    contextLow,
    contextRangePercent,
    contextPricePositionPercent,
    contextTrend,
    contextPhase,
    priorMovePercent,
    timingReturnPercent,
    candidateScenarios,
    priceImpulseConfirmed,
    contextQuoteVolume,
    timingQuoteVolume,
    timingVolumeRatio,
    timingVolumeSharePercent,
    volumeConcentrated,
    opportunityPoolEligible,
    windowMinutes,
    observations:
      timingCandles.length + (triggerPrice === null ? 0 : 1),
    referencePrice,
    triggerPrice,
    extremePrice,
    signedMovePercent,
    magnitudePercent,
    speedPercentPerMinute:
      magnitudePercent === null ? null : magnitudePercent / windowMinutes,
    noisePercent,
    thresholdPercent,
    reason:
      !contextComplete
        ? `过去${contextMinutes}分钟背景样本不足`
        : timingCandles.length === 0
          ? `最近${windowMinutes}分钟缺少入场节奏数据`
        : !directionMatched
          ? "价格脉冲方向与被强平仓位方向不一致"
          : !priceImpulseConfirmed
            ? `过去${contextMinutes}分钟背景已分析，但爆仓触发缺少对应的快速价格位移`
            : !volumeConcentrated
              ? `价格冲击有效，爆仓前成交量尚未集中；继续等待爆仓后的结构与放量`
              : `价格快速变化且成交量集中，进入候选机会池；方向仍由大脑结构判断`,
    orderAffecting: false as const,
  };
}

export function nexusLiquidationContextSummary(
  impulse: ReturnType<typeof analyzeNexusLiquidationPriceImpulse>,
) {
  const trend = {
    UP: "上行",
    DOWN: "下行",
    RANGE: "震荡",
    INSUFFICIENT: "样本不足",
  }[impulse.contextTrend];
  const phase = {
    ACCELERATING: "加速",
    DECELERATING: "减速",
    REVERSING: "方向切换",
    STABLE: "延续",
    INSUFFICIENT: "样本不足",
  }[impulse.contextPhase];
  return (
    `爆仓前${impulse.contextMinutes}分钟：${trend}/${phase}` +
    `，区间位置${formatPercent(impulse.contextPricePositionPercent)}` +
    `，累计变化${formatSignedPercent(impulse.contextReturnPercent)}` +
    `，成交量集中比${formatRatio(impulse.timingVolumeRatio)}` +
    `；候选情景：${impulse.candidateScenarios.join("、") || "等待更多事实"}` +
    `；最近${impulse.windowMinutes}分钟仅校验触发速度，不单独决定下单`
  );
}

export function liquidationPriceImpulseMarketFact(input: {
  symbol: string;
  eventAt: number;
  receivedAt: number;
  expiresAt: number;
  impulse: ReturnType<typeof analyzeNexusLiquidationPriceImpulse>;
}) {
  if (!input.impulse.confirmed) return null;
  return createNexusMarketFact({
    kind:
      input.impulse.expectedDirection === "UP"
        ? "PRICE_IMPULSE_UP"
        : "PRICE_IMPULSE_DOWN",
    symbol: input.symbol,
    interval: `${input.impulse.windowMinutes}m`,
    source: "SYSTEM_DERIVED",
    eventAt: input.eventAt,
    receivedAt: input.receivedAt,
    expiresAt: input.expiresAt,
    payload: { ...input.impulse },
  });
}

function recentMedianAbsoluteReturnPercent(candles: NexusImpulseCandle[]) {
  const returns: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1].close;
    const current = candles[index].close;
    if (previous <= 0 || current <= 0) continue;
    returns.push(Math.abs(((current - previous) / previous) * 100));
  }
  if (returns.length === 0) return null;
  returns.sort((left, right) => left - right);
  const middle = Math.floor(returns.length / 2);
  return returns.length % 2
    ? returns[middle]
    : (returns[middle - 1] + returns[middle]) / 2;
}

function sumQuoteVolume(candles: NexusImpulseCandle[]) {
  if (candles.length === 0) return null;
  let total = 0;
  for (const candle of candles) {
    const value = candle.quoteVolume;
    if (!Number.isFinite(value) || Number(value) < 0) return null;
    total += Number(value);
  }
  return total;
}

function classifyContextTrend(input: {
  contextReturnPercent: number | null;
  noisePercent: number | null;
}) {
  if (input.contextReturnPercent === null)
    return "INSUFFICIENT" as const;
  const threshold = Math.max(0.3, (input.noisePercent ?? 0) * 3);
  if (input.contextReturnPercent >= threshold) return "UP" as const;
  if (input.contextReturnPercent <= -threshold) return "DOWN" as const;
  return "RANGE" as const;
}

function classifyContextPhase(input: {
  contextTrend: "UP" | "DOWN" | "RANGE" | "INSUFFICIENT";
  priorMovePercent: number | null;
  priorMinutes: number;
  timingReturnPercent: number | null;
  timingMinutes: number;
}) {
  if (
    input.contextTrend === "INSUFFICIENT" ||
    input.priorMovePercent === null ||
    input.timingReturnPercent === null
  )
    return "INSUFFICIENT" as const;
  const priorDirection = Math.sign(input.priorMovePercent);
  const timingDirection = Math.sign(input.timingReturnPercent);
  if (
    priorDirection !== 0 &&
    timingDirection !== 0 &&
    priorDirection !== timingDirection
  )
    return "REVERSING" as const;
  const priorSpeed =
    Math.abs(input.priorMovePercent) / Math.max(1, input.priorMinutes);
  const timingSpeed =
    Math.abs(input.timingReturnPercent) / Math.max(1, input.timingMinutes);
  if (timingSpeed >= Math.max(0.05, priorSpeed * 1.5))
    return "ACCELERATING" as const;
  if (priorSpeed > 0 && timingSpeed <= priorSpeed * 0.6)
    return "DECELERATING" as const;
  return "STABLE" as const;
}

function liquidationCandidateScenarios(input: {
  liquidationSide: "BUY" | "SELL";
  contextTrend: "UP" | "DOWN" | "RANGE" | "INSUFFICIENT";
  contextPhase:
    | "ACCELERATING"
    | "DECELERATING"
    | "REVERSING"
    | "STABLE"
    | "INSUFFICIENT";
}) {
  if (
    input.contextTrend === "INSUFFICIENT" ||
    input.contextPhase === "INSUFFICIENT"
  )
    return [] as string[];
  if (input.liquidationSide === "SELL") {
    if (input.contextTrend === "DOWN")
      return input.contextPhase === "DECELERATING"
        ? ["下杀衰竭后反转"]
        : ["下跌延续", "下杀衰竭后反转"];
    if (input.contextTrend === "UP")
      return ["上升趋势内清洗多头后收回"];
    return ["震荡下沿收回", "跌破后延续"];
  }
  if (input.contextTrend === "UP")
    return input.contextPhase === "DECELERATING"
      ? ["拉升衰竭后反转"]
      : ["上涨延续", "拉升衰竭后反转"];
  if (input.contextTrend === "DOWN")
    return ["下降趋势内清洗空头后回落"];
  return ["震荡上沿回落", "突破后延续"];
}

function formatPercent(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "--"
    : `${value.toFixed(1)}%`;
}

function formatSignedPercent(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "--"
    : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatRatio(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "--"
    : `${value.toFixed(2)}×`;
}

function validCandle(candle: NexusImpulseCandle) {
  return (
    Number.isFinite(candle.openTime) &&
    [candle.open, candle.high, candle.low, candle.close].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    candle.high >= candle.low
  );
}
