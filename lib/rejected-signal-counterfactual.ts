type CounterfactualEvidence = Record<string, unknown>;

export const REJECTED_SIGNAL_COUNTERFACTUAL_CHECKPOINT_MINUTES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 30, 60,
] as const;

export type RejectedSignalCounterfactualAnchor = {
  anchorAtMs: number;
  entryPrice: number;
  priceSource:
    | "DECISION_MARK_PRICE"
    | "UNFILLED_LIMIT_DECISION_MARK_PRICE"
    | "SIGNAL_MARK_PRICE"
    | "LIQUIDATION_PRICE";
};

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function rejectedSignalCounterfactualAnchor(input: {
  eventTimeMs: number;
  updatedAtMs?: number | null;
  completedAtMs?: number | null;
  liquidationPrice: number;
  entryEvidence: CounterfactualEvidence;
}): RejectedSignalCounterfactualAnchor | null {
  const unfilledLimit =
    input.entryEvidence.unfilledLimitCounterfactual &&
      typeof input.entryEvidence.unfilledLimitCounterfactual === "object" &&
      !Array.isArray(input.entryEvidence.unfilledLimitCounterfactual)
      ? input.entryEvidence.unfilledLimitCounterfactual as Record<string, unknown>
      : {};
  const unfilledDecisionAt = positiveNumber(unfilledLimit.decisionAtMs);
  const unfilledDecisionPrice = positiveNumber(
    unfilledLimit.decisionMarkPrice,
  );
  if (unfilledDecisionAt && unfilledDecisionPrice)
    return {
      anchorAtMs: unfilledDecisionAt,
      entryPrice: unfilledDecisionPrice,
      priceSource: "UNFILLED_LIMIT_DECISION_MARK_PRICE",
    };
  const decisionPrice = positiveNumber(input.entryEvidence.markPrice);
  const signalPrice = positiveNumber(input.entryEvidence.signalMarkPrice);
  const liquidationPrice = positiveNumber(input.liquidationPrice);
  const entryPrice = decisionPrice ?? signalPrice ?? liquidationPrice;
  if (!entryPrice || !Number.isFinite(input.eventTimeMs)) return null;

  // A delayed rejection can only be evaluated from the moment the strategy
  // actually had enough evidence to decide. Using the original liquidation
  // signal would credit the strategy with a move that happened while it was
  // still waiting for closed-candle confirmation and was not allowed to enter.
  const decisionAt = decisionPrice
    ? positiveNumber(input.completedAtMs) ?? positiveNumber(input.updatedAtMs)
    : null;
  return {
    anchorAtMs: decisionAt ?? input.eventTimeMs,
    entryPrice,
    priceSource: decisionPrice
      ? "DECISION_MARK_PRICE"
      : signalPrice
        ? "SIGNAL_MARK_PRICE"
        : "LIQUIDATION_PRICE",
  };
}

export function counterfactualMinuteOffset(nowMs: number, anchorAtMs: number) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(anchorAtMs)) return null;
  const offset = Math.floor((nowMs - anchorAtMs) / 60_000);
  return REJECTED_SIGNAL_COUNTERFACTUAL_CHECKPOINT_MINUTES.includes(
    offset as (typeof REJECTED_SIGNAL_COUNTERFACTUAL_CHECKPOINT_MINUTES)[number],
  )
    ? offset
    : null;
}

export function rejectedSignalCounterfactualDirection(
  entryEvidence: CounterfactualEvidence,
): "LONG" | "SHORT" {
  const explicit = [
    entryEvidence.tradeDirection,
    entryEvidence.positionSide,
  ].find((value) => value === "LONG" || value === "SHORT");
  return explicit === "SHORT" ? "SHORT" : "LONG";
}

export function isDecisionAnchoredCounterfactualEvidence(value: string) {
  try {
    const evidence = JSON.parse(value) as Record<string, unknown>;
    return evidence.counterfactualVersion === 2;
  } catch {
    return false;
  }
}

export function isMarkPriceKlineBackfillEvidence(value: string) {
  try {
    const evidence = JSON.parse(value) as Record<string, unknown>;
    return evidence.counterfactualVersion === 2 &&
      evidence.source === "CENTRAL_PROXY_MARK_PRICE_KLINE_BACKFILL";
  } catch {
    return false;
  }
}
