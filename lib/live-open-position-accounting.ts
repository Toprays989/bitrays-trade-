export type LiveOpenPositionAccounting = Readonly<{
  grossUnrealizedPnlUsdt: number;
  estimatedEntryFeeUsdt: number;
  estimatedExitFeeUsdt: number;
  estimatedTradingFeesUsdt: number;
  netPnlAfterTradingFeesUsdt: number;
  projectedNextFundingPnlUsdt: number | null;
  netPnlIncludingProjectedFundingUsdt: number | null;
  netRoeAfterTradingFeesPercent: number;
  feeRatePercent: number;
}>;

/**
 * Mark-to-market accounting for an open USDⓈ-M position.
 *
 * Trading commission is estimated from the frozen strategy fee setting until
 * Binance user-trade settlement makes the completed lifecycle exact. Funding
 * is deliberately kept separate: it is a periodic payment, not a cost that
 * accrues into realised PnL every second.
 */
export function liveOpenPositionAccounting(input: {
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  estimatedRoundTripFeePercent?: number | null;
  fundingRate?: number | null;
}): LiveOpenPositionAccounting | null {
  const quantity = positive(input.quantity);
  const entryPrice = positive(input.entryPrice);
  const markPrice = positive(input.markPrice);
  const leverage = positive(input.leverage);
  if (quantity === null || entryPrice === null || markPrice === null || leverage === null)
    return null;

  const feeRatePercent = boundedNonNegative(
    input.estimatedRoundTripFeePercent,
    0.08,
  );
  const feeRate = feeRatePercent / 100;
  const entryNotional = quantity * entryPrice;
  const currentNotional = quantity * markPrice;
  const grossUnrealizedPnlUsdt = input.positionSide === "LONG"
    ? (markPrice - entryPrice) * quantity
    : (entryPrice - markPrice) * quantity;
  const estimatedEntryFeeUsdt = entryNotional * feeRate / 2;
  const estimatedExitFeeUsdt = currentNotional * feeRate / 2;
  const estimatedTradingFeesUsdt = estimatedEntryFeeUsdt + estimatedExitFeeUsdt;
  const netPnlAfterTradingFeesUsdt =
    grossUnrealizedPnlUsdt - estimatedTradingFeesUsdt;
  const fundingRate = finite(input.fundingRate);
  const projectedNextFundingPnlUsdt = fundingRate === null
    ? null
    : currentNotional * fundingRate * (input.positionSide === "LONG" ? -1 : 1);
  const marginBasis = entryNotional / leverage;
  const netRoeAfterTradingFeesPercent = marginBasis > 0
    ? netPnlAfterTradingFeesUsdt / marginBasis * 100
    : 0;

  return Object.freeze({
    grossUnrealizedPnlUsdt,
    estimatedEntryFeeUsdt,
    estimatedExitFeeUsdt,
    estimatedTradingFeesUsdt,
    netPnlAfterTradingFeesUsdt,
    projectedNextFundingPnlUsdt,
    netPnlIncludingProjectedFundingUsdt:
      projectedNextFundingPnlUsdt === null
        ? null
        : netPnlAfterTradingFeesUsdt + projectedNextFundingPnlUsdt,
    netRoeAfterTradingFeesPercent,
    feeRatePercent,
  });
}

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedNonNegative(value: unknown, fallback: number) {
  const number = finite(value);
  return number === null || number < 0 || number > 2 ? fallback : number;
}
