function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Binance force-order snapshots expose three different quantities:
 * - z: accumulated filled quantity for this liquidation order
 * - q: original order quantity
 * - l: only the final individual fill quantity
 *
 * Liquidation notional must use the accumulated filled quantity. Using `l`
 * severely undercounts a force order that was matched in multiple fills.
 */
export function liquidationFilledQuantity(order) {
  const accumulatedFilled = positiveNumber(order?.z);
  if (accumulatedFilled > 0) return accumulatedFilled;

  const originalQuantity = positiveNumber(order?.q);
  if (originalQuantity > 0) return originalQuantity;

  return positiveNumber(order?.l);
}
