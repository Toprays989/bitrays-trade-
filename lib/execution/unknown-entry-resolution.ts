export const UNKNOWN_ENTRY_RESOLUTION_VERSION =
  "unknown-entry-resolution-v1" as const;

export function resolveUnknownEntryNoFill(input: {
  allowSecondOrder: boolean;
  attempt: number;
  nowMs: number;
  analysisExpiresAtMs: number;
  pendingEntryOwner?: unknown;
}) {
  const attempt = Math.max(1, Math.min(2, Math.trunc(input.attempt) || 1));
  const canReanalyze =
    input.allowSecondOrder &&
    attempt < 2 &&
    input.nowMs < input.analysisExpiresAtMs;
  return {
    attempt,
    canReanalyze,
    nextAttempt: canReanalyze ? attempt + 1 : attempt,
    traceState: canReanalyze
      ? input.pendingEntryOwner === "SHORT_ENTRY_WORKER"
        ? "ORDER_READY" as const
        : "ARMED" as const
      : "CANCELED" as const,
    resultCode: canReanalyze
      ? "EXECUTION_UNKNOWN_CONFIRMED_NO_FILL_REANALYZE"
      : "EXECUTION_UNKNOWN_CONFIRMED_NO_FILL",
  };
}
