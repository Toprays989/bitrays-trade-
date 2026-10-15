import type { AnalysisCandle } from "./liquidation-trend-analysis";

export type LiquiditySweepCycle = {
  status: "RECLAIMED" | "ACTIVE_CASCADE" | "UNCONFIRMED" | "DATA_STALE";
  code: string;
  message: string;
  detail: {
    priorSupport: number | null;
    priorResistance: number | null;
    priorRangeAtr: number | null;
    rangeState: "COMPRESSED" | "BROAD" | "UNKNOWN";
    sweepLow: number | null;
    sweepDepthAtr: number | null;
    sweptSupport: boolean;
    reclaimedSupport: boolean;
    cascadeStopped: boolean;
    postEventClosedCandles: number;
  };
};

const FIVE_MINUTES = 5 * 60_000;

/**
 * Converts the subjective “庄家杀仓” story into auditable price evidence:
 * local range -> downside liquidity sweep -> closed-candle reclaim -> cascade stop.
 * It does not claim trader identity or market manipulation.
 */
export function analyzeDownsideLiquiditySweep(input: {
  eventTime: number;
  liquidationPrice: number;
  atr5m: number;
  maxPriorRangeAtr?: number;
  trade5m: AnalysisCandle[];
}): LiquiditySweepCycle {
  const eventBucket = Math.floor(input.eventTime / FIVE_MINUTES) * FIVE_MINUTES;
  const preEvent = input.trade5m
    .filter((candle) => candle.openTime < eventBucket)
    .slice(-12);
  const postEvent = input.trade5m.filter((candle) => candle.openTime >= eventBucket);
  const emptyDetail = {
    priorSupport: null,
    priorResistance: null,
    priorRangeAtr: null,
    rangeState: "UNKNOWN" as const,
    sweepLow: null,
    sweepDepthAtr: null,
    sweptSupport: false,
    reclaimedSupport: false,
    cascadeStopped: false,
    postEventClosedCandles: postEvent.length,
  };
  if (
    preEvent.length < 6 ||
    !Number.isFinite(input.atr5m) || input.atr5m <= 0 ||
    !Number.isFinite(input.liquidationPrice) || input.liquidationPrice <= 0
  ) return {
    status: "DATA_STALE",
    code: "LIQUIDITY_SWEEP_DATA_INCOMPLETE",
    message: "局部震荡与流动性扫盘数据不足",
    detail: emptyDetail,
  };

  const priorSupport = Math.min(...preEvent.map((candle) => candle.low));
  const priorResistance = Math.max(...preEvent.map((candle) => candle.high));
  const priorRangeAtr = (priorResistance - priorSupport) / input.atr5m;
  const maxPriorRangeAtr = Number.isFinite(input.maxPriorRangeAtr)
    ? Math.max(1, Number(input.maxPriorRangeAtr))
    : 4;
  const rangeState: "COMPRESSED" | "BROAD" =
    priorRangeAtr <= maxPriorRangeAtr ? "COMPRESSED" : "BROAD";
  const sweepLow = Math.min(
    input.liquidationPrice,
    ...postEvent.map((candle) => candle.low),
  );
  const sweepDepthAtr = (priorSupport - sweepLow) / input.atr5m;
  // A touch within 0.10 ATR counts because liquidation prints and candle lows
  // can differ slightly across mark price and last price streams.
  const sweptSupport = sweepLow <= priorSupport + input.atr5m * 0.1;
  const reclaimIndex = postEvent.findIndex((candle) => {
    const range = candle.high - candle.low;
    const closeLocation = range > 0 ? (candle.close - candle.low) / range : 0;
    return candle.close >= priorSupport && closeLocation >= 0.55;
  });
  const reclaim = reclaimIndex >= 0 ? postEvent[reclaimIndex] : null;
  const latest = postEvent.at(-1);
  const cascadeStopped = Boolean(
    reclaim && latest &&
    latest.close >= priorSupport &&
    postEvent
      .slice(reclaimIndex)
      .every((candle) => candle.close >= priorSupport - input.atr5m * 0.1),
  );
  const detail = {
    priorSupport,
    priorResistance,
    priorRangeAtr,
    rangeState,
    sweepLow,
    sweepDepthAtr,
    sweptSupport,
    reclaimedSupport: Boolean(reclaim),
    cascadeStopped,
    postEventClosedCandles: postEvent.length,
  };
  if (!postEvent.length) return {
    status: "UNCONFIRMED",
    code: "LIQUIDITY_SWEEP_WAIT_CLOSED_CANDLE",
    message: "等待爆仓后的第一根完整5分钟K线",
    detail,
  };
  if (rangeState === "BROAD") return {
    status: "UNCONFIRMED",
    code: "LIQUIDITY_SWEEP_RANGE_TOO_WIDE",
    message: `扫盘前区间 ${priorRangeAtr.toFixed(2)} ATR，超过震荡上限 ${maxPriorRangeAtr.toFixed(2)} ATR`,
    detail,
  };
  if (!sweptSupport) return {
    status: "UNCONFIRMED",
    code: "LIQUIDITY_SWEEP_NOT_REACHED",
    message: "价格尚未扫到局部震荡支撑，不推断为杀仓反转",
    detail,
  };
  if (!reclaim || !cascadeStopped) return {
    status: "ACTIVE_CASCADE",
    code: "LIQUIDITY_SWEEP_CASCADE_ACTIVE",
    message: "已扫过局部支撑但尚未收回，杀仓过程可能仍在继续",
    detail,
  };
  return {
    status: "RECLAIMED",
    code: "LIQUIDITY_SWEEP_RECLAIMED",
    message: "局部支撑被扫后由完整5分钟K线收回，单边杀仓已出现衰竭证据",
    detail,
  };
}
