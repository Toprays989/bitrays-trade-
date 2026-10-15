export type LowPositionWindowTriggerConfig = Readonly<{
  maxPosition72hPercent: number;
  maxFactAgeMs: number;
  scanIntervalSeconds: number;
  maxWakeCandidatesPerCycle: number;
}>;

export const DEFAULT_LOW_POSITION_WINDOW_TRIGGER_CONFIG:
  LowPositionWindowTriggerConfig = Object.freeze({
    maxPosition72hPercent: 25,
    maxFactAgeMs: 3_000,
    scanIntervalSeconds: 30,
    maxWakeCandidatesPerCycle: 1,
  });

export function normalizeLowPositionWindowTriggerConfig(
  value: unknown,
): LowPositionWindowTriggerConfig {
  const input = isRecord(value) ? value : {};
  return {
    maxPosition72hPercent: finiteOr(
      input.maxPosition72hPercent,
      DEFAULT_LOW_POSITION_WINDOW_TRIGGER_CONFIG.maxPosition72hPercent,
    ),
    maxFactAgeMs: integerOr(
      input.maxFactAgeMs,
      DEFAULT_LOW_POSITION_WINDOW_TRIGGER_CONFIG.maxFactAgeMs,
    ),
    scanIntervalSeconds: integerOr(
      input.scanIntervalSeconds,
      DEFAULT_LOW_POSITION_WINDOW_TRIGGER_CONFIG.scanIntervalSeconds,
    ),
    maxWakeCandidatesPerCycle: integerOr(
      input.maxWakeCandidatesPerCycle,
      DEFAULT_LOW_POSITION_WINDOW_TRIGGER_CONFIG.maxWakeCandidatesPerCycle,
    ),
  };
}

export function validateLowPositionWindowTriggerConfig(value: unknown) {
  if (!isRecord(value)) return "请配置低位价格触发参数";
  if (!finiteInRange(value.maxPosition72hPercent, 1, 60))
    return "72小时低位阈值需为 1% 至 60%";
  if (!integerInRange(value.maxFactAgeMs, 1_000, 30_000))
    return "标记价格最大延迟需为 1000 至 30000 毫秒";
  if (!integerInRange(value.scanIntervalSeconds, 5, 3_600))
    return "低位扫描间隔需为 5 至 3600 秒";
  if (!integerInRange(value.maxWakeCandidatesPerCycle, 1, 10))
    return "每轮候选上限需为 1 至 10 个";
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
