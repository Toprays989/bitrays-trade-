export type BreakoutRetestTriggerConfig = Readonly<{
  lookbackCandles: number;
  maximumRetestCandles: number;
  minimumBreakoutBps: number;
  retestToleranceBps: number;
  minimumBreakoutVolumeRatio: number;
  maxFactAgeMs: number;
  scanIntervalSeconds: number;
  maxWakeCandidatesPerCycle: number;
}>;

export const DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG:
  BreakoutRetestTriggerConfig = Object.freeze({
    lookbackCandles: 24,
    maximumRetestCandles: 4,
    minimumBreakoutBps: 20,
    retestToleranceBps: 15,
    minimumBreakoutVolumeRatio: 1.5,
    maxFactAgeMs: 360_000,
    scanIntervalSeconds: 30,
    maxWakeCandidatesPerCycle: 1,
  });

export function normalizeBreakoutRetestTriggerConfig(
  value: unknown,
): BreakoutRetestTriggerConfig {
  const input = isRecord(value) ? value : {};
  return {
    lookbackCandles: integerOr(
      input.lookbackCandles,
      DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG.lookbackCandles,
    ),
    maximumRetestCandles: integerOr(
      input.maximumRetestCandles,
      DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG.maximumRetestCandles,
    ),
    minimumBreakoutBps: finiteOr(
      input.minimumBreakoutBps,
      DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG.minimumBreakoutBps,
    ),
    retestToleranceBps: finiteOr(
      input.retestToleranceBps,
      DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG.retestToleranceBps,
    ),
    minimumBreakoutVolumeRatio: finiteOr(
      input.minimumBreakoutVolumeRatio,
      DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG.minimumBreakoutVolumeRatio,
    ),
    maxFactAgeMs: integerOr(
      input.maxFactAgeMs,
      DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG.maxFactAgeMs,
    ),
    scanIntervalSeconds: integerOr(
      input.scanIntervalSeconds,
      DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG.scanIntervalSeconds,
    ),
    maxWakeCandidatesPerCycle: integerOr(
      input.maxWakeCandidatesPerCycle,
      DEFAULT_BREAKOUT_RETEST_TRIGGER_CONFIG.maxWakeCandidatesPerCycle,
    ),
  };
}

export function validateBreakoutRetestTriggerConfig(value: unknown) {
  if (!isRecord(value)) return "请配置突破回踩触发参数";
  if (!integerInRange(value.lookbackCandles, 10, 80))
    return "突破结构回看需为 10 至 80 根 K 线";
  if (!integerInRange(value.maximumRetestCandles, 1, 6))
    return "突破后回踩需在 1 至 6 根 K 线内完成";
  if (!finiteInRange(value.minimumBreakoutBps, 1, 1_000))
    return "最小突破距离需为 1 至 1000 bp";
  if (!finiteInRange(value.retestToleranceBps, 1, 1_000))
    return "回踩容差需为 1 至 1000 bp";
  if (!finiteInRange(value.minimumBreakoutVolumeRatio, 0.5, 10))
    return "突破成交量倍数需为 0.5 至 10";
  if (!integerInRange(value.maxFactAgeMs, 60_000, 900_000))
    return "突破回踩闭合行情最大延迟需为 60000 至 900000 毫秒";
  if (!integerInRange(value.scanIntervalSeconds, 5, 3_600))
    return "突破回踩扫描间隔需为 5 至 3600 秒";
  if (!integerInRange(value.maxWakeCandidatesPerCycle, 1, 10))
    return "突破回踩每轮候选上限需为 1 至 10 个";
  return null;
}

function finiteOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function integerOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : fallback;
}

function finiteInRange(value: unknown, min: number, max: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= min && numeric <= max;
}

function integerInRange(value: unknown, min: number, max: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= min && numeric <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
