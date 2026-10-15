import {
  closedUnifiedCandleMarketFacts,
  type NexusMarketFact,
  type NexusOpenTimeCandle,
} from "./nexus-market-facts.ts";

/** Request-scoped reuse of immutable facts derived from one closed snapshot. */
export class NexusMarketFactCycle {
  private readonly facts = new Map<string, NexusMarketFact[]>();

  closedCandles(input: {
    symbol: string;
    interval: string;
    candles: readonly NexusOpenTimeCandle[];
    receivedAt?: number;
    structureLookback?: number;
    volumeLookback?: number;
    volumeExpansionRatio?: number;
  }) {
    const receivedAt = input.receivedAt ?? Date.now();
    const structureLookback = Math.max(
      2,
      Math.trunc(input.structureLookback ?? 20),
    );
    const volumeLookback = Math.max(
      2,
      Math.trunc(input.volumeLookback ?? 20),
    );
    const volumeExpansionRatio = Math.max(
      1,
      input.volumeExpansionRatio ?? 1.5,
    );
    const firstOpenTime = input.candles.at(0)?.openTime ?? -1;
    const latestOpenTime = input.candles.at(-1)?.openTime ?? -1;
    const key = [
      input.symbol.trim().toUpperCase(),
      input.interval,
      firstOpenTime,
      latestOpenTime,
      input.candles.length,
      receivedAt,
      structureLookback,
      volumeLookback,
      volumeExpansionRatio,
    ].join(":");
    const existing = this.facts.get(key);
    if (existing) return existing;
    const facts = closedUnifiedCandleMarketFacts({
      ...input,
      receivedAt,
      structureLookback,
      volumeLookback,
      volumeExpansionRatio,
    });
    this.facts.set(key, facts);
    return facts;
  }

  clear() {
    this.facts.clear();
  }
}
