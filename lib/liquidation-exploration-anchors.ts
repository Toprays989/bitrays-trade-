export type ExplorationLongAnchorSource =
  | "CONFIRMED_STRUCTURE"
  | "CONFIRMED_TREND_BREAKOUT_ATR_BOUNDARY"
  | "CONFIRMED_SUPPORT_REVERSAL_BOUNDARY"
  | "FROZEN_DECISION_ATR_BOUNDARY"
  | "EXPLORATION_ATR_BOUNDARY";

export function resolveExplorationLongAnchors(input: {
  explorationAllowed: boolean;
  executionMarkPrice: number;
  liquidationPrice?: number | null;
  atr5m: number;
  atrStopBuffer: number;
  priceTickSize: number;
  confirmationLevel?: number | null;
  invalidBoundary?: number | null;
  confirmedPath?: string | null;
  confirmedEvidenceFactIds?: string[] | null;
  marketFacts?: unknown[] | null;
  frozenDecisionApproved?: boolean;
  approvedMarkPrice?: number | null;
}) {
  const existingConfirmation = finitePositive(input.confirmationLevel);
  const existingInvalidBoundary = finitePositive(input.invalidBoundary);
  if (
    existingConfirmation !== null &&
    existingInvalidBoundary !== null &&
    existingConfirmation > existingInvalidBoundary
  )
    return {
      confirmationLevel: existingConfirmation,
      invalidBoundary: existingInvalidBoundary,
      source: "CONFIRMED_STRUCTURE" as const,
      derived: false,
    };
  const confirmedStateMachineAnchors =
    resolveConfirmedStateMachineLongAnchors(input);
  if (confirmedStateMachineAnchors) return confirmedStateMachineAnchors;
  if (input.frozenDecisionApproved) {
    const approvedMarkPrice = finitePositive(input.approvedMarkPrice);
    const atr5m = finitePositive(input.atr5m);
    const priceTickSize = finitePositive(input.priceTickSize);
    const atrStopBuffer = finitePositive(input.atrStopBuffer);
    if (
      approvedMarkPrice !== null &&
      atr5m !== null &&
      priceTickSize !== null &&
      atrStopBuffer !== null
    ) {
      // State-machine facts are rolling-window data. Their identifiers can
      // legitimately leave the next market snapshot after the brain has
      // already frozen an approved decision. Preserve that approved price as
      // the confirmation anchor and derive only the execution safety boundary;
      // do not make the strategy perform a second directional judgment.
      const confirmationLevel = alignPriceUp(
        approvedMarkPrice,
        priceTickSize,
      );
      const invalidBoundary = alignPriceDown(
        confirmationLevel - atr5m * atrStopBuffer,
        priceTickSize,
      );
      if (
        confirmationLevel > 0 &&
        invalidBoundary > 0 &&
        invalidBoundary < confirmationLevel
      )
        return {
          confirmationLevel,
          invalidBoundary,
          source: "FROZEN_DECISION_ATR_BOUNDARY" as const,
          derived: true,
        };
    }
  }
  if (!input.explorationAllowed) return null;

  const markPrice = finitePositive(input.executionMarkPrice);
  const liquidationPrice = finitePositive(input.liquidationPrice);
  const atr5m = finitePositive(input.atr5m);
  const priceTickSize = finitePositive(input.priceTickSize);
  const atrStopBuffer = finitePositive(input.atrStopBuffer);
  if (
    markPrice === null ||
    atr5m === null ||
    priceTickSize === null ||
    atrStopBuffer === null
  ) return null;

  // An exploration probe deliberately has no confirmed reclaim structure yet.
  // Use the lower of the fresh mark and liquidation print as its observation
  // anchor, then place the invalidation boundary one configured ATR buffer
  // below it. This is a risk boundary, not fabricated confirmation evidence.
  const rawConfirmation = Math.min(markPrice, liquidationPrice ?? markPrice);
  const confirmationTicks = Math.floor(
    (rawConfirmation + priceTickSize * 1e-8) / priceTickSize,
  );
  const confirmationLevel = Number(
    (confirmationTicks * priceTickSize).toPrecision(15),
  );
  const rawInvalidBoundary =
    confirmationLevel - atr5m * atrStopBuffer;
  const invalidTicks = Math.floor(
    (rawInvalidBoundary + priceTickSize * 1e-8) / priceTickSize,
  );
  const invalidBoundary = Number(
    (invalidTicks * priceTickSize).toPrecision(15),
  );
  if (
    confirmationLevel <= 0 ||
    invalidBoundary <= 0 ||
    invalidBoundary >= confirmationLevel
  ) return null;
  return {
    confirmationLevel,
    invalidBoundary,
    source: "EXPLORATION_ATR_BOUNDARY" as const,
    derived: true,
  };
}

function resolveConfirmedStateMachineLongAnchors(input: {
  atr5m: number;
  atrStopBuffer: number;
  priceTickSize: number;
  confirmedPath?: string | null;
  confirmedEvidenceFactIds?: string[] | null;
  marketFacts?: unknown[] | null;
}) {
  const confirmedPath = String(input.confirmedPath ?? "");
  if (
    confirmedPath !== "TREND_BREAKOUT" &&
    confirmedPath !== "SUPPORT_REVERSAL"
  )
    return null;
  const atr5m = finitePositive(input.atr5m);
  const atrStopBuffer = finitePositive(input.atrStopBuffer);
  const priceTickSize = finitePositive(input.priceTickSize);
  if (
    atr5m === null ||
    atrStopBuffer === null ||
    priceTickSize === null
  )
    return null;
  const evidenceIds = new Set(
    Array.isArray(input.confirmedEvidenceFactIds)
      ? input.confirmedEvidenceFactIds.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  if (!evidenceIds.size || !Array.isArray(input.marketFacts)) return null;
  const facts = input.marketFacts
    .map(asMarketFact)
    .filter(
      (fact): fact is MarketFact =>
        fact !== null && evidenceIds.has(fact.id),
    )
    .sort((left, right) => left.eventAt - right.eventAt);

  if (confirmedPath === "TREND_BREAKOUT") {
    const breakout = facts
      .filter((fact) => fact.kind === "PRICE_NEW_HIGH")
      .at(-1);
    const rawConfirmation = finitePositive(
      breakout?.payload.priorHigh ?? breakout?.payload.price,
    );
    if (rawConfirmation === null) return null;
    const confirmationLevel = alignPriceUp(
      rawConfirmation,
      priceTickSize,
    );
    const invalidBoundary = alignPriceDown(
      confirmationLevel - atr5m * atrStopBuffer,
      priceTickSize,
    );
    if (
      invalidBoundary <= 0 ||
      invalidBoundary >= confirmationLevel
    )
      return null;
    return {
      confirmationLevel,
      invalidBoundary,
      source: "CONFIRMED_TREND_BREAKOUT_ATR_BOUNDARY" as const,
      derived: true,
    };
  }

  const reclaim = facts
    .filter((fact) => fact.kind === "SUPPORT_RECLAIMED")
    .at(-1);
  const sweep = facts
    .filter((fact) => fact.kind === "SUPPORT_SWEPT")
    .at(-1);
  const rawConfirmation = finitePositive(
    reclaim?.payload.reclaimClose ??
      reclaim?.payload.price ??
      reclaim?.payload.priorLow,
  );
  const sweptLow = finitePositive(
    sweep?.payload.sweepLow ?? sweep?.payload.priorLow,
  );
  if (rawConfirmation === null || sweptLow === null) return null;
  const confirmationLevel = alignPriceUp(
    rawConfirmation,
    priceTickSize,
  );
  const invalidBoundary = alignPriceDown(
    Math.min(
      sweptLow,
      confirmationLevel - atr5m * atrStopBuffer,
    ),
    priceTickSize,
  );
  if (
    invalidBoundary <= 0 ||
    invalidBoundary >= confirmationLevel
  )
    return null;
  return {
    confirmationLevel,
    invalidBoundary,
    source: "CONFIRMED_SUPPORT_REVERSAL_BOUNDARY" as const,
    derived: true,
  };
}

type MarketFact = {
  id: string;
  kind: string;
  eventAt: number;
  payload: Record<string, unknown>;
};

function asMarketFact(value: unknown): MarketFact | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.kind !== "string" ||
    !Number.isFinite(Number(record.eventAt)) ||
    !record.payload ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  )
    return null;
  return {
    id: record.id,
    kind: record.kind,
    eventAt: Number(record.eventAt),
    payload: record.payload as Record<string, unknown>,
  };
}

function alignPriceUp(value: number, tickSize: number) {
  const ticks = Math.ceil(
    (value - tickSize * 1e-8) / tickSize,
  );
  return Number((ticks * tickSize).toPrecision(15));
}

function alignPriceDown(value: number, tickSize: number) {
  const ticks = Math.floor(
    (value + tickSize * 1e-8) / tickSize,
  );
  return Number((ticks * tickSize).toPrecision(15));
}

function finitePositive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
