export const POSITION_ADDITION_LEARNING_VERSION =
  "position-addition-learning-v1";

export type PositionAdditionLearningVerdict =
  | "COLLECTING"
  | "KEEP_PARAMETERS"
  | "REVIEW_PARAMETERS"
  | "REVIEW_DISABLE";

export type PositionAdditionLearningSample = {
  additionId: number;
  minuteOffset: number;
  netAdditionRoePercent: number | null;
  netCompositeRoeImprovement: number | null;
  sampleDelayMs: number;
  sampleSource?: string | null;
  modelVersion: string | null;
};

export type PositionAdditionLearningSummary = {
  learningVersion: typeof POSITION_ADDITION_LEARNING_VERSION;
  positionManagementModelVersion: string;
  observedAdditions: number;
  completedAdditions: number;
  delayedSamples: number;
  backfilledSamples: number;
  terminalSamples: number;
  minimumCompletedAdditions: number;
  remainingCompletedAdditions: number;
  positiveNetAdditionRate30: number | null;
  positiveNetAdditionRate60: number | null;
  medianNetCompositeImprovement30: number | null;
  medianNetCompositeImprovement60: number | null;
  verdict: PositionAdditionLearningVerdict;
  message: string;
};

/**
 * 聚合只使用同一持仓管理模型的5/30/60分钟样本。实时样本必须在目标
 * 时间后90秒内取得；延迟样本只有使用目标时点之前最近一根已闭合标记
 * 价格K线补齐时才可进入学习，恢复时现价不能伪装成历史训练证据。
 */
export function aggregatePositionAdditionLearning(input: {
  samples: PositionAdditionLearningSample[];
  observedAdditionIds?: number[];
  positionManagementModelVersion: string;
  minimumCompletedAdditions?: number;
}): PositionAdditionLearningSummary {
  const minimumCompletedAdditions = integerAtLeast(
    input.minimumCompletedAdditions,
    5,
  );
  const matching = input.samples.filter(
    (sample) =>
      sample.modelVersion === input.positionManagementModelVersion &&
      [5, 30, 60].includes(sample.minuteOffset),
  );
  const observedAdditionIds = new Set([
    ...(input.observedAdditionIds ?? []),
    ...matching.map((sample) => sample.additionId),
  ]);
  const backfilledSamples = matching.filter(
    (sample) =>
      sample.sampleSource ===
      "CENTRAL_PROXY_MARK_PRICE_KLINE_BACKFILL",
  ).length;
  const terminalSamples = matching.filter(
    (sample) => sample.sampleSource === "POSITION_CLOSED_TERMINAL",
  ).length;
  const delayedSamples = matching.filter(
    (sample) =>
      sample.sampleDelayMs > 90_000 &&
      sample.sampleSource !==
        "CENTRAL_PROXY_MARK_PRICE_KLINE_BACKFILL" &&
      sample.sampleSource !== "POSITION_CLOSED_TERMINAL",
  ).length;
  const onTime = matching.filter(
    (sample) =>
      (
        Number.isFinite(sample.sampleDelayMs) &&
        sample.sampleDelayMs >= 0 &&
        sample.sampleDelayMs <= 90_000
      ) ||
      sample.sampleSource ===
        "CENTRAL_PROXY_MARK_PRICE_KLINE_BACKFILL" ||
      sample.sampleSource === "POSITION_CLOSED_TERMINAL",
  );
  const byAddition = new Map<
    number,
    Map<number, PositionAdditionLearningSample>
  >();
  for (const sample of onTime) {
    const milestones = byAddition.get(sample.additionId) ?? new Map();
    milestones.set(sample.minuteOffset, sample);
    byAddition.set(sample.additionId, milestones);
  }
  const completed = [...byAddition.values()].filter((milestones) =>
    [5, 30, 60].every((minute) => milestones.has(minute))
  );
  const minute30 = completed
    .map((milestones) => milestones.get(30)!)
    .filter(Boolean);
  const minute60 = completed
    .map((milestones) => milestones.get(60)!)
    .filter(Boolean);
  const positiveNetAdditionRate30 = positiveRate(minute30);
  const positiveNetAdditionRate60 = positiveRate(minute60);
  const medianNetCompositeImprovement30 = median(
    minute30
      .map((sample) => sample.netCompositeRoeImprovement)
      .filter((value): value is number => Number.isFinite(value)),
  );
  const medianNetCompositeImprovement60 = median(
    minute60
      .map((sample) => sample.netCompositeRoeImprovement)
      .filter((value): value is number => Number.isFinite(value)),
  );

  let verdict: PositionAdditionLearningVerdict = "COLLECTING";
  let message =
    `已完成 ${completed.length}/${minimumCompletedAdditions} 个可验证的补仓后 5/30/60 分钟周期；` +
    "样本不足时不改变补仓参数。";
  if (completed.length >= minimumCompletedAdditions) {
    if (
      medianNetCompositeImprovement60 !== null &&
      medianNetCompositeImprovement60 <= -1 &&
      positiveNetAdditionRate60 !== null &&
      positiveNetAdditionRate60 < 0.4
    ) {
      verdict = "REVIEW_DISABLE";
      message =
        `扣除补仓新增双边手续费后，60分钟组合ROE相对不补仓的中位变化为 ${signed(medianNetCompositeImprovement60)} 个百分点，` +
        `补仓腿净正收益率 ${(positiveNetAdditionRate60 * 100).toFixed(0)}%；建议人工复核并暂停自动补仓，不自动改参数。`;
    } else if (
      medianNetCompositeImprovement60 !== null &&
      medianNetCompositeImprovement60 > 0 &&
      positiveNetAdditionRate60 !== null &&
      positiveNetAdditionRate60 >= 0.55
    ) {
      verdict = "KEEP_PARAMETERS";
      message =
        `扣除补仓新增双边手续费后，60分钟组合ROE相对不补仓的中位改善为 ${signed(medianNetCompositeImprovement60)} 个百分点，` +
        `补仓腿净正收益率 ${(positiveNetAdditionRate60 * 100).toFixed(0)}%；当前证据支持维持参数并继续验证。`;
    } else {
      verdict = "REVIEW_PARAMETERS";
      message =
        `扣除补仓新增双边手续费后，60分钟结果分化：组合ROE中位变化 ${formatNullable(medianNetCompositeImprovement60)} 个百分点，` +
        `补仓腿净正收益率 ${percentNullable(positiveNetAdditionRate60)}；建议复核反弹阈值、补仓金额和最大亏损范围。`;
    }
  }

  return {
    learningVersion: POSITION_ADDITION_LEARNING_VERSION,
    positionManagementModelVersion: input.positionManagementModelVersion,
    observedAdditions: observedAdditionIds.size,
    completedAdditions: completed.length,
    delayedSamples,
    backfilledSamples,
    terminalSamples,
    minimumCompletedAdditions,
    remainingCompletedAdditions: Math.max(
      0,
      minimumCompletedAdditions - completed.length,
    ),
    positiveNetAdditionRate30,
    positiveNetAdditionRate60,
    medianNetCompositeImprovement30,
    medianNetCompositeImprovement60,
    verdict,
    message,
  };
}

function positiveRate(samples: PositionAdditionLearningSample[]) {
  const measured = samples.filter((sample) =>
    Number.isFinite(sample.netAdditionRoePercent)
  );
  if (!measured.length) return null;
  return (
    measured.filter((sample) => sample.netAdditionRoePercent! > 0).length /
    measured.length
  );
}

function median(values: number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function integerAtLeast(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatNullable(value: number | null) {
  return value === null ? "暂无" : signed(value);
}

function percentNullable(value: number | null) {
  return value === null ? "暂无" : `${(value * 100).toFixed(0)}%`;
}
