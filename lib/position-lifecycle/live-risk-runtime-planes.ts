export const LIVE_RISK_RUNTIME_PLANE_VERSION =
  "live-risk-runtime-planes-v1" as const;

export const LIVE_RISK_RUNTIME_PLANES = {
  PROTECTION: {
    queryMode: null,
    responsibility: "TIME_CRITICAL_POSITION_PROTECTION",
    maySubmitReduction: true,
    maySubmitEntry: false,
    mayEmitEntryCandidate: false,
    mayMutateLearning: false,
  },
  POSITION_INTELLIGENCE: {
    queryMode: "intelligence",
    responsibility: "POSITION_CAUSAL_OBSERVATION_AND_ENTRY_CANDIDATE",
    maySubmitReduction: false,
    maySubmitEntry: false,
    mayEmitEntryCandidate: true,
    mayMutateLearning: false,
  },
  ORDER_RECONCILIATION: {
    queryMode: "order-reconcile",
    responsibility: "EXCHANGE_ORDER_TRUTH_RECONCILIATION",
    maySubmitReduction: false,
    maySubmitEntry: false,
    mayEmitEntryCandidate: false,
    mayMutateLearning: false,
  },
  ACCOUNT_AUDIT: {
    queryMode: "account-audit",
    responsibility: "ACCOUNT_POSITION_SETTLEMENT_AND_LEARNING_HANDOFF",
    maySubmitReduction: false,
    maySubmitEntry: false,
    mayEmitEntryCandidate: false,
    mayMutateLearning: true,
  },
  STRATEGY_LEARNING: {
    queryMode: "strategy-learning",
    responsibility: "TERMINAL_RESULT_ABSORPTION",
    maySubmitReduction: false,
    maySubmitEntry: false,
    mayEmitEntryCandidate: false,
    mayMutateLearning: true,
  },
} as const;

export type LiveRiskRuntimePlane = keyof typeof LIVE_RISK_RUNTIME_PLANES;

export function resolveLiveRiskRuntimePlane(
  queryMode: string | null,
): LiveRiskRuntimePlane {
  if (queryMode === "intelligence") return "POSITION_INTELLIGENCE";
  if (queryMode === "order-reconcile") return "ORDER_RECONCILIATION";
  if (queryMode === "account-audit") return "ACCOUNT_AUDIT";
  if (queryMode === "strategy-learning") return "STRATEGY_LEARNING";
  return "PROTECTION";
}

export async function dispatchAuxiliaryLiveRiskPlane<
  TPositionIntelligence,
  TOrderReconciliation,
  TAccountAudit,
  TStrategyLearning,
>(input: {
  queryMode: string | null;
  runPositionIntelligence: () => Promise<TPositionIntelligence>;
  runOrderReconciliation: () => Promise<TOrderReconciliation>;
  runAccountAudit: () => Promise<TAccountAudit>;
  runStrategyLearning: () => Promise<TStrategyLearning>;
}) {
  const plane = resolveLiveRiskRuntimePlane(input.queryMode);
  if (plane === "POSITION_INTELLIGENCE")
    return {
      handled: true,
      plane,
      result: await input.runPositionIntelligence(),
    } as const;
  if (plane === "ORDER_RECONCILIATION")
    return {
      handled: true,
      plane,
      result: await input.runOrderReconciliation(),
    } as const;
  if (plane === "ACCOUNT_AUDIT")
    return {
      handled: true,
      plane,
      result: await input.runAccountAudit(),
    } as const;
  if (plane === "STRATEGY_LEARNING")
    return {
      handled: true,
      plane,
      result: await input.runStrategyLearning(),
    } as const;
  return { handled: false, plane, result: null } as const;
}
