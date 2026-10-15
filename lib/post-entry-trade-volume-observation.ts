import type { NexusUnifiedCandle } from "./nexus-unified-market-data.ts";

export const POST_ENTRY_TRADE_VOLUME_MODEL_VERSION =
  "post-entry-trade-volume-v2" as const;

const MEANINGFUL_VOLUME_EXPANSION_RATIO = 1.2;

export type PostEntryTradeVolumeStatus =
  | "DIRECTIONAL_EXPANSION"
  | "OPPOSITE_EXPANSION"
  | "CONTRACTING"
  | "MIXED"
  | "UNAVAILABLE";

export type PostEntryTradeVolumeObservation = {
  modelVersion: typeof POST_ENTRY_TRADE_VOLUME_MODEL_VERSION;
  status: PostEntryTradeVolumeStatus;
  source: "BINANCE_TRADE_1M";
  closedCandleCount: number;
  baselineCandleCount: number;
  recentCandleCount: number;
  baselineQuoteVolume: number | null;
  recentQuoteVolume: number | null;
  quoteVolumeRatio: number | null;
  recentPriceChangePercent: number | null;
  directionAligned: boolean;
  oppositeDirection: boolean;
  volumeExpanded: boolean;
  reason: string;
};

/**
 * 持仓后的量价证据必须来自持仓期间已经闭合的真实成交 K 线。
 * 用相邻、等长的 1 分钟窗口比较，不复用入场快照，也不使用 24h 滚动量
 * 冒充当前资金流。它只描述已经发生的扩量方向，不预测下一根 K 线。
 */
export function analyzePostEntryTradeVolume(input: {
  positionSide: "LONG" | "SHORT";
  openedAtMs: number;
  closedTradeMinutes1m: NexusUnifiedCandle[];
}): PostEntryTradeVolumeObservation {
  const rows = input.closedTradeMinutes1m
    .filter(validCandle)
    .filter((row) => row.openTime >= input.openedAtMs)
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-6);
  if (rows.length < 4)
    return unavailable(
      rows.length,
      "持仓后尚不足四根已闭合真实成交1分钟K线；等待两个可比较窗口形成。",
    );

  const windowSize = Math.min(3, Math.floor(rows.length / 2));
  const compared = rows.slice(-windowSize * 2);
  const baseline = compared.slice(0, windowSize);
  const recent = compared.slice(windowSize);
  const baselineQuoteVolume = sumQuoteVolume(baseline);
  const recentQuoteVolume = sumQuoteVolume(recent);
  if (baselineQuoteVolume === null || recentQuoteVolume === null)
    return unavailable(
      rows.length,
      "真实成交K线缺少有效成交额；本轮不推导资金方向。",
    );

  const recentOpen = recent[0]?.open ?? 0;
  const recentClose = recent.at(-1)?.close ?? 0;
  if (!(recentOpen > 0) || !(recentClose > 0))
    return unavailable(rows.length, "真实成交K线价格无效；本轮只观察。");

  const recentPriceChangePercent =
    (recentClose - recentOpen) / recentOpen * 100;
  const priceDirection = Math.sign(recentPriceChangePercent);
  const expectedDirection = input.positionSide === "LONG" ? 1 : -1;
  const directionAligned = priceDirection === expectedDirection;
  const oppositeDirection = priceDirection === -expectedDirection;
  const quoteVolumeRatio = baselineQuoteVolume > 0
    ? recentQuoteVolume / baselineQuoteVolume
    : null;
  const volumeExpanded = quoteVolumeRatio !== null &&
    quoteVolumeRatio >= MEANINGFUL_VOLUME_EXPANSION_RATIO;
  const status: PostEntryTradeVolumeStatus = !volumeExpanded
    ? "CONTRACTING"
    : directionAligned
      ? "DIRECTIONAL_EXPANSION"
      : oppositeDirection
        ? "OPPOSITE_EXPANSION"
        : "MIXED";

  return {
    modelVersion: POST_ENTRY_TRADE_VOLUME_MODEL_VERSION,
    status,
    source: "BINANCE_TRADE_1M",
    closedCandleCount: rows.length,
    baselineCandleCount: baseline.length,
    recentCandleCount: recent.length,
    baselineQuoteVolume: rounded(baselineQuoteVolume),
    recentQuoteVolume: rounded(recentQuoteVolume),
    quoteVolumeRatio: quoteVolumeRatio === null ? null : rounded(quoteVolumeRatio),
    recentPriceChangePercent: rounded(recentPriceChangePercent),
    directionAligned,
    oppositeDirection,
    volumeExpanded,
    reason:
      status === "DIRECTIONAL_EXPANSION"
        ? "持仓后的最近等长真实成交1分钟K线窗口扩量，价格方向与仓位一致。"
        : status === "OPPOSITE_EXPANSION"
          ? "持仓后的最近等长真实成交1分钟K线窗口扩量，价格方向与仓位相反。"
          : status === "CONTRACTING"
            ? "最近真实成交1分钟K线窗口未达到20%有效扩量，不把轻微波动解释为资金确认。"
            : "真实成交量扩张，但等长窗口内没有形成明确方向。",
  };
}

function unavailable(
  closedCandleCount: number,
  reason: string,
): PostEntryTradeVolumeObservation {
  return {
    modelVersion: POST_ENTRY_TRADE_VOLUME_MODEL_VERSION,
    status: "UNAVAILABLE",
    source: "BINANCE_TRADE_1M",
    closedCandleCount,
    baselineCandleCount: 0,
    recentCandleCount: 0,
    baselineQuoteVolume: null,
    recentQuoteVolume: null,
    quoteVolumeRatio: null,
    recentPriceChangePercent: null,
    directionAligned: false,
    oppositeDirection: false,
    volumeExpanded: false,
    reason,
  };
}

function validCandle(row: NexusUnifiedCandle) {
  return Number.isFinite(row.openTime) &&
    Number.isFinite(row.open) && row.open > 0 &&
    Number.isFinite(row.close) && row.close > 0;
}

function sumQuoteVolume(rows: NexusUnifiedCandle[]) {
  const values = rows.map((row) => Number(row.quoteVolume));
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
