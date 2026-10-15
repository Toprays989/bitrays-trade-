export type FavorablePricePositionSide = "LONG" | "SHORT";

function positiveFinite(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? numberValue
    : null;
}

/**
 * Maintains the best mark seen for an unchanged position cost basis.
 *
 * A long position may only raise its favorable price and a short position may
 * only lower it. The peak is deliberately reset only when a new cost basis or
 * a newly enabled protection cycle explicitly starts a fresh measurement.
 */
export function monotonicFavorablePrice(input: {
  positionSide: FavorablePricePositionSide;
  entryPrice: number;
  previousFavorablePrice?: number | null;
  currentMarkPrice?: number | null;
  reset?: boolean;
}) {
  const entryPrice = positiveFinite(input.entryPrice);
  const previousFavorablePrice =
    positiveFinite(input.previousFavorablePrice) ?? entryPrice;
  const currentMarkPrice = positiveFinite(input.currentMarkPrice);

  if (input.reset)
    return currentMarkPrice ?? previousFavorablePrice;
  if (previousFavorablePrice === null) return currentMarkPrice;
  if (currentMarkPrice === null) return previousFavorablePrice;

  return input.positionSide === "SHORT"
    ? Math.min(previousFavorablePrice, currentMarkPrice)
    : Math.max(previousFavorablePrice, currentMarkPrice);
}
