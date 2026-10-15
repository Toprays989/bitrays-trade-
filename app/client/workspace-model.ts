import type { PortfolioProfitFunnel } from "../../lib/portfolio-profit-funnel";

export type LivePosition = {
  id: number;
  sourceEventId: number;
  accountId: string;
  symbol: string;
  instrumentId?: string | null;
  instrumentRuleVersion?: number;
  positionVersion?: number;
  protectionVersion?: number;
  protectionState?: "ACTIVE" | "POST_ADD_REVALIDATION" | "ERROR";
  protectionUpdatedAt?: string | number | null;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  allocationEntryPrice?: number;
  exchangeEntryPrice?: number;
  markPrice: number;
  liquidationPrice?: number | null;
  liquidationPriceRaw?: number | null;
  liquidationPriceStatus?:
    | "AVAILABLE"
    | "EXCHANGE_NOT_PROVIDED"
    | "DIRECTION_INVALID"
    | "MARK_PRICE_INVALID"
    | "POSITION_NOT_FOUND"
    | "UNKNOWN";
  liquidationPriceObservedAt?: string | number | null;
  leverage: number;
  riskPlanJson: string;
  executedRiskPlanJson: string;
  marketMicrostructureJson?: string;
  openAccountingPolicy?: {
    estimatedRoundTripFeePercent: number;
    source: "FROZEN_STRATEGY_CONFIG" | "DEFAULT_ESTIMATE";
  };
  liveMarket?: {
    fundingRate: number | null;
    nextFundingTime: number | null;
    observedAt: string | number | null;
  };
  trailingActivationPercent: number;
  trailingStopPercent: number;
  favorablePrice?: number | null;
  status: "OPEN" | "CLOSED" | "EXECUTION_UNKNOWN" | "ERROR";
  pendingCloseClientOrderId?: string | null;
  exitReason?:
    | "STOP_LOSS"
    | "TAKE_PROFIT"
    | "TRAILING_STOP"
    | "MANUAL"
    | "EXTERNAL"
    | null;
  realizedPnl: number;
  lastError?: string | null;
  openedAt: string | number;
  closedAt?: string | number | null;
  updatedAt: string | number;
  executionRule?: {
    minOrderQty: number;
    quantityStep: number;
    minNotionalUsdt: number;
  } | null;
  additionSummary?: {
    count: number;
    latest: {
      status: string;
      entryPrice?: number | null;
      learning?: {
        verdict: "IMPROVED" | "WORSENED" | "INCONCLUSIVE";
        comparison: string;
      } | null;
    } | null;
  };
  learning?: {
    source: "MANUAL" | "SEMI_AUTO" | "STRATEGY";
    traceId: string;
    strategyId?: number | null;
    latestMinute: number;
    sampleCount: number;
    historicalSampleCount?: number;
    causalTimingVerified?: boolean;
    checkpoints?: Array<{
      minute: number;
      markPrice: number;
      roePercent?: number | null;
      status: string;
    }>;
    collection?: {
      state:
        | "PENDING"
        | "RETRY_WAIT"
        | "COLLECTING"
        | "COMPLETE"
        | "UNAVAILABLE";
      label: string;
      nextAction: string;
    };
    complete: boolean;
    latestRoePercent?: number | null;
    mfeRoePercent?: number | null;
    maeRoePercent?: number | null;
    verdict: "COLLECTING" | "FAVORABLE" | "ADVERSE" | "NEUTRAL";
    comparison: string;
    suggestion: string;
    entryEvidenceSummary: string;
    entryEvidence?: Record<string, unknown>;
    positionManagementDecision?: {
      state:
        | "PROFIT_CONTINUATION"
        | "PROFIT_HOLD_OBSERVE"
        | "PROFIT_PROTECT"
        | "LOSS_WAIT_BOTTOM"
        | "BOTTOM_REBOUND_CONFIRMED"
        | "EVIDENCE_DEGRADING"
        | "TREND_INVALIDATED"
        | "NEUTRAL";
      action:
        | "HOLD_FOR_EXTENSION"
        | "HOLD_AND_OBSERVE"
        | "TIGHTEN_PROFIT_PROTECTION"
        | "WAIT_NO_ADD"
        | "ADD_ELIGIBLE"
        | "SCALE_IN_ELIGIBLE"
        | "REDUCE_RISK_BY_EVIDENCE"
        | "EXIT_OR_REDUCE_BY_RISK_PLAN";
      label: string;
      reason: string;
      observedMinute?: number;
      opportunityId?: string;
      traceId?: string;
      observedAtMs?: number;
      validUntilMs?: number;
      opportunityExpired?: boolean;
      positionThesisOutlook?:
        | "IMPROVING"
        | "POSITIVE_STABLE"
        | "DETERIORATING"
        | "INVALIDATED"
        | "UNAVAILABLE";
      contractTrendProfile?: {
        status?:
          | "ALIGNED"
          | "PULLBACK"
          | "TRANSITION"
          | "OPPOSED"
          | "RANGE"
          | "UNAVAILABLE";
        baseHorizon?: "SCALP" | "INTRADAY" | "SWING" | "UNSPECIFIED";
        effectiveHorizon?:
          | "SCALP"
          | "INTRADAY"
          | "SWING"
          | "SWING_EXTENSION"
          | "UNSPECIFIED";
        swingExtensionEligible?: boolean;
        shortCycleExitAuthorized?: boolean;
        reason?: string;
      } | null;
      rotationPlan?: {
        primaryAction?: string;
        hedgeAction?: string;
        capitalAction?: string;
        label?: string;
        reason?: string;
      };
    } | null;
    positionManagementExecutionBinding?: {
      status:
        | "BOUND"
        | "WAITING_FOR_TRIGGER"
        | "DISABLED"
        | "OBSERVATION_ONLY"
        | "NO_ACTION_REQUIRED";
      executor:
        | "POSITION_ADDITION"
        | "TRAILING_STOP"
        | "DISCIPLINARY_MARKET_EXIT"
        | "CONFIGURED_RISK_PLAN"
        | "NONE";
      changesPositionImmediately: boolean;
      summary: string;
    } | null;
    positionAdditionExecution?: {
      opportunityId?: string;
      evaluatedAtMs?: number;
      executed: boolean;
      attempted: boolean;
      reason: string;
      label: string;
      currentRoePercent?: number | null;
      recoveryFromTroughRoePoints?: number | null;
      quantity?: number | null;
      entryPrice?: number | null;
      detail?: string | null;
    } | null;
    structureProtection?: {
      stage:
        | "UNAVAILABLE"
        | "STABLE"
        | "WARNING"
        | "CONFIRMED"
        | "SUBMITTED"
        | "RECONCILED";
      label: string;
      reason: string;
      consecutiveClosedMinutes: number;
      requiredClosedMinutes: number;
    };
  };
};
export type Market = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  high: number;
  low: number;
  volume: string | number;
  min: string;
};
export type LivePositionReduction = {
  id: number;
  positionId: number;
  accountId: string;
  clientOrderId: string;
  exchangeOrderId?: string | null;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  exitPrice: number;
  realizedPnl: number;
  accounting?: {
    pnl: number;
    grossRealizedPnl: number;
    netRealizedPnl: number | null;
    exactNetAvailable: boolean;
    tradeDetailsAvailable: boolean;
    feeAdjustedPnl: number | null;
    settlementStatus:
      | "EXACT_NET"
      | "TRADE_DETAILS_PENDING"
      | "FUNDING_SHARED"
      | "FUNDING_PENDING";
    commissionAsset: string | null;
    exitCommission: number | null;
    entryCommissionAllocated: number | null;
    fundingIncome: number | null;
    fundingAsset: string | null;
    fundingAttribution:
      | "NOT_REQUESTED_PARTIAL"
      | "SYSTEM_UNIQUE_POSITION"
      | "OVERLAPPING_POSITION"
      | "UNAVAILABLE"
      | null;
  };
  reason: "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP" | "MANUAL" | "EXTERNAL";
  createdAt: string | number;
};

export function liveReductionAccounting(item: LivePositionReduction) {
  return item.accounting ?? {
    pnl: item.realizedPnl,
    grossRealizedPnl: item.realizedPnl,
    netRealizedPnl: null,
    exactNetAvailable: false,
    tradeDetailsAvailable: false,
    feeAdjustedPnl: null,
    settlementStatus: "TRADE_DETAILS_PENDING" as const,
    commissionAsset: null,
    exitCommission: null,
    entryCommissionAllocated: null,
    fundingIncome: null,
    fundingAsset: null,
    fundingAttribution: null,
  };
}
export type LiveOrderEvent = {
  id: number;
  accountId: string;
  clientOrderId: string;
  exchangeOrderId?: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  orderType: "MARKET" | "LIMIT";
    quantity: number;
    executedQuantity?: number;
    remainingQuantity?: number;
    referencePrice: number;
  estimatedNotional: number;
  leverage?: number | null;
  initialMarginUsdt?: number | null;
  testOnly: boolean;
  status:
    | "PENDING"
    | "TEST_ACCEPTED"
    | "SUBMITTED"
    | "NEW"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "CANCEL_PENDING"
    | "CANCELED"
    | "EXPIRED"
    | "REJECTED"
    | "EXECUTION_UNKNOWN";
  expiresAt?: string | null;
  cancelReason?: string | null;
  canCancel?: boolean;
  purpose?: "ENTRY" | "ADDITION" | "REDUCTION" | "UNKNOWN";
  strategyId?: number | null;
  createdAt: string | number;
  updatedAt: string | number;
};
export type OverviewData = {
  accountScope: {
    mode: "ALL" | "SINGLE";
    accountId: string | null;
    name: string;
  };
  accountOptions: Array<{
    accountId: string;
    name: string;
    isActive: boolean;
    executionMode: "LIVE";
  }>;
  metrics: {
    hourOrders: number;
    hourOrderNotional: number;
    hourFilledOrders: number;
    hourFilledNotional: number;
    todayOrders: number;
    todayOrderNotional: number;
    todayNewPositions: number;
    todayClosedPositions: number;
    todayStrategyOrders: number;
    todayManualOrders: number;
    todayAutomaticReductions: number;
    todayAutomaticReductionPnl: number;
    todayProfitableRecords: number;
    todayLosingRecords: number;
    todayBreakevenRecords: number;
    todayRealizedPnl: number;
    monthRealizedPnl: number;
    accountBalance: number;
    accountAvailableBalance: number;
    accountBalanceComplete: boolean;
    accountBalanceAvailable: boolean;
    eligibleAccountCount: number;
    freshAccountCount: number;
    realizedPnl: number;
    unrealizedPnl: number;
    unrealizedPnlAvailable: boolean;
    positionEstimatedUnrealizedPnl: number;
    unrealizedPnlDifference: number | null;
    positionPricesComplete: boolean;
    notionalValue: number;
    marginUsed: number;
    marginIsEstimate: boolean;
    openPositions: number;
    closedPositions: number;
    partialReductions: number;
    realizedRecords: number;
    profitableRecords: number;
    losingRecords: number;
    breakevenRecords: number;
    closedTradeWins: number;
    closedTradeLosses: number;
    closedTradeBreakeven: number;
    totalOrders: number;
    pendingOrders: number;
    filledOrders: number;
    rejectedOrders: number;
    executionUnknownOrders: number;
    runningStrategies: number;
    totalStrategies: number;
    activeSymbols: number;
    todayFilledOrders: number;
    todayFilledNotional: number;
  };
  accountBalances: Array<{
    accountId: string;
    name: string;
    totalWalletBalance: number | null;
    totalUnrealizedProfit: number | null;
    totalMarginBalance: number | null;
    totalPositionInitialMargin: number | null;
    totalOpenOrderInitialMargin: number | null;
    availableBalance: number | null;
    syncedAt: string | null;
    status: "FRESH" | "STALE" | "ERROR";
    error: string | null;
  }>;
  orderHealth: {
    status: "HEALTHY" | "ATTENTION";
    workingCount: number;
    oldestWorkingAgeMs: number;
    terminalTraceWorkingCount: number;
    expiredIntentWorkingCount: number;
    executionUnknownCount: number;
    details: Array<{
      id: number;
      accountId: string;
      symbol: string;
      positionSide: "LONG" | "SHORT";
      status: string;
      clientOrderId: string;
      lifecycleId: string | null;
      traceState: string | null;
      intentStatus: string | null;
      ageMs: number;
      updatedAt: string;
    }>;
  };
  profitFunnel: PortfolioProfitFunnel;
  positions: LivePosition[];
  strategies: Array<{
    id: number;
    name: string;
    displayName?: string;
    brainTemplate?: string;
    strategyType: string;
    symbolScope: string;
    status: string;
    configVersion: number;
    accountId: string;
  }>;
  strategyFunnels: Array<{
    strategyId: number;
    name: string;
    displayName: string;
    status: string;
    directionMode: "FOLLOW_BRAIN" | "INVERSE_BRAIN";
    eyeConfirmed: number;
    confirmed: number;
    netExpectancyRejected: number;
    authorized: number;
    priceTooFar: number;
    expired: number;
    existingPosition: number;
    analysisExpired: number;
    directionConflict: number;
    marketDataWait: number;
    marketDataWaitBreakdown: {
      total: number;
      bookFreshness: number;
      analysisClockPaused: number;
      degradedContext: number;
      upstreamFetch: number;
    };
    capacityInsufficient: number;
    strategyRiskRejected: number;
    orders: number;
    orderAttempts: number;
    retryAttempts: number;
    filled: number;
    canceled: number;
    working: number;
    noOrder: number;
    conversionPercent: number;
    inverseLanes: {
      LONG_TO_SHORT: {
        confirmed: number;
        orders: number;
        filled: number;
      };
      SHORT_TO_LONG: {
        confirmed: number;
        orders: number;
        filled: number;
      };
    } | null;
    confirmationToOrderMedianMs: number | null;
    confirmationToOrderP90Ms: number | null;
    orderToTerminalP50Ms: number | null;
    orderToTerminalP90Ms: number | null;
    marketOrderToTerminalP50Ms: number | null;
    marketOrderToTerminalP90Ms: number | null;
    limitOrderToTerminalP50Ms: number | null;
    limitOrderToTerminalP90Ms: number | null;
    priceDeviationMedianBps: number | null;
    slowConfirmedOrders: number;
    unknownInverseDirectionOrders: number;
  }>;
  rateLimit: {
    usedWeight: number;
    projectUsedWeight: number;
    binanceObservedWeight: number;
    unattributedWeight: number;
    limitWeight: number;
    reservedTradingWeight: number;
    remainingWeight: number;
    observationUsedWeight: number;
    observationLimitWeight: number;
    observationRemainingWeight: number;
    globalIpLimitWeight: number;
    globalRemainingWeight: number;
    source: "BINANCE_PROXY" | "DATABASE_FALLBACK";
  } | null;
  traffic: {
    futuresData: {
      windowMs?: number;
      requestLimit?: number;
      upstreamRequests?: number;
      remainingRequests?: number;
    } | null;
    klineWeightAudit: {
      activeWindowMs?: number;
      evaluationWindowMs?: number;
      evaluationMinutes?: number;
      completeWindowObserved?: boolean;
      upstreamRequests?: number;
      estimatedWeight?: number;
      observationWeight?: number;
      observationLimit?: number;
      klineSharePercent?: number;
      observationUtilizationPercent?: number;
      totalWeightThreshold?: number;
      klineRequestThreshold?: number;
      continuousHighWeightMinutes?: number;
      continuousHighKlineMinutes?: number;
      recentRateLimitCount?: number;
      recent429Count?: number;
      recent418Count?: number;
      duplicateRequestGroupCount?: number;
      reviewReasons?: string[];
      status?: "WITHIN_BUDGET" | "REVIEW_REQUIRED";
      scheduleReviewRequired?: boolean;
      schedulerChangedAutomatically?: false;
      monitorOnly?: true;
      basis?: "UPSTREAM_ONLY_AFTER_SHARED_CACHE";
    } | null;
    liquidationNotionalDistribution: {
      windowMs?: number;
      eventCount?: number;
      uniqueSymbols?: number;
      p50Notional?: number | null;
      p75Notional?: number | null;
      p90Notional?: number | null;
      p95Notional?: number | null;
      threshold6000?: {
        eventCount?: number;
        eventShare?: number;
        notional?: number;
        notionalShare?: number;
      };
      marketWindow120s?: {
        windowMs?: number;
        thresholdNotionalUsdt?: number;
        sell?: {
          currentNotional?: number;
          currentEventCount?: number;
          currentUniqueSymbols?: number;
          peakNotional?: number;
          peakAt?: number | null;
          triggerCount?: number;
          latestTriggerAt?: number | null;
        };
        buy?: {
          currentNotional?: number;
          currentEventCount?: number;
          currentUniqueSymbols?: number;
          peakNotional?: number;
          peakAt?: number | null;
          triggerCount?: number;
          latestTriggerAt?: number | null;
        };
      };
    } | null;
    topInternalRequest: {
      method?: string;
      pathname?: string;
      internalRequests?: number;
    } | null;
    topUpstreamRequest: {
      method?: string;
      pathname?: string;
      upstreamRequests?: number;
    } | null;
  };
  systemStatus: {
    healthy: boolean;
    websocketHealthy: boolean;
    riskHeartbeatHealthy: boolean;
    balanceComplete: boolean;
    positionPricesComplete: boolean;
    checkedAt: string;
  };
  riskState: {
    tradingEnabled: boolean;
    circuitBreakerStatus: string;
    drawdownThreshold: number;
    reason?: string | null;
  } | null;
  events: Array<{
    id: number;
    action: string;
    resourceType: string;
    resourceId: string;
    createdAt: string | number;
  }>;
  marketStatus: {
    source: "BINANCE_WEBSOCKET_MARK_AND_TICKER";
    reachable: boolean;
    error: string | null;
    updatedAt: string;
  };
  markets: Market[];
};
export type NotificationItem = {
  id: number;
  action: string;
  resourceId: string;
  strategyId?: number;
  severity: "CRITICAL" | "WARNING" | "INFO";
  title: string;
  message: string;
  destination: string;
  createdAt: string | number;
};
export type GlobalSearchResult = {
  type: "PAGE" | "MARKET";
  id: string;
  label: string;
  description: string;
};
export type AccountRiskEvent = {
  id: number;
  action: string;
  resourceId: string;
  detail: Record<string, unknown>;
  createdAt: string | number;
};
export type TradeReadiness = {
  mode: "LIVE";
  liveReady: boolean;
  credentialState: "MISSING" | "UNVERIFIED" | "HEALTHY" | "FAILED" | "STALE";
  blockers: string[];
  lastCheckedAt?: string | number | null;
};
export type TradingAccount = {
  id: number;
  accountId: string;
  name: string;
  accountType: "MAIN" | "STRATEGY";
  executionMode: "LIVE";
  tradeReadiness: TradeReadiness;
  operatorName: string;
  note?: string | null;
  equityLimit: number;
  reservePercent: number;
  dailyLossLimitPercent: number;
  maxSymbolMarginPercent: number;
  maxOpenPositions: number;
  maxPendingOrders: number;
  riskLocked: boolean;
  riskLockReason?: string | null;
  riskLockedAt?: string | number | null;
  accountDrawdown?: {
    phase: "NORMAL" | "DEFENSIVE" | "HARD_STOP";
    peakEquityUsdt: number;
    currentEquityUsdt: number;
    drawdownPercent: number;
    operatorRearmRequired: boolean;
    triggeredAt?: string | number | null;
    lastActionAt?: string | number | null;
  } | null;
  maxLeverage: number;
  isActive: boolean;
  updatedAt: string | number;
  stats: {
    openPositions: number;
    notionalValue: number;
    pendingOrders: number;
    runningStrategies: number;
    marginUsed: number;
    reservedMargin: number;
    committedMargin: number;
    reserveAmount: number;
    usableEquity: number;
    availableMargin: number;
    utilizationPercent: number;
    topConcentrationSymbol: string | null;
    topConcentrationPercent: number;
    unrealizedPnl: number;
    realizedPnl: number;
    dailyRealizedPnl: number;
    dailyPnl: number;
    dailyLossLimitAmount: number;
    nextRiskResetAt: string | number;
    riskLevel: "NORMAL" | "WATCH" | "HIGH" | "LOCKED" | "DISABLED";
  };
};
export type ExchangeCredential = {
  id: number;
  accountId: string;
  label: string;
  apiKeyMask: string;
  secretConfigured: boolean;
  allowedSymbols: string[];
  maxOrderNotionalUsdt: number;
  maxDailyNotionalUsdt: number;
  maxLeverage: number;
  liveTradingEnabled: boolean;
  connectionStatus: "UNVERIFIED" | "VERIFIED" | "FAILED";
  lastVerifiedAt?: string | number | null;
  lastError?: string | null;
  totalWalletBalance?: number | null;
  totalUnrealizedProfit?: number | null;
  totalMarginBalance?: number | null;
  totalPositionInitialMargin?: number | null;
  totalOpenOrderInitialMargin?: number | null;
  availableBalance?: number | null;
  balanceSyncedAt?: string | number | null;
  positionMode?: "ONE_WAY" | "HEDGE" | null;
  updatedAt: string | number;
};
export function credentialVerifiedRecently(credential?: ExchangeCredential) {
  return Boolean(
    credential?.connectionStatus === "VERIFIED" &&
    credential.lastVerifiedAt &&
    !credential.lastError,
  );
}

export function liveRiskPlanSummary(value: string) {
  try {
    const plan = JSON.parse(value) as {
      takeProfits?: Array<{
        triggerPercent: number;
        closeQuantity?: number;
      }>;
      stopLosses?: Array<{
        triggerPercent: number;
        closeQuantity?: number;
      }>;
      minimumObservationMinutes?: number;
      liquidationGuardBufferPercent?: number;
      dynamicProfitProtectionEnabled?: boolean;
      capitalPreservationStopRoePercent?: number;
      notionalExitPolicy?: {
        version: 1;
        mode: "STAGED" | "SINGLE_FULL_EXIT";
        referencePrice: number | null;
        minNotionalUsdt: number | null;
        stagedThresholdUsdt: number | null;
        positionNotionalUsdt: number | null;
        plannedExitLegCount: number;
        reason:
          | "STAGED_EXIT_EXECUTABLE"
          | "MIN_NOTIONAL_UNSPLITTABLE"
          | "RULE_UNAVAILABLE";
      };
    };
    const capitalPreservationStopRoePercent = Number(
      plan.capitalPreservationStopRoePercent,
    );
    return {
      takeProfits: plan.takeProfits ?? [],
      stopLosses: plan.stopLosses ?? [],
      minimumObservationMinutes: plan.minimumObservationMinutes ?? 0,
      liquidationGuardBufferPercent:
        plan.liquidationGuardBufferPercent ?? 5,
      dynamicProfitProtectionEnabled:
        plan.dynamicProfitProtectionEnabled !== false,
      capitalPreservationStopRoePercent:
        Number.isFinite(capitalPreservationStopRoePercent) &&
          capitalPreservationStopRoePercent > 0
          ? capitalPreservationStopRoePercent
          : null,
      notionalExitPolicy: plan.notionalExitPolicy ?? null,
    };
  } catch {
    return {
      takeProfits: [],
      stopLosses: [],
      minimumObservationMinutes: 0,
      liquidationGuardBufferPercent: 5,
      dynamicProfitProtectionEnabled: true,
      capitalPreservationStopRoePercent: null,
      notionalExitPolicy: null,
    };
  }
}

export type LiveDynamicProfitReductionProgress = {
  anchorQuantity: number;
  executedQuantity: number;
  completedStages: number[];
  lastStageRoePercent: number | null;
  lastStageAtMs: number | null;
  softActivationRuleVersion: number | null;
  softActivatedAtMs: number | null;
  softActivationRoePercent: number | null;
};

export function liveProfitProtectionStageSummary(input: {
  enabled: boolean;
  currentQuantity: number;
  currentRoePercent: number;
  progress: LiveDynamicProfitReductionProgress | null;
}) {
  const progress = input.progress;
  const activatedAtMs = finiteNumber(progress?.softActivatedAtMs);
  const activationRoePercent =
    finiteNumber(progress?.softActivationRoePercent) ?? 6;
  const active =
    input.enabled &&
    progress?.softActivationRuleVersion === 1 &&
    activatedAtMs !== null;
  const lastStageAtMs = finiteNumber(progress?.lastStageAtMs);
  const completedStages = progress?.completedStages ?? [];
  // A position can contain dynamic-reduction stages from before the current
  // soft-activation rule was armed. Only a stage executed after that moment
  // belongs to the dynamic-reduction lifecycle shown to operations.
  const forwardStage =
    active &&
    lastStageAtMs !== null &&
    lastStageAtMs >= activatedAtMs
      ? Math.max(0, ...completedStages)
      : 0;
  const anchorQuantity = Math.max(
    0,
    finiteNumber(progress?.anchorQuantity) ?? 0,
  );
  const executedQuantity = Math.max(
    0,
    finiteNumber(progress?.executedQuantity) ?? 0,
  );
  const cumulativeRatio =
    anchorQuantity > 0
      ? Math.min(1, executedQuantity / anchorQuantity)
      : 0;
  const historicalProgressRetained =
    active && forwardStage === 0 && cumulativeRatio > 0;

  if (!input.enabled)
    return {
      state: "DISABLED" as const,
      label: "首档前动态减仓关闭",
      activatedAtMs: null,
      activationRoePercent,
      forwardStage: 0,
      anchorQuantity,
      executedQuantity,
      cumulativeRatio,
      historicalProgressRetained: false,
    };
  if (!active)
    return {
      state: "WAITING" as const,
      label: `等待 ${activationRoePercent.toFixed(0)}% 动态减仓`,
      activatedAtMs: null,
      activationRoePercent,
      forwardStage: 0,
      anchorQuantity,
      executedQuantity,
      cumulativeRatio,
      historicalProgressRetained: false,
    };
  if (forwardStage >= 3)
    return {
      state: "COMPLETED" as const,
      label: "尾仓保护已完成",
      activatedAtMs,
      activationRoePercent,
      forwardStage,
      anchorQuantity,
      executedQuantity,
      cumulativeRatio,
      historicalProgressRetained,
    };
  if (forwardStage >= 2)
    return {
      state: "TAIL_PROTECTED" as const,
      label: "累计减仓55% · 尾仓保护",
      activatedAtMs,
      activationRoePercent,
      forwardStage,
      anchorQuantity,
      executedQuantity,
      cumulativeRatio,
      historicalProgressRetained,
    };
  if (forwardStage >= 1)
    return {
      state: "REDUCED_25" as const,
      label: "已减仓25% · 观察下一阶段",
      activatedAtMs,
      activationRoePercent,
      forwardStage,
      anchorQuantity,
      executedQuantity,
      cumulativeRatio,
      historicalProgressRetained,
    };
  return {
    state: "ARMED" as const,
    label: `${activationRoePercent.toFixed(0)}% 动态减仓已激活`,
    activatedAtMs,
    activationRoePercent,
    forwardStage: 0,
    anchorQuantity,
    executedQuantity,
    cumulativeRatio,
    historicalProgressRetained,
  };
}

export function liveExecutedRiskPlanSummary(value: string) {
  try {
    const progress = JSON.parse(value) as {
      takeProfits?: unknown;
      stopLosses?: unknown;
      takeProfitQuantities?: unknown;
      dynamicProfitReduction?: unknown;
      tailWaveExit?: unknown;
    };
    const indexes = (input: unknown) =>
      Array.isArray(input)
        ? [...new Set(input.filter(
            (item): item is number =>
              Number.isInteger(item) && Number(item) >= 0,
          ))]
        : [];
    const quantities =
      progress.takeProfitQuantities &&
      typeof progress.takeProfitQuantities === "object" &&
      !Array.isArray(progress.takeProfitQuantities)
        ? Object.fromEntries(
            Object.entries(progress.takeProfitQuantities)
              .filter(([key, quantity]) =>
                /^\d+$/.test(key) &&
                Number.isFinite(Number(quantity)) &&
                Number(quantity) > 0
              )
              .map(([key, quantity]) => [key, Number(quantity)]),
          )
        : {};
    const dynamicValue =
      progress.dynamicProfitReduction &&
        typeof progress.dynamicProfitReduction === "object" &&
        !Array.isArray(progress.dynamicProfitReduction)
        ? progress.dynamicProfitReduction as Record<string, unknown>
        : null;
    const dynamicProfitReduction = dynamicValue
      ? {
          anchorQuantity: Math.max(
            0,
            finiteNumber(dynamicValue.anchorQuantity) ?? 0,
          ),
          executedQuantity: Math.max(
            0,
            finiteNumber(dynamicValue.executedQuantity) ?? 0,
          ),
          completedStages: indexes(dynamicValue.completedStages).filter(
            (stage) => stage >= 1 && stage <= 3,
          ),
          lastStageRoePercent: finiteNumber(
            dynamicValue.lastStageRoePercent,
          ),
          lastStageAtMs: finiteNumber(dynamicValue.lastStageAtMs),
          softActivationRuleVersion: finiteNumber(
            dynamicValue.softActivationRuleVersion,
          ),
          softActivatedAtMs: finiteNumber(dynamicValue.softActivatedAtMs),
          softActivationRoePercent: finiteNumber(
            dynamicValue.softActivationRoePercent,
          ),
        }
      : null;
    const tailWaveValue =
      progress.tailWaveExit &&
        typeof progress.tailWaveExit === "object" &&
        !Array.isArray(progress.tailWaveExit)
        ? progress.tailWaveExit as Record<string, unknown>
        : null;
    const tailWaveExit = tailWaveValue &&
        (tailWaveValue.phase === "OBSERVING" ||
          tailWaveValue.phase === "TRACKING_REBREAK")
      ? {
          phase: tailWaveValue.phase,
          startedAtMs: finiteNumber(tailWaveValue.startedAtMs),
          deadlineAtMs: finiteNumber(tailWaveValue.deadlineAtMs),
          rebreakAtMs: finiteNumber(tailWaveValue.rebreakAtMs),
          rebreakPeakRoePercent: finiteNumber(
            tailWaveValue.rebreakPeakRoePercent,
          ),
        }
      : null;
    return {
      takeProfits: indexes(progress.takeProfits),
      stopLosses: indexes(progress.stopLosses),
      takeProfitQuantities: quantities,
      dynamicProfitReduction,
      tailWaveExit,
    };
  } catch {
    return {
      takeProfits: [],
      stopLosses: [],
      takeProfitQuantities: {},
      dynamicProfitReduction: null,
      tailWaveExit: null,
    };
  }
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}


