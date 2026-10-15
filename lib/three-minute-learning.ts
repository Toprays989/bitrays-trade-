export type ThreeMinuteLearningState = Readonly<{
  modelVersion: string;
  sampleCount: number;
  wins: number;
  losses: number;
  exactNetSampleCount: number;
  exactNetPnlUsdt: number;
  averageWinBps: number;
  averageLossBps: number;
  stableBaselineVersion: string;
  currentVersion: string;
  mode: "CALIBRATING" | "ACTIVE" | "OBSERVE_ONLY" | "ROLLBACK_REQUIRED";
  completedBatches: number;
}>;

export type ThreeMinuteRoundOutcome = Readonly<{
  direction: "LONG" | "SHORT";
  grossReturnBps: number;
  exactNetPnlUsdt: number | null;
  exactSettlement: boolean;
}>;

export type ThreeMinuteParameterLearningSample = Readonly<{
  selectedProbabilityPercent: number;
  netEdgeBps: number;
  exactNetRoePercent: number;
  completedAtMs?: number;
}>;

export type ThreeMinuteExactNetOutcome = Readonly<{
  won: boolean;
  netReturnBps: number;
}>;

export function resolveThreeMinuteExactNetOutcome(input: {
  exactNetPnlUsdt: number | null | undefined;
  entryPrice: number;
  quantity: number;
}): ThreeMinuteExactNetOutcome | null {
  if (
    typeof input.exactNetPnlUsdt !== "number" ||
    !Number.isFinite(input.exactNetPnlUsdt) ||
    !Number.isFinite(input.entryPrice) ||
    !Number.isFinite(input.quantity)
  ) return null;
  const entryNotional = input.entryPrice * input.quantity;
  if (entryNotional <= 0) return null;
  const netReturnBps = input.exactNetPnlUsdt / entryNotional * 10_000;
  if (!Number.isFinite(netReturnBps)) return null;
  return Object.freeze({
    won: input.exactNetPnlUsdt > 0,
    netReturnBps,
  });
}

export function buildThreeMinuteParameterCandidate(input: {
  currentMinimumProbabilityPercent: number;
  currentMinimumNetEdgeBps: number;
  batchSize: number;
  samples: readonly ThreeMinuteParameterLearningSample[];
}) {
  const batch = input.samples
    .filter((sample) =>
      Number.isFinite(sample.selectedProbabilityPercent) &&
      Number.isFinite(sample.netEdgeBps) &&
      Number.isFinite(sample.exactNetRoePercent)
    )
    .sort((left, right) =>
      Number(right.completedAtMs ?? 0) - Number(left.completedAtMs ?? 0)
    )
    .slice(0, Math.max(1, Math.trunc(input.batchSize)));
  if (batch.length < input.batchSize) return null;
  const baselineMean = mean(batch.map((sample) => sample.exactNetRoePercent));
  if (baselineMean >= 0) return null;
  const minimumRetained = Math.max(3, Math.ceil(batch.length * 0.6));
  const probability = bestThresholdCandidate({
    parameterName: "trigger.threeMinuteProbability.minimumProbabilityPercent",
    label: "3分钟最低方向概率",
    currentValue: input.currentMinimumProbabilityPercent,
    values: batch.map((sample) => ({
      threshold: sample.selectedProbabilityPercent,
      outcome: sample.exactNetRoePercent,
    })),
    minimumRetained,
    maximum: 99,
  });
  const netEdge = bestThresholdCandidate({
    parameterName: "trigger.threeMinuteProbability.minimumNetEdgeBps",
    label: "3分钟最低费用后净优势",
    currentValue: input.currentMinimumNetEdgeBps,
    values: batch.map((sample) => ({
      threshold: sample.netEdgeBps,
      outcome: sample.exactNetRoePercent,
    })),
    minimumRetained,
    maximum: 1_000,
  });
  const selected = [probability, netEdge]
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      candidate !== null
    )
    .sort((left, right) =>
      right.improvementRoePoints - left.improvementRoePoints ||
      left.parameterName.localeCompare(right.parameterName)
    )[0];
  if (!selected) return null;
  return Object.freeze({
    parameterName: selected.parameterName,
    label: selected.label,
    currentValue: selected.currentValue,
    suggestedValue: selected.suggestedValue,
    action: "TIGHTEN" as const,
    confidence: Math.min(0.9, 0.55 + selected.retained / batch.length * 0.25),
    reason:
      `最近 ${batch.length} 个费用后精确轮次平均 ${baselineMean.toFixed(3)}% ROE；` +
      `仅保留门槛以上 ${selected.retained} 个历史轮次时平均 ${selected.meanRoePercent.toFixed(3)}% ROE，` +
      `改善 ${selected.improvementRoePoints.toFixed(3)} 个ROE点。` +
      "这是待人工确认的小规模验证候选，不自动修改实盘参数。",
    sampleCount: batch.length,
    retainedSampleCount: selected.retained,
    baselineMeanRoePercent: baselineMean,
    candidateMeanRoePercent: selected.meanRoePercent,
  });
}

export function resolveThreeMinuteExecutionLearningMode(input: {
  sampleCount: number;
  calibrationRounds: number;
  exactNetSampleCount: number;
  recentExactBatchSampleCount: number;
  recentExactBatchPnlUsdt: number;
  batchSize: number;
  calibrationMode: "MINIMUM_ORDER" | "OBSERVE_ONLY";
  negativeExpectancyMode: "MINIMUM_ORDER" | "OBSERVE_ONLY";
  freshPendingExactSettlementCount?: number;
  stalePendingExactSettlementCount?: number;
}) {
  if (input.sampleCount < input.calibrationRounds)
    return input.calibrationMode === "MINIMUM_ORDER"
      ? "CALIBRATING" as const
      : "OBSERVE_ONLY" as const;
  const requiredExactSamples = Math.min(
    input.calibrationRounds,
    input.batchSize,
  );
  if (
    requiredExactSamples > 0 &&
    input.exactNetSampleCount < requiredExactSamples
  ) {
    if (Math.max(0, input.freshPendingExactSettlementCount ?? 0) > 0)
      return "OBSERVE_ONLY" as const;
    if (
      Math.max(0, input.stalePendingExactSettlementCount ?? 0) > 0 &&
      input.calibrationMode === "MINIMUM_ORDER"
    ) return "CALIBRATING" as const;
    return "OBSERVE_ONLY" as const;
  }
  if (
    input.recentExactBatchSampleCount >= input.batchSize &&
    input.recentExactBatchPnlUsdt < 0
  ) return input.negativeExpectancyMode;
  return "ACTIVE" as const;
}

export function initialThreeMinuteLearningState(
  modelVersion = "three-minute-probability-v1",
): ThreeMinuteLearningState {
  return Object.freeze({
    modelVersion,
    sampleCount: 0,
    wins: 0,
    losses: 0,
    exactNetSampleCount: 0,
    exactNetPnlUsdt: 0,
    averageWinBps: 0,
    averageLossBps: 0,
    stableBaselineVersion: modelVersion,
    currentVersion: modelVersion,
    mode: "CALIBRATING",
    completedBatches: 0,
  });
}

export function absorbThreeMinuteRound(input: {
  state: ThreeMinuteLearningState;
  outcome: ThreeMinuteRoundOutcome;
  calibrationRounds: number;
  batchSize: number;
}): ThreeMinuteLearningState {
  const outcome = input.outcome;
  const won = outcome.grossReturnBps > 0;
  const sampleCount = input.state.sampleCount + 1;
  const wins = input.state.wins + (won ? 1 : 0);
  const losses = input.state.losses + (won ? 0 : 1);
  const averageWinBps = won
    ? runningAverage(input.state.averageWinBps, input.state.wins, Math.abs(outcome.grossReturnBps))
    : input.state.averageWinBps;
  const averageLossBps = won
    ? input.state.averageLossBps
    : runningAverage(input.state.averageLossBps, input.state.losses, Math.abs(outcome.grossReturnBps));
  const exactNetSampleCount = input.state.exactNetSampleCount +
    (outcome.exactSettlement ? 1 : 0);
  const exactNetPnlUsdt = input.state.exactNetPnlUsdt +
    (outcome.exactSettlement && Number.isFinite(outcome.exactNetPnlUsdt)
      ? Number(outcome.exactNetPnlUsdt)
      : 0);
  const completedBatches = Math.floor(sampleCount / Math.max(1, input.batchSize));
  const batchJustCompleted = completedBatches > input.state.completedBatches;
  const exactNegative = exactNetSampleCount >= input.batchSize && exactNetPnlUsdt < 0;
  const mode = sampleCount < input.calibrationRounds
    ? "CALIBRATING"
    : batchJustCompleted && exactNegative
      ? "ROLLBACK_REQUIRED"
      : exactNegative
        ? "OBSERVE_ONLY"
        : "ACTIVE";
  return Object.freeze({
    ...input.state,
    sampleCount,
    wins,
    losses,
    exactNetSampleCount,
    exactNetPnlUsdt,
    averageWinBps,
    averageLossBps,
    completedBatches,
    mode,
    currentVersion:
      mode === "ROLLBACK_REQUIRED"
        ? input.state.stableBaselineVersion
        : input.state.currentVersion,
  });
}

export function upgradeThreeMinuteExactSettlement(input: {
  state: ThreeMinuteLearningState;
  exactNetPnlUsdt: number;
  batchSize: number;
}) {
  if (!Number.isFinite(input.exactNetPnlUsdt)) return input.state;
  const exactNetSampleCount = input.state.exactNetSampleCount + 1;
  const exactNetPnlUsdt = input.state.exactNetPnlUsdt + input.exactNetPnlUsdt;
  const negative = exactNetSampleCount >= input.batchSize && exactNetPnlUsdt < 0;
  return Object.freeze({
    ...input.state,
    exactNetSampleCount,
    exactNetPnlUsdt,
    mode: negative ? "ROLLBACK_REQUIRED" as const : input.state.mode,
    currentVersion: negative
      ? input.state.stableBaselineVersion
      : input.state.currentVersion,
  });
}

function runningAverage(current: number, count: number, value: number) {
  return count <= 0 ? value : (current * count + value) / (count + 1);
}

function bestThresholdCandidate(input: {
  parameterName: string;
  label: string;
  currentValue: number;
  values: Array<{ threshold: number; outcome: number }>;
  minimumRetained: number;
  maximum: number;
}) {
  const thresholds = [...new Set(input.values
    .map((row) => round(row.threshold, 2))
    .filter((value) => value > input.currentValue && value <= input.maximum))]
    .sort((left, right) => left - right);
  const baselineMean = mean(input.values.map((row) => row.outcome));
  return thresholds
    .flatMap((threshold) => {
      const retained = input.values.filter((row) => row.threshold >= threshold);
      if (retained.length < input.minimumRetained) return [];
      const meanRoePercent = mean(retained.map((row) => row.outcome));
      const improvementRoePoints = meanRoePercent - baselineMean;
      return meanRoePercent > 0 && improvementRoePoints >= 0.05
        ? [{
            parameterName: input.parameterName,
            label: input.label,
            currentValue: input.currentValue,
            suggestedValue: threshold,
            retained: retained.length,
            meanRoePercent,
            improvementRoePoints,
          }]
        : [];
    })
    .sort((left, right) =>
      right.improvementRoePoints - left.improvementRoePoints ||
      left.suggestedValue - right.suggestedValue
    )[0] ?? null;
}

function mean(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
