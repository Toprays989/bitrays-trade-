import {
  revalidateNexusConfirmedLongEntry,
  revalidateNexusConfirmedShortEntry,
} from "./liquidation-entry-revalidation.ts";

export function resolveDirectionalEntryAnchors(input: {
  direction: "LONG" | "SHORT";
  approvedMarkPrice: number;
  atr5m: number;
  atrStopBuffer: number;
  priceTickSize: number;
}) {
  if (
    ![input.approvedMarkPrice, input.atr5m, input.atrStopBuffer,
      input.priceTickSize].every((value) => Number.isFinite(value) && value > 0)
  ) return null;
  const confirmationLevel = alignNearest(
    input.approvedMarkPrice,
    input.priceTickSize,
  );
  const invalidBoundary = input.direction === "LONG"
    ? alignDown(
        confirmationLevel - input.atr5m * input.atrStopBuffer,
        input.priceTickSize,
      )
    : alignUp(
        confirmationLevel + input.atr5m * input.atrStopBuffer,
        input.priceTickSize,
      );
  if (confirmationLevel <= 0 || invalidBoundary <= 0) return null;
  if (
    input.direction === "LONG"
      ? invalidBoundary >= confirmationLevel
      : invalidBoundary <= confirmationLevel
  ) return null;
  return {
    direction: input.direction,
    confirmationLevel,
    invalidBoundary,
    source: "STRUCTURE_WAKE_APPROVED_MARK_ATR_BOUNDARY" as const,
    derived: true as const,
  };
}

/**
 * The entry-direction comparison must use the live structural distance that
 * will be frozen into the order, never the position's emergency hard stop.
 * The latter protects an already-open position and is intentionally wider.
 */
export function directionalEntryStructuralRiskRoePercent(input: {
  approvedMarkPrice: number;
  atr5m: number;
  atrStopBuffer: number;
  leverage: number;
}) {
  if (
    ![
      input.approvedMarkPrice,
      input.atr5m,
      input.atrStopBuffer,
      input.leverage,
    ].every((value) => Number.isFinite(value) && value > 0)
  ) return null;
  const roe = input.atr5m * input.atrStopBuffer /
    input.approvedMarkPrice * input.leverage * 100;
  return Number.isFinite(roe) && roe > 0
    ? Math.round(roe * 1_000_000) / 1_000_000
    : null;
}

export function revalidateDirectionalEntry(input: {
  direction: "LONG" | "SHORT";
  executionMarkPrice: number;
  atr5m: number;
  confirmationLevel: number;
  invalidBoundary: number;
  maxEntryDistanceAtr: number;
  requireConfirmedEntryDistance?: boolean;
}) {
  if (input.direction === "LONG")
    return revalidateNexusConfirmedLongEntry({
      executionMarkPrice: input.executionMarkPrice,
      atr5m: input.atr5m,
      confirmationLevel: input.confirmationLevel,
      invalidBoundary: input.invalidBoundary,
      maxEntryDistanceAtr: input.maxEntryDistanceAtr,
      requireConfirmedEntryDistance: input.requireConfirmedEntryDistance,
    });
  const result = revalidateNexusConfirmedShortEntry({
    executionMarkPrice: input.executionMarkPrice,
    atr5m: input.atr5m,
    brokenSupport: input.confirmationLevel,
    maxEntryDistanceAtr: input.maxEntryDistanceAtr,
    requireConfirmedEntryDistance: input.requireConfirmedEntryDistance,
  });
  if (input.executionMarkPrice > input.invalidBoundary)
    return {
      eligible: false,
      code: "STRUCTURE_INVALIDATED" as const,
      entryDistanceAtr: result.entryDistanceAtr,
    };
  return result;
}

function alignNearest(value: number, tick: number) {
  return Number((Math.round(value / tick) * tick).toPrecision(15));
}

function alignDown(value: number, tick: number) {
  return Number((Math.floor((value + tick * 1e-8) / tick) * tick).toPrecision(15));
}

function alignUp(value: number, tick: number) {
  return Number((Math.ceil((value - tick * 1e-8) / tick) * tick).toPrecision(15));
}
