export const APPLYABLE_STRATEGY_SUGGESTION_PATHS = new Set([
  "liquidationFactors.mode",
  "execution.orderType",
  "execution.adaptiveMarketMaxDistanceAtr",
  "largeTrader.minTakerBuySellRatio",
  "largeTrader.minOpenInterestChangePercent",
  "marketPosition.maxPosition72hPercent",
  "risk.takeProfitSteps[0].profitPercent",
  "risk.trailingActivationPercent",
  "risk.trailingDrawdownPercent",
  "risk.positionManagement.tailWaveObservationMinutes",
  "trend.maxEntryDistanceAtr",
  "trend.maxPriorRangeAtr",
  "trend.trend1hBreakHandling",
  "trend.structure30mBreakHandling",
  "trend.volumeRatio3m",
  "trigger.minClusterEvents",
  "trigger.maxClusterSpanSeconds",
  "trigger.maxClusterEventGapSeconds",
  "trigger.threeMinuteProbability.minimumProbabilityPercent",
  "trigger.threeMinuteProbability.minimumNetEdgeBps",
]);

export function suggestionMatchesDraftConfig(input: {
  parameterName: string;
  suggestedValue: unknown;
  draftConfig: unknown;
}) {
  if (!APPLYABLE_STRATEGY_SUGGESTION_PATHS.has(input.parameterName))
    return false;
  const actual = configValueAtPath(input.draftConfig, input.parameterName);
  return JSON.stringify(actual) === JSON.stringify(input.suggestedValue);
}

export function acceptedSuggestionEvidence(input: {
  currentEvidence: unknown;
  suggestionId: number;
  sourceConfigVersion: number;
  targetDraftVersion: number;
  reviewerEmail: string;
  reviewedAt: Date;
}) {
  const evidence = record(input.currentEvidence);
  return {
    ...evidence,
    sourceConfigVersion: input.sourceConfigVersion,
    targetDraftVersion: input.targetDraftVersion,
    humanDecision: {
      status: "ACCEPTED_TO_DRAFT" as const,
      suggestionId: input.suggestionId,
      reviewerEmail: input.reviewerEmail,
      reviewedAt: input.reviewedAt.toISOString(),
    },
    validationPlan: {
      mode: "SMALL_LIVE_SAMPLE" as const,
      requiredCompleteCycles: 8,
      minimumRollbackCycles: 3,
      maximumCompleteCycles: 12,
      automaticExpansionAllowed: false as const,
      automaticPromotionAllowed: false as const,
      automaticDeteriorationRollbackAllowed: true as const,
      oldPositionsKeepBoundVersionOnRollback: true as const,
    },
  };
}

export type CandidateSuggestionSnapshot = {
  id: number;
  status: string;
  configVersion: number;
  parameterName: string;
  suggestedValueJson: string;
  evidenceJson: string;
  reviewedAt: Date | null;
};

export function validateFreshCandidateSuggestions(input: {
  baselineVersion: number;
  candidateVersion: number;
  draftUpdatedAt: Date | null;
  draftConfig: unknown;
  suggestions: CandidateSuggestionSnapshot[];
}) {
  if (input.suggestions.length > 1)
    return { ok: false as const, error: "每个候选版本只能验证一个参数" };
  if (!input.suggestions.length)
    return { ok: true as const, confirmation: null };
  const suggestion = input.suggestions[0];
  const evidence = recordFromJson(suggestion.evidenceJson);
  const humanDecision = record(evidence.humanDecision);
  const reviewedAtMs = suggestion.reviewedAt?.getTime() ?? Number.NaN;
  const evidenceReviewedAtMs = Date.parse(String(humanDecision.reviewedAt ?? ""));
  const draftUpdatedAtMs = input.draftUpdatedAt?.getTime() ?? Number.NaN;
  if (
    suggestion.status !== "ACCEPTED" ||
    suggestion.configVersion !== input.baselineVersion ||
    Number(evidence.sourceConfigVersion) !== input.baselineVersion ||
    Number(evidence.targetDraftVersion) !== input.candidateVersion ||
    humanDecision.status !== "ACCEPTED_TO_DRAFT" ||
    Number(humanDecision.suggestionId) !== suggestion.id ||
    typeof humanDecision.reviewerEmail !== "string" ||
    !humanDecision.reviewerEmail.trim() ||
    !Number.isFinite(reviewedAtMs) ||
    !Number.isFinite(evidenceReviewedAtMs) ||
    Math.abs(reviewedAtMs - evidenceReviewedAtMs) > 1_000 ||
    !Number.isFinite(draftUpdatedAtMs) ||
    draftUpdatedAtMs < reviewedAtMs ||
    !suggestionMatchesDraftConfig({
      parameterName: suggestion.parameterName,
      suggestedValue: parseJson(suggestion.suggestedValueJson),
      draftConfig: input.draftConfig,
    })
  )
    return {
      ok: false as const,
      error: "候选建议确认已过期或与当前草稿不一致，请重新带入建议",
    };
  return {
    ok: true as const,
    confirmation: {
      status: "CONFIRMED_TO_SMALL_LIVE_VALIDATION" as const,
      source: "ACCEPTED_PARAMETER_SUGGESTION" as const,
      confirmedBy: humanDecision.reviewerEmail.trim(),
      confirmedAt: new Date(reviewedAtMs).toISOString(),
      baselineVersion: input.baselineVersion,
      candidateVersion: input.candidateVersion,
      suggestionIds: [suggestion.id],
    },
  };
}

export function manualCandidateConfirmation(input: {
  confirmedBy: string;
  confirmedAt: Date;
  baselineVersion: number;
  candidateVersion: number;
}) {
  return {
    status: "CONFIRMED_TO_SMALL_LIVE_VALIDATION" as const,
    source: "HUMAN_CONFIG_PUBLISH" as const,
    confirmedBy: input.confirmedBy,
    confirmedAt: input.confirmedAt.toISOString(),
    baselineVersion: input.baselineVersion,
    candidateVersion: input.candidateVersion,
    suggestionIds: [] as number[],
  };
}

export function candidateConfirmationMatches(input: {
  confirmation: unknown;
  baselineVersion: number;
  candidateVersion: number;
  suggestionIds: number[];
}) {
  const confirmation = record(input.confirmation);
  const confirmedAtMs = Date.parse(String(confirmation.confirmedAt ?? ""));
  const confirmedSuggestionIds = positiveIntegerArray(confirmation.suggestionIds);
  return (
    confirmation.status === "CONFIRMED_TO_SMALL_LIVE_VALIDATION" &&
    (confirmation.source === "ACCEPTED_PARAMETER_SUGGESTION" ||
      confirmation.source === "HUMAN_CONFIG_PUBLISH") &&
    typeof confirmation.confirmedBy === "string" &&
    confirmation.confirmedBy.trim().length > 0 &&
    Number.isFinite(confirmedAtMs) &&
    confirmedAtMs <= Date.now() + 60_000 &&
    Number(confirmation.baselineVersion) === input.baselineVersion &&
    Number(confirmation.candidateVersion) === input.candidateVersion &&
    JSON.stringify(confirmedSuggestionIds) ===
      JSON.stringify([...input.suggestionIds].sort((a, b) => a - b))
  );
}

function configValueAtPath(config: unknown, parameterName: string) {
  const segments = parameterName
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".");
  let cursor: unknown = config;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = Array.isArray(cursor)
      ? cursor[Number(segment)]
      : (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recordFromJson(value: string) {
  return record(parseJson(value));
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function positiveIntegerArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(Number)
        .filter((item) => Number.isSafeInteger(item) && item > 0)
        .sort((a, b) => a - b)
    : [];
}
