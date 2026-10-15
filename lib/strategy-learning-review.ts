export const STRATEGY_LEARNING_EXPERIENCE_VERSION =
  "strategy-learning-experience-v1" as const;

export type StrategyLearningReviewDecision =
  | "CONFIRMED"
  | "NOISE"
  | "DEFERRED";

export type StrategyLearningPromotionStatus =
  | "PROVISIONAL"
  | "PROMOTED"
  | "IGNORED"
  | "DEFERRED";

export type StrategyLearningOutcome =
  | "WIN"
  | "LOSS"
  | "BREAKEVEN"
  | "UNAVAILABLE";

export type StrategyLearningCapabilitySnapshot = {
  promotedExperiences: number;
  exactNetExperiences: number;
  wins: number;
  losses: number;
  breakeven: number;
  exactNetPnlUsdt: number;
  exactNetWinRatePercent: number | null;
};

export type StrategyLearningReviewSummary = {
  readyForReview: number;
  feesPending: number;
  confirmed: number;
  provisional: number;
  noise: number;
  deferred: number;
  pendingSuggestions: number;
  capability: StrategyLearningCapabilitySnapshot;
};

export type StrategyLearningReviewItem = {
  learningKey: string;
  strategyId: number;
  brainKey: string;
  configVersion: number;
  traceId: string;
  symbol: string;
  direction: "LONG" | "SHORT" | "UNKNOWN";
  orderSource: string;
  terminalStatus: string;
  eligibility: string;
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  observedPnlUsdt: number | null;
  outcome: StrategyLearningOutcome;
  evidenceComplete: boolean;
  fastLearningStatus: string;
  timingAttribution: string;
  observedCheckpointMinutes: number[];
  requiredCheckpointMinutes: number[];
  missingCheckpointMinutes: number[];
  exitReasons: string[];
  holdingDurationMinutes: number | null;
  mfeRoePercent: number | null;
  maeRoePercent: number | null;
  summary: string;
  attribution: {
    triggerKind: string;
    triggerVersion: string;
    entryReasons: string[];
    marketContext: string[];
    learnedRule: string;
    evidenceSampleCount: number;
    evidenceConfidence:
      | "EXACT_COMPLETE"
      | "TERMINAL_PARTIAL"
      | "OBSERVATION_ONLY";
    parameterSuggestions: Array<{
      parameterName: string;
      status: string;
      sampleCount: number;
      confidence: number | null;
    }>;
    exitQuality: {
      sampleCount: number;
      latestExitReason: string;
      latestHorizonMinutes: number | null;
      latestPathOutcome: string;
      latestExecutionTiming: string;
      directionReturnPercent: number | null;
      postExitMfePercent: number | null;
      postExitMaePercent: number | null;
      materialMovePercent: number | null;
      postExitVolumeRatio: number | null;
      tailWaveReasonCode: string | null;
      historicalLabelOnly: true;
      summary: string;
    } | null;
  };
  reviewReady: boolean;
  updatedAt: string | number;
  review: {
    decision: StrategyLearningReviewDecision;
    promotionStatus: StrategyLearningPromotionStatus;
    memoryVersion: number | null;
    reviewComment: string | null;
    reviewedBy: string;
    reviewedAt: string | number;
    sampleUpdatedAt: string | number;
    needsSettlementRefresh: boolean;
  } | null;
};

export function buildStrategyLearningReviewAttribution(input: {
  detailJson: string;
  entryEvidenceJson: string | null;
  triggerKind: string | null;
  triggerVersion: string | null;
  observedCheckpointMinutes: number[];
  evidenceComplete: boolean;
  exactNetAvailable: boolean;
  eligibility: string;
  parameterSuggestions?: Array<{
    parameterName: string;
    status: string;
    sampleCount: number;
    evidenceJson: string;
  }>;
}) {
  const detail = recordFromJson(input.detailJson);
  const entryEvidence = recordFromJson(input.entryEvidenceJson);
  const triggerIdentity = record(entryEvidence.triggerIdentity);
  const retrospective = record(detail.retrospective);
  const memoryCase = record(detail.memoryCase);
  const feedback = record(detail.feedback);
  const fastLearning = record(detail.fastLearning);
  const exitCounterfactual = record(retrospective.exitCounterfactual);
  const exitCheckpoints = Array.isArray(exitCounterfactual.checkpoints)
    ? exitCounterfactual.checkpoints
        .map((item) => record(item))
        .filter((item) => Number.isFinite(Number(item.horizonMinutes)))
    : [];
  const latestExitCheckpoint = [...exitCheckpoints].sort(
    (left, right) =>
      (finiteOrNull(right.exitAtMs) ?? 0) -
        (finiteOrNull(left.exitAtMs) ?? 0) ||
      Number(right.horizonMinutes) - Number(left.horizonMinutes),
  )[0] ?? null;
  const latestExitReason = stringValue(
    exitCounterfactual.latestExitReason,
  ) ?? stringValue(latestExitCheckpoint?.exitReason) ?? "UNKNOWN";
  const latestPathOutcome = stringValue(
    exitCounterfactual.latestPathOutcome,
  ) ?? stringValue(latestExitCheckpoint?.pathOutcome) ??
    stringValue(latestExitCheckpoint?.classification) ?? "INCONCLUSIVE";
  const latestExecutionTiming = stringValue(
    exitCounterfactual.latestExecutionTiming,
  ) ?? stringValue(latestExitCheckpoint?.executionTiming) ?? "UNAVAILABLE";
  const exitQuality = latestExitCheckpoint
    ? {
        sampleCount: exitCheckpoints.length,
        latestExitReason,
        latestHorizonMinutes: finiteOrNull(
          latestExitCheckpoint.horizonMinutes,
        ),
        latestPathOutcome,
        latestExecutionTiming,
        directionReturnPercent: finiteOrNull(
          latestExitCheckpoint.directionReturnPercent,
        ),
        postExitMfePercent: finiteOrNull(
          latestExitCheckpoint.postExitMfePercent,
        ),
        postExitMaePercent: finiteOrNull(
          latestExitCheckpoint.postExitMaePercent,
        ),
        materialMovePercent: finiteOrNull(
          latestExitCheckpoint.materialMovePercent,
        ),
        postExitVolumeRatio: finiteOrNull(
          latestExitCheckpoint.postExitVolumeRatio,
        ),
        tailWaveReasonCode:
          stringValue(latestExitCheckpoint.tailWaveReasonCode),
        historicalLabelOnly: true as const,
        summary:
          `${latestExitReason} 后 ${Number(latestExitCheckpoint.horizonMinutes)} 分钟` +
          `路径 ${latestPathOutcome}，执行时机 ${latestExecutionTiming}；` +
          "未来价格仅作历史标签。",
      }
    : null;
  const entryReasons = uniqueStrings([
    ...stringArray(entryEvidence.entryReasons),
    ...stringArray(entryEvidence.reasonCodes),
    ...stringArray(record(entryEvidence.decision).reasonCodes),
    ...stringArray(record(entryEvidence.nexusDecision).reasonCodes),
  ]).slice(0, 8);
  const marketContext = uniqueStrings([
    stringValue(memoryCase.marketContextKey),
    stringValue(memoryCase.volatilityRegime),
    stringValue(memoryCase.liquidityRegime),
    stringValue(memoryCase.liquidationDirection),
  ].filter((item): item is string => Boolean(item)));
  const retrospectiveSummaries = stringArray(retrospective.summaries);
  const learnedRule = stringValue(feedback.summary) ??
    retrospectiveSummaries[0] ??
    stringValue(fastLearning.summary) ??
    "终局结果已吸收；当前证据尚未形成可晋升的参数规则。";
  return {
    triggerKind: stringValue(input.triggerKind) ??
      stringValue(triggerIdentity.triggerKind) ?? "UNKNOWN",
    triggerVersion: stringValue(input.triggerVersion) ??
      stringValue(triggerIdentity.triggerVersion) ?? "unknown",
    entryReasons,
    marketContext,
    learnedRule,
    evidenceSampleCount: input.observedCheckpointMinutes.length + 1,
    evidenceConfidence: input.eligibility === "OBSERVATION_ONLY"
      ? "OBSERVATION_ONLY" as const
      : input.evidenceComplete && input.exactNetAvailable
        ? "EXACT_COMPLETE" as const
        : "TERMINAL_PARTIAL" as const,
    parameterSuggestions: (input.parameterSuggestions ?? []).map(
      (suggestion) => ({
        parameterName: suggestion.parameterName,
        status: suggestion.status,
        sampleCount: suggestion.sampleCount,
        confidence: finiteOrNull(
          recordFromJson(suggestion.evidenceJson).confidence,
        ),
      }),
    ),
    exitQuality,
  };
}

export function learningReviewReadiness(input: {
  terminalStatus: string;
  detailJson: string;
  eligibility?: string;
  exactNetAvailable?: boolean;
}) {
  const detail = recordFromJson(input.detailJson);
  const fastLearning = record(detail.fastLearning);
  const status = String(fastLearning.status ?? "UNAVAILABLE");
  const legacyExactEligible =
    input.eligibility === "ELIGIBLE" && input.exactNetAvailable === true;
  return {
    ready:
      input.terminalStatus === "CLOSED" &&
      (status === "LEARNED" || status === "PARTIAL" || legacyExactEligible),
    fastLearningStatus: status,
  };
}

export function buildStrategyLearningExperience(input: {
  learningKey: string;
  strategyId: number;
  brainKey: string;
  configVersion: number;
  traceId: string;
  orderSource: string;
  terminalStatus: string;
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  preTradeFactsComplete: boolean;
  observedCheckpointMinutes: number[];
  detailJson: string;
  sampleUpdatedAt: Date;
}) {
  const detail = recordFromJson(input.detailJson);
  const fastLearning = record(detail.fastLearning);
  const memoryCase = record(detail.memoryCase);
  const missingCheckpointMinutes = numberArray(
    detail.missingCheckpointMinutes,
  );
  const requiredCheckpointMinutes = numberArray(
    detail.requiredCheckpointMinutes,
  );
  const observedPnlUsdt = finiteOrNull(fastLearning.observedPnlUsdt) ??
    finiteOrNull(memoryCase.observedPnlUsdt);
  const effectivePnlUsdt = input.exactNetAvailable
    ? input.exactNetPnlUsdt
    : observedPnlUsdt;
  const evidenceComplete =
    input.preTradeFactsComplete && missingCheckpointMinutes.length === 0;
  const exitReasons = stringArray(
    fastLearning.exitReasons ?? memoryCase.terminalExitReasons,
  );
  const experience = {
    version: STRATEGY_LEARNING_EXPERIENCE_VERSION,
    learningKey: input.learningKey,
    strategyId: input.strategyId,
    brainKey: input.brainKey,
    configVersion: input.configVersion,
    traceId: input.traceId,
    orderSource: input.orderSource,
    terminalStatus: input.terminalStatus,
    symbol: stringValue(memoryCase.symbol) ?? "UNKNOWN",
    direction: directionValue(memoryCase.direction),
    exactNetAvailable: input.exactNetAvailable,
    exactNetPnlUsdt: input.exactNetAvailable
      ? input.exactNetPnlUsdt
      : null,
    observedPnlUsdt,
    outcome: learningOutcome(effectivePnlUsdt),
    evidenceComplete,
    fastLearningStatus: String(fastLearning.status ?? "UNAVAILABLE"),
    timingAttribution: String(
      fastLearning.timingAttribution ?? "UNAVAILABLE",
    ),
    observedCheckpointMinutes: input.observedCheckpointMinutes,
    requiredCheckpointMinutes,
    missingCheckpointMinutes,
    exitReasons,
    holdingDurationMinutes:
      finiteOrNull(fastLearning.holdingDurationMinutes) ??
      finiteOrNull(record(detail.terminalOutcome).holdingDurationMinutes),
    mfeRoePercent:
      finiteOrNull(fastLearning.mfeRoePercent) ??
      finiteOrNull(memoryCase.mfeRoePercent),
    maeRoePercent:
      finiteOrNull(fastLearning.maeRoePercent) ??
      finiteOrNull(memoryCase.maeRoePercent),
    summary: String(
      fastLearning.summary ??
        record(detail.feedback).summary ??
        "终局结果已由所属大脑自动吸收，等待运营复核归因。",
    ),
    sampleUpdatedAt: input.sampleUpdatedAt.toISOString(),
    orderAffecting: false as const,
    automaticConfigMutationAllowed: false as const,
  };
  return {
    experience,
    outcome: experience.outcome,
    evidenceComplete,
    observedPnlUsdt,
  };
}

export function buildStrategyLearningCapabilitySnapshot(
  reviews: Array<{
    decision: string;
    promotionStatus: string;
    exactNetAvailable: boolean;
    exactNetPnlUsdt: number | null;
    outcome: string;
  }>,
): StrategyLearningCapabilitySnapshot {
  const promoted = reviews.filter(
    (review) =>
      review.decision === "CONFIRMED" &&
      ["PROVISIONAL", "PROMOTED"].includes(review.promotionStatus),
  );
  const exact = promoted.filter(
    (review) =>
      review.exactNetAvailable && Number.isFinite(review.exactNetPnlUsdt),
  );
  const wins = exact.filter((review) => review.outcome === "WIN").length;
  const losses = exact.filter((review) => review.outcome === "LOSS").length;
  const breakeven = exact.filter(
    (review) => review.outcome === "BREAKEVEN",
  ).length;
  return {
    promotedExperiences: promoted.length,
    exactNetExperiences: exact.length,
    wins,
    losses,
    breakeven,
    exactNetPnlUsdt: round(
      exact.reduce(
        (sum, review) => sum + Number(review.exactNetPnlUsdt ?? 0),
        0,
      ),
    ),
    exactNetWinRatePercent: exact.length
      ? round((wins / exact.length) * 100)
      : null,
  };
}

export function addStrategyLearningCapabilityReview(
  current: StrategyLearningCapabilitySnapshot,
  review: {
    decision: string;
    promotionStatus: string;
    exactNetAvailable: boolean;
    exactNetPnlUsdt: number | null;
    outcome: string;
  },
): StrategyLearningCapabilitySnapshot {
  if (
    review.decision !== "CONFIRMED" ||
    !["PROVISIONAL", "PROMOTED"].includes(review.promotionStatus)
  ) return current;
  const exact = review.exactNetAvailable &&
    Number.isFinite(review.exactNetPnlUsdt);
  const exactNetExperiences = current.exactNetExperiences + (exact ? 1 : 0);
  const wins = current.wins + (exact && review.outcome === "WIN" ? 1 : 0);
  const losses = current.losses +
    (exact && review.outcome === "LOSS" ? 1 : 0);
  const breakeven = current.breakeven +
    (exact && review.outcome === "BREAKEVEN" ? 1 : 0);
  return {
    promotedExperiences: current.promotedExperiences + 1,
    exactNetExperiences,
    wins,
    losses,
    breakeven,
    exactNetPnlUsdt: round(
      current.exactNetPnlUsdt +
        (exact ? Number(review.exactNetPnlUsdt) : 0),
    ),
    exactNetWinRatePercent: exactNetExperiences
      ? round((wins / exactNetExperiences) * 100)
      : null,
  };
}

export function learningOutcome(
  pnlUsdt: number | null,
): StrategyLearningOutcome {
  if (!Number.isFinite(pnlUsdt)) return "UNAVAILABLE";
  if (Number(pnlUsdt) > 0.00000001) return "WIN";
  if (Number(pnlUsdt) < -0.00000001) return "LOSS";
  return "BREAKEVEN";
}

export function recordFromJson(value: string | null) {
  try {
    return record(JSON.parse(value ?? "{}"));
  } catch {
    return {};
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function numberArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
    : [];
}

export function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function directionValue(value: unknown): "LONG" | "SHORT" | "UNKNOWN" {
  return value === "LONG" || value === "SHORT" ? value : "UNKNOWN";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}
