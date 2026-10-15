export type GridPriceLevelTriggerConfig = Readonly<{
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  activationToleranceBps: number;
  maxFactAgeMs: number;
  scanIntervalSeconds: number;
}>;

export const DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG:
  GridPriceLevelTriggerConfig = Object.freeze({
    lowerPrice: 0,
    upperPrice: 0,
    gridCount: 8,
    activationToleranceBps: 8,
    maxFactAgeMs: 3_000,
    scanIntervalSeconds: 3,
  });

export function normalizeGridPriceLevelTriggerConfig(
  value: unknown,
): GridPriceLevelTriggerConfig {
  const input = isRecord(value) ? value : {};
  return {
    lowerPrice: finiteOr(
      input.lowerPrice,
      DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG.lowerPrice,
    ),
    upperPrice: finiteOr(
      input.upperPrice,
      DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG.upperPrice,
    ),
    gridCount: integerOr(
      input.gridCount,
      DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG.gridCount,
    ),
    activationToleranceBps: finiteOr(
      input.activationToleranceBps,
      DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG.activationToleranceBps,
    ),
    maxFactAgeMs: integerOr(
      input.maxFactAgeMs,
      DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG.maxFactAgeMs,
    ),
    scanIntervalSeconds: integerOr(
      input.scanIntervalSeconds,
      DEFAULT_GRID_PRICE_LEVEL_TRIGGER_CONFIG.scanIntervalSeconds,
    ),
  };
}

export function validateGridPriceLevelTriggerConfig(value: unknown) {
  if (!isRecord(value)) return "请配置网格价位触发参数";
  if (!finiteInRange(value.lowerPrice, Number.EPSILON))
    return "网格下沿价格必须大于 0";
  if (!finiteInRange(value.upperPrice, Number.EPSILON))
    return "网格上沿价格必须大于 0";
  if (Number(value.upperPrice) <= Number(value.lowerPrice))
    return "网格上沿价格必须高于下沿价格";
  if (!integerInRange(value.gridCount, 2, 100))
    return "网格数量需为 2 至 100 格";
  if (!finiteInRange(value.activationToleranceBps, 1, 500))
    return "网格触发容差需为 1 至 500 bp";
  if (!integerInRange(value.maxFactAgeMs, 1_000, 30_000))
    return "网格标记价格最大延迟需为 1000 至 30000 毫秒";
  if (!integerInRange(value.scanIntervalSeconds, 1, 3_600))
    return "网格扫描间隔需为 1 至 3600 秒";
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

function finiteInRange(value: unknown, min: number, max = Number.POSITIVE_INFINITY) {
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
