export type LiquidationEntryRevalidationCode =
  | "ENTRY_REVALIDATED"
  | "ENTRY_REVALIDATION_DATA_INVALID"
  | "POSITION_72H_ABOVE_LIMIT"
  | "STRUCTURE_INVALIDATED"
  | "BELOW_CONFIRMATION"
  | "PRICE_TOO_FAR";

export type NexusConfirmedEntryRevalidationCode =
  | "ENTRY_REVALIDATED"
  | "ENTRY_REVALIDATION_DATA_INVALID"
  | "STRUCTURE_INVALIDATED"
  | "BELOW_CONFIRMATION"
  | "PRICE_TOO_FAR";

export type NexusConfirmedShortEntryRevalidationCode =
  | "ENTRY_REVALIDATED"
  | "ENTRY_REVALIDATION_DATA_INVALID"
  | "BROKEN_SUPPORT_RECLAIMED"
  | "PRICE_TOO_FAR";

/**
 * Runtime revalidation for the NEXUS brain/eye path.
 *
 * The market eye has already selected a named state-machine path. The final
 * check therefore validates only fresh execution price against that path's
 * confirmation/invalidation anchors and ATR distance. It intentionally does
 * not reintroduce 24h/72h position gates from the retired analyzer.
 */
export function revalidateNexusConfirmedLongEntry(input: {
  executionMarkPrice: number;
  atr5m: number;
  confirmationLevel: number;
  invalidBoundary: number;
  maxEntryDistanceAtr: number;
  requireConfirmedEntryDistance?: boolean;
}) {
  const requireConfirmedEntryDistance =
    input.requireConfirmedEntryDistance !== false;
  const confirmationValid =
    Number.isFinite(input.confirmationLevel) &&
    input.confirmationLevel > 0;
  const invalidBoundaryValid =
    Number.isFinite(input.invalidBoundary) &&
    input.invalidBoundary > 0;
  const valid =
    [
      input.executionMarkPrice,
      input.atr5m,
      input.maxEntryDistanceAtr,
    ].every(Number.isFinite) &&
    input.executionMarkPrice > 0 &&
    input.atr5m > 0 &&
    input.maxEntryDistanceAtr >= 0 &&
    confirmationValid &&
    invalidBoundaryValid &&
    input.confirmationLevel > input.invalidBoundary;
  const entryDistanceAtr = valid
    ? (input.executionMarkPrice - input.confirmationLevel) / input.atr5m
    : Number.NaN;

  let code: NexusConfirmedEntryRevalidationCode = "ENTRY_REVALIDATED";
  if (!valid) code = "ENTRY_REVALIDATION_DATA_INVALID";
  else if (input.executionMarkPrice < input.invalidBoundary)
    code = "STRUCTURE_INVALIDATED";
  else if (
    requireConfirmedEntryDistance &&
    entryDistanceAtr < 0
  ) code = "BELOW_CONFIRMATION";
  else if (
    requireConfirmedEntryDistance &&
    entryDistanceAtr > input.maxEntryDistanceAtr
  ) code = "PRICE_TOO_FAR";

  return {
    eligible: code === "ENTRY_REVALIDATED",
    code,
    entryDistanceAtr,
  };
}

/**
 * Final execution-timing check for a confirmed short path.  Freezing the
 * analytical conclusion may survive a transient infrastructure wait, but it
 * must never freeze the old executable price.  A reclaimed broken support or
 * a market price already too far below that support is no longer the approved
 * entry moment.
 */
export function revalidateNexusConfirmedShortEntry(input: {
  executionMarkPrice: number;
  atr5m: number;
  brokenSupport: number;
  maxEntryDistanceAtr: number;
  requireConfirmedEntryDistance?: boolean;
}) {
  const requireConfirmedEntryDistance =
    input.requireConfirmedEntryDistance !== false;
  const valid = [
    input.executionMarkPrice,
    input.atr5m,
    input.brokenSupport,
    input.maxEntryDistanceAtr,
  ].every(Number.isFinite) &&
    input.executionMarkPrice > 0 &&
    input.atr5m > 0 &&
    input.brokenSupport > 0 &&
    input.maxEntryDistanceAtr >= 0;
  const entryDistanceAtr = valid
    ? (input.brokenSupport - input.executionMarkPrice) / input.atr5m
    : Number.NaN;

  let code: NexusConfirmedShortEntryRevalidationCode = "ENTRY_REVALIDATED";
  if (!valid) code = "ENTRY_REVALIDATION_DATA_INVALID";
  else if (
    requireConfirmedEntryDistance &&
    entryDistanceAtr < 0
  ) code = "BROKEN_SUPPORT_RECLAIMED";
  else if (
    requireConfirmedEntryDistance &&
    entryDistanceAtr > input.maxEntryDistanceAtr
  ) code = "PRICE_TOO_FAR";

  return {
    eligible: code === "ENTRY_REVALIDATED",
    code,
    entryDistanceAtr,
  };
}

/**
 * Historical replay helper retained for old samples only.
 * New production orders must use revalidateNexusConfirmedLongEntry.
 */
export function revalidateLiquidationLongEntry(input: {
  executionMarkPrice: number;
  high24h: number;
  low24h: number;
  high72h: number;
  low72h: number;
  maxPosition72hPercent: number;
  atr5m: number;
  confirmationLevel: number;
  invalidBoundary: number;
  maxEntryDistanceAtr: number;
  requireConfirmedEntryDistance?: boolean;
}) {
  const requireConfirmedEntryDistance =
    input.requireConfirmedEntryDistance !== false;
  const range72h = input.high72h - input.low72h;
  const baseValid =
    [
      input.executionMarkPrice,
      input.high72h,
      input.low72h,
      input.maxPosition72hPercent,
      input.atr5m,
      input.maxEntryDistanceAtr,
    ].every(Number.isFinite) &&
    input.executionMarkPrice > 0 &&
    input.high72h > 0 &&
    input.low72h > 0 &&
    range72h > 0 &&
    input.maxPosition72hPercent > 0 &&
    input.atr5m > 0 &&
    input.maxEntryDistanceAtr >= 0;
  const confirmationValid =
    Number.isFinite(input.confirmationLevel) &&
    input.confirmationLevel > 0;
  const invalidBoundaryValid =
    Number.isFinite(input.invalidBoundary) &&
    input.invalidBoundary > 0;
  const valid =
    baseValid &&
    (!requireConfirmedEntryDistance || confirmationValid) &&
    (!requireConfirmedEntryDistance || invalidBoundaryValid);
  const range24h = input.high24h - input.low24h;
  const position24hPercent = Number.isFinite(range24h) && range24h > 0
    ? clampPercent(((input.executionMarkPrice - input.low24h) / range24h) * 100)
    : Number.NaN;
  const entryDistanceAtr = baseValid && confirmationValid
    ? (input.executionMarkPrice - input.confirmationLevel) / input.atr5m
    : Number.NaN;
  const position72hPercent = baseValid
    ? clampPercent(((input.executionMarkPrice - input.low72h) / range72h) * 100)
    : Number.NaN;

  let code: LiquidationEntryRevalidationCode = "ENTRY_REVALIDATED";
  if (!valid) code = "ENTRY_REVALIDATION_DATA_INVALID";
  else if (position72hPercent >= input.maxPosition72hPercent)
    code = "POSITION_72H_ABOVE_LIMIT";
  else if (
    invalidBoundaryValid &&
    input.executionMarkPrice < input.invalidBoundary
  )
    code = "STRUCTURE_INVALIDATED";
  else if (
    requireConfirmedEntryDistance &&
    entryDistanceAtr < 0
  ) code = "BELOW_CONFIRMATION";
  else if (
    requireConfirmedEntryDistance &&
    entryDistanceAtr > input.maxEntryDistanceAtr
  )
    code = "PRICE_TOO_FAR";

  return {
    eligible: code === "ENTRY_REVALIDATED",
    code,
    position24hPercent,
    position72hPercent,
    entryDistanceAtr,
  };
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}
