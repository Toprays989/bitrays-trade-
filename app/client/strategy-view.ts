import {
  DEFAULT_LIQUIDATION_LARGE_TRADER_UI,
  liquidationDirection,
  strategyPluginId,
  strategyTriggerKind,
  type StrategyDirection,
} from "./strategy-config";
import type { StrategyLearningReviewSummary } from "../../lib/strategy-learning-review";
import type { LiquidationFactorLearningSummary } from "../../lib/liquidation-factor-learning";
import {
  applyStrategyDefaultParameters,
  normalizeStrategyTriggerScopedExecution,
  stampStrategyParameterProfile,
} from "../../lib/strategy-default-parameters";
import {
  normalizeStrategyAssetClassScope,
  type StrategyAssetClassScope,
} from "../../lib/strategy-asset-scope";
export type ConfiguredStrategy = {
  id: number;
  brainKey?: string;
  displayName?: string;
  accountId: string;
  name: string;
  brainTemplate?:
    | "LEGACY_LIQUIDATION"
    | "NEXUS_MARKET_BRAIN"
    | "TREND_BREAKOUT"
    | "SUPPORT_REVERSAL"
    | "DOWNTREND_CONTINUATION";
  runtimeMode?: "SHADOW" | "CONFIRM_REQUIRED" | "LIVE";
  strategyType: "LIQ_CHASE" | "SENTINEL" | "SIMPLE_REBOUND";
  symbolScope: string;
  configVersion: number;
  publishedVersion?: number;
  draftVersion?: number;
  hasUnpublishedDraft?: boolean;
  draft?: {
    name: string;
    accountId: string;
    symbolScope: string;
    config: Record<string, unknown>;
    version: number;
    updatedAt: string | number | null;
  } | null;
  status:
    | "DRAFT"
    | "READY"
    | "RUNNING"
    | "PAUSED"
    | "DRAINING"
    | "BLOCKED"
    | "ERROR"
    | "ARCHIVED";
  config: Record<string, unknown>;
  runtimeMargin?: {
    configuredMarginUsdt: number;
    unrealizedPnlUsdt: number;
    dynamicMarginUsdt: number;
    usedMarginUsdt: number;
    availableMarginUsdt: number;
    exhausted: boolean;
    enforced?: boolean;
    nextResetAt: string | number;
  } | null;
  learningReview?: StrategyLearningReviewSummary | null;
  liquidationFactorLearning?: LiquidationFactorLearningSummary | null;
  updatedAt: string | number;
};

export function liquidationFactorLearningPhaseLabel(
  phase: LiquidationFactorLearningSummary["phase"],
) {
  return phase === "SHADOW_READY"
    ? "学习达标，待进入LIVE"
    : phase === "LIVE_VALIDATING"
      ? "LIVE小样本验证中"
      : phase === "LIVE_PROMOTION_READY"
        ? "LIVE已达到稳定条件"
        : phase === "LIVE_ROLLBACK_REQUIRED"
          ? "LIVE恶化，正在回退"
          : phase === "LIVE_STABLE"
            ? "LIVE稳定运行"
            : phase === "RELEARNING"
              ? "已回退，重新学习"
              : "SHADOW积累中";
}

export function defaultLiquidationStrategyConfig(
  accountId = "bys-main",
  name = "",
  direction: StrategyDirection = "BOTH",
) {
  return applyStrategyDefaultParameters({
    probabilityPolicy: {
      mode: "STANDARD" as const,
      minimumNetExpectancyRoePercent: 0,
      priorWinProbabilityPercent: 55,
      priorEquivalentSamples: 4,
      minimumComparableSamples: 5,
      maximumComparableSamples: 120,
      maximumSampleAgeDays: 30,
      estimatedRoundTripFeePercent: 0.08,
      estimatedExitSlippageBps: 5,
    },
    marketProfile: {
      mode: "UNIFIED" as const,
      contractType: "PERPETUAL" as const,
      triggerPolicy: "LIQUIDATION_ONLY" as const,
      orderSizing: "EXCHANGE_MINIMUM" as const,
    },
    accountId,
    name,
    interval: "1m",
    lookback: 21,
    momentumThresholdPercent: 0.6,
    maxSymbols: 0,
    maxOrdersPerRun: 1,
    leverage: 10,
    stopLossPercent: 20,
    takeProfitPercent: 8,
    direction,
    assetClassScope: "CRYPTO_NATIVE" as StrategyAssetClassScope,
    selectedSymbols: [] as string[],
    shortTrend: {
      minimumLongLiquidationSharePercent: 65,
      minimumMarket60mDropPercent: 0.2,
    },
    trigger: {
      kind: "LIQUIDATION_WINDOW" as const,
      minLiquidationNotionalUsdt: 6000,
      minSingleLiquidationNotionalUsdt: 6000,
      minLiquidationPrice: 0,
      maxLiquidationPrice: 0,
      aggregationWindowMs: 1000,
      maxSignalDelayMs: 1500,
      analysisValiditySeconds: 900,
      cooldownMinutes: 10,
      maxConcurrentAnalyses: 0,
      minClusterEvents: 3,
      maxClusterSpanSeconds: 120,
      maxClusterEventGapSeconds: 30,
    },
    liquidationFactors: {
      mode: "SHADOW" as const,
      automaticModeSwitch: true,
      learningTargetEpisodes: 30,
      learningMinimumExactCycles: 8,
      minimumEvents: 3,
      minimumObservationSeconds: 3,
      minimumAmountUsdt: 6000,
      minimumVelocityUsdtPerSecond: 50,
      minimumLiquidationToOiPercent: 0,
      minimumDirectionalPriceImpactPercent: 0.05,
      minimumAccelerationRatio: 1.2,
      maximumDivergenceImpactRatio: 0.5,
      minimumVolumeRatio: 1.2,
      requiredScore: 60,
      weights: {
        amount: 10,
        velocity: 15,
        liquidationToOi: 10,
        priceImpact: 20,
        acceleration: 20,
        divergence: 25,
      },
    },
    marketPosition: {
      maxPosition72hPercent: 35,
    },
    trend: {
      volumeRatio3m: 1.2,
      atrPeriod5m: 14,
      maxEntryDistanceAtr: 1,
      maxPriorRangeAtr: 4,
      trend1hBreakHandling: "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM" as const,
      structure30mBreakHandling: "WAIT_FOR_POST_BREAK_LOCAL_5M_RECLAIM" as const,
    },
    largeTrader: { ...DEFAULT_LIQUIDATION_LARGE_TRADER_UI },
    execution: {
      directionMode: "FOLLOW_BRAIN" as const,
      orderType: "MARKET" as const,
      entryDistanceExecutionMode: "SHADOW" as const,
      limitOffsetPercent: 0,
      adaptiveMarketMaxDistanceAtr: 0.2,
      orderTtlSeconds: 180,
      allowSecondOrder: false,
      sameLegWorkingOrderPolicy: "BLOCK" as const,
      existingPositionPolicy: "BLOCK" as const,
      minimumOrderFloorMode: "REJECT" as const,
      explorationOrderTarget: 10,
      leverage: 10,
      quantitySizingMode: "EVIDENCE_1_TO_2" as const,
      minimumOrderQuantityMultiplier: 1,
      minimumPositionNotionalUsdt: 20,
      equityAllocationPercent: 12,
      targetOrderNotionalUsdt: 5.1,
      maxOrderNotionalUsdt: 10,
      maxDailyNotionalUsdt: 60,
    },
    risk: {
      maxMarginUsagePercent: 50,
      dailyLossLimitUsdt: 15,
      stopLossPercent: 20,
      minimumObservationMinutes: 60,
      liquidationGuardBufferPercent: 5,
      takeProfitSteps: [
        { profitPercent: 2, closePercent: 30 },
        { profitPercent: 8, closePercent: 30 },
        { profitPercent: 15, closePercent: 40 },
      ],
      atrStopBuffer: 1,
      dynamicTrailingEnabled: true,
      trailingActivationPercent: 2,
      trailingDrawdownPercent: 3,
      portfolioRisk: {
        perTradeRiskPercent: 1,
        strategyRiskBudgetPercent: 4,
        learningProbeRiskBudgetPercent: 3,
        maxPortfolioRiskPercent: 8,
        maxDirectionalRiskPercent: 6,
        maxCorrelationGroupRiskPercent: 4,
        drawdownCautionPercent: 3,
        drawdownReducedPercent: 6,
        drawdownHaltPercent: 10,
        cautionMultiplier: 0.5,
        reducedMultiplier: 0.25,
      },
      positionManagement: {
        profitGivebackRoePoints: 3,
        bottomRecoveryRoePoints: 2,
        tailWaveExitEnabled: true,
        tailWaveObservationMinutes: 15,
        tailWaveMaximumPositionPercent: 35,
        tailWavePeakGivebackAtr: 0.5,
        addOnEnabled: false,
        profitScaleInEnabled: false,
        addOnNotionalUsdt: 5.1,
        maxAddOnsPerPosition: 1,
        minMinutesBetweenAddOns: 30,
        maxAddOnLossRoePercent: 20,
        contrarianFallbackEnabled: false,
        contrarianProbeNotionalUsdt: 5.1,
        contrarianProfitRoeBeforeHedge: 3,
        evidenceRisk: {
          enabled: true,
          warningMinute: 3,
          reductionMinute: 5,
          exitMinute: 15,
          reductionPercent: 30,
          minimumDeteriorationRoePoints: 0.5,
          postReductionExitDelaySeconds: 15,
          exitRemainingOnPersistentInvalidation: false,
        },
      },
    },
    validation: {
      minSamplesForSuggestion: 30,
    },
  }, "LIQUIDATION_WINDOW");
}

export function strategyEditorConfig(strategy: ConfiguredStrategy) {
  const editableConfig = strategy.draft?.config ?? strategy.config;
  const editableAccountId = strategy.draft?.accountId ?? strategy.accountId;
  const editableName = strategy.draft?.name ?? strategy.name;
  const editableTriggerKind = strategyTriggerKind(editableConfig);
  const base = defaultLiquidationStrategyConfig(
    editableAccountId,
    editableName,
    liquidationDirection(editableConfig),
  );
  const execution = normalizeStrategyTriggerScopedExecution(
    editableConfig.execution,
    editableTriggerKind,
  );
  return stampStrategyParameterProfile(
    {
      ...base,
      ...editableConfig,
      execution,
      assetClassScope: normalizeStrategyAssetClassScope({
        value: editableConfig.assetClassScope,
        selectedSymbols: Array.isArray(editableConfig.selectedSymbols)
          ? editableConfig.selectedSymbols.filter(
              (symbol): symbol is string => typeof symbol === "string",
            )
          : [],
      }),
      name: editableName,
      accountId: editableAccountId,
    },
    editableTriggerKind,
  );
}

export function strategyTypeLabel(
  type: ConfiguredStrategy["strategyType"],
  config?: Record<string, unknown>,
) {
  if (type === "SENTINEL") return "NEXUS 哨兵 · 仅观察";
  if (type === "SIMPLE_REBOUND") return "Simple Rebound · 独立反弹";
  if (strategyPluginId(config) === "FIXED_CONTRACT_INTRADAY")
    return "NEXUS 大脑 · 固定合约日内";
  const probabilityPolicy = config?.probabilityPolicy;
  if (
    probabilityPolicy &&
    typeof probabilityPolicy === "object" &&
    !Array.isArray(probabilityPolicy) &&
    (probabilityPolicy as Record<string, unknown>).mode === "NET_EXPECTANCY"
  ) return "NEXUS 大脑 · 净期望概率";
  const marketProfile = config?.marketProfile;
  if (
    marketProfile &&
    typeof marketProfile === "object" &&
    !Array.isArray(marketProfile) &&
    (marketProfile as Record<string, unknown>).mode === "RELATIVE_STRENGTH"
  ) return "NEXUS 大脑 · 相对强弱趋势";
  if (
    marketProfile &&
    typeof marketProfile === "object" &&
    !Array.isArray(marketProfile) &&
    (marketProfile as Record<string, unknown>).mode === "TRADFI"
  ) return "NEXUS 大脑 · TradFi 独立实盘";
  const execution = config?.execution;
  if (
    execution &&
    typeof execution === "object" &&
    !Array.isArray(execution) &&
    (execution as Record<string, unknown>).directionMode === "INVERSE_BRAIN"
  ) return "NEXUS 大脑 · 反人性执行";
  const direction = liquidationDirection(config);
  if (direction === "SHORT_ONLY") return "NEXUS 大脑 · 做空";
  if (direction === "BOTH") return "NEXUS 大脑 · 双向";
  return "NEXUS 大脑 · 做多";
}

export function strategySymbolScopeSummary(rawScope: string) {
  const scope = typeof rawScope === "string" ? rawScope.trim() : "";
  if (!scope || scope.toUpperCase() === "POOL") return "系统合约池";

  const symbols = Array.from(
    new Set(
      scope
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (symbols.length === 0) return "系统合约池";
  if (symbols.length <= 3) return symbols.join("、");
  return `指定 ${symbols.length} 个合约 · ${symbols.slice(0, 3).join("、")}…`;
}
type HistoricalStrategyType =
  | ConfiguredStrategy["strategyType"]
  | "GRID"
  | "SHORT_CONTINUATION"
  | "SENTINEL"
  | "BREAKOUT";
export type StrategyConfigVersion = {
  id: number;
  strategyId: number;
  accountId: string;
  version: number;
  sourceVersion?: number | null;
  versionLabel?: string | null;
  note?: string | null;
  isBaseline: boolean;
  lifecycle?: "DRAFT" | "PUBLISHED" | "RETIRED";
  strategyType: HistoricalStrategyType;
  symbolScope: string;
  config: Record<string, unknown>;
  createdAt: string | number;
};
export type StrategyExecutionTrace = {
  id: number;
  traceId: string;
  strategyId: number;
  strategyRunId: string;
  configVersion: number;
  accountId: string;
  symbol: string;
  triggerKind?: "LIQUIDATION_WINDOW" | "LOW_POSITION_WINDOW" | string;
  triggerVersion?: string;
  triggerDirection?: "LONG" | "SHORT";
  triggerReferencePrice?: number;
  triggerFactSnapshotId?: string | null;
  triggerSourceId?: string | null;
  liquidationSide: "BUY" | "SELL";
  tradeDirection: "LONG" | "SHORT";
  liquidationPrice: number;
  liquidationNotional: number;
  eventTime: string | number;
  receivedAt: string | number;
  expiresAt: string | number;
  state: string;
  resultCode?: string | null;
  resultMessage?: string | null;
  exchangeOrderId?: string | null;
  positionId?: string | null;
  entryEvidence: Record<string, unknown>;
  configSnapshot: Record<string, unknown>;
  createdAt: string | number;
  updatedAt: string | number;
  completedAt?: string | number | null;
};

export function strategyExecutionDirectionLabel(
  execution: Pick<StrategyExecutionTrace, "tradeDirection" | "entryEvidence">,
) {
  const brain = execution.entryEvidence.brainDecisionDirection;
  const actual = execution.tradeDirection === "SHORT" ? "做空" : "做多";
  if (brain === "LONG" && execution.tradeDirection === "SHORT")
    return `大脑做多 → 实盘${actual}`;
  if (brain === "SHORT" && execution.tradeDirection === "LONG")
    return `大脑做空 → 实盘${actual}`;
  return actual;
}

export function strategyExecutionTriggerLabel(
  execution: Pick<
    StrategyExecutionTrace,
    "triggerKind" | "liquidationSide"
  >,
) {
  switch (execution.triggerKind) {
    case "LOW_POSITION_WINDOW":
      return "72小时低位";
    case "THREE_MINUTE_PROBABILITY":
      return "3分钟概率轮次";
    case "PRICE_VOLUME_STRUCTURE":
      return "量价结构";
    case "RELATIVE_STRENGTH_CONTINUATION":
      return "相对强弱延续";
    case "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE":
      return "爆仓或价格动量";
    case "HIGH_POSITION_PRICE_VOLUME_STRUCTURE":
      return "高位量价转弱";
    case "GRID_PRICE_LEVEL":
      return "网格价位";
    case "SCHEDULED_SCAN":
      return "定时扫描";
    case "BREAKOUT_RETEST":
      return "突破回踩";
    default:
      return execution.liquidationSide === "SELL"
        ? "多头爆仓"
        : "空头爆仓";
  }
}
export const STRATEGY_SESSION_LOG_LIMIT = 1_000;
export type StrategyMonitorStatus = {
  triggerKind?: string;
  triggerLabel?: string;
  source?: "CENTRALIZED_LIQUIDATION_FEED" | "UNIFIED_LOW_POSITION_TRIGGER" | string;
  triggerSide?: "BUY" | "SELL";
  feedEvents: number;
  candidateCount: number;
  freshCandidateCount: number;
  freshestCandidateAgeSeconds: number | null;
  activeAnalysisCount?: number;
  activeAnalyses?: Array<{
    traceId: string;
    symbol: string;
    state: string;
    resultCode?: string | null;
    resultMessage?: string | null;
    ageSeconds: number;
    expiresInSeconds?: number | null;
    updatedAgeSeconds: number;
  }>;
  reason: string;
  checkedAt: string | number;
  threshold?: {
    minSingleEventNotionalUsdt: number;
    minWindowNotionalUsdt: number;
    maxSpanSeconds: number;
    maxInterEventGapSeconds: number;
    maxSignalDelayMs: number;
  };
  lowPositionThreshold?: {
    maxPosition72hPercent: number;
    scanIntervalSeconds: number;
    maxWakeCandidatesPerCycle: number;
  };
  threeMinuteRound?: {
    roundId: string | null;
    roundEndsAt: string | null;
    countdownSeconds: number | null;
    symbol: string | null;
    direction: "LONG" | "SHORT" | null;
    pLongPercent: number | null;
    pShortPercent: number | null;
    netEdgeBps: number | null;
    breakEvenProbabilityPercent: number | null;
    dataQuality: string;
    state: string;
    resultCode: string | null;
    resultMessage: string | null;
  };
  threeMinutePosition?: {
    positionId: number;
    symbol: string;
    direction: "LONG" | "SHORT";
    status: string;
    openedAt: string;
    exitDueAt: string;
    remainingSeconds: number;
    realizedPnlUsdt: number;
  } | null;
  threeMinuteCheckpoints?: Array<{
    elapsedSeconds: number;
    status: "OPEN" | "CLOSED" | "MISSED" | "DATA_STALE";
    sampledAt: string | null;
    roePercent: number | null;
    mfeRoePercent: number | null;
    maeRoePercent: number | null;
    netPnlEstimate: number | null;
    counterfactual: boolean;
  }>;
  threeMinuteLearning?: {
    learnedRounds: number;
    wins: number;
    losses: number;
    exactNetSampleCount: number;
    exactNetPnlUsdt: number;
    recentExactBatchSampleCount: number;
    recentExactBatchPnlUsdt: number;
    calibrationRounds: number;
    calibrationRemaining: number;
    batchSize: number;
    mode: "CALIBRATING" | "OBSERVE_ONLY" | "MINIMUM_ORDER" | "ACTIVE";
    humanConfirmationRequired: boolean;
  };
  strongestSingle?: {
    symbol: string;
    notional: number;
    latestAgeSeconds: number;
  } | null;
  bestConfiguredWindow?: {
    symbol: string;
    notional: number;
    spanSeconds: number;
    latestAgeSeconds: number;
  } | null;
  best120SecondWindow?: {
    symbol: string;
    notional: number;
    spanSeconds: number;
    latestAgeSeconds: number;
  } | null;
  recentLiquidations?: Array<{
    sequence: number;
    symbol: string;
    side: "BUY" | "SELL";
    notional: number;
    averagePrice: number;
    eventCount: number;
    tradeTime: string | number;
    receivedAt: string | number;
    screeningState:
      | "ACCUMULATING"
      | "DIRECTION_SKIPPED"
      | "BRAIN_ACCEPTED"
      | "SIGNAL_EXPIRED";
    screeningReason: string;
  }>;
  suggestion?: { action: string; message: string } | null;
};
export type StrategyExecutionEvent = {
  id: number;
  traceId: string;
  sequence: number;
  eventType: string;
  stage: string;
  outcome: "PASSED" | "PENDING" | "REJECTED" | "INFO" | "ERROR";
  message: string;
  detail: Record<string, unknown>;
  eventAt: string | number;
};
export type StrategyPositionEvidence = {
  id: number;
  traceId: string;
  minuteOffset: number;
  scheduledAt: string | number;
  sampledAt?: string | number | null;
  status: "OPEN" | "CLOSED" | "MISSED" | "DATA_STALE";
  markPrice?: number | null;
  entryPrice: number;
  remainingQty: number;
  unrealizedPnl?: number | null;
  netPnlEstimate?: number | null;
  roePercent?: number | null;
  mfeRoePercent?: number | null;
  maeRoePercent?: number | null;
  volumeRatio3m?: number | null;
  atr5m?: number | null;
  sampleDelayMs?: number | null;
  causalLearningEligible?: boolean;
  learningUse?: "PARAMETER_LEARNING" | "HISTORICAL_ONLY";
  detail: Record<string, unknown>;
};
export function strategyPositionEvidenceStatusLabel(
  sample: StrategyPositionEvidence,
) {
  if (
    sample.status === "MISSED" &&
    typeof sample.detail.sampleType === "string" &&
    sample.detail.sampleType.includes("COUNTERFACTUAL")
  )
    return "反事实观察";
  if (sample.learningUse === "HISTORICAL_ONLY" && sample.status !== "MISSED")
    return sample.status === "DATA_STALE" ? "数据过期·仅复盘" : "历史参考·不参与学习";
  const labels: Record<StrategyPositionEvidence["status"], string> = {
    OPEN: "持仓观察",
    CLOSED: "已平仓",
    MISSED: "采样缺失",
    DATA_STALE: "数据过期",
  };
  return labels[sample.status];
}
export type StrategyPostEntrySuggestion = {
  parameterName: string;
  label: string;
  currentValue: unknown;
  suggestedValue: unknown;
  action: "KEEP" | "TIGHTEN" | "LOOSEN" | "OBSERVE";
  confidence: number;
  reason: string;
};
export type StrategyPostEntryAnalysis = {
  observationMode: "ACTUAL_POSITION" | "REJECTED_COUNTERFACTUAL";
  entryTriggerKind: string;
  sampleCount: number;
  causalEvidenceSampleCount: number;
  priceOnlySampleCount: number;
  incompleteCausalSampleCount: number;
  missingCausalDimensions: string[];
  causalAttributionReady: boolean;
  evidenceCompletenessSummary: string;
  latestMinute: number | null;
  latestRoePercent: number | null;
  bestRoePercent: number | null;
  worstRoePercent: number | null;
  positiveMinuteRatio: number | null;
  entrySlippagePercent: number | null;
  entryConfiguredOrderMode: "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE" | null;
  entrySelectedOrderType: "MARKET" | "LIMIT" | null;
  entryAdaptiveDistanceAtr: number | null;
  entryAdaptiveThresholdAtr: number | null;
  entryPosition24hPercent: number | null;
  entryPosition72hPercent: number | null;
  entryVolumeRatio3m: number | null;
  entryDistanceAtr: number | null;
  entryConsensusVerdict: "STRICT_CONSENSUS" | "RECOVERY_CONSENSUS" | "MIXED" | "CONFLICT" | "INCOMPLETE" | null;
  entryConsensusSupportCount: number | null;
  entryConsensusConflictCount: number | null;
  consensusRoe5mPercent: number | null;
  consensusRoe10mPercent: number | null;
  consensusRoe30mPercent: number | null;
  consensusRoe60mPercent: number | null;
  consensusContextSummary: string;
  entryLargeTraderStatus: "SUPPORTS_LONG" | "CONFLICTS_LONG" | "NEUTRAL" | "UNAVAILABLE" | null;
  entryLargeTraderConfirmationMode: "BROAD_LONG" | "CAPITAL_CONCENTRATION_LONG" | null;
  entryOpenInterestChangePercent: number | null;
  entryTopPositionRatioChangePercent: number | null;
  entryTopAccountRatioChangePercent: number | null;
  entryTakerBuySellRatio: number | null;
  entryLargeTraderEvidenceMode: "PRE_ENTRY" | "POST_FILL_BASELINE" | null;
  largeTraderContextSummary: string;
  entryLiquiditySweepStatus: "RECLAIMED" | "ACTIVE_CASCADE" | "UNCONFIRMED" | "DATA_STALE" | null;
  entrySweepDepthAtr: number | null;
  entryPriorRangeAtr: number | null;
  entryPriorRangeState: "COMPRESSED" | "BROAD" | "UNKNOWN" | null;
  liquiditySweepContextSummary: string;
  postBreakLocalRecoveryStatus: "QUALIFIED" | "REJECTED" | "INCOMPLETE" | null;
  postBreakLocalRecoveryOutcome: "TAKE_PROFIT_FIRST" | "STOP_LOSS_FIRST" | "AMBIGUOUS" | "NO_TRIGGER" | "NO_ENTRY" | null;
  postBreakLocalRecoveryEntryPrice: number | null;
  postBreakLocalRecoveryVolumeRatio3m: number | null;
  postBreakLocalRecoveryVolumeRatio5m: number | null;
  postBreakLocalRecoveryMfeRoePercent: number | null;
  postBreakLocalRecoveryMaeRoePercent: number | null;
  postBreakLocalRecoveryTakeProfitMinute: number | null;
  postBreakLocalRecoveryStopLossMinute: number | null;
  postBreakLocalRecoveryEstimatedGrossRoePercent: number | null;
  postBreakLocalRecoveryEstimatedObservedCloseGrossRoePercent: number | null;
  postBreakLocalRecoveryEstimatedExitMinute: number | null;
  postBreakLocalRecoveryEstimatedExitReason: "TAKE_PROFIT" | "TRAILING_STOP" | "STOP_LOSS" | "OPEN" | null;
  postBreakLocalRecoverySummary: string;
  entryLiquidationClusterCount: number | null;
  entryLiquidationEventCount: number | null;
  entryLiquidationClusterNotional: number | null;
  entryLiquidationClusterSpanMs: number | null;
  entrySymbolLiquidationSharePercent: number | null;
  entrySymbolContributionRank: number | null;
  liquidationClusterContextSummary: string;
  entryOpenPositionCount: number | null;
  entrySameMarketClusterOpenPositions: number | null;
  entryIndependentOpportunity: boolean | null;
  concurrentExposureSummary: string;
  finalRealizedPnl: number | null;
  finalPnlBasis: "NET_EXACT" | "GROSS_FALLBACK" | null;
  finalExitReason: string | null;
  finalOutcome: "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN" | "UNKNOWN";
  finalOutcomeSummary: string;
  entryMarketRegimeAtFill:
    | "FAVORABLE"
    | "NEUTRAL"
    | "ADVERSE"
    | "UNAVAILABLE"
    | null;
  entryMarketBaselineDelayMs: number | null;
  entryMarketRegimeChanged: boolean | null;
  entryMarketTransitionSummary: string;
  latestMarketRegime: "FAVORABLE" | "NEUTRAL" | "ADVERSE" | "UNAVAILABLE" | null;
  favorableMarketRatio: number | null;
  adverseMarketRatio: number | null;
  marketContextSummary: string;
  entryGlobalLiquidationTrend: string | null;
  latestGlobalLiquidationTrend: string | null;
  latestGlobalLiquidationSwing: string | null;
  globalLiquidationTrendChanged: boolean | null;
  globalLiquidationContextSummary: string;
  latestPostEntryLargeTraderStatus: "SUPPORT_CONTINUES" | "CAPITAL_WITHDRAWAL" | "MIXED" | "UNAVAILABLE" | "NOT_APPLICABLE" | "NOT_SCHEDULED" | null;
  postEntryLargeTraderSupportRatio: number | null;
  postEntryLargeTraderWithdrawalRatio: number | null;
  postEntryLargeTraderContextSummary: string;
  longHoldAnalysis: {
    status: "NOT_DUE" | "RECOVERED" | "PROFIT_EXTENDING" | "GIVEBACK" | "WEAKENING" | "HOLDING_RANGE";
    sampleCount: number;
    latestMinute: number | null;
    latestRoePercent: number | null;
    roe60mPercent: number | null;
    recoveryFrom60mRoePercent: number | null;
    bestPost60mRoePercent: number | null;
    summary: string;
  };
  capitalExitShadow: {
    status: "NO_SIGNAL" | "INCOMPLETE" | "PROTECTIVE" | "MISSED_RECOVERY" | "NEUTRAL";
    signalMinute: number | null;
    signalRoePercent: number | null;
    latestComparisonMinute: number | null;
    latestComparisonRoePercent: number | null;
    advantageVsLatestRoePercent: number | null;
    missedRecoveryRoePercent: number | null;
    summary: string;
  };
  positionManagementDecisionOutcome: {
    status:
      | "NO_SIGNAL"
      | "INCOMPLETE"
      | "SUPPORTED"
      | "CONTRADICTED"
      | "INCONCLUSIVE";
    signalAction: string | null;
    signalCausalEvidenceReady: boolean;
    signalMinute: number | null;
    comparisonMinute: number | null;
    comparisonRoePercent: number | null;
    bestRoeAfterSignal: number | null;
    worstRoeAfterSignal: number | null;
    summary: string;
  };
  waveThesisId: string | null;
  waveThesisStatus: "CONFIRMED" | "INCOMPLETE" | null;
  waveThesisOutcome: "INSUFFICIENT" | "FOLLOW_THROUGH" | "FAILED_STRUCTURE" | "CAPITAL_WITHDRAWAL" | "PROFIT_GIVEBACK" | "UNRESOLVED" | null;
  waveThesisSummary: string;
  waveDirectionVerdict: "VALIDATED_EARLY" | "VALIDATED_LATE" | "INVALIDATED" | "UNRESOLVED" | "INSUFFICIENT";
  waveEntryTimingVerdict: "TIMELY" | "TOO_EARLY" | "CHASED" | "NOT_APPLICABLE" | "UNRESOLVED";
  waveEntryAttributionSummary: string;
  deeperLimitCounterfactual: {
    status: "FILLED" | "NOT_FILLED" | "INSUFFICIENT";
    extraOffsetPercent: number;
    fillDeadlineMinute: number;
    candidateEntryPrice: number | null;
    fillMinute: number | null;
    evaluationMinute: number | null;
    actualRoePercent: number | null;
    candidateRoePercent: number | null;
    advantageRoePercent: number | null;
    summary: string;
  };
  deeperLimitCounterfactual30m: {
    status: "FILLED" | "NOT_FILLED" | "INSUFFICIENT";
    extraOffsetPercent: number;
    fillDeadlineMinute: number;
    candidateEntryPrice: number | null;
    fillMinute: number | null;
    evaluationMinute: number | null;
    actualRoePercent: number | null;
    candidateRoePercent: number | null;
    advantageRoePercent: number | null;
    summary: string;
  };
  deeperLimitCounterfactual60m: {
    status: "FILLED" | "NOT_FILLED" | "INSUFFICIENT";
    extraOffsetPercent: number;
    fillDeadlineMinute: number;
    candidateEntryPrice: number | null;
    fillMinute: number | null;
    evaluationMinute: number | null;
    actualRoePercent: number | null;
    candidateRoePercent: number | null;
    advantageRoePercent: number | null;
    summary: string;
  };
  delayedReclaimCounterfactual: {
    status: "ENTERED" | "NO_CONFIRMATION" | "NOT_APPLICABLE" | "INSUFFICIENT";
    adverseTriggerRoePercent: number;
    requiredRecoveryFraction: number;
    adverseMinute: number | null;
    confirmationMinute: number | null;
    candidateEntryPrice: number | null;
    evaluationMinute: number | null;
    actualRoePercent: number | null;
    candidateRoePercent: number | null;
    advantageRoePercent: number | null;
    summary: string;
  };
  delayedReclaimCounterfactual30m: {
    status: "ENTERED" | "NO_CONFIRMATION" | "NOT_APPLICABLE" | "INSUFFICIENT";
    adverseTriggerRoePercent: number;
    requiredRecoveryFraction: number;
    adverseMinute: number | null;
    confirmationMinute: number | null;
    candidateEntryPrice: number | null;
    evaluationMinute: number | null;
    actualRoePercent: number | null;
    candidateRoePercent: number | null;
    advantageRoePercent: number | null;
    summary: string;
  };
  delayedReclaimCounterfactual60m: {
    status: "ENTERED" | "NO_CONFIRMATION" | "NOT_APPLICABLE" | "INSUFFICIENT";
    adverseTriggerRoePercent: number;
    requiredRecoveryFraction: number;
    adverseMinute: number | null;
    confirmationMinute: number | null;
    candidateEntryPrice: number | null;
    evaluationMinute: number | null;
    actualRoePercent: number | null;
    candidateRoePercent: number | null;
    advantageRoePercent: number | null;
    summary: string;
  };
  sentinelShadowEntryValidation: {
    version: "nexus-sentinel-shadow-entry-validation-v1";
    status:
      | "NOT_APPLICABLE"
      | "COLLECTING"
      | "MISSED_ENTRY"
      | "FILTER_VALIDATED"
      | "MIXED_PATH"
      | "NO_EDGE";
    triggerKind: string;
    rejectionCode: string | null;
    observedHorizons: number[];
    missingHorizons: number[];
    latestObservedMinute: number | null;
    firstTakeProfitMinute: number | null;
    firstStopLossMinute: number | null;
    checkpointResults: Array<{
      minuteOffset: number;
      roePercent: number | null;
      mfeRoePercent: number | null;
      maeRoePercent: number | null;
    }>;
    summary: string;
    authority: "SHADOW_VALIDATION_ONLY";
    historicalLabelOnly: true;
    operatorReviewRequired: true;
    orderAffecting: false;
    liveConfigMutationAllowed: false;
  };
  quality: "INSUFFICIENT" | "GOOD" | "WEAK" | "LATE" | "GIVEBACK" | "MISSED_WIN" | "AVOIDED_LOSS" | "NO_TRIGGER" | "AMBIGUOUS";
  summary: string;
  suggestions: StrategyPostEntrySuggestion[];
};
export type StoredStrategyParameterSuggestion = {
  id: number;
  sampleCount: number;
  parameterName: string;
  currentValue: unknown;
  suggestedValue: unknown;
  evidence: {
    label?: string;
    action?: StrategyPostEntrySuggestion["action"];
    confidence?: number;
    reason?: string;
    proposalMode?: "DRAFT_ONLY";
    learningEligible?: boolean;
    sourceLearningKeys?: string[];
    sourceSampleKeys?: string[];
    automaticPublishAllowed?: false;
  };
};
export type StrategyExecutionDetail = {
  execution: StrategyExecutionTrace;
  events: StrategyExecutionEvent[];
  evidence: StrategyPositionEvidence[];
  postEntryAnalysis?: StrategyPostEntryAnalysis | null;
  configValidation?: {
    status: "NOT_APPLICABLE" | "COLLECTING" | "PROMOTION_READY" | "ROLLBACK_REQUIRED" | "PROMOTED" | "ROLLED_BACK";
    configVersion: number;
    sourceConfigVersion: number | null;
    targetCycles: number;
    completedCycles: number;
    exactNetPnlUsdt: number | null;
    wins: number;
    losses: number;
    outcome: "UNAVAILABLE" | "PENDING" | "POSITIVE" | "NEGATIVE" | "FLAT";
    suggestionIds: number[];
    sourceLearningSampleIds: string[];
    orderAffecting: boolean;
    automaticRollbackAllowed: true;
    automaticPromotionAllowed: false;
    automaticConfigMutationAllowed: boolean;
  };
  suggestions: StoredStrategyParameterSuggestion[];
};
export type StrategyLearningProgress = {
  configVersion: number;
  decisionEngineVersion: string | null;
  learningSchemaVersion: string;
  modelPhase:
    | "EXPLORATION_10"
    | "EXPLORATION_150"
    | "DAILY_REINFORCEMENT"
    | "EVIDENCE_COLLECTION"
    | "VALIDATION";
  explorationTargetOrders: number;
  learningTargetOrders: number;
  explorationTargetWinRatePercent: number;
  committedEntryOrders: number;
  dailyCommittedEntryOrders?: number;
  dailyReinforcementTargetOrders?: number;
  dailyReinforcementRemainingOrders?: number;
  completedExactNetOrders: number;
  remainingExplorationOrders: number;
  remainingExactNetOrders: number;
  orderFirstAllowed: boolean;
  parameterOptimizationReady: boolean;
  historicalPerformanceGateApplied: boolean;
  modelPhaseMessage: string;
  cohortPerformance?: {
    exactNetClosedOrders: number;
    exactNetWinningOrders: number;
    exactNetWinRatePercent: number | null;
    exactNetRealizedPnlUsdt: number;
    openPositions: number;
    openWinningPositions: number;
    openLosingPositions: number;
    openGrossPnlUsdt: number;
    accountingBasis:
      "EXACT_NET_CLOSED_PLUS_GROSS_UNREALIZED_OPEN_SEPARATE";
  };
  inverseDirectionEvaluation?: {
    version: 1;
    minimumSettledSamples: number;
    lanes: Record<
      "LONG_TO_SHORT" | "SHORT_TO_LONG",
      {
        lane: "LONG_TO_SHORT" | "SHORT_TO_LONG";
        totalPositions: number;
        settledSamples: number;
        wins: number;
        losses: number;
        winRatePercent: number | null;
        exactNetPnlUsdt: number;
        profitFactor: number | null;
        openPositions: number;
        openGrossPnlUsdt: number;
        reviewReady: boolean;
        remainingSettledSamples: number;
      }
    >;
    bothLanesReady: boolean;
    liveConfigMutationAllowed: false;
    automaticPublishAllowed: false;
    summary: string;
  } | null;
  completeSamples: number;
  actualSamples: number;
  causalActualSamples: number;
  incompleteCausalActualSamples: number;
  rejectedSamples: number;
  waveSymbolSelection: {
    minimumClusters: number;
    totalMultiSymbolClusters: number;
    entryComparableClusters: number;
    excludedIncompleteEntryEvidenceClusters: number;
    selectedPairs: Array<{
      clusterId: string;
      winnerSymbol: string | null;
      loserSymbol: string | null;
      winnerRoe60mPercent: number;
      loserRoe60mPercent: number;
      spreadRoePercent: number;
    }>;
    verdict: "WAIT_FOR_COMPARABLE_WAVES" | "OBSERVATION_READY";
    summary: string;
  };
  minimumSamples: number;
  postBreakShadowSamples: number;
  minimumPostBreakShadowSamples: number;
  remainingPostBreakShadowSamples: number;
  readyForPostBreakSuggestion: boolean;
  consensusShadowSamples: number;
  consensus30Samples: number;
  minimumConsensusSamples: number;
  remainingConsensus30Samples: number;
  readyForConsensusReview: boolean;
  remainingSamples: number;
  remainingActualSamples: number;
  remainingRejectedSamples: number;
  readyForActualSuggestion: boolean;
  readyForRejectedSuggestion: boolean;
  positionManagementValidation?: {
    sampleCount: number;
    supportedCount: number;
    contradictedCount: number;
    inconclusiveCount: number;
    contradictionRate: number;
    verdict:
      | "KEEP_OBSERVATION_ONLY"
      | "REVIEW_DECISION_THRESHOLDS";
    minimumSamples: number;
    causalSignals: number;
    pendingCount: number;
    incompleteEvidenceCount: number;
  };
  positionAdditionLearning?: {
    learningVersion: string;
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
    verdict:
      | "COLLECTING"
      | "KEEP_PARAMETERS"
      | "REVIEW_PARAMETERS"
      | "REVIEW_DISABLE";
    message: string;
  };
  nexusBrainLifecycle?: {
    version: "nexus-brain-lifecycle-v1";
    totalTraces: number;
    eyesComplete: number;
    decisionComplete: number;
    positionManagementObserved: number;
    learningEligible: number;
    stages: {
      eyesWaiting: number;
      brainReasoning: number;
      decisionFrozen: number;
      positionManaging: number;
      learningCollecting: number;
      learningReady: number;
    };
    topBlockers: Array<{
      code: string;
      traces: number;
    }>;
    orderAffecting: false;
    parameterAffecting: false;
  };
  nexusBrainShadowComparison?: {
    version: 2;
    feeAware: true;
    totalTraces: number;
    independentOpportunities: number;
    completeCausalSamples: number;
    independentCompleteCausalSamples: number;
    noiseFilteredTraces: number;
    noiseFilteredOpportunities: number;
    shadowComparableSamples: number;
    shadowSupportedSamples: number;
    shadowContradictedSamples: number;
    shadowInconclusiveSamples: number;
    shadowAccuracy: number | null;
    originalComparableSamples: number;
    originalSupportedSamples: number;
    originalContradictedSamples: number;
    originalAccuracy: number | null;
    disagreementSamples: number;
    shadowReadyOriginalSkipped: number;
    shadowInvalidOriginalEntered: number;
    minimumComparableSamples: number;
    reviewReady: boolean;
    reviewReadyDirections: Array<"LONG" | "SHORT">;
    statisticallySupportedDirections: Array<"LONG" | "SHORT">;
    reasonCounts: {
      checkpointsIncomplete: number;
      stopPathIncomplete: number;
      stopLossHit: number;
      netFavorable: number;
      netAdverse: number;
      mixedPath: number;
    };
    orderAffecting: false;
    parameterAffecting: false;
    byDirection: Record<
      "LONG" | "SHORT",
      {
        totalTraces: number;
        completeCausalSamples: number;
        comparableSamples: number;
        supportedSamples: number;
        contradictedSamples: number;
        accuracy: number | null;
        accuracyWilsonLower: number | null;
        minimumComparableSamples: number;
        reviewReady: boolean;
        statisticallySupported: boolean;
      }
    >;
    summary: string;
  };
  evidenceConfidenceDecayCapability: {
    version: "nexus-evidence-confidence-decay-v1";
    state:
      | "ACTIVE"
      | "PAUSED_WAITING"
      | "COLLECTING_CURRENT_VERSION"
      | "WAITING_CURRENT_VERSION";
    configVersion: number;
    sourceConfigVersion: number | null;
    sampleCount: number;
    latestStatus: string | null;
    latestSummary: string | null;
    updatedAt: number | null;
    message: string;
    orderAffecting: false;
    positionAffecting: false;
    liveConfigMutationAllowed: false;
  };
  learningObservability: {
    currentConfig: {
      version: number;
      terminalTraces: number;
      absorbedCycles: number;
      exactNetCycles: number;
      eligibleCycles: number;
      absorptionRatePercent: number | null;
      medianAbsorptionLatencyMs: number | null;
      pendingTerminalReceipts: number;
    };
    candidates: {
      currentPending: number;
      stalePending: number;
      expired: number;
      accepted: number;
      rejected: number;
      automaticConfigMutationAllowed: false;
    };
    triggerCoverage: Array<{
      triggerKind: string;
      triggerVersion: string;
      currentConfig: boolean;
      terminalTraces: number;
      absorbedCycles: number;
      exactNetCycles: number;
      eligibleCycles: number;
      absorptionRatePercent: number | null;
      medianAbsorptionLatencyMs: number | null;
      p90AbsorptionLatencyMs: number | null;
    }>;
  };
  isolationMessage: string;
};

export function nexusBrainLifecycleBlockerLabel(code: string) {
  const labels: Record<string, string> = {
    EYES_FACTS_MISSING: "眼睛事实缺失",
    BRAIN_DECISION_PENDING: "大脑尚未完成判断",
    CHECKPOINT_5M_MISSING: "缺少5分钟验证",
    CHECKPOINT_30M_MISSING: "缺少30分钟验证",
    CHECKPOINT_60M_MISSING: "缺少60分钟验证",
    STOP_PATH_MISSING: "缺少止损路径",
  };
  return labels[code] ?? "证据尚未完整";
}
export type StrategyMarketRegime = {
  status?: "FAVORABLE" | "NEUTRAL" | "ADVERSE" | "UNAVAILABLE";
  label?: string;
  btcChangePercent24h?: number | null;
  ethChangePercent24h?: number | null;
  positiveBreadthPercent?: number | null;
  reason?: string;
};
export function strategyMarketRegime(detail: Record<string, unknown>) {
  const value = detail.marketRegime;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as StrategyMarketRegime
    : null;
}
export type StrategyModelProgressEvidence = {
  phase?:
    | "EXPLORATION_10"
    | "EXPLORATION_150"
    | "DAILY_REINFORCEMENT"
    | "EVIDENCE_COLLECTION"
    | "VALIDATION";
  targetOrders?: number;
  learningTargetOrders?: number;
  committedEntryOrders?: number;
  dailyCommittedEntryOrders?: number;
  dailyReinforcementTargetOrders?: number;
  dailyReinforcementRemainingOrders?: number;
  completedExactNetOrders?: number;
  remainingExplorationOrders?: number;
  remainingExactNetOrders?: number;
  orderFirstAllowed?: boolean;
  parameterOptimizationReady?: boolean;
  historicalPerformanceGateApplied?: boolean;
  message?: string;
};
export function strategyExecutionModelProgress(execution: StrategyExecutionTrace) {
  const value = execution.entryEvidence.strategyModelProgress;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as StrategyModelProgressEvidence
    : null;
}
export function strategyExecutionBranch(execution: StrategyExecutionTrace) {
  const value = execution.entryEvidence.contrarianProbe;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "PRIMARY" as const;
  return (value as Record<string, unknown>).version === 2
    ? "CONTRARIAN_PROBE" as const
    : "PRIMARY" as const;
}
export type StrategyBreakdownObservation = {
  status?:
    | "STABLE"
    | "WATCH"
    | "BREAKDOWN_PRESSURE"
    | "UNAVAILABLE"
    | "NOT_APPLICABLE";
  label?: string;
  reason?: string;
  consecutiveClosedMinutesBelowBoundary?: number;
  sellLiquidationNotional?: number;
};
export function strategyBreakdownObservation(detail: Record<string, unknown>) {
  const value = detail.breakdownObservation;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as StrategyBreakdownObservation
    : null;
}
export type StrategyWaveStructure = {
  state?: "NORMAL_RANGE" | "UPSIDE_BREAKOUT" | "SUPPORT_BREAK" | "UNAVAILABLE";
  supportIntact?: boolean | null;
  priorHighBroken?: boolean | null;
  summary?: string;
};
export function strategyWaveStructure(detail: Record<string, unknown>) {
  const value = detail.waveStructure;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as StrategyWaveStructure
    : null;
}
export function strategyExecutionEventDetailSummary(event: StrategyExecutionEvent) {
  const detail = event.detail;
  const lifecycleValue = detail.contrarianProbeLifecycle;
  const lifecycle =
    lifecycleValue &&
      typeof lifecycleValue === "object" &&
      !Array.isArray(lifecycleValue)
      ? lifecycleValue as Record<string, unknown>
      : null;
  const analysisValue = detail.entryAnalysis;
  const analysis =
    analysisValue && typeof analysisValue === "object" && !Array.isArray(analysisValue)
      ? analysisValue as Record<string, unknown>
      : null;
  const formatPrice = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? number.toLocaleString("en-US", { maximumFractionDigits: 8 })
      : "—";
  };
  if (analysis) {
    const selectedOrderType =
      analysis.selectedOrderType === "MARKET"
        ? "市价"
        : analysis.selectedOrderType === "LIMIT"
          ? "限价"
          : "委托";
    const reason =
      typeof analysis.selectionReason === "string"
        ? ` · ${analysis.selectionReason}`
        : "";
    return `${selectedOrderType} · 分析价 ${formatPrice(analysis.analyzedEntryPrice)} · 确认位 ${formatPrice(analysis.confirmationLevel)} · 局部支撑 ${formatPrice(analysis.priorSupport)} · 插针低点 ${formatPrice(analysis.sweepLow)} · 有效下界 ${formatPrice(analysis.structuralFloor)}${reason}`;
  }
  if (lifecycle?.isContrarianProbe === true) {
    return [
      String(lifecycle.label ?? "反向探针"),
      String(lifecycle.reason ?? "等待持仓验证"),
      "禁止摊平与自动对冲",
    ].join(" · ");
  }
  if (event.eventType.startsWith("ANALYZED_LIMIT_"))
    return `限价 ${formatPrice(detail.limitPrice)} · 原因 ${String(detail.reason ?? event.eventType)}`;
  if (event.eventType.startsWith("NEXUS_BTC_RELATIONSHIP:")) {
    const correlation = formatFiniteRatio(detail.slowCorrelation);
    const beta = formatFiniteRatio(detail.beta);
    const relativeVolume = formatFiniteRatio(detail.relativeVolume);
    return `相关 ${correlation} · Beta ${beta} · 相对成交量 ${relativeVolume}`;
  }
  if (event.eventType.startsWith("NEXUS_TREND_REGIME:"))
    return (
      `EMA${String(detail.fastPeriod ?? 9)} ${formatPrice(detail.fastEma)} · ` +
      `EMA${String(detail.slowPeriod ?? 21)} ${formatPrice(detail.slowEma)} · ` +
      `ATR ${formatPrice(detail.atr)}`
    );
  if (event.eventType.startsWith("NEXUS_MARKET_EYE:")) {
    const evidenceValue = detail.evidence;
    const evidence =
      evidenceValue &&
        typeof evidenceValue === "object" &&
        !Array.isArray(evidenceValue)
        ? evidenceValue as Record<string, unknown>
        : {};
    const paths = Array.isArray(evidence.paths)
      ? evidence.paths
        .map((path) => {
          if (!path || typeof path !== "object" || Array.isArray(path))
            return null;
          const record = path as Record<string, unknown>;
          return `${String(record.machine ?? "—")}:${String(record.state ?? "—")}`;
        })
        .filter(Boolean)
        .join(" / ") || "—"
      : "—";
    return (
      `自身1/2/3h ${String(evidence.ownMacroRegime ?? "—")} · ` +
      `入场3/5m ${String(evidence.ownEntryRegime ?? "—")} · ` +
      `BTC背景 ${String(evidence.btcMacroRegime ?? "—")} · ` +
      `联动 ${String(evidence.btcRelationship ?? "—")} · ` +
      `3m量 ${formatFiniteRatio(evidence.relativeVolume)}× · ` +
      `15m量 ${formatFiniteRatio(evidence.contextRelativeVolume)}× · ` +
      `门槛 ${formatFiniteRatio(evidence.requiredRelativeVolume)}× · ` +
      `路径 ${paths}`
    );
  }
  if (event.eventType === "POSITION_PROFIT_PROTECTION_ARMED")
    return (
      `仓位 #${String(detail.positionId ?? "—")} · ` +
      `触发 ${formatFiniteRatio(detail.activationRoePercent)}% ROE · ` +
      `观察 ${formatFiniteRatio(detail.currentRoePercent)}% ROE · ` +
      `规则 v${String(detail.softActivationRuleVersion ?? "—")}`
    );
  if (event.eventType.startsWith("POSITION_PROFIT_PROTECTION_STAGE_")) {
    const dynamicValue = detail.dynamicProfitReduction;
    const dynamic =
      dynamicValue &&
        typeof dynamicValue === "object" &&
        !Array.isArray(dynamicValue)
        ? dynamicValue as Record<string, unknown>
        : {};
    return (
      `仓位 #${String(detail.positionId ?? "—")} · ` +
      `阶段 ${String(detail.profitProtectionStage ?? "—")} · ` +
      `累计目标 ${(Number(dynamic.targetCumulativeRatio ?? 0) * 100).toFixed(0)}% · ` +
      `峰值回撤 ${formatFiniteRatio(dynamic.givebackRoePoints)} ROE点`
    );
  }
  return null;
}

function formatFiniteRatio(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "—";
}
export function strategyExecutionStateLabel(state: string) {
  const labels: Record<string, string> = {
    TRIGGERED: "已触发",
    ANALYZING: "分析中",
    ARMED: "等待入场",
    ORDER_READY: "订单就绪",
    ORDER_PENDING: "下单中",
    POSITION_OPEN: "已开仓",
    TRAILING_ARMED: "移动止损待启用",
    TRAILING_ACTIVE: "移动止损运行中",
    EXIT_PENDING: "平仓中",
    MONITOR_READY: "持仓验证中",
    CLOSED: "已结束",
    EXPIRED: "已过期",
    REJECTED: "已拒绝",
    CANCELED: "已取消",
    DATA_STALE: "数据过期",
    EXECUTION_UNKNOWN: "交易所状态待核对",
  };
  return labels[state] ?? state;
}

export function formatStrategySuggestionValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).displayValue === "string"
  ) return String((value as Record<string, unknown>).displayValue);
  try { return JSON.stringify(value); }
  catch { return String(value); }
}
export function formatSignedPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatPercentRatio(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(1)}%`;
}
export function globalLiquidationTrendLabel(value: string | null) {
  const labels: Record<string, string> = {
    UPTREND_SHORT_SQUEEZE: "中长周期上行挤空",
    DOWNTREND_LONG_FLUSH: "中长周期下行杀多",
    TRANSITION_OR_RANGE: "中长周期转换/震荡",
    UPSIDE_WAVE: "短周期上行波段",
    DOWNSIDE_WAVE: "短周期下行波段",
    REVERSAL_OR_DIVERGENCE: "短周期方向分歧",
    UNAVAILABLE: "数据不可用",
  };
  return value ? labels[value] ?? value : "—";
}
export function strategyExecutionStageLabel(stage: string) {
  const labels: Record<string, string> = {
    SIGNAL: "爆仓触发",
    POSITION: "72 小时位置",
    TREND_1H: "1 小时趋势",
    STRUCTURE_30M: "30 分钟结构",
    RECLAIM_5M: "5 分钟确认",
    ENTRY_3M: "3 分钟入场",
    ORDER: "交易所下单",
    POSITION_MANAGEMENT: "持仓验证",
  };
  return labels[stage] ?? stage;
}

