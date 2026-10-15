export type EntryObservationBaseline = {
  version: 1;
  captureMode: "POST_FILL_BASELINE";
  orderEligibilityImpact: "NONE";
  positionOpenedAt: string;
  captureStartedAt: string;
  captureCompletedAt: string;
  delayFromFillMs: number;
  acquisitionLatencyMs: number;
  marketRegime: Record<string, unknown>;
  largeTraderPositioning: Record<string, unknown>;
  completeness: "COMPLETE" | "PARTIAL";
  missingDimensions: string[];
};

export function buildPostFillObservationBaseline(input: {
  positionOpenedAtMs: number;
  captureStartedAtMs: number;
  captureCompletedAtMs: number;
  marketRegime: Record<string, unknown>;
  largeTraderPositioning: Record<string, unknown>;
}): EntryObservationBaseline {
  const marketStatus = String(input.marketRegime.status ?? "");
  const largeTraderStatus = String(input.largeTraderPositioning.status ?? "");
  const missingDimensions = [
    ...(
      ["FAVORABLE", "NEUTRAL", "ADVERSE"].includes(marketStatus)
        ? []
        : ["marketRegime"]
    ),
    ...(
      ["SUPPORTS_LONG", "CONFLICTS_LONG", "NEUTRAL"].includes(
          largeTraderStatus,
        )
        ? []
        : ["largeTraderPositioning"]
    ),
  ];
  return {
    version: 1,
    captureMode: "POST_FILL_BASELINE",
    orderEligibilityImpact: "NONE",
    positionOpenedAt: new Date(input.positionOpenedAtMs).toISOString(),
    captureStartedAt: new Date(input.captureStartedAtMs).toISOString(),
    captureCompletedAt: new Date(input.captureCompletedAtMs).toISOString(),
    delayFromFillMs: Math.max(
      0,
      input.captureStartedAtMs - input.positionOpenedAtMs,
    ),
    acquisitionLatencyMs: Math.max(
      0,
      input.captureCompletedAtMs - input.captureStartedAtMs,
    ),
    marketRegime: input.marketRegime,
    largeTraderPositioning: input.largeTraderPositioning,
    completeness: missingDimensions.length ? "PARTIAL" : "COMPLETE",
    missingDimensions,
  };
}

export function entryLargeTraderPositioning(
  entryEvidence: Record<string, unknown>,
): Record<string, unknown> {
  const direct = record(entryEvidence.largeTraderPositioning);
  if (Object.keys(direct).length) return direct;
  const baseline = record(entryEvidence.entryObservationBaseline);
  return record(baseline.largeTraderPositioning);
}

export function entryMarketRegime(
  entryEvidence: Record<string, unknown>,
): Record<string, unknown> {
  const baseline = record(entryEvidence.entryObservationBaseline);
  return record(baseline.marketRegime);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
