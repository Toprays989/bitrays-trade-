export type MovingProtectionReviewSample = {
  decisionAtMs: number | null;
  finalNetRoePercent: number | null;
  lifetimeBestRoePercent: number | null;
  exitAttributionMode:
    | "AUTOMATED_ONLY"
    | "OPERATOR_INTERVENED"
    | "EXTERNAL_UNKNOWN"
    | "UNKNOWN";
};

export type MovingProtectionReview = {
  version: "moving-protection-review-v1";
  status:
    | "COLLECTING"
    | "PRELIMINARY_REVIEW"
    | "KEEP_CURRENT"
    | "SHADOW_CANDIDATE";
  displayValue: string;
  orderAffecting: false;
  parameterAffecting: false;
  exactNetClosedSamples: number;
  automatedComparableSamples: number;
  operatorExcludedSamples: number;
  externalOrUnknownExcludedSamples: number;
  minimumPreliminarySamples: number;
  minimumCandidateSamples: number;
  currentActivationRoePercent: number;
  currentDrawdownRoePoints: number;
  firstTakeProfitRoePercent: number;
  meaningfulWaveRoePercent: number;
  medianLifetimeBestRoePercent: number | null;
  averageFinalNetRoePercent: number | null;
  medianCaptureEfficiencyPercent: number | null;
  givebackCount: number;
  givebackRatePercent: number | null;
  weakCaptureCount: number;
  weakCaptureRatePercent: number | null;
  preActivationGivebackCount: number;
  preActivationGivebackRatePercent: number | null;
  postActivationWeakCaptureCount: number;
  postActivationWeakCaptureRatePercent: number | null;
  recentHoldoutSamples: number;
  recentPreActivationGivebackRatePercent: number | null;
  recentPostActivationWeakCaptureRatePercent: number | null;
  candidate: {
    parameterName:
      | "risk.trailingActivationPercent"
      | "risk.trailingDrawdownPercent";
    currentValue: number;
    candidateValue: number;
    basis: "PRE_ACTIVATION_GIVEBACK" | "POST_ACTIVATION_WEAK_CAPTURE";
  } | null;
  summary: string;
};

export function evaluateMovingProtectionReview(input: {
  samples: MovingProtectionReviewSample[];
  minimumOrders: number;
  trailingActivationRoePercent: number;
  trailingDrawdownRoePoints: number;
  firstTakeProfitRoePercent: number;
}): MovingProtectionReview {
  const exactNetClosedSamples = input.samples.length;
  const operatorExcludedSamples = input.samples.filter(
    (sample) => sample.exitAttributionMode === "OPERATOR_INTERVENED",
  ).length;
  const externalOrUnknownExcludedSamples = input.samples.filter(
    (sample) =>
      sample.exitAttributionMode === "EXTERNAL_UNKNOWN" ||
      sample.exitAttributionMode === "UNKNOWN",
  ).length;
  const comparable = input.samples
    .filter(
      (sample) =>
        sample.exitAttributionMode === "AUTOMATED_ONLY" &&
        finite(sample.finalNetRoePercent) !== null &&
        finite(sample.lifetimeBestRoePercent) !== null &&
        finite(sample.lifetimeBestRoePercent)! > 0,
    )
    .toSorted((left, right) =>
      (left.decisionAtMs ?? Number.MAX_SAFE_INTEGER) -
      (right.decisionAtMs ?? Number.MAX_SAFE_INTEGER)
    );
  const minimumPreliminarySamples = 10;
  const minimumCandidateSamples = Math.max(
    20,
    Math.ceil(Math.max(1, input.minimumOrders) * 0.2),
  );
  const activation = Math.max(
    0.1,
    finite(input.trailingActivationRoePercent) ?? 0.1,
  );
  const drawdown = Math.max(
    0.1,
    finite(input.trailingDrawdownRoePoints) ?? 0.1,
  );
  const firstTakeProfit = Math.max(
    0,
    finite(input.firstTakeProfitRoePercent) ?? 0,
  );
  const meaningfulWave = Math.max(0.5, firstTakeProfit * 0.6);
  const meaningful = comparable.filter(
    (sample) => sample.lifetimeBestRoePercent! >= meaningfulWave,
  );
  const givebacks = meaningful.filter(
    (sample) => sample.finalNetRoePercent! <= 0,
  );
  const weakCaptures = meaningful.filter(
    (sample) =>
      sample.finalNetRoePercent! < sample.lifetimeBestRoePercent! * 0.3,
  );
  const preActivationGivebacks = meaningful.filter(
    (sample) =>
      sample.lifetimeBestRoePercent! < activation &&
      sample.finalNetRoePercent! <= 0,
  );
  const postActivationWeakCaptures = meaningful.filter(
    (sample) =>
      sample.lifetimeBestRoePercent! >= activation &&
      sample.finalNetRoePercent! < sample.lifetimeBestRoePercent! * 0.3,
  );
  const holdoutSize = comparable.length >= minimumPreliminarySamples
    ? Math.max(4, Math.ceil(comparable.length * 0.3))
    : 0;
  const recentHoldout = holdoutSize > 0
    ? comparable.slice(-holdoutSize)
    : [];
  const olderTraining = holdoutSize > 0
    ? comparable.slice(0, -holdoutSize)
    : [];
  const recentMeaningful = recentHoldout.filter(
    (sample) => sample.lifetimeBestRoePercent! >= meaningfulWave,
  );
  const olderMeaningful = olderTraining.filter(
    (sample) => sample.lifetimeBestRoePercent! >= meaningfulWave,
  );
  const preRate = rate(preActivationGivebacks.length, meaningful.length);
  const postRate = rate(
    postActivationWeakCaptures.length,
    meaningful.length,
  );
  const recentPreRate = rate(
    recentMeaningful.filter(
      (sample) =>
        sample.lifetimeBestRoePercent! < activation &&
        sample.finalNetRoePercent! <= 0,
    ).length,
    recentMeaningful.length,
  );
  const recentPostRate = rate(
    recentMeaningful.filter(
      (sample) =>
        sample.lifetimeBestRoePercent! >= activation &&
        sample.finalNetRoePercent! < sample.lifetimeBestRoePercent! * 0.3,
    ).length,
    recentMeaningful.length,
  );
  const olderPreRate = rate(
    olderMeaningful.filter(
      (sample) =>
        sample.lifetimeBestRoePercent! < activation &&
        sample.finalNetRoePercent! <= 0,
    ).length,
    olderMeaningful.length,
  );
  const olderPostRate = rate(
    olderMeaningful.filter(
      (sample) =>
        sample.lifetimeBestRoePercent! >= activation &&
        sample.finalNetRoePercent! < sample.lifetimeBestRoePercent! * 0.3,
    ).length,
    olderMeaningful.length,
  );
  const enoughForCandidate = comparable.length >= minimumCandidateSamples &&
    recentMeaningful.length >= 4 && olderMeaningful.length >= 8;
  const stablePreActivationIssue = enoughForCandidate &&
    (preRate ?? 0) >= 0.25 &&
    (recentPreRate ?? 0) >= 0.2 &&
    (olderPreRate ?? 0) >= 0.2;
  const stablePostActivationIssue = enoughForCandidate &&
    (postRate ?? 0) >= 0.3 &&
    (recentPostRate ?? 0) >= 0.25 &&
    (olderPostRate ?? 0) >= 0.25;
  const candidate = stablePreActivationIssue
    ? {
        parameterName: "risk.trailingActivationPercent" as const,
        currentValue: round(activation, 2),
        candidateValue: round(
          Math.max(
            0.1,
            Math.min(
              activation * 0.85,
              (median(
                preActivationGivebacks.map(
                  (sample) => sample.lifetimeBestRoePercent!,
                ),
              ) ?? activation) * 0.9,
            ),
          ),
          2,
        ),
        basis: "PRE_ACTIVATION_GIVEBACK" as const,
      }
    : stablePostActivationIssue
      ? {
          parameterName: "risk.trailingDrawdownPercent" as const,
          currentValue: round(drawdown, 2),
          candidateValue: round(Math.max(0.1, drawdown * 0.85), 2),
          basis: "POST_ACTIVATION_WEAK_CAPTURE" as const,
        }
      : null;
  const status = comparable.length < minimumPreliminarySamples
    ? "COLLECTING" as const
    : comparable.length < minimumCandidateSamples
      ? "PRELIMINARY_REVIEW" as const
      : candidate
        ? "SHADOW_CANDIDATE" as const
        : "KEEP_CURRENT" as const;
  const displayValue = status === "COLLECTING"
    ? `积累中 ${comparable.length}/${minimumPreliminarySamples}`
    : status === "PRELIMINARY_REVIEW"
      ? `初步观察 ${comparable.length}/${minimumCandidateSamples}`
      : status === "SHADOW_CANDIDATE"
        ? `影子候选 ${candidate!.candidateValue}%`
        : "保持当前参数";
  const captureEfficiencies = comparable.map(
    (sample) =>
      sample.finalNetRoePercent! / sample.lifetimeBestRoePercent! * 100,
  );
  const averageFinalNetRoe = comparable.length
    ? comparable.reduce(
        (sum, sample) => sum + sample.finalNetRoePercent!,
        0,
      ) / comparable.length
    : null;
  const summary =
    `${comparable.length}笔精确净结算且全程由系统退出的独立完整周期；` +
    `最高有利ROE中位数 ${formatPercent(median(comparable.map((sample) => sample.lifetimeBestRoePercent!)))}，` +
    `最终净ROE均值 ${formatPercent(averageFinalNetRoe)}，` +
    `利润捕获效率中位数 ${formatPercent(median(captureEfficiencies))}。` +
    (status === "COLLECTING"
      ? `不足 ${minimumPreliminarySamples} 笔，只展示事实，不形成参数方向。`
      : status === "PRELIMINARY_REVIEW"
        ? `已可初步观察，但未达到 ${minimumCandidateSamples} 笔及近期留出样本门槛，不形成参数候选。`
        : candidate?.basis === "PRE_ACTIVATION_GIVEBACK"
          ? `启动前回吐在较早样本与近期留出样本中同时存在，仅生成 ${candidate.candidateValue}% 启动线影子候选，等待后续对照，不修改实盘。`
          : candidate?.basis === "POST_ACTIVATION_WEAK_CAPTURE"
            ? `启动后弱捕获在较早样本与近期留出样本中同时存在，仅生成 ${candidate.candidateValue}% 回撤影子候选，等待后续对照，不修改实盘。`
            : "回吐问题未在较早样本和近期留出样本中同时达到门槛，保持当前参数。") +
    ` 已排除人工干预 ${operatorExcludedSamples} 笔、外部或归因不明 ${externalOrUnknownExcludedSamples} 笔。`;

  return {
    version: "moving-protection-review-v1",
    status,
    displayValue,
    orderAffecting: false,
    parameterAffecting: false,
    exactNetClosedSamples,
    automatedComparableSamples: comparable.length,
    operatorExcludedSamples,
    externalOrUnknownExcludedSamples,
    minimumPreliminarySamples,
    minimumCandidateSamples,
    currentActivationRoePercent: round(activation, 2),
    currentDrawdownRoePoints: round(drawdown, 2),
    firstTakeProfitRoePercent: round(firstTakeProfit, 2),
    meaningfulWaveRoePercent: round(meaningfulWave, 2),
    medianLifetimeBestRoePercent: nullableRound(
      median(comparable.map((sample) => sample.lifetimeBestRoePercent!)),
      2,
    ),
    averageFinalNetRoePercent: nullableRound(averageFinalNetRoe, 2),
    medianCaptureEfficiencyPercent: nullableRound(
      median(captureEfficiencies),
      1,
    ),
    givebackCount: givebacks.length,
    givebackRatePercent: percent(givebacks.length, meaningful.length),
    weakCaptureCount: weakCaptures.length,
    weakCaptureRatePercent: percent(
      weakCaptures.length,
      meaningful.length,
    ),
    preActivationGivebackCount: preActivationGivebacks.length,
    preActivationGivebackRatePercent: percent(
      preActivationGivebacks.length,
      meaningful.length,
    ),
    postActivationWeakCaptureCount: postActivationWeakCaptures.length,
    postActivationWeakCaptureRatePercent: percent(
      postActivationWeakCaptures.length,
      meaningful.length,
    ),
    recentHoldoutSamples: recentHoldout.length,
    recentPreActivationGivebackRatePercent: nullableRound(
      recentPreRate === null ? null : recentPreRate * 100,
      1,
    ),
    recentPostActivationWeakCaptureRatePercent: nullableRound(
      recentPostRate === null ? null : recentPostRate * 100,
      1,
    ),
    candidate,
    summary,
  };
}

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function percent(numerator: number, denominator: number) {
  const value = rate(numerator, denominator);
  return value === null ? null : round(value * 100, 1);
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function nullableRound(value: number | null, digits: number) {
  return value === null ? null : round(value, digits);
}

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}
