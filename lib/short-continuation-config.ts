import {
  DEFAULT_SHORT_CONTINUATION_CONFIG,
  type ShortContinuationConfig,
} from "./short-downtrend-continuation.ts";

export type ShortContinuationStrategyConfig = ShortContinuationConfig & {
  selectedSymbols: string[];
  leverage: number;
  stopLossRoePercent: number;
  takeProfits: Array<{
    triggerRoePercent: number;
    closePercent: number;
  }>;
  trailingActivationRoePercent: number;
  trailingGivebackRoePoints: number;
};

export const DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG:
  ShortContinuationStrategyConfig = {
    ...DEFAULT_SHORT_CONTINUATION_CONFIG,
    selectedSymbols: [],
    leverage: 10,
    stopLossRoePercent: 20,
    takeProfits: [
      { triggerRoePercent: 10, closePercent: 50 },
      { triggerRoePercent: 20, closePercent: 50 },
    ],
    trailingActivationRoePercent: 10,
    trailingGivebackRoePoints: 5,
  };

export function normalizeShortContinuationStrategyConfig(
  value: unknown,
): ShortContinuationStrategyConfig {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<ShortContinuationStrategyConfig>)
      : {};
  return {
    selectedSymbols: Array.isArray(input.selectedSymbols)
      ? [
          ...new Set(
            input.selectedSymbols
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim().toUpperCase())
              .filter(Boolean),
          ),
        ]
      : [],
    minimumLongLiquidationSharePercent: positiveOr(
      input.minimumLongLiquidationSharePercent,
      DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG.minimumLongLiquidationSharePercent,
    ),
    minimumVolumeRatio3m: positiveOr(
      input.minimumVolumeRatio3m,
      DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG.minimumVolumeRatio3m,
    ),
    maximumChaseDistanceAtr: positiveOr(
      input.maximumChaseDistanceAtr,
      DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG.maximumChaseDistanceAtr,
    ),
    maximumMarketDataAgeMs: integerOr(
      input.maximumMarketDataAgeMs,
      DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG.maximumMarketDataAgeMs,
    ),
    leverage: integerOr(
      input.leverage,
      DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG.leverage,
    ),
    stopLossRoePercent: positiveOr(
      input.stopLossRoePercent,
      DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG.stopLossRoePercent,
    ),
    takeProfits: normalizeTakeProfits(input.takeProfits),
    trailingActivationRoePercent: positiveOr(
      input.trailingActivationRoePercent,
      DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG.trailingActivationRoePercent,
    ),
    trailingGivebackRoePoints: positiveOr(
      input.trailingGivebackRoePoints,
      DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG.trailingGivebackRoePoints,
    ),
  };
}

export function validateShortContinuationStrategyConfig(value: unknown) {
  const config = normalizeShortContinuationStrategyConfig(value);
  if (
    config.selectedSymbols.some(
      (symbol) => !/^[A-Z0-9]{1,20}USDT$/.test(symbol),
    )
  )
    return "做空策略包含无效合约";
  if (
    config.minimumLongLiquidationSharePercent < 50 ||
    config.minimumLongLiquidationSharePercent > 100
  )
    return "1小时多头爆仓占比需为 50% 至 100%";
  if (config.minimumVolumeRatio3m > 20)
    return "3分钟量比上限为 20";
  if (config.maximumChaseDistanceAtr > 10)
    return "最大追空距离上限为 10 ATR";
  if (
    config.maximumMarketDataAgeMs < 100 ||
    config.maximumMarketDataAgeMs > 10_000
  )
    return "行情新鲜度需为 100 至 10000 毫秒";
  if (config.leverage < 1 || config.leverage > 20)
    return "做空杠杆需为 1 至 20 倍";
  if (!config.takeProfits.length) return "至少需要一个做空止盈层级";
  const totalClosePercent = config.takeProfits.reduce(
    (sum, level) => sum + level.closePercent,
    0,
  );
  if (Math.abs(totalClosePercent - 100) > 1e-9)
    return "做空止盈比例必须合计 100%";
  return null;
}

function normalizeTakeProfits(
  value: ShortContinuationStrategyConfig["takeProfits"] | undefined,
) {
  const normalized = Array.isArray(value)
    ? value
        .map((level) => ({
          triggerRoePercent: Number(level?.triggerRoePercent),
          closePercent: Number(level?.closePercent),
        }))
        .filter(
          (level) =>
            Number.isFinite(level.triggerRoePercent) &&
            level.triggerRoePercent > 0 &&
            Number.isFinite(level.closePercent) &&
            level.closePercent > 0 &&
            level.closePercent <= 100,
        )
        .sort(
          (left, right) =>
            left.triggerRoePercent - right.triggerRoePercent,
        )
    : [];
  return normalized.length
    ? normalized
    : DEFAULT_SHORT_CONTINUATION_STRATEGY_CONFIG.takeProfits.map((level) => ({
        ...level,
      }));
}

function positiveOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function integerOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}
