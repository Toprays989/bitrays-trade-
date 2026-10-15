function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function usableEntryStructureBaseline(value: unknown) {
  const baseline = record(value);
  return baseline.managementEligibility === true &&
    Number(baseline.priorSupport) > 0 &&
    Number(baseline.priorResistance) > 0 &&
    Number(baseline.atr5m) > 0;
}

/**
 * Legacy backfills predate the durable pending/completed marker. A baseline
 * captured more than one 5-minute candle after its signal is therefore treated
 * as reconstructed and receives one observation-only reassessment.
 */
export function entryStructureReassessmentRequired(value: unknown) {
  const evidence = record(value);
  const baseline = record(evidence.entryStructureBaseline);
  if (!usableEntryStructureBaseline(baseline)) return false;
  if (evidence.entryStructureReassessmentCompletedAt) return false;
  if (evidence.entryStructureReassessmentRequired === false) return false;
  if (evidence.entryStructureReassessmentRequired === true) return true;
  if (
    baseline.source !==
      "HISTORICAL_MARK_PRICE_5M_BACKFILL_AT_SIGNAL_TIME"
  ) return false;
  const capturedAtMs = Date.parse(String(baseline.capturedAt ?? ""));
  const eventTimeMs = Date.parse(String(baseline.eventTime ?? ""));
  return Number.isFinite(capturedAtMs) &&
    Number.isFinite(eventTimeMs) &&
    capturedAtMs - eventTimeMs > 5 * 60_000;
}
