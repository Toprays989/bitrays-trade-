export type ExchangeZeroCloseResolution = {
  executedQuantity: number;
  provisionalExitPrice: number;
  localGrossRealizedPnl: number;
};

export function resolveExchangeZeroClose(input: {
  localQuantity: number;
  entryPrice: number;
  lastMarkPrice: number;
  positionSide: "LONG" | "SHORT";
}): ExchangeZeroCloseResolution | null {
  const executedQuantity = Number(input.localQuantity);
  if (!Number.isFinite(executedQuantity) || executedQuantity <= 0) return null;
  const markPrice = Number(input.lastMarkPrice);
  const entryPrice = Number(input.entryPrice);
  const provisionalExitPrice = Number.isFinite(markPrice) && markPrice > 0
    ? markPrice
    : Number.isFinite(entryPrice) && entryPrice > 0
      ? entryPrice
      : 0;
  if (provisionalExitPrice <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0)
    return null;
  const localGrossRealizedPnl = input.positionSide === "LONG"
    ? (provisionalExitPrice - entryPrice) * executedQuantity
    : (entryPrice - provisionalExitPrice) * executedQuantity;
  return {
    executedQuantity,
    provisionalExitPrice,
    localGrossRealizedPnl,
  };
}
