export type ScheduledScanTriggerConfig = Readonly<{
  intervalSeconds: number;
  maxFactAgeMs: number;
  maxWakeCandidatesPerCycle: number;
  scanAllSymbols: boolean;
}>;

export const DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG:
  ScheduledScanTriggerConfig = Object.freeze({
    intervalSeconds: 300,
    maxFactAgeMs: 360_000,
    maxWakeCandidatesPerCycle: 1,
    scanAllSymbols: false,
  });

export function normalizeScheduledScanTriggerConfig(
  value: unknown,
): ScheduledScanTriggerConfig {
  const input = isRecord(value) ? value : {};
  return {
    intervalSeconds: integerOr(
      input.intervalSeconds,
      DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG.intervalSeconds,
    ),
    maxFactAgeMs: integerOr(
      input.maxFactAgeMs,
      DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG.maxFactAgeMs,
    ),
    maxWakeCandidatesPerCycle: integerOr(
      input.maxWakeCandidatesPerCycle,
      DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG.maxWakeCandidatesPerCycle,
    ),
    scanAllSymbols: typeof input.scanAllSymbols === "boolean"
      ? input.scanAllSymbols
      : DEFAULT_SCHEDULED_SCAN_TRIGGER_CONFIG.scanAllSymbols,
  };
}

export function validateScheduledScanTriggerConfig(value: unknown) {
  if (!isRecord(value)) return "请配置定时扫描触发参数";
  if (!integerInRange(value.intervalSeconds, 60, 86_400))
    return "定时扫描周期需为 60 至 86400 秒";
  if (!integerInRange(value.maxFactAgeMs, 60_000, 900_000))
    return "定时扫描闭合行情最大延迟需为 60000 至 900000 毫秒";
  if (!integerInRange(value.maxWakeCandidatesPerCycle, 1, 10))
    return "定时扫描每轮合约上限需为 1 至 10 个";
  if (typeof value.scanAllSymbols !== "boolean")
    return "定时扫描全合约覆盖参数无效";
  return null;
}

function integerOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : fallback;
}

function integerInRange(value: unknown, min: number, max: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= min && numeric <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
