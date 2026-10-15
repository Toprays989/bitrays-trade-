export const NEXUS_PROBABILITY_CONTEXT_VERSION =
  "nexus-probability-context-v1" as const;

/**
 * Probability learning needs the same low-cardinality identity at entry and
 * settlement. Keeping it separate from the richer retrospective market label
 * prevents exact-net samples from silently falling back to direction-only.
 */
export function nexusProbabilityContextFromEvidence(
  evidence: Record<string, unknown>,
) {
  const marketEye = record(evidence.nexusMarketEyeDecision);
  const ownMacro = record(evidence.nexusOwnMultiHourContext);
  const ownEntry = record(evidence.nexusOwnEntryRegime5m);
  const volumeTiming = record(evidence.nexusVolumeTiming);
  return {
    version: NEXUS_PROBABILITY_CONTEXT_VERSION,
    decisionPath: normalizedToken(marketEye.selectedPath, "UNKNOWN"),
    marketContextKey: [
      normalizedToken(
        ownMacro.decisionRegime ?? ownMacro.regime,
        "UNKNOWN",
      ),
      normalizedToken(ownEntry.regime, "UNKNOWN"),
      normalizedToken(volumeTiming.state, "UNKNOWN"),
    ].join(":"),
  };
}

function normalizedToken(value: unknown, fallback: string) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
