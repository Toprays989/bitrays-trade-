import type { NexusUnifiedCandle } from "../nexus-unified-market-data.ts";
import type { StrategyTriggerAdapter } from "./contract.ts";

export const BREAKOUT_RETEST_TRIGGER_VERSION =
  "breakout-retest-trigger-v1" as const;

export type BreakoutRetestFact = Readonly<{
  symbol: string;
  markPrice: number;
  markEventAt: number;
  markReceivedAt: number;
  candles: readonly NexusUnifiedCandle[];
  candleReceivedAt: number;
  factSnapshotId: string;
}>;

export type BreakoutRetestTriggerCandidate = Readonly<{
  kind: "BREAKOUT_RETEST";
  symbol: string;
  direction: "LONG" | "SHORT";
  referencePrice: number;
  breakoutLevel: number;
  breakoutClose: number;
  breakoutAt: number;
  retestAt: number;
  breakoutDistanceBps: number;
  retestDistanceBps: number;
  breakoutVolumeRatio: number;
  eventAt: number;
  receivedAt: number;
  factSnapshotId: string;
}>;

const FIVE_MINUTES_MS = 5 * 60_000;

export const breakoutRetestTriggerAdapter: StrategyTriggerAdapter<
  Readonly<{ rows: readonly BreakoutRetestFact[]; processedAt: number }>,
  Readonly<{
    lookbackCandles: number;
    maximumRetestCandles: number;
    minimumBreakoutBps: number;
    retestToleranceBps: number;
    minimumBreakoutVolumeRatio: number;
    maxFactAgeMs: number;
    direction: "LONG_ONLY" | "SHORT_ONLY" | "BOTH";
  }>,
  BreakoutRetestTriggerCandidate
> = Object.freeze({
  kind: "BREAKOUT_RETEST",
  version: BREAKOUT_RETEST_TRIGGER_VERSION,
  requiredFacts: Object.freeze([
    "MARK_PRICE_SNAPSHOT" as const,
    "MARK_PRICE_MULTI_INTERVAL_CLOSED_CANDLES" as const,
  ]),
  evaluate(input) {
    if (!validConfig(input.config, input.facts.processedAt)) return [];
    return input.facts.rows
      .map((fact) => evaluateRow(fact, input.facts.processedAt, input.config))
      .filter((row): row is BreakoutRetestTriggerCandidate => row !== null)
      .sort((left, right) =>
        right.breakoutAt - left.breakoutAt ||
        left.retestDistanceBps - right.retestDistanceBps ||
        left.symbol.localeCompare(right.symbol)
      );
  },
});

function evaluateRow(
  fact: BreakoutRetestFact,
  processedAt: number,
  config: Parameters<typeof validConfig>[0],
): BreakoutRetestTriggerCandidate | null {
  const symbol = fact.symbol.trim().toUpperCase();
  if (
    !/^[A-Z0-9]{3,30}$/.test(symbol) ||
    !Number.isFinite(fact.markPrice) ||
    fact.markPrice <= 0 ||
    ![fact.markEventAt, fact.markReceivedAt, fact.candleReceivedAt]
      .every(Number.isFinite) ||
    fact.markEventAt <= 0 ||
    fact.markReceivedAt < fact.markEventAt ||
    fact.candleReceivedAt <= 0 ||
    fact.markReceivedAt > processedAt + 1_000 ||
    fact.candleReceivedAt > processedAt + 1_000 ||
    processedAt - fact.markReceivedAt > config.maxFactAgeMs ||
    processedAt - fact.candleReceivedAt > config.maxFactAgeMs ||
    !fact.factSnapshotId.trim()
  ) return null;
  const candles = fact.candles
    .filter(validCandle)
    .slice()
    .sort((left, right) => left.openTime - right.openTime);
  if (candles.length < config.lookbackCandles + 2) return null;
  const latest = candles.at(-1)!;
  const latestEventAt = latest.openTime + FIVE_MINUTES_MS - 1;
  if (
    latestEventAt > processedAt + 1_000 ||
    fact.candleReceivedAt < latestEventAt ||
    processedAt - latestEventAt > config.maxFactAgeMs
  ) return null;
  const earliestBreakoutIndex = Math.max(
    config.lookbackCandles,
    candles.length - 1 - config.maximumRetestCandles,
  );
  for (
    let breakoutIndex = candles.length - 2;
    breakoutIndex >= earliestBreakoutIndex;
    breakoutIndex -= 1
  ) {
    const breakout = candles[breakoutIndex];
    const prior = candles.slice(
      breakoutIndex - config.lookbackCandles,
      breakoutIndex,
    );
    const priorHigh = Math.max(...prior.map((row) => row.high));
    const priorLow = Math.min(...prior.map((row) => row.low));
    const averageVolume = prior.reduce((sum, row) => sum + row.volume, 0) /
      prior.length;
    const breakoutVolumeRatio = averageVolume > 0
      ? breakout.volume / averageVolume
      : 0;
    if (breakoutVolumeRatio < config.minimumBreakoutVolumeRatio) continue;
    const breakoutAt = breakout.openTime + FIVE_MINUTES_MS - 1;
    const afterBreakout = candles.slice(breakoutIndex + 1);
    const longDistanceBps = (breakout.close / priorHigh - 1) * 10_000;
    if (
      config.direction !== "SHORT_ONLY" &&
      longDistanceBps >= config.minimumBreakoutBps
    ) {
      const tolerance = priorHigh * config.retestToleranceBps / 10_000;
      const touched = afterBreakout.some((row) => row.low <= priorHigh + tolerance);
      const held = afterBreakout.every((row) => row.close >= priorHigh - tolerance);
      const retestDistanceBps = Math.abs(fact.markPrice / priorHigh - 1) * 10_000;
      if (touched && held && retestDistanceBps <= config.retestToleranceBps)
        return candidate({
          fact,
          symbol,
          direction: "LONG",
          breakoutLevel: priorHigh,
          breakoutClose: breakout.close,
          breakoutAt,
          retestAt: latestEventAt,
          breakoutDistanceBps: longDistanceBps,
          retestDistanceBps,
          breakoutVolumeRatio,
        });
    }
    const shortDistanceBps = (priorLow / breakout.close - 1) * 10_000;
    if (
      config.direction !== "LONG_ONLY" &&
      shortDistanceBps >= config.minimumBreakoutBps
    ) {
      const tolerance = priorLow * config.retestToleranceBps / 10_000;
      const touched = afterBreakout.some((row) => row.high >= priorLow - tolerance);
      const held = afterBreakout.every((row) => row.close <= priorLow + tolerance);
      const retestDistanceBps = Math.abs(fact.markPrice / priorLow - 1) * 10_000;
      if (touched && held && retestDistanceBps <= config.retestToleranceBps)
        return candidate({
          fact,
          symbol,
          direction: "SHORT",
          breakoutLevel: priorLow,
          breakoutClose: breakout.close,
          breakoutAt,
          retestAt: latestEventAt,
          breakoutDistanceBps: shortDistanceBps,
          retestDistanceBps,
          breakoutVolumeRatio,
        });
    }
  }
  return null;
}

function candidate(input: {
  fact: BreakoutRetestFact;
  symbol: string;
  direction: "LONG" | "SHORT";
  breakoutLevel: number;
  breakoutClose: number;
  breakoutAt: number;
  retestAt: number;
  breakoutDistanceBps: number;
  retestDistanceBps: number;
  breakoutVolumeRatio: number;
}): BreakoutRetestTriggerCandidate {
  return {
    kind: "BREAKOUT_RETEST",
    symbol: input.symbol,
    direction: input.direction,
    referencePrice: input.fact.markPrice,
    breakoutLevel: input.breakoutLevel,
    breakoutClose: input.breakoutClose,
    breakoutAt: input.breakoutAt,
    retestAt: input.retestAt,
    breakoutDistanceBps: input.breakoutDistanceBps,
    retestDistanceBps: input.retestDistanceBps,
    breakoutVolumeRatio: input.breakoutVolumeRatio,
    eventAt: input.retestAt,
    receivedAt: Math.max(
      input.fact.markReceivedAt,
      input.fact.candleReceivedAt,
    ),
    factSnapshotId: input.fact.factSnapshotId,
  };
}

function validConfig(
  config: Readonly<{
    lookbackCandles: number;
    maximumRetestCandles: number;
    minimumBreakoutBps: number;
    retestToleranceBps: number;
    minimumBreakoutVolumeRatio: number;
    maxFactAgeMs: number;
    direction: "LONG_ONLY" | "SHORT_ONLY" | "BOTH";
  }>,
  processedAt: number,
) {
  return Number.isFinite(processedAt) && processedAt > 0 &&
    Number.isInteger(config.lookbackCandles) && config.lookbackCandles >= 2 &&
    Number.isInteger(config.maximumRetestCandles) && config.maximumRetestCandles >= 1 &&
    Number.isFinite(config.minimumBreakoutBps) && config.minimumBreakoutBps > 0 &&
    Number.isFinite(config.retestToleranceBps) && config.retestToleranceBps > 0 &&
    Number.isFinite(config.minimumBreakoutVolumeRatio) &&
    config.minimumBreakoutVolumeRatio > 0 &&
    Number.isFinite(config.maxFactAgeMs) && config.maxFactAgeMs > 0;
}

function validCandle(row: NexusUnifiedCandle) {
  return Number.isFinite(row.openTime) && row.openTime > 0 &&
    [row.open, row.high, row.low, row.close]
      .every((value) => Number.isFinite(value) && value > 0) &&
    row.high >= Math.max(row.open, row.close, row.low) &&
    row.low <= Math.min(row.open, row.close, row.high) &&
    Number.isFinite(row.volume) && row.volume >= 0;
}
