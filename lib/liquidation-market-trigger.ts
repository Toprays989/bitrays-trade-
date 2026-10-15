import type { BinanceLiquidationAggregate } from "./binance-usdm-live";

export type LiquidationMarketTriggerCandidate =
  BinanceLiquidationAggregate & {
    triggerScope: "SINGLE_SYMBOL";
    marketClusterId: string;
    marketClusterNotional: number;
    marketClusterEventCount: number;
    marketClusterSymbolCount: number;
    marketClusterSpanMs: number;
    marketClusterMaxGapMs: number;
    configuredMaxInterEventGapMs: number;
    marketTriggerMode: "SINGLE_STRONG" | "ACCUMULATED_CONTINUOUS";
    symbolLiquidationNotional: number;
    symbolEventCount: number;
    symbolLiquidationSharePercent: number;
    symbolContributionRank: number;
  };

type LiquidationMarketTriggerOptions = {
  side: "BUY" | "SELL";
  /** Same-symbol cumulative liquidation threshold. */
  minNotionalUsdt: number;
  /** One liquidation event may independently trigger analysis. */
  minSingleEventNotionalUsdt?: number;
  minEventCount: number;
  maxSpanMs: number;
  maxInterEventGapMs: number;
  minLiquidationPrice?: number;
  maxLiquidationPrice?: number;
};

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function chronological(
  left: BinanceLiquidationAggregate,
  right: BinanceLiquidationAggregate,
) {
  return (
    left.lastTradeTime - right.lastTradeTime ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Creates causal liquidation triggers independently for every contract.
 *
 * Market-wide liquidation totals are useful background evidence, but they must
 * never be assigned to every incidental symbol. A candidate is created only
 * when that same symbol has one sufficiently large liquidation or its own
 * continuous window reaches the configured event-count and notional limits.
 */
export function buildLiquidationMarketTriggerCandidates(
  rows: BinanceLiquidationAggregate[],
  options: LiquidationMarketTriggerOptions,
) {
  const minNotionalUsdt = Math.max(0, Number(options.minNotionalUsdt) || 0);
  const minSingleEventNotionalUsdt = Math.max(
    0,
    Number(options.minSingleEventNotionalUsdt ?? minNotionalUsdt) || 0,
  );
  const minEventCount = Math.max(1, Math.trunc(options.minEventCount) || 1);
  const maxSpanMs = Math.max(1_000, Math.trunc(options.maxSpanMs) || 3_000);
  const maxInterEventGapMs = Math.min(
    maxSpanMs,
    Math.max(
      1_000,
      Math.trunc(options.maxInterEventGapMs) || maxSpanMs,
    ),
  );
  const minLiquidationPrice = Math.max(
    0,
    Number(options.minLiquidationPrice) || 0,
  );
  const maxLiquidationPrice = Math.max(
    0,
    Number(options.maxLiquidationPrice) || 0,
  );
  const ordered = rows
    .filter((row) => {
      const price = positive(row.averagePrice);
      return (
        row.side === options.side &&
        typeof row.symbol === "string" &&
        row.symbol.length > 0 &&
        positive(row.notional) > 0 &&
        price > 0 &&
        (!minLiquidationPrice || price >= minLiquidationPrice) &&
        (!maxLiquidationPrice || price <= maxLiquidationPrice) &&
        Number.isFinite(row.firstTradeTime) &&
        Number.isFinite(row.lastTradeTime)
      );
    })
    .sort(chronological);
  const symbolRows = new Map<string, BinanceLiquidationAggregate[]>();
  for (const row of ordered) {
    const current = symbolRows.get(row.symbol) ?? [];
    current.push(row);
    symbolRows.set(row.symbol, current);
  }
  const candidates: LiquidationMarketTriggerCandidate[] = [];

  for (const [symbol, rowsForSymbol] of symbolRows) {
    let pending: BinanceLiquidationAggregate[] = [];
    for (const row of rowsForSymbol) {
      const singleStrongSignal =
        row.notional >= minSingleEventNotionalUsdt;
      if (singleStrongSignal) {
        pending = [row];
      } else {
        const previous = pending.at(-1);
        if (
          previous &&
          row.firstTradeTime - previous.lastTradeTime > maxInterEventGapMs
        )
          pending = [];
        pending = pending.filter(
          (item) => row.lastTradeTime - item.firstTradeTime <= maxSpanMs,
        );
        pending.push(row);
      }
      const clusterNotional = pending.reduce(
        (sum, item) => sum + positive(item.notional),
        0,
      );
      const clusterEventCount = pending.reduce(
        (sum, item) =>
          sum + Math.max(1, Math.trunc(positive(item.eventCount) || 1)),
        0,
      );
      if (
        !singleStrongSignal &&
        (
          clusterNotional < minNotionalUsdt ||
          clusterEventCount < minEventCount
        )
      )
        continue;

      const clusterRows = pending;
      pending = [];
      const first = clusterRows[0];
      const last = clusterRows.at(-1)!;
      const filledQuantity = clusterRows.reduce(
        (sum, item) => sum + positive(item.filledQuantity),
        0,
      );
      const weightedPrice = clusterRows.reduce(
        (sum, item) =>
          sum + positive(item.averagePrice) * positive(item.notional),
        0,
      );
      const clusterMaxGapMs = clusterRows.slice(1).reduce(
        (largest, item, index) =>
          Math.max(
            largest,
            item.firstTradeTime - clusterRows[index].lastTradeTime,
          ),
        0,
      );
      const clusterId = `symbol:${options.side}:${symbol}:${first.id}:${last.id}`;
      candidates.push({
        sequence: last.sequence,
        id: clusterId,
        symbol,
        side: options.side,
        averagePrice:
          clusterNotional > 0
            ? weightedPrice / clusterNotional
            : last.averagePrice,
        filledQuantity,
        notional: clusterNotional,
        eventCount: clusterEventCount,
        bucketStart: first.bucketStart,
        bucketEnd: last.bucketEnd,
        firstTradeTime: first.firstTradeTime,
        lastTradeTime: last.lastTradeTime,
        firstReceivedAt: first.firstReceivedAt,
        lastReceivedAt: last.lastReceivedAt,
        triggerScope: "SINGLE_SYMBOL",
        marketClusterId: clusterId,
        marketClusterNotional: clusterNotional,
        marketClusterEventCount: clusterEventCount,
        marketClusterSymbolCount: 1,
        marketClusterSpanMs: Math.max(
          0,
          last.lastTradeTime - first.firstTradeTime,
        ),
        marketClusterMaxGapMs: clusterMaxGapMs,
        configuredMaxInterEventGapMs: maxInterEventGapMs,
        marketTriggerMode: singleStrongSignal
          ? "SINGLE_STRONG"
          : "ACCUMULATED_CONTINUOUS",
        symbolLiquidationNotional: clusterNotional,
        symbolEventCount: clusterEventCount,
        symbolLiquidationSharePercent: 100,
        symbolContributionRank: 1,
      });
    }
  }

  return candidates.sort(chronological);
}
