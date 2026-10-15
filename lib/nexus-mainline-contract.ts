export const NEXUS_MAINLINE_CONTRACT_VERSION =
  "nexus-mainline-contract-v1" as const;

export const NEXUS_MAINLINE_STAGE_ORDER = [
  "MARKET_FACTS",
  "TRIGGER_WAKE",
  "BRAIN_DECISION",
  "ENTRY_AUTHORIZATION",
  "EXECUTION_INTENT",
  "EXCHANGE_ORDER",
  "FILLED_POSITION",
  "POSITION_PROTECTION",
  "REDUCTION_SETTLEMENT",
  "LEARNING_CYCLE",
  "REVIEWED_EXPERIENCE",
  "CONFIG_CANDIDATE",
] as const;

export type NexusMainlineStage =
  (typeof NEXUS_MAINLINE_STAGE_ORDER)[number];

/**
 * Cross-module ownership contract. It describes authority only; it does not
 * contain strategy thresholds and cannot change a trading decision.
 */
export const NEXUS_MAINLINE_BOUNDARIES = {
  MARKET_FACTS: {
    owner: "NEXUS_EYE",
    authority: "MARKET_FACTS_ONLY",
    scope: "FULL_MARKET_SHARED_DATA",
    canAuthorizeOrder: false,
  },
  TRIGGER_WAKE: {
    owner: "STRATEGY_TRIGGER",
    authority: "WAKE_CANDIDATE_ONLY",
    canAuthorizeOrder: false,
  },
  BRAIN_DECISION: {
    owner: "NEXUS_MARKET_BRAIN",
    authority: "FINAL_ENTRY_DECISION",
    consumesStrategyContext: true,
  },
  ENTRY_AUTHORIZATION: {
    owner: "NEXUS_ENTRY_AUTHORIZATION",
    authority: "FROZEN_DECISION_ONLY",
  },
  EXECUTION_INTENT: {
    owner: "NEXUS_EXECUTION_COORDINATOR",
    authority: "SINGLE_ORDER_EXECUTION_OWNER",
  },
  EXCHANGE_ORDER: {
    owner: "BINANCE_ORDER_ADAPTER",
    authority: "EXCHANGE_TRUTH_RECONCILIATION",
  },
  FILLED_POSITION: {
    owner: "UNIFIED_POSITION_LIFECYCLE",
    authority: "POST_FILL_HANDOFF",
  },
  POSITION_PROTECTION: {
    owner: "UNIFIED_POSITION_LIFECYCLE",
    authority: "UNIFIED_POST_FILL_POSITION_MANAGEMENT",
    sourcePolicy: "BOUND_RISK_PLAN_AND_LIVE_POSITION_FACTS",
  },
  REDUCTION_SETTLEMENT: {
    owner: "UNIFIED_SETTLEMENT",
    authority: "EXCHANGE_FILL_FEE_AND_FUNDING_TRUTH",
  },
  LEARNING_CYCLE: {
    owner: "NEXUS_LEARNING",
    authority: "TERMINAL_FACT_ABSORPTION",
    orderAffecting: false,
  },
  REVIEWED_EXPERIENCE: {
    owner: "NEXUS_LEARNING_REVIEW",
    authority: "HUMAN_CERTIFIED_EXPERIENCE",
    automaticConfigMutationAllowed: false,
  },
  CONFIG_CANDIDATE: {
    owner: "NEXUS_CONFIG_VALIDATION",
    authority: "ISOLATED_CANDIDATE_VALIDATION",
    automaticPromotionAllowed: false,
  },
} as const satisfies Record<NexusMainlineStage, object>;

export const NEXUS_MAINLINE_HANDOFFS = {
  TRIGGER_TO_BRAIN: {
    event: "TRIGGER_WAKE_CREATED",
    from: "STRATEGY_TRIGGER",
    to: "NEXUS_MARKET_BRAIN",
  },
  ENTRY_TO_POSITION: {
    event: "POSITION_FILLED",
    from: "STRATEGY_ENTRY",
    to: "UNIFIED_POSITION_LIFECYCLE",
  },
  POSITION_TO_LEARNING: {
    event: "POSITION_TERMINAL_SETTLED",
    from: "UNIFIED_POSITION_LIFECYCLE",
    to: "NEXUS_LEARNING",
  },
} as const;

export const NEXUS_MAINLINE_IDENTITY_ORDER = [
  "cycleId",
  "factSnapshotId",
  "decisionId",
  "executionIntentId",
  "clientOrderId",
  "exchangeOrderId",
  "positionId",
  "settlementId",
  "learningSampleId",
  "suggestionId",
  "configVersion",
] as const;

export type NexusMainlineIdentityName =
  (typeof NEXUS_MAINLINE_IDENTITY_ORDER)[number];

export type NexusMainlineIdentityChain = Readonly<{
  cycleId: string;
  factSnapshotId: string | null;
  decisionId: string | null;
  executionIntentId: string | null;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  positionId: string | null;
  settlementId: string | null;
  learningSampleId: string | null;
  suggestionId: string | null;
  configVersion: number;
}>;

export type NexusEntryDecisionIdentityChain = Pick<
  NexusMainlineIdentityChain,
  | "cycleId"
  | "factSnapshotId"
  | "decisionId"
  | "executionIntentId"
  | "configVersion"
>;

export type NexusLearningIdentityChain = Pick<
  NexusMainlineIdentityChain,
  | "cycleId"
  | "factSnapshotId"
  | "decisionId"
  | "executionIntentId"
  | "positionId"
  | "settlementId"
  | "learningSampleId"
  | "configVersion"
>;
