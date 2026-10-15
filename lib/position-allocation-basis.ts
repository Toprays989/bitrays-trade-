export type PositionAllocationFill = {
  quantity: number;
  entryPrice: number;
};

export function positionAllocationEntryPrice(
  source: PositionAllocationFill | null | undefined,
  additions: PositionAllocationFill[],
  fallbackEntryPrice: number,
) {
  const fills = [source, ...additions].filter(
    (fill): fill is PositionAllocationFill =>
      Boolean(fill) &&
      Number.isFinite(fill?.quantity) &&
      fill!.quantity > 0 &&
      Number.isFinite(fill?.entryPrice) &&
      fill!.entryPrice > 0,
  );
  const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  const notional = fills.reduce(
    (sum, fill) => sum + fill.quantity * fill.entryPrice,
    0,
  );
  return quantity > 0 && notional > 0
    ? notional / quantity
    : fallbackEntryPrice;
}
