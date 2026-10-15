import type { NexusMarketFact } from "./nexus-market-facts";
import {
  nexusFactSnapshotId,
  type NexusMarketContextSnapshot,
} from "./nexus-market-context-snapshot.ts";

export const NEXUS_DECISION_INTERVALS = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
] as const;

export function assessNexusDecisionSnapshot(input: {
  facts: NexusMarketFact[];
  evaluatedAt: number;
  symbol?: string;
  requiredIntervals?: readonly string[];
  maximumMarkAgeMs?: number;
  maximumFactReceiveAgeMs?: number;
  maximumFactReceiveSkewMs?: number;
  candleBoundaryGraceMs?: number;
  btcMacro?: {
    regime: string;
    observations: number;
    eventAt: number;
  };
  marketContext?: NexusMarketContextSnapshot | null;
}) {
  const requiredIntervals =
    input.requiredIntervals ?? NEXUS_DECISION_INTERVALS;
  const mark = input.facts
    .filter(
      (fact) =>
        fact.kind === "MARK_PRICE_UPDATED" &&
        (!input.symbol || fact.symbol === input.symbol) &&
        fact.eventAt <= input.evaluatedAt &&
        fact.receivedAt <= input.evaluatedAt,
    )
    .sort((left, right) => right.eventAt - left.eventAt)[0];
  const maximumMarkAgeMs = Math.max(1, input.maximumMarkAgeMs ?? 5_000);
  const maximumFactReceiveAgeMs = Math.max(
    1,
    input.maximumFactReceiveAgeMs ?? 90_000,
  );
  const maximumFactReceiveSkewMs = Math.max(
    0,
    input.maximumFactReceiveSkewMs ?? 30_000,
  );
  const candleBoundaryGraceMs = Math.max(
    0,
    input.candleBoundaryGraceMs ?? 2_000,
  );
  const missing: string[] = [];
  if (!mark) missing.push("新鲜标记价格");
  else if (
    mark.expiresAt <= input.evaluatedAt ||
    input.evaluatedAt - mark.eventAt > maximumMarkAgeMs
  )
    missing.push("标记价格延迟超过5秒");
  const candleFacts = input.facts.filter(
    (fact) =>
      fact.kind === "CANDLE_CLOSED" &&
      (!input.symbol || fact.symbol === input.symbol) &&
      fact.eventAt <= input.evaluatedAt &&
      fact.receivedAt <= input.evaluatedAt &&
      fact.expiresAt > input.evaluatedAt,
  );
  const latestCandleByInterval = new Map<string, NexusMarketFact>();
  for (const fact of candleFacts) {
    const interval = fact.interval ?? "";
    const current = latestCandleByInterval.get(interval);
    if (
      !current ||
      fact.eventAt > current.eventAt ||
      (fact.eventAt === current.eventAt &&
        fact.receivedAt > current.receivedAt)
    ) latestCandleByInterval.set(interval, fact);
  }
  const selectedCandles: NexusMarketFact[] = [];
  const candleFreshness: Array<{
    interval: string;
    eventAt: number | null;
    expectedCloseAt: number | null;
    receivedAt: number | null;
    current: boolean;
  }> = [];
  for (const interval of requiredIntervals) {
    const fact = latestCandleByInterval.get(interval);
    const expectedCloseAt = expectedClosedCandleAt(
      interval,
      input.evaluatedAt,
      candleBoundaryGraceMs,
    );
    if (!fact) {
      missing.push(`${interval}闭合K线`);
      candleFreshness.push({
        interval,
        eventAt: null,
        expectedCloseAt,
        receivedAt: null,
        current: false,
      });
      continue;
    }
    selectedCandles.push(fact);
    const current = expectedCloseAt === null || fact.eventAt >= expectedCloseAt;
    candleFreshness.push({
      interval,
      eventAt: fact.eventAt,
      expectedCloseAt,
      receivedAt: fact.receivedAt,
      current,
    });
    if (!current) missing.push(`${interval}闭合K线落后最新周期`);
  }
  const decisionFacts = [
    ...(mark ? [mark] : []),
    ...selectedCandles,
  ];
  const receivedTimes = decisionFacts.map((fact) => fact.receivedAt);
  const factReceiveSkewMs = receivedTimes.length > 1
    ? Math.max(...receivedTimes) - Math.min(...receivedTimes)
    : 0;
  const receiptWarnings: string[] = [];
  for (const fact of decisionFacts) {
    if (input.evaluatedAt - fact.receivedAt > maximumFactReceiveAgeMs)
      receiptWarnings.push(
        `${fact.interval ?? "mark"}数据复用了有效闭合快照`,
      );
  }
  if (factReceiveSkewMs > maximumFactReceiveSkewMs)
    receiptWarnings.push("多周期来自不同缓存批次，已按各周期闭合时间校验");
  const uniqueReceiptWarnings = [...new Set(receiptWarnings)];
  const integrity = missing.length > 0
    ? "INCOMPLETE"
    : uniqueReceiptWarnings.length > 0
      ? "COMPLETE_WITH_RECEIPT_SKEW"
      : "ALIGNED";
  const integritySummary = integrity === "ALIGNED"
    ? "标记价格与全部闭合周期已对齐"
    : integrity === "COMPLETE_WITH_RECEIPT_SKEW"
      ? `全部决策事实有效，但存在接收批次差异：${uniqueReceiptWarnings.join("；")}`
      : `决策事实不完整：${missing.join("、")}`;
  const factIds = [
    ...(mark ? [mark.id] : []),
    ...selectedCandles.map((fact) => fact.id),
  ];
  const marketContext =
    input.marketContext &&
      input.marketContext.symbol === (input.symbol ?? input.marketContext.symbol)
      ? input.marketContext
      : null;
  return {
    version: 3 as const,
    factSnapshotId: nexusFactSnapshotId({
      symbol: input.symbol ?? mark?.symbol ?? "UNKNOWN",
      evaluatedAt: input.evaluatedAt,
      factIds,
      marketContextId: marketContext?.id,
    }),
    complete: missing.length === 0,
    integrity,
    integritySummary,
    evaluatedAt: input.evaluatedAt,
    markFactId: mark?.id ?? null,
    markAgeMs: mark ? input.evaluatedAt - mark.eventAt : null,
    factReceiveSkewMs,
    maximumFactReceiveAgeMs,
    maximumFactReceiveSkewMs,
    candleBoundaryGraceMs,
    candleFreshness,
    receiptWarnings: uniqueReceiptWarnings,
    requiredIntervals: [...requiredIntervals],
    // BTC is preserved in the frozen snapshot for post-entry attribution.
    // It is deliberately excluded from `missing`: the target contract's
    // fresh price and own closed candles are the complete pre-entry facts.
    btcMacro: input.btcMacro ?? null,
    // Long-horizon context is frozen beside the decision facts but does not
    // fill a missing mark/candle or approve an order. Strategy-specific wake
    // logic may read it under the authority declared by the context snapshot.
    marketContextId: marketContext?.id ?? null,
    marketContext,
    missing,
    factIds,
  };
}

function expectedClosedCandleAt(
  interval: string,
  evaluatedAt: number,
  boundaryGraceMs: number,
) {
  const intervalMs = {
    "1m": 60_000,
    "3m": 3 * 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
  }[interval];
  if (!intervalMs) return null;
  const settledAt = Math.max(0, evaluatedAt - boundaryGraceMs);
  return Math.floor(settledAt / intervalMs) * intervalMs - 1;
}
