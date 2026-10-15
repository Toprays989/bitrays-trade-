export function liquidationGuard(input: {
  positionSide: "LONG" | "SHORT";
  markPrice: number;
  liquidationPrice: number | null | undefined;
  bufferPercent: number;
}) {
  if (
    !Number.isFinite(input.markPrice) ||
    input.markPrice <= 0 ||
    !Number.isFinite(input.liquidationPrice) ||
    Number(input.liquidationPrice) <= 0 ||
    !Number.isFinite(input.bufferPercent) ||
    input.bufferPercent <= 0
  ) return { available: false, hit: false, guardPrice: null };
  const liquidationPrice = Number(input.liquidationPrice);
  const directionallyValid = input.positionSide === "LONG"
    ? liquidationPrice < input.markPrice
    : liquidationPrice > input.markPrice;
  if (!directionallyValid)
    return { available: false, hit: false, guardPrice: null };
  const guardPrice = input.positionSide === "LONG"
    ? liquidationPrice * (1 + input.bufferPercent / 100)
    : liquidationPrice * (1 - input.bufferPercent / 100);
  return {
    available: true,
    guardPrice,
    hit: input.positionSide === "LONG"
      ? input.markPrice <= guardPrice
      : input.markPrice >= guardPrice,
  };
}
