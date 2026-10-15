export const NEXUS_DAILY_MARKET_ACTIVITY_VERSION =
  "nexus-daily-market-activity-v1" as const;

export type NexusDailyMarketActivityLevel =
  | "EXTREME"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "UNKNOWN";

export function analyzeNexusDailyMarketActivity(input: {
  symbol: string;
  quoteVolume24h: number | null | undefined;
  universeQuoteVolumes24h: Array<number | null | undefined>;
  recentVolumeRatio?: number | null;
}) {
  const quoteVolume24h = finiteNonNegative(input.quoteVolume24h);
  const universe = input.universeQuoteVolumes24h
    .map(finiteNonNegative)
    .filter((value): value is number => value !== null && value > 0)
    .sort((left, right) => right - left);
  const recentVolumeRatio = finiteNonNegative(input.recentVolumeRatio);
  if (quoteVolume24h === null || quoteVolume24h <= 0 || universe.length === 0)
    return {
      version: NEXUS_DAILY_MARKET_ACTIVITY_VERSION,
      symbol: normalizeSymbol(input.symbol),
      quoteVolume24h,
      universeSize: universe.length,
      rank: null,
      percentile: null,
      level: "UNKNOWN" as const,
      recentVolumeRatio,
      opportunityContext: "UNKNOWN" as const,
      learningOnly: true as const,
      orderAffecting: false as const,
      reason: "系统合约池尚未同步有效的24小时成交额",
    };

  const rank =
    universe.filter((value) => value > quoteVolume24h).length + 1;
  const percentile =
    universe.length === 1
      ? 100
      : ((universe.length - rank) / (universe.length - 1)) * 100;
  const level: NexusDailyMarketActivityLevel =
    percentile >= 95
      ? "EXTREME"
      : percentile >= 80
        ? "HIGH"
        : percentile >= 50
          ? "MEDIUM"
          : "LOW";
  const opportunityContext =
    (level === "EXTREME" || level === "HIGH") &&
    recentVolumeRatio !== null &&
    recentVolumeRatio >= 1.5
      ? ("ACTIVE_EXPANSION" as const)
      : level === "EXTREME" || level === "HIGH"
        ? ("LIQUID_BASE" as const)
        : recentVolumeRatio !== null && recentVolumeRatio >= 1.5
          ? ("LOCAL_BURST" as const)
          : ("NORMAL" as const);

  return {
    version: NEXUS_DAILY_MARKET_ACTIVITY_VERSION,
    symbol: normalizeSymbol(input.symbol),
    quoteVolume24h,
    universeSize: universe.length,
    rank,
    percentile,
    level,
    recentVolumeRatio,
    opportunityContext,
    learningOnly: true as const,
    orderAffecting: false as const,
    reason:
      opportunityContext === "ACTIVE_EXPANSION"
        ? "当日成交额位于活跃合约前列，且当前量能继续放大，记录为高活跃机会样本"
        : opportunityContext === "LIQUID_BASE"
          ? "当日成交额位于活跃合约前列，但当前未形成局部放量，仅记录流动性基础"
          : opportunityContext === "LOCAL_BURST"
            ? "当日成交额不在前列但局部突然放量，记录为局部资金异动样本"
            : "当日成交额和局部量能均处于普通水平",
  };
}

export function nexusDailyMarketActivitySummary(
  activity: ReturnType<typeof analyzeNexusDailyMarketActivity>,
) {
  if (
    activity.quoteVolume24h === null ||
    activity.rank === null ||
    activity.percentile === null
  )
    return activity.reason;
  return (
    `24小时成交额 ${formatUsdt(activity.quoteVolume24h)} USDT` +
    `，系统合约池排名 ${activity.rank}/${activity.universeSize}` +
    `（分位 ${activity.percentile.toFixed(1)}%）` +
    `，活跃等级 ${activity.level}` +
    `，15分钟量能比 ${formatRatio(activity.recentVolumeRatio)}。` +
    activity.reason
  );
}

function finiteNonNegative(value: number | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeSymbol(value: string) {
  return value.trim().toUpperCase();
}

function formatUsdt(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}

function formatRatio(value: number | null) {
  return value === null ? "--" : `${value.toFixed(2)}×`;
}
