import type { NexusUnifiedCandle } from "./nexus-unified-market-data";

export const NEXUS_TEMPORAL_SHADOW_VERSION =
  "nexus-temporal-shadow-v1" as const;

export type NexusTemporalPhase =
  | "UPSIDE_EXPANSION"
  | "DOWNSIDE_EXPANSION"
  | "VOLATILE_NOISE"
  | "MEAN_REVERSION_WATCH"
  | "TREND_PERSISTENCE"
  | "NO_DECISIVE_CHANGE"
  | "INSUFFICIENT";

export type NexusTemporalShadow = {
  version: typeof NEXUS_TEMPORAL_SHADOW_VERSION;
  status: "READY" | "INSUFFICIENT";
  phase: NexusTemporalPhase;
  returnShift: "UP" | "DOWN" | "NONE" | "INSUFFICIENT";
  contextDirection: "UP" | "DOWN" | "FLAT" | "INSUFFICIENT";
  volatility: "EXPANDING" | "STABLE" | "CONTRACTING" | "INSUFFICIENT";
  volumeShift: "UP" | "DOWN" | "STABLE" | "INSUFFICIENT";
  persistence: "TRENDING" | "MEAN_REVERTING" | "NOISY" | "NEUTRAL" | "INSUFFICIENT";
  metrics: {
    executionSamples: number;
    contextSamples: number;
    returnShiftScore: number | null;
    volatilityRatio: number | null;
    volumeShiftScore: number | null;
    volumeRatio: number | null;
    returnEntropy: number | null;
    medianCrossingRate: number | null;
    lag1Autocorrelation: number | null;
    contextReturnPercent: number | null;
    latestExecutionCloseAt: number | null;
    latestContextCloseAt: number | null;
  };
  missing: string[];
  summary: string;
  source: "NATIVE_LIGHTWEIGHT";
  researchGate: "SHADOW_ONLY";
  learningOnly: true;
  orderAffecting: false;
};

/**
 * 把离线时序研究中相对稳定、计算成本低的统计量移植为旁路观察。
 * 只读取已经由统一行情缓存取得的已收盘 K 线，不发起网络请求，也不
 * 参与开仓放行、拒单或仓位保护。研究门禁通过前只能用于学习分组和复盘。
 */
export function analyzeNexusTemporalShadow(input: {
  executionCandles: NexusUnifiedCandle[];
  contextCandles: NexusUnifiedCandle[];
  evaluatedAt: number;
  executionIntervalMs?: number;
  contextIntervalMs?: number;
}): NexusTemporalShadow {
  const executionIntervalMs = input.executionIntervalMs ?? 60_000;
  const contextIntervalMs = input.contextIntervalMs ?? 15 * 60_000;
  const execution = normalizedClosedCandles(
    input.executionCandles,
    input.evaluatedAt,
    executionIntervalMs,
  );
  const context = normalizedClosedCandles(
    input.contextCandles,
    input.evaluatedAt,
    contextIntervalMs,
  );
  const missing: string[] = [];
  if (execution.length < 40) missing.push("至少40根已收盘执行周期K线");
  if (context.length < 12) missing.push("至少12根已收盘背景周期K线");

  if (missing.length) {
    return insufficient(execution, context, missing, executionIntervalMs, contextIntervalMs);
  }

  const closes = execution.map((row) => row.close);
  const returns = logReturns(closes);
  const volumes = execution.map((row) => Math.max(0, row.quoteVolume ?? row.volume));
  const recentReturnWindow = returns.slice(-8);
  const baselineReturnWindow = returns.slice(-28, -8);
  const returnShiftScore = standardizedMeanShift(
    baselineReturnWindow,
    recentReturnWindow,
  );
  const returnShift = returnShiftScore >= 1.5
    ? "UP"
    : returnShiftScore <= -1.5
      ? "DOWN"
      : "NONE";
  const volatilityRatio = ratio(
    sampleStandardDeviation(recentReturnWindow),
    sampleStandardDeviation(baselineReturnWindow),
  );
  const volatility = volatilityRatio === null
    ? "STABLE"
    : volatilityRatio >= 1.25
      ? "EXPANDING"
      : volatilityRatio <= 0.8
        ? "CONTRACTING"
        : "STABLE";

  const recentVolumes = volumes.slice(-8);
  const baselineVolumes = volumes.slice(-28, -8);
  const volumeShiftScore = standardizedMedianShift(
    baselineVolumes,
    recentVolumes,
  );
  const volumeRatio = ratio(mean(recentVolumes), mean(baselineVolumes));
  const volumeShift = volumeShiftScore >= 1
    ? "UP"
    : volumeShiftScore <= -1
      ? "DOWN"
      : "STABLE";

  const structureReturns = returns.slice(-24);
  const returnEntropy = normalizedEntropy(structureReturns);
  const medianCrossingRate = crossingRate(structureReturns);
  const lag1Autocorrelation = lagAutocorrelation(structureReturns);
  const persistence = classifyPersistence({
    entropy: returnEntropy,
    crossingRate: medianCrossingRate,
    autocorrelation: lag1Autocorrelation,
  });
  const contextSlice = context.slice(-12);
  const contextReturnPercent =
    ((contextSlice.at(-1)!.close / contextSlice[0]!.open) - 1) * 100;
  const contextNoisePercent =
    sampleStandardDeviation(logReturns(contextSlice.map((row) => row.close))) *
    100;
  const contextDirection = Math.abs(contextReturnPercent) < Math.max(0.1, contextNoisePercent)
    ? "FLAT"
    : contextReturnPercent > 0
      ? "UP"
      : "DOWN";

  const phase = classifyPhase({
    returnShift,
    volatility,
    volumeShift,
    persistence,
  });
  const metrics = {
    executionSamples: execution.length,
    contextSamples: context.length,
    returnShiftScore: rounded(returnShiftScore),
    volatilityRatio: roundedOrNull(volatilityRatio),
    volumeShiftScore: rounded(volumeShiftScore),
    volumeRatio: roundedOrNull(volumeRatio),
    returnEntropy: rounded(returnEntropy),
    medianCrossingRate: rounded(medianCrossingRate),
    lag1Autocorrelation: roundedOrNull(lag1Autocorrelation),
    contextReturnPercent: rounded(contextReturnPercent),
    latestExecutionCloseAt:
      execution.at(-1)!.openTime + executionIntervalMs - 1,
    latestContextCloseAt: context.at(-1)!.openTime + contextIntervalMs - 1,
  };

  return {
    version: NEXUS_TEMPORAL_SHADOW_VERSION,
    status: "READY",
    phase,
    returnShift,
    contextDirection,
    volatility,
    volumeShift,
    persistence,
    metrics,
    missing: [],
    summary:
      `时序旁路 ${phase}：收益变点 ${returnShift}、波动 ${volatility}、` +
      `成交量位移 ${volumeShift}、序列特征 ${persistence}、` +
      `背景方向 ${contextDirection}。仅用于学习与复盘。`,
    source: "NATIVE_LIGHTWEIGHT",
    researchGate: "SHADOW_ONLY",
    learningOnly: true,
    orderAffecting: false,
  };
}

function insufficient(
  execution: NexusUnifiedCandle[],
  context: NexusUnifiedCandle[],
  missing: string[],
  executionIntervalMs: number,
  contextIntervalMs: number,
): NexusTemporalShadow {
  return {
    version: NEXUS_TEMPORAL_SHADOW_VERSION,
    status: "INSUFFICIENT",
    phase: "INSUFFICIENT",
    returnShift: "INSUFFICIENT",
    contextDirection: "INSUFFICIENT",
    volatility: "INSUFFICIENT",
    volumeShift: "INSUFFICIENT",
    persistence: "INSUFFICIENT",
    metrics: {
      executionSamples: execution.length,
      contextSamples: context.length,
      returnShiftScore: null,
      volatilityRatio: null,
      volumeShiftScore: null,
      volumeRatio: null,
      returnEntropy: null,
      medianCrossingRate: null,
      lag1Autocorrelation: null,
      contextReturnPercent: null,
      latestExecutionCloseAt: execution.at(-1)
        ? execution.at(-1)!.openTime + executionIntervalMs - 1
        : null,
      latestContextCloseAt: context.at(-1)
        ? context.at(-1)!.openTime + contextIntervalMs - 1
        : null,
    },
    missing,
    summary: `时序旁路样本不足：${missing.join("、")}。不影响订单判断。`,
    source: "NATIVE_LIGHTWEIGHT",
    researchGate: "SHADOW_ONLY",
    learningOnly: true,
    orderAffecting: false,
  };
}

function normalizedClosedCandles(
  rows: NexusUnifiedCandle[],
  evaluatedAt: number,
  intervalMs: number,
) {
  const byOpenTime = new Map<number, NexusUnifiedCandle>();
  for (const row of rows) {
    if (
      !Number.isFinite(row.openTime) ||
      row.openTime < 0 ||
      row.openTime + intervalMs - 1 > evaluatedAt ||
      ![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) ||
      row.open <= 0 ||
      row.high <= 0 ||
      row.low <= 0 ||
      row.close <= 0 ||
      row.volume < 0
    ) continue;
    byOpenTime.set(row.openTime, row);
  }
  return [...byOpenTime.values()].sort((left, right) => left.openTime - right.openTime);
}

function classifyPhase(input: {
  returnShift: NexusTemporalShadow["returnShift"];
  volatility: NexusTemporalShadow["volatility"];
  volumeShift: NexusTemporalShadow["volumeShift"];
  persistence: NexusTemporalShadow["persistence"];
}): NexusTemporalPhase {
  if (
    input.returnShift === "UP" &&
    (input.volatility === "EXPANDING" || input.volumeShift === "UP")
  ) return "UPSIDE_EXPANSION";
  if (
    input.returnShift === "DOWN" &&
    (input.volatility === "EXPANDING" || input.volumeShift === "UP")
  ) return "DOWNSIDE_EXPANSION";
  if (input.volatility === "EXPANDING" && input.persistence === "NOISY")
    return "VOLATILE_NOISE";
  if (input.persistence === "MEAN_REVERTING") return "MEAN_REVERSION_WATCH";
  if (input.persistence === "TRENDING") return "TREND_PERSISTENCE";
  return "NO_DECISIVE_CHANGE";
}

function classifyPersistence(input: {
  entropy: number;
  crossingRate: number;
  autocorrelation: number | null;
}): NexusTemporalShadow["persistence"] {
  if (input.entropy >= 0.8 && input.crossingRate >= 0.5) return "NOISY";
  if (input.autocorrelation !== null && input.autocorrelation <= -0.2)
    return "MEAN_REVERTING";
  if (
    input.autocorrelation !== null &&
    input.autocorrelation >= 0.2 &&
    input.crossingRate <= 0.45
  ) return "TRENDING";
  return "NEUTRAL";
}

function logReturns(values: number[]) {
  const rows: number[] = [];
  for (let index = 1; index < values.length; index += 1)
    rows.push(Math.log(values[index]! / values[index - 1]!));
  return rows;
}

function standardizedMeanShift(before: number[], recent: number[]) {
  return (mean(recent) - mean(before)) / robustScale([...before, ...recent]);
}

function standardizedMedianShift(before: number[], recent: number[]) {
  return (median(recent) - median(before)) / robustScale([...before, ...recent]);
}

function robustScale(values: number[]) {
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  if (mad > 1e-15) return mad * 1.4826;
  return Math.max(sampleStandardDeviation(values), 1e-12);
}

function normalizedEntropy(values: number[], bins = 8) {
  if (!values.length) return 0;
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (high - low <= 1e-15) return 0;
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of values) {
    const index = Math.min(
      bins - 1,
      Math.floor(((value - low) / (high - low)) * bins),
    );
    counts[index] += 1;
  }
  let entropy = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / values.length;
    entropy -= probability * Math.log(probability);
  }
  return entropy / Math.log(bins);
}

function crossingRate(values: number[]) {
  if (values.length < 2) return 0;
  const center = median(values);
  const signs = values
    .map((value) => value > center ? 1 : value < center ? -1 : 0)
    .filter((value) => value !== 0);
  if (signs.length < 2) return 0;
  let crossings = 0;
  for (let index = 1; index < signs.length; index += 1)
    if (signs[index] !== signs[index - 1]) crossings += 1;
  return crossings / (signs.length - 1);
}

function lagAutocorrelation(values: number[]) {
  if (values.length <= 3) return null;
  const left = values.slice(0, -1);
  const right = values.slice(1);
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index]! - leftMean;
    const rightDelta = right[index]! - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquare += leftDelta ** 2;
    rightSquare += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator <= 1e-15 ? null : numerator / denominator;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sampleStandardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1),
  );
}

function ratio(numerator: number, denominator: number) {
  if (denominator <= 1e-15)
    return numerator <= 1e-15 ? null : 999;
  return numerator / denominator;
}

function rounded(value: number) {
  return Number(value.toFixed(6));
}

function roundedOrNull(value: number | null) {
  return value === null || !Number.isFinite(value) ? null : rounded(value);
}
