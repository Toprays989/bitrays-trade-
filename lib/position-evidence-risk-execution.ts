export type PositionEvidenceRiskExecution = {
  action: "REDUCE_PARTIAL" | "EXIT_FULL";
  reductionPercent: number;
  opportunityId: string | null;
};

/**
 * Chooses the reason that may own the next close intent. Existing pending
 * evidence orders remain immutable, while liquidation, configured stops,
 * take profit, trailing protection, time exits and account/pair exits always
 * keep priority over a newly observed evidence-risk action.
 */
export function selectPositionEvidenceRiskExecution(input: {
  pending?: PositionEvidenceRiskExecution | null;
  candidate?: PositionEvidenceRiskExecution | null;
  latchedClose: boolean;
  accountDrawdownExit: boolean;
  pairExit: boolean;
  timeExit: boolean;
  autonomyAction: "AUTONOMOUS_CLOSE" | "MONITOR";
  autonomyReason:
    | "LIQUIDATION_PROXIMITY"
    | "CONFIGURED_STOP"
    | "TAKE_PROFIT"
    | "TRAILING_PROTECTION"
    | "STRUCTURE_INVALIDATION"
    | "NO_ACTION";
}) {
  if (input.pending) return input.pending;
  if (
    input.latchedClose ||
    input.accountDrawdownExit ||
    input.pairExit ||
    input.timeExit ||
    !input.candidate
  ) return null;
  if (
    input.candidate.action === "REDUCE_PARTIAL" &&
    input.autonomyAction === "MONITOR"
  ) return input.candidate;
  if (
    input.candidate.action === "EXIT_FULL" &&
    input.autonomyAction === "AUTONOMOUS_CLOSE" &&
    input.autonomyReason === "STRUCTURE_INVALIDATION"
  ) return input.candidate;
  return null;
}
