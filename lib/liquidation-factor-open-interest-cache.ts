export type LiquidationFactorOpenInterestContext = {
  observedAt: number;
  latestDataAt: number | null;
  openInterestValue: number | null;
  openInterestChangePercent: number | null;
  status: "AVAILABLE" | "UNAVAILABLE";
};

export const LIQUIDATION_FACTOR_OPEN_INTEREST_CACHE_MAXIMUM_ENTRIES = 256;

export type LiquidationFactorOpenInterestCacheEntry = {
  expiresAt: number;
  value: LiquidationFactorOpenInterestContext;
};

export function pruneLiquidationFactorOpenInterestCache(
  entries: Map<string, LiquidationFactorOpenInterestCacheEntry>,
  now = Date.now(),
) {
  for (const [cacheKey, value] of entries)
    if (value.expiresAt <= now) entries.delete(cacheKey);
  while (entries.size > LIQUIDATION_FACTOR_OPEN_INTEREST_CACHE_MAXIMUM_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (typeof oldestKey !== "string") break;
    entries.delete(oldestKey);
  }
}
