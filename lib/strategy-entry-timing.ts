import type { LiquidationTrendConfig } from "./liquidation-trend-config.ts";
import type { MarketLiquidityLane } from "./market-liquidity-priority.ts";

export const NEXUS_STRATEGY_ENTRY_TIMING_VERSION =
  "nexus-strategy-entry-timing-v1" as const;

export type StrategyEntryTimingProfile = ReturnType<
  typeof resolveStrategyEntryTimingProfile
>;

/**
 * A strategy owns only wake-up and entry timing. The shared eye still
 * supplies facts and the shared NEXUS brain still approves or rejects entry.
 */
export function resolveStrategyEntryTimingProfile(input: {
  config: LiquidationTrendConfig;
  strategyType: string;
}) {
  const tradfi = input.config.marketProfile?.mode === "TRADFI";
  const relativeStrength =
    input.config.marketProfile?.mode === "RELATIVE_STRENGTH";
  const trendPullback =
    input.config.marketProfile?.mode === "TREND_PULLBACK";
  const highPositionShort =
    input.config.marketProfile?.mode === "HIGH_POSITION_SHORT";
  const lowPositionLong =
    input.config.marketProfile?.mode === "LOW_POSITION_LONG";
  const gridPrice = input.config.marketProfile?.mode === "GRID_PRICE";
  const scheduledScan = input.config.marketProfile?.mode === "SCHEDULED_SCAN";
  const breakoutRetest = input.config.marketProfile?.mode === "BREAKOUT_RETEST";
  const sentinel = input.strategyType === "SENTINEL";
  const inverse = input.config.execution.directionMode === "INVERSE_BRAIN";
  const profile = relativeStrength
    ? "RELATIVE_STRENGTH_PAIR_TIMING"
    : highPositionShort
    ? "HIGH_POSITION_SHORT_TIMING"
    : lowPositionLong
    ? "LOW_POSITION_LONG_TIMING"
    : gridPrice
    ? "GRID_PRICE_LEVEL_TIMING"
    : scheduledScan
    ? "SCHEDULED_SCAN_TIMING"
    : breakoutRetest
    ? "BREAKOUT_RETEST_TIMING"
    : trendPullback
    ? "HIGH_LIQUIDITY_TREND_PULLBACK_TIMING"
    : tradfi
    ? "TRADFI_PRICE_VOLUME_TIMING"
    : sentinel
      ? "LIQUIDATION_SENTINEL_TIMING"
      : inverse
        ? "LIQUIDATION_INVERSE_EXECUTION_TIMING"
        : "LIQUIDATION_WAVE_TIMING";

  return {
    version: NEXUS_STRATEGY_ENTRY_TIMING_VERSION,
    profile,
    wakeAdapter: relativeStrength
      ? "RELATIVE_STRENGTH_PRICE_VOLUME_STRUCTURE"
      : highPositionShort
      ? "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
      : lowPositionLong
      ? "LOW_POSITION_WINDOW"
      : gridPrice
      ? "GRID_PRICE_LEVEL"
      : scheduledScan
      ? "SCHEDULED_SCAN"
      : breakoutRetest
      ? "BREAKOUT_RETEST"
      : trendPullback
      ? "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE"
      : tradfi
      ? "TRADFI_PRICE_VOLUME_STRUCTURE"
      : "LIQUIDATION_WAVE",
    entryResponsibility: "WAKE_AND_TIMING_ONLY" as const,
    sharedEyeRequired: true,
    sharedBrainConfirmationRequired: true,
    directionHandling: relativeStrength
      ? "STRONG_LONG_WEAK_SHORT_PAIR"
      : inverse
      ? "INVERT_AFTER_SHARED_BRAIN_APPROVAL"
      : "FOLLOW_SHARED_BRAIN_APPROVAL",
    observationOnly: sentinel,
    postFillLifecycleAuthority: false,
  };
}

export type TradfiTimingCandidateRow = {
  symbol: string;
  quoteVolume24h: number | null;
  lastPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  marketSyncedAt: Date | null;
};

export type TradfiTimingSelectionEvidence = {
  lane: "PRIORITY" | "DISCOVERY" | "FILL";
  marketLiquidityLane: MarketLiquidityLane;
  cachedPosition24hPercent: number | null;
  quoteVolume24h: number | null;
  marketSyncedAtMs: number | null;
};

/**
 * Spend the bounded K-line budget on likely high-position candidates without
 * losing broad-market discovery. With a budget of two, one slot rotates over
 * the highest cached 24h positions and one continues full-universe discovery.
 */
export function selectTradfiEntryTimingCandidates<
  T extends TradfiTimingCandidateRow,
>(input: {
  rows: T[];
  maxCandidates: number;
  priorityCursor: number;
  discoveryCursor: number;
  marketLiquidityLane?: MarketLiquidityLane;
}) {
  const ordered = [...input.rows]
    .filter((row) => row.symbol.trim().length > 0)
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  const maxCandidates = Math.min(
    ordered.length,
    Math.max(1, Math.trunc(input.maxCandidates)),
  );
  if (!ordered.length)
    return {
      rows: [] as T[],
      evidenceBySymbol: {} as Record<string, TradfiTimingSelectionEvidence>,
      priorityPoolSize: 0,
      nextPriorityCursor: 0,
      nextDiscoveryCursor: 0,
    };

  const ranked = [...ordered].sort((left, right) =>
    compareTradfiTimingPriority(left, right)
  );
  const priorityPoolSize = Math.min(
    ranked.length,
    Math.max(12, maxCandidates * 8),
  );
  const priorityPool = ranked.slice(0, priorityPoolSize);
  const prioritySlots = maxCandidates === 1 ? 1 : maxCandidates - 1;
  const discoverySlots = maxCandidates - prioritySlots;
  const selected: T[] = [];
  const evidenceBySymbol: Record<string, TradfiTimingSelectionEvidence> = {};
  const selectedSymbols = new Set<string>();

  const priority = takeRotating(priorityPool, input.priorityCursor, prioritySlots);
  for (const row of priority.rows) add(row, "PRIORITY");
  const discovery = takeRotating(
    ordered,
    input.discoveryCursor,
    Math.max(discoverySlots, 1),
    selectedSymbols,
  );
  if (discoverySlots > 0)
    for (const row of discovery.rows.slice(0, discoverySlots))
      add(row, "DISCOVERY");

  for (const row of ranked) {
    if (selected.length >= maxCandidates) break;
    add(row, "FILL");
  }

  return {
    rows: selected,
    evidenceBySymbol,
    priorityPoolSize,
    nextPriorityCursor: priority.nextCursor,
    nextDiscoveryCursor: discovery.nextCursor,
  };

  function add(
    row: T,
    lane: TradfiTimingSelectionEvidence["lane"],
  ) {
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol || selectedSymbols.has(symbol)) return;
    selectedSymbols.add(symbol);
    selected.push(row);
    evidenceBySymbol[symbol] = {
      lane,
      marketLiquidityLane: input.marketLiquidityLane ?? "PRIMARY",
      cachedPosition24hPercent: cachedPosition24hPercent(row),
      quoteVolume24h: finiteOrNull(row.quoteVolume24h),
      marketSyncedAtMs:
        row.marketSyncedAt instanceof Date &&
          Number.isFinite(row.marketSyncedAt.getTime())
          ? row.marketSyncedAt.getTime()
          : null,
    };
  }
}

function takeRotating<T>(
  rows: T[],
  cursor: number,
  count: number,
  excluded = new Set<unknown>(),
) {
  if (!rows.length || count <= 0)
    return { rows: [] as T[], nextCursor: 0 };
  const start = normalizeCursor(cursor, rows.length);
  const selected: T[] = [];
  let visited = 0;
  while (visited < rows.length && selected.length < count) {
    const row = rows[(start + visited) % rows.length];
    const key = typeof row === "object" && row && "symbol" in row
      ? String((row as { symbol: unknown }).symbol).trim().toUpperCase()
      : row;
    if (!excluded.has(key)) selected.push(row);
    visited += 1;
  }
  return {
    rows: selected,
    nextCursor: (start + Math.max(visited, 1)) % rows.length,
  };
}

function compareTradfiTimingPriority(
  left: TradfiTimingCandidateRow,
  right: TradfiTimingCandidateRow,
) {
  return (
    (cachedPosition24hPercent(right) ?? -1) -
      (cachedPosition24hPercent(left) ?? -1) ||
    (finiteOrNull(right.quoteVolume24h) ?? -1) -
      (finiteOrNull(left.quoteVolume24h) ?? -1) ||
    right.symbol.localeCompare(left.symbol)
  );
}

function cachedPosition24hPercent(row: TradfiTimingCandidateRow) {
  const last = finiteOrNull(row.lastPrice);
  const high = finiteOrNull(row.highPrice);
  const low = finiteOrNull(row.lowPrice);
  if (last === null || high === null || low === null || high <= low)
    return null;
  return Math.min(100, Math.max(0, ((last - low) / (high - low)) * 100));
}

function finiteOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCursor(cursor: number, length: number) {
  if (!Number.isFinite(cursor) || length <= 0) return 0;
  return Math.abs(Math.trunc(cursor)) % length;
}
