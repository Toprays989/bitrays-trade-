export type StrategyEntryRearmState =
  | "ORDER_READY"
  | "ARMED"
  | "CANCELED";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function strategyPendingEntryRearmState(input: {
  canRearm: boolean;
  evidence: Record<string, unknown>;
}): StrategyEntryRearmState {
  if (!input.canRearm) return "CANCELED";
  const frozenDecision = record(input.evidence.frozenExecutionDecision);
  const frozenExecutionApproved =
    frozenDecision.approved === true &&
    frozenDecision.decisionFrozen === true &&
    frozenDecision.retryWithoutReanalysis === true;
  return input.evidence.pendingEntryOwner === "SHORT_ENTRY_WORKER" ||
      frozenExecutionApproved
    ? "ORDER_READY"
    : "ARMED";
}
