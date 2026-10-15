import { getBinanceLiveOpenInterestHistory } from "./binance-usdm-live";
import {
  pruneLiquidationFactorOpenInterestCache,
  type LiquidationFactorOpenInterestContext as OpenInterestContext,
  type LiquidationFactorOpenInterestCacheEntry,
} from "./liquidation-factor-open-interest-cache";

const CACHE_MS = 60_000;
const cache = new Map<
  string,
  LiquidationFactorOpenInterestCacheEntry
>();

/** One bounded public OI read per symbol/minute, shared by every local brain. */
export async function readLiquidationFactorOpenInterest(symbol: string) {
  const key = symbol.trim().toUpperCase();
  const now = Date.now();
  pruneLiquidationFactorOpenInterestCache(cache, now);
  const current = cache.get(key);
  if (current && current.expiresAt > now) return current.value;
  const value = await load(key).catch(() => ({
      observedAt: Date.now(),
      latestDataAt: null,
      openInterestValue: null,
      openInterestChangePercent: null,
      status: "UNAVAILABLE" as const,
    }));
  cache.set(key, { expiresAt: Date.now() + CACHE_MS, value });
  pruneLiquidationFactorOpenInterestCache(cache);
  return value;
}

async function load(symbol: string): Promise<OpenInterestContext> {
  const points = (await getBinanceLiveOpenInterestHistory(symbol, "5m", 3))
    .filter((point) =>
      Number.isFinite(point.timestamp) &&
      Number.isFinite(point.value) &&
      point.value > 0
    )
    .sort((left, right) => left.timestamp - right.timestamp);
  const latest = points.at(-1) ?? null;
  const previous = points.at(-2) ?? null;
  return {
    observedAt: Date.now(),
    latestDataAt: latest?.timestamp ?? null,
    openInterestValue: latest?.value ?? null,
    openInterestChangePercent:
      latest && previous && previous.value > 0
        ? (latest.value - previous.value) / previous.value * 100
        : null,
    status: latest && previous ? "AVAILABLE" : "UNAVAILABLE",
  };
}
