import {
  type LargeTraderConfirmationConfig,
  normalizeLargeTraderConfirmation,
} from "./liquidation-trend-config.ts";

export type LargeTraderSeriesPoint = {
  timestamp: number;
  value: number;
};

export type LargeTraderPositioningInput = {
  symbol: string;
  observedAt: number;
  openInterestValue: LargeTraderSeriesPoint[];
  topPositionLongShortRatio: LargeTraderSeriesPoint[];
  topAccountLongShortRatio: LargeTraderSeriesPoint[];
  takerBuySellRatio: LargeTraderSeriesPoint[];
};

export type LargeTraderPositioning = {
  status: "SUPPORTS_LONG" | "CONFLICTS_LONG" | "NEUTRAL" | "UNAVAILABLE";
  code: string;
  message: string;
  sourceLabel: "BINANCE_TOP_TRADER_AGGREGATE_NOT_WALLET";
  observedAt: number;
  latestDataAt: number | null;
  confirmationMode: "BROAD_LONG" | "CAPITAL_CONCENTRATION_LONG" | null;
  thresholds: LargeTraderConfirmationConfig;
  detail: {
    openInterestValue: number | null;
    openInterestChangePercent: number | null;
    topPositionLongShortRatio: number | null;
    topPositionRatioChangePercent: number | null;
    topAccountLongShortRatio: number | null;
    topAccountRatioChangePercent: number | null;
    takerBuySellRatio: number | null;
    takerRatioChangePercent: number | null;
    dataAgeMs: number | null;
  };
};

export function analyzeLargeTraderLongPositioning(
  input: LargeTraderPositioningInput,
  configuredThresholds?: Partial<LargeTraderConfirmationConfig>,
): LargeTraderPositioning {
  const thresholds = normalizeLargeTraderConfirmation(configuredThresholds);
  const openInterest = latestChange(input.openInterestValue);
  const topPosition = latestChange(input.topPositionLongShortRatio);
  const topAccount = latestChange(input.topAccountLongShortRatio);
  const taker = latestChange(input.takerBuySellRatio);
  const latestDataAt = Math.max(
    0,
    Math.min(
      openInterest?.timestamp ?? 0,
      topPosition?.timestamp ?? 0,
      topAccount?.timestamp ?? 0,
      taker?.timestamp ?? 0,
    ),
  ) || null;
  const dataAgeMs = latestDataAt === null ? null : input.observedAt - latestDataAt;
  const detail = {
    openInterestValue: openInterest?.latest ?? null,
    openInterestChangePercent: openInterest?.changePercent ?? null,
    topPositionLongShortRatio: topPosition?.latest ?? null,
    topPositionRatioChangePercent: topPosition?.changePercent ?? null,
    topAccountLongShortRatio: topAccount?.latest ?? null,
    topAccountRatioChangePercent: topAccount?.changePercent ?? null,
    takerBuySellRatio: taker?.latest ?? null,
    takerRatioChangePercent: taker?.changePercent ?? null,
    dataAgeMs,
  };
  const base = {
    sourceLabel: "BINANCE_TOP_TRADER_AGGREGATE_NOT_WALLET" as const,
    observedAt: input.observedAt,
    latestDataAt,
    confirmationMode: null as LargeTraderPositioning["confirmationMode"],
    thresholds,
    detail,
  };
  if (!openInterest || !topPosition || !topAccount || !taker)
    return {
      ...base,
      status: "UNAVAILABLE",
      code: "LARGE_TRADER_DATA_INCOMPLETE",
      message: "币安大户聚合持仓数据不足，等待下一组 5 分钟数据",
    };
  if (
    dataAgeMs === null ||
    dataAgeMs < -60_000 ||
    dataAgeMs > thresholds.maxDataAgeMinutes * 60_000
  )
    return {
      ...base,
      status: "UNAVAILABLE",
      code: "LARGE_TRADER_DATA_STALE",
      message: `币安大户聚合持仓数据已超过 ${thresholds.maxDataAgeMinutes} 分钟，等待新数据`,
    };

  const increasingShortPressure =
    openInterest.changePercent > 0 &&
    topPosition.changePercent < 0 &&
    topAccount.changePercent < 0 &&
    taker.latest < 1;
  if (increasingShortPressure)
    return {
      ...base,
      status: "CONFLICTS_LONG",
      code: "LARGE_TRADER_SHORT_BUILDUP",
      message: "未平仓量增加，但大户净多持仓和净多账户同步下降，主动卖量占优",
    };

  const coordinatedLongIncrease =
    topPosition.changePercent >= thresholds.minTopPositionRatioChangePercent &&
    topAccount.changePercent >= thresholds.minTopAccountRatioChangePercent &&
    taker.latest >= thresholds.minTakerBuySellRatio &&
    openInterest.changePercent >= thresholds.minOpenInterestChangePercent;
  if (coordinatedLongIncrease)
    return {
      ...base,
      confirmationMode: topAccount.changePercent >= 0
        ? "BROAD_LONG"
        : "CAPITAL_CONCENTRATION_LONG",
      status: "SUPPORTS_LONG",
      code: "LARGE_TRADER_LONG_CONFIRMED",
      message: topAccount.changePercent >= 0
        ? "大户净多持仓与净多账户同步抬升，主动买量不弱且未平仓量未异常撤退"
        : "大户净多持仓抬升、净多账户小幅收缩，呈现少数大户仓位集中；主动买量和未平仓量确认未转弱",
    };

  return {
    ...base,
    status: "NEUTRAL",
    code: "LARGE_TRADER_DIRECTION_UNCONFIRMED",
    message: "大户持仓、账户和主动成交尚未形成一致方向，继续等待",
  };
}

function latestChange(points: LargeTraderSeriesPoint[]) {
  const valid = points
    .filter(
      (point) =>
        Number.isFinite(point.timestamp) &&
        Number.isFinite(point.value) &&
        point.timestamp > 0 &&
        point.value > 0,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  if (valid.length < 2) return null;
  const previous = valid[valid.length - 2];
  const latest = valid[valid.length - 1];
  return {
    timestamp: latest.timestamp,
    latest: latest.value,
    changePercent: ((latest.value - previous.value) / previous.value) * 100,
  };
}
