import type { StrategyTriggerAdapter } from "./contract.ts";

export const GRID_PRICE_LEVEL_TRIGGER_VERSION =
  "grid-price-level-trigger-v1" as const;

export type GridPriceLevelFact = Readonly<{
  symbol: string;
  markPrice: number;
  eventAt: number;
  receivedAt: number;
  factSnapshotId: string;
}>;

export type GridPriceLevelTriggerCandidate = Readonly<{
  kind: "GRID_PRICE_LEVEL";
  symbol: string;
  direction: "LONG" | "SHORT";
  markPrice: number;
  gridLevel: number;
  gridIndex: number;
  gridCount: number;
  distanceBps: number;
  eventAt: number;
  receivedAt: number;
  factSnapshotId: string;
}>;

export const gridPriceLevelTriggerAdapter: StrategyTriggerAdapter<
  Readonly<{ rows: readonly GridPriceLevelFact[]; processedAt: number }>,
  Readonly<{
    lowerPrice: number;
    upperPrice: number;
    gridCount: number;
    activationToleranceBps: number;
    maxFactAgeMs: number;
    direction: "LONG_ONLY" | "SHORT_ONLY" | "BOTH";
  }>,
  GridPriceLevelTriggerCandidate
> = Object.freeze({
  kind: "GRID_PRICE_LEVEL",
  version: GRID_PRICE_LEVEL_TRIGGER_VERSION,
  requiredFacts: Object.freeze(["MARK_PRICE_SNAPSHOT" as const]),
  evaluate(input) {
    const config = input.config;
    if (
      !Number.isFinite(config.lowerPrice) ||
      !Number.isFinite(config.upperPrice) ||
      config.lowerPrice <= 0 ||
      config.upperPrice <= config.lowerPrice ||
      !Number.isInteger(config.gridCount) ||
      config.gridCount < 2 ||
      !Number.isFinite(config.activationToleranceBps) ||
      config.activationToleranceBps <= 0 ||
      !Number.isFinite(config.maxFactAgeMs) ||
      config.maxFactAgeMs <= 0 ||
      !Number.isFinite(input.facts.processedAt)
    ) return [];

    const latestBySymbol = latestValidFacts(
      input.facts.rows,
      input.facts.processedAt,
      config.maxFactAgeMs,
    );
    const step = (config.upperPrice - config.lowerPrice) /
      (config.gridCount - 1);
    const midpoint = (config.lowerPrice + config.upperPrice) / 2;
    return [...latestBySymbol.values()]
      .map((fact): GridPriceLevelTriggerCandidate | null => {
        const rawIndex = Math.round((fact.markPrice - config.lowerPrice) / step);
        const gridIndex = Math.max(0, Math.min(config.gridCount - 1, rawIndex));
        const gridLevel = config.lowerPrice + gridIndex * step;
        const distanceBps = Math.abs(fact.markPrice / gridLevel - 1) * 10_000;
        if (distanceBps > config.activationToleranceBps) return null;
        const direction = config.direction === "LONG_ONLY"
          ? "LONG" as const
          : config.direction === "SHORT_ONLY"
            ? "SHORT" as const
            : gridLevel <= midpoint
              ? "LONG" as const
              : "SHORT" as const;
        return {
          kind: "GRID_PRICE_LEVEL" as const,
          symbol: fact.symbol,
          direction,
          markPrice: fact.markPrice,
          gridLevel,
          gridIndex,
          gridCount: config.gridCount,
          distanceBps,
          eventAt: fact.eventAt,
          receivedAt: fact.receivedAt,
          factSnapshotId: fact.factSnapshotId,
        };
      })
      .filter((row): row is GridPriceLevelTriggerCandidate => row !== null)
      .sort((left, right) =>
        left.distanceBps - right.distanceBps ||
        left.symbol.localeCompare(right.symbol)
      );
  },
});

function latestValidFacts(
  rows: readonly GridPriceLevelFact[],
  processedAt: number,
  maxFactAgeMs: number,
) {
  const latest = new Map<string, GridPriceLevelFact>();
  for (const row of rows) {
    const symbol = row.symbol.trim().toUpperCase();
    if (
      !/^[A-Z0-9]{3,30}$/.test(symbol) ||
      !Number.isFinite(row.markPrice) ||
      row.markPrice <= 0 ||
      !Number.isFinite(row.eventAt) ||
      !Number.isFinite(row.receivedAt) ||
      row.eventAt <= 0 ||
      row.receivedAt < row.eventAt ||
      row.receivedAt > processedAt + 1_000 ||
      processedAt - row.receivedAt > maxFactAgeMs ||
      !row.factSnapshotId.trim()
    ) continue;
    const normalized = { ...row, symbol };
    const previous = latest.get(symbol);
    if (!previous || normalized.receivedAt > previous.receivedAt)
      latest.set(symbol, normalized);
  }
  return latest;
}
