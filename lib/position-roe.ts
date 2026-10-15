export type PositionSide = "LONG" | "SHORT";

export function positionRoePercent(
  entryPrice: number,
  markPrice: number,
  leverage: number,
  positionSide: PositionSide,
) {
  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(markPrice) ||
    !Number.isFinite(leverage) ||
    leverage <= 0
  )
    return Number.NaN;
  const priceMove =
    positionSide === "LONG"
      ? (markPrice - entryPrice) / entryPrice
      : (entryPrice - markPrice) / entryPrice;
  return priceMove * leverage * 100;
}

export function priceAtRoePercent(
  entryPrice: number,
  targetRoePercent: number,
  leverage: number,
  positionSide: PositionSide,
) {
  const safeLeverage = Math.max(leverage, 1);
  const priceMove = targetRoePercent / safeLeverage / 100;
  return positionSide === "LONG"
    ? entryPrice * (1 + priceMove)
    : entryPrice * (1 - priceMove);
}
