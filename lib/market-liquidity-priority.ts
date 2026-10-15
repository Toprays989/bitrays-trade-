export const PRIMARY_MARKET_QUOTE_VOLUME_24H_USDT = 300_000_000;

export type MarketLiquidityLane = "PRIMARY" | "FALLBACK";

export function marketLiquidityLane(
  quoteVolume24h: number | null | undefined,
): MarketLiquidityLane {
  const volume = Number(quoteVolume24h);
  return Number.isFinite(volume) &&
      volume >= PRIMARY_MARKET_QUOTE_VOLUME_24H_USDT
    ? "PRIMARY"
    : "FALLBACK";
}

export function isPrimaryLiquidityMarket(
  quoteVolume24h: number | null | undefined,
) {
  return marketLiquidityLane(quoteVolume24h) === "PRIMARY";
}

export function partitionMarketLiquidity<T>(
  rows: T[],
  quoteVolume: (row: T) => number | null | undefined,
) {
  const primary: T[] = [];
  const fallback: T[] = [];
  for (const row of rows) {
    (isPrimaryLiquidityMarket(quoteVolume(row)) ? primary : fallback).push(row);
  }
  return { primary, fallback };
}

/**
 * Candidate scheduling only. This never approves an order or changes the
 * shared eye/brain decision. Stable ordering preserves the original order
 * inside each liquidity lane.
 */
export function prioritizePrimaryLiquidity<T>(
  rows: T[],
  quoteVolume: (row: T) => number | null | undefined,
) {
  const { primary, fallback } = partitionMarketLiquidity(rows, quoteVolume);
  return [...primary, ...fallback];
}
