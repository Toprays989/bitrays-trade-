import type { NexusMarketContextSnapshot } from "./nexus-market-context-snapshot";
import type { NexusUnifiedCandle } from "./nexus-unified-market-data";

export type HighPositionShortConfig = {
  minimumQuoteVolume24hUsdt: number;
  minimumPosition24hPercent: number;
  minimumPosition72hPercent: number;
  minimumPosition30dPercent: number;
  minimumPosition60dPercent: number;
  minimumSellerVolumeRatio3m: number;
  resistanceRetestToleranceAtr: number;
  maximumMarketDataAgeMs: number;
  maximumEntryDistanceAtr: number;
  minimumRewardRiskRatio: number;
  estimatedRoundTripCostPercent: number;
};

export const DEFAULT_HIGH_POSITION_SHORT_CONFIG: HighPositionShortConfig = {
  minimumQuoteVolume24hUsdt: 300_000_000,
  minimumPosition24hPercent: 80,
  minimumPosition72hPercent: 75,
  minimumPosition30dPercent: 70,
  minimumPosition60dPercent: 65,
  minimumSellerVolumeRatio3m: 1.3,
  resistanceRetestToleranceAtr: 0.15,
  maximumMarketDataAgeMs: 2_000,
  maximumEntryDistanceAtr: 0.15,
  minimumRewardRiskRatio: 1.8,
  estimatedRoundTripCostPercent: 0.12,
};

export function normalizeHighPositionShortConfig(
  value?: Partial<HighPositionShortConfig> | null,
): HighPositionShortConfig {
  const source = value ?? {};
  return {
    minimumQuoteVolume24hUsdt: numberOrDefault(
      source.minimumQuoteVolume24hUsdt,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.minimumQuoteVolume24hUsdt,
    ),
    minimumPosition24hPercent: numberOrDefault(
      source.minimumPosition24hPercent,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.minimumPosition24hPercent,
    ),
    minimumPosition72hPercent: numberOrDefault(
      source.minimumPosition72hPercent,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.minimumPosition72hPercent,
    ),
    minimumPosition30dPercent: numberOrDefault(
      source.minimumPosition30dPercent,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.minimumPosition30dPercent,
    ),
    minimumPosition60dPercent: numberOrDefault(
      source.minimumPosition60dPercent,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.minimumPosition60dPercent,
    ),
    minimumSellerVolumeRatio3m: numberOrDefault(
      source.minimumSellerVolumeRatio3m,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.minimumSellerVolumeRatio3m,
    ),
    resistanceRetestToleranceAtr: numberOrDefault(
      source.resistanceRetestToleranceAtr,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.resistanceRetestToleranceAtr,
    ),
    maximumMarketDataAgeMs: numberOrDefault(
      source.maximumMarketDataAgeMs,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.maximumMarketDataAgeMs,
    ),
    maximumEntryDistanceAtr: numberOrDefault(
      source.maximumEntryDistanceAtr,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.maximumEntryDistanceAtr,
    ),
    minimumRewardRiskRatio: numberOrDefault(
      source.minimumRewardRiskRatio,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.minimumRewardRiskRatio,
    ),
    estimatedRoundTripCostPercent: numberOrDefault(
      source.estimatedRoundTripCostPercent,
      DEFAULT_HIGH_POSITION_SHORT_CONFIG.estimatedRoundTripCostPercent,
    ),
  };
}

export function validateHighPositionShortConfig(value: unknown): string | null {
  if (!isRecord(value)) return "高位转弱做空参数无效";
  if (!finiteAtLeast(value.minimumQuoteVolume24hUsdt, 1))
    return "高位转弱做空最低24小时成交额必须大于0";
  for (const field of [
    "minimumPosition24hPercent",
    "minimumPosition72hPercent",
    "minimumPosition30dPercent",
    "minimumPosition60dPercent",
  ] as const) {
    if (!finiteBetween(value[field], 0, 100))
      return "高位转弱做空价格位置必须为0%至100%";
  }
  if (!finiteBetween(value.minimumSellerVolumeRatio3m, 0.1, 10))
    return "高位转弱做空卖量倍数必须为0.1至10";
  if (!finiteBetween(value.resistanceRetestToleranceAtr, 0, 2))
    return "高位转弱做空阻力反抽容差必须为0至2 ATR";
  if (!finiteBetween(value.maximumMarketDataAgeMs, 100, 30_000))
    return "高位转弱做空行情最大延迟必须为100至30000毫秒";
  if (!finiteBetween(value.maximumEntryDistanceAtr, 0.01, 3))
    return "高位转弱做空最大入场距离必须为0.01至3 ATR";
  if (!finiteBetween(value.minimumRewardRiskRatio, 0.1, 10))
    return "高位转弱做空最低盈亏比必须为0.1至10";
  if (!finiteBetween(value.estimatedRoundTripCostPercent, 0, 5))
    return "高位转弱做空预估交易成本必须为0%至5%";
  return null;
}

export type HighPositionShortWake = {
  version: 1;
  wake: boolean;
  code:
    | "READY"
    | "MARKET_CONTEXT_STALE"
    | "POSITION_CONTEXT_INCOMPLETE"
    | "POSITION_THRESHOLD_NOT_REACHED"
    | "QUOTE_VOLUME_NOT_REACHED"
    | "SELLER_VOLUME_NOT_CONFIRMED"
    | "CURRENT_STRUCTURE_NOT_WEAKENING";
  symbol: string;
  direction: "SHORT";
  eventAt: number | null;
  referencePrice: number | null;
  high72h: number | null;
  low72h: number | null;
  position72hPercent: number | null;
  relativeVolume5m: number | null;
  relativeVolume3m: number | null;
  authority: "WAKE_ONLY";
  orderAffecting: false;
  consumedParameters: string[];
  marketContextId: string;
  summary: string;
};

const HIGH_POSITION_WAKE_PARAMETERS = [
  "minimumQuoteVolume24hUsdt",
  "minimumPosition24hPercent",
  "minimumPosition72hPercent",
  "minimumPosition30dPercent",
  "minimumPosition60dPercent",
  "minimumSellerVolumeRatio3m",
  "maximumMarketDataAgeMs",
] as const;

export function evaluateHighPositionShortWake(input: {
  now: number;
  context: NexusMarketContextSnapshot;
  candles3m: NexusUnifiedCandle[];
  candles5m: NexusUnifiedCandle[];
  config: HighPositionShortConfig;
}): HighPositionShortWake {
  const symbol = input.context.symbol;
  const latest3m = validCandles(input.candles3m).at(-1) ?? null;
  const fiveMinute = validCandles(input.candles5m);
  const latest5m = fiveMinute.at(-1) ?? null;
  const previous5m = fiveMinute.at(-2) ?? null;
  const eventAt = latest5m
    ? latest5m.openTime + 5 * 60_000 - 1
    : input.context.ticker24h.eventAt;
  const position72h = input.context.positions["72h"];
  const base = {
    version: 1 as const,
    symbol,
    direction: "SHORT" as const,
    eventAt,
    referencePrice: input.context.ticker24h.lastPrice,
    high72h: position72h.high,
    low72h: position72h.low,
    position72hPercent: position72h.positionPercent,
    relativeVolume5m: relativeVolume(fiveMinute),
    relativeVolume3m: relativeVolume(validCandles(input.candles3m)),
    authority: "WAKE_ONLY" as const,
    orderAffecting: false as const,
    consumedParameters: [...HIGH_POSITION_WAKE_PARAMETERS],
    marketContextId: input.context.id,
  };
  const tickerAgeMs = input.context.ticker24h.receivedAt === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, input.now - input.context.ticker24h.receivedAt);
  if (tickerAgeMs > input.config.maximumMarketDataAgeMs)
    return result("MARKET_CONTEXT_STALE", "统一24小时行情已过期，本轮不唤醒", base);

  const windows = ["24h", "72h", "30d", "60d"] as const;
  if (windows.some((window) => !input.context.positions[window].complete))
    return result(
      "POSITION_CONTEXT_INCOMPLETE",
      "高位做空所需24小时、72小时、30日或60日位置数据不完整",
      base,
    );
  if (
    (input.context.ticker24h.quoteVolume ?? 0) <
      input.config.minimumQuoteVolume24hUsdt
  )
    return result(
      "QUOTE_VOLUME_NOT_REACHED",
      "24小时真实成交额未达到策略配置门槛",
      base,
    );
  const thresholds = {
    "24h": input.config.minimumPosition24hPercent,
    "72h": input.config.minimumPosition72hPercent,
    "30d": input.config.minimumPosition30dPercent,
    "60d": input.config.minimumPosition60dPercent,
  };
  const failedWindow = windows.find(
    (window) =>
      (input.context.positions[window].positionPercent ?? -1) <
      thresholds[window],
  );
  if (failedWindow)
    return result(
      "POSITION_THRESHOLD_NOT_REACHED",
      `${failedWindow}价格位置未达到高位唤醒阈值`,
      base,
    );
  const sellerVolumeConfirmed =
    latest3m !== null &&
    latest3m.close < latest3m.open &&
    base.relativeVolume3m !== null &&
    base.relativeVolume3m >= input.config.minimumSellerVolumeRatio3m;
  if (!sellerVolumeConfirmed)
    return result(
      "SELLER_VOLUME_NOT_CONFIRMED",
      "3分钟真实卖方成交量尚未达到策略配置门槛",
      base,
    );
  const weakening = Boolean(
    latest5m &&
      previous5m &&
      latest5m.close < latest5m.open &&
      (latest5m.close < previous5m.close ||
        latest5m.high <= previous5m.high),
  );
  if (!weakening)
    return result(
      "CURRENT_STRUCTURE_NOT_WEAKENING",
      "长周期位置处于高位，但当前闭合5分钟结构尚未转弱",
      base,
    );
  return result(
    "READY",
    "多窗口价格位置达到配置阈值，3分钟真实卖量放大且5分钟闭合结构转弱；仅唤醒共享大脑继续裁决",
    base,
    true,
  );
}

function result(
  code: HighPositionShortWake["code"],
  summary: string,
  base: Omit<HighPositionShortWake, "wake" | "code" | "summary">,
  wake = false,
): HighPositionShortWake {
  return { ...base, wake, code, summary };
}

function validCandles(value: NexusUnifiedCandle[]) {
  return Array.isArray(value)
    ? value
        .filter(
          (row) =>
            Number.isFinite(row.openTime) &&
            [row.open, row.high, row.low, row.close].every(
              (number) => Number.isFinite(number) && number > 0,
            ),
        )
        .sort((left, right) => left.openTime - right.openTime)
    : [];
}

function relativeVolume(rows: NexusUnifiedCandle[]) {
  if (rows.length < 2) return null;
  const latest = volumeValue(rows.at(-1)!);
  const prior = rows.slice(0, -1).slice(-20).map(volumeValue);
  const average = prior.reduce((sum, value) => sum + value, 0) / prior.length;
  return average > 0 ? latest / average : null;
}

function volumeValue(row: NexusUnifiedCandle) {
  const quoteVolume = Number(row.quoteVolume);
  return Number.isFinite(quoteVolume) && quoteVolume >= 0
    ? quoteVolume
    : Math.max(0, Number(row.volume) || 0);
}

function numberOrDefault(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function finiteAtLeast(value: unknown, minimum: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum;
}

function finiteBetween(value: unknown, minimum: number, maximum: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
