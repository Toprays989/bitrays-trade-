export type StrategyLearningBacklogRow<T> = T & {
  learningEligibility: "ELIGIBLE" | "OBSERVATION_ONLY" | "INCOMPLETE" | null;
  learningUpdatedAt: Date | null;
  completedAt: Date | null;
  settlementRefreshPending?: boolean | number | null;
  learningSchemaRefreshPending?: boolean | number | null;
};

export const STRATEGY_LEARNING_SETTLEMENT_GRACE_MS = 30 * 60_000;
export const MANUAL_INTERVENTION_LEARNING_SUPERSESSION_VERSION =
  "manual-intervention-learning-supersession-v1" as const;

export function buildManualInterventionLearningSupersessionPatch(input: {
  blockedReasonsJson: string | null;
  detailJson: string | null;
  manualLearningKey: string;
  observedAt: Date;
}) {
  const detail = objectFromJson(input.detailJson);
  const feedback = objectRecord(detail.feedback);
  const memoryCase = objectRecord(detail.memoryCase);
  const blockedReasons = stringArrayFromJson(input.blockedReasonsJson)
    .filter((reason) =>
      reason !== "POSITION_CYCLE_OPEN" &&
      reason !== "EXACT_NET_SETTLEMENT_INCOMPLETE"
    );
  if (!blockedReasons.includes("MANUAL_INTERVENTION_SUPERSEDED_ACTUAL_PATH"))
    blockedReasons.push("MANUAL_INTERVENTION_SUPERSEDED_ACTUAL_PATH");
  return {
    manualIntervention: true,
    terminalStatus: "CLOSED" as const,
    exactNetAvailable: false,
    exactNetPnlUsdt: null,
    eligibility: "OBSERVATION_ONLY" as const,
    blockedReasonsJson: JSON.stringify(blockedReasons),
    detailJson: JSON.stringify({
      ...detail,
      learningLane: "OBSERVATION",
      parameterLearningAllowed: false,
      probeLearningAllowed: false,
      settlementRefreshPending: false,
      settlementRefreshResolvedAt: input.observedAt.toISOString(),
      manualInterventionSupersession: {
        version: MANUAL_INTERVENTION_LEARNING_SUPERSESSION_VERSION,
        status: "SUPERSEDED",
        manualLearningKey: input.manualLearningKey,
        observedAt: input.observedAt.toISOString(),
      },
      feedback: Object.keys(feedback).length
        ? {
            ...feedback,
            learningLane: "OBSERVATION",
            aggregateLearningEligible: false,
            orderAffecting: false,
            liveConfigMutationAllowed: false,
          }
        : detail.feedback,
      memoryCase: Object.keys(memoryCase).length
        ? {
            ...memoryCase,
            eligibility: "OBSERVATION_ONLY",
            orderAffecting: false,
            liveConfigMutationAllowed: false,
          }
        : detail.memoryCase,
    }),
    updatedAt: input.observedAt,
  };
}

export function buildNexusSettlementRefreshPatch(input: {
  detailJson: string | null;
  observedAt: Date;
}) {
  const detail = objectFromJson(input.detailJson);
  const memoryCase = objectRecord(detail.memoryCase);
  return {
    eligibility: "INCOMPLETE" as const,
    detailJson: JSON.stringify({
      ...detail,
      settlementRefreshPending: true,
      settlementRefreshRequestedAt: input.observedAt.toISOString(),
      memoryCase: Object.keys(memoryCase).length
        ? { ...memoryCase, eligibility: "INCOMPLETE" }
        : detail.memoryCase,
    }),
  };
}

export function prioritizeStrategyLearningBacklog<T>(
  rows: Array<StrategyLearningBacklogRow<T>>,
  now = new Date(),
) {
  return [...rows].sort((left, right) => {
    const leftPriority = learningBacklogPriority(left, now);
    const rightPriority = learningBacklogPriority(right, now);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftUpdatedAt = left.learningUpdatedAt?.getTime() ?? 0;
    const rightUpdatedAt = right.learningUpdatedAt?.getTime() ?? 0;
    if (
      hasSettlementRefreshPending(left) &&
      hasSettlementRefreshPending(right) &&
      leftUpdatedAt !== rightUpdatedAt
    ) return rightUpdatedAt - leftUpdatedAt;
    if (
      hasLearningSchemaRefreshPending(left) &&
      hasLearningSchemaRefreshPending(right) &&
      leftUpdatedAt !== rightUpdatedAt
    ) return rightUpdatedAt - leftUpdatedAt;
    if (leftUpdatedAt !== rightUpdatedAt)
      return leftUpdatedAt - rightUpdatedAt;
    return (left.completedAt?.getTime() ?? 0) -
      (right.completedAt?.getTime() ?? 0);
  });
}

function learningBacklogPriority<T>(
  row: StrategyLearningBacklogRow<T>,
  now: Date,
) {
  if (hasSettlementRefreshPending(row)) return -2;
  if (hasLearningSchemaRefreshPending(row)) return -1;
  if (
    row.learningEligibility === "INCOMPLETE" &&
    now.getTime() - (row.learningUpdatedAt?.getTime() ?? 0) >=
      STRATEGY_LEARNING_SETTLEMENT_GRACE_MS
  ) return 0;
  if (row.learningEligibility === null) return 1;
  return 2;
}

function hasSettlementRefreshPending<T>(
  row: StrategyLearningBacklogRow<T>,
) {
  return row.settlementRefreshPending === true ||
    row.settlementRefreshPending === 1;
}

function hasLearningSchemaRefreshPending<T>(
  row: StrategyLearningBacklogRow<T>,
) {
  return row.learningSchemaRefreshPending === true ||
    row.learningSchemaRefreshPending === 1;
}

function objectFromJson(value: string | null) {
  try {
    return objectRecord(JSON.parse(value ?? "{}"));
  } catch {
    return {};
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArrayFromJson(value: string | null) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
