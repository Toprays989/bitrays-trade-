export const POSITION_EVIDENCE_RISK_VERSION =
  "position-evidence-risk-v2" as const;

export type PositionEvidenceRiskConfig = {
  enabled: boolean;
  warningMinute: number;
  reductionMinute: number;
  exitMinute: number;
  reductionPercent: number;
  minimumDeteriorationRoePoints: number;
  postReductionExitDelaySeconds: number;
  exitRemainingOnPersistentInvalidation: boolean;
};

export const DEFAULT_POSITION_EVIDENCE_RISK_CONFIG:
  Readonly<PositionEvidenceRiskConfig> = Object.freeze({
    enabled: true,
    warningMinute: 3,
    reductionMinute: 5,
    exitMinute: 15,
  reductionPercent: 30,
  minimumDeteriorationRoePoints: 0.5,
  postReductionExitDelaySeconds: 15,
  exitRemainingOnPersistentInvalidation: false,
  });

export type PositionEvidenceRiskAssessment = {
  version: typeof POSITION_EVIDENCE_RISK_VERSION;
  stage:
    | "DISABLED"
    | "NORMAL_FLUCTUATION"
    | "EVIDENCE_WARNING"
    | "PARTIAL_RISK_REDUCTION"
    | "REDUCED_RISK_MONITORING"
    | "EVIDENCE_INVALIDATED_EXIT";
  action: "HOLD" | "FREEZE_RISK" | "REDUCE_PARTIAL" | "EXIT_FULL";
  observedMinute: number;
  currentNetRoePercent: number;
  bestGrossRoePercent: number;
  bestNetRoePercent: number;
  givebackFromPeakRoePoints: number;
  feeCoveredProfitFullyGivenBack: boolean;
  minute3NetRoePercent: number | null;
  minute5NetRoePercent: number | null;
  estimatedRoundTripCostRoePercent: number;
  adverseEvidenceCodes: string[];
  localAdverseEvidenceCount: number;
  normalPullback: boolean;
  priorReductionExecuted: boolean;
  postReductionObservationEligible: boolean;
  reductionPercent: number | null;
  reason: string;
};

export function normalizePositionEvidenceRiskConfig(
  value: unknown,
): PositionEvidenceRiskConfig {
  const source = record(value);
  const warningMinute = integerOr(
    source.warningMinute,
    DEFAULT_POSITION_EVIDENCE_RISK_CONFIG.warningMinute,
  );
  const reductionMinute = Math.max(
    warningMinute + 1,
    integerOr(
      source.reductionMinute,
      DEFAULT_POSITION_EVIDENCE_RISK_CONFIG.reductionMinute,
    ),
  );
  const exitMinute = Math.max(
    reductionMinute + 1,
    integerOr(
      source.exitMinute,
      DEFAULT_POSITION_EVIDENCE_RISK_CONFIG.exitMinute,
    ),
  );
  return {
    enabled: typeof source.enabled === "boolean"
      ? source.enabled
      : DEFAULT_POSITION_EVIDENCE_RISK_CONFIG.enabled,
    warningMinute,
    reductionMinute,
    exitMinute,
    reductionPercent: boundedOr(
      source.reductionPercent,
      1,
      99,
      DEFAULT_POSITION_EVIDENCE_RISK_CONFIG.reductionPercent,
    ),
    minimumDeteriorationRoePoints: boundedOr(
      source.minimumDeteriorationRoePoints,
      0.1,
      100,
      DEFAULT_POSITION_EVIDENCE_RISK_CONFIG
        .minimumDeteriorationRoePoints,
    ),
    postReductionExitDelaySeconds: Math.max(
      5,
      integerOr(
        source.postReductionExitDelaySeconds,
        DEFAULT_POSITION_EVIDENCE_RISK_CONFIG.postReductionExitDelaySeconds,
      ),
    ),
    exitRemainingOnPersistentInvalidation:
      typeof source.exitRemainingOnPersistentInvalidation === "boolean"
        ? source.exitRemainingOnPersistentInvalidation
        : DEFAULT_POSITION_EVIDENCE_RISK_CONFIG
          .exitRemainingOnPersistentInvalidation,
  };
}

/**
 * Convert post-fill price, structure and real-volume facts into one ordered
 * risk response. A negative ROE alone never reduces or exits a position:
 * local adverse evidence and persistent fee-adjusted deterioration must agree.
 * Likewise, an aligned higher-timeframe pullback remains ordinary volatility
 * until local structure or real volume proves otherwise.
 */
export function assessPositionEvidenceRisk(input: {
  config?: Partial<PositionEvidenceRiskConfig> | null;
  observedMinute: number;
  currentRoePercent: number;
  bestRoePercent?: number | null;
  minute3RoePercent?: number | null;
  minute5RoePercent?: number | null;
  estimatedRoundTripCostRoePercent?: number | null;
  profitGivebackRoePoints?: number | null;
  priorReductionExecuted?: boolean;
  postReductionElapsedSeconds?: number | null;
  clearInvalidation?: boolean;
  waveState?: string | null;
  entryThesisStatus?: string | null;
  trendPathStatus?: string | null;
  tradeVolumeStatus?: string | null;
  contractTrendStatus?: string | null;
  positionThesisOutlook?: string | null;
}): PositionEvidenceRiskAssessment {
  const config = normalizePositionEvidenceRiskConfig(input.config);
  const observedMinute = Math.max(0, Math.trunc(finite(input.observedMinute)));
  const estimatedCost = Math.max(
    0,
    finite(input.estimatedRoundTripCostRoePercent),
  );
  const currentNet = finite(input.currentRoePercent) - estimatedCost;
  const bestGross = Math.max(
    finite(input.currentRoePercent),
    finite(input.bestRoePercent),
  );
  const bestNet = bestGross - estimatedCost;
  const givebackFromPeak = Math.max(
    0,
    bestGross - finite(input.currentRoePercent),
  );
  const profitGivebackThreshold = boundedOr(
    input.profitGivebackRoePoints,
    0.1,
    100,
    3,
  );
  const localContinuationLost = [
    "RANGE",
    "MOMENTUM_DECAY",
    "REVERSAL_PRESSURE",
  ].includes(String(input.trendPathStatus)) &&
    ["CONTRACTING", "MIXED", "OPPOSITE_EXPANSION"].includes(
      String(input.tradeVolumeStatus),
    );
  const feeCoveredProfitFullyGivenBack =
    observedMinute >= config.reductionMinute &&
    bestNet >= profitGivebackThreshold &&
    currentNet < 0 &&
    givebackFromPeak >= profitGivebackThreshold &&
    localContinuationLost;
  const minute3Gross = finiteOrNull(input.minute3RoePercent);
  const minute5Gross = finiteOrNull(input.minute5RoePercent);
  const minute3Net = minute3Gross === null ? null : minute3Gross - estimatedCost;
  const minute5Net = minute5Gross === null ? null : minute5Gross - estimatedCost;
  const adverseEvidenceCodes = [
    input.entryThesisStatus === "WATCH" ? "ENTRY_THESIS_WATCH" : null,
    input.entryThesisStatus === "INVALIDATED"
      ? "ENTRY_THESIS_INVALIDATED"
      : null,
    input.waveState === "SUPPORT_BREAK" ? "LOCAL_STRUCTURE_BROKEN" : null,
    input.trendPathStatus === "REVERSAL_PRESSURE"
      ? "CLOSED_PATH_REVERSAL_PRESSURE"
      : null,
    input.tradeVolumeStatus === "OPPOSITE_EXPANSION"
      ? "REAL_VOLUME_OPPOSES_POSITION"
      : null,
    input.contractTrendStatus === "OPPOSED"
      ? "MULTI_HOUR_TREND_OPPOSED"
      : null,
    input.contractTrendStatus === "TRANSITION"
      ? "MULTI_HOUR_TREND_TRANSITION"
      : null,
    input.positionThesisOutlook === "DETERIORATING"
      ? "REMAINING_EXPECTANCY_DETERIORATING"
      : null,
    input.positionThesisOutlook === "INVALIDATED"
      ? "REMAINING_EXPECTANCY_INVALIDATED"
      : null,
    feeCoveredProfitFullyGivenBack
      ? "FEE_COVERED_PROFIT_FULLY_GIVEN_BACK"
      : null,
  ].filter((code): code is string => Boolean(code));
  const localAdverseEvidenceCount = adverseEvidenceCodes.filter((code) =>
    [
      "ENTRY_THESIS_WATCH",
      "ENTRY_THESIS_INVALIDATED",
      "LOCAL_STRUCTURE_BROKEN",
      "CLOSED_PATH_REVERSAL_PRESSURE",
      "REAL_VOLUME_OPPOSES_POSITION",
      "FEE_COVERED_PROFIT_FULLY_GIVEN_BACK",
    ].includes(code)
  ).length;
  const normalPullback =
    input.entryThesisStatus === "STABLE" &&
    ["NORMAL_RANGE", "UPSIDE_BREAKOUT"].includes(String(input.waveState)) &&
    input.trendPathStatus !== "REVERSAL_PRESSURE" &&
    input.tradeVolumeStatus !== "OPPOSITE_EXPANSION" &&
    ["ALIGNED", "PULLBACK", "RANGE"].includes(
      String(input.contractTrendStatus),
    );
  const priorReductionExecuted = input.priorReductionExecuted === true;
  const postReductionElapsedSeconds = Math.max(
    0,
    finite(input.postReductionElapsedSeconds),
  );
  const postReductionObservationEligible =
    priorReductionExecuted &&
    postReductionElapsedSeconds >= config.postReductionExitDelaySeconds;
  const common = {
    version: POSITION_EVIDENCE_RISK_VERSION,
    observedMinute,
    currentNetRoePercent: rounded(currentNet),
    bestGrossRoePercent: rounded(bestGross),
    bestNetRoePercent: rounded(bestNet),
    givebackFromPeakRoePoints: rounded(givebackFromPeak),
    feeCoveredProfitFullyGivenBack,
    minute3NetRoePercent: roundedOrNull(minute3Net),
    minute5NetRoePercent: roundedOrNull(minute5Net),
    estimatedRoundTripCostRoePercent: rounded(estimatedCost),
    adverseEvidenceCodes,
    localAdverseEvidenceCount,
    normalPullback,
    priorReductionExecuted,
    postReductionObservationEligible,
  };

  if (!config.enabled)
    return {
      ...common,
      stage: "DISABLED",
      action: "HOLD",
      reductionPercent: null,
      reason: "本策略未启用早期证据减险；既有止盈、止损和移动保护独立执行。",
    };

  if (input.clearInvalidation === true) {
    if (
      postReductionObservationEligible &&
      config.exitRemainingOnPersistentInvalidation
    )
      return {
        ...common,
        stage: "EVIDENCE_INVALIDATED_EXIT",
        action: "EXIT_FULL",
        reductionPercent: 100,
        reason:
          "本生命周期已经完成一次证据减险；当前实时结构、收回失败和真实逆向成交量再次共同确认失效，退出剩余仓位。",
      };
    if (priorReductionExecuted)
      return {
        ...common,
        stage: "REDUCED_RISK_MONITORING",
        action: "FREEZE_RISK",
        reductionPercent: null,
        reason: config.exitRemainingOnPersistentInvalidation
          ? `证据减险刚刚成交，继续等待至少 ${config.postReductionExitDelaySeconds} 秒后的新鲜实时事实；本轮不得把同一批旧事实升级为全平。`
          : "本生命周期已经完成一次证据减险；余仓只由盈利保护或最终硬止损管理，不因结构证据再次自动退出。",
      };
    return {
      ...common,
      stage: "PARTIAL_RISK_REDUCTION",
      action: "REDUCE_PARTIAL",
      reductionPercent: config.reductionPercent,
      reason:
        `当前实时结构、收回失败和真实逆向成交量共同确认恶化；先减仓 ${config.reductionPercent}% 降低风险，剩余仓位继续由后续实时事实和最终硬止损管理。`,
    };
  }

  const minute3Negative = minute3Net !== null && minute3Net < 0;
  const minute5Negative = minute5Net !== null && minute5Net < 0;
  const persistentEarlyLoss = minute3Negative &&
    (minute5Net === null ? currentNet < 0 : minute5Negative);
  const deteriorationReference = minute5Net ?? minute3Net;
  const deteriorationConfirmed =
    minute3Net !== null &&
    currentNet <= minute3Net - config.minimumDeteriorationRoePoints;
  const noMeaningfulReclaim =
    deteriorationReference !== null &&
    currentNet < 0 &&
    currentNet <=
      deteriorationReference + config.minimumDeteriorationRoePoints;
  const enoughAdverseEvidence =
    localAdverseEvidenceCount >= 1 && adverseEvidenceCodes.length >= 2;
  const exitStructureStillAdverse = adverseEvidenceCodes.some((code) =>
    [
      "ENTRY_THESIS_WATCH",
      "ENTRY_THESIS_INVALIDATED",
      "LOCAL_STRUCTURE_BROKEN",
      "CLOSED_PATH_REVERSAL_PRESSURE",
      "MULTI_HOUR_TREND_OPPOSED",
    ].includes(code)
  );

  if (
    observedMinute >= config.exitMinute &&
    persistentEarlyLoss &&
    noMeaningfulReclaim &&
    enoughAdverseEvidence &&
    exitStructureStillAdverse &&
    postReductionObservationEligible &&
    config.exitRemainingOnPersistentInvalidation &&
    !normalPullback
  )
    return {
      ...common,
      stage: "EVIDENCE_INVALIDATED_EXIT",
      action: "EXIT_FULL",
      reductionPercent: 100,
      reason:
        `第 ${config.exitMinute} 分钟后仍未收回早期费用后亏损，且局部结构/真实成交量与更长周期至少两项继续逆向；` +
        "原机会已不再具备等待价值，退出剩余仓位。",
    };

  if (feeCoveredProfitFullyGivenBack) {
    if (priorReductionExecuted)
      return {
        ...common,
        stage: "REDUCED_RISK_MONITORING",
        action: "FREEZE_RISK",
        reductionPercent: null,
        reason:
          "费用已覆盖的盈利峰值回吐后，本生命周期已经完成一次证据减险；继续保留余仓观察，不重复减仓、不补仓。",
      };
    return {
      ...common,
      stage: "PARTIAL_RISK_REDUCTION",
      action: "REDUCE_PARTIAL",
      reductionPercent: config.reductionPercent,
      reason:
        `仓位曾形成费用后正收益，但已从峰值回吐 ${givebackFromPeak.toFixed(2)} 个 ROE 点并转为费用后亏损；` +
        `闭合路径与真实短周期成交量均未继续确认原方向，先减仓 ${config.reductionPercent}% 降低风险，余仓仍由结构失效和硬止损管理。`,
    };
  }

  if (
    observedMinute >= config.reductionMinute &&
    persistentEarlyLoss &&
    deteriorationConfirmed &&
    enoughAdverseEvidence &&
    !normalPullback
  ) {
    if (priorReductionExecuted)
      return {
        ...common,
        stage: "REDUCED_RISK_MONITORING",
        action: "FREEZE_RISK",
        reductionPercent: null,
        reason:
          "早期证据减险已经真实成交；继续观察能否收回结构，不重复减仓、不补仓。",
      };
    return {
      ...common,
      stage: "PARTIAL_RISK_REDUCTION",
      action: "REDUCE_PARTIAL",
      reductionPercent: config.reductionPercent,
      reason:
        `第 ${config.reductionMinute} 分钟后费用后亏损继续扩大，并由局部结构/真实成交量和至少一项独立证据共同确认恶化；` +
        `先减仓 ${config.reductionPercent}% 降低风险，保留余仓等待波段重新证明。`,
    };
  }

  if (
    observedMinute >= config.warningMinute &&
    currentNet < 0 &&
    localAdverseEvidenceCount >= 1 &&
    !normalPullback
  )
    return {
      ...common,
      stage: "EVIDENCE_WARNING",
      action: "FREEZE_RISK",
      reductionPercent: null,
      reason:
        `第 ${config.warningMinute} 分钟后费用后收益仍为负且局部证据开始恶化；冻结补仓与盈利加仓，继续等到减险节点复核。`,
    };

  return {
    ...common,
    stage: "NORMAL_FLUCTUATION",
    action: "HOLD",
    reductionPercent: null,
    reason: normalPullback
      ? "多小时方向仍同向，入场结构稳定且没有真实逆向扩量；本轮属于正常波动，继续等待波段兑现。"
      : "尚未形成足以改变仓位的连续逆向证据；保持既有风险参数并继续观察。",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerOr(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function boundedOr(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(minimum, Math.min(maximum, numeric))
    : fallback;
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function roundedOrNull(value: number | null) {
  return value === null ? null : rounded(value);
}
