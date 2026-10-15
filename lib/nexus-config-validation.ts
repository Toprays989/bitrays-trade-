export const NEXUS_CONFIG_VALIDATION_VERSION = "nexus-config-validation-v2" as const;
export const NEXUS_CONFIG_VALIDATION_TARGET_CYCLES = 8;
export const NEXUS_CONFIG_VALIDATION_MIN_ROLLBACK_CYCLES = 3;
export const NEXUS_CONFIG_VALIDATION_MAX_CYCLES = 12;

export type AcceptedSuggestionForValidation = {
  id: number;
  status: string;
  evidenceJson: string;
};

export type LearningCycleForConfigValidation = {
  configVersion: number;
  terminalStatus: string;
  exactNetAvailable: boolean;
  exactNetPnlUsdt: number | null;
  eligibility: string;
  manualIntervention: boolean;
  updatedAtMs?: number | null;
};

type ValidationMetrics = {
  sampleCount: number;
  exactNetPnlUsdt: number | null;
  averageNetPnlUsdt: number | null;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePercent: number | null;
  profitFactor: number | null;
  maximumDrawdownUsdt: number | null;
  currentLossStreak: number;
  largestWinSharePercent: number | null;
};

export function buildNexusConfigValidation(input: {
  configVersion: number;
  suggestions: AcceptedSuggestionForValidation[];
  cycles: LearningCycleForConfigValidation[];
  sourceConfigVersion?: number | null;
  targetCycles?: number;
  minimumRollbackCycles?: number;
  maximumCycles?: number;
  directCandidate?: boolean;
}) {
  const targetCycles = boundedInteger(
    input.targetCycles,
    NEXUS_CONFIG_VALIDATION_TARGET_CYCLES,
    3,
  );
  const minimumRollbackCycles = Math.min(
    targetCycles,
    boundedInteger(
      input.minimumRollbackCycles,
      NEXUS_CONFIG_VALIDATION_MIN_ROLLBACK_CYCLES,
      2,
    ),
  );
  const maximumCycles = Math.max(
    targetCycles,
    boundedInteger(
      input.maximumCycles,
      NEXUS_CONFIG_VALIDATION_MAX_CYCLES,
      targetCycles,
    ),
  );
  const matchedSuggestions = input.suggestions
    .map((suggestion) => ({
      id: suggestion.id,
      status: suggestion.status,
      evidence: recordFromJson(suggestion.evidenceJson),
    }))
    .filter(
      (suggestion) =>
        ["ACCEPTED", "REJECTED"].includes(suggestion.status) &&
        Number(suggestion.evidence.targetDraftVersion) === input.configVersion,
    );
  const sourceConfigVersion = positiveInteger(input.sourceConfigVersion) ??
    matchedSuggestions
      .map((suggestion) => positiveInteger(suggestion.evidence.sourceConfigVersion))
      .find((value): value is number => value !== null) ??
    null;
  const terminalDecision = matchedSuggestions
    .map((suggestion) => record(suggestion.evidence.validationDecision))
    .find((decision) =>
      decision.status === "PROMOTED" || decision.status === "ROLLED_BACK"
    );
  if (!matchedSuggestions.length && !input.directCandidate) {
    return emptyValidation(input.configVersion, targetCycles);
  }
  const candidateCycles = validCycles(input.cycles, input.configVersion);
  const candidate = metrics(candidateCycles.slice(0, maximumCycles));
  const baselineCycles = sourceConfigVersion === null
    ? []
    : validCycles(input.cycles, sourceConfigVersion).slice(-targetCycles);
  const baseline = metrics(baselineCycles);
  if (terminalDecision?.status === "PROMOTED")
    return validationResult({
      status: "PROMOTED",
      recommendation: "KEEP_PROMOTED_CONFIG",
      candidate,
      baseline,
      deteriorationReasons: [],
      promotionReasons: ["人工已确认候选版本晋升为稳定基线"],
    });
  if (terminalDecision?.status === "ROLLED_BACK")
    return validationResult({
      status: "ROLLED_BACK",
      recommendation: "RELEARN_FROM_FAILED_CANDIDATE",
      candidate,
      baseline,
      deteriorationReasons: stringArray(terminalDecision.reasons),
      promotionReasons: [],
    });

  const deteriorationReasons = detectDeterioration({
    candidate,
    baseline,
    minimumRollbackCycles,
    targetCycles,
    maximumCycles,
  });
  const promotionReasons = detectPromotionReadiness({
    candidate,
    baseline,
    targetCycles,
  });
  const rollbackRequired = deteriorationReasons.length > 0;
  const promotionReady = !rollbackRequired && promotionReasons.length > 0;
  return validationResult({
    status: rollbackRequired
      ? "ROLLBACK_REQUIRED"
      : promotionReady
        ? "PROMOTION_READY"
        : "COLLECTING",
    recommendation: rollbackRequired
      ? "QUARANTINE_AND_ROLLBACK"
      : promotionReady
        ? "REQUEST_HUMAN_PROMOTION"
        : "CONTINUE_COLLECTING",
    candidate,
    baseline,
    deteriorationReasons,
    promotionReasons,
  });

  function validationResult(inputResult: {
    status:
      | "COLLECTING"
      | "PROMOTION_READY"
      | "ROLLBACK_REQUIRED"
      | "PROMOTED"
      | "ROLLED_BACK";
    recommendation:
      | "CONTINUE_COLLECTING"
      | "REQUEST_HUMAN_PROMOTION"
      | "QUARANTINE_AND_ROLLBACK"
      | "KEEP_PROMOTED_CONFIG"
      | "RELEARN_FROM_FAILED_CANDIDATE";
    candidate: ValidationMetrics;
    baseline: ValidationMetrics;
    deteriorationReasons: string[];
    promotionReasons: string[];
  }) {
    return {
      version: NEXUS_CONFIG_VALIDATION_VERSION,
      status: inputResult.status,
      recommendation: inputResult.recommendation,
      configVersion: input.configVersion,
      sourceConfigVersion,
      targetCycles,
      minimumRollbackCycles,
      maximumCycles,
      completedCycles: inputResult.candidate.sampleCount,
      exactNetPnlUsdt: inputResult.candidate.exactNetPnlUsdt,
      wins: inputResult.candidate.wins,
      losses: inputResult.candidate.losses,
      outcome: outcome(inputResult.candidate.exactNetPnlUsdt),
      candidate: inputResult.candidate,
      baseline: inputResult.baseline,
      deteriorationReasons: inputResult.deteriorationReasons,
      promotionReasons: inputResult.promotionReasons,
      suggestionIds: matchedSuggestions.map((suggestion) => suggestion.id),
      sourceLearningSampleIds: matchedSuggestions
        .flatMap((suggestion) => [
          suggestion.evidence.sourceLearningSampleId,
          ...unknownArray(suggestion.evidence.sourceLearningSampleIds),
        ])
        .filter((value): value is string =>
          typeof value === "string" && value.length > 0
        )
        .filter((value, index, values) => values.indexOf(value) === index),
      orderAffecting: inputResult.status === "ROLLBACK_REQUIRED",
      automaticRollbackAllowed: true as const,
      automaticPromotionAllowed: false as const,
      automaticConfigMutationAllowed:
        inputResult.status === "ROLLBACK_REQUIRED",
    };
  }
}

function emptyValidation(configVersion: number, targetCycles: number) {
  const empty = metrics([]);
  return {
    version: NEXUS_CONFIG_VALIDATION_VERSION,
    status: "NOT_APPLICABLE" as const,
    recommendation: "NO_CANDIDATE" as const,
    configVersion,
    sourceConfigVersion: null,
    targetCycles,
    minimumRollbackCycles: NEXUS_CONFIG_VALIDATION_MIN_ROLLBACK_CYCLES,
    maximumCycles: NEXUS_CONFIG_VALIDATION_MAX_CYCLES,
    completedCycles: 0,
    exactNetPnlUsdt: null,
    wins: 0,
    losses: 0,
    outcome: "UNAVAILABLE" as const,
    candidate: empty,
    baseline: empty,
    deteriorationReasons: [] as string[],
    promotionReasons: [] as string[],
    suggestionIds: [] as number[],
    sourceLearningSampleIds: [] as string[],
    orderAffecting: false as const,
    automaticRollbackAllowed: true as const,
    automaticPromotionAllowed: false as const,
    automaticConfigMutationAllowed: false as const,
  };
}

function validCycles(
  cycles: LearningCycleForConfigValidation[],
  configVersion: number,
) {
  return cycles
    .filter(
      (cycle) =>
        cycle.configVersion === configVersion &&
        cycle.terminalStatus === "CLOSED" &&
        cycle.exactNetAvailable === true &&
        Number.isFinite(cycle.exactNetPnlUsdt) &&
        cycle.eligibility === "ELIGIBLE" &&
        cycle.manualIntervention === false,
    )
    .sort(
      (left, right) =>
        Number(left.updatedAtMs ?? 0) - Number(right.updatedAtMs ?? 0),
    );
}

function metrics(cycles: LearningCycleForConfigValidation[]): ValidationMetrics {
  const pnl = cycles.map((cycle) => Number(cycle.exactNetPnlUsdt));
  const gains = pnl.filter((value) => value > 0);
  const lossValues = pnl.filter((value) => value < 0);
  const grossProfit = gains.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(lossValues.reduce((sum, value) => sum + value, 0));
  const total = pnl.reduce((sum, value) => sum + value, 0);
  let lossStreak = 0;
  for (let index = pnl.length - 1; index >= 0 && pnl[index] < 0; index -= 1)
    lossStreak += 1;
  return {
    sampleCount: pnl.length,
    exactNetPnlUsdt: pnl.length ? round(total) : null,
    averageNetPnlUsdt: pnl.length ? round(total / pnl.length) : null,
    wins: gains.length,
    losses: lossValues.length,
    breakeven: pnl.length - gains.length - lossValues.length,
    winRatePercent: pnl.length ? round(gains.length / pnl.length * 100) : null,
    profitFactor: grossLoss > 0
      ? round(grossProfit / grossLoss)
      : gains.length
        ? Number.POSITIVE_INFINITY
        : null,
    maximumDrawdownUsdt: pnl.length ? round(maximumDrawdown(pnl)) : null,
    currentLossStreak: lossStreak,
    largestWinSharePercent: grossProfit > 0
      ? round(Math.max(...gains) / grossProfit * 100)
      : null,
  };
}

function detectDeterioration(input: {
  candidate: ValidationMetrics;
  baseline: ValidationMetrics;
  minimumRollbackCycles: number;
  targetCycles: number;
  maximumCycles: number;
}) {
  const reasons: string[] = [];
  const candidate = input.candidate;
  if (candidate.sampleCount < input.minimumRollbackCycles) return reasons;
  if (
    candidate.currentLossStreak >= input.minimumRollbackCycles &&
    Number(candidate.exactNetPnlUsdt) < 0
  )
    reasons.push(
      `候选版本连续亏损 ${candidate.currentLossStreak} 个精确净结算周期`,
    );
  if (
    candidate.losses >= input.minimumRollbackCycles &&
    candidate.profitFactor !== null &&
    candidate.profitFactor < 0.65 &&
    Number(candidate.exactNetPnlUsdt) < 0
  )
    reasons.push(
      `候选版本利润因子 ${format(candidate.profitFactor)} 低于恶化线 0.65`,
    );
  if (
    input.baseline.sampleCount >= input.minimumRollbackCycles &&
    candidate.averageNetPnlUsdt !== null &&
    input.baseline.averageNetPnlUsdt !== null &&
    Number(candidate.exactNetPnlUsdt) < 0
  ) {
    const tolerance = Math.max(
      0.03,
      Math.abs(input.baseline.averageNetPnlUsdt) * 0.35,
    );
    if (
      candidate.averageNetPnlUsdt <
        input.baseline.averageNetPnlUsdt - tolerance
    )
      reasons.push(
        `候选单周期净收益 ${format(candidate.averageNetPnlUsdt)} USDT，显著低于基线 ${format(input.baseline.averageNetPnlUsdt)} USDT`,
      );
  }
  if (
    candidate.sampleCount >= input.targetCycles &&
    Number(candidate.exactNetPnlUsdt) <= 0
  )
    reasons.push(
      `达到 ${input.targetCycles} 个验证周期后费用后累计净收益仍未转正`,
    );
  if (candidate.sampleCount >= input.maximumCycles)
    reasons.push(
      `达到最多 ${input.maximumCycles} 个验证周期仍未满足晋升规则`,
    );
  return [...new Set(reasons)];
}

function detectPromotionReadiness(input: {
  candidate: ValidationMetrics;
  baseline: ValidationMetrics;
  targetCycles: number;
}) {
  const candidate = input.candidate;
  if (
    candidate.sampleCount < input.targetCycles ||
    Number(candidate.exactNetPnlUsdt) <= 0 ||
    candidate.averageNetPnlUsdt === null ||
    candidate.averageNetPnlUsdt <= 0 ||
    candidate.profitFactor === null ||
    candidate.profitFactor < 1.15 ||
    candidate.wins < candidate.losses ||
    (
      candidate.largestWinSharePercent !== null &&
      candidate.largestWinSharePercent > 70
    )
  ) return [];
  if (
    input.baseline.sampleCount >= 3 &&
    input.baseline.averageNetPnlUsdt !== null &&
    input.baseline.averageNetPnlUsdt > 0 &&
    candidate.averageNetPnlUsdt < input.baseline.averageNetPnlUsdt * 0.85
  ) return [];
  return [
    `候选版本 ${candidate.sampleCount} 个费用后完整周期累计净收益 ${format(candidate.exactNetPnlUsdt)} USDT`,
    `利润因子 ${format(candidate.profitFactor)}，胜负 ${candidate.wins}/${candidate.losses}，且单笔盈利未支配全部结果`,
    input.baseline.sampleCount
      ? "候选版本未显著弱于上一稳定基线"
      : "缺少可比基线，已按更严格绝对规则验证",
  ];
}

function maximumDrawdown(values: number[]) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function outcome(pnl: number | null) {
  return pnl === null
    ? "UNAVAILABLE" as const
    : pnl > 0
      ? "POSITIVE" as const
      : pnl < 0
        ? "NEGATIVE" as const
        : "FLAT" as const;
}

function recordFromJson(value: string) {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unknownArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
) {
  const number = Number(value);
  return Math.max(
    minimum,
    Math.trunc(Number.isFinite(number) ? number : fallback),
  );
}

function format(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toFixed(4);
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}
