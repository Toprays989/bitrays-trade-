export const POST_ENTRY_STRUCTURE_CONTEXT_VERSION =
  "post-entry-structure-context-v2" as const;

export type PostEntryStructureContext = Readonly<{
  version: typeof POST_ENTRY_STRUCTURE_CONTEXT_VERSION;
  positionSide: "LONG" | "SHORT";
  source:
    | "ORIGINAL_LONG_STRUCTURE"
    | "ORIGINAL_SHORT_BREAKOUT"
    | "BASELINE_LONG_STRUCTURE"
    | "BASELINE_SHORT_RESISTANCE"
    | "BOUND_ENTRY_INVALIDATION"
    | "UNAVAILABLE";
  thesisStructuralLevel: number | null;
  thesisAtr5m: number | null;
  thesisInvalidBoundary: number | null;
  continuationBoundary: number | null;
  favorableWaveBoundary: number | null;
  invalidationWaveBoundary: number | null;
  managementEligible: boolean;
  reconstructedStructureUsed: boolean;
  restrictsRiskIncrease: boolean;
  rejectedShortBreakoutReason: string | null;
}>;

/**
 * Resolve the frozen entry structure used by post-fill management.
 *
 * A numeric `brokenSupport` is not proof that a short position entered below
 * that level. Legacy and observation-only traces can contain a measured level
 * even when the break/retest flags were false. Using such a level blindly
 * makes the position appear structurally invalid from the fill itself. The
 * resolver therefore verifies the entry price against the same ATR-buffered
 * boundary used by thesis invalidation, then falls back to the immutable
 * signal-time baseline. Reconstructed baselines may reduce/exit risk but can
 * never authorize an add-on.
 */
export function resolvePostEntryStructureContext(input: {
  positionSide: "LONG" | "SHORT";
  entryPrice: number;
  directLongStructureComplete: boolean;
  entrySupport: number | null;
  entryPriorHigh: number | null;
  entryAtr5m: number | null;
  shortBrokenSupport: number | null;
  shortAtr5m: number | null;
  boundInvalidBoundary?: number | null;
  baselineManagementEligible: boolean;
  boundaryBufferAtr?: number;
}): PostEntryStructureContext {
  const entryPrice = positive(input.entryPrice);
  const support = positive(input.entrySupport);
  const resistance = positive(input.entryPriorHigh);
  const entryAtr = positive(input.entryAtr5m);
  const brokenSupport = positive(input.shortBrokenSupport);
  const shortAtr = positive(input.shortAtr5m);
  const boundInvalidBoundary = validBoundInvalidBoundary({
    positionSide: input.positionSide,
    entryPrice,
    invalidBoundary: input.boundInvalidBoundary,
  });
  const bufferAtr = Math.max(0.05, finite(input.boundaryBufferAtr) ?? 0.1);

  if (input.positionSide === "LONG") {
    const valid = entryPrice !== null && support !== null && entryAtr !== null &&
      entryPrice >= support - entryAtr * bufferAtr;
    if (!valid)
      return boundInvalidBoundary !== null
        ? boundEntryInvalidationContext("LONG", boundInvalidBoundary)
        : unavailable("LONG");
    const reconstructed = !input.directLongStructureComplete;
    if (reconstructed && !input.baselineManagementEligible)
      return boundInvalidBoundary !== null
        ? boundEntryInvalidationContext("LONG", boundInvalidBoundary)
        : unavailable("LONG");
    return Object.freeze({
      version: POST_ENTRY_STRUCTURE_CONTEXT_VERSION,
      positionSide: "LONG",
      source: reconstructed
        ? "BASELINE_LONG_STRUCTURE"
        : "ORIGINAL_LONG_STRUCTURE",
      thesisStructuralLevel: support,
      thesisAtr5m: entryAtr,
      thesisInvalidBoundary: boundInvalidBoundary,
      continuationBoundary: resistance,
      favorableWaveBoundary: support,
      invalidationWaveBoundary: resistance,
      managementEligible: true,
      reconstructedStructureUsed: reconstructed,
      restrictsRiskIncrease: reconstructed,
      rejectedShortBreakoutReason: null,
    });
  }

  const shortBreakoutValid =
    entryPrice !== null &&
    brokenSupport !== null &&
    shortAtr !== null &&
    entryPrice <= brokenSupport + shortAtr * bufferAtr;
  if (shortBreakoutValid)
    return Object.freeze({
      version: POST_ENTRY_STRUCTURE_CONTEXT_VERSION,
      positionSide: "SHORT",
      source: "ORIGINAL_SHORT_BREAKOUT",
      thesisStructuralLevel: brokenSupport,
      thesisAtr5m: shortAtr,
      thesisInvalidBoundary: boundInvalidBoundary,
      continuationBoundary: brokenSupport,
      favorableWaveBoundary: brokenSupport,
      invalidationWaveBoundary: resistance,
      managementEligible: true,
      reconstructedStructureUsed: false,
      restrictsRiskIncrease: false,
      rejectedShortBreakoutReason: null,
    });

  const baselineValid =
    input.baselineManagementEligible &&
    entryPrice !== null &&
    resistance !== null &&
    entryAtr !== null &&
    entryPrice <= resistance + entryAtr * bufferAtr;
  if (!baselineValid) {
    if (boundInvalidBoundary !== null)
      return boundEntryInvalidationContext("SHORT", boundInvalidBoundary);
    return {
      ...unavailable("SHORT"),
      rejectedShortBreakoutReason: brokenSupport === null || shortAtr === null
        ? "SHORT_BREAKOUT_ANCHOR_INCOMPLETE"
        : "SHORT_ENTRY_ALREADY_BEYOND_BREAKOUT_INVALIDATION",
    };
  }

  return Object.freeze({
    version: POST_ENTRY_STRUCTURE_CONTEXT_VERSION,
    positionSide: "SHORT",
    source: "BASELINE_SHORT_RESISTANCE",
    thesisStructuralLevel: resistance,
    thesisAtr5m: entryAtr,
    thesisInvalidBoundary: boundInvalidBoundary,
    continuationBoundary: support,
    favorableWaveBoundary: support,
    invalidationWaveBoundary: resistance,
    managementEligible: true,
    reconstructedStructureUsed: true,
    restrictsRiskIncrease: true,
    rejectedShortBreakoutReason: brokenSupport === null || shortAtr === null
      ? "SHORT_BREAKOUT_ANCHOR_INCOMPLETE"
      : "SHORT_ENTRY_ALREADY_BEYOND_BREAKOUT_INVALIDATION",
  });
}

function boundEntryInvalidationContext(
  positionSide: "LONG" | "SHORT",
  invalidBoundary: number,
): PostEntryStructureContext {
  return Object.freeze({
    version: POST_ENTRY_STRUCTURE_CONTEXT_VERSION,
    positionSide,
    source: "BOUND_ENTRY_INVALIDATION",
    thesisStructuralLevel: null,
    thesisAtr5m: null,
    thesisInvalidBoundary: invalidBoundary,
    continuationBoundary: null,
    favorableWaveBoundary: null,
    invalidationWaveBoundary: null,
    managementEligible: true,
    reconstructedStructureUsed: false,
    restrictsRiskIncrease: true,
    rejectedShortBreakoutReason: null,
  });
}

function unavailable(
  positionSide: "LONG" | "SHORT",
): PostEntryStructureContext {
  return Object.freeze({
    version: POST_ENTRY_STRUCTURE_CONTEXT_VERSION,
    positionSide,
    source: "UNAVAILABLE",
    thesisStructuralLevel: null,
    thesisAtr5m: null,
    thesisInvalidBoundary: null,
    continuationBoundary: null,
    favorableWaveBoundary: null,
    invalidationWaveBoundary: null,
    managementEligible: false,
    reconstructedStructureUsed: false,
    restrictsRiskIncrease: true,
    rejectedShortBreakoutReason: null,
  });
}

function validBoundInvalidBoundary(input: {
  positionSide: "LONG" | "SHORT";
  entryPrice: number | null;
  invalidBoundary: unknown;
}) {
  const invalidBoundary = positive(input.invalidBoundary);
  if (input.entryPrice === null || invalidBoundary === null) return null;
  return input.positionSide === "LONG"
    ? invalidBoundary < input.entryPrice
      ? invalidBoundary
      : null
    : invalidBoundary > input.entryPrice
      ? invalidBoundary
      : null;
}

function positive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function finite(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
