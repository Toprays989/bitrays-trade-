import {
  buildNexusMarketContextSnapshot,
  nexusFactSnapshotId,
} from "./nexus-market-context-snapshot.ts";
import {
  marketContextPositionFact,
  markPriceMarketFact,
} from "./nexus-market-facts.ts";
import type { NexusUnifiedMarketData } from "./nexus-unified-market-data.ts";
import { resolveStrategyTriggerAdapter } from "./strategy-triggers/registry.ts";
import type { LowPositionWindowTriggerCandidate } from "./strategy-triggers/low-position-window.ts";

export const LOW_POSITION_TRIGGER_OBSERVATION_VERSION =
  "low-position-trigger-observation-v1" as const;

export type LowPositionObservationMark = Readonly<{
  symbol: string;
  markPrice: number;
  eventAt: number;
  receivedAt: number;
}>;

export type LowPositionObservationStatus =
  | "CANDIDATE"
  | "ABOVE_LIMIT"
  | "MARK_MISSING"
  | "MARK_STALE"
  | "CACHE_MISS"
  | "WINDOW_INCOMPLETE"
  | "RANGE_INVALID";

export type LowPositionObservationLog = Readonly<{
  symbol: string;
  status: LowPositionObservationStatus;
  message: string;
  position72hPercent: number | null;
  factSnapshotId: string | null;
  marketContextId: string | null;
}>;

/**
 * Build low-position observations exclusively from shared in-process cache.
 * A cache miss is a diagnostic result, never permission to load Binance data.
 */
export function observeCachedLowPositionTriggers(input: {
  marketData: NexusUnifiedMarketData;
  symbols: readonly string[];
  marks: readonly LowPositionObservationMark[];
  maxPosition72hPercent: number;
  maxMarkAgeMs: number;
  now: number;
}) {
  const symbols = [...new Set(input.symbols.map(normalizeSymbol))].sort();
  const marks = latestMarks(input.marks);
  const facts: Array<{
    symbol: string;
    markPrice: number;
    high72h: number;
    low72h: number;
    eventAt: number;
    receivedAt: number;
    factSnapshotId: string;
  }> = [];
  const logs = new Map<string, LowPositionObservationLog>();

  for (const symbol of symbols) {
    const mark = marks.get(symbol);
    if (!mark) {
      logs.set(symbol, log(symbol, "MARK_MISSING", "缺少共享标记价格"));
      continue;
    }
    if (!freshMark(mark, input.now, input.maxMarkAgeMs)) {
      logs.set(symbol, log(symbol, "MARK_STALE", "共享标记价格已过期或时间无效"));
      continue;
    }
    const hourly = input.marketData.cachedClosedCandles({
      symbol,
      interval: "1h",
      source: "MARK_PRICE",
      limit: 72,
      now: input.now,
    });
    if (!hourly) {
      logs.set(
        symbol,
        log(symbol, "CACHE_MISS", "共享72小时缓存尚未形成；观察不会触发上游请求"),
      );
      continue;
    }
    if (hourly.rows.length < 72) {
      logs.set(
        symbol,
        log(
          symbol,
          "WINDOW_INCOMPLETE",
          `共享72小时缓存仅有 ${hourly.rows.length}/72 根闭合K线`,
        ),
      );
      continue;
    }
    const context = buildNexusMarketContextSnapshot({
      symbol,
      capturedAt: input.now,
      ticker24h: {
        lastPrice: mark.markPrice,
        eventAt: mark.eventAt,
        receivedAt: mark.receivedAt,
      },
      candles1h: hourly.rows,
    });
    const position = context.positions["72h"];
    if (
      !position.complete ||
      position.high === null ||
      position.low === null ||
      position.positionPercent === null ||
      mark.markPrice < position.low ||
      mark.markPrice > position.high
    ) {
      logs.set(
        symbol,
        log(symbol, "RANGE_INVALID", "72小时区间与当前标记价格未对齐"),
      );
      continue;
    }
    const markFact = markPriceMarketFact({
      symbol,
      markPrice: mark.markPrice,
      eventAt: mark.eventAt,
      receivedAt: mark.receivedAt,
    });
    const positionFact = marketContextPositionFact({
      context,
      eventAt: mark.eventAt,
      receivedAt: input.now,
      expiresAt: Math.min(hourly.expiresAt, markFact.expiresAt),
    });
    const factSnapshotId = nexusFactSnapshotId({
      symbol,
      evaluatedAt: input.now,
      factIds: [markFact.id, positionFact.id],
      marketContextId: context.id,
    });
    facts.push({
      symbol,
      markPrice: mark.markPrice,
      high72h: position.high,
      low72h: position.low,
      eventAt: mark.eventAt,
      receivedAt: mark.receivedAt,
      factSnapshotId,
    });
    logs.set(symbol, {
      symbol,
      status: "ABOVE_LIMIT",
      message: `72小时位置 ${position.positionPercent.toFixed(2)}%，等待低于 ${input.maxPosition72hPercent}%`,
      position72hPercent: position.positionPercent,
      factSnapshotId,
      marketContextId: context.id,
    });
  }

  const candidates = resolveStrategyTriggerAdapter(
    "LOW_POSITION_WINDOW",
  ).evaluate({
    facts: { rows: facts, processedAt: input.now },
    config: {
      maxPosition72hPercent: input.maxPosition72hPercent,
      maxFactAgeMs: input.maxMarkAgeMs,
    },
  });
  for (const candidate of candidates) {
    const current = logs.get(candidate.symbol);
    logs.set(candidate.symbol, {
      symbol: candidate.symbol,
      status: "CANDIDATE",
      message: `72小时位置 ${candidate.position72hPercent.toFixed(2)}%，已形成低位观察候选`,
      position72hPercent: candidate.position72hPercent,
      factSnapshotId: candidate.factSnapshotId,
      marketContextId: current?.marketContextId ?? null,
    });
  }

  const observationLogs = [...logs.values()].sort((left, right) =>
    left.symbol.localeCompare(right.symbol)
  );
  return {
    version: LOW_POSITION_TRIGGER_OBSERVATION_VERSION,
    observationOnly: true as const,
    canAuthorizeOrder: false as const,
    evaluatedAt: input.now,
    observedSymbols: symbols.length,
    preparedFacts: facts.length,
    candidateCount: candidates.length,
    candidates: candidates as LowPositionWindowTriggerCandidate[],
    logs: observationLogs,
  };
}

function latestMarks(marks: readonly LowPositionObservationMark[]) {
  const result = new Map<string, LowPositionObservationMark>();
  for (const mark of marks) {
    const symbol = normalizeSymbol(mark.symbol);
    const current = result.get(symbol);
    if (
      !current ||
      mark.eventAt > current.eventAt ||
      (mark.eventAt === current.eventAt && mark.receivedAt > current.receivedAt)
    ) result.set(symbol, { ...mark, symbol });
  }
  return result;
}

function freshMark(
  mark: LowPositionObservationMark,
  now: number,
  maxAgeMs: number,
) {
  return (
    Number.isFinite(now) &&
    now > 0 &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs > 0 &&
    Number.isFinite(mark.markPrice) &&
    mark.markPrice > 0 &&
    Number.isFinite(mark.eventAt) &&
    Number.isFinite(mark.receivedAt) &&
    mark.eventAt > 0 &&
    mark.receivedAt > 0 &&
    mark.eventAt <= now + 1_000 &&
    mark.receivedAt <= now + 1_000 &&
    now - mark.eventAt < maxAgeMs &&
    now - mark.receivedAt < maxAgeMs
  );
}

function normalizeSymbol(value: string) {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol))
    throw new Error("低位观察合约代码无效");
  return symbol;
}

function log(
  symbol: string,
  status: LowPositionObservationStatus,
  message: string,
): LowPositionObservationLog {
  return {
    symbol,
    status,
    message,
    position72hPercent: null,
    factSnapshotId: null,
    marketContextId: null,
  };
}
