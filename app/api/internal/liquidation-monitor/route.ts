import { env } from "cloudflare:workers";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  notLike,
  or,
} from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  contractSymbols,
  exchangeCredentials,
  liveOrderEvents,
  livePositions,
  strategies,
  strategyExecutionEvents,
  strategyExecutionTraces,
  tradingAccounts,
} from "../../../../db/schema";
import {
  BinanceLiveError,
  type BinanceLiquidationAggregate,
  getBinanceLiveAccountBalance,
  getBinanceLargeTraderPositioningSnapshot,
  getBinanceLiveContractUniverse,
  getBinanceLiveLiquidationEvents,
  getBinanceLiveMarkPrices,
  getBinanceLiveSystemMetrics,
  getLivePositionSnapshots,
  warmNexusBookTicker,
  waitForFreshNexusBookTicker,
} from "../../../../lib/binance-usdm-live";
import { submitLiveEntryOrder } from
  "../../../../lib/execution/exchange-order-gateway";
import { nexusUnifiedMarketData } from "../../../../lib/nexus-unified-market-data-live";
import {
  classifyNexusMarketRegimeFromCandles,
  nexusMarketRegimeLabel,
} from "../../../../lib/nexus-market-regime";
import {
  calculateNexusClosedEntryRelativeVolume,
  decideNexusMarketEye,
} from "../../../../lib/nexus-market-eye-decision";
import {
  analyzeNexusVolumeTimingConcordance,
  buildNexusPreTriggerVolumeReference,
} from "../../../../lib/nexus-volume-timing-concordance";
import { analyzeNexusTemporalShadow } from "../../../../lib/nexus-temporal-shadow";
import {
  adverseFundingCostRate,
  analyzeNexusFundingContext,
} from "../../../../lib/nexus-funding-context";
import {
  analyzeNexusMultiHourContext,
  nexusMultiHourContextSummary,
} from "../../../../lib/nexus-multi-hour-context";
import {
  analyzeNexusDailyMarketActivity,
  nexusDailyMarketActivitySummary,
} from "../../../../lib/nexus-daily-market-activity";
import {
  analyzeNexusLiquidationPriceImpulse,
  liquidationPriceImpulseMarketFact,
  nexusLiquidationContextSummary,
} from "../../../../lib/nexus-price-impulse";
import {
  credentialContext,
  decryptCredential,
  liveTradingAllowedByServer,
} from "../../../../lib/credential-vault";
import { reconcileUnknownAccountOrdersBeforeEntry } from "../../../../lib/unknown-live-order-account-reconciliation";
import {
  filledPendingOrderResponse,
  pendingOrderReservedMargin,
} from "../../../../lib/live-order-reserved-margin";
import { observeExecutionQuote } from "../../../../lib/execution-quote-shadow-store";
import { buildEntryDecisionHandoff } from "../../../../lib/trade-lifecycle-contract";
import { evaluateAutomatedEntryContractLeverage } from "../../../../lib/automated-entry-leverage-policy";
import {
  buildAutomatedEntryDirectionEvidence,
  evaluateAutomatedEntryRestCapacity,
} from "../../../../lib/execution/automated-entry-context";
import { resolveEvidenceQuantityMultiplier } from
  "../../../../lib/execution/evidence-quantity-sizing";
import {
  buildAutomatedEntryClientOrderId,
  readAutomatedEntryAcknowledgement,
} from "../../../../lib/execution/automated-entry-order";
import {
  createAutomatedEntryOrder,
  persistFilledAutomatedPosition,
} from "../../../../lib/execution/automated-entry-ledger";
import {
  buildFilledExecutionIntentDetail,
  resolveFilledPositionLifecycleLink,
} from "../../../../lib/execution/filled-entry-handoff";
import {
  buildFilledPositionProtection,
} from "../../../../lib/execution/filled-position-protection";
import {
  buildFilledPositionInsertValues,
  buildFilledPositionRecoveryValues,
} from "../../../../lib/execution/filled-position-persistence";
import {
  settleRejectedAutomatedEntry,
} from "../../../../lib/execution/rejected-entry-settlement";
import {
  buildEntryExecutionShadow,
  effectiveEntryOrderMode,
  entryDistanceExecutionMode,
} from "../../../../lib/entry-execution-shadow";
import {
  buildPilotRiskPlan,
  capRiskSizedEntryToConfiguredMargin,
  configuredEntryOrder,
  configuredShortEntryOrder,
  LIQUIDATION_PILOT_LIMITS,
  smallestPilotQuantity,
} from "../../../../lib/liquidation-live-execution";
import { analyzeMarkPricePosition } from "../../../../lib/nexus-market-position-observation";
import {
  effectiveStrategyEntryOrderTtlMs,
  type LiquidationTrendConfig,
  resolveLiquidationTrendConfig,
} from "../../../../lib/liquidation-trend-config";
import { filterContractsByStrategyAssetScope } from
  "../../../../lib/strategy-asset-scope";
import { resolveNexusTradingArchitecture } from "../../../../lib/nexus-trading-architecture";
import { nexusConfigValidationEntryBlock } from "../../../../lib/nexus-config-validation-runtime";
import {
  evaluateNexusNetExpectancy,
  nexusProbabilityExplorationAllowed,
  resolveNexusProbabilityEntryExecution,
} from "../../../../lib/nexus-net-expectancy";
import { loadNexusProbabilityContext } from "../../../../lib/nexus-net-expectancy-store";
import { nexusProbabilityContextFromEvidence } from
  "../../../../lib/nexus-probability-context";
import { resolveStrategyEntryTimingProfile } from "../../../../lib/strategy-entry-timing";
import { DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG } from "../../../../lib/strategy-triggers/three-minute-probability-config";
import { threeMinuteRoundFailureDiagnostic } from
  "../../../../lib/strategy-monitor-diagnostics";
import { isPrimaryLiquidityMarket } from "../../../../lib/market-liquidity-priority";
import {
  resolveStrategyExecutionDirection,
  roeStopInvalidationPrice,
} from "../../../../lib/strategy-execution-direction";
import { buildInverseExecutionObservation } from "../../../../lib/inverse-strategy-observability";
import {
  buildFrozenExecutionWindow,
  frozenExecutionExpiryReason,
  isFrozenExecutionApproval,
  MAX_FROZEN_EXECUTION_VALIDITY_MS,
  renewFrozenExecutionDecision,
  resolveFrozenExecutionDeadline,
  resolveFrozenExecutionIntentExpiry,
} from "../../../../lib/nexus-frozen-execution-window.mjs";
import { loadBoundLiquidationTrendConfig } from "../../../../lib/bound-liquidation-config";
import { getTradeReadiness } from "../../../../lib/trade-readiness";
import {
  accountFundingSnapshot,
  automatedEntryEquitySizingCapitalUsdt,
} from "../../../../lib/account-funding-snapshot";
import { chinaTradingDayWindow } from "../../../../lib/trading-calendar";
import {
  decisionEngineVersionFromEvidence,
  LIQUIDATION_DECISION_ENGINE_VERSION,
  retiredNexusExecutionVersionBlock,
} from "../../../../lib/liquidation-decision-engine";
import { liquidationSignalTiming } from "../../../../lib/liquidation-signal-freshness";
import {
  liquidationDerivedFactorMarketFact,
  liquidationMarketFact,
  marketStructureWakeFact,
  markPriceMarketFact,
  mergeFrozenNexusMarketFacts,
  trendRegimeMarketFact,
} from "../../../../lib/nexus-market-facts";
import { NexusMarketFactCycle } from "../../../../lib/nexus-market-fact-cycle";
import {
  restoreStrategyTriggerFacts,
  strategyWakeEvidenceFacts,
} from "../../../../lib/strategy-trigger-evidence-facts";
import { nexusMarketFactBuffer } from "../../../../lib/nexus-market-fact-buffer";
import { assessNexusDecisionSnapshot } from "../../../../lib/nexus-decision-snapshot";
import {
  buildNexusMarketContextSnapshot,
  nexusFactSnapshotId,
} from "../../../../lib/nexus-market-context-snapshot";
import { decideNexusAnalysisContinuity } from "../../../../lib/nexus-analysis-continuity";
import { deriveNexusBrainShadowState } from "../../../../lib/nexus-brain-shadow-state";
import {
  nexusLifecycleTriggerExpiry,
  nexusPureStateMachineMessage,
  replayNexusPureStateMachine,
} from "../../../../lib/nexus-brain-state-machines";
import {
  advanceNexusExecutionIntent,
  releaseUnboundNexusExecutionIntentForTrace,
  reserveNexusExplorationExecutionIntent,
  reserveNexusExecutionIntent,
  settleNexusExecutionIntentWithLiveOrder,
  synchronizeReservedNexusOrder,
} from "../../../../lib/nexus-execution-intent-store";
import {
  recoverAcknowledgedAutomatedEntry,
} from "../../../../lib/execution/acknowledged-entry-recovery-settlement";
import { recordUncertainAutomatedEntry } from
  "../../../../lib/execution/uncertain-entry-settlement";
import { reconcileManualPendingEntryOrders as reconcileManualPendingEntries } from
  "../../../../lib/execution/manual-pending-entry-reconciliation";
import { reconcileStrategyPendingEntryOrders as reconcileStrategyPendingEntries } from
  "../../../../lib/execution/strategy-pending-entry-reconciliation";
import {
  calculateNexusPortfolioRiskPlan,
  nexusAutomatedStrategyExposures,
  nexusBoundStrategyId,
  nexusPositionRiskExposure,
} from "../../../../lib/nexus-portfolio-risk";
import {
  readNexusReservedRiskExposures,
  updateNexusPortfolioEquityPeak,
} from "../../../../lib/nexus-portfolio-risk-store";
import { revalidateNexusConfirmedLongEntry } from "../../../../lib/liquidation-entry-revalidation";
import { analyzeLargeTraderLongPositioning } from "../../../../lib/large-trader-positioning";
import {
  analyzePostEntryMarketRegime,
  unavailablePostEntryMarketRegime,
} from "../../../../lib/post-entry-market-regime";
import { analyzeNexusBtcRelationship } from "../../../../lib/nexus-btc-relationship";
import {
  buildPostFillObservationBaseline,
} from "../../../../lib/strategy-entry-observation-baseline";
import { summarizeLiquidationSignalCluster } from "../../../../lib/liquidation-signal-cluster";
import { nexusLiquidationOpportunity } from "../../../../lib/nexus-liquidation-opportunity";
import { resolveStrategyTriggerAdapter } from "../../../../lib/strategy-triggers/registry";
import { isStrategyTriggerKind } from "../../../../lib/strategy-trigger-catalog";
import { evaluateLowPositionTriggerRuntime } from "../../../../lib/low-position-trigger-runtime";
import { evaluateThreeMinuteProbabilityRuntime } from "../../../../lib/three-minute-probability-runtime";
import {
  THREE_MINUTE_CANDIDATE_DISCOVERY_BATCH,
  planThreeMinuteCandidateQueueAdmission,
  THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH,
  THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY,
  THREE_MINUTE_MARKET_SCAN_BATCH,
} from "../../../../lib/three-minute-candidate-queue";
import {
  THREE_MINUTE_OPPORTUNITY_BOARD_CAPACITY,
  ThreeMinuteOpportunityBoard,
  threeMinuteOpportunityPriority,
  threeMinuteOpportunityShouldPreempt,
} from "../../../../lib/three-minute-opportunity-board";
import {
  THREE_MINUTE_HARD_STOP_ROE_PERCENT,
  THREE_MINUTE_LOSS_FLOOR_ROE_PERCENT,
  THREE_MINUTE_PROFIT_EXIT_ROE_PERCENT,
  THREE_MINUTE_PROFIT_FLOOR_ROE_PERCENT,
  THREE_MINUTE_PROFIT_MONITOR_ROE_PERCENT,
} from "../../../../lib/three-minute-dynamic-protection";
import {
  evaluateBreakoutRetestTriggerRuntime,
  evaluateGridPriceLevelTriggerRuntime,
  evaluateScheduledScanTriggerRuntime,
} from "../../../../lib/market-structure-trigger-runtime";
import type { StrategyTriggerWake } from "../../../../lib/strategy-trigger-wake";
import { getNexusLiveOrderFlow } from "../../../../lib/nexus-order-flow-live";
import {
  threeMinuteRoundAt,
  threeMinuteRollingEvaluationDue,
} from "../../../../lib/three-minute-round";
import { buildLiquidationWaveThesis } from "../../../../lib/liquidation-wave-thesis";
import { resolveExplorationLongAnchors } from "../../../../lib/liquidation-exploration-anchors";
import {
  buildThreeMinuteRoundThesis,
  decideThreeMinuteProbabilityEye,
} from "../../../../lib/three-minute-entry-decision";
import {
  directionalEntryStructuralRiskRoePercent,
  resolveDirectionalEntryAnchors,
  revalidateDirectionalEntry,
} from "../../../../lib/strategy-directional-entry";
import { buildStructureWakeThesis } from "../../../../lib/structure-wake-thesis";
import {
  entryAuthorizationEvidence,
  resolveNexusEntryAuthorization,
} from "../../../../lib/nexus-entry-authorization";
import {
  evaluateNexusStrategyDirections,
} from "../../../../lib/strategy-direction-paths/evaluate";
import {
  handoffNexusDirectionDecision,
} from "../../../../lib/strategy-direction-paths/handoff";
import {
  configuredExpectedProfitRoePercent,
  directionalStructureUncertaintyRoePercent,
  nexusMarketEyeDirectionPathAdapter,
} from "../../../../lib/strategy-direction-paths/market-eye";
import { buildCompetingDirectionWakeCohorts } from
  "../../../../lib/strategy-direction-paths/wake-cohort";
import {
  resolvedExchangeFillTime,
} from "../../../../lib/liquidation-pending-entry";
import {
  effectiveNexusOrderDeadline,
  nexusExecutionIntentSettlementDeadline,
} from "../../../../lib/nexus-order-lifecycle";
import {
  executableRiskPlanPayoffProfile,
  hasCompleteNetProfitPath,
} from "../../../../lib/strategy-payoff";
import {
  hasExplorationOrderFirstPolicy,
  strategyModelPhase,
} from "../../../../lib/strategy-model-phase";
import { readStrategyModelProgressCounts } from
  "../../../../lib/strategy-model-progress-store";
import { marketAnalysisPressureResponse } from
  "../../../../lib/runtime-memory-pressure";
import {
  effectiveExplorationLiquidationEventCount,
  evaluateNexusExplorationEntry,
  explorationExecutionConfig,
  rollingSameSymbolLiquidationEventCount,
} from "../../../../lib/nexus-exploration-entry";
import { settleNexusAnalysisCandleSeries } from "../../../../lib/nexus-analysis-candle-series";
import { NexusMarketAnalysisCycle } from "../../../../lib/nexus-market-analysis-cycle";
import { getCoinGlassWebLiquidationContext } from "../../../../lib/coinglass-web-liquidations";
import { calculateStrategyMarginCapacity } from "../../../../lib/strategy-margin-capacity.mjs";
import { binanceAnalysisCapacity } from "../../../../lib/binance-analysis-capacity";
import {
  automatedOrderCapacityMessage,
  calculateAutomatedDailyMarginQuota,
  calculateAutomatedOrderCapacity,
} from "../../../../lib/automated-order-capacity.mjs";
import {
  attributedOrderInitialMargin,
  attributedPositionMargin,
  attributedPositionUnrealizedPnl,
  liquidationLongTraceIdFromClientOrderId,
} from "../../../../lib/strategy-order-attribution";
import {
  readTradingStrategyDailyPnl,
  writeAudit,
} from "../../control/shared";
import {
  pauseAnalysisWindow,
} from "../../../../lib/analysis-window-renewal";
import { nexusEntryWaitDisposition } from "../../../../lib/nexus-entry-wait-policy";
import {
  analyzeLiquidationCascadeContext,
  shouldSupersedeLiquidationAnalysis,
} from "../../../../lib/liquidation-cascade-context";
import {
  deriveLiquidationDerivedFactors,
  evaluateLiquidationFactorBrain,
  normalizeLiquidationFactorPolicy,
  selectLiquidationFactorEpisode,
} from "../../../../lib/liquidation-derived-factors";
import { readLiquidationFactorOpenInterest } from "../../../../lib/liquidation-factor-market-context";
import { evaluateAutomatedOrderConcurrency } from "../../../../lib/automated-order-concurrency";
import { findBlockingOpenSymbolPosition } from "../../../../lib/position-exposure";
import {
  buildEntryAnalysisOccupancySnapshot,
  entryAnalysisOccupancyReason,
} from "../../../../lib/entry-analysis-occupancy.mjs";
import { buildGlobalSentinelObservation } from "../../../../lib/nexus-global-sentinel";
import { loadGlobalSentinelProbeFeedback } from "../../../../lib/nexus-learning-cycle-store";
import {
  NEXUS_FINAL_ANALYSIS_SETTLEMENT_GRACE_MS,
  resolveNexusAnalysisDecisionWindow,
  summarizeNexusAnalysisExpiry,
} from "../../../../lib/nexus-analysis-expiry";
import {
  advanceNexusPriorLifecycleMemory,
  buildNexusPriorLifecycleMemory,
  effectiveNexusPriorAwareLiquidationCount,
  type NexusPriorLifecycleMemory,
} from "../../../../lib/nexus-prior-lifecycle-memory";
import {
  monitorMemoryPressureBlocksAnalysis,
  resolveMonitorMarketWorkload,
} from
  "../../../../lib/monitor-market-workload";

export const dynamic = "force-dynamic";

const ACTIVE_STATES = [
  "TRIGGERED",
  "ANALYZING",
  "ARMED",
  "ORDER_READY",
  "ORDER_PENDING",
  "POSITION_OPEN",
  "TRAILING_ARMED",
  "TRAILING_ACTIVE",
  "EXIT_PENDING",
] as const;
const ACTIVE_STATE_SET = new Set<string>(ACTIVE_STATES);
const ANALYSIS_EXPIRABLE_STATES = [
  "TRIGGERED",
  "ANALYZING",
  "ARMED",
  "ORDER_READY",
] as const;
const LIQUIDATION_FEED_RECOVERY_WINDOW_MS = 300_000;
const ANALYSIS_REST_WEIGHT_PER_TRACE = 5;
const ANALYSIS_CAPACITY_RECHECK_MS = 5_000;
let analysisCapacityRetryAt = 0;
const lowPositionLastScanAtByStrategy = new Map<string, number>();
const lowPositionScanCursorByStrategy = new Map<string, number>();
const threeMinuteLastEvaluationAtByStrategy = new Map<string, number>();
const threeMinuteScanCursorByStrategy = new Map<string, number>();
const threeMinuteWarmSymbolsByStrategy = new Map<string, string[]>();
const threeMinuteOpportunityBoardByStrategy = new Map<
  string,
  ThreeMinuteOpportunityBoard
>();
const liquidationMonitorRuntimeStartedAt = Date.now();
const recoveredThreeMinuteCandidateTraceIds = new Set<string>();
let recoveredThreeMinuteCandidateCount = 0;
const marketStructureLastScanAtByStrategy = new Map<string, number>();
const marketStructureScanCursorByStrategy = new Map<string, number>();
const scheduledScanWindowByStrategy = new Map<string, number>();

function triggerRuntimeStateKey(strategy: { id: number; configVersion: number }) {
  return `${strategy.id}:v${strategy.configVersion}`;
}

export function pruneLiquidationTriggerRuntimeState(
  runningStrategies: Array<{ id: number; configVersion: number }>,
) {
  const currentKeys = new Set(runningStrategies.map(triggerRuntimeStateKey));
  for (const store of [
    lowPositionLastScanAtByStrategy,
    lowPositionScanCursorByStrategy,
    threeMinuteLastEvaluationAtByStrategy,
    threeMinuteScanCursorByStrategy,
    threeMinuteWarmSymbolsByStrategy,
    threeMinuteOpportunityBoardByStrategy,
  ]) {
    for (const key of store.keys())
      if (!currentKeys.has(key)) store.delete(key);
  }
  const structurePrefixes = runningStrategies.map(
    (strategy) => `${strategy.id}:${strategy.configVersion}:`,
  );
  for (const store of [
    marketStructureLastScanAtByStrategy,
    marketStructureScanCursorByStrategy,
    scheduledScanWindowByStrategy,
  ]) {
    for (const key of store.keys())
      if (!structurePrefixes.some((prefix) => key.startsWith(prefix)))
        store.delete(key);
  }
}

const MARKET_STRUCTURE_TRIGGER_KINDS = new Set([
  "GRID_PRICE_LEVEL",
  "SCHEDULED_SCAN",
  "BREAKOUT_RETEST",
] as const);

type LiquidationWindowSummary = {
  symbol: string;
  side: "BUY" | "SELL";
  notional: number;
  eventCount: number;
  maxSingleNotional: number;
  spanSeconds: number;
  maxGapSeconds: number;
  latestAgeSeconds: number;
};

type ActiveAnalysisSummary = {
  traceId: string;
  symbol: string;
  state: string;
  resultCode: string | null;
  resultMessage: string | null;
  ageSeconds: number;
  expiresInSeconds: number | null;
  updatedAgeSeconds: number;
};

type AnalysisMarketDataPauseTrace = {
  id: number;
  traceId: string;
  strategyId: number;
  configVersion: number;
  configSnapshotJson: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  entryEvidenceJson: string | null;
};

type LiquidationTriggerDiagnostic = {
  strategyId: number;
  strategyName: string;
  direction: LiquidationTrendConfig["direction"];
  feedEvents: number;
  candidateCount: number;
  freshCandidateCount: number;
  freshestCandidateAgeSeconds: number | null;
  activeAnalysisCount: number;
  activeAnalyses: ActiveAnalysisSummary[];
  selectedSymbolCount: number;
  threshold: {
    side: "BUY_AND_SELL";
    minSingleEventNotionalUsdt: number;
    minWindowNotionalUsdt: number;
    minEventCount: number;
    maxSpanSeconds: number;
    maxInterEventGapSeconds: number;
    maxSignalDelayMs: number;
  };
  strongestSingleSell: LiquidationWindowSummary | null;
  bestConfiguredSellWindow: LiquidationWindowSummary | null;
  best120SecondSellWindow: LiquidationWindowSummary | null;
  strongestSingleBuy: LiquidationWindowSummary | null;
  best120SecondBuyWindow: LiquidationWindowSummary | null;
  closestTriggerSuggestion: {
    action: "KEEP_WAITING" | "LOWER_NOTIONAL" | "WIDEN_WINDOW";
    message: string;
    suggestedMinSingleEventNotionalUsdt: number | null;
    suggestedMinWindowNotionalUsdt: number | null;
    suggestedMaxSpanSeconds: number | null;
    suggestedMaxInterEventGapSeconds: number | null;
    suggestedMaxSignalDelayMs: number | null;
  };
  reason: string;
};

type LowPositionTriggerDiagnostic = {
  strategyId: number;
  strategyName: string;
  triggerKind: "LOW_POSITION_WINDOW";
  scannedSymbols: string[];
  totalSymbolCount: number;
  preparedFacts: number;
  candidateCount: number;
  createdCount: number;
  cacheErrors: Array<{ symbol: string; message: string }>;
  skippedUntil: string | null;
};

type ThreeMinuteProbabilityDiagnostic = {
  strategyId: number;
  strategyName: string;
  triggerKind: "THREE_MINUTE_PROBABILITY";
  roundId: string;
  roundEndsAt: string;
  scannedSymbols: string[];
  prefilteredSymbols: string[];
  skippedUnsupportedSymbols: string[];
  candidateCount: number;
  createdCount: number;
  cacheErrors: Array<{ symbol: string; interval: string; message: string }>;
  executionInfeasibleSymbols?: Array<{
    symbol: string;
    direction: "LONG" | "SHORT";
    reason: string;
    requiredMarginUsdt: number | null;
    availableTargetMarginUsdt: number | null;
  }>;
  skippedReason: string | null;
};

async function readThreeMinuteCandidateQueueDepth(at: Date) {
  const [row] = await getDb()
    .select({ value: count() })
    .from(strategyExecutionTraces)
    .where(and(
      eq(
        strategyExecutionTraces.triggerKind,
        "THREE_MINUTE_PROBABILITY",
      ),
      inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
      gt(strategyExecutionTraces.expiresAt, at),
    ));
  return Number(row?.value ?? 0);
}

type MarketStructureTriggerDiagnostic = {
  strategyId: number;
  strategyName: string;
  triggerKind: "GRID_PRICE_LEVEL" | "SCHEDULED_SCAN" | "BREAKOUT_RETEST";
  scannedSymbols: string[];
  totalSymbolCount: number;
  candidateCount: number;
  createdCount: number;
  cacheErrors: Array<{ symbol: string; message: string }>;
  skippedUntil: string | null;
  reason: string;
  scanCoverage?: {
    scanCount: number;
    coverageCycles: number;
    requiredScanCount: number;
    fullSweepSeconds: number;
    meetsFactAge: boolean;
    capped: boolean;
  } | null;
};

function authorized(request: Request) {
  const configured = (
    env as unknown as { NQ_INTERNAL_LIQUIDATION_TOKEN?: string }
  ).NQ_INTERNAL_LIQUIDATION_TOKEN ?? "";
  return (
    configured.length >= 32 &&
    request.headers.get("authorization") === `Bearer ${configured}`
  );
}

function pilotRuntime() {
  return {
    // 运行资格由页面上的策略状态、服务器总控和账户密钥状态共同决定。
    // 这里仅表示监控进程已加载，不再读取隐藏环境开关。
    enabled: true,
  };
}

function rounded(value: number, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function upsertThreeMinuteRoundStatus(input: {
  strategy: {
    id: number;
    configVersion: number;
    ownerEmail: string;
    accountId: string;
  };
  config: LiquidationTrendConfig;
  runtime: Awaited<ReturnType<typeof evaluateThreeMinuteProbabilityRuntime>> | null;
  round: ReturnType<typeof threeMinuteRoundAt>;
  runtimeError?: string | null;
  createdCount: number;
  occupiedPositionSuppressed: number;
  workingOrderSuppressed: number;
  checkedAt: Date;
}) {
  const db = getDb();
  const traceId = `three-minute-monitor-status:${input.strategy.id}`;
  const decisions = (input.runtime?.decisions ?? [])
    .map((decision) => ({
      symbol: decision.symbol,
      direction: decision.direction,
      pLongPercent: rounded(decision.pLongPercent),
      pShortPercent: rounded(decision.pShortPercent),
      selectedProbabilityPercent: rounded(
        Math.max(decision.pLongPercent, decision.pShortPercent),
      ),
      configuredMinimumProbabilityPercent:
        input.config.trigger.threeMinuteProbability
          ?.minimumProbabilityPercent ??
          DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.minimumProbabilityPercent,
      breakEvenProbabilityPercent: rounded(
        decision.breakEvenProbabilityPercent,
      ),
      netEdgeBps: rounded(decision.netEdgeBps),
      dataQuality: decision.dataQuality,
      eligibilityMode: decision.eligibilityMode,
    }))
    .sort((left, right) =>
      right.selectedProbabilityPercent - left.selectedProbabilityPercent ||
      left.symbol.localeCompare(right.symbol)
    );
  const top = decisions[0] ?? null;
  const topDirection = top
    ? top.pLongPercent >= top.pShortPercent ? "LONG" as const : "SHORT" as const
    : "LONG" as const;
  const resultMessage = input.runtimeError
    ? input.runtimeError
    : input.createdCount > 0
    ? `3分钟滚动评估已建立 ${input.createdCount} 个候选并进入直接概率执行。`
    : input.occupiedPositionSuppressed > 0
      ? "本次滚动候选已确认，但对应合约已有持仓，未重复开仓。"
      : input.workingOrderSuppressed > 0
        ? "本次滚动候选已确认，但对应合约已有生效委托，未重复提交。"
        : top
          ? `${top.symbol} 当前最高方向概率 ${top.selectedProbabilityPercent.toFixed(2)}%，` +
            `执行门槛 ${top.configuredMinimumProbabilityPercent.toFixed(2)}%；` +
            `费用后参考 ${top.netEdgeBps.toFixed(2)}bp（不拦截）。` +
            "本次滚动评估未形成可执行候选。"
          : (input.runtime?.orderFlowMissingSymbols.length ?? 0) > 0
            ? `订单流尚未成熟：${input.runtime?.orderFlowMissingSymbols.join("、")}；其余合约继续独立计算。`
            : (input.runtime?.cacheErrors.length ?? 0) > 0
              ? "本次滚动评估的多周期闭合K线不完整，未使用残缺数据下单。"
              : (input.runtime?.skippedUnsupportedSymbols.length ?? 0) > 0
                ? `本次滚动评估已隔离当前执行链不支持的合约：${input.runtime?.skippedUnsupportedSymbols.join("、")}；其余合约已正常完成计算。`
                : "本次滚动评估没有形成满足配置的概率候选。";
  const referencePrice = 1;
  const values = {
    strategyId: input.strategy.id,
    strategyRunId: "three-minute-monitor-status",
    configVersion: input.strategy.configVersion,
    ownerEmail: input.strategy.ownerEmail,
    accountId: input.strategy.accountId,
    symbol:
      top?.symbol ?? input.runtime?.prefilteredSymbols[0] ??
      input.runtime?.scannedSymbols[0] ?? "BTCUSDT",
    triggerKind: "THREE_MINUTE_PROBABILITY" as const,
    triggerVersion: "three-minute-probability-trigger-v3",
    triggerDirection: topDirection,
    triggerReferencePrice: referencePrice,
    triggerFactSnapshotId: null,
    triggerSourceId: traceId,
    liquidationSide: topDirection === "LONG" ? "SELL" as const : "BUY" as const,
    liquidationPrice: referencePrice,
    liquidationNotional: 0,
    eventTime: input.checkedAt,
    receivedAt: input.checkedAt,
    expiresAt: new Date(input.round.endsAt),
    state: "CLOSED" as const,
    resultCode: "THREE_MINUTE_ROUND_STATUS",
    resultMessage,
    configSnapshotJson: JSON.stringify(input.config),
    entryEvidenceJson: JSON.stringify({
      monitorDiagnostic: true,
      triggerKind: "THREE_MINUTE_PROBABILITY",
      runtimeStatus: input.runtimeError ? "ERROR" : "READY",
      runtimeError: input.runtimeError ?? null,
      roundId: input.round.roundId,
      roundStartedAt: input.round.startedAt,
      roundEndsAt: input.round.endsAt,
      threeMinuteProbability: top
        ? {
            ...top,
            direction: topDirection,
            roundId: input.round.roundId,
            roundStartedAt: input.round.startedAt,
            roundEndsAt: input.round.endsAt,
          }
        : null,
      round: input.round,
      scannedSymbols: input.runtime?.scannedSymbols ?? [],
      prefilteredSymbols: input.runtime?.prefilteredSymbols ?? [],
      skippedUnsupportedSymbols:
        input.runtime?.skippedUnsupportedSymbols ?? [],
      executionInfeasibleSymbols:
        input.runtime?.executionInfeasibleSymbols ?? [],
      orderFlowMissingSymbols: input.runtime?.orderFlowMissingSymbols ?? [],
      orderFlowErrors: input.runtime?.orderFlowErrors ?? [],
      cacheErrors: input.runtime?.cacheErrors ?? [],
      decisions,
      candidateCount: input.runtime?.wakes.length ?? 0,
      createdCount: input.createdCount,
      occupiedPositionSuppressed: input.occupiedPositionSuppressed,
      workingOrderSuppressed: input.workingOrderSuppressed,
      checkedAt: input.checkedAt.toISOString(),
    }),
    updatedAt: input.checkedAt,
    completedAt: input.checkedAt,
  };
  await db
    .insert(strategyExecutionTraces)
    .values({ traceId, ...values, createdAt: input.checkedAt })
    .onConflictDoUpdate({
      target: strategyExecutionTraces.traceId,
      set: values,
    });
  const eventValues = {
    strategyId: input.strategy.id,
    sequence: 1,
    stage: "SIGNAL" as const,
    outcome: input.runtimeError
      ? "ERROR" as const
      : input.createdCount > 0 ? "PASSED" as const : "PENDING" as const,
    message: resultMessage,
    detailJson: JSON.stringify({
      runtimeStatus: input.runtimeError ? "ERROR" : "READY",
      runtimeError: input.runtimeError ?? null,
      roundId: input.round.roundId,
      roundEndsAt: input.round.endsAt,
      decisions,
      orderFlowMissingSymbols: input.runtime?.orderFlowMissingSymbols ?? [],
      skippedUnsupportedSymbols:
        input.runtime?.skippedUnsupportedSymbols ?? [],
      executionInfeasibleSymbols:
        input.runtime?.executionInfeasibleSymbols ?? [],
      cacheErrors: input.runtime?.cacheErrors ?? [],
      candidateCount: input.runtime?.wakes.length ?? 0,
      createdCount: input.createdCount,
    }),
    eventAt: input.checkedAt,
    createdAt: input.checkedAt,
  };
  const [existingEvent] = await db
    .select({ id: strategyExecutionEvents.id })
    .from(strategyExecutionEvents)
    .where(and(
      eq(strategyExecutionEvents.traceId, traceId),
      eq(strategyExecutionEvents.eventType, "THREE_MINUTE_ROUND_STATUS"),
    ))
    .limit(1);
  if (existingEvent)
    await db.update(strategyExecutionEvents)
      .set(eventValues)
      .where(eq(strategyExecutionEvents.id, existingEvent.id));
  else
    await db.insert(strategyExecutionEvents).values({
      traceId,
      eventType: "THREE_MINUTE_ROUND_STATUS",
      ...eventValues,
    });
}

function summarizeStrongestSingleLiquidation(
  rows: BinanceLiquidationAggregate[],
  side: "BUY" | "SELL",
): LiquidationWindowSummary | null {
  const row = rows
    .filter((item) => item.side === side)
    .sort((left, right) => right.notional - left.notional)[0];
  if (!row) return null;
  return {
    symbol: row.symbol,
    side,
    notional: rounded(row.notional),
    eventCount: Math.max(1, Math.trunc(row.eventCount || 1)),
    maxSingleNotional: rounded(row.notional),
    spanSeconds: rounded((row.lastTradeTime - row.firstTradeTime) / 1_000, 1),
    maxGapSeconds: 0,
    latestAgeSeconds: rounded((Date.now() - row.lastTradeTime) / 1_000, 1),
  };
}

function summarizeBestLiquidationWindow(
  rows: BinanceLiquidationAggregate[],
  side: "BUY" | "SELL",
  maxSpanMs: number,
  maxInterEventGapMs: number,
): LiquidationWindowSummary | null {
  const bySymbol = new Map<string, BinanceLiquidationAggregate[]>();
  for (const row of rows) {
    if (row.side !== side) continue;
    const current = bySymbol.get(row.symbol) ?? [];
    current.push(row);
    bySymbol.set(row.symbol, current);
  }
  let best: LiquidationWindowSummary | null = null;
  for (const [symbol, symbolRows] of bySymbol) {
    const ordered = [...symbolRows].sort(
      (left, right) =>
        left.lastTradeTime - right.lastTradeTime ||
        left.sequence - right.sequence,
    );
    for (let start = 0; start < ordered.length; start += 1) {
      let notional = 0;
      let eventCount = 0;
      let maxSingleNotional = 0;
      let maxGapMs = 0;
      for (let end = start; end < ordered.length; end += 1) {
        const row = ordered[end];
        const first = ordered[start];
        const previous = end > start ? ordered[end - 1] : null;
        const gapMs = previous ? row.firstTradeTime - previous.lastTradeTime : 0;
        if (previous && gapMs > maxInterEventGapMs) break;
        if (row.lastTradeTime - first.firstTradeTime > maxSpanMs) break;
        notional += row.notional;
        eventCount += Math.max(1, Math.trunc(row.eventCount || 1));
        maxSingleNotional = Math.max(maxSingleNotional, row.notional);
        maxGapMs = Math.max(maxGapMs, gapMs);
        const candidate = {
          symbol,
          side,
          notional: rounded(notional),
          eventCount,
          maxSingleNotional: rounded(maxSingleNotional),
          spanSeconds: rounded(
            (row.lastTradeTime - first.firstTradeTime) / 1_000,
            1,
          ),
          maxGapSeconds: rounded(maxGapMs / 1_000, 1),
          latestAgeSeconds: rounded((Date.now() - row.lastTradeTime) / 1_000, 1),
        };
        if (!best || candidate.notional > best.notional) best = candidate;
      }
    }
  }
  return best;
}

function liquidationTriggerReason(input: {
  candidateCount: number;
  threshold: LiquidationTriggerDiagnostic["threshold"];
  strongestSingleSell: LiquidationWindowSummary | null;
  bestConfiguredSellWindow: LiquidationWindowSummary | null;
  best120SecondSellWindow: LiquidationWindowSummary | null;
  freshCandidateCount: number;
  freshestCandidateAgeSeconds: number | null;
  activeAnalysisCount: number;
}) {
  if (input.activeAnalysisCount > 0 && input.freshCandidateCount === 0)
    return `当前已有 ${input.activeAnalysisCount} 条分析链路在处理；本轮没有新增新鲜候选，避免重复创建同类链路。`;
  if (input.freshCandidateCount > 0)
    return `已形成 ${input.freshCandidateCount}/${input.candidateCount} 个新鲜单币爆仓候选，等待后续趋势和结构判断。`;
  if (input.candidateCount > 0)
    return `最近窗口曾形成 ${input.candidateCount} 个单币爆仓候选，但最新候选年龄 ${(
      input.freshestCandidateAgeSeconds ?? 0
    ).toFixed(1)} 秒，超过策略最大延迟 ${(input.threshold.maxSignalDelayMs / 1_000).toFixed(1)} 秒，本轮不建新执行链路。`;
  const strongest = input.strongestSingleSell;
  const configured = input.bestConfiguredSellWindow;
  if (!strongest && !configured) return "最近窗口没有 SELL 方向单币爆仓事件。";
  const parts = [
    `当前未形成候选：最大单笔 SELL ${(strongest?.maxSingleNotional ?? 0).toFixed(2)} / ${input.threshold.minSingleEventNotionalUsdt.toFixed(2)} USDT`,
    `配置窗口 ${input.threshold.maxSpanSeconds}s 内最大累计 SELL ${(configured?.notional ?? 0).toFixed(2)} / ${input.threshold.minWindowNotionalUsdt.toFixed(2)} USDT`,
  ];
  if (input.best120SecondSellWindow)
    parts.push(
      `120s 观察窗口最大累计 ${input.best120SecondSellWindow.notional.toFixed(2)} USDT（仅诊断，不参与当前下单）`,
    );
  parts.push("爆仓金额未达到当前策略触发门槛。");
  return parts.join("；");
}

function buildClosestTriggerSuggestion(input: {
  threshold: LiquidationTriggerDiagnostic["threshold"];
  candidateCount: number;
  freshCandidateCount: number;
  freshestCandidateAgeSeconds: number | null;
  strongestSingleSell: LiquidationWindowSummary | null;
  bestConfiguredSellWindow: LiquidationWindowSummary | null;
  best120SecondSellWindow: LiquidationWindowSummary | null;
}): LiquidationTriggerDiagnostic["closestTriggerSuggestion"] {
  const base = {
    suggestedMinSingleEventNotionalUsdt: null,
    suggestedMinWindowNotionalUsdt: null,
    suggestedMaxSpanSeconds: null,
    suggestedMaxInterEventGapSeconds: null,
    suggestedMaxSignalDelayMs: null,
  };
  if (input.freshCandidateCount > 0)
    return {
      action: "KEEP_WAITING",
      message: "已有新鲜候选，继续进入趋势、结构和下单可行性判断。",
      ...base,
    };
  if (input.candidateCount > 0) {
    return {
      action: "KEEP_WAITING",
      message: `候选已经形成但超过 ${input.threshold.maxSignalDelayMs}ms 延迟限制；本轮丢弃旧候选并等待新鲜信号，不自动放宽策略时效。`,
      ...base,
    };
  }
  const configured = input.bestConfiguredSellWindow;
  const wide = input.best120SecondSellWindow;
  if (
    wide &&
    wide.notional >= Math.max(1, input.threshold.minWindowNotionalUsdt * 0.5) &&
    wide.notional > (configured?.notional ?? 0)
  ) {
    return {
      action: "WIDEN_WINDOW",
      message:
        `${wide.symbol} 在 120 秒观察窗口累计 ${wide.notional.toFixed(2)} USDT，` +
        `高于当前 ${input.threshold.maxSpanSeconds}s 配置窗口；若要捕捉慢速扫盘，可放宽单币累计窗口。`,
      ...base,
      suggestedMaxSpanSeconds: Math.max(30, Math.ceil(wide.spanSeconds)),
      suggestedMaxInterEventGapSeconds: Math.max(
        10,
        Math.ceil(wide.maxGapSeconds || wide.spanSeconds),
      ),
    };
  }
  const nearest = [configured, wide, input.strongestSingleSell]
    .filter(Boolean)
    .sort((left, right) => right!.notional - left!.notional)[0] ?? null;
  if (nearest) {
    const exploratoryThreshold = Math.max(1, Math.floor(nearest.notional));
    return {
      action: "LOWER_NOTIONAL",
      message:
        `${nearest.symbol} 当前最接近触发，SELL 金额 ${nearest.notional.toFixed(2)} USDT；` +
        `若目标是前期探索积累样本，可把单币触发金额降到不高于 ${exploratoryThreshold} USDT。`,
      ...base,
      suggestedMinSingleEventNotionalUsdt: exploratoryThreshold,
      suggestedMinWindowNotionalUsdt: exploratoryThreshold,
    };
  }
  return {
    action: "KEEP_WAITING",
    message: "最近没有可参考的 SELL 爆仓事件，继续等待真实波动。",
    ...base,
  };
}

function buildLiquidationTriggerDiagnostic(input: {
  strategy: typeof strategies.$inferSelect;
  config: LiquidationTrendConfig;
  feedRows: BinanceLiquidationAggregate[];
  candidateCount: number;
  freshCandidateCount: number;
  freshestCandidateAgeSeconds: number | null;
  activeAnalysisCount: number;
  activeAnalyses: ActiveAnalysisSummary[];
}) {
  const threshold = {
    side: "BUY_AND_SELL" as const,
    minSingleEventNotionalUsdt:
      input.config.trigger.minSingleLiquidationNotionalUsdt ??
      input.config.trigger.minLiquidationNotionalUsdt,
    minWindowNotionalUsdt: input.config.trigger.minLiquidationNotionalUsdt,
    minEventCount: input.config.trigger.minClusterEvents ?? 1,
    maxSpanSeconds: input.config.trigger.maxClusterSpanSeconds ?? 3,
    maxInterEventGapSeconds:
      input.config.trigger.maxClusterEventGapSeconds ??
      input.config.trigger.maxClusterSpanSeconds ??
      3,
    maxSignalDelayMs: input.config.trigger.maxSignalDelayMs,
  };
  const strongestSingleSell = summarizeStrongestSingleLiquidation(
    input.feedRows,
    "SELL",
  );
  const bestConfiguredSellWindow = summarizeBestLiquidationWindow(
    input.feedRows,
    "SELL",
    Math.max(1_000, threshold.maxSpanSeconds * 1_000),
    Math.max(1_000, threshold.maxInterEventGapSeconds * 1_000),
  );
  const best120SecondSellWindow = summarizeBestLiquidationWindow(
    input.feedRows,
    "SELL",
    120_000,
    120_000,
  );
  const diagnostic: LiquidationTriggerDiagnostic = {
    strategyId: input.strategy.id,
    strategyName: input.strategy.name,
    direction: input.config.direction,
    feedEvents: input.feedRows.length,
    candidateCount: input.candidateCount,
    freshCandidateCount: input.freshCandidateCount,
    freshestCandidateAgeSeconds: input.freshestCandidateAgeSeconds,
    activeAnalysisCount: input.activeAnalysisCount,
    activeAnalyses: input.activeAnalyses,
    selectedSymbolCount: input.config.selectedSymbols.length,
    threshold,
    strongestSingleSell,
    bestConfiguredSellWindow,
    best120SecondSellWindow,
    strongestSingleBuy: summarizeStrongestSingleLiquidation(
      input.feedRows,
      "BUY",
    ),
    best120SecondBuyWindow: summarizeBestLiquidationWindow(
      input.feedRows,
      "BUY",
      120_000,
      120_000,
    ),
    closestTriggerSuggestion: {
      action: "KEEP_WAITING",
      message: "",
      suggestedMinSingleEventNotionalUsdt: null,
      suggestedMinWindowNotionalUsdt: null,
      suggestedMaxSpanSeconds: null,
      suggestedMaxInterEventGapSeconds: null,
      suggestedMaxSignalDelayMs: null,
    },
    reason: "",
  };
  diagnostic.closestTriggerSuggestion = buildClosestTriggerSuggestion({
    threshold,
    candidateCount: diagnostic.candidateCount,
    freshCandidateCount: diagnostic.freshCandidateCount,
    freshestCandidateAgeSeconds: diagnostic.freshestCandidateAgeSeconds,
    strongestSingleSell,
    bestConfiguredSellWindow,
    best120SecondSellWindow,
  });
  diagnostic.reason = liquidationTriggerReason({
    candidateCount: diagnostic.candidateCount,
    freshCandidateCount: diagnostic.freshCandidateCount,
    freshestCandidateAgeSeconds: diagnostic.freshestCandidateAgeSeconds,
    activeAnalysisCount: diagnostic.activeAnalysisCount,
    threshold,
    strongestSingleSell,
    bestConfiguredSellWindow,
    best120SecondSellWindow,
  });
  return diagnostic;
}

async function expireUnresolvedAnalysisTraces(now: Date) {
  const db = getDb();
  const expiring = await db
    .select({
      id: strategyExecutionTraces.id,
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
      symbol: strategyExecutionTraces.symbol,
      triggerKind: strategyExecutionTraces.triggerKind,
      expiresAt: strategyExecutionTraces.expiresAt,
      configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        inArray(strategyExecutionTraces.state, [...ANALYSIS_EXPIRABLE_STATES]),
        notLike(strategyExecutionTraces.traceId, "short-%"),
        lte(strategyExecutionTraces.expiresAt, now),
        or(
          isNull(strategyExecutionTraces.resultCode),
          ne(strategyExecutionTraces.resultCode, "SHORT_MONITOR_STATUS"),
        ),
      ),
    )
    .limit(100);
  let expired = 0;
  for (const trace of expiring) {
    const entryEvidence = asRecord(safeParse(trace.entryEvidenceJson));
    const frozenDecision = asRecord(entryEvidence.frozenExecutionDecision);
    const snapshot = asRecord(safeParse(trace.configSnapshotJson));
    const trigger = asRecord(snapshot.trigger);
    const frozenExecutionDeadline = resolveFrozenExecutionDeadline({
      frozenDecision,
      analysisValiditySeconds: finiteNumber(
        trigger.analysisValiditySeconds,
        300,
      ),
    });
    const frozenApproval = isFrozenExecutionApproval(frozenDecision);
    if (
      frozenApproval &&
      frozenExecutionDeadline !== null &&
      frozenExecutionDeadline > now.getTime()
    ) {
      await db
        .update(strategyExecutionTraces)
        .set({
          expiresAt: new Date(frozenExecutionDeadline),
          completedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(strategyExecutionTraces.id, trace.id),
            inArray(strategyExecutionTraces.state, [
              ...ANALYSIS_EXPIRABLE_STATES,
            ]),
            lte(strategyExecutionTraces.expiresAt, now),
          ),
        );
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "NEXUS_FROZEN_EXECUTION_WINDOW_RECOVERED",
        stage: "ORDER",
        outcome: "PENDING",
        message:
          "大脑判断已经通过；旧分析计时器已切换为独立执行窗口，不重新分析",
        detail: {
          previousExpiresAt: trace.expiresAt.toISOString(),
          executionExpiresAt: new Date(
            frozenExecutionDeadline,
          ).toISOString(),
          retryWithoutReanalysis: true,
        },
        eventAt: now,
      });
      continue;
    }
    const continuity = decideNexusAnalysisContinuity({
      entryEvidence,
      currentExpiresAtMs: trace.expiresAt.getTime(),
      nowMs: now.getTime(),
    });
    if (
      !frozenApproval &&
      continuity.extend &&
      continuity.nextExpiresAtMs !== null
    ) {
      entryEvidence.analysisContinuityRecovery = continuity.recovery;
      const [extended] = await db
        .update(strategyExecutionTraces)
        .set({
          expiresAt: new Date(continuity.nextExpiresAtMs),
          entryEvidenceJson: JSON.stringify(entryEvidence),
          completedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(strategyExecutionTraces.id, trace.id),
            inArray(
              strategyExecutionTraces.state,
              [...ANALYSIS_EXPIRABLE_STATES],
            ),
            lte(strategyExecutionTraces.expiresAt, now),
          ),
        )
        .returning({ id: strategyExecutionTraces.id });
      if (extended) {
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: "NEXUS_EYE_DATA_RECOVERY_WINDOW_EXTENDED",
          stage: "SIGNAL",
          outcome: "PENDING",
          message:
            `眼睛数据尚未完整，信号仅延长30秒等待补齐：${continuity.missing.join("、") || "决策快照缺项"}；该窗口不代表探针或下单授权`,
          detail: continuity.recovery ?? {},
          eventAt: now,
        });
        continue;
      }
    }
    const expiryOutcome = summarizeNexusAnalysisExpiry({
      symbol: trace.symbol,
      triggerKind: isStrategyTriggerKind(trace.triggerKind)
        ? trace.triggerKind
        : "LIQUIDATION_WINDOW",
      entryEvidence,
      requiredLiquidationEventCount: Math.max(
        1,
        Math.trunc(finiteNumber(trigger.minClusterEvents, 1)),
      ),
    });
    entryEvidence.analysisExpiryOutcome = expiryOutcome;
    const resultCode = frozenApproval
      ? "NEXUS_FROZEN_EXECUTION_EXPIRED"
      : "ANALYSIS_EXPIRED";
    const frozenExpiryReason = frozenExecutionExpiryReason(frozenDecision);
    const resultMessage = frozenApproval
      ? frozenExpiryReason.summary
      : expiryOutcome.summary;
    const [updated] = await db
      .update(strategyExecutionTraces)
      .set({
        state: "EXPIRED",
        resultCode,
        resultMessage,
        entryEvidenceJson: JSON.stringify(entryEvidence),
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(strategyExecutionTraces.id, trace.id),
          inArray(strategyExecutionTraces.state, [...ANALYSIS_EXPIRABLE_STATES]),
          notLike(strategyExecutionTraces.traceId, "short-%"),
          lte(strategyExecutionTraces.expiresAt, now),
          or(
            isNull(strategyExecutionTraces.resultCode),
            ne(strategyExecutionTraces.resultCode, "SHORT_MONITOR_STATUS"),
          ),
        ),
      )
      .returning({ id: strategyExecutionTraces.id });
    if (!updated) continue;
    expired += 1;
    await appendEvent(trace.traceId, trace.strategyId, {
      eventType: resultCode,
      stage: frozenApproval ? "ORDER" : "SIGNAL",
      outcome: "REJECTED",
      message: resultMessage,
      detail: {
        monitorOnly: true,
        finalMarketFactEvaluationCompleted: true,
        executionDecisionWasFrozen: frozenApproval,
        executionExpiresAt:
          frozenExecutionDeadline === null
            ? null
            : new Date(frozenExecutionDeadline).toISOString(),
        lastWaitCode: frozenApproval
          ? frozenExpiryReason.lastWaitCode
          : null,
        lastWaitMessage: frozenApproval
          ? frozenExpiryReason.lastWaitMessage
          : null,
        ...expiryOutcome,
      },
      eventAt: now,
    });
  }
  return expired;
}

async function readPriorExpiredLifecycleMemory(input: {
  ownerEmail: string;
  accountId: string;
  strategyId: number;
  symbol: string;
  liquidationSide: "BUY" | "SELL";
  eventTime: Date;
}): Promise<NexusPriorLifecycleMemory | null> {
  const db = getDb();
  const windowStartedAt = new Date(input.eventTime.getTime() - 3 * 60 * 60_000);
  const rows = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      state: strategyExecutionTraces.state,
      resultCode: strategyExecutionTraces.resultCode,
      eventTime: strategyExecutionTraces.eventTime,
      completedAt: strategyExecutionTraces.completedAt,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.ownerEmail, input.ownerEmail),
        eq(strategyExecutionTraces.accountId, input.accountId),
        eq(strategyExecutionTraces.strategyId, input.strategyId),
        eq(strategyExecutionTraces.symbol, input.symbol),
        eq(strategyExecutionTraces.triggerKind, "LIQUIDATION_WINDOW"),
        eq(strategyExecutionTraces.liquidationSide, input.liquidationSide),
        eq(strategyExecutionTraces.state, "EXPIRED"),
        eq(strategyExecutionTraces.resultCode, "ANALYSIS_EXPIRED"),
        gte(strategyExecutionTraces.eventTime, windowStartedAt),
        lte(strategyExecutionTraces.eventTime, input.eventTime),
      ),
    )
    .orderBy(desc(strategyExecutionTraces.eventTime), desc(strategyExecutionTraces.id))
    .limit(5);
  for (const row of rows) {
    const memory = buildNexusPriorLifecycleMemory({
      sourceTraceId: row.traceId,
      sourceState: row.state,
      sourceResultCode: row.resultCode,
      sourceEventAt: row.eventTime,
      sourceCompletedAt: row.completedAt,
      entryEvidence: safeParse(row.entryEvidenceJson),
    });
    if (memory) return memory;
  }
  return null;
}

function runStrategyPendingEntryReconciliation() {
  // The dedicated runner schedules the next poll only after this request
  // completes. Keep the exchange I/O request-scoped instead of caching its
  // Promise globally.
  return reconcileStrategyPendingEntries({
    finalizeFilledEntry,
    appendEvent,
  });
}

export async function POST(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "内部爆仓监控凭据无效" }, { status: 401 });
  const requestUrl = new URL(request.url);
  const compactResponse = requestUrl.searchParams.get("compact") === "1";
  if (requestUrl.searchParams.get("mode") === "pending-entry")
    {
      const manualPendingEntries = await reconcileManualPendingEntries({
        writeAudit,
      });
      const pendingEntries = await runStrategyPendingEntryReconciliation();
      return Response.json({
        mode: "PENDING_ENTRY_RECONCILIATION",
        pendingEntries,
        manualPendingEntries,
        checkedAt: new Date().toISOString(),
      });
    }

  const pressureResponse = marketAnalysisPressureResponse();

  const db = getDb();
  const now = new Date();
  const pilot = pilotRuntime();
  const marketFactCycle = new NexusMarketFactCycle();
  const marketAnalysisCycle = new NexusMarketAnalysisCycle(
    nexusUnifiedMarketData,
    now.getTime(),
  );

  // Contract metadata is refreshed by the independent contract-data runner.
  // The strategy brain only reads the last completed cache and therefore
  // cannot be delayed by a full Binance universe request or hundreds of DB writes.
  const contractPoolSyncError: string | null = null;
  const runningStrategies = await db
    .select()
    .from(strategies)
    .where(
      and(
        inArray(strategies.strategyType, ["LIQ_CHASE", "SENTINEL"]),
        eq(strategies.brainTemplate, "NEXUS_MARKET_BRAIN"),
        eq(strategies.runtimeMode, "LIVE"),
        eq(strategies.status, "RUNNING"),
      ),
    );
  const triggerKinds = runningStrategies.flatMap((strategy) => {
    const resolved = resolveLiquidationTrendConfig(safeParse(strategy.configJson));
    return resolved.config ? [resolved.config.trigger.kind] : ["INVALID"];
  });
  const [activeNonRollingTrace] = await db
    .select({ id: strategyExecutionTraces.id })
    .from(strategyExecutionTraces)
    .where(and(
      inArray(strategyExecutionTraces.state, [...ACTIVE_STATES]),
      ne(strategyExecutionTraces.triggerKind, "THREE_MINUTE_PROBABILITY"),
    ))
    .limit(1);
  const marketWorkload = resolveMonitorMarketWorkload({
    triggerKinds,
    hasActiveNonRollingTrace: Boolean(activeNonRollingTrace),
  });
  if (monitorMemoryPressureBlocksAnalysis({
    pressureActive: Boolean(pressureResponse),
    workload: marketWorkload,
  })) return pressureResponse!;
  const [
    feed,
    activeSymbolRows,
    threeMinuteMarketSymbolRows,
    globalLiquidationContext,
  ] = await Promise.all([
    marketWorkload.loadLiquidationBackground
      // The proxy retains the maximum configurable five-minute cluster window.
      // Read it only when a liquidation lifecycle can still consume it.
      ? getBinanceLiveLiquidationEvents(0, LIQUIDATION_FEED_RECOVERY_WINDOW_MS)
      : Promise.resolve({ rows: [] }),
    db
      .select({
        symbol: contractSymbols.symbol,
        contractType: contractSymbols.contractType,
        quoteVolume24h: contractSymbols.quoteVolume24h,
        minOrderQty: contractSymbols.minOrderQty,
        quantityStep: contractSymbols.quantityStep,
        minNotionalUsdt: contractSymbols.minNotionalUsdt,
      })
      .from(contractSymbols)
      .where(eq(contractSymbols.isActive, true)),
    db
      .select({
        symbol: contractSymbols.symbol,
        contractType: contractSymbols.contractType,
        quoteVolume24h: contractSymbols.quoteVolume24h,
        minOrderQty: contractSymbols.minOrderQty,
        quantityStep: contractSymbols.quantityStep,
        minNotionalUsdt: contractSymbols.minNotionalUsdt,
      })
      .from(contractSymbols)
      .where(
        and(
          eq(contractSymbols.venue, "BINANCE"),
          eq(contractSymbols.environment, "LIVE"),
          eq(contractSymbols.market, "USDT_M"),
          eq(contractSymbols.listingGeneration, "CURRENT"),
        ),
      ),
    // It is background for liquidation analysis only; do not allocate it on
    // every rolling-probability evaluation.
    marketWorkload.loadLiquidationBackground
      ? getCoinGlassWebLiquidationContext()
      : Promise.resolve(null),
  ]);
  pruneLiquidationTriggerRuntimeState(runningStrategies);
  const runningAccountIds = [
    ...new Set(runningStrategies.map((strategy) => strategy.accountId)),
  ];
  const [
    analysisPositionRows,
    analysisOrderRows,
    analysisCredentialRows,
    globalSentinelProbeFeedback,
  ] = runningAccountIds.length
    ? await Promise.all([
        db
          .select({
            ownerEmail: livePositions.ownerEmail,
            accountId: livePositions.accountId,
            symbol: livePositions.symbol,
            positionSide: livePositions.positionSide,
            status: livePositions.status,
            quantity: livePositions.quantity,
            updatedAt: livePositions.updatedAt,
          })
          .from(livePositions)
          .where(
            and(
              inArray(livePositions.accountId, runningAccountIds),
              inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
            ),
          ),
        db
          .select({
            ownerEmail: liveOrderEvents.ownerEmail,
            accountId: liveOrderEvents.accountId,
            symbol: liveOrderEvents.symbol,
            positionSide: liveOrderEvents.positionSide,
            status: liveOrderEvents.status,
            updatedAt: liveOrderEvents.updatedAt,
          })
          .from(liveOrderEvents)
          .where(
            and(
              inArray(liveOrderEvents.accountId, runningAccountIds),
              inArray(liveOrderEvents.status, [
                "PENDING",
                "SUBMITTED",
                "NEW",
                "PARTIALLY_FILLED",
                "CANCEL_PENDING",
                "EXECUTION_UNKNOWN",
              ]),
            ),
          ),
        db
          .select({
            ownerEmail: exchangeCredentials.ownerEmail,
            accountId: exchangeCredentials.accountId,
            positionMode: exchangeCredentials.positionMode,
            totalMarginBalance: exchangeCredentials.totalMarginBalance,
            availableBalance: exchangeCredentials.availableBalance,
            balanceSyncedAt: exchangeCredentials.balanceSyncedAt,
          })
          .from(exchangeCredentials)
          .where(inArray(exchangeCredentials.accountId, runningAccountIds)),
        loadGlobalSentinelProbeFeedback(
          runningStrategies.map((strategy) => strategy.ownerEmail),
        ),
      ])
    : [[], [], [], []];
  const analysisOccupancy = buildEntryAnalysisOccupancySnapshot({
    positions: analysisPositionRows,
    orders: analysisOrderRows,
    nowMs: now.getTime(),
  });
  const positionModeByAccount = new Map(
    analysisCredentialRows.map((row) => [
      `${row.ownerEmail.trim().toLowerCase()}:${row.accountId.trim().toLowerCase()}`,
      row.positionMode ?? "ONE_WAY",
    ]),
  );
  const accountFundingByKey = new Map(
    analysisCredentialRows.map((row) => [
      `${row.ownerEmail.trim().toLowerCase()}:${row.accountId.trim().toLowerCase()}`,
      row,
    ]),
  );
  const activeSymbols = new Set(activeSymbolRows.map((item) => item.symbol));
  const activeContractTypes = new Map(
    activeSymbolRows.map((item) => [item.symbol, item.contractType]),
  );
  const activeQuoteVolumes24h = new Map(
    activeSymbolRows.map((item) => [item.symbol, item.quoteVolume24h]),
  );
  let signalMarkRows: Awaited<ReturnType<typeof getBinanceLiveMarkPrices>> = [];
  let signalMarkWait: string | null = null;
  const tradableFeedRows = feed.rows.filter((item) =>
    activeSymbols.has(item.symbol) &&
    isPrimaryLiquidityMarket(activeQuoteVolumes24h.get(item.symbol)),
  );
  if (feed.rows.length) {
    if (tradableFeedRows.length) {
      try {
        signalMarkRows = await getBinanceLiveMarkPrices([
          ...new Set(tradableFeedRows.map((item) => item.symbol)),
        ]);
      } catch (error) {
        if (!isTransientMarketDataWait(error)) throw error;
        // Keep the liquidation event and create its idempotent trace. Analysis
        // remains paused until a fresh centralized mark-price snapshot returns.
        signalMarkWait = error.message;
      }
    }
  }
  const signalMarks = new Map(
    signalMarkRows.map((item) => [item.symbol, item]),
  );
  const marketFactCapturedAt = Date.now();
  nexusMarketFactBuffer.addMany(
    [
      ...signalMarkRows.map((item) =>
        markPriceMarketFact({
          symbol: item.symbol,
          markPrice: item.markPrice,
          eventAt: item.time,
          receivedAt: item.receivedAt,
        }),
      ),
    ],
    marketFactCapturedAt,
  );
  let created = 0;
  let updated = 0;
  const rejected = 0;
  let ignored = 0;
  let cooldownSuppressed = 0;
  let occupiedPositionSuppressed = 0;
  let workingOrderSuppressed = 0;
  const triggerDiagnostics: LiquidationTriggerDiagnostic[] = [];
  const lowPositionTriggerDiagnostics: LowPositionTriggerDiagnostic[] = [];
  const threeMinuteProbabilityDiagnostics: ThreeMinuteProbabilityDiagnostic[] = [];
  const marketStructureTriggerDiagnostics: MarketStructureTriggerDiagnostic[] = [];
  const threeMinuteQueueDepthAtStart =
    await readThreeMinuteCandidateQueueDepth(now);
  let threeMinuteQueueDepth = threeMinuteQueueDepthAtStart;
  let threeMinuteQueueEnqueued = 0;
  let threeMinuteQueueFullSuppressed = 0;
  let threeMinuteQueuePreempted = 0;
  let threeMinuteQueueAdmissionRemaining =
    planThreeMinuteCandidateQueueAdmission(
      threeMinuteQueueDepthAtStart,
    ).admissionLimit;

  const preemptWeakestThreeMinuteCandidate = async (
    incomingPriority: number,
  ) => {
    if (threeMinuteQueuePreempted >= THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH)
      return false;
    const candidates = await db
      .select({
        id: strategyExecutionTraces.id,
        traceId: strategyExecutionTraces.traceId,
        strategyId: strategyExecutionTraces.strategyId,
        symbol: strategyExecutionTraces.symbol,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
      })
      .from(strategyExecutionTraces)
      .where(and(
        eq(
          strategyExecutionTraces.triggerKind,
          "THREE_MINUTE_PROBABILITY",
        ),
        inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
        gt(strategyExecutionTraces.expiresAt, now),
      ))
      .limit(THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY);
    const weakest = candidates
      .map((candidate) => {
        const evidence = asRecord(safeParse(candidate.entryEvidenceJson));
        const storedPriority = Number(evidence.threeMinuteOpportunityPriority);
        return {
          ...candidate,
          priority: Number.isFinite(storedPriority)
            ? storedPriority
            : Number.NEGATIVE_INFINITY,
        };
      })
      .sort((left, right) =>
        left.priority - right.priority || left.id - right.id
      )[0];
    if (
      !weakest ||
      !threeMinuteOpportunityShouldPreempt({
        incomingPriority,
        weakestPriority: weakest.priority,
      })
    ) return false;
    const preempted = await db
      .update(strategyExecutionTraces)
      .set({
        state: "CANCELED",
        resultCode: "SUPERSEDED_BY_HIGHER_PRIORITY_CANDIDATE",
        resultMessage:
          "尚未确认的较弱3分钟候选已被最新、更强且未过期的全市场机会替换",
        completedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(strategyExecutionTraces.id, weakest.id),
        inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
      ))
      .returning({ id: strategyExecutionTraces.id });
    if (!preempted.length) return false;
    for (const board of threeMinuteOpportunityBoardByStrategy.values())
      board.remove(weakest.symbol);
    threeMinuteQueuePreempted += 1;
    try {
      await appendEvent(weakest.traceId, weakest.strategyId, {
        eventType: "THREE_MINUTE_CANDIDATE_PREEMPTED",
        stage: "SIGNAL",
        outcome: "INFO",
        message:
          `${weakest.symbol} 尚未取得直接概率执行权，已释放候选格给更强机会`,
        detail: {
          weakestPriority: weakest.priority,
          incomingPriority,
          preemptionMargin: incomingPriority - weakest.priority,
          orderReadyCandidateProtected: true,
        },
        eventAt: now,
      });
    } catch {
      // The state transition is authoritative. Observability must not block
      // the replacement of an unconfirmed stale candidate.
    }
    return true;
  };

  let analysis: Awaited<ReturnType<typeof evaluateActiveTraces>> = {
    checked: 0,
    ready: 0,
    pending: 0,
    rejected: 0,
    errors: 0,
    marketDataWait: false,
    marketDataWaitReason: null,
  };
  let expired = 0;
  const persistMarketStructureWake = async (input: {
    strategy: (typeof runningStrategies)[number];
    config: LiquidationTrendConfig;
    wake: StrategyTriggerWake;
    directionWakes?: readonly StrategyTriggerWake[];
    nexusArchitecture: ReturnType<typeof resolveNexusTradingArchitecture>;
    entryTimingProfile: ReturnType<typeof resolveStrategyEntryTimingProfile>;
  }) => {
    const directionWakes = input.directionWakes?.length
      ? [...input.directionWakes]
      : [input.wake];
    const competingDirections = directionWakes.length === 2;
    const positionMode = positionModeByAccount.get(
      `${input.strategy.ownerEmail.trim().toLowerCase()}:${input.strategy.accountId.trim().toLowerCase()}`,
    ) ?? "ONE_WAY";
    for (const directionWake of directionWakes) {
      const occupancyReason = entryAnalysisOccupancyReason(analysisOccupancy, {
        ownerEmail: input.strategy.ownerEmail,
        accountId: input.strategy.accountId,
        symbol: input.wake.symbol,
        positionSide: directionWake.direction,
        positionMode,
      });
      const occupancyBlockedByStrategy = occupancyReason === "OPEN_POSITION"
        ? input.config.execution.existingPositionPolicy !== "ALLOW_SAME_DIRECTION"
        : occupancyReason === "WORKING_ORDER"
          ? input.config.execution.sameLegWorkingOrderPolicy !== "ALLOW"
          : false;
      if (
        occupancyBlockedByStrategy &&
        input.strategy.strategyType !== "SENTINEL"
      ) return occupancyReason;
    }

    const [alreadyHandled] = await db
      .select({ id: strategyExecutionTraces.id })
      .from(strategyExecutionTraces)
      .where(eq(strategyExecutionTraces.traceId, input.wake.wakeId))
      .limit(1);
    if (alreadyHandled) return "DUPLICATE" as const;
    const latestTrace = await db
      .select({
        state: strategyExecutionTraces.state,
        createdAt: strategyExecutionTraces.createdAt,
        expiresAt: strategyExecutionTraces.expiresAt,
      })
      .from(strategyExecutionTraces)
      .where(and(
        eq(strategyExecutionTraces.ownerEmail, input.strategy.ownerEmail),
        eq(strategyExecutionTraces.accountId, input.strategy.accountId),
        eq(strategyExecutionTraces.strategyId, input.strategy.id),
        eq(strategyExecutionTraces.symbol, input.wake.symbol),
        eq(strategyExecutionTraces.triggerKind, input.wake.triggerKind),
        ...(competingDirections
          ? []
          : [eq(
              strategyExecutionTraces.triggerDirection,
              input.wake.direction,
            )]),
      ))
      .orderBy(desc(strategyExecutionTraces.id))
      .limit(1)
      .then((rows) => rows[0]);
    if (
      latestTrace &&
      ACTIVE_STATE_SET.has(latestTrace.state) &&
      latestTrace.expiresAt.getTime() > now.getTime()
    ) return "ACTIVE_ANALYSIS" as const;
    if (
      latestTrace &&
      latestTrace.createdAt.getTime() >=
        now.getTime() - input.config.trigger.cooldownMinutes * 60_000
    ) return "COOLDOWN" as const;

    const marketSide = input.wake.direction === "LONG" ? "SELL" : "BUY";
    const triggerSeedFacts = directionWakes.flatMap((directionWake) =>
      strategyWakeEvidenceFacts({
        wakeId: directionWake.wakeId,
        triggerKind: directionWake.triggerKind,
        symbol: directionWake.symbol,
        direction: directionWake.direction,
        referencePrice: directionWake.referencePrice,
        eventAt: directionWake.eventAt,
        receivedAt: directionWake.receivedAt,
        expiresAt: directionWake.expiresAt,
        evidence: directionWake.evidence,
      })
    );
    const triggerFact = triggerSeedFacts[0];
    const markFact = markPriceMarketFact({
      symbol: input.wake.symbol,
      markPrice: input.wake.referencePrice,
      eventAt: input.wake.eventAt,
      receivedAt: input.wake.receivedAt,
    });
    const triggerFacts = [...triggerSeedFacts, markFact];
    nexusMarketFactBuffer.addMany(triggerFacts, now.getTime());
    const primaryMachine = input.wake.direction === "SHORT"
      ? "DOWNTREND_CONTINUATION" as const
      : "SUPPORT_REVERSAL" as const;
    const nexusOpportunity = {
      version: "nexus-structure-wake-opportunity-v1",
      triggerKind: input.wake.triggerKind,
      direction: input.wake.direction,
      primaryMachine,
      secondaryMachine: "TREND_BREAKOUT" as const,
      orderAffecting: false as const,
    };
    const nexusBrainShadow = deriveNexusBrainShadowState({
      direction: input.wake.direction,
      triggerFactId: triggerFact.id,
      facts: triggerFacts,
      now: now.getTime(),
    });
    const nexusPureStateMachine = replayNexusPureStateMachine({
      machine: primaryMachine,
      direction: input.wake.direction,
      symbol: input.wake.symbol,
      triggerFactId: triggerFact.id,
      facts: triggerFacts,
      now: now.getTime(),
    });
    const nexusTrendBreakoutStateMachine = replayNexusPureStateMachine({
      machine: "TREND_BREAKOUT",
      direction: input.wake.direction,
      symbol: input.wake.symbol,
      triggerFactId: triggerFact.id,
      facts: triggerFacts,
      now: now.getTime(),
    });
    const globalSentinelObservation = buildGlobalSentinelObservation({
      ownerEmail: input.strategy.ownerEmail,
      observerAccountId: input.strategy.accountId,
      symbol: input.wake.symbol,
      positionSide: input.wake.direction,
      observedAt: now.getTime(),
      positions: analysisPositionRows,
      orders: analysisOrderRows,
      probeFeedback: globalSentinelProbeFeedback,
    });
    const [trace] = await db.insert(strategyExecutionTraces).values({
      traceId: input.wake.wakeId,
      strategyId: input.strategy.id,
      strategyRunId: `monitor-${now.toISOString().slice(0, 10)}`,
      configVersion: input.strategy.configVersion,
      ownerEmail: input.strategy.ownerEmail,
      accountId: input.strategy.accountId,
      symbol: input.wake.symbol,
      triggerKind: input.wake.triggerKind,
      triggerVersion: input.wake.triggerVersion,
      triggerDirection: input.wake.direction,
      triggerReferencePrice: input.wake.referencePrice,
      triggerFactSnapshotId: input.wake.factSnapshotId,
      triggerSourceId: input.wake.sourceId,
      liquidationSide: marketSide,
      liquidationPrice: input.wake.referencePrice,
      liquidationNotional: 0,
      eventTime: new Date(input.wake.eventAt),
      receivedAt: new Date(input.wake.receivedAt),
      expiresAt: new Date(input.wake.expiresAt),
      state: "ANALYZING",
      resultCode: null,
      resultMessage: null,
      configSnapshotJson: JSON.stringify(input.config),
      entryEvidenceJson: JSON.stringify({
        symbol: input.wake.symbol,
        brainKey: input.strategy.brainKey,
        nexusArchitecture: input.nexusArchitecture,
        entryTimingProfile: input.entryTimingProfile,
        triggerIdentity: {
          version: input.wake.version,
          wakeId: input.wake.wakeId,
          triggerKind: input.wake.triggerKind,
          triggerVersion: input.wake.triggerVersion,
          direction: input.wake.direction,
          factSnapshotId: input.wake.factSnapshotId,
          sourceId: input.wake.sourceId,
          referencePrice: input.wake.referencePrice,
          eventAt: input.wake.eventAt,
          receivedAt: input.wake.receivedAt,
          expiresAt: input.wake.expiresAt,
          canAuthorizeOrder: false,
        },
        ...(competingDirections
          ? {
              directionDecisionPending: true,
              directionTriggerIdentities: directionWakes.map(
                (directionWake) => ({
                  wakeId: directionWake.wakeId,
                  direction: directionWake.direction,
                  factSnapshotId: directionWake.factSnapshotId,
                  sourceId: directionWake.sourceId,
                  eventAt: directionWake.eventAt,
                  receivedAt: directionWake.receivedAt,
                  expiresAt: directionWake.expiresAt,
                  canAuthorizeOrder: false,
                }),
              ),
            }
          : {}),
        strategyTriggerEvidence: input.wake.evidence,
        marketClusterId: input.wake.factSnapshotId,
        marketClusterType: input.wake.triggerKind,
        brainDecisionDirection: input.wake.direction,
        tradeDirection: input.wake.direction,
        executionDirection: resolveStrategyExecutionDirection({
          mode: input.config.execution.directionMode,
          brainDirection: input.wake.direction,
        }),
        sentinelAdvisoryOnly: input.strategy.strategyType === "SENTINEL",
        sentinelExposure: globalSentinelObservation.sameDirectionExposure,
        globalSentinelObservation,
        decisionEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
        signalMarkPrice: input.wake.referencePrice,
        signalMarkTime: input.wake.eventAt,
        signalMarkSource: "UNIFIED_TRIGGER_FACT",
        nexusTriggerFact: triggerFact,
        nexusOpportunity,
        nexusMarketFactsShadow: triggerFacts,
        nexusBrainShadow,
        nexusPureStateMachine,
        nexusTrendBreakoutStateMachine,
      }),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }).onConflictDoNothing().returning();
    if (!trace) return "DUPLICATE" as const;
    const bookEyePrewarmReady = await warmNexusBookTicker(input.wake.symbol);
    const orderSubmissionAllowed =
      pilot.enabled && input.strategy.strategyType !== "SENTINEL";
    await appendEvent(input.wake.wakeId, input.strategy.id, {
      eventType: `${input.wake.triggerKind}_WAKE_RECEIVED`,
      stage: "SIGNAL",
      outcome: "PASSED",
      message:
        `${input.wake.symbol} ${input.wake.direction === "LONG" ? "做多" : "做空"}候选` +
        `已由${input.wake.triggerKind}触发并进入统一大脑复核`,
      detail: {
        ...input.wake.evidence,
        triggerOnly: true,
        canAuthorizeOrder: false,
        bookEyePrewarm: bookEyePrewarmReady ? "READY" : "SUBSCRIBING",
        monitorOnly: !orderSubmissionAllowed,
        orderSubmissionAllowed,
      },
      eventAt: new Date(input.wake.eventAt),
    });
    return "CREATED" as const;
  };
  try {
  // Persisted ANALYZING/ARMED rows are the official candidate queue. Consume
  // them before doing another whole-market scan so a main-app restart resumes
  // accepted work immediately instead of waiting behind new market analysis.
  if (threeMinuteQueueDepthAtStart > 0) {
    analysis = await evaluateActiveTraces(
      marketFactCycle,
      marketAnalysisCycle,
    );
    threeMinuteQueueDepth = await readThreeMinuteCandidateQueueDepth(
      new Date(),
    );
    threeMinuteQueueAdmissionRemaining =
      planThreeMinuteCandidateQueueAdmission(
        threeMinuteQueueDepth,
      ).admissionLimit;
  }
  for (const strategy of runningStrategies) {
    const triggerStateKey = triggerRuntimeStateKey(strategy);
    const resolved = resolveLiquidationTrendConfig(
      safeParse(strategy.configJson),
    );
    if (!resolved.config) {
      ignored += feed.rows.length;
      continue;
    }
    const config = resolved.config;
    const strategyActiveSymbolRows = config.trigger.kind ===
        "THREE_MINUTE_PROBABILITY"
      ? activeSymbolRows
      : filterContractsByStrategyAssetScope({
          contracts: activeSymbolRows,
          scope: config.assetClassScope ?? "ALL",
          selectedSymbols: config.selectedSymbols,
        });
    const strategyActiveSymbols = new Set(
      strategyActiveSymbolRows.map((row) => row.symbol),
    );
    if (
      config.direction === "SHORT_ONLY" &&
      !MARKET_STRUCTURE_TRIGGER_KINDS.has(
        config.trigger.kind as "GRID_PRICE_LEVEL" | "SCHEDULED_SCAN" | "BREAKOUT_RETEST",
      )
    ) {
      ignored += feed.rows.length;
      continue;
    }
    const nexusArchitecture = resolveNexusTradingArchitecture({
      config,
      strategyType: strategy.strategyType,
    });
    if (config.marketProfile?.mode === "RELATIVE_STRENGTH") continue;
    const entryTimingProfile = resolveStrategyEntryTimingProfile({
      config,
      strategyType: strategy.strategyType,
    });
    if (config.trigger.kind === "THREE_MINUTE_PROBABILITY") {
      const roundConfig = config.trigger.threeMinuteProbability;
      if (!roundConfig) {
        ignored += 1;
        continue;
      }
      const round = threeMinuteRoundAt(now.getTime());
      const lastEvaluatedAt = threeMinuteLastEvaluationAtByStrategy.get(
        triggerStateKey,
      );
      if (!threeMinuteRollingEvaluationDue({
        nowMs: now.getTime(),
        lastEvaluatedAtMs: lastEvaluatedAt,
        cadenceSeconds: roundConfig.evaluationCadenceSeconds,
      })) {
        threeMinuteProbabilityDiagnostics.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          triggerKind: "THREE_MINUTE_PROBABILITY",
          roundId: round.roundId,
          roundEndsAt: new Date(round.endsAt).toISOString(),
          scannedSymbols: [],
          prefilteredSymbols: [],
          skippedUnsupportedSymbols: [],
          candidateCount: 0,
          createdCount: 0,
          cacheErrors: [],
          skippedReason:
            `距上次滚动评估不足 ${roundConfig.evaluationCadenceSeconds} 秒，保留最新事实等待下一次复核`,
        });
        continue;
      }
      threeMinuteLastEvaluationAtByStrategy.set(triggerStateKey, now.getTime());
      // Discovery rotates over every currently listed Binance USDT-M contract.
      // The active contract pool remains the execution allow-list, so scanning
      // never revives a retired, low-liquidity or manually excluded contract.
      const selectedSymbols = new Set<string>();
      const contractExecutionRuleBySymbol = new Map(
        strategyActiveSymbolRows.map((row) => [row.symbol, row]),
      );
      const accountFunding = accountFundingByKey.get(
        `${strategy.ownerEmail.trim().toLowerCase()}:${strategy.accountId.trim().toLowerCase()}`,
      );
      const previousWarmSymbols =
        threeMinuteWarmSymbolsByStrategy.get(triggerStateKey) ?? [];
      const warmSymbols = (
        previousWarmSymbols.length
          ? previousWarmSymbols
          : selectedSymbols.size
            ? [...selectedSymbols]
            : threeMinuteMarketSymbolRows
              .map((row) => row.symbol)
              .slice(0, Math.max(1, roundConfig.maxCandidatesPerRound * 2))
      ).slice(0, 20);
      if (warmSymbols.length)
        await getNexusLiveOrderFlow(warmSymbols).catch(() => null);
      const scanSymbols = threeMinuteMarketSymbolRows
        .map((row) => row.symbol)
        .filter((symbol) => !selectedSymbols.size || selectedSymbols.has(symbol));
      let runtime;
      try {
        runtime = await evaluateThreeMinuteProbabilityRuntime({
          marketData: nexusUnifiedMarketData,
          loadMarks: async (symbols) =>
            (await getBinanceLiveMarkPrices(symbols, {
              includeHistory: true,
            })).map((mark) => ({
              symbol: mark.symbol,
              markPrice: mark.markPrice,
              eventAt: mark.time,
              receivedAt: mark.receivedAt,
              history: mark.history,
            })),
          loadOrderFlow: getNexusLiveOrderFlow,
          learningEnabled: false,
          evaluateEntryFeasibility: ({ symbol, referencePrice }) => {
            const rule = contractExecutionRuleBySymbol.get(symbol);
            const balanceAgeMs = accountFunding?.balanceSyncedAt
              ? now.getTime() - accountFunding.balanceSyncedAt.getTime()
              : Number.POSITIVE_INFINITY;
            const availableBalance = Number(accountFunding?.availableBalance);
            const funding = accountFundingSnapshot(
              accountFunding ?? {},
              now.getTime(),
            );
            const sizingCapitalUsdt =
              automatedEntryEquitySizingCapitalUsdt(funding);
            const availableMarginUsdt = Number.isFinite(availableBalance)
              ? Math.max(0, availableBalance)
              : 0;
            if (!rule || balanceAgeMs > 120_000 || sizingCapitalUsdt <= 0)
              return {
                executable: true,
                reason: "EXECUTION_PREFLIGHT_DATA_UNAVAILABLE",
              };
            const equityAllocationPercent =
              config.execution.equityAllocationPercent ?? 5;
            const availableTargetMarginUsdt = Math.min(
              config.execution.maxOrderNotionalUsdt,
              sizingCapitalUsdt * equityAllocationPercent / 100,
              availableMarginUsdt,
            );
            const sizing = capRiskSizedEntryToConfiguredMargin({
              riskSizedQuantity: 0,
              entryPrice: referencePrice,
              leverage: config.execution.leverage,
              minOrderQty: rule.minOrderQty,
              quantityStep: rule.quantityStep,
              minNotionalUsdt: rule.minNotionalUsdt,
              targetMarginUsdt: config.execution.targetOrderNotionalUsdt,
              maxOrderMarginUsdt: config.execution.maxOrderNotionalUsdt,
              sizingCapitalUsdt,
              equityAllocationPercent,
              minimumPositionNotionalUsdt:
                config.execution.minimumPositionNotionalUsdt ?? 15,
              explorationProbe: true,
              marketOrder: config.execution.orderType !== "LIMIT_OFFSET",
              minimumOrderQuantityMultiplier: 1,
            });
            return sizing &&
              sizing.requiredMarginUsdt <= availableMarginUsdt + 1e-10
              ? {
                  executable: true,
                  reason: "EXECUTION_PREFLIGHT_READY",
                  requiredMarginUsdt: sizing.requiredMarginUsdt,
                  availableTargetMarginUsdt,
                }
              : {
                  executable: false,
                  reason: sizing
                    ? "BINANCE_AVAILABLE_MARGIN_INSUFFICIENT"
                    : "MINIMUM_ORDER_EXCEEDS_STRATEGY_CAPITAL_ALLOCATION",
                  requiredMarginUsdt:
                    Math.max(
                      rule.minOrderQty * referencePrice,
                      rule.minNotionalUsdt,
                      config.execution.minimumPositionNotionalUsdt ?? 15,
                    ) / Math.max(config.execution.leverage, 1),
                  availableTargetMarginUsdt,
                };
          },
          symbols: scanSymbols,
          explicitSymbolScope: selectedSymbols.size > 0,
          scanCursor: threeMinuteScanCursorByStrategy.get(triggerStateKey) ?? 0,
          scanBatchSize: THREE_MINUTE_MARKET_SCAN_BATCH,
          maximumCandidates: THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH,
          candidateDiscoveryLimit: THREE_MINUTE_CANDIDATE_DISCOVERY_BATCH,
          minimumProbabilityPercent: roundConfig.minimumProbabilityPercent,
          minimumNetEdgeBps: roundConfig.minimumNetEdgeBps,
          estimatedRoundTripFeeBps: roundConfig.estimatedRoundTripFeeBps,
          estimatedSlippageBps: roundConfig.estimatedSlippageBps,
          maxFactAgeMs: roundConfig.maxFactAgeMs,
          calibrationRounds: roundConfig.calibrationRounds,
          calibrationMode: roundConfig.calibrationMode,
          negativeExpectancyMode: roundConfig.negativeExpectancyMode,
          batchSize: roundConfig.batchSize,
          analysisValiditySeconds: config.trigger.analysisValiditySeconds,
          strategyId: strategy.id,
          configVersion: strategy.configVersion,
          ownerEmail: strategy.ownerEmail,
          accountId: strategy.accountId,
          now: now.getTime(),
        });
      } catch (error) {
        const failure = threeMinuteRoundFailureDiagnostic(error);
        threeMinuteProbabilityDiagnostics.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          triggerKind: "THREE_MINUTE_PROBABILITY",
          roundId: round.roundId,
          roundEndsAt: new Date(round.endsAt).toISOString(),
          scannedSymbols: [],
          prefilteredSymbols: [],
          skippedUnsupportedSymbols: [],
          candidateCount: 0,
          createdCount: 0,
          cacheErrors: [{
            symbol: "--",
            interval: "--",
            message: failure.error,
          }],
          skippedReason: "本轮事实未能完整冻结",
        });
        await upsertThreeMinuteRoundStatus({
          strategy,
          config,
          runtime: null,
          round,
          runtimeError: failure.message,
          createdCount: 0,
          occupiedPositionSuppressed: 0,
          workingOrderSuppressed: 0,
          checkedAt: now,
        });
        continue;
      }
      threeMinuteScanCursorByStrategy.set(triggerStateKey, runtime.nextScanCursor);
      if (runtime.prefilteredSymbols.length)
        threeMinuteWarmSymbolsByStrategy.set(
          triggerStateKey,
          runtime.prefilteredSymbols.slice(0, 20),
        );
      let opportunityBoard = threeMinuteOpportunityBoardByStrategy.get(
        triggerStateKey,
      );
      if (!opportunityBoard) {
        opportunityBoard = new ThreeMinuteOpportunityBoard();
        threeMinuteOpportunityBoardByStrategy.set(
          triggerStateKey,
          opportunityBoard,
        );
      }
      const rankedOpportunities = opportunityBoard.refresh(
        runtime.wakes,
        now.getTime(),
      );
      let roundCreated = 0;
      let roundOccupiedPositionSuppressed = 0;
      let roundWorkingOrderSuppressed = 0;
      for (const opportunity of rankedOpportunities) {
        const wake = opportunity.wake;
        if (threeMinuteQueueAdmissionRemaining <= 0) {
          const preempted = await preemptWeakestThreeMinuteCandidate(
            opportunity.priority,
          );
          if (!preempted) {
            threeMinuteQueueFullSuppressed += 1;
            continue;
          }
          threeMinuteQueueDepth = Math.max(0, threeMinuteQueueDepth - 1);
          threeMinuteQueueAdmissionRemaining = 1;
        }
        const positionSide = wake.direction;
        const occupancyReason = entryAnalysisOccupancyReason(analysisOccupancy, {
          ownerEmail: strategy.ownerEmail,
          accountId: strategy.accountId,
          symbol: wake.symbol,
          positionSide,
          positionMode: positionModeByAccount.get(
            `${strategy.ownerEmail.trim().toLowerCase()}:${strategy.accountId.trim().toLowerCase()}`,
          ) ?? "ONE_WAY",
        });
        if (occupancyReason) {
          ignored += 1;
          if (occupancyReason === "OPEN_POSITION") {
            occupiedPositionSuppressed += 1;
            roundOccupiedPositionSuppressed += 1;
          } else {
            workingOrderSuppressed += 1;
            roundWorkingOrderSuppressed += 1;
          }
          opportunityBoard.remove(wake.symbol);
          continue;
        }
        const evidence = asRecord(wake.evidence);
        const roundId = String(evidence.roundId ?? runtime.round.roundId);
        const traceId = `rolling-${wake.wakeId}`;
        const [activeSameSymbolCandidate] = await db
          .select({ id: strategyExecutionTraces.id })
          .from(strategyExecutionTraces)
          .where(and(
            eq(strategyExecutionTraces.strategyId, strategy.id),
            eq(strategyExecutionTraces.symbol, wake.symbol),
            eq(
              strategyExecutionTraces.triggerKind,
              "THREE_MINUTE_PROBABILITY",
            ),
            inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
            gt(strategyExecutionTraces.expiresAt, now),
          ))
          .limit(1);
        if (activeSameSymbolCandidate) {
          opportunityBoard.remove(wake.symbol);
          continue;
        }
        const [alreadyHandled] = await db
          .select({ id: strategyExecutionTraces.id })
          .from(strategyExecutionTraces)
          .where(eq(strategyExecutionTraces.traceId, traceId))
          .limit(1);
        if (alreadyHandled) {
          opportunityBoard.remove(wake.symbol);
          continue;
        }
        const triggerFact = marketStructureWakeFact({
          id: traceId,
          symbol: wake.symbol,
          side: wake.direction === "LONG" ? "SELL" : "BUY",
          eventAt: wake.eventAt,
          receivedAt: wake.receivedAt,
          expiresAt: wake.expiresAt,
          referencePrice: wake.referencePrice,
          position72hPercent: 50,
          relativeVolume5m: null,
          structureCode: `THREE_MINUTE_PROBABILITY_${wake.direction}`,
        });
        const markFact = markPriceMarketFact({
          symbol: wake.symbol,
          markPrice: wake.referencePrice,
          eventAt: wake.eventAt,
          receivedAt: wake.receivedAt,
        });
        const triggerFacts = [markFact, triggerFact];
        nexusMarketFactBuffer.addMany(triggerFacts, now.getTime());
        const primaryMachine = wake.direction === "LONG"
          ? "SUPPORT_REVERSAL" as const
          : "DOWNTREND_CONTINUATION" as const;
        const secondaryMachine = "TREND_BREAKOUT" as const;
        const nexusOpportunity = {
          version: "nexus-three-minute-probability-opportunity-v1",
          triggerKind: "THREE_MINUTE_PROBABILITY",
          direction: wake.direction,
          primaryMachine,
          secondaryMachine,
          orderAffecting: false,
        };
        const nexusBrainShadow = deriveNexusBrainShadowState({
          direction: wake.direction,
          triggerFactId: triggerFact.id,
          facts: triggerFacts,
          now: now.getTime(),
        });
        const nexusPureStateMachine = replayNexusPureStateMachine({
          machine: primaryMachine,
          direction: wake.direction,
          symbol: wake.symbol,
          triggerFactId: triggerFact.id,
          facts: triggerFacts,
          now: now.getTime(),
        });
        const nexusTrendBreakoutStateMachine = replayNexusPureStateMachine({
          machine: secondaryMachine,
          direction: wake.direction,
          symbol: wake.symbol,
          triggerFactId: triggerFact.id,
          facts: triggerFacts,
          now: now.getTime(),
        });
        const globalSentinelObservation = buildGlobalSentinelObservation({
          ownerEmail: strategy.ownerEmail,
          observerAccountId: strategy.accountId,
          symbol: wake.symbol,
          positionSide,
          observedAt: now.getTime(),
          positions: analysisPositionRows,
          orders: analysisOrderRows,
          probeFeedback: globalSentinelProbeFeedback,
        });
        const [trace] = await db.insert(strategyExecutionTraces).values({
          traceId,
          strategyId: strategy.id,
          strategyRunId: `3m-rolling-${wake.eventAt}`,
          configVersion: strategy.configVersion,
          ownerEmail: strategy.ownerEmail,
          accountId: strategy.accountId,
          symbol: wake.symbol,
          triggerKind: wake.triggerKind,
          triggerVersion: wake.triggerVersion,
          triggerDirection: wake.direction,
          triggerReferencePrice: wake.referencePrice,
          triggerFactSnapshotId: wake.factSnapshotId,
          triggerSourceId: wake.sourceId,
          liquidationSide: wake.direction === "LONG" ? "SELL" : "BUY",
          liquidationPrice: wake.referencePrice,
          liquidationNotional: 0,
          eventTime: new Date(wake.eventAt),
          receivedAt: new Date(wake.receivedAt),
          expiresAt: new Date(wake.expiresAt),
          state: "ANALYZING",
          resultCode: null,
          resultMessage: null,
          configSnapshotJson: JSON.stringify(config),
          entryEvidenceJson: JSON.stringify({
            symbol: wake.symbol,
            nexusArchitecture,
            entryTimingProfile,
            triggerIdentity: {
              version: wake.version,
              wakeId: wake.wakeId,
              traceId,
              triggerKind: wake.triggerKind,
              triggerVersion: wake.triggerVersion,
              direction: wake.direction,
              factSnapshotId: wake.factSnapshotId,
              sourceId: wake.sourceId,
              referencePrice: wake.referencePrice,
              eventAt: wake.eventAt,
              receivedAt: wake.receivedAt,
              expiresAt: wake.expiresAt,
              canAuthorizeOrder: false,
            },
            threeMinuteProbability: evidence,
            threeMinuteOpportunityPriority: opportunity.priority,
            roundId,
            roundStartedAt: evidence.roundStartedAt,
            roundEndsAt: evidence.roundEndsAt,
            modelVersion: evidence.modelVersion,
            marketClusterId:
              `${strategy.id}:${strategy.configVersion}:${roundId}:${wake.factSnapshotId}`,
            marketClusterType: "THREE_MINUTE_PROBABILITY",
            brainDecisionDirection: wake.direction,
            tradeDirection: wake.direction,
            executionDirection: resolveStrategyExecutionDirection({
              mode: config.execution.directionMode,
              brainDirection: wake.direction,
            }),
            sentinelAdvisoryOnly: false,
            sentinelExposure: globalSentinelObservation.sameDirectionExposure,
            globalSentinelObservation,
            decisionEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
            signalMarkPrice: wake.referencePrice,
            signalMarkTime: wake.eventAt,
            signalMarkSource: "CENTRAL_WEBSOCKET_MARK_PRICE",
            nexusTriggerFact: triggerFact,
            nexusOpportunity,
            nexusMarketFactsShadow: triggerFacts,
            nexusBrainShadow,
            nexusPureStateMachine,
            nexusTrendBreakoutStateMachine,
          }),
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        }).onConflictDoNothing().returning();
        if (!trace) {
          opportunityBoard.remove(wake.symbol);
          continue;
        }
        opportunityBoard.remove(wake.symbol);
        await Promise.all([
          warmNexusBookTicker(wake.symbol),
          getBinanceLiveMarkPrices([wake.symbol], { includeHistory: true })
            .catch(() => []),
        ]);
        created += 1;
        roundCreated += 1;
        threeMinuteQueueDepth += 1;
        threeMinuteQueueEnqueued += 1;
        threeMinuteQueueAdmissionRemaining -= 1;
        const queueAdmission = planThreeMinuteCandidateQueueAdmission(
          threeMinuteQueueDepth,
        );
        await appendEvent(traceId, strategy.id, {
          eventType: "THREE_MINUTE_PROBABILITY_WAKE_RECEIVED",
          stage: "SIGNAL",
          outcome: "PASSED",
          message:
            `${wake.symbol} ${wake.direction === "LONG" ? "做多" : "做空"} ` +
            `概率 ${Number(
              wake.direction === "LONG"
                ? evidence.pLongPercent
                : evidence.pShortPercent,
            ).toFixed(2)}%，已进入直接概率执行`,
          detail: {
            ...evidence,
            triggerOnly: true,
            canAuthorizeOrder: false,
            timeExitSeconds:
              config.trigger.threeMinuteProbability?.timeExitSeconds ?? 300,
            evaluationCadenceSeconds:
              config.trigger.threeMinuteProbability
                ?.evaluationCadenceSeconds ?? 9,
          },
          eventAt: new Date(wake.eventAt),
        });
        if (queueAdmission.full)
          await appendEvent(traceId, strategy.id, {
            eventType: "THREE_MINUTE_CANDIDATE_QUEUE_FULL",
            stage: "SIGNAL",
            outcome: "INFO",
            message:
              "3分钟候选队列已达到12格；全市场扫描继续轮转，待消费后自动补位",
            detail: {
              capacity: THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY,
              enqueueBatch: THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH,
              discoveryBatch: THREE_MINUTE_CANDIDATE_DISCOVERY_BATCH,
              scanBatch: THREE_MINUTE_MARKET_SCAN_BATCH,
              queuedCount: threeMinuteQueueDepth,
              scanningContinues: true,
            },
            eventAt: new Date(),
          });
      }
      threeMinuteProbabilityDiagnostics.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        triggerKind: "THREE_MINUTE_PROBABILITY",
        roundId: runtime.round.roundId,
        roundEndsAt: new Date(runtime.round.endsAt).toISOString(),
        scannedSymbols: runtime.scannedSymbols,
        prefilteredSymbols: runtime.prefilteredSymbols,
        skippedUnsupportedSymbols: runtime.skippedUnsupportedSymbols,
        executionInfeasibleSymbols: runtime.executionInfeasibleSymbols,
        candidateCount: runtime.wakes.length,
        createdCount: roundCreated,
        cacheErrors: runtime.cacheErrors,
        skippedReason: null,
      });
      await upsertThreeMinuteRoundStatus({
        strategy,
        config,
        runtime,
        round: runtime.round,
        runtimeError: null,
        createdCount: roundCreated,
        occupiedPositionSuppressed: roundOccupiedPositionSuppressed,
        workingOrderSuppressed: roundWorkingOrderSuppressed,
        checkedAt: now,
      });
      continue;
    }
    if (config.trigger.kind === "LOW_POSITION_WINDOW") {
      const lowConfig = config.trigger.lowPositionWindow;
      if (!lowConfig) {
        ignored += 1;
        continue;
      }
      const previousScanAt =
        lowPositionLastScanAtByStrategy.get(triggerStateKey) ?? 0;
      const nextScanAt =
        previousScanAt + lowConfig.scanIntervalSeconds * 1_000;
      if (nextScanAt > now.getTime()) {
        lowPositionTriggerDiagnostics.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          triggerKind: "LOW_POSITION_WINDOW",
          scannedSymbols: [],
          totalSymbolCount: strategyActiveSymbolRows.length,
          preparedFacts: 0,
          candidateCount: 0,
          createdCount: 0,
          cacheErrors: [],
          skippedUntil: new Date(nextScanAt).toISOString(),
        });
        continue;
      }
      const selectedSymbols = new Set(config.selectedSymbols);
      const scanSymbols = strategyActiveSymbolRows
        .map((row) => row.symbol)
        .filter((symbol) =>
          !selectedSymbols.size || selectedSymbols.has(symbol)
        );
      let runtime;
      try {
        runtime = await evaluateLowPositionTriggerRuntime({
          marketData: nexusUnifiedMarketData,
          loadMarks: async (symbols) =>
            (await getBinanceLiveMarkPrices(symbols)).map((mark) => ({
              symbol: mark.symbol,
              markPrice: mark.markPrice,
              eventAt: mark.time,
              receivedAt: mark.receivedAt,
            })),
          symbols: scanSymbols,
          scanCursor:
            lowPositionScanCursorByStrategy.get(triggerStateKey) ?? 0,
          maxPosition72hPercent: lowConfig.maxPosition72hPercent,
          maxFactAgeMs: lowConfig.maxFactAgeMs,
          maxWakeCandidatesPerCycle:
            lowConfig.maxWakeCandidatesPerCycle,
          analysisValiditySeconds: config.trigger.analysisValiditySeconds,
          strategyId: strategy.id,
          configVersion: strategy.configVersion,
          ownerEmail: strategy.ownerEmail,
          accountId: strategy.accountId,
          now: now.getTime(),
        });
      } catch (error) {
        lowPositionTriggerDiagnostics.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          triggerKind: "LOW_POSITION_WINDOW",
          scannedSymbols: [],
          totalSymbolCount: scanSymbols.length,
          preparedFacts: 0,
          candidateCount: 0,
          createdCount: 0,
          cacheErrors: [{
            symbol: "--",
            message:
              error instanceof Error ? error.message : "低位触发器运行失败",
          }],
          skippedUntil: null,
        });
        continue;
      }
      lowPositionLastScanAtByStrategy.set(triggerStateKey, now.getTime());
      lowPositionScanCursorByStrategy.set(
        triggerStateKey,
        runtime.nextScanCursor,
      );
      let lowCreated = 0;
      for (const wake of runtime.wakes) {
        const occupancyReason = entryAnalysisOccupancyReason(
          analysisOccupancy,
          {
            ownerEmail: strategy.ownerEmail,
            accountId: strategy.accountId,
            symbol: wake.symbol,
            positionSide: "LONG",
            positionMode: positionModeByAccount.get(
              `${strategy.ownerEmail.trim().toLowerCase()}:${strategy.accountId.trim().toLowerCase()}`,
            ) ?? "ONE_WAY",
          },
        );
        const occupancyBlockedByStrategy =
          occupancyReason === "OPEN_POSITION"
            ? config.execution.existingPositionPolicy !==
              "ALLOW_SAME_DIRECTION"
            : occupancyReason === "WORKING_ORDER"
              ? config.execution.sameLegWorkingOrderPolicy !== "ALLOW"
              : false;
        if (
          occupancyBlockedByStrategy &&
          strategy.strategyType !== "SENTINEL"
        ) {
          ignored += 1;
          if (occupancyReason === "OPEN_POSITION")
            occupiedPositionSuppressed += 1;
          else workingOrderSuppressed += 1;
          continue;
        }

        const [alreadyHandled] = await db
          .select({ id: strategyExecutionTraces.id })
          .from(strategyExecutionTraces)
          .where(eq(strategyExecutionTraces.traceId, wake.wakeId))
          .limit(1);
        if (alreadyHandled) continue;
        const latestTrace = await db
          .select({
            id: strategyExecutionTraces.id,
            traceId: strategyExecutionTraces.traceId,
            state: strategyExecutionTraces.state,
            createdAt: strategyExecutionTraces.createdAt,
            expiresAt: strategyExecutionTraces.expiresAt,
          })
          .from(strategyExecutionTraces)
          .where(
            and(
              eq(strategyExecutionTraces.ownerEmail, strategy.ownerEmail),
              eq(strategyExecutionTraces.accountId, strategy.accountId),
              eq(strategyExecutionTraces.strategyId, strategy.id),
              eq(strategyExecutionTraces.symbol, wake.symbol),
              eq(
                strategyExecutionTraces.triggerKind,
                "LOW_POSITION_WINDOW",
              ),
            ),
          )
          .orderBy(desc(strategyExecutionTraces.id))
          .limit(1)
          .then((rows) => rows[0]);
        if (
          latestTrace &&
          ACTIVE_STATE_SET.has(latestTrace.state) &&
          latestTrace.expiresAt.getTime() > now.getTime()
        ) {
          ignored += 1;
          continue;
        }
        const cooldownStartedAt =
          now.getTime() - config.trigger.cooldownMinutes * 60_000;
        if (
          latestTrace &&
          latestTrace.createdAt.getTime() >= cooldownStartedAt
        ) {
          ignored += 1;
          cooldownSuppressed += 1;
          continue;
        }

        const triggerFact = marketStructureWakeFact({
          id: wake.wakeId,
          symbol: wake.symbol,
          // SELL is the market-side wake for a LONG support/reversal path;
          // the fact kind remains MARKET_STRUCTURE_WAKE, never liquidation.
          side: "SELL",
          eventAt: wake.eventAt,
          receivedAt: wake.receivedAt,
          expiresAt: wake.expiresAt,
          referencePrice: wake.referencePrice,
          position72hPercent: Number(wake.evidence.position72hPercent),
          relativeVolume5m: null,
          structureCode: "LOW_POSITION_72H_WINDOW",
        });
        const markFact = markPriceMarketFact({
          symbol: wake.symbol,
          markPrice: wake.referencePrice,
          eventAt: wake.eventAt,
          receivedAt: wake.receivedAt,
        });
        const triggerFacts = [markFact, triggerFact];
        nexusMarketFactBuffer.addMany(triggerFacts, now.getTime());
        const nexusOpportunity = {
          version: "nexus-structure-wake-opportunity-v1",
          triggerKind: "LOW_POSITION_WINDOW",
          direction: "LONG",
          primaryMachine: "SUPPORT_REVERSAL" as const,
          secondaryMachine: "TREND_BREAKOUT" as const,
          orderAffecting: false,
        };
        const nexusBrainShadow = deriveNexusBrainShadowState({
          direction: "LONG",
          triggerFactId: triggerFact.id,
          facts: triggerFacts,
          now: now.getTime(),
        });
        const nexusPureStateMachine = replayNexusPureStateMachine({
          machine: nexusOpportunity.primaryMachine,
          direction: "LONG",
          symbol: wake.symbol,
          triggerFactId: triggerFact.id,
          facts: triggerFacts,
          now: now.getTime(),
        });
        const nexusTrendBreakoutStateMachine = replayNexusPureStateMachine({
          machine: nexusOpportunity.secondaryMachine,
          direction: "LONG",
          symbol: wake.symbol,
          triggerFactId: triggerFact.id,
          facts: triggerFacts,
          now: now.getTime(),
        });
        const globalSentinelObservation = buildGlobalSentinelObservation({
          ownerEmail: strategy.ownerEmail,
          observerAccountId: strategy.accountId,
          symbol: wake.symbol,
          positionSide: "LONG",
          observedAt: now.getTime(),
          positions: analysisPositionRows,
          orders: analysisOrderRows,
          probeFeedback: globalSentinelProbeFeedback,
        });
        const [trace] = await db
          .insert(strategyExecutionTraces)
          .values({
            traceId: wake.wakeId,
            strategyId: strategy.id,
            strategyRunId: `monitor-${now.toISOString().slice(0, 10)}`,
            configVersion: strategy.configVersion,
            ownerEmail: strategy.ownerEmail,
            accountId: strategy.accountId,
            symbol: wake.symbol,
            triggerKind: wake.triggerKind,
            triggerVersion: wake.triggerVersion,
            triggerDirection: wake.direction,
            triggerReferencePrice: wake.referencePrice,
            triggerFactSnapshotId: wake.factSnapshotId,
            triggerSourceId: wake.sourceId,
            // Physical compatibility for the legacy table only. These fields
            // are explicitly non-authoritative when triggerKind is not the
            // liquidation adapter and are never emitted as liquidation facts.
            liquidationSide: "SELL",
            liquidationPrice: wake.referencePrice,
            liquidationNotional: 0,
            eventTime: new Date(wake.eventAt),
            receivedAt: new Date(wake.receivedAt),
            expiresAt: new Date(wake.expiresAt),
            state: "ANALYZING",
            resultCode: null,
            resultMessage: null,
            configSnapshotJson: JSON.stringify(config),
            entryEvidenceJson: JSON.stringify({
              symbol: wake.symbol,
              nexusArchitecture,
              entryTimingProfile,
              triggerIdentity: {
                version: wake.version,
                wakeId: wake.wakeId,
                triggerKind: wake.triggerKind,
                triggerVersion: wake.triggerVersion,
                direction: wake.direction,
                factSnapshotId: wake.factSnapshotId,
                sourceId: wake.sourceId,
                referencePrice: wake.referencePrice,
                eventAt: wake.eventAt,
                receivedAt: wake.receivedAt,
                expiresAt: wake.expiresAt,
                canAuthorizeOrder: false,
              },
              lowPositionWindow: wake.evidence,
              marketClusterId: wake.factSnapshotId,
              marketClusterType: "LOW_POSITION_WINDOW",
              brainDecisionDirection: "LONG",
              tradeDirection: "LONG",
              executionDirection: resolveStrategyExecutionDirection({
                mode: config.execution.directionMode,
                brainDirection: "LONG",
              }),
              sentinelAdvisoryOnly: strategy.strategyType === "SENTINEL",
              sentinelExposure:
                globalSentinelObservation.sameDirectionExposure,
              globalSentinelObservation,
              decisionEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
              signalMarkPrice: wake.referencePrice,
              signalMarkTime: wake.eventAt,
              signalMarkSource: "CENTRAL_WEBSOCKET_MARK_PRICE",
              nexusTriggerFact: triggerFact,
              nexusOpportunity,
              nexusMarketFactsShadow: triggerFacts,
              nexusBrainShadow,
              nexusPureStateMachine,
              nexusTrendBreakoutStateMachine,
            }),
            createdAt: now,
            updatedAt: now,
            completedAt: null,
          })
          .onConflictDoNothing()
          .returning();
        if (!trace) continue;
        const bookEyePrewarmReady = await warmNexusBookTicker(wake.symbol);
        created += 1;
        lowCreated += 1;
        const orderSubmissionAllowed =
          pilot.enabled && strategy.strategyType !== "SENTINEL";
        await appendEvent(wake.wakeId, strategy.id, {
          eventType: "LOW_POSITION_WAKE_RECEIVED",
          stage: "SIGNAL",
          outcome: "PASSED",
          message:
            `${wake.symbol} 处于72小时区间 ${Number(wake.evidence.position72hPercent).toFixed(2)}%，` +
            "低位事实已唤醒统一趋势、结构与量能分析",
          detail: {
            triggerIdentity: {
              wakeId: wake.wakeId,
              triggerKind: wake.triggerKind,
              triggerVersion: wake.triggerVersion,
              factSnapshotId: wake.factSnapshotId,
              canAuthorizeOrder: false,
            },
            ...wake.evidence,
            bookEyePrewarm:
              bookEyePrewarmReady ? "READY" : "SUBSCRIBING",
            monitorOnly: !orderSubmissionAllowed,
            orderSubmissionAllowed,
          },
          eventAt: new Date(wake.eventAt),
        });
      }
      lowPositionTriggerDiagnostics.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        triggerKind: "LOW_POSITION_WINDOW",
        scannedSymbols: runtime.scannedSymbols,
        totalSymbolCount: runtime.totalSymbolCount,
        preparedFacts: runtime.report.preparedFacts,
        candidateCount: runtime.wakes.length,
        createdCount: lowCreated,
        cacheErrors: runtime.cacheErrors,
        skippedUntil: null,
      });
      continue;
    }
    if (
      MARKET_STRUCTURE_TRIGGER_KINDS.has(
        config.trigger.kind as "GRID_PRICE_LEVEL" | "SCHEDULED_SCAN" | "BREAKOUT_RETEST",
      )
    ) {
      const triggerKind = config.trigger.kind as
        | "GRID_PRICE_LEVEL"
        | "SCHEDULED_SCAN"
        | "BREAKOUT_RETEST";
      const runtimeKey =
        `${strategy.id}:${strategy.configVersion}:${triggerKind}`;
      const scanIntervalSeconds = triggerKind === "GRID_PRICE_LEVEL"
        ? config.trigger.gridPriceLevel?.scanIntervalSeconds
        : triggerKind === "BREAKOUT_RETEST"
          ? config.trigger.breakoutRetest?.scanIntervalSeconds
          : config.trigger.scheduledScan?.intervalSeconds;
      if (!scanIntervalSeconds) {
        ignored += 1;
        continue;
      }
      const previousScanAt =
        marketStructureLastScanAtByStrategy.get(runtimeKey) ?? 0;
      const nextScanAt = previousScanAt + scanIntervalSeconds * 1_000;
      const scheduleWindowStartedAt = triggerKind === "SCHEDULED_SCAN"
        ? Math.floor(now.getTime() / (scanIntervalSeconds * 1_000)) *
          scanIntervalSeconds * 1_000
        : null;
      const alreadyScannedScheduleWindow =
        scheduleWindowStartedAt !== null &&
        scheduledScanWindowByStrategy.get(runtimeKey) ===
          scheduleWindowStartedAt;
      if (
        (triggerKind !== "SCHEDULED_SCAN" && nextScanAt > now.getTime()) ||
        alreadyScannedScheduleWindow
      ) {
        marketStructureTriggerDiagnostics.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          triggerKind,
          scannedSymbols: [],
          totalSymbolCount: strategyActiveSymbolRows.length,
          candidateCount: 0,
          createdCount: 0,
          cacheErrors: [],
          skippedUntil: new Date(
            triggerKind === "SCHEDULED_SCAN"
              ? (scheduleWindowStartedAt ?? now.getTime()) +
                scanIntervalSeconds * 1_000
              : nextScanAt,
          ).toISOString(),
          reason: triggerKind === "SCHEDULED_SCAN"
            ? "当前定时窗口已完成扫描"
            : "尚未到达下一次扫描时间",
        });
        continue;
      }
      const selectedSymbols = new Set(config.selectedSymbols);
      const scanSymbols = strategyActiveSymbolRows
        .map((row) => row.symbol)
        .filter((symbol) =>
          !selectedSymbols.size || selectedSymbols.has(symbol)
        );
      let runtime;
      try {
        const identity = {
          strategyId: strategy.id,
          configVersion: strategy.configVersion,
          ownerEmail: strategy.ownerEmail,
          accountId: strategy.accountId,
          analysisValiditySeconds: config.trigger.analysisValiditySeconds,
          direction: config.direction ?? "LONG_ONLY",
          now: now.getTime(),
        };
        if (triggerKind === "GRID_PRICE_LEVEL") {
          runtime = await evaluateGridPriceLevelTriggerRuntime({
            ...identity,
            loadMarks: async (symbols) =>
              (await getBinanceLiveMarkPrices(symbols)).map((mark) => ({
                symbol: mark.symbol,
                markPrice: mark.markPrice,
                eventAt: mark.time,
                receivedAt: mark.receivedAt,
              })),
            symbols: scanSymbols,
            config: config.trigger.gridPriceLevel!,
          });
        } else if (triggerKind === "SCHEDULED_SCAN") {
          runtime = await evaluateScheduledScanTriggerRuntime({
            ...identity,
            marketData: nexusUnifiedMarketData,
            symbols: scanSymbols,
            scanCursor:
              marketStructureScanCursorByStrategy.get(runtimeKey) ?? 0,
            config: config.trigger.scheduledScan!,
          });
        } else {
          runtime = await evaluateBreakoutRetestTriggerRuntime({
            ...identity,
            marketData: nexusUnifiedMarketData,
            loadMarks: async (symbols) =>
              (await getBinanceLiveMarkPrices(symbols)).map((mark) => ({
                symbol: mark.symbol,
                markPrice: mark.markPrice,
                eventAt: mark.time,
                receivedAt: mark.receivedAt,
              })),
            symbols: scanSymbols,
            scanCursor:
              marketStructureScanCursorByStrategy.get(runtimeKey) ?? 0,
            config: config.trigger.breakoutRetest!,
          });
        }
      } catch (error) {
        marketStructureTriggerDiagnostics.push({
          strategyId: strategy.id,
          strategyName: strategy.name,
          triggerKind,
          scannedSymbols: [],
          totalSymbolCount: scanSymbols.length,
          candidateCount: 0,
          createdCount: 0,
          cacheErrors: [{
            symbol: "--",
            message: error instanceof Error
              ? error.message
              : `${triggerKind}触发器运行失败`,
          }],
          skippedUntil: null,
          reason: "触发事实准备失败，未创建分析轨迹",
        });
        continue;
      }
      marketStructureLastScanAtByStrategy.set(runtimeKey, now.getTime());
      marketStructureScanCursorByStrategy.set(
        runtimeKey,
        runtime.nextScanCursor,
      );
      if (scheduleWindowStartedAt !== null)
        scheduledScanWindowByStrategy.set(
          runtimeKey,
          Math.floor(runtime.evaluatedAt / (scanIntervalSeconds * 1_000)) *
            scanIntervalSeconds * 1_000,
        );
      let structureCreated = 0;
      const competingScheduledScan =
        triggerKind === "SCHEDULED_SCAN" &&
        config.direction === "BOTH" &&
        config.directionDecision?.mode === "COMPETING_DIRECTIONS";
      const directionWakeInputs = competingScheduledScan
        ? buildCompetingDirectionWakeCohorts(runtime.wakes).cohorts.map(
            (cohort) => ({
              wake: cohort.wakes[0],
              directionWakes: cohort.wakes,
            }),
          )
        : runtime.wakes.map((wake) => ({ wake }));
      const invalidCompetingWakeCount = competingScheduledScan
        ? runtime.wakes.length - directionWakeInputs.length * 2
        : 0;
      ignored += invalidCompetingWakeCount;
      const wakeCreationLimit = triggerKind === "SCHEDULED_SCAN"
        ? config.trigger.scheduledScan!.maxWakeCandidatesPerCycle
        : Number.POSITIVE_INFINITY;
      for (let wakeIndex = 0; wakeIndex < directionWakeInputs.length; wakeIndex += 1) {
        if (structureCreated >= wakeCreationLimit) {
          ignored += directionWakeInputs.length - wakeIndex;
          break;
        }
        const wakeInput = directionWakeInputs[wakeIndex];
        const result = await persistMarketStructureWake({
          strategy,
          config,
          ...wakeInput,
          nexusArchitecture,
          entryTimingProfile,
        });
        if (result === "CREATED") {
          created += 1;
          structureCreated += 1;
        } else {
          ignored += 1;
          if (result === "OPEN_POSITION") occupiedPositionSuppressed += 1;
          if (result === "WORKING_ORDER") workingOrderSuppressed += 1;
          if (result === "COOLDOWN") cooldownSuppressed += 1;
        }
      }
      marketStructureTriggerDiagnostics.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        triggerKind,
        scannedSymbols: runtime.scannedSymbols,
        totalSymbolCount: runtime.totalSymbolCount,
        candidateCount: competingScheduledScan
          ? directionWakeInputs.length
          : runtime.wakes.length,
        createdCount: structureCreated,
        cacheErrors: runtime.cacheErrors,
        skippedUntil: null,
        scanCoverage: runtime.scanCoverage,
        reason: directionWakeInputs.length
          ? competingScheduledScan
            ? `生成 ${directionWakeInputs.length} 个同快照多空决策组并交给统一大脑复核`
            : `生成 ${runtime.wakes.length} 个候选并交给统一大脑复核`
          : "本轮没有满足触发条件的候选",
      });
      continue;
    }
    // Unknown or not-yet-runnable trigger types fail closed. They are never
    // reinterpreted as liquidation events.
    if (config.trigger.kind !== "LIQUIDATION_WINDOW") {
      ignored += feed.rows.length;
      continue;
    }
    const selectedSymbols = new Set(config.selectedSymbols);
    const requiredContractType =
      config.marketProfile?.mode === "TRADFI"
        ? "TRADIFI_PERPETUAL"
        : null;
    const strategyFeedRows = tradableFeedRows.filter(
      (item) =>
        strategyActiveSymbols.has(item.symbol) &&
        (!selectedSymbols.size || selectedSymbols.has(item.symbol)) &&
        (!requiredContractType ||
          activeContractTypes.get(item.symbol) === requiredContractType),
    );
    const triggerCandidates = resolveStrategyTriggerAdapter(
      "LIQUIDATION_WINDOW",
    ).evaluate({
      facts: { rows: strategyFeedRows },
      config: {
        minNotionalUsdt: config.trigger.minLiquidationNotionalUsdt,
        minSingleEventNotionalUsdt:
          config.trigger.minSingleLiquidationNotionalUsdt ??
          config.trigger.minLiquidationNotionalUsdt,
        minLiquidationPrice: config.trigger.minLiquidationPrice ?? 0,
        maxLiquidationPrice: config.trigger.maxLiquidationPrice ?? 0,
        minEventCount: config.trigger.minClusterEvents ?? 1,
        maxSpanMs: (config.trigger.maxClusterSpanSeconds ?? 3) * 1_000,
        maxInterEventGapMs:
          (config.trigger.maxClusterEventGapSeconds ??
            config.trigger.maxClusterSpanSeconds ??
            3) * 1_000,
      },
    });
    const freshTriggerCandidates = triggerCandidates.filter((item) =>
      liquidationSignalTiming({
        tradeTimeMs: item.lastTradeTime,
        receivedAtMs: item.lastReceivedAt,
        processedAtMs: Date.now(),
        maxSignalDelayMs: config.trigger.maxSignalDelayMs,
      }).fresh,
    );
    const freshestCandidateAgeSeconds = triggerCandidates.length
      ? Math.min(
          ...triggerCandidates.map((item) =>
            (Date.now() - item.lastTradeTime) / 1_000,
          ),
        )
      : null;
    const activeAnalyses = (
      await db
        .select({
          traceId: strategyExecutionTraces.traceId,
          symbol: strategyExecutionTraces.symbol,
          state: strategyExecutionTraces.state,
          resultCode: strategyExecutionTraces.resultCode,
          resultMessage: strategyExecutionTraces.resultMessage,
          createdAt: strategyExecutionTraces.createdAt,
          updatedAt: strategyExecutionTraces.updatedAt,
          expiresAt: strategyExecutionTraces.expiresAt,
        })
        .from(strategyExecutionTraces)
        .where(
          and(
            eq(strategyExecutionTraces.strategyId, strategy.id),
            // This limit protects only the pre-order analysis queue. Orders
            // and positions already owned by the execution coordinator must
            // not consume analysis slots; their concurrency and exposure are
            // enforced independently before submission.
            inArray(strategyExecutionTraces.state, [
              ...ANALYSIS_EXPIRABLE_STATES,
            ]),
            // Expired traces are still evaluated once at the end of this
            // poll so facts arriving exactly on the deadline are preserved.
            // They must not reserve capacity before that final evaluation,
            // otherwise a fresh 1.5s liquidation signal can be discarded and
            // become stale before the next monitor poll.
            gt(strategyExecutionTraces.expiresAt, now),
          ),
        )
        .orderBy(desc(strategyExecutionTraces.updatedAt), desc(strategyExecutionTraces.id))
    ).map((trace) => ({
      traceId: trace.traceId,
      symbol: trace.symbol,
      state: trace.state,
      resultCode: trace.resultCode,
      resultMessage: trace.resultMessage,
      ageSeconds: rounded((Date.now() - trace.createdAt.getTime()) / 1_000, 1),
      expiresInSeconds: trace.expiresAt
        ? rounded((trace.expiresAt.getTime() - Date.now()) / 1_000, 1)
        : null,
      updatedAgeSeconds: rounded((Date.now() - trace.updatedAt.getTime()) / 1_000, 1),
    }));
    let activeAnalysisCount = activeAnalyses.length;
    triggerDiagnostics.push(
      buildLiquidationTriggerDiagnostic({
        strategy,
        config,
        feedRows: strategyFeedRows,
        candidateCount: triggerCandidates.length,
        freshCandidateCount: freshTriggerCandidates.length,
        freshestCandidateAgeSeconds,
        activeAnalysisCount,
        activeAnalyses: activeAnalyses.slice(0, 5),
      }),
    );
    for (const item of triggerCandidates) {
      if (!strategyActiveSymbols.has(item.symbol)) {
        ignored += 1;
        continue;
      }
      if (selectedSymbols.size && !selectedSymbols.has(item.symbol)) continue;

      const occupancyReason = entryAnalysisOccupancyReason(
        analysisOccupancy,
        {
          ownerEmail: strategy.ownerEmail,
          accountId: strategy.accountId,
          symbol: item.symbol,
          positionSide: resolveStrategyExecutionDirection({
            mode: config.execution.directionMode,
            brainDirection: "LONG",
          }).positionSide,
          positionMode: positionModeByAccount.get(
            `${strategy.ownerEmail.trim().toLowerCase()}:${strategy.accountId.trim().toLowerCase()}`,
          ) ?? "ONE_WAY",
        },
      );
      const occupancyBlockedByStrategy =
        occupancyReason === "OPEN_POSITION"
          ? config.execution.existingPositionPolicy !==
            "ALLOW_SAME_DIRECTION"
          : occupancyReason === "WORKING_ORDER"
            ? config.execution.sameLegWorkingOrderPolicy !== "ALLOW"
            : false;
      if (occupancyBlockedByStrategy && strategy.strategyType !== "SENTINEL") {
        ignored += 1;
        if (occupancyReason === "OPEN_POSITION")
          occupiedPositionSuppressed += 1;
        else workingOrderSuppressed += 1;
        continue;
      }

      const signalTiming = liquidationSignalTiming({
        // The market cluster may span minutes. Order eligibility is tied to
        // the threshold-crossing event, while the full cluster span remains
        // recorded in evidence.
        tradeTimeMs: item.lastTradeTime,
        receivedAtMs: item.lastReceivedAt,
        processedAtMs: Date.now(),
        maxSignalDelayMs: config.trigger.maxSignalDelayMs,
      });
      // Noise is counted but never persisted. The candidate builder already
      // enforced same-symbol notional, price, continuity and event-count
      // thresholds; only freshness remains before a trace may be created.
      // Freshness covers the complete trade-to-processing path so a cached
      // WebSocket event cannot enter live analysis after a restart or backlog.
      if (!signalTiming.fresh) {
        ignored += 1;
        continue;
      }

      const traceId = await deterministicTraceId(strategy.id, strategy.accountId, item);
      const [alreadyHandled] = await db
        .select({ id: strategyExecutionTraces.id })
        .from(strategyExecutionTraces)
        .where(eq(strategyExecutionTraces.traceId, traceId))
        .limit(1);
      if (alreadyHandled) continue;

      const latestTrace = await db
        .select({
          id: strategyExecutionTraces.id,
          traceId: strategyExecutionTraces.traceId,
          liquidationPrice: strategyExecutionTraces.liquidationPrice,
          expiresAt: strategyExecutionTraces.expiresAt,
          state: strategyExecutionTraces.state,
          createdAt: strategyExecutionTraces.createdAt,
          eventTime: strategyExecutionTraces.eventTime,
        })
        .from(strategyExecutionTraces)
        .where(
          and(
            eq(strategyExecutionTraces.ownerEmail, strategy.ownerEmail),
            eq(strategyExecutionTraces.accountId, strategy.accountId),
            eq(strategyExecutionTraces.strategyId, strategy.id),
            eq(strategyExecutionTraces.symbol, item.symbol),
            eq(strategyExecutionTraces.triggerKind, "LIQUIDATION_WINDOW"),
            eq(strategyExecutionTraces.liquidationSide, item.side),
          ),
        )
        .orderBy(desc(strategyExecutionTraces.id))
        .limit(1)
        .then((rows) => rows[0]);
      let supersededLatestAnalysis = false;
      if (
        latestTrace &&
        ACTIVE_STATE_SET.has(latestTrace.state) &&
        latestTrace.expiresAt.getTime() > Date.now() &&
        config.trigger.cooldownMinutes > 0
      ) {
        const materiallyExtendedLiquidation =
          shouldSupersedeLiquidationAnalysis({
            liquidationSide: item.side,
            currentState: latestTrace.state,
            previousEventAtMs: latestTrace.eventTime.getTime(),
            latestEventAtMs: item.lastTradeTime,
            previousLiquidationPrice: latestTrace.liquidationPrice,
            latestLiquidationPrice: item.averagePrice,
          });
        if (materiallyExtendedLiquidation) {
          const supersededAt = new Date(item.lastTradeTime);
          const message =
            `${item.symbol} 出现${item.side === "SELL" ? "更低的连续多头爆仓价" : "更高的连续空头爆仓价"} ` +
            `${item.averagePrice}，旧候选 ${latestTrace.liquidationPrice} ` +
            "转为历史证据，由最新价格重新建立独立判断生命周期";
          const [canceled] = await db
            .update(strategyExecutionTraces)
            .set({
              state: "CANCELED",
              resultCode:
                item.side === "SELL"
                  ? "SUPERSEDED_BY_LOWER_LIQUIDATION_PRICE"
                  : "SUPERSEDED_BY_HIGHER_LIQUIDATION_PRICE",
              resultMessage: message,
              completedAt: supersededAt,
              updatedAt: supersededAt,
            })
            .where(
              and(
                eq(strategyExecutionTraces.id, latestTrace.id),
                inArray(strategyExecutionTraces.state, [
                  "ANALYZING",
                  "ARMED",
                ]),
              ),
            )
            .returning({ id: strategyExecutionTraces.id });
          if (canceled) {
            await appendEvent(latestTrace.traceId, strategy.id, {
              eventType:
                `SIGNAL_SUPERSEDED_BY_LOWER_PRICE:${item.id}`,
              stage: "SIGNAL",
              outcome: "INFO",
              message,
              detail: {
                previousLiquidationPrice:
                  latestTrace.liquidationPrice,
                latestLiquidationPrice: item.averagePrice,
                previousTraceId: latestTrace.traceId,
                latestSignalTime: supersededAt.toISOString(),
                createsNewIndependentTrace: true,
                orderOrPositionAffected: false,
              },
              eventAt: supersededAt,
            });
            supersededLatestAnalysis = true;
            activeAnalysisCount = Math.max(
              0,
              activeAnalysisCount - 1,
            );
          }
        }
        if (!supersededLatestAnalysis) {
          const eventCreated = await appendEvent(latestTrace.traceId, strategy.id, {
          eventType: `SIGNAL_CLUSTER_UPDATED:${item.id}`,
          stage: "SIGNAL",
          outcome: "INFO",
          message:
            `${item.symbol} 单币连续爆仓累计 ${item.symbolLiquidationNotional.toFixed(2)} USDT，` +
            (["ANALYZING", "ARMED"].includes(latestTrace.state)
              ? "新增事实已记录，分析截止时间保持不变"
              : "已进入委托或持仓阶段，不再修改分析时钟"),
          detail: {
            liquidationSide: item.side,
            liquidationPrice: item.averagePrice,
            liquidationNotional: item.notional,
            eventCount: item.eventCount,
            marketClusterId: item.marketClusterId,
            marketClusterNotional: item.marketClusterNotional,
            marketClusterEventCount: item.marketClusterEventCount,
            marketClusterSymbolCount: item.marketClusterSymbolCount,
            marketClusterSpanMs: item.marketClusterSpanMs,
            marketClusterMaxGapMs: item.marketClusterMaxGapMs,
            configuredMaxInterEventGapMs:
              item.configuredMaxInterEventGapMs,
            marketTriggerMode: item.marketTriggerMode,
            symbolLiquidationNotional: item.symbolLiquidationNotional,
            symbolEventCount: item.symbolEventCount,
            previousEventTime: latestTrace.eventTime.toISOString(),
            latestSignalTime: new Date(item.lastTradeTime).toISOString(),
            expiresAt: latestTrace.expiresAt.toISOString(),
            hardExpiresAt: latestTrace.expiresAt.toISOString(),
            analysisWindowRenewed: false,
            monitorOnly: true,
          },
          eventAt: new Date(item.lastTradeTime),
          });
          if (eventCreated) updated += 1;
          continue;
        }
      }
      const cooldownStartedAt =
        Date.now() - config.trigger.cooldownMinutes * 60_000;
      if (
        !supersededLatestAnalysis &&
        latestTrace &&
        latestTrace.createdAt.getTime() >= cooldownStartedAt
      ) {
        const cooldownEndsAt =
          latestTrace.createdAt.getTime() +
          config.trigger.cooldownMinutes * 60_000;
        const eventCreated = await appendEvent(
          latestTrace.traceId,
          strategy.id,
          {
            eventType: `SIGNAL_COOLDOWN_SUPPRESSED:${item.id}`,
            stage: "SIGNAL",
            outcome: "INFO",
            message:
              `${item.symbol} 单币连续爆仓累计 ${item.symbolLiquidationNotional.toFixed(2)} USDT，` +
              `因同合约冷却期未重新分析`,
            detail: {
              sourceId: item.id,
              liquidationSide: item.side,
              liquidationPrice: item.averagePrice,
              liquidationNotional: item.notional,
              eventCount: item.eventCount,
              marketClusterId: item.marketClusterId,
              marketClusterNotional: item.marketClusterNotional,
              marketClusterEventCount: item.marketClusterEventCount,
              marketClusterSymbolCount: item.marketClusterSymbolCount,
              marketClusterSpanMs: item.marketClusterSpanMs,
              marketClusterMaxGapMs: item.marketClusterMaxGapMs,
              configuredMaxInterEventGapMs:
                item.configuredMaxInterEventGapMs,
              marketTriggerMode: item.marketTriggerMode,
              symbolLiquidationNotional: item.symbolLiquidationNotional,
              symbolEventCount: item.symbolEventCount,
              configuredCooldownMinutes: config.trigger.cooldownMinutes,
              cooldownEndsAt: new Date(cooldownEndsAt).toISOString(),
              remainingCooldownMs: Math.max(0, cooldownEndsAt - Date.now()),
              monitorOnly: true,
              orderAffecting: false,
            },
            eventAt: new Date(item.lastTradeTime),
          },
        );
        if (eventCreated) {
          updated += 1;
          cooldownSuppressed += 1;
        }
        ignored += 1;
        continue;
      }
      const configuredConcurrentAnalysisLimit = Math.max(
        0,
        Math.trunc(config.trigger.maxConcurrentAnalyses ?? 0),
      );
      if (
        configuredConcurrentAnalysisLimit > 0 &&
        activeAnalysisCount >= configuredConcurrentAnalysisLimit
      ) {
        ignored += 1;
        continue;
      }

      const eventTime = new Date(item.lastTradeTime);
      const signalMark = signalMarks.get(item.symbol);
      const signalMarkPrice = signalMark?.markPrice ?? item.averagePrice;
      const traceExpiresAt =
        item.lastTradeTime + config.trigger.analysisValiditySeconds * 1_000;
      const nexusTriggerFact = liquidationMarketFact({
        ...item,
        expiresAt: traceExpiresAt,
      });
      const triggerFactSnapshotId = nexusFactSnapshotId({
        symbol: item.symbol,
        evaluatedAt: marketFactCapturedAt,
        factIds: [nexusTriggerFact.id],
      });
      const nexusOpportunity = nexusLiquidationOpportunity({
        liquidationSide: item.side,
        direction: "LONG",
      });
      const priorLifecycleMemory = await readPriorExpiredLifecycleMemory({
        ownerEmail: strategy.ownerEmail,
        accountId: strategy.accountId,
        strategyId: strategy.id,
        symbol: item.symbol,
        liquidationSide: item.side,
        eventTime,
      });
      nexusMarketFactBuffer.add(nexusTriggerFact, marketFactCapturedAt);
      const nexusMarketFactsShadow = nexusMarketFactBuffer.query({
        symbol: item.symbol,
        freshOnly: true,
        now: marketFactCapturedAt,
        limit: 8,
      });
      const nexusBrainShadow = deriveNexusBrainShadowState({
        direction: "LONG",
        triggerLiquidationSide: item.side,
        facts: nexusMarketFactsShadow,
        now: marketFactCapturedAt,
      });
      const nexusPureStateMachine = replayNexusPureStateMachine({
        machine: nexusOpportunity.primaryMachine,
        direction: "LONG",
        symbol: item.symbol,
        triggerLiquidationSide: item.side,
        facts: nexusMarketFactsShadow,
        now: marketFactCapturedAt,
      });
      const nexusTrendBreakoutStateMachine = replayNexusPureStateMachine({
        machine: nexusOpportunity.secondaryMachine,
        direction: "LONG",
        symbol: item.symbol,
        triggerLiquidationSide: item.side,
        facts: nexusMarketFactsShadow,
        now: marketFactCapturedAt,
      });
      const globalSentinelObservation = buildGlobalSentinelObservation({
        ownerEmail: strategy.ownerEmail,
        observerAccountId: strategy.accountId,
        symbol: item.symbol,
        positionSide: "LONG",
        observedAt: marketFactCapturedAt,
        positions: analysisPositionRows,
        orders: analysisOrderRows,
        probeFeedback: globalSentinelProbeFeedback,
      });
      const sentinelExposure =
        globalSentinelObservation.sameDirectionExposure;
      const [trace] = await db
        .insert(strategyExecutionTraces)
        .values({
          traceId,
          strategyId: strategy.id,
          strategyRunId: `monitor-${eventTime.toISOString().slice(0, 10)}`,
          configVersion: strategy.configVersion,
          ownerEmail: strategy.ownerEmail,
          accountId: strategy.accountId,
          symbol: item.symbol,
          triggerKind: "LIQUIDATION_WINDOW",
          triggerVersion: "liquidation-window-trigger-v1",
          triggerDirection: "LONG",
          triggerReferencePrice: signalMarkPrice,
          triggerFactSnapshotId,
          triggerSourceId: item.id,
          liquidationSide: item.side,
          liquidationPrice: item.averagePrice,
          liquidationNotional: item.notional,
          eventTime,
          receivedAt: new Date(item.lastReceivedAt),
          expiresAt: new Date(traceExpiresAt),
          state: "ANALYZING",
          resultCode: null,
          resultMessage: null,
          configSnapshotJson: JSON.stringify(config),
          entryEvidenceJson: JSON.stringify({
            symbol: item.symbol,
            triggerIdentity: {
              triggerKind: "LIQUIDATION_WINDOW",
              triggerVersion: "liquidation-window-trigger-v1",
              direction: "LONG",
              factSnapshotId: triggerFactSnapshotId,
              sourceId: item.id,
              referencePrice: signalMarkPrice,
              eventAt: item.lastTradeTime,
              receivedAt: item.lastReceivedAt,
              expiresAt: traceExpiresAt,
              canAuthorizeOrder: false,
            },
            nexusArchitecture,
            entryTimingProfile,
            brainDecisionDirection: "LONG",
            tradeDirection: resolveStrategyExecutionDirection({
              mode: config.execution.directionMode,
              brainDirection: "LONG",
            }).tradeDirection,
            executionDirection: resolveStrategyExecutionDirection({
              mode: config.execution.directionMode,
              brainDirection: "LONG",
            }),
            sentinelAdvisoryOnly: strategy.strategyType === "SENTINEL",
            sentinelExposure,
            globalSentinelObservation,
            decisionEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
            globalLiquidationContext,
            triggerScope: item.triggerScope,
            marketTriggerMode: item.marketTriggerMode,
            marketClusterId: item.marketClusterId,
            marketClusterNotional: item.marketClusterNotional,
            marketClusterEventCount: item.marketClusterEventCount,
            marketClusterSpanMs: item.marketClusterSpanMs,
            marketClusterMaxGapMs: item.marketClusterMaxGapMs,
            configuredMaxInterEventGapMs:
              item.configuredMaxInterEventGapMs,
            symbolLiquidationNotional: item.symbolLiquidationNotional,
            symbolEventCount: item.symbolEventCount,
            symbolLiquidationSharePercent:
              item.symbolLiquidationSharePercent,
            symbolContributionRank: item.symbolContributionRank,
            signalMarkPrice,
            signalMarkTime: signalMark?.time ?? item.lastTradeTime,
            signalLiquidationPrice: item.averagePrice,
            signalMarkSource: signalMark
              ? "CENTRAL_WEBSOCKET_MARK_PRICE"
              : "LIQUIDATION_PRICE_FALLBACK_WAITING_FOR_MARK",
            // The trigger is immutable evidence for this trace. Keep it
            // outside the rolling fact snapshot so high-frequency mark facts
            // cannot push it out during the longer analysis window.
            nexusTriggerFact,
            nexusOpportunity,
            nexusMarketFactsShadow,
            nexusBrainShadow,
            nexusPureStateMachine,
            nexusTrendBreakoutStateMachine,
            priorLifecycleMemory,
          }),
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        })
        .onConflictDoNothing()
        .returning();
      if (!trace) continue;
      // Start the individual-symbol book stream as soon as the brain accepts
      // the liquidation candidate. The final execution gate remains strict
      // and independently requires a <=500ms snapshot.
      const bookEyePrewarmReady = await warmNexusBookTicker(item.symbol);
      created += 1;
      activeAnalysisCount += 1;
      const orderSubmissionAllowed =
        pilot.enabled && strategy.strategyType !== "SENTINEL";
      await appendEvent(traceId, strategy.id, {
        eventType: "SIGNAL_RECEIVED",
        stage: "SIGNAL",
        outcome: "PASSED",
        message:
          item.marketTriggerMode === "SINGLE_STRONG"
            ? `${item.symbol} 单笔爆仓 ${item.symbolLiquidationNotional.toFixed(2)} USDT，按单币触发进入 NEXUS 大脑状态机`
            : `${item.symbol} 在 ${Math.round(item.marketClusterSpanMs / 1_000)} 秒窗口内连续爆仓 ${item.symbolEventCount} 次、累计 ${item.symbolLiquidationNotional.toFixed(2)} USDT，按单币触发进入 NEXUS 大脑状态机`,
        detail: {
          decisionEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
          globalLiquidationContext,
          triggerScope: item.triggerScope,
          sourceId: item.id,
          marketClusterId: item.marketClusterId,
          transportAggregationWindowMs: feed.aggregationWindowMs,
          aggregationWindowMs: feed.aggregationWindowMs,
          strategyClusterWindowMs:
            (config.trigger.maxClusterSpanSeconds ?? 3) * 1_000,
          strategyMaxInterEventGapMs:
            (config.trigger.maxClusterEventGapSeconds ??
              config.trigger.maxClusterSpanSeconds ??
              3) * 1_000,
          liquidationSide: item.side,
          liquidationPrice: item.averagePrice,
          signalMarkPrice,
          signalMarkTime: signalMark?.time ?? item.lastTradeTime,
          signalMarkSource: signalMark
            ? "CENTRAL_WEBSOCKET_MARK_PRICE"
            : "LIQUIDATION_PRICE_FALLBACK_WAITING_FOR_MARK",
          liquidationNotional: item.notional,
          marketClusterNotional: item.marketClusterNotional,
          marketClusterEventCount: item.marketClusterEventCount,
          marketClusterSymbolCount: item.marketClusterSymbolCount,
          marketClusterMaxGapMs: item.marketClusterMaxGapMs,
          configuredMaxInterEventGapMs:
            item.configuredMaxInterEventGapMs,
          marketTriggerMode: item.marketTriggerMode,
          symbolLiquidationNotional: item.symbolLiquidationNotional,
          symbolEventCount: item.symbolEventCount,
          symbolLiquidationSharePercent:
            item.symbolLiquidationSharePercent,
          symbolContributionRank: item.symbolContributionRank,
          filledQuantity: item.filledQuantity,
          eventCount: item.eventCount,
          firstTradeTime: item.firstTradeTime,
          lastTradeTime: item.lastTradeTime,
          clusterTradeSpanMs: item.marketClusterSpanMs,
          eventLatencyMs: signalTiming.transportLatencyMs,
          processingLagMs: signalTiming.processingLagMs,
          totalSignalAgeMs: signalTiming.totalSignalAgeMs,
          minLiquidationNotionalUsdt:
            config.trigger.minLiquidationNotionalUsdt,
          maxSignalDelayMs: config.trigger.maxSignalDelayMs,
          bookEyePrewarm:
            bookEyePrewarmReady ? "READY" : "SUBSCRIBING",
          bookEyeFinalGate: "REQUIRE_FRESH_WITHIN_500MS",
          monitorOnly: !orderSubmissionAllowed,
          orderSubmissionAllowed,
          sentinelExposure,
        },
        eventAt: eventTime,
      });
      if (priorLifecycleMemory)
        await appendEvent(traceId, strategy.id, {
          eventType: "PRIOR_LIFECYCLE_MEMORY_ATTACHED",
          stage: "SIGNAL",
          outcome: "INFO",
          message: priorLifecycleMemory.summary,
          detail: priorLifecycleMemory,
          eventAt: eventTime,
        });
      await appendEvent(traceId, strategy.id, {
        eventType:
          `NEXUS_PURE_STATE:${nexusTrendBreakoutStateMachine.machine}:${nexusTrendBreakoutStateMachine.state}`,
        stage: "SIGNAL",
        outcome: "INFO",
        message: nexusPureStateMachineMessage(
          nexusTrendBreakoutStateMachine,
        ),
        detail: nexusTrendBreakoutStateMachine,
        eventAt: eventTime,
      });
      await appendEvent(traceId, strategy.id, {
        eventType:
          `NEXUS_PURE_STATE:${nexusPureStateMachine.machine}:${nexusPureStateMachine.state}`,
        stage: "SIGNAL",
        outcome: "INFO",
        message: nexusPureStateMachineMessage(nexusPureStateMachine),
        detail: nexusPureStateMachine,
        eventAt: eventTime,
      });
      await appendEvent(traceId, strategy.id, {
        eventType: `NEXUS_BRAIN_SHADOW:${nexusBrainShadow.state}`,
        stage: "SIGNAL",
        outcome:
          nexusBrainShadow.state === "READY_SHADOW"
            ? "PASSED"
            : nexusBrainShadow.state === "INVALIDATED"
              ? "REJECTED"
              : "INFO",
        message: `NEXUS大脑影子：${nexusBrainShadow.reasons.map((item) => item.message).join("；")}`,
        detail: nexusBrainShadow,
        eventAt: eventTime,
      });
    }
  }
  } finally {
    // Queue progress is an independent phase. A malformed or temporarily
    // unavailable new signal must never strand traces that were accepted by a
    // previous monitor cycle in ANALYZING/ARMED until they silently expire.
    analysis = await evaluateActiveTraces(marketFactCycle, marketAnalysisCycle);
    // Always consume the newest liquidation facts and closed market candles
    // before terminating an analysis lifecycle. Expiring at the beginning of
    // the poll discarded evidence that arrived on the exact deadline and could
    // turn a pending path into READY. New facts never extend the original clock.
    expired = await expireUnresolvedAnalysisTraces(new Date());
  }
  marketFactCycle.clear();
  marketAnalysisCycle.clear();

  const threeMinuteQueueDepthAfterCycle =
    await readThreeMinuteCandidateQueueDepth(new Date());
  const threeMinuteCandidateQueue = {
    capacity: THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY,
    enqueueBatch: THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH,
    discoveryBatch: THREE_MINUTE_CANDIDATE_DISCOVERY_BATCH,
    marketScanBatch: THREE_MINUTE_MARKET_SCAN_BATCH,
    opportunityBoardCapacity: THREE_MINUTE_OPPORTUNITY_BOARD_CAPACITY,
    opportunityBoardCandidates: [...threeMinuteOpportunityBoardByStrategy]
      .filter(([key]) =>
        runningStrategies.some((strategy) =>
          triggerRuntimeStateKey(strategy) === key
        )
      )
      .reduce(
        (total, [, board]) => total + board.snapshot(Date.now()).length,
        0,
      ),
    queuedAtStart: threeMinuteQueueDepthAtStart,
    enqueuedThisCycle: threeMinuteQueueEnqueued,
    preemptedThisCycle: threeMinuteQueuePreempted,
    fullCandidatesSkippedThisCycle: threeMinuteQueueFullSuppressed,
    queuedAfterCycle: threeMinuteQueueDepthAfterCycle,
    full:
      threeMinuteQueueDepthAfterCycle >=
        THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY,
    recoveredThisProcess: recoveredThreeMinuteCandidateCount,
    scanningContinuesWhenFull: true,
    queuePolicy:
      "LATEST_FACT_PER_SYMBOL -> GLOBAL_PROBABILITY_PRIORITY -> TOP12_QUEUE -> TOP3_DIRECT_ADMISSION",
    lifecycle:
      "ANALYZING -> DIRECT_PROBABILITY -> ORDER_READY -> UNIFIED_EXECUTION",
  };
  const checkedAt = now.toISOString();
  const unifiedMarketData = nexusUnifiedMarketData.metrics();
  if (compactResponse)
    return Response.json({
      mode: pilot.enabled ? "LIVE_PILOT" : "MONITOR_ONLY",
      orderSubmissionAllowed: pilot.enabled,
      strategies: runningStrategies.length,
      feedEvents: feed.rows.length,
      created,
      updated,
      rejected,
      ignored,
      cooldownSuppressed,
      occupiedPositionSuppressed,
      workingOrderSuppressed,
      diagnosticCounts: {
        liquidation: triggerDiagnostics.length,
        lowPosition: lowPositionTriggerDiagnostics.length,
        threeMinuteProbability: threeMinuteProbabilityDiagnostics.length,
        marketStructure: marketStructureTriggerDiagnostics.length,
      },
      threeMinuteCandidateQueue,
      analysis,
      expired,
      marketDataWait: Boolean(signalMarkWait || analysis.marketDataWait),
      marketDataWaitReason:
        signalMarkWait ?? analysis.marketDataWaitReason ?? null,
      contractPoolSyncError,
      pendingEntryReconciliation: "DEDICATED_RUNNER",
      unifiedMarketData,
      timings: { totalMs: Date.now() - now.getTime() },
      checkedAt,
    });

  return Response.json({
    mode: pilot.enabled ? "LIVE_PILOT" : "MONITOR_ONLY",
    orderSubmissionAllowed: pilot.enabled,
    liveAccountScope: pilot.enabled ? "STRATEGY_BOUND_ACCOUNTS" : null,
    pilotLimits: pilot.enabled ? LIQUIDATION_PILOT_LIMITS : null,
    strategies: runningStrategies.length,
    feedEvents: feed.rows.length,
    created,
    updated,
    rejected,
    ignored,
    cooldownSuppressed,
    occupiedPositionSuppressed,
    workingOrderSuppressed,
    triggerDiagnostics,
    lowPositionTriggerDiagnostics,
    threeMinuteProbabilityDiagnostics,
    threeMinuteCandidateQueue,
    marketStructureTriggerDiagnostics,
    analysis,
    expired,
    marketDataWait: Boolean(signalMarkWait || analysis.marketDataWait),
    marketDataWaitReason: signalMarkWait ?? analysis.marketDataWaitReason ?? null,
    contractPoolSyncError,
    pendingEntryReconciliation: "DEDICATED_RUNNER",
    globalLiquidationContext,
    unifiedMarketData,
    checkedAt,
  });
}

async function pauseAnalysisClockForTransientWait(
  trace: AnalysisMarketDataPauseTrace,
  config: LiquidationTrendConfig,
  input: {
    code: string;
    message: string;
    pausedAt?: Date;
  },
) {
  const db = getDb();
  const pausedAt = input.pausedAt ?? new Date();
  const evidence = asRecord(safeParse(trace.entryEvidenceJson ?? "{}"));
  const previousPause = asRecord(evidence.analysisMarketDataPause);
  const pause = pauseAnalysisWindow({
    createdAtMs: trace.createdAt.getTime(),
    currentExpiresAtMs: trace.expiresAt.getTime(),
    lastProgressAtMs: trace.updatedAt.getTime(),
    nowMs: pausedAt.getTime(),
    validityMs: config.trigger.analysisValiditySeconds * 1_000,
    alreadyPausedMs: finiteNumber(previousPause.totalPausedMs, 0),
    maximumLifetimeMultiplier: 3,
  });
  evidence.analysisMarketDataPause = {
    version: 1,
    status: "WAITING",
    code: input.code,
    message: input.message,
    firstPausedAt:
      typeof previousPause.firstPausedAt === "string"
        ? previousPause.firstPausedAt
        : pausedAt.toISOString(),
    lastPausedAt: pausedAt.toISOString(),
    pauseAppliedMs: pause.pauseAppliedMs,
    totalPausedMs: pause.totalPausedMs,
    maximumPauseMs: pause.maximumPauseMs,
    previousExpiresAt: trace.expiresAt.toISOString(),
    nextExpiresAt: new Date(pause.nextExpiresAtMs).toISOString(),
    hardExpiresAt: new Date(pause.hardExpiresAtMs).toISOString(),
  };
  await db
    .update(strategyExecutionTraces)
    .set({
      entryEvidenceJson: JSON.stringify(evidence),
      expiresAt: new Date(pause.nextExpiresAtMs),
      updatedAt: pausedAt,
    })
    .where(
      and(
        eq(strategyExecutionTraces.id, trace.id),
        inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
      ),
    );
  await appendEvent(trace.traceId, trace.strategyId, {
    eventType: "ANALYSIS_MARKET_DATA_CLOCK_PAUSED",
    stage: "POSITION",
    outcome: "PENDING",
    message: pause.paused
      ? `外部行情暂不可用，分析时钟已补偿 ${pause.pauseAppliedMs}ms，恢复后继续原生命周期`
      : "外部行情暂不可用；仅在当前分析截止时间内重试，不延长本生命周期",
    detail: {
      code: input.code,
      temporary: true,
      orderSubmissionAllowed: false,
      ...pause,
    },
    eventAt: pausedAt,
  });
  return pause;
}

async function pauseAnalysisClocksForTransientWait(
  traces: AnalysisMarketDataPauseTrace[],
  input: {
    code: string;
    message: string;
  },
) {
  const pausedAt = new Date();
  for (const trace of traces) {
    try {
      const config = await loadBoundLiquidationTrendConfig(trace);
      await pauseAnalysisClockForTransientWait(trace, config, {
        ...input,
        pausedAt,
      });
    } catch {
      // A broken legacy snapshot must not turn a temporary market-data wait
      // into a monitor-wide 500. The normal trace evaluator will isolate that
      // configuration error on its next available pass.
    }
  }
}

async function persistFrozenLongExecutionDecision(
  trace: typeof strategyExecutionTraces.$inferSelect,
  evidence: Record<string, unknown>,
  analysisValiditySeconds: number,
) {
  const frozenDecision = asRecord(evidence.frozenExecutionDecision);
  const approvalCode =
    typeof frozenDecision.approvalCode === "string"
      ? frozenDecision.approvalCode
      : "NEXUS_EXECUTION_APPROVED";
  const approvalSummary =
    typeof frozenDecision.approvalSummary === "string"
      ? frozenDecision.approvalSummary
      : "业务判断已通过";
  const now = new Date();
  const executionWindow = buildFrozenExecutionWindow({
    approvedAt: frozenDecision.approvedAt ?? now,
    analysisValiditySeconds,
  });
  evidence.frozenExecutionDecision = {
    ...frozenDecision,
    approvedAt: executionWindow.approvedAt,
    executionValidityMs: executionWindow.executionValidityMs,
    executionExpiresAt: executionWindow.executionExpiresAt,
    waitCode:
      typeof frozenDecision.waitCode === "string" && frozenDecision.waitCode
        ? frozenDecision.waitCode
        : "NEXUS_EXECUTION_PENDING",
    waitMessage:
      typeof frozenDecision.waitMessage === "string" && frozenDecision.waitMessage
        ? frozenDecision.waitMessage
        : "业务判断已通过，等待首次执行安全复核",
  };
  await getDb()
    .update(strategyExecutionTraces)
    .set({
      state: "ORDER_READY",
      resultCode: "NEXUS_EXECUTION_APPROVED",
      resultMessage:
        `${approvalSummary}；执行结论已冻结，环境恢复后不再重新判断趋势`,
      entryEvidenceJson: JSON.stringify(evidence),
      expiresAt: new Date(
        Math.max(
          trace.expiresAt.getTime(),
          executionWindow.executionExpiresAtMs,
        ),
      ),
      completedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(strategyExecutionTraces.id, trace.id),
        inArray(strategyExecutionTraces.state, [
          "ANALYZING",
          "ARMED",
          "ORDER_READY",
        ]),
      ),
    );
  await appendEvent(trace.traceId, trace.strategyId, {
    eventType: "NEXUS_EXECUTION_DECISION_FROZEN",
    stage: "ORDER",
    outcome: "PASSED",
    message:
      `${approvalSummary}；已冻结为待执行，环境恢复仅复核交易安全条件`,
    detail: {
      approvalCode,
      decisionFrozen: true,
      retryWithoutReanalysis: true,
      executionExpiresAt: executionWindow.executionExpiresAt,
    },
    eventAt: now,
  });
}

async function retryFrozenLongExecutionDecisions() {
  const db = getDb();
  const now = new Date();
  const traces = await db
    .select()
    .from(strategyExecutionTraces)
    .where(
      and(
        or(
          eq(strategyExecutionTraces.state, "ORDER_READY"),
          and(
            eq(strategyExecutionTraces.state, "EXPIRED"),
            eq(strategyExecutionTraces.resultCode, "ANALYSIS_EXPIRED"),
            gte(
              strategyExecutionTraces.updatedAt,
              new Date(
                now.getTime() - MAX_FROZEN_EXECUTION_VALIDITY_MS,
              ),
            ),
          ),
        ),
        notLike(strategyExecutionTraces.traceId, "short-%"),
        lte(
          strategyExecutionTraces.updatedAt,
          new Date(now.getTime() - ANALYSIS_CAPACITY_RECHECK_MS),
        ),
      ),
    )
    .orderBy(asc(strategyExecutionTraces.updatedAt))
    .limit(3);
  if (!traces.length) return 0;

  const strategyRows = await db
    .select({
      id: strategies.id,
      status: strategies.status,
      configJson: strategies.configJson,
    })
    .from(strategies)
    .where(
      inArray(
        strategies.id,
        [...new Set(traces.map((trace) => trace.strategyId))],
      ),
    );
  const strategyById = new Map(
    strategyRows.map((strategy) => [strategy.id, strategy]),
  );
  let retried = 0;
  for (const trace of traces) {
    const strategy = strategyById.get(trace.strategyId);
    const currentConfig = asRecord(safeParse(strategy?.configJson ?? "{}"));
    const currentTriggerKind = String(
      asRecord(currentConfig.trigger).kind ?? "",
    );
    const mainRouteOwnsShortExecution = MARKET_STRUCTURE_TRIGGER_KINDS.has(
      currentTriggerKind as
        | "GRID_PRICE_LEVEL"
        | "SCHEDULED_SCAN"
        | "BREAKOUT_RETEST",
    ) || MARKET_STRUCTURE_TRIGGER_KINDS.has(
      trace.triggerKind as
        | "GRID_PRICE_LEVEL"
        | "SCHEDULED_SCAN"
        | "BREAKOUT_RETEST",
    );
    if (
      !strategy ||
      strategy.status !== "RUNNING" ||
      (
        currentConfig.direction === "SHORT_ONLY" &&
        !mainRouteOwnsShortExecution
      )
    )
      continue;
    const evidence = asRecord(safeParse(trace.entryEvidenceJson));
    const frozenDecision = asRecord(evidence.frozenExecutionDecision);
    if (
      frozenDecision.approved !== true ||
      frozenDecision.decisionFrozen !== true ||
      frozenDecision.retryWithoutReanalysis !== true
    )
      continue;
    const config = await loadBoundLiquidationTrendConfig(trace);
    const executionDeadline = resolveFrozenExecutionDeadline({
      frozenDecision,
      analysisValiditySeconds: config.trigger.analysisValiditySeconds,
    });
    if (
      executionDeadline === null ||
      executionDeadline <= now.getTime()
    ) {
      const expiryReason = frozenExecutionExpiryReason(frozenDecision);
      if (trace.state !== "EXPIRED" ||
        trace.resultCode !== "NEXUS_FROZEN_EXECUTION_EXPIRED") {
        await db
          .update(strategyExecutionTraces)
          .set({
            state: "EXPIRED",
            resultCode: "NEXUS_FROZEN_EXECUTION_EXPIRED",
            resultMessage: expiryReason.summary,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(strategyExecutionTraces.id, trace.id));
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: "NEXUS_FROZEN_EXECUTION_EXPIRED",
          stage: "ORDER",
          outcome: "REJECTED",
          message:
            "获批执行窗口已结束；未提交订单，下一次爆仓事件重新建立判断生命周期",
          detail: {
            executionExpiresAt:
              executionDeadline === null
                ? null
                : new Date(executionDeadline).toISOString(),
            retryWithoutReanalysis: false,
            lastWaitCode: expiryReason.lastWaitCode,
            lastWaitMessage: expiryReason.lastWaitMessage,
          },
          eventAt: now,
        });
      }
      continue;
    }
    const recoveringExpiredAnalysis =
      trace.state === "EXPIRED" &&
      trace.resultCode === "ANALYSIS_EXPIRED";
    if (recoveringExpiredAnalysis) {
      await db
        .update(strategyExecutionTraces)
        .set({
          state: "ORDER_READY",
          resultCode: "NEXUS_EXECUTION_RETRY_READY",
          resultMessage:
            "历史版本将已获批订单误按分析时间过期；现已恢复独立执行窗口，环境恢复后直接重试",
          expiresAt: new Date(executionDeadline),
          completedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(strategyExecutionTraces.id, trace.id),
            eq(strategyExecutionTraces.state, "EXPIRED"),
          ),
        );
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "NEXUS_FROZEN_EXECUTION_WINDOW_RECOVERED",
        stage: "ORDER",
        outcome: "PENDING",
        message:
          "历史分析过期已恢复为待执行；不重新分析，只复核真实交易安全条件",
        detail: {
          previousResultCode: trace.resultCode,
          retryWithoutReanalysis: true,
          executionExpiresAt: new Date(executionDeadline).toISOString(),
        },
        eventAt: now,
      });
      trace.state = "ORDER_READY";
      trace.resultCode = "NEXUS_EXECUTION_RETRY_READY";
      trace.resultMessage =
        "历史分析过期已恢复为待执行；等待真实交易环境恢复";
      trace.expiresAt = new Date(executionDeadline);
      trace.completedAt = null;
      trace.updatedAt = now;
    } else if (trace.expiresAt.getTime() !== executionDeadline) {
      await db
        .update(strategyExecutionTraces)
        .set({
          expiresAt: new Date(executionDeadline),
          updatedAt: now,
        })
        .where(eq(strategyExecutionTraces.id, trace.id));
      trace.expiresAt = new Date(executionDeadline);
    }
    let executionMarkPrice = finiteNumber(
      evidence.executionApprovedMarkPrice,
      trace.liquidationPrice,
    );
    const deferFrozenMarkPrice = async (waitMessage: string) => {
      const renewal = renewFrozenExecutionDecision({
        frozenDecision: {
          ...frozenDecision,
          waitCode: "PILOT_MARK_PRICE_WAIT",
          waitMessage,
          lastDeferredAt: now.toISOString(),
        },
        deferredAt: now,
        waitCode: "PILOT_MARK_PRICE_WAIT",
        analysisValiditySeconds: config.trigger.analysisValiditySeconds,
      });
      evidence.frozenExecutionDecision = renewal.decision;
      const renewedDeadline = renewal.executionExpiresAtMs;
      await db.update(strategyExecutionTraces).set({
        resultCode: "PILOT_MARK_PRICE_WAIT",
        resultMessage: waitMessage,
        entryEvidenceJson: JSON.stringify(evidence),
        ...(renewedDeadline !== null
          ? {
              expiresAt: new Date(
                Math.max(trace.expiresAt.getTime(), renewedDeadline),
              ),
            }
          : {}),
        updatedAt: now,
      }).where(eq(strategyExecutionTraces.id, trace.id));
      if (renewedDeadline !== null) {
        trace.expiresAt = new Date(
          Math.max(trace.expiresAt.getTime(), renewedDeadline),
        );
      }
    };
    try {
      const [latestMark] = await getBinanceLiveMarkPrices([trace.symbol]);
      if (latestMark?.markPrice && Date.now() - latestMark.time <= 5_000)
        executionMarkPrice = latestMark.markPrice;
    } catch (error) {
      // Keep the frozen decision queued. The next monitor cycle retries it
      // without rebuilding or reversing the already approved market thesis.
      const waitMessage = error instanceof Error
        ? `最新标记价格读取失败：${error.message}`
        : "最新标记价格读取失败";
      await deferFrozenMarkPrice(waitMessage);
      continue;
    }
    if (!(executionMarkPrice > 0)) {
      const waitMessage = "最新标记价格无效，等待行情恢复";
      await deferFrozenMarkPrice(waitMessage);
      continue;
    }
    evidence.executionRetry = {
      version: 1,
      resumedAt: new Date().toISOString(),
      previousWaitCode: trace.resultCode,
      reanalysisPerformed: false,
      latestMarkPrice: executionMarkPrice,
    };
    await executeConfiguredEntrySafely(
      trace,
      frozenDecision.explorationProbe === true
        ? explorationExecutionConfig(config)
        : config,
      executionMarkPrice,
      evidence,
    );
    retried += 1;
  }
  return retried;
}

async function evaluateActiveTraces(
  marketFactCycle: NexusMarketFactCycle,
  marketAnalysisCycle: NexusMarketAnalysisCycle,
) {
  const db = getDb();
  const now = new Date();
  const frozenExecutionRetries =
    await retryFrozenLongExecutionDecisions();
  const liveQueuedCandidates = await db
    .select()
    .from(strategyExecutionTraces)
    .where(
      and(
        inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
        notLike(strategyExecutionTraces.traceId, "short-%"),
        // Expired analyses receive one final settlement pass later in this
        // poll, but must never consume one of the three live analysis slots.
        // Otherwise three stale rows can delay a fresh liquidation lifecycle
        // until its 1.5 second execution signal is no longer actionable.
        gt(strategyExecutionTraces.expiresAt, now),
        or(
          isNull(strategyExecutionTraces.resultCode),
          ne(strategyExecutionTraces.resultCode, "SHORT_MONITOR_STATUS"),
        ),
      ),
    )
    .orderBy(
      asc(strategyExecutionTraces.updatedAt),
      asc(strategyExecutionTraces.id),
    )
    .limit(20);
  for (const trace of liveQueuedCandidates) {
    if (
      trace.triggerKind !== "THREE_MINUTE_PROBABILITY" ||
      trace.createdAt.getTime() >= liquidationMonitorRuntimeStartedAt ||
      recoveredThreeMinuteCandidateTraceIds.has(trace.traceId)
    ) continue;
    recoveredThreeMinuteCandidateTraceIds.add(trace.traceId);
    recoveredThreeMinuteCandidateCount += 1;
    try {
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "THREE_MINUTE_CANDIDATE_QUEUE_RECOVERED",
        stage: "SIGNAL",
        outcome: "INFO",
        message:
          "主应用重启后已恢复3分钟候选，继续按当前概率进入统一执行链",
        detail: {
          runtimeStartedAt: new Date(
            liquidationMonitorRuntimeStartedAt,
          ).toISOString(),
          capacity: THREE_MINUTE_CANDIDATE_QUEUE_CAPACITY,
          enqueueBatch: THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH,
          preservedState: trace.state,
          bypassedGenericReanalysis: true,
        },
        eventAt: new Date(),
      });
    } catch {
      // Recovery of the official trace is authoritative. A best-effort
      // observability write must not strand it after the process restarts.
    }
  }
  const finalQueuedCandidates = await db
    .select()
    .from(strategyExecutionTraces)
    .where(
      and(
        inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
        notLike(strategyExecutionTraces.traceId, "short-%"),
        lte(strategyExecutionTraces.expiresAt, now),
        gte(
          strategyExecutionTraces.expiresAt,
          new Date(
            now.getTime() - NEXUS_FINAL_ANALYSIS_SETTLEMENT_GRACE_MS,
          ),
        ),
        or(
          isNull(strategyExecutionTraces.resultCode),
          ne(strategyExecutionTraces.resultCode, "SHORT_MONITOR_STATUS"),
        ),
      ),
    )
    .orderBy(
      asc(strategyExecutionTraces.updatedAt),
      asc(strategyExecutionTraces.id),
    )
    .limit(20);
  // Fresh opportunities always own the real-time evaluation slots.
  // Deadline candidates may use only spare slots for their final fact pass;
  // they are settled by expireUnresolvedAnalysisTraces later in this poll.
  const queuedCandidates = [
    ...liveQueuedCandidates,
    ...finalQueuedCandidates,
  ];
  const queuedStrategyIds = [
    ...new Set(queuedCandidates.map((trace) => trace.strategyId)),
  ];
  const queuedStrategyRows = queuedStrategyIds.length
    ? await db
        .select({
          id: strategies.id,
          status: strategies.status,
          configJson: strategies.configJson,
        })
        .from(strategies)
        .where(inArray(strategies.id, queuedStrategyIds))
    : [];
  const queuedStrategyById = new Map(
    queuedStrategyRows.map((strategy) => [strategy.id, strategy]),
  );
  const queuedTraces: typeof queuedCandidates = [];
  for (const trace of queuedCandidates) {
    const strategy = queuedStrategyById.get(trace.strategyId);
    const currentConfig = asRecord(
      safeParse(strategy?.configJson ?? "{}"),
    );
    const configuredDirection = currentConfig.direction;
    const traceDirection = trace.triggerDirection === "SHORT"
      ? "SHORT"
      : "LONG";
    const directionAllowed = configuredDirection === "BOTH" ||
      (configuredDirection === "LONG_ONLY" && traceDirection === "LONG") ||
      (configuredDirection === "SHORT_ONLY" && traceDirection === "SHORT");
    if (
      !strategy ||
      strategy.status !== "RUNNING" ||
      !directionAllowed
    ) {
      await db
        .update(strategyExecutionTraces)
        .set({
          state: "CANCELED",
          resultCode: "DIRECTION_CHANGED_SKIPPED",
          resultMessage: "当前策略方向不再允许该候选方向，本条旧机会已跳过",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(strategyExecutionTraces.id, trace.id),
            inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
          ),
        );
      continue;
    }
    queuedTraces.push(trace);
  }
  if (!queuedTraces.length)
    return {
      checked: frozenExecutionRetries,
      ready: 0,
      pending: 0,
      rejected: 0,
      errors: 0,
      marketDataWait: false,
      marketDataWaitReason: null as string | null,
    };
  const directProbabilityTraces = queuedTraces.filter(
    (trace) => trace.triggerKind === "THREE_MINUTE_PROBABILITY",
  );
  const directProbabilityTraceIds = new Set(
    directProbabilityTraces.map((trace) => trace.id),
  );
  const restAnalysisTraces = queuedTraces.filter((trace) =>
    !directProbabilityTraceIds.has(trace.id)
  );
  const restCapacityCooling = analysisCapacityRetryAt > Date.now();
  let availableAnalysisSlots = 0;
  if (!restCapacityCooling) {
    try {
      const metrics = await getBinanceLiveSystemMetrics();
      availableAnalysisSlots = binanceAnalysisCapacity({
        rest: metrics.rest,
        weightPerSymbol: ANALYSIS_REST_WEIGHT_PER_TRACE,
        configuredMaxSymbols: Math.max(1, restAnalysisTraces.length),
      }).maxSymbols;
    } catch {
      availableAnalysisSlots = 0;
    }
  }
  if (availableAnalysisSlots < 1 && restAnalysisTraces.length) {
    analysisCapacityRetryAt = Date.now() + ANALYSIS_CAPACITY_RECHECK_MS;
    await pauseAnalysisClocksForTransientWait(restAnalysisTraces, {
      code: restCapacityCooling
        ? "REST_ANALYSIS_CAPACITY_COOLDOWN"
        : "REST_ANALYSIS_CAPACITY_EXHAUSTED",
      message: restCapacityCooling
        ? "Binance REST 分析额度正在冷却"
        : "Binance REST 分析额度不足",
    });
  }
  if (availableAnalysisSlots < 1 && !directProbabilityTraces.length) {
    return {
      checked: 0,
      ready: 0,
      pending: queuedTraces.length,
      rejected: 0,
      errors: 0,
      marketDataWait: true,
      marketDataWaitReason: restCapacityCooling
        ? "Binance REST 分析额度正在冷却，WebSocket 信号继续接收"
        : "Binance REST 分析额度不足，暂停K线请求但继续接收WebSocket信号",
    };
  }
  const traces = [
    ...directProbabilityTraces.slice(0, THREE_MINUTE_CANDIDATE_ENQUEUE_BATCH),
    ...restAnalysisTraces.slice(0, availableAnalysisSlots),
  ];
  let markRows: Awaited<ReturnType<typeof getBinanceLiveMarkPrices>>;
  try {
    markRows = await getBinanceLiveMarkPrices([
        ...new Set(traces.map((trace) => trace.symbol)),
      ], { includeHistory: true });
  } catch (error) {
    if (!isTransientMarketDataWait(error)) throw error;
    await pauseAnalysisClocksForTransientWait(traces, {
      code: "MARK_PRICE_REQUEST_WAIT",
      message: error.message,
    });
    return {
      checked: traces.length,
      ready: 0,
      pending: traces.length,
      rejected: 0,
      errors: 0,
      marketDataWait: true,
      marketDataWaitReason: error.message,
    };
  }
  const marks = new Map(markRows.map((item) => [item.symbol, item]));
  type MarkRow = (typeof markRows)[number];
  const refreshedMarks = new Map<string, MarkRow | null>();
  const activityRows = await db
    .select({
      symbol: contractSymbols.symbol,
      quoteVolume24h: contractSymbols.quoteVolume24h,
      lastPrice: contractSymbols.lastPrice,
      priceChangePercent: contractSymbols.priceChangePercent,
      highPrice: contractSymbols.highPrice,
      lowPrice: contractSymbols.lowPrice,
      marketSyncedAt: contractSymbols.marketSyncedAt,
    })
    .from(contractSymbols)
    .where(eq(contractSymbols.isActive, true));
  const activeSymbolByName = new Map(
    activityRows.map((item) => [item.symbol, item]),
  );
  const activeQuoteVolumes24h = activityRows.map(
    (item) => item.quoteVolume24h,
  );
  let ready = 0;
  let pending = 0;
  let rejected = 0;
  let errors = 0;
  let marketDataWait = false;
  let marketDataWaitReason: string | null = null;
  for (const trace of traces) {
    try {
    const config = await loadBoundLiquidationTrendConfig(trace);
    const modelProgress = await currentStrategyModelProgress(
      trace,
      config.execution.explorationOrderTarget,
    );
    const storedEvidence = asRecord(safeParse(trace.entryEvidenceJson));
    const triggerKind = isStrategyTriggerKind(trace.triggerKind)
      ? trace.triggerKind
      : "LIQUIDATION_WINDOW";
    const liquidationTrigger = triggerKind === "LIQUIDATION_WINDOW";
    let brainDirection = !liquidationTrigger &&
        trace.triggerDirection === "SHORT"
      ? "SHORT" as const
      : "LONG" as const;
    let triggerReferencePrice =
      trace.triggerReferencePrice > 0
        ? trace.triggerReferencePrice
        : trace.liquidationPrice;
    const traceEngineVersion = decisionEngineVersionFromEvidence(storedEvidence);
    if (traceEngineVersion !== LIQUIDATION_DECISION_ENGINE_VERSION) {
      rejected += 1;
      await db
        .update(strategyExecutionTraces)
        .set({
          state: "REJECTED",
          resultCode: "DECISION_ENGINE_VERSION_RETIRED",
          resultMessage: "该分析由旧决策引擎创建，已终止且不会进入实盘委托",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(strategyExecutionTraces.id, trace.id),
            inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
          ),
        );
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "DECISION_ENGINE_VERSION_RETIRED",
        stage: "ORDER",
        outcome: "REJECTED",
        message: "旧决策引擎的未完成分析已隔离，不允许跨版本继续下单",
        detail: {
          traceEngineVersion,
          currentEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
          orderSubmissionAllowed: false,
        },
        eventAt: new Date(),
      });
      continue;
    }
    const signalCluster = liquidationTrigger
      ? await readSignalClusterSummary(
          trace,
          (config.trigger.maxClusterSpanSeconds ?? 3) * 1_000,
          (config.trigger.maxClusterEventGapSeconds ??
            config.trigger.maxClusterSpanSeconds ??
            3) * 1_000,
        )
      : {
          clusterCount: 0,
          eventCount: 0,
          totalNotional: 0,
          minLiquidationPrice: triggerReferencePrice,
          maxLiquidationPrice: triggerReferencePrice,
          firstEventAt: trace.eventTime.getTime(),
          lastEventAt: trace.eventTime.getTime(),
          clusterSpanMs: 0,
          maxClusterSpanMs: 0,
          maxInterEventGapMs: 0,
          excludedLateClusters: 0,
        };
    const freshTriggerLiquidationEventCount = liquidationTrigger
      ? await readRollingLiquidationTriggerCount(trace, config)
      : 0;
    const liquidationCascadeSeries = liquidationTrigger
      ? await readLiquidationCascadeSeries(trace)
      : {
          events: [],
          context: analyzeLiquidationCascadeContext({
            events: [],
            liquidationSide: "SELL",
          }),
        };
    const liquidationCascadeContext = liquidationCascadeSeries.context;
    const existingEvidence: Record<string, unknown> = {
      ...storedEvidence,
      symbol: trace.symbol,
      ...(liquidationTrigger
        ? { signalCluster, liquidationCascadeContext }
        : {}),
      strategyModelProgress: modelProgress,
    };
    // 旧版本残留的探索标记不能直接继承；本轮在完整市场快照形成后重算。
    delete existingEvidence.explorationOrderFirst;
    // Retired analyzer fields must not leak into the NEXUS runtime. Old
    // completed samples remain readable in history, but an active trace is
    // rewritten from unified facts and named state-machine output only.
    for (const key of [
      "high24h",
      "low24h",
      "high72h",
      "low72h",
      "position24hPercent",
      "position72hPercent",
      "maxPosition72hPercent",
      "atr5m",
      "confirmationLevel",
      "invalidBoundary",
      "oneHour",
      "thirtyMinute",
      "fiveMinute",
      "threeMinute",
      "liquiditySweep",
      "positionGateContinuationShadow",
      "consensusShadow",
    ])
      delete existingEvidence[key];
    let initialMark = marks.get(trace.symbol);
    if (
      !initialMark?.markPrice ||
      Date.now() - initialMark.time > 5_000
    ) {
      if (!refreshedMarks.has(trace.symbol)) {
        try {
          const [refreshedMark] = await getBinanceLiveMarkPrices([
            trace.symbol,
          ]);
          refreshedMarks.set(trace.symbol, refreshedMark ?? null);
        } catch {
          refreshedMarks.set(trace.symbol, null);
        }
      }
      const refreshedMark = refreshedMarks.get(trace.symbol);
      if (refreshedMark) {
        initialMark = refreshedMark;
        marks.set(trace.symbol, refreshedMark);
      }
    }
    let markPrice = initialMark?.markPrice ?? 0;
    let markEventAt = initialMark?.time ?? 0;
    const markAgeMs = markEventAt > 0 ? Date.now() - markEventAt : null;
    const invalidDataCode = !markPrice
        ? "MARK_PRICE_MISSING"
        : markAgeMs === null || markAgeMs > 5_000
          ? "MARK_PRICE_STALE"
          : null;
    if (invalidDataCode) {
      let clockPause: Awaited<
        ReturnType<typeof pauseAnalysisClockForTransientWait>
      > | null = null;
      pending += 1;
      marketDataWait = true;
      marketDataWaitReason =
        invalidDataCode === "MARK_PRICE_MISSING"
          ? `${trace.symbol} 统一 WebSocket 暂未返回标记价格`
          : `${trace.symbol} 统一 WebSocket 标记价格已过期`;
      clockPause = await pauseAnalysisClockForTransientWait(trace, config, {
        code: invalidDataCode,
        message: marketDataWaitReason,
      });
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "ANALYSIS_DATA_INVALID",
        stage: "POSITION",
        outcome: "PENDING",
        message: invalidDataCode === "MARK_PRICE_MISSING"
          ? `${trace.symbol} 统一 WebSocket 暂未返回标记价格，等待下一轮`
          : `${trace.symbol} 统一 WebSocket 标记价格已过期，等待新鲜行情`,
        detail: {
          monitorOnly: true,
          code: invalidDataCode,
          markEventAt: markEventAt || null,
          markAgeMs,
          staleAfterMs: 5_000,
          refreshedOnce: true,
          clockPause,
        },
        eventAt: new Date(),
      });
      continue;
    }
    const previousMarketDataPause = asRecord(
      existingEvidence.analysisMarketDataPause,
    );
    if (previousMarketDataPause.status === "WAITING") {
      existingEvidence.analysisMarketDataPause = {
        ...previousMarketDataPause,
        status: "RESUMED",
        resumedAt: new Date().toISOString(),
        recoveredMarkEventAt: markEventAt,
        recoveredMarkAgeMs: markAgeMs,
      };
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "ANALYSIS_MARKET_DATA_CLOCK_RESUMED",
        stage: "POSITION",
        outcome: "PASSED",
        message: `${trace.symbol} 新鲜行情已恢复，沿用原生命周期继续判断`,
        detail: asRecord(existingEvidence.analysisMarketDataPause),
        eventAt: new Date(),
      });
    }
    if (triggerKind === "THREE_MINUTE_PROBABILITY") {
      const probabilityEvidence = asRecord(
        existingEvidence.threeMinuteProbability,
      );
      const selectedDirection = probabilityEvidence.direction === "SHORT"
        ? "SHORT" as const
        : probabilityEvidence.direction === "LONG"
          ? "LONG" as const
          : traceDirection;
      brainDirection = selectedDirection;
      triggerReferencePrice = Math.max(
        0,
        finiteNumber(
          probabilityEvidence.referencePrice,
          triggerReferencePrice,
        ),
      ) || triggerReferencePrice;
      trace.triggerDirection = selectedDirection;
      trace.triggerReferencePrice = triggerReferencePrice;
      trace.liquidationSide = selectedDirection === "LONG" ? "SELL" : "BUY";
      trace.liquidationPrice = triggerReferencePrice;
      existingEvidence.brainDecisionDirection = selectedDirection;
      existingEvidence.tradeDirection = selectedDirection;
      existingEvidence.executionDirection = resolveStrategyExecutionDirection({
        mode: config.execution.directionMode,
        brainDirection: selectedDirection,
      });

      const directEyeDecision = decideThreeMinuteProbabilityEye({
        probabilityEvidence,
        direction: selectedDirection,
        minimumProbabilityPercent:
          config.trigger.threeMinuteProbability?.minimumProbabilityPercent ??
          DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.minimumProbabilityPercent,
        minimumNetEdgeBps:
          config.trigger.threeMinuteProbability?.minimumNetEdgeBps ??
          DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.minimumNetEdgeBps,
      });
      const directFeatureVector = asRecord(probabilityEvidence.featureVector);
      const directAtr5m = finiteNumber(directFeatureVector.atr5m, 0);
      const directEvidence: Record<string, unknown> = {
        ...existingEvidence,
        brainDecisionDirection: selectedDirection,
        tradeDirection: selectedDirection,
        executionApprovedMarkPrice: markPrice,
        nexusMarketEyeDecision: directEyeDecision,
        nexusDecisionSnapshot: {
          complete: directEyeDecision.dataIntegrity === "ALIGNED",
          integrity: directEyeDecision.dataIntegrity,
          integritySummary: directEyeDecision.dataIntegritySummary,
          factSnapshotId: directEyeDecision.factSnapshotId,
        },
        nexusOwnEntryRegime5m: {
          version: "three-minute-direct-entry-regime-v1",
          regime: "DIRECT_PROBABILITY",
          atr: directAtr5m,
          source: "CURRENT_SHARED_FACT_SNAPSHOT",
        },
        nexusVolumeTiming: {
          state: "DIRECT_PROBABILITY",
          source: "CURRENT_SHARED_FACT_SNAPSHOT",
        },
        nexusFundingContext: {
          fundingRate: initialMark?.fundingRate ?? null,
          observationOnly: true,
        },
      };
      if (directEyeDecision.verdict !== "CONFIRMED" || directAtr5m <= 0) {
        rejected += 1;
        const resultCode = directAtr5m <= 0
          ? "THREE_MINUTE_DIRECT_ATR_MISSING"
          : directEyeDecision.code;
        const resultMessage = directAtr5m <= 0
          ? "当前概率事实缺少可执行的5分钟ATR，本候选销毁并由持续扫描补位"
          : directEyeDecision.summary;
        await db
          .update(strategyExecutionTraces)
          .set({
            state: "REJECTED",
            resultCode,
            resultMessage,
            entryEvidenceJson: JSON.stringify(directEvidence),
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(strategyExecutionTraces.id, trace.id),
              inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
            ),
          );
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: `THREE_MINUTE_DIRECT_CANDIDATE_DISCARDED:${resultCode}`,
          stage: "ORDER",
          outcome: "REJECTED",
          message: resultMessage,
          detail: {
            probabilityDecision: directEyeDecision,
            atr5m: directAtr5m || null,
            queueRefillAllowed: true,
            orderSubmissionAllowed: false,
          },
          eventAt: new Date(),
        });
        continue;
      }

      ready += 1;
      const pilot = pilotRuntime();
      if (pilot.enabled && existingEvidence.sentinelAdvisoryOnly !== true) {
        directEvidence.executionAuthorization = entryAuthorizationEvidence(
          "CONFIRMED_EYE",
          { reasonCode: directEyeDecision.code },
        );
        directEvidence.frozenExecutionDecision = {
          version: 1,
          approved: true,
          decisionFrozen: true,
          retryWithoutReanalysis: true,
          explorationProbe: false,
          approvedAt: new Date().toISOString(),
          approvalCode: directEyeDecision.code,
          approvalSummary: directEyeDecision.summary,
        };
        await persistFrozenLongExecutionDecision(
          trace,
          directEvidence,
          config.trigger.analysisValiditySeconds,
        );
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: "THREE_MINUTE_DIRECT_PROBABILITY_APPROVED",
          stage: "ORDER",
          outcome: "PASSED",
          message:
            "当前共享事实的多空概率已达到策略门槛，跳过通用重分析并进入统一执行安全链",
          detail: {
            direction: selectedDirection,
            selectedProbabilityPercent:
              directEyeDecision.selectedProbabilityPercent,
            atr5m: directAtr5m,
            bypassedGenericReanalysis: true,
            orderSubmissionAllowed: true,
          },
          eventAt: new Date(),
        });
        await executeConfiguredEntrySafely(
          trace,
          config,
          markPrice,
          directEvidence,
        );
      } else {
        await db
          .update(strategyExecutionTraces)
          .set({
            state: "MONITOR_READY",
            resultCode: directEyeDecision.code,
            resultMessage:
              `${directEyeDecision.summary}；只监控模式未提交订单`,
            entryEvidenceJson: JSON.stringify(directEvidence),
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(strategyExecutionTraces.id, trace.id),
              inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
            ),
          );
      }
      continue;
    }
    const [executionRule] = await db
      .select({
        minOrderQty: contractSymbols.minOrderQty,
        quantityStep: contractSymbols.quantityStep,
        minNotionalUsdt: contractSymbols.minNotionalUsdt,
      })
      .from(contractSymbols)
      .where(
        and(
          eq(contractSymbols.symbol, trace.symbol),
          eq(contractSymbols.isActive, true),
        ),
      )
      .limit(1);
    const preflightReferencePrice =
      config.execution.orderType === "LIMIT_OFFSET"
        ? markPrice * (1 - config.execution.limitOffsetPercent / 100)
        : markPrice;
    const postExitReentryMinimumQuantity =
      asRecord(existingEvidence.postExitReentryCandidate).eligible === true &&
      asRecord(existingEvidence.postExitReentryCandidate).minimumQuantityOnly ===
        true;
    const preflightMinimumOrderQuantityMultiplier =
      postExitReentryMinimumQuantity
        ? 1
        : config.execution.minimumOrderQuantityMultiplier;
    const executionFeasibility = executionRule
      ? smallestPilotQuantity({
          markPrice: preflightReferencePrice,
          minOrderQty: executionRule.minOrderQty,
          quantityStep: executionRule.quantityStep,
          minNotionalUsdt: executionRule.minNotionalUsdt,
          leverage: config.execution.leverage,
          targetNotionalUsdt: config.execution.targetOrderNotionalUsdt,
          maxOrderNotionalUsdt: Number.MAX_SAFE_INTEGER,
          minimumOrderQuantityMultiplier:
            preflightMinimumOrderQuantityMultiplier,
        })
      : null;
    const requiredMinimumNotionalUsdt =
      executionFeasibility?.notional ?? null;
    const executableUnderCurrentLimit =
      executionFeasibility?.requiredMargin !== undefined &&
      executionFeasibility.requiredMargin <=
        config.execution.maxOrderNotionalUsdt + 1e-8;
    existingEvidence.executionFeasibilityAtTrigger = {
      referencePrice: preflightReferencePrice,
      requiredMinimumQuantity: executionFeasibility?.quantity ?? null,
      minimumOrderQuantityMultiplier:
        preflightMinimumOrderQuantityMultiplier ?? 1,
      requiredMinimumNotionalUsdt,
      requiredMinimumMarginUsdt:
        executionFeasibility?.requiredMargin ?? null,
      leverage: config.execution.leverage,
      strategyTargetNotionalUsdt:
        config.execution.targetOrderNotionalUsdt,
      strategyMaxOrderNotionalUsdt:
        config.execution.maxOrderNotionalUsdt,
      strategyTargetMarginUsdt:
        config.execution.targetOrderNotionalUsdt,
      strategyMaxOrderMarginUsdt:
        config.execution.maxOrderNotionalUsdt,
      executableUnderCurrentLimit,
      analysisContinues: true,
      orderAffectingOnlyAfterBrainConfirmation: true,
    };
    await appendEvent(trace.traceId, trace.strategyId, {
      eventType: executableUnderCurrentLimit
        ? "EXECUTION_CAPACITY:READY"
        : "EXECUTION_CAPACITY:INSUFFICIENT",
      stage: "ORDER",
      outcome: "INFO",
      message: executableUnderCurrentLimit
        ? "执行容量已就绪：交易所最小量和资金可执行；这不是大脑批准、探针授权或订单提交。"
        : `执行容量不足：当前额度暂不能执行交易所最小量；大脑仍可完成分析，但没有订单提交权限。`,
      detail: {
        ...asRecord(existingEvidence.executionFeasibilityAtTrigger),
        capacityOnly: true,
        brainApproved: false,
        probeAuthorized: false,
        orderSubmissionAllowed: false,
      },
      eventAt: new Date(),
    });
    await appendEvent(trace.traceId, trace.strategyId, {
      eventType: `LIQUIDATION_CASCADE:${liquidationCascadeContext.phase}`,
      stage: "SIGNAL",
      outcome: "INFO",
      message: liquidationCascadeContext.reason,
      detail: liquidationCascadeContext,
      eventAt: new Date(),
    });
    // Refresh the dynamic watch before the slower multi-timeframe analysis.
    // This is internal proxy traffic and does not consume Binance REST weight.
    await warmNexusBookTicker(trace.symbol);
    try {
      const analysisSeries = await settleNexusAnalysisCandleSeries({
        requests: {
          trade4h: marketAnalysisCycle
            .closedSnapshot({
              symbol: trace.symbol,
              interval: "4h",
              source: "TRADE",
              limit: 24,
            }),
          trade1h: marketAnalysisCycle
            .closedSnapshot({
              symbol: trace.symbol,
              interval: "1h",
              source: "TRADE",
              limit: 73,
            }),
          trade30m: marketAnalysisCycle
            .closedSnapshot({
              symbol: trace.symbol,
              interval: "30m",
              source: "TRADE",
              limit: 12,
            }),
          trade15m: marketAnalysisCycle
            .closedSnapshot({
              symbol: trace.symbol,
              interval: "15m",
              source: "TRADE",
              limit: 24,
            }),
          trade5m: marketAnalysisCycle
            .closedSnapshot({
              symbol: trace.symbol,
              interval: "5m",
              source: "TRADE",
              limit: Math.max(61, config.trend.atrPeriod5m + 2),
            }),
          trade3m: marketAnalysisCycle
            .closedSnapshot({
              symbol: trace.symbol,
              interval: "3m",
              source: "TRADE",
              limit: 30,
            }),
          trade1m: marketAnalysisCycle
            .closedSnapshot({
              symbol: trace.symbol,
              interval: "1m",
              source: "TRADE",
              limit: 60,
            }),
          btcTrade1h: marketAnalysisCycle
            .closedSnapshot({
              symbol: "BTCUSDT",
              interval: "1h",
              source: "TRADE",
              limit: 61,
            }),
        },
        // 5m supplies the ATR invalidation boundary used by normal entries
        // and minimum exploration probes. A transient miss on another
        // horizon lowers analytical completeness, but must not make the
        // documented second-liquidation learning path unreachable.
        requiredSeries: ["trade1m", "trade5m", "trade15m"],
      });
      if (analysisSeries.requiredFailure)
        throw analysisSeries.requiredFailure;
      const {
        trade4h,
        trade1h,
        trade30m,
        trade15m,
        trade5m,
        trade3m,
        trade1m,
        btcTrade1h,
      } = analysisSeries.rows;
      const analysisSources = analysisSeries.sources;
      const latestMark = (await getBinanceLiveMarkPrices([trace.symbol]))[0];
      if (
        !latestMark ||
        !Number.isFinite(latestMark.markPrice) ||
        latestMark.markPrice <= 0 ||
        Date.now() - latestMark.time > 5_000
      )
        throw new BinanceLiveError(
          "统一 WebSocket 标记价格超过5秒，暂停本轮开仓判断",
          503,
        );
      markPrice = latestMark.markPrice;
      markEventAt = latestMark.time;
      const brainEvaluatedAt = Date.now();
      const nexusOwnMacroCompatibility = classifyNexusMarketRegimeFromCandles({
        candles: trade1h.slice(-6),
        fastPeriod: 2,
        slowPeriod: 5,
        atrPeriod: 5,
      });
      const nexusOwnMultiHourContext = analyzeNexusMultiHourContext({
        candles1h: trade1h,
        candles15m: trade15m,
        evaluatedAt: brainEvaluatedAt,
      });
      const nexusDailyMarketActivity = analyzeNexusDailyMarketActivity({
        symbol: trace.symbol,
        quoteVolume24h:
          activeSymbolByName.get(trace.symbol)?.quoteVolume24h,
        universeQuoteVolumes24h: activeQuoteVolumes24h,
        recentVolumeRatio:
          nexusOwnMultiHourContext.volume.relativeRatio,
      });
      const nexusOwnEntryRegime5m = classifyNexusMarketRegimeFromCandles({
        candles: trade5m,
      });
      const nexusBtcMacroRegime6h = classifyNexusMarketRegimeFromCandles({
        candles: btcTrade1h.slice(-6),
        fastPeriod: 2,
        slowPeriod: 5,
        atrPeriod: 5,
      });
      const nexusBtcRelationship = analyzeNexusBtcRelationship({
        altCandles: trade1h,
        btcCandles: btcTrade1h,
        fastWindow: 12,
        slowWindow: 60,
        minimumObservations: 20,
        relativeVolumeOverride:
          nexusOwnMultiHourContext.volume.relativeRatio,
        relativeVolumeThreshold: config.trend.volumeRatio3m,
      });
      const entryRegimeEventAt =
        (trade5m.at(-1)?.openTime ?? brainEvaluatedAt - 5 * 60_000) +
        5 * 60_000 -
        1;
      const macroRegimeEventAt =
        (trade1h.at(-1)?.openTime ?? brainEvaluatedAt - 60 * 60_000) +
        60 * 60_000 -
        1;
      const btcMacroRegimeEventAt =
        (btcTrade1h.at(-1)?.openTime ??
          brainEvaluatedAt - 60 * 60_000) +
        60 * 60_000 -
        1;
      const nexusPriceImpulse = analyzeNexusLiquidationPriceImpulse({
        candles: trade1m,
        triggerEventAt: trace.eventTime.getTime(),
        triggerPrice: triggerReferencePrice,
        liquidationSide: trace.liquidationSide as "BUY" | "SELL",
        evaluatedAt: brainEvaluatedAt,
      });
      const entryRelativeVolume1m =
        calculateNexusClosedEntryRelativeVolume(trade1m);
      const factorOpenInterest = liquidationTrigger
        ? await readLiquidationFactorOpenInterest(trace.symbol)
        : {
            openInterestValue: null,
            openInterestChangePercent: null,
          };
      const liquidationFactorPolicy = normalizeLiquidationFactorPolicy(
        config.liquidationFactors,
        {
          minimumEvents: config.trigger.minClusterEvents ?? 3,
          minimumAmountUsdt: config.trigger.minLiquidationNotionalUsdt,
          observationWindowSeconds:
            config.trigger.maxClusterSpanSeconds ?? 120,
          minimumVolumeRatio: config.trend.volumeRatio3m,
        },
      );
      const liquidationFactorSnapshot = deriveLiquidationDerivedFactors({
        symbol: trace.symbol,
        liquidationSide: trace.liquidationSide as "BUY" | "SELL",
        events: selectLiquidationFactorEpisode(
          liquidationCascadeSeries.events,
          {
            maximumWindowMs:
              (config.trigger.maxClusterSpanSeconds ?? 120) * 1_000,
            maximumInterEventGapMs:
              (config.trigger.maxClusterEventGapSeconds ??
                config.trigger.maxClusterSpanSeconds ??
                120) * 1_000,
          },
        ),
        pricePoints: trade1m.map((candle) => ({
          eventAtMs: candle.openTime + 60_000 - 1,
          price: candle.close,
        })),
        evaluatedAt: brainEvaluatedAt,
        latestPrice: latestMark.markPrice,
        openInterestValue: factorOpenInterest.openInterestValue,
        openInterestChangePercent:
          factorOpenInterest.openInterestChangePercent,
        fundingRate: latestMark.fundingRate,
        relativeVolume: entryRelativeVolume1m,
      });
      const liquidationFactorFact = liquidationTrigger
        ? liquidationDerivedFactorMarketFact({
            symbol: trace.symbol,
            eventAt:
              liquidationFactorSnapshot.windowEndedAt ??
              trace.eventTime.getTime(),
            receivedAt: brainEvaluatedAt,
            expiresAt: trace.expiresAt.getTime(),
            snapshot: liquidationFactorSnapshot,
          })
        : null;
      const liquidationFactorDecision = liquidationTrigger
        ? evaluateLiquidationFactorBrain({
            direction: brainDirection,
            snapshot: liquidationFactorSnapshot,
            policy: liquidationFactorPolicy,
          })
        : null;
      const preTrigger3mReference = buildNexusPreTriggerVolumeReference({
        candles: trade3m,
        triggerEventAt: trace.eventTime.getTime(),
      });
      const nexusVolumeTiming = analyzeNexusVolumeTimingConcordance({
        decisionAt: brainEvaluatedAt,
        triggerEventAt: trace.eventTime.getTime(),
        currentExecutionCloseAt: trade1m.at(-1)
          ? trade1m.at(-1)!.openTime + 60_000 - 1
          : null,
        currentContextCloseAt: trade15m.at(-1)
          ? trade15m.at(-1)!.openTime + 15 * 60_000 - 1
          : null,
        historicalImpulseVolumeRatio: liquidationTrigger
          ? nexusPriceImpulse.timingVolumeRatio
          : null,
        historicalImpulseConcentrated: liquidationTrigger
          ? nexusPriceImpulse.volumeConcentrated
          : false,
        currentExecutionVolumeRatio: entryRelativeVolume1m,
        currentContextVolumeRatio:
          nexusOwnMultiHourContext.volume.relativeRatio,
        requiredVolumeRatio: config.trend.volumeRatio3m,
        executionIntervalMs: 60_000,
        contextIntervalMs: 15 * 60_000,
      });
      const nexusTemporalShadow = analyzeNexusTemporalShadow({
        executionCandles: trade1m,
        contextCandles: trade15m,
        evaluatedAt: brainEvaluatedAt,
        executionIntervalMs: 60_000,
        contextIntervalMs: 15 * 60_000,
      });
      const fundingContextForDirection = (direction: "LONG" | "SHORT") =>
        analyzeNexusFundingContext({
          direction,
          fundingRate: latestMark.fundingRate,
          nextFundingTime: latestMark.nextFundingTime,
          observedPriceDirection: liquidationTrigger
            ? nexusPriceImpulse.observedDirection
            : null,
          volumeConcentrated: liquidationTrigger
            ? nexusPriceImpulse.volumeConcentrated
            : false,
          contextPhase: liquidationTrigger
            ? nexusPriceImpulse.contextPhase
            : null,
        });
      const nexusPriceImpulseFact = liquidationTrigger
        ? liquidationPriceImpulseMarketFact({
            symbol: trace.symbol,
            eventAt: trace.eventTime.getTime(),
            receivedAt: brainEvaluatedAt,
            expiresAt: trace.expiresAt.getTime(),
            impulse: nexusPriceImpulse,
          })
        : null;
      const closedMarketFacts = [
        ...(liquidationFactorFact ? [liquidationFactorFact] : []),
        ...marketFactCycle.closedCandles({
          symbol: trace.symbol,
          interval: "4h",
          candles: trade4h,
          receivedAt:
            analysisSources.trade4h.receivedAt ?? brainEvaluatedAt,
          structureLookback: 12,
          volumeLookback: 12,
          volumeExpansionRatio: config.trend.volumeRatio3m,
        }),
        ...marketFactCycle.closedCandles({
          symbol: trace.symbol,
          interval: "1m",
          candles: trade1m,
          receivedAt:
            analysisSources.trade1m.receivedAt ?? brainEvaluatedAt,
          structureLookback: 20,
          volumeLookback: 20,
          volumeExpansionRatio: config.trend.volumeRatio3m,
        }),
        ...marketFactCycle.closedCandles({
          symbol: trace.symbol,
          interval: "3m",
          candles: trade3m,
          receivedAt:
            analysisSources.trade3m.receivedAt ?? brainEvaluatedAt,
          structureLookback: 20,
          volumeLookback: 10,
          volumeExpansionRatio: config.trend.volumeRatio3m,
        }),
        ...marketFactCycle.closedCandles({
          symbol: trace.symbol,
          interval: "5m",
          candles: trade5m,
          receivedAt:
            analysisSources.trade5m.receivedAt ?? brainEvaluatedAt,
          structureLookback: 12,
          volumeLookback: 20,
          volumeExpansionRatio: config.trend.volumeRatio3m,
        }),
        ...marketFactCycle.closedCandles({
          symbol: trace.symbol,
          interval: "15m",
          candles: trade15m,
          receivedAt:
            analysisSources.trade15m.receivedAt ?? brainEvaluatedAt,
          structureLookback: 20,
          volumeLookback: 20,
          volumeExpansionRatio: config.trend.volumeRatio3m,
        }),
        ...marketFactCycle.closedCandles({
          symbol: trace.symbol,
          interval: "30m",
          candles: trade30m,
          receivedAt:
            analysisSources.trade30m.receivedAt ?? brainEvaluatedAt,
          structureLookback: 12,
          volumeLookback: 12,
          volumeExpansionRatio: config.trend.volumeRatio3m,
        }),
        ...marketFactCycle.closedCandles({
          symbol: trace.symbol,
          interval: "1h",
          candles: trade1h,
          receivedAt:
            analysisSources.trade1h.receivedAt ?? brainEvaluatedAt,
          structureLookback: 12,
          volumeLookback: 12,
          volumeExpansionRatio: config.trend.volumeRatio3m,
        }),
        markPriceMarketFact({
          symbol: trace.symbol,
          markPrice,
          eventAt: markEventAt,
          receivedAt: latestMark.receivedAt,
        }),
        trendRegimeMarketFact({
          symbol: trace.symbol,
          interval: "5m",
          eventAt: entryRegimeEventAt,
          receivedAt:
            analysisSources.trade5m.receivedAt ?? brainEvaluatedAt,
          regime: nexusOwnEntryRegime5m,
        }),
        trendRegimeMarketFact({
          symbol: trace.symbol,
          interval: "1h",
          eventAt: macroRegimeEventAt,
          receivedAt:
            analysisSources.trade1h.receivedAt ?? brainEvaluatedAt,
          regime: nexusOwnMacroCompatibility,
        }),
        ...marketFactCycle.closedCandles({
          symbol: "BTCUSDT",
          interval: "1h",
          candles: btcTrade1h,
          receivedAt:
            analysisSources.btcTrade1h.receivedAt ?? brainEvaluatedAt,
          structureLookback: 6,
          volumeLookback: 6,
          volumeExpansionRatio: config.trend.volumeRatio3m,
        }),
        trendRegimeMarketFact({
          symbol: "BTCUSDT",
          interval: "1h",
          eventAt: btcMacroRegimeEventAt,
          receivedAt:
            analysisSources.btcTrade1h.receivedAt ?? brainEvaluatedAt,
          regime: nexusBtcMacroRegime6h,
        }),
        ...(nexusPriceImpulseFact ? [nexusPriceImpulseFact] : []),
      ];
      const triggerFactExpiry = nexusLifecycleTriggerExpiry(
        trace.expiresAt.getTime(),
        brainEvaluatedAt,
      );
      const storedTriggerFacts = restoreStrategyTriggerFacts({
        value: [
          existingEvidence.nexusTriggerFact,
          ...(Array.isArray(existingEvidence.nexusMarketFactsShadow)
            ? existingEvidence.nexusMarketFactsShadow
            : []),
        ],
        symbol: trace.symbol,
        triggerKind,
        // Expired candidates receive one final fact-settlement pass before
        // closure. Keep the immutable trigger alive for that exact replay so
        // the state machine cannot forget why this lifecycle started.
        traceExpiresAt: triggerFactExpiry,
      });
      const rebuiltStructureTriggerFacts = liquidationTrigger
        ? []
        : strategyWakeEvidenceFacts({
            wakeId: trace.traceId,
            triggerKind,
            symbol: trace.symbol,
            direction: brainDirection,
            referencePrice: triggerReferencePrice,
            eventAt: trace.eventTime.getTime(),
            receivedAt: trace.receivedAt.getTime(),
            expiresAt: triggerFactExpiry,
            evidence: existingEvidence.strategyTriggerEvidence,
          });
      const frozenTriggerFacts = storedTriggerFacts.length
        ? mergeFrozenNexusMarketFacts(
            storedTriggerFacts,
            rebuiltStructureTriggerFacts,
            8,
          )
        : liquidationTrigger
        ? [
            liquidationMarketFact({
              id: trace.traceId,
              sequence: trace.id,
              symbol: trace.symbol,
              side: trace.liquidationSide as "BUY" | "SELL",
              averagePrice: trace.liquidationPrice,
              filledQuantity:
                trace.liquidationPrice > 0
                  ? trace.liquidationNotional / trace.liquidationPrice
                  : 1,
              notional: trace.liquidationNotional,
              eventCount: Math.max(
                1,
                finiteNumber(existingEvidence.symbolEventCount, 1),
              ),
              firstTradeTime: trace.eventTime.getTime(),
              lastTradeTime: trace.eventTime.getTime(),
              lastReceivedAt: trace.receivedAt.getTime(),
              expiresAt: triggerFactExpiry,
            }),
          ]
        : rebuiltStructureTriggerFacts;
      nexusMarketFactBuffer.addMany(
        frozenTriggerFacts,
        brainEvaluatedAt,
      );
      nexusMarketFactBuffer.addMany(closedMarketFacts, brainEvaluatedAt);
      const rollingMarketFacts = nexusMarketFactBuffer.query({
        symbol: trace.symbol,
        freshOnly: true,
        now: brainEvaluatedAt,
        // One slot is reserved for the frozen liquidation trigger below.
        // Keeping the rolling window at 63 prevents the merge from dropping
        // the oldest (usually 1h/4h) reserved timeframe fact.
        limit: 63,
        preserveLatestByKindInterval: true,
      });
      const nexusMarketFactsShadow = mergeFrozenNexusMarketFacts(
        frozenTriggerFacts,
        // The just-fetched closed candles are the authoritative recovery
        // snapshot after a restart. Put them ahead of the process-local
        // rolling buffer so faster 1m facts cannot evict 3m/5m/15m/30m/1h.
        [...closedMarketFacts, ...rollingMarketFacts],
        64,
      );
      const ticker24h = activeSymbolByName.get(trace.symbol);
      const ticker24hEventAt = ticker24h?.marketSyncedAt?.getTime();
      const nexusMarketContextSnapshot = buildNexusMarketContextSnapshot({
        symbol: trace.symbol,
        capturedAt: brainEvaluatedAt,
        ticker24h: ticker24h && ticker24hEventAt
          ? {
              lastPrice: Number(ticker24h.lastPrice),
              highPrice: Number(ticker24h.highPrice),
              lowPrice: Number(ticker24h.lowPrice),
              quoteVolume: Number(ticker24h.quoteVolume24h),
              priceChangePercent: Number(ticker24h.priceChangePercent),
              eventAt: ticker24hEventAt,
              receivedAt: ticker24hEventAt,
            }
          : null,
        candles1h: trade1h,
      });
      const nexusDecisionSnapshot = assessNexusDecisionSnapshot({
        facts: nexusMarketFactsShadow,
        evaluatedAt: brainEvaluatedAt,
        symbol: trace.symbol,
        marketContext: nexusMarketContextSnapshot,
        btcMacro: {
          regime: nexusBtcMacroRegime6h.regime,
          observations: nexusBtcMacroRegime6h.observations,
          eventAt: btcMacroRegimeEventAt,
        },
      });
      const previousDirectionBranches = asRecord(
        existingEvidence.nexusDirectionBranches,
      );
      const directionStructuralRiskRoePercent =
        directionalEntryStructuralRiskRoePercent({
          approvedMarkPrice: markPrice,
          atr5m: Number(nexusOwnEntryRegime5m.atr),
          atrStopBuffer: config.risk.atrStopBuffer,
          leverage: config.execution.leverage,
        });
      const directionTriggerFactId = (direction: "LONG" | "SHORT") => {
        const side = direction === "LONG" ? "SELL" : "BUY";
        return nexusMarketFactsShadow.find((fact) =>
          fact.kind === "MARKET_STRUCTURE_WAKE" &&
          fact.payload.side === side
        )?.id ?? frozenTriggerFacts[0]?.id ?? null;
      };
      const analyzeDirection = (direction: "LONG" | "SHORT") => {
        const previous = asRecord(previousDirectionBranches[direction]);
        const previousBrainShadow = Object.keys(previous).length
          ? previous.nexusBrainShadow
          : existingEvidence.nexusBrainShadow;
        const previousPureStateMachine = Object.keys(previous).length
          ? previous.nexusPureStateMachine
          : existingEvidence.nexusPureStateMachine;
        const previousBreakoutStateMachine = Object.keys(previous).length
          ? previous.nexusTrendBreakoutStateMachine
          : existingEvidence.nexusTrendBreakoutStateMachine;
        const triggerFactId = directionTriggerFactId(direction);
        const directionBrainShadow = deriveNexusBrainShadowState({
          direction,
          triggerLiquidationSide:
            trace.liquidationSide as "BUY" | "SELL",
          triggerFactId,
          facts: nexusMarketFactsShadow,
          now: brainEvaluatedAt,
          previous: previousBrainShadow,
        });
        const directionOpportunity = liquidationTrigger
          ? nexusLiquidationOpportunity({
              liquidationSide: trace.liquidationSide as "BUY" | "SELL",
              direction: "LONG",
            })
          : {
              version: "nexus-structure-wake-opportunity-v1",
              triggerKind,
              direction,
              primaryMachine: direction === "SHORT"
                ? "DOWNTREND_CONTINUATION" as const
                : "SUPPORT_REVERSAL" as const,
              secondaryMachine: "TREND_BREAKOUT" as const,
              orderAffecting: false as const,
            };
        const directionPureStateMachine = replayNexusPureStateMachine({
          machine: directionOpportunity.primaryMachine,
          direction,
          symbol: trace.symbol,
          triggerLiquidationSide:
            liquidationTrigger
              ? trace.liquidationSide as "BUY" | "SELL"
              : direction === "LONG" ? "SELL" : "BUY",
          triggerFactId: directionBrainShadow.triggerFactId,
          facts: nexusMarketFactsShadow,
          now: brainEvaluatedAt,
          previous: asRecord(previousPureStateMachine),
        });
        const directionTrendBreakoutStateMachine =
          replayNexusPureStateMachine({
            machine: directionOpportunity.secondaryMachine,
            direction,
            symbol: trace.symbol,
            triggerLiquidationSide:
              liquidationTrigger
                ? trace.liquidationSide as "BUY" | "SELL"
                : direction === "LONG" ? "SELL" : "BUY",
            triggerFactId: directionBrainShadow.triggerFactId,
            facts: nexusMarketFactsShadow,
            now: brainEvaluatedAt,
            previous: asRecord(previousBreakoutStateMachine),
          });
        const rawMarketEyeDecision = decideNexusMarketEye({
          direction,
          ownMacroRegime: nexusOwnMultiHourContext.decisionRegime,
          ownEntryRegime: nexusOwnEntryRegime5m.regime,
          btcMacroRegime: nexusBtcMacroRegime6h.regime,
          btcRelationship: nexusBtcRelationship.state,
          relativeVolume: entryRelativeVolume1m,
          contextRelativeVolume:
            nexusOwnMultiHourContext.volume.relativeRatio,
          volumeTiming: nexusVolumeTiming,
          liquidationFactorDecision:
            liquidationTrigger ? liquidationFactorDecision : null,
          minimumIndependentRelativeVolume: config.trend.volumeRatio3m,
          paths: [directionPureStateMachine, directionTrendBreakoutStateMachine]
            .map((machine) => ({
              machine: machine.machine,
              direction: machine.direction,
              state: machine.state,
              changedAt: machine.changedAt,
              evidenceFactIds: machine.evidenceFactIds,
              missing: machine.missing,
            })),
        });
        const marketEyeDecision = triggerKind === "THREE_MINUTE_PROBABILITY"
          ? decideThreeMinuteProbabilityEye({
              probabilityEvidence: asRecord(
                existingEvidence.threeMinuteProbability,
              ),
              direction,
              minimumProbabilityPercent:
                config.trigger.threeMinuteProbability
                  ?.minimumProbabilityPercent ??
                DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.minimumProbabilityPercent,
              minimumNetEdgeBps:
                config.trigger.threeMinuteProbability?.minimumNetEdgeBps ??
                DEFAULT_THREE_MINUTE_PROBABILITY_TRIGGER_CONFIG.minimumNetEdgeBps,
            })
          : nexusDecisionSnapshot.complete
            ? {
                ...rawMarketEyeDecision,
                dataIntegrity: nexusDecisionSnapshot.integrity,
                dataIntegritySummary: nexusDecisionSnapshot.integritySummary,
              }
            : {
                ...rawMarketEyeDecision,
                verdict: "WAIT" as const,
                code: "EYE_DECISION_SNAPSHOT_INCOMPLETE" as const,
                summary:
                  `决策快照不完整：${nexusDecisionSnapshot.missing.join("、")}`,
                missing: nexusDecisionSnapshot.missing,
                dataIntegrity: nexusDecisionSnapshot.integrity,
                dataIntegritySummary: nexusDecisionSnapshot.integritySummary,
              };
        return {
          direction,
          nexusBrainShadow: directionBrainShadow,
          nexusOpportunity: directionOpportunity,
          nexusPureStateMachine: directionPureStateMachine,
          nexusTrendBreakoutStateMachine:
            directionTrendBreakoutStateMachine,
          nexusFundingContext: fundingContextForDirection(direction),
          rawNexusMarketEyeDecision: rawMarketEyeDecision,
          nexusMarketEyeDecision: marketEyeDecision,
        };
      };
      const competingDirectionMode =
        triggerKind === "SCHEDULED_SCAN" &&
        config.direction === "BOTH" &&
        config.directionDecision?.mode === "COMPETING_DIRECTIONS";
      const directionAnalyses = competingDirectionMode
        ? {
            LONG: analyzeDirection("LONG"),
            SHORT: analyzeDirection("SHORT"),
          }
        : { [brainDirection]: analyzeDirection(brainDirection) };
      let directionDecisionEvidence: Record<string, unknown> = {};
      if (competingDirectionMode) {
        const analysisDecisionWindow = resolveNexusAnalysisDecisionWindow({
          analysisExpiresAtMs: trace.expiresAt.getTime(),
          evaluatedAtMs: brainEvaluatedAt,
        });
        // The trigger snapshot identifies what woke the strategy, while the
        // direction decision must identify the current complete market-fact
        // snapshot that both branches actually compared. They are different
        // identities and must never be compared as if they were the same one.
        const triggerFactSnapshotId = String(
          trace.triggerFactSnapshotId ??
            asRecord(existingEvidence.triggerIdentity).factSnapshotId ??
            "",
        );
        const factSnapshotId = String(
          nexusDecisionSnapshot.factSnapshotId ?? triggerFactSnapshotId,
        );
        const horizons = [
          nexusOwnMultiHourContext.horizon1h.direction,
          nexusOwnMultiHourContext.horizon2h.direction,
          nexusOwnMultiHourContext.horizon3h.direction,
          nexusOwnMultiHourContext.horizon4h.direction,
        ];
        const expectedProfitRoePercent =
          configuredExpectedProfitRoePercent(config.risk.takeProfitSteps);
        const estimatedCostRoePercent =
          (config.probabilityPolicy?.estimatedRoundTripFeePercent ?? 0.08) *
          config.execution.leverage;
        const directionDecision = evaluateNexusStrategyDirections({
          adapter: nexusMarketEyeDirectionPathAdapter,
          facts: Object.freeze({
            factSnapshotId,
            decisions: Object.freeze({
              LONG: directionAnalyses.LONG.nexusMarketEyeDecision,
              SHORT: directionAnalyses.SHORT.nexusMarketEyeDecision,
            }),
            structuralRiskRoePercent: Object.freeze({
              LONG: directionStructuralRiskRoePercent,
              SHORT: directionStructuralRiskRoePercent,
            }),
            uncertaintyRoePercent: Object.freeze({
              LONG: directionalStructureUncertaintyRoePercent({
                direction: "LONG",
                structuralRiskRoePercent:
                  directionStructuralRiskRoePercent ?? 0,
                horizons,
              }),
              SHORT: directionalStructureUncertaintyRoePercent({
                direction: "SHORT",
                structuralRiskRoePercent:
                  directionStructuralRiskRoePercent ?? 0,
                horizons,
              }),
            }),
          }),
          config: Object.freeze({
            expectedProfitRoePercent,
            estimatedCostRoePercent,
          }),
          context: Object.freeze({
            factSnapshotId,
            evaluatedAt: brainEvaluatedAt,
            expiresAt: analysisDecisionWindow.decisionExpiresAtMs,
          }),
          identity: {
            strategyId: trace.strategyId,
            brainKey: String(existingEvidence.brainKey ?? ""),
            configVersion: trace.configVersion,
            ownerEmail: trace.ownerEmail,
            accountId: trace.accountId,
            symbol: trace.symbol,
            triggerKind,
            triggerSourceId: trace.triggerSourceId ?? triggerFactSnapshotId,
            factSnapshotId,
          },
          configuredDirection: "BOTH",
          executionDirectionMode: config.execution.directionMode,
          policy: {
            minimumNetExpectancyRoePercent:
              config.probabilityPolicy?.minimumNetExpectancyRoePercent ?? 0,
            minimumRewardRiskRatio:
              config.directionDecision?.minimumRewardRiskRatio ?? 1.2,
            minimumDirectionAdvantageRoePercent:
              config.directionDecision
                ?.minimumDirectionAdvantageRoePercent ?? 0.15,
            maximumUncertaintyRoePercent:
              config.directionDecision?.maximumUncertaintyRoePercent ?? 1.5,
          },
          decisionAt: brainEvaluatedAt,
        });
        const directionHandoff = handoffNexusDirectionDecision({
          decision: directionDecision,
          candidates: (["LONG", "SHORT"] as const).map((direction) => ({
            direction,
            factSnapshotId,
            evidence: { directionAnalysis: directionAnalyses[direction] },
          })),
        });
        directionDecisionEvidence = {
          nexusDirectionDecision: directionDecision,
          nexusDirectionHandoff: directionHandoff,
          nexusDirectionBranches: directionAnalyses,
          nexusDirectionStructuralRiskRoePercent:
            directionStructuralRiskRoePercent,
          nexusAnalysisDecisionWindow: analysisDecisionWindow,
        };
        if (
          directionHandoff.outcome === "READY_FOR_ENTRY_AUTHORIZATION" &&
          directionHandoff.selectedCandidate
        ) brainDirection = directionHandoff.selectedCandidate.direction;
      }
      const selectedDirectionAnalysis = directionAnalyses[brainDirection] ??
        directionAnalyses.LONG ?? directionAnalyses.SHORT;
      const nexusBrainShadow = selectedDirectionAnalysis.nexusBrainShadow;
      const nexusOpportunity = selectedDirectionAnalysis.nexusOpportunity;
      const nexusPureStateMachine =
        selectedDirectionAnalysis.nexusPureStateMachine;
      const nexusTrendBreakoutStateMachine =
        selectedDirectionAnalysis.nexusTrendBreakoutStateMachine;
      const nexusFundingContext =
        selectedDirectionAnalysis.nexusFundingContext;
      const rawNexusMarketEyeDecision =
        selectedDirectionAnalysis.rawNexusMarketEyeDecision;
      const selectedMarketEyeDecision =
        selectedDirectionAnalysis.nexusMarketEyeDecision;
      const directionHandoff = asRecord(
        directionDecisionEvidence.nexusDirectionHandoff,
      );
      const nexusMarketEyeDecision =
        competingDirectionMode &&
          directionHandoff.outcome !== "READY_FOR_ENTRY_AUTHORIZATION"
          ? {
              ...selectedMarketEyeDecision,
              verdict: "WAIT" as const,
              code: "EYE_PATH_PENDING" as const,
              summary: String(
                directionHandoff.reason ?? "多空方向尚未形成唯一优势",
              ),
              selectedPath: null,
              missing: ["同快照多空方向形成唯一净期望优势"],
            }
          : selectedMarketEyeDecision;
      const evidence: Record<string, unknown> = {
        ...existingEvidence,
        ...directionDecisionEvidence,
        brainDecisionDirection: brainDirection,
        tradeDirection: brainDirection,
        directionDecisionPending:
          competingDirectionMode &&
          asRecord(directionDecisionEvidence.nexusDirectionHandoff).outcome !==
            "READY_FOR_ENTRY_AUTHORIZATION",
        nexusAnalysisDataAvailability: analysisSeries.availability,
        nexusTriggerFact: frozenTriggerFacts[0],
        nexusOpportunity,
        nexusMarketFactsShadow,
        nexusBrainShadow,
        nexusPureStateMachine,
        nexusTrendBreakoutStateMachine,
        nexusOwnMultiHourContext,
        nexusDailyMarketActivity,
        nexusOwnEntryRegime5m,
        nexusBtcMacroRegime6h,
        nexusBtcRelationship,
        nexusPriceImpulse: liquidationTrigger ? nexusPriceImpulse : null,
        preTrigger3mReference,
        nexusVolumeTiming,
        nexusTemporalShadow,
        nexusFundingContext,
        liquidationFactorSnapshot:
          liquidationTrigger ? liquidationFactorSnapshot : null,
        liquidationFactorDecision:
          liquidationTrigger ? liquidationFactorDecision : null,
        nexusMarketEyeDecision,
        nexusDecisionSnapshot,
      };
      const previousAvailability = asRecord(
        existingEvidence.nexusAnalysisDataAvailability,
      );
      const previousMissingSeries = Array.isArray(
        previousAvailability.missingSeries,
      )
        ? previousAvailability.missingSeries
            .map((item) => asRecord(item).key)
            .filter((key): key is string => typeof key === "string")
            .sort()
            .join(",")
        : "";
      const currentMissingSeries =
        analysisSeries.availability.missingSeries
          .map((item) => item.key)
          .sort()
          .join(",");
      if (previousMissingSeries !== currentMissingSeries)
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: analysisSeries.availability.degraded
            ? "NEXUS_ANALYSIS_DATA_DEGRADED"
            : "NEXUS_ANALYSIS_DATA_RECOVERED",
          stage: "SIGNAL",
          outcome: analysisSeries.availability.degraded
            ? "PENDING"
            : "PASSED",
          message: analysisSeries.availability.degraded
            ? `非核心分析周期暂缺：${analysisSeries.availability.missingSeries
                .map((item) => item.key)
                .join("、")}；保留5分钟风险尺度，第二次爆仓学习探针可继续完成执行门禁`
            : "多周期分析数据已经恢复完整",
          detail: analysisSeries.availability,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousBrainState = asRecord(
        existingEvidence.nexusBrainShadow,
      ).state;
      if (previousBrainState !== nexusBrainShadow.state)
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: `NEXUS_BRAIN_SHADOW:${nexusBrainShadow.state}`,
          stage: "SIGNAL",
          outcome:
            nexusBrainShadow.state === "READY_SHADOW"
              ? "PASSED"
              : nexusBrainShadow.state === "INVALIDATED"
                ? "REJECTED"
                : "INFO",
          message:
            `NEXUS大脑影子：${nexusBrainShadow.reasons.map((item) => item.message).join("；")}`,
          detail: nexusBrainShadow,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousPureState = asRecord(
        existingEvidence.nexusPureStateMachine,
      ).state;
      if (previousPureState !== nexusPureStateMachine.state)
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_PURE_STATE:${nexusPureStateMachine.machine}:${nexusPureStateMachine.state}`,
          stage: "SIGNAL",
          outcome:
            nexusPureStateMachine.state === "READY_SHADOW"
              ? "PASSED"
              : nexusPureStateMachine.state === "INVALIDATED"
                ? "REJECTED"
                : "INFO",
          message: nexusPureStateMachineMessage(nexusPureStateMachine),
          detail: nexusPureStateMachine,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousTrendBreakoutState = asRecord(
        existingEvidence.nexusTrendBreakoutStateMachine,
      ).state;
      if (
        previousTrendBreakoutState !==
        nexusTrendBreakoutStateMachine.state
      )
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_PURE_STATE:${nexusTrendBreakoutStateMachine.machine}:${nexusTrendBreakoutStateMachine.state}`,
          stage: "SIGNAL",
          outcome:
            nexusTrendBreakoutStateMachine.state === "READY_SHADOW"
              ? "PASSED"
              : nexusTrendBreakoutStateMachine.state === "INVALIDATED"
                ? "REJECTED"
                : "INFO",
          message: nexusPureStateMachineMessage(
            nexusTrendBreakoutStateMachine,
          ),
          detail: nexusTrendBreakoutStateMachine,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousBtcMacroRegime = asRecord(
        existingEvidence.nexusBtcMacroRegime6h,
      ).regime;
      const previousLiquidationContextVersion = asRecord(
        existingEvidence.nexusPriceImpulse,
      ).version;
      if (
        liquidationTrigger &&
        previousLiquidationContextVersion !==
        nexusPriceImpulse.version
      )
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: "NEXUS_LIQUIDATION_CONTEXT_30M",
          stage: "SIGNAL",
          outcome: nexusPriceImpulse.confirmed ? "PASSED" : "INFO",
          message: nexusLiquidationContextSummary(nexusPriceImpulse),
          detail: nexusPriceImpulse,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousVolumeTimingState = asRecord(
        existingEvidence.nexusVolumeTiming,
      ).state;
      if (previousVolumeTimingState !== nexusVolumeTiming.state)
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: `NEXUS_VOLUME_TIMING:${nexusVolumeTiming.state}`,
          stage: "SIGNAL",
          outcome:
            nexusVolumeTiming.state === "CURRENT_EXECUTION_CONFIRMED"
              ? "PASSED"
              : "INFO",
          message: `量价时序：${nexusVolumeTiming.summary}`,
          detail: nexusVolumeTiming,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousTemporalPhase = asRecord(
        existingEvidence.nexusTemporalShadow,
      ).phase;
      if (previousTemporalPhase !== nexusTemporalShadow.phase)
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: `NEXUS_TEMPORAL_SHADOW:${nexusTemporalShadow.phase}`,
          stage: "SIGNAL",
          outcome: "INFO",
          message: nexusTemporalShadow.summary,
          detail: nexusTemporalShadow,
          eventAt: new Date(brainEvaluatedAt),
        });
      if (previousBtcMacroRegime !== nexusBtcMacroRegime6h.regime)
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_BTC_MACRO_6H:${nexusBtcMacroRegime6h.regime}`,
          stage: "SIGNAL",
          outcome: "INFO",
          message:
            `BTC大盘背景：最近6根已收盘1小时K线为` +
            `${nexusMarketRegimeLabel(nexusBtcMacroRegime6h.regime)}；` +
            nexusBtcMacroRegime6h.reason,
          detail: nexusBtcMacroRegime6h,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousBtcRelationship = asRecord(
        existingEvidence.nexusBtcRelationship,
      ).state;
      if (previousBtcRelationship !== nexusBtcRelationship.state)
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_BTC_RELATIONSHIP:${nexusBtcRelationship.state}`,
          stage: "SIGNAL",
          outcome: "INFO",
          message:
            `目标币与BTC关系：${nexusBtcRelationship.reason}；` +
            "该关系仅作为成交后的大盘归因与仓位管理证据，不参与首次下单放行或否决",
          detail: nexusBtcRelationship,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousOwnMacroRegime = asRecord(
        existingEvidence.nexusOwnMultiHourContext,
      ).decisionRegime;
      if (
        previousOwnMacroRegime !==
        nexusOwnMultiHourContext.decisionRegime
      )
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_OWN_MULTI_HOUR:${nexusOwnMultiHourContext.decisionRegime}`,
          stage: "SIGNAL",
          outcome: "INFO",
          message: nexusMultiHourContextSummary(
            nexusOwnMultiHourContext,
          ),
          detail: nexusOwnMultiHourContext,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousDailyActivity = asRecord(
        existingEvidence.nexusDailyMarketActivity,
      );
      if (
        previousDailyActivity.opportunityContext !==
          nexusDailyMarketActivity.opportunityContext ||
        previousDailyActivity.rank !== nexusDailyMarketActivity.rank
      )
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_DAILY_ACTIVITY:${nexusDailyMarketActivity.opportunityContext}`,
          stage: "SIGNAL",
          outcome: "INFO",
          message: nexusDailyMarketActivitySummary(
            nexusDailyMarketActivity,
          ),
          detail: nexusDailyMarketActivity,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousOwnEntryRegime = asRecord(
        existingEvidence.nexusOwnEntryRegime5m,
      ).regime;
      if (previousOwnEntryRegime !== nexusOwnEntryRegime5m.regime)
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_OWN_ENTRY_5M:${nexusOwnEntryRegime5m.regime}`,
          stage: "SIGNAL",
          outcome: "INFO",
          message:
            `目标币入场节奏：${nexusMarketRegimeLabel(nexusOwnEntryRegime5m.regime)}；` +
            nexusOwnEntryRegime5m.reason,
          detail: nexusOwnEntryRegime5m,
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousFundingRegime = asRecord(
        existingEvidence.nexusFundingContext,
      ).regime;
      if (previousFundingRegime !== nexusFundingContext.regime)
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: `NEXUS_FUNDING_CONTEXT:${nexusFundingContext.regime}`,
          stage: "SIGNAL",
          outcome: "INFO",
          message: `资金费率证据：${nexusFundingContext.summary}`,
          detail: { ...nexusFundingContext },
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousFactorDecision = asRecord(
        existingEvidence.liquidationFactorDecision,
      );
      if (
        liquidationTrigger &&
        liquidationFactorDecision &&
        liquidationFactorFact &&
        (
          previousFactorDecision.verdict !==
            liquidationFactorDecision.verdict ||
          previousFactorDecision.regime !==
            liquidationFactorDecision.regime ||
          previousFactorDecision.continuationScore !==
            liquidationFactorDecision.continuationScore ||
          previousFactorDecision.exhaustionScore !==
            liquidationFactorDecision.exhaustionScore
        )
      )
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_LIQUIDATION_FACTORS:${liquidationFactorDecision.verdict}`,
          stage: "SIGNAL",
          outcome: liquidationFactorDecision.supportsDirection
            ? "PASSED"
            : "INFO",
          message:
            `爆仓衍生因子：延续 ${liquidationFactorDecision.continuationScore.toFixed(0)} 分，` +
            `衰竭 ${liquidationFactorDecision.exhaustionScore.toFixed(0)} 分，` +
            `本策略结论 ${liquidationFactorDecision.verdict}`,
          detail: {
            factorFactId: liquidationFactorFact.id,
            factors: liquidationFactorSnapshot.factors,
            confirmations: liquidationFactorSnapshot.confirmations,
            decision: liquidationFactorDecision,
          },
          eventAt: new Date(brainEvaluatedAt),
        });
      const previousMarketEyeVerdict = asRecord(
        existingEvidence.nexusMarketEyeDecision,
      ).verdict;
      const previousMarketEyeCode = asRecord(
        existingEvidence.nexusMarketEyeDecision,
      ).code;
      const previousMarketEyeSummary = asRecord(
        existingEvidence.nexusMarketEyeDecision,
      ).summary;
      const currentDirectionDecision = asRecord(
        directionDecisionEvidence.nexusDirectionDecision,
      );
      const previousDirectionDecision = asRecord(
        existingEvidence.nexusDirectionDecision,
      );
      if (
        competingDirectionMode &&
        (
          previousDirectionDecision.outcome !==
            currentDirectionDecision.outcome ||
          previousDirectionDecision.selectedDirection !==
            currentDirectionDecision.selectedDirection ||
          previousDirectionDecision.reasonCode !==
            currentDirectionDecision.reasonCode
        )
      )
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_DIRECTION_DECISION:${currentDirectionDecision.outcome}`,
          stage: "SIGNAL",
          outcome: currentDirectionDecision.outcome === "SELECTED"
            ? "PASSED"
            : "INFO",
          message: String(
            currentDirectionDecision.reason ?? "同快照多空方向仍在比较",
          ),
          detail: {
            decision: currentDirectionDecision,
            handoff: asRecord(
              directionDecisionEvidence.nexusDirectionHandoff,
            ),
            orderSubmissionAllowed: false,
          },
          eventAt: new Date(brainEvaluatedAt),
        });
      if (
        previousMarketEyeVerdict !== nexusMarketEyeDecision.verdict ||
        previousMarketEyeCode !== nexusMarketEyeDecision.code ||
        previousMarketEyeSummary !== nexusMarketEyeDecision.summary
      )
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType:
            `NEXUS_MARKET_EYE:${nexusMarketEyeDecision.verdict}`,
          stage: "SIGNAL",
          outcome:
            nexusMarketEyeDecision.verdict === "CONFIRMED"
              ? "PASSED"
              : nexusMarketEyeDecision.verdict === "BLOCKED"
                ? "REJECTED"
                : "INFO",
          message:
            `NEXUS眼睛（${nexusDecisionSnapshot.integritySummary}）：` +
            nexusMarketEyeDecision.summary,
          detail: nexusMarketEyeDecision,
          eventAt: new Date(brainEvaluatedAt),
        });
      const currentLifecycleLiquidationEventCount =
        effectiveExplorationLiquidationEventCount({
          traceEventCount: signalCluster.eventCount,
          // The three-hour cascade remains useful context for the brain, but
          // cannot qualify as the second executable liquidation. Only events
          // inside the configured rolling window and continuity gap may arm
          // a learning probe.
          lifecycleEventCount: freshTriggerLiquidationEventCount,
        });
      const priorAwareLiquidationCount =
        effectiveNexusPriorAwareLiquidationCount({
          memory: existingEvidence.priorLifecycleMemory,
          currentLifecycleEventCount: currentLifecycleLiquidationEventCount,
        });
      const explorationLiquidationEventCount =
        currentLifecycleLiquidationEventCount;
      const explorationSingleLiquidationNotional = Math.max(
        0,
        finiteNumber(trace.liquidationNotional, 0),
      );
      const explorationAggregateLiquidationNotional = Math.max(
        explorationSingleLiquidationNotional,
        finiteNumber(signalCluster.totalNotional, 0),
        finiteNumber(existingEvidence.symbolLiquidationNotional, 0),
      );
      evidence.explorationLiquidationEventCount =
        explorationLiquidationEventCount;
      evidence.explorationLiquidationTrigger = {
        singleNotionalUsdt: explorationSingleLiquidationNotional,
        aggregateNotionalUsdt: explorationAggregateLiquidationNotional,
        minSingleNotionalUsdt:
          config.trigger.minSingleLiquidationNotionalUsdt ??
          config.trigger.minLiquidationNotionalUsdt,
        minAggregateNotionalUsdt:
          config.trigger.minLiquidationNotionalUsdt,
      };
      evidence.currentLifecycleLiquidationEventCount =
        currentLifecycleLiquidationEventCount;
      evidence.priorAwareLiquidationCount =
        priorAwareLiquidationCount;
      evidence.freshTriggerLiquidationEventCount =
        freshTriggerLiquidationEventCount;
      const priorLifecycleProgress = advanceNexusPriorLifecycleMemory({
        memory: existingEvidence.priorLifecycleMemory,
        liquidationEventCount: explorationLiquidationEventCount,
        eyeVerdict: nexusMarketEyeDecision.verdict,
      });
      if (priorLifecycleProgress) {
        evidence.priorLifecycleProgress = priorLifecycleProgress;
        const previousPriorLifecycleStatus = asRecord(
          existingEvidence.priorLifecycleProgress,
        ).status;
        if (previousPriorLifecycleStatus !== priorLifecycleProgress.status)
          await appendEvent(trace.traceId, trace.strategyId, {
            eventType:
              `PRIOR_LIFECYCLE_PROGRESS:${priorLifecycleProgress.status}`,
            stage: "SIGNAL",
            outcome:
              priorLifecycleProgress.status ===
                "SECOND_LIQUIDATION_REACHED" ||
              priorLifecycleProgress.status === "FRESH_LIFECYCLE_REARMED"
                ? "PASSED"
                : "INFO",
            message: priorLifecycleProgress.summary,
            detail: priorLifecycleProgress,
            eventAt: new Date(brainEvaluatedAt),
          });
      }
      const explorationEntryPolicyBase = evaluateNexusExplorationEntry({
        modelProgress,
        eyeDecision: rawNexusMarketEyeDecision,
        decisionSnapshotComplete: nexusDecisionSnapshot.complete,
        liquidationEventCount: currentLifecycleLiquidationEventCount,
        singleLiquidationNotional:
          explorationSingleLiquidationNotional,
        minSingleLiquidationNotionalUsdt:
          config.trigger.minSingleLiquidationNotionalUsdt ??
          config.trigger.minLiquidationNotionalUsdt,
        aggregateLiquidationNotional:
          explorationAggregateLiquidationNotional,
        minAggregateLiquidationNotionalUsdt:
          config.trigger.minLiquidationNotionalUsdt,
        executionOrderType: config.execution.orderType,
        executionLimitOffsetPercent:
          config.execution.limitOffsetPercent,
        executionOrderTtlSeconds: config.execution.orderTtlSeconds,
        executionAllowSecondOrder:
          config.execution.allowSecondOrder,
        requiredLiquidationEventCount:
          config.trigger.minClusterEvents ?? 1,
      });
      const explorationEntryPolicy = explorationEntryPolicyBase;
      const probabilityExplorationAllowed =
        liquidationTrigger && nexusProbabilityExplorationAllowed({
          policy: config.probabilityPolicy,
          explorationAllowed: explorationEntryPolicy.allowed,
        });
      if (liquidationTrigger)
        evidence.explorationEntryPolicy = explorationEntryPolicy;
      if (
        liquidationTrigger &&
        config.probabilityPolicy?.mode === "NET_EXPECTANCY" &&
        explorationEntryPolicy.allowed
      )
        evidence.probabilityExplorationSuppressed = {
          reasonCode: "NET_EXPECTANCY_REQUIRES_CONFIRMED_EYE",
          reason:
            "概率策略的冷启动最小量只能在眼睛完整确认后由净期望门禁签发，禁止复用通用探索探针。",
        };
      if (
        liquidationTrigger &&
        explorationEntryPolicy.reasonCode ===
          "STRONG_DIRECTION_CONFLICT" &&
        asRecord(existingEvidence.explorationEntryPolicy).reasonCode !==
          "STRONG_DIRECTION_CONFLICT"
      )
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: "NEXUS_EXPLORATION_DIRECTION_CONFLICT",
          stage: "ORDER",
          outcome: "PENDING",
          message:
            "探索单暂缓：目标币多小时方向与5分钟入场节奏同时反向；等待至少一个层级脱离反向趋势后再用最小量验证",
          detail: explorationEntryPolicy,
          eventAt: new Date(brainEvaluatedAt),
        });
      if (probabilityExplorationAllowed)
        evidence.explorationOrderFirst = explorationEntryPolicy;
      // NEXUS眼睛是唯一的入场判断。旧四周期分析、72小时位置和
      // 大户聚合只保留为证据，不再形成第二套相互矛盾的放行链。
      if (nexusMarketEyeDecision.verdict === "CONFIRMED") {
        ready += 1;
        const pilot = pilotRuntime();
        if (pilot.enabled && existingEvidence.sentinelAdvisoryOnly !== true) {
          evidence.executionApprovedMarkPrice = markPrice;
          evidence.executionAuthorization = entryAuthorizationEvidence(
            "CONFIRMED_EYE",
            {
              reasonCode: nexusMarketEyeDecision.code,
              retainedExplorationCandidateForLearning:
                probabilityExplorationAllowed,
            },
          );
          evidence.frozenExecutionDecision = {
            version: 1,
            approved: true,
            decisionFrozen: true,
            retryWithoutReanalysis: true,
            explorationProbe: false,
            approvedAt: new Date().toISOString(),
            approvalCode: nexusMarketEyeDecision.code,
            approvalSummary: nexusMarketEyeDecision.summary,
          };
          await persistFrozenLongExecutionDecision(
            trace,
            evidence,
            config.trigger.analysisValiditySeconds,
          );
          await appendEvent(trace.traceId, trace.strategyId, {
            eventType: "NEXUS_BRAIN_CANDIDATE_APPROVED:CONFIRMED_EYE",
            stage: "ORDER",
            outcome: "PASSED",
            message: "NEXUS眼睛已完整确认，大脑最终批准正常策略订单进入执行安全复核。",
            detail: {
              authorizationMode: "CONFIRMED_EYE",
              explorationProbe: false,
              orderSubmissionAllowed: true,
              reasonCode: nexusMarketEyeDecision.code,
            },
            eventAt: new Date(),
          });
          await executeConfiguredEntrySafely(
            trace,
            config,
            markPrice,
            evidence,
          );
        } else {
          await db
            .update(strategyExecutionTraces)
            .set({
              state: "MONITOR_READY",
              resultCode: nexusMarketEyeDecision.code,
              resultMessage:
                `NEXUS眼睛已确认：${nexusMarketEyeDecision.summary}；只监控模式未提交订单`,
              entryEvidenceJson: JSON.stringify(evidence),
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(strategyExecutionTraces.id, trace.id),
                inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
              ),
            );
          await appendEvent(trace.traceId, trace.strategyId, {
            eventType: "NEXUS_EYE_MONITOR_ONLY_READY",
            stage: "ORDER",
            outcome: "INFO",
            message:
              `NEXUS眼睛已找到下单时机：${nexusMarketEyeDecision.summary}；当前只记录证据`,
            detail: {
              ...evidence,
              monitorOnly: true,
              orderSubmissionAllowed: false,
            },
            eventAt: new Date(),
          });
        }
      } else if (probabilityExplorationAllowed) {
        ready += 1;
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: "NEXUS_EXPLORATION_PROBE_CANDIDATE",
          stage: "ORDER",
          outcome: "INFO",
          message:
            `证据尚未完全闭合，独立探针资格已形成；这不是大脑正常批准，` +
            `也尚未代表本订单已经提交。当前账户已提交或持有 ${modelProgress.committedEntryOrders}/` +
            `${modelProgress.targetOrders} 个学习探针；最终授权后才进入中央执行预留，` +
            (explorationEntryPolicy.orderType === "MARKET"
              ? "按策略配置立即市价成交"
              : `${explorationEntryPolicy.orderType === "ADAPTIVE" ? "按自适应模式择价" : `限价偏移 ${explorationEntryPolicy.limitOffsetPercent}%`}，` +
                `${explorationEntryPolicy.orderTtlSeconds} 秒未成交自动撤单`),
          detail: explorationEntryPolicy,
          eventAt: new Date(),
        });
        const pilot = pilotRuntime();
        if (pilot.enabled && existingEvidence.sentinelAdvisoryOnly !== true) {
          evidence.executionApprovedMarkPrice = markPrice;
          evidence.executionAuthorization = entryAuthorizationEvidence(
            "EXPLORATION_PROBE",
            { reasonCode: explorationEntryPolicy.reasonCode },
          );
          evidence.frozenExecutionDecision = {
            version: 1,
            approved: true,
            decisionFrozen: true,
            retryWithoutReanalysis: true,
            explorationProbe: true,
            approvedAt: new Date().toISOString(),
            approvalCode: explorationEntryPolicy.reasonCode,
            approvalSummary:
              "学习探针已通过入场判断；环境恢复后直接进入执行安全复核",
          };
          await persistFrozenLongExecutionDecision(
            trace,
            evidence,
            config.trigger.analysisValiditySeconds,
          );
          await appendEvent(trace.traceId, trace.strategyId, {
            eventType: "NEXUS_BRAIN_CANDIDATE_APPROVED:EXPLORATION_PROBE",
            stage: "ORDER",
            outcome: "PASSED",
            message: "独立探针规则已批准最小量学习订单；该授权不等同于正常策略确认。",
            detail: {
              authorizationMode: "EXPLORATION_PROBE",
              explorationProbe: true,
              minimumQuantityOnly: true,
              orderSubmissionAllowed: true,
              reasonCode: explorationEntryPolicy.reasonCode,
            },
            eventAt: new Date(),
          });
          await executeConfiguredEntrySafely(
            trace,
            explorationExecutionConfig(config),
            markPrice,
            evidence,
          );
        } else {
          await db
            .update(strategyExecutionTraces)
            .set({
              state: "MONITOR_READY",
              resultCode: "NEXUS_EXPLORATION_PROBE_CANDIDATE",
              resultMessage: "学习探针资格已形成；当前账户未授权自动实盘，未提交订单",
              entryEvidenceJson: JSON.stringify(evidence),
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(strategyExecutionTraces.id, trace.id));
        }
      } else if (nexusMarketEyeDecision.verdict === "BLOCKED") {
        rejected += 1;
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: `NEXUS_EYE_FINAL_REJECTED:${nexusMarketEyeDecision.code}`,
          stage: "ORDER",
          outcome: "REJECTED",
          message:
            `NEXUS眼睛拒绝本次${brainDirection === "LONG" ? "做多" : "做空"}：${nexusMarketEyeDecision.summary}`,
          detail: {
            ...nexusMarketEyeDecision,
            orderSubmissionAllowed: false,
          },
          eventAt: new Date(),
        });
        await db
          .update(strategyExecutionTraces)
          .set({
            state: "REJECTED",
            resultCode: nexusMarketEyeDecision.code,
            resultMessage: nexusMarketEyeDecision.summary,
            entryEvidenceJson: JSON.stringify(evidence),
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(strategyExecutionTraces.id, trace.id));
      } else {
        pending += 1;
        await db
          .update(strategyExecutionTraces)
          .set({
            state:
              nexusMarketEyeDecision.verdict === "WAIT"
                ? "ARMED"
                : "ANALYZING",
            resultCode: nexusMarketEyeDecision.code,
            resultMessage: nexusMarketEyeDecision.summary,
            entryEvidenceJson: JSON.stringify(evidence),
            expiresAt: trace.expiresAt,
            completedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(strategyExecutionTraces.id, trace.id));
      }
    } catch (error) {
      if (isTransientMarketDataWait(error)) {
        pending += 1;
        marketDataWait = true;
        marketDataWaitReason = error.message;
        if (error.status === 429)
          analysisCapacityRetryAt =
            Date.now() + ANALYSIS_CAPACITY_RECHECK_MS;
        const clockPause = await pauseAnalysisClockForTransientWait(
          trace,
          config,
          {
            code:
              error.status === 429
                ? "REST_RATE_LIMIT_WAIT"
                : "ANALYSIS_MARKET_DATA_WAIT",
            message: error.message,
          },
        );
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: "ANALYSIS_MARKET_DATA_WAIT",
          stage: "POSITION",
          outcome: "PENDING",
          message: error.message,
          detail: {
            orderSubmissionAllowed: false,
            temporary: true,
            retryAfterSeconds: error.retryAfterSeconds ?? null,
            clockPause,
          },
          eventAt: new Date(),
        });
        if (error.status === 429) break;
        continue;
      }
      errors += 1;
      await db
        .update(strategyExecutionTraces)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(strategyExecutionTraces.id, trace.id),
            inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
          ),
        );
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "ANALYSIS_MARKET_DATA_ERROR",
        stage: "POSITION",
        outcome: "ERROR",
        message:
          error instanceof Error ? error.message : "四周期行情读取失败",
        detail: { monitorOnly: true },
        eventAt: new Date(),
      });
    }
    } catch (error) {
      errors += 1;
      const message = error instanceof Error
        ? error.message
        : "策略轨迹读取或评估失败";
      await db
        .update(strategyExecutionTraces)
        .set({
          resultCode: "TRACE_EVALUATION_ISOLATED",
          resultMessage: message,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(strategyExecutionTraces.id, trace.id),
            inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED"]),
          ),
        );
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "TRACE_EVALUATION_ISOLATED",
        stage: "SIGNAL",
        outcome: "ERROR",
        message:
          `本条策略轨迹读取或评估失败，已独立隔离；同批其他候选继续运行：${message}`,
        detail: {
          orderSubmissionAllowed: false,
          batchContinues: true,
        },
        eventAt: new Date(),
      });
      continue;
    }
  }
  return {
    checked: traces.length + frozenExecutionRetries,
    ready,
    pending,
    rejected,
    errors,
    marketDataWait,
    marketDataWaitReason,
  };
}

async function readSignalClusterSummary(
  trace: typeof strategyExecutionTraces.$inferSelect,
  maxClusterSpanMs: number,
  maxInterEventGapMs: number,
) {
  const rows = await getDb()
    .select({
      eventType: strategyExecutionEvents.eventType,
      detailJson: strategyExecutionEvents.detailJson,
      eventAt: strategyExecutionEvents.eventAt,
    })
    .from(strategyExecutionEvents)
    .where(eq(strategyExecutionEvents.traceId, trace.traceId));
  const allClusterRows = rows
    .filter((row) =>
      row.eventType === "SIGNAL_RECEIVED" ||
      row.eventType.startsWith("SIGNAL_CLUSTER_UPDATED:")
    )
    .map((row) => ({ ...row, detail: asRecord(safeParse(row.detailJson)) }));
  return summarizeLiquidationSignalCluster(
    allClusterRows.map((row) => ({
      eventAtMs: row.eventAt.getTime(),
      liquidationNotional: finiteNumber(row.detail.liquidationNotional, 0),
      liquidationPrice: finiteNumber(row.detail.liquidationPrice, Number.NaN),
      eventCount: finiteNumber(row.detail.eventCount, 1),
    })),
    {
      liquidationNotional: trace.liquidationNotional,
      liquidationPrice: trace.liquidationPrice,
      eventAtMs: trace.eventTime.getTime(),
    },
    maxClusterSpanMs,
    maxInterEventGapMs,
  );
}

async function readRollingLiquidationTriggerCount(
  trace: typeof strategyExecutionTraces.$inferSelect,
  config: LiquidationTrendConfig,
) {
  const db = getDb();
  const windowMs =
    (config.trigger.maxClusterSpanSeconds ?? 120) * 1_000;
  const maxInterEventGapMs =
    (config.trigger.maxClusterEventGapSeconds ??
      config.trigger.maxClusterSpanSeconds ??
      120) * 1_000;
  const referenceTimeMs = trace.eventTime.getTime();
  const windowStartedAt = new Date(referenceTimeMs - windowMs);
  const recentTraceIds = await db
    .select({ traceId: strategyExecutionTraces.traceId })
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.ownerEmail, trace.ownerEmail),
        eq(strategyExecutionTraces.accountId, trace.accountId),
        eq(strategyExecutionTraces.strategyId, trace.strategyId),
        eq(strategyExecutionTraces.symbol, trace.symbol),
        eq(strategyExecutionTraces.triggerKind, "LIQUIDATION_WINDOW"),
        eq(strategyExecutionTraces.liquidationSide, trace.liquidationSide),
        gte(strategyExecutionTraces.eventTime, windowStartedAt),
        lte(strategyExecutionTraces.eventTime, trace.eventTime),
      ),
    )
    .orderBy(asc(strategyExecutionTraces.eventTime))
    .limit(100);
  const traceIds = recentTraceIds.map((row) => row.traceId);
  const signalEvents = traceIds.length
    ? await db
        .select({
          eventType: strategyExecutionEvents.eventType,
          detailJson: strategyExecutionEvents.detailJson,
          eventAt: strategyExecutionEvents.eventAt,
        })
        .from(strategyExecutionEvents)
        .where(
          and(
            inArray(strategyExecutionEvents.traceId, traceIds),
            gte(strategyExecutionEvents.eventAt, windowStartedAt),
            lte(strategyExecutionEvents.eventAt, trace.eventTime),
          ),
        )
        .orderBy(asc(strategyExecutionEvents.eventAt))
    : [];
  const rows = signalEvents
    .filter(
      (row) =>
        row.eventType === "SIGNAL_RECEIVED" ||
        row.eventType.startsWith("SIGNAL_CLUSTER_UPDATED:"),
    )
    .map((row) => {
      const detail = asRecord(safeParse(row.detailJson));
      const eventAtMs = row.eventAt.getTime();
      return {
        symbol: trace.symbol,
        side: trace.liquidationSide as "BUY" | "SELL",
        eventCount: finiteNumber(detail.eventCount, 1),
        firstTradeTime: finiteNumber(detail.firstTradeTime, eventAtMs),
        lastTradeTime: finiteNumber(detail.lastTradeTime, eventAtMs),
      };
    });
  if (!rows.length)
    rows.push({
      symbol: trace.symbol,
      side: trace.liquidationSide as "BUY" | "SELL",
      eventCount: 1,
      firstTradeTime: referenceTimeMs,
      lastTradeTime: referenceTimeMs,
    });
  return rollingSameSymbolLiquidationEventCount({
    rows,
    symbol: trace.symbol,
    side: trace.liquidationSide as "BUY" | "SELL",
    referenceTimeMs,
    windowMs,
    maxInterEventGapMs,
  });
}

async function readLiquidationCascadeSeries(
  trace: typeof strategyExecutionTraces.$inferSelect,
) {
  const db = getDb();
  const windowStartedAt = new Date(
    trace.eventTime.getTime() - 3 * 60 * 60_000,
  );
  const recentTraces = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      liquidationPrice: strategyExecutionTraces.liquidationPrice,
      liquidationNotional: strategyExecutionTraces.liquidationNotional,
      eventTime: strategyExecutionTraces.eventTime,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.ownerEmail, trace.ownerEmail),
        eq(strategyExecutionTraces.accountId, trace.accountId),
        eq(strategyExecutionTraces.strategyId, trace.strategyId),
        eq(strategyExecutionTraces.symbol, trace.symbol),
        eq(strategyExecutionTraces.triggerKind, "LIQUIDATION_WINDOW"),
        eq(strategyExecutionTraces.liquidationSide, trace.liquidationSide),
        gte(strategyExecutionTraces.eventTime, windowStartedAt),
        lte(strategyExecutionTraces.eventTime, trace.eventTime),
      ),
    )
    .orderBy(asc(strategyExecutionTraces.eventTime))
    .limit(100);
  const traceIds = recentTraces.map((row) => row.traceId);
  const signalEvents = traceIds.length
    ? await db
        .select({
          eventType: strategyExecutionEvents.eventType,
          detailJson: strategyExecutionEvents.detailJson,
          eventAt: strategyExecutionEvents.eventAt,
        })
        .from(strategyExecutionEvents)
        .where(inArray(strategyExecutionEvents.traceId, traceIds))
        .orderBy(asc(strategyExecutionEvents.eventAt))
    : [];
  const candidates = [
    ...recentTraces.map((row) => ({
      eventAtMs: row.eventTime.getTime(),
      liquidationPrice: row.liquidationPrice,
      liquidationNotional: row.liquidationNotional,
    })),
    ...signalEvents
      .filter(
        (row) =>
          row.eventType === "SIGNAL_RECEIVED" ||
          row.eventType.startsWith("SIGNAL_CLUSTER_UPDATED:"),
      )
      .map((row) => {
        const detail = asRecord(safeParse(row.detailJson));
        return {
          eventAtMs: row.eventAt.getTime(),
          liquidationPrice: finiteNumber(
            detail.liquidationPrice,
            Number.NaN,
          ),
          liquidationNotional: finiteNumber(
            detail.liquidationNotional,
            0,
          ),
        };
      }),
  ];
  const unique = new Map<
    string,
    {
      eventAtMs: number;
      liquidationPrice: number;
      liquidationNotional: number;
    }
  >();
  for (const candidate of candidates) {
    if (
      !Number.isFinite(candidate.eventAtMs) ||
      !Number.isFinite(candidate.liquidationPrice) ||
      candidate.liquidationPrice <= 0 ||
      !Number.isFinite(candidate.liquidationNotional) ||
      candidate.liquidationNotional <= 0
    )
      continue;
    const key =
      `${candidate.eventAtMs}:` +
      `${candidate.liquidationPrice.toPrecision(12)}`;
    unique.set(key, candidate);
  }
  const events = [...unique.values()];
  return {
    events,
    context: analyzeLiquidationCascadeContext({
      events,
      liquidationSide: trace.liquidationSide,
    }),
  };
}

async function readLargeTraderPositioning(
  trace: typeof strategyExecutionTraces.$inferSelect,
  config: LiquidationTrendConfig,
) {
  const db = getDb();
  try {
    const credential = await db
      .select({
        apiKeyCiphertext: exchangeCredentials.apiKeyCiphertext,
        apiKeyIv: exchangeCredentials.apiKeyIv,
      })
      .from(exchangeCredentials)
      .where(
        and(
          eq(exchangeCredentials.ownerEmail, trace.ownerEmail),
          eq(exchangeCredentials.accountId, trace.accountId),
          eq(exchangeCredentials.environment, "LIVE"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);
    if (!credential) throw new Error("交易子账户未配置 Binance 实盘 API Key");
    const apiKey = await decryptCredential(
      credential.apiKeyCiphertext,
      credential.apiKeyIv,
      credentialContext(trace.ownerEmail, trace.accountId, "api-key"),
    );
    const snapshot = await getBinanceLargeTraderPositioningSnapshot(
      apiKey,
      trace.symbol,
    );
    return analyzeLargeTraderLongPositioning(
      {
        symbol: trace.symbol,
        observedAt: Date.now(),
        ...snapshot,
      },
      config.largeTrader,
    );
  } catch (error) {
    const unavailable = analyzeLargeTraderLongPositioning(
      {
        symbol: trace.symbol,
        observedAt: Date.now(),
        openInterestValue: [],
        topPositionLongShortRatio: [],
        topAccountLongShortRatio: [],
        takerBuySellRatio: [],
      },
      config.largeTrader,
    );
    return {
      ...unavailable,
      message: error instanceof Error
        ? `大户聚合持仓读取失败：${error.message}`
        : unavailable.message,
    };
  }
}

function isTransientMarketDataWait(error: unknown): error is BinanceLiveError {
  return (
    error instanceof BinanceLiveError &&
    (error.status === 429 || error.status === 503)
  );
}

async function executeConfiguredEntrySafely(
  trace: typeof strategyExecutionTraces.$inferSelect,
  config: LiquidationTrendConfig,
  markPrice: number,
  evidence: Record<string, unknown>,
) {
  try {
    return await executeConfiguredEntry(trace, config, markPrice, evidence);
  } catch (error) {
    const deferredAt = new Date();
    const latestEvidence = {
      ...asRecord(safeParse(trace.entryEvidenceJson)),
      ...evidence,
    };
    const frozenDecision = asRecord(
      latestEvidence.frozenExecutionDecision,
    );
    const directionLabel = evidence.brainDecisionDirection === "SHORT"
      ? "做空"
      : "做多";
    const message = error instanceof Error
      ? `${directionLabel}执行链暂时异常：${error.message}`
      : `${directionLabel}执行链暂时异常`;
    let releasedReservation = false;
    try {
      releasedReservation = await releaseUnboundNexusExecutionIntentForTrace({
        traceId: trace.traceId,
        reasonCode: "PRE_SUBMISSION_REANALYSIS_REQUIRED",
        reasonMessage: "委托创建前执行链异常，已释放未绑定订单的资金预留",
        detail: {
          error: error instanceof Error ? error.message : "未知错误",
          releasedAt: deferredAt.toISOString(),
        },
      });
    } catch {
      // The reservation may have transitioned concurrently. Keep the existing
      // recovery path rather than making error reporting itself fail.
    }
    if (releasedReservation) {
      latestEvidence.frozenExecutionDecision = {
        ...frozenDecision,
        approved: false,
        decisionFrozen: false,
        retryWithoutReanalysis: false,
        waitCode: "NEXUS_EXECUTION_REANALYSIS_REQUIRED",
        waitMessage: message,
        releasedReservationAt: deferredAt.toISOString(),
      };
      const [rearmedTrace] = await getDb()
        .update(strategyExecutionTraces)
        .set({
          state: "ARMED",
          resultCode: "NEXUS_EXECUTION_REANALYSIS_REQUIRED",
          resultMessage:
            "委托创建前异常已释放旧预留；下一轮必须使用当前市场事实重新判断",
          entryEvidenceJson: JSON.stringify(latestEvidence),
          completedAt: null,
          updatedAt: deferredAt,
        })
        .where(
          and(
            eq(strategyExecutionTraces.id, trace.id),
            inArray(strategyExecutionTraces.state, [
              "ANALYZING",
              "ARMED",
              "ORDER_READY",
            ]),
          ),
        )
        .returning({ id: strategyExecutionTraces.id });
      if (rearmedTrace) {
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: "NEXUS_EXECUTION_RESERVATION_RELEASED",
          stage: "ORDER",
          outcome: "PENDING",
          message:
            "本地未创建订单的旧执行预留已释放；下一轮重新读取当前事实，不复用旧方向与价格判断",
          detail: {
            retryWithoutReanalysis: false,
            releasedReservation: true,
          },
          eventAt: deferredAt,
        });
      }
      return false;
    }
    const renewal = renewFrozenExecutionDecision({
      frozenDecision: {
        ...frozenDecision,
        waitCode: "LONG_EXECUTION_PIPELINE_RECOVERY_WAIT",
        waitMessage: message,
        lastDeferredAt: deferredAt.toISOString(),
      },
      deferredAt,
      waitCode: "LONG_EXECUTION_PIPELINE_RECOVERY_WAIT",
      analysisValiditySeconds: config.trigger.analysisValiditySeconds,
    });
    latestEvidence.frozenExecutionDecision = renewal.decision;
    const [deferredTrace] = await getDb()
      .update(strategyExecutionTraces)
      .set({
        state: "ORDER_READY",
        resultCode: "LONG_EXECUTION_PIPELINE_RECOVERY_WAIT",
        resultMessage: message,
        entryEvidenceJson: JSON.stringify(latestEvidence),
        ...(renewal.executionExpiresAtMs !== null
          ? { expiresAt: new Date(renewal.executionExpiresAtMs) }
          : {}),
        completedAt: null,
        updatedAt: deferredAt,
      })
      .where(
        and(
          eq(strategyExecutionTraces.id, trace.id),
          inArray(strategyExecutionTraces.state, [
            "ANALYZING",
            "ARMED",
            "ORDER_READY",
          ]),
        ),
      )
      .returning({ id: strategyExecutionTraces.id });
    if (!deferredTrace) return false;
    await appendEvent(trace.traceId, trace.strategyId, {
      eventType: "LONG_EXECUTION_PIPELINE_RECOVERY_WAIT",
      stage: "ORDER",
      outcome: "PENDING",
      message,
      detail: {
        retryWithoutReanalysis: true,
        executionStateChanged: false,
        executionWindowRenewed: renewal.renewed,
        executionExpiresAt:
          renewal.executionExpiresAtMs === null
            ? null
            : new Date(renewal.executionExpiresAtMs).toISOString(),
      },
      eventAt: deferredAt,
    });
    return false;
  }
}

async function executeConfiguredEntry(
  trace: typeof strategyExecutionTraces.$inferSelect,
  config: LiquidationTrendConfig,
  markPrice: number,
  evidence: Record<string, unknown>,
) {
  const db = getDb();
  const executionAttemptStartedAt = new Date();
  const brainDirection = evidence.brainDecisionDirection === "SHORT"
    ? "SHORT" as const
    : "LONG" as const;
  const executionDirection = resolveStrategyExecutionDirection({
    mode: config.execution.directionMode,
    brainDirection,
  });
  Object.assign(
    evidence,
    buildAutomatedEntryDirectionEvidence(executionDirection),
  );
  let executionIntentKey: string | null = null;
  const defer = async (
    code: string,
    message: string,
    detail: Record<string, unknown> = {},
  ) => {
    const deferredAt = new Date();
    const baseFrozenExecutionDecision = {
      ...asRecord(evidence.frozenExecutionDecision),
      version: 1,
      approved: true,
      decisionFrozen: true,
      retryWithoutReanalysis: true,
      lastDeferredAt: deferredAt.toISOString(),
      waitCode: code,
      waitMessage: message,
      waitDetail: detail,
    };
    const renewal = renewFrozenExecutionDecision({
      frozenDecision: baseFrozenExecutionDecision,
      deferredAt,
      waitCode: code,
      analysisValiditySeconds: config.trigger.analysisValiditySeconds,
    });
    const frozenExecutionDecision = renewal.decision;
    evidence.frozenExecutionDecision = frozenExecutionDecision;
    await db
      .update(strategyExecutionTraces)
      .set({
        state: "ORDER_READY",
        resultCode: code,
        resultMessage: message,
        entryEvidenceJson: JSON.stringify(evidence),
        ...(renewal.executionExpiresAtMs !== null
          ? {
              expiresAt: new Date(
                Math.max(
                  trace.expiresAt.getTime(),
                  renewal.executionExpiresAtMs,
                ),
              ),
            }
          : {}),
        completedAt: null,
        updatedAt: deferredAt,
      })
      .where(
        and(
          eq(strategyExecutionTraces.id, trace.id),
          inArray(strategyExecutionTraces.state, [
            "ANALYZING",
            "ARMED",
            "ORDER_READY",
          ]),
        ),
      );
    await appendEvent(trace.traceId, trace.strategyId, {
      eventType: code,
      stage: "ORDER",
      outcome: "PENDING",
      message,
      detail: {
        ...detail,
        pilot: true,
        orderSubmissionAllowed: false,
        executionWindowRenewed: renewal.renewed,
        executionExpiresAt:
          renewal.executionExpiresAtMs !== null
            ? new Date(renewal.executionExpiresAtMs).toISOString()
            : null,
      },
      eventAt: deferredAt,
    });
  };
  const reject = async (code: string, message: string, detail: unknown = {}) => {
    if (executionIntentKey) {
      try {
        await advanceNexusExecutionIntent({
          intentKey: executionIntentKey,
          nextStatus: "REJECTED",
          reasonCode: code,
          reasonMessage: message,
          detail: asRecord(detail),
        });
      } catch {
        // 已进入交易所未知态的意图不能被分析拒绝覆盖。
      }
      executionIntentKey = null;
    }
    await db
      .update(strategyExecutionTraces)
      .set({
        state: "REJECTED",
        resultCode: code,
        resultMessage: message,
        entryEvidenceJson: JSON.stringify(evidence),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(strategyExecutionTraces.id, trace.id),
          inArray(strategyExecutionTraces.state, ["ANALYZING", "ARMED", "ORDER_READY"]),
        ),
      );
    await appendEvent(trace.traceId, trace.strategyId, {
      eventType: `PILOT_REJECTED:${code}`,
      stage: "ORDER",
      outcome: "REJECTED",
      message,
      detail: { ...asRecord(detail), pilot: true, orderSubmissionAllowed: false },
      eventAt: new Date(),
    });
  };

  if (!(await liveTradingAllowedByServer()))
    return reject("SERVER_LIVE_DISABLED", "服务器实盘总开关未启用");
  const validationBlock = await nexusConfigValidationEntryBlock({
    strategyId: trace.strategyId,
    configVersion: trace.configVersion,
  });
  if (validationBlock)
    return reject(
      validationBlock.code,
      validationBlock.message,
      {
        validationStatus: validationBlock.status,
        baselineVersion: validationBlock.baselineVersion,
        reasons: validationBlock.reasons,
        oldPositionsKeepBoundVersion: true,
      },
    );
  const [account, credential, symbol, strategyRecord] = await Promise.all([
    db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.ownerEmail, trace.ownerEmail),
          eq(tradingAccounts.accountId, trace.accountId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select()
      .from(exchangeCredentials)
      .where(
        and(
          eq(exchangeCredentials.ownerEmail, trace.ownerEmail),
          eq(exchangeCredentials.accountId, trace.accountId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select()
      .from(contractSymbols)
      .where(
        and(
          eq(contractSymbols.symbol, trace.symbol),
          eq(contractSymbols.isActive, true),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({
        brainKey: strategies.brainKey,
        configVersion: strategies.configVersion,
      })
      .from(strategies)
      .where(eq(strategies.id, trace.strategyId))
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (!strategyRecord)
    return reject("PILOT_STRATEGY_INVALID", "执行轨迹对应的大脑不存在");
  const retiredVersionBlock = retiredNexusExecutionVersionBlock({
    traceConfigVersion: trace.configVersion,
    currentConfigVersion: strategyRecord.configVersion,
    evidence,
  });
  if (retiredVersionBlock)
    return reject(
      retiredVersionBlock.code,
      retiredVersionBlock.message,
      {
        ...retiredVersionBlock,
        freshAnalysisRequired: true,
      },
    );
  if (!account || account.accountType !== "STRATEGY")
    return reject("PILOT_ACCOUNT_INVALID", "首轮测试账户不存在或不是交易子账户");
  const readiness = getTradeReadiness(
    account,
    credential,
    await liveTradingAllowedByServer(),
  );
  if (!credential || !readiness.liveReady)
    return reject(
      "PILOT_ACCOUNT_NOT_READY",
      readiness.blockers.join("；") || "子账户实盘密钥未就绪",
    );
  const keys = {
    apiKey: await decryptCredential(
      credential.apiKeyCiphertext,
      credential.apiKeyIv,
      credentialContext(trace.ownerEmail, trace.accountId, "api-key"),
    ),
    secretKey: await decryptCredential(
      credential.secretKeyCiphertext,
      credential.secretKeyIv,
      credentialContext(trace.ownerEmail, trace.accountId, "secret-key"),
    ),
  };
  const unknownOrderReconciliation =
    await reconcileUnknownAccountOrdersBeforeEntry({
      ownerEmail: trace.ownerEmail,
      accountId: trace.accountId,
      credentials: keys,
    });
  evidence.unknownOrderReconciliation = unknownOrderReconciliation;
  if (!symbol)
    return defer(
      "PILOT_SYMBOL_RULES_WAIT",
      "本地交易所合约规则暂不可用；已冻结下单结论，规则恢复后直接重试执行",
    );
  const contractLeverageDecision = evaluateAutomatedEntryContractLeverage(
    symbol.maxLeverage,
    config.execution.leverage,
  );
  if (contractLeverageDecision.code === "CONTRACT_LEVERAGE_UNKNOWN")
    return defer(
      "PILOT_CONTRACT_LEVERAGE_WAIT",
      `${trace.symbol} 的 Binance 合约最大杠杆尚未同步；不创建委托，等待合约规则恢复`,
      contractLeverageDecision,
    );
  if (!contractLeverageDecision.allowed)
    return reject(
      "PILOT_CONTRACT_MAX_LEVERAGE_TOO_LOW",
      `${trace.symbol} 的 Binance 合约最高仅 ${contractLeverageDecision.contractMaximumLeverage} 倍；自动策略要求合约至少支持 ${contractLeverageDecision.minimumRequiredLeverage} 倍，本次直接弃单`,
      contractLeverageDecision,
    );
  // The Binance REST weight header is shared by every service using the same
  // public IP. Do not claim an order while another project has exhausted that
  // shared budget. Keeping the trace ARMED lets the normal monitor retry after
  // the minute window recovers, without creating a duplicate order record.
  let systemMetrics: Awaited<ReturnType<typeof getBinanceLiveSystemMetrics>>;
  try {
    systemMetrics = await getBinanceLiveSystemMetrics();
  } catch (error) {
    return defer(
      "PILOT_REST_CAPACITY_WAIT",
      "Binance 代理容量状态暂不可读；已冻结下单结论，环境恢复后直接重试执行",
      {
        reason: error instanceof Error ? error.message : "代理容量状态读取失败",
      },
    );
  }
  const restCapacity = evaluateAutomatedEntryRestCapacity({
    rest: systemMetrics.rest,
    requiredRemainingWeight:
      LIQUIDATION_PILOT_LIMITS.minRestRemainingWeightBeforeEntry,
  });
  if (!restCapacity.allowed)
    return defer(
      "PILOT_REST_CAPACITY_WAIT",
      "本项目 Binance REST 预留不足，保留信号并等待下一轮安全重试",
      {
        remainingRestWeight: restCapacity.remainingRestWeight,
        requiredRemainingWeight: restCapacity.requiredRemainingWeight,
        effectiveUsedWeight:
          systemMetrics.rest?.effectiveUsedWeight ?? null,
        localEstimatedWeight:
          systemMetrics.rest?.localEstimatedWeight ?? null,
        binanceObservedWeight:
          systemMetrics.rest?.binanceObservedWeight ?? null,
      },
    );

  const strategyDailyPnl = await readTradingStrategyDailyPnl(
    { email: trace.ownerEmail, accountId: trace.accountId },
    account,
    trace.strategyId,
  );
  const effectiveDailyLossLimitUsdt = config.risk.dailyLossLimitUsdt ?? 15;
  const dailyLossLimitExceeded =
    strategyDailyPnl.dailyPnl <= -effectiveDailyLossLimitUsdt;
  evidence.strategyDailyLossAdvisory = {
    strategyId: trace.strategyId,
    dailyPnl: strategyDailyPnl.dailyPnl,
    dailyRealizedPnl: strategyDailyPnl.dailyRealizedPnl,
    unrealizedPnl: strategyDailyPnl.unrealizedPnl,
    effectiveLossLimitAmount: effectiveDailyLossLimitUsdt,
    strategyLossLimitAmount: config.risk.dailyLossLimitUsdt ?? 15,
    nextResetAt: strategyDailyPnl.nextResetAt.toISOString(),
    exceeded: dailyLossLimitExceeded,
    orderAffecting: false,
  };
  if (dailyLossLimitExceeded) {
    try {
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "PILOT_DAILY_LOSS_ADVISORY",
        stage: "ORDER",
        outcome: "INFO",
        message:
          `策略当日综合盈亏 ${strategyDailyPnl.dailyPnl.toFixed(2)} USDT 已越过旧试验参考线 -${effectiveDailyLossLimitUsdt.toFixed(2)} USDT；` +
          "仅记录运营风险，不否决已由当前眼睛与大脑确认的订单",
        detail: evidence.strategyDailyLossAdvisory,
        eventAt: new Date(),
      });
    } catch {
      // Advisory logging must never decide whether an already-confirmed order
      // can proceed.
    }
  }

  const { startedAt: dayStartedAt } = chinaTradingDayWindow();
  const [openPositions, pendingOrders, dailyOrders] = await Promise.all([
    db
      .select({
        id: livePositions.id,
        symbol: livePositions.symbol,
        positionSide: livePositions.positionSide,
        quantity: livePositions.quantity,
        entryPrice: livePositions.entryPrice,
        markPrice: livePositions.markPrice,
        leverage: livePositions.leverage,
        riskPlanJson: livePositions.riskPlanJson,
        executedRiskPlanJson: livePositions.executedRiskPlanJson,
        favorablePrice: livePositions.favorablePrice,
        trailingActivationPercent: livePositions.trailingActivationPercent,
        trailingStopPercent: livePositions.trailingStopPercent,
      })
      .from(livePositions)
      .where(
        and(
          eq(livePositions.ownerEmail, trace.ownerEmail),
          eq(livePositions.accountId, trace.accountId),
          inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
        ),
      ),
    db
      .select({
        id: liveOrderEvents.id,
        symbol: liveOrderEvents.symbol,
        positionSide: liveOrderEvents.positionSide,
        status: liveOrderEvents.status,
        estimatedNotional: liveOrderEvents.estimatedNotional,
        quantity: liveOrderEvents.quantity,
        referencePrice: liveOrderEvents.referencePrice,
        responseJson: liveOrderEvents.responseJson,
      })
      .from(liveOrderEvents)
      .where(
        and(
          eq(liveOrderEvents.ownerEmail, trace.ownerEmail),
          eq(liveOrderEvents.accountId, trace.accountId),
          eq(liveOrderEvents.testOnly, false),
          inArray(liveOrderEvents.status, [
            "PENDING",
            "NEW",
            "PARTIALLY_FILLED",
            "CANCEL_PENDING",
            "EXECUTION_UNKNOWN",
          ]),
        ),
      ),
    db
      .select({
        id: liveOrderEvents.id,
        clientOrderId: liveOrderEvents.clientOrderId,
        symbol: liveOrderEvents.symbol,
        estimatedNotional: liveOrderEvents.estimatedNotional,
        responseJson: liveOrderEvents.responseJson,
        createdAt: liveOrderEvents.createdAt,
      })
      .from(liveOrderEvents)
      .where(
        and(
          eq(liveOrderEvents.ownerEmail, trace.ownerEmail),
          eq(liveOrderEvents.accountId, trace.accountId),
          eq(liveOrderEvents.testOnly, false),
          gte(liveOrderEvents.createdAt, dayStartedAt),
          inArray(liveOrderEvents.status, [
            "PENDING",
            "NEW",
            "PARTIALLY_FILLED",
            "SUBMITTED",
            "FILLED",
            "EXECUTION_UNKNOWN",
          ]),
        ),
      ),
  ]);
  const orderConcurrency = evaluateAutomatedOrderConcurrency({
    orders: pendingOrders,
    targetSymbol: trace.symbol,
    targetPositionSide: executionDirection.positionSide,
    positionMode: credential.positionMode ?? "ONE_WAY",
  });
  if (
    !orderConcurrency.allowed &&
    (
      orderConcurrency.code === "EXECUTION_UNKNOWN_ORDER" ||
      config.execution.sameLegWorkingOrderPolicy !== "ALLOW"
    )
  )
    return reject(
      orderConcurrency.code === "EXECUTION_UNKNOWN_ORDER"
        ? "PILOT_EXECUTION_UNKNOWN_ORDER"
        : "PILOT_PENDING_ORDER_SAME_LEG",
      orderConcurrency.code === "EXECUTION_UNKNOWN_ORDER"
        ? "账户存在执行结果未知的订单，核对完成前禁止新增自动仓位"
        : `${trace.symbol} 已存在同方向工作订单，本次禁止重复提交`,
      {
        blockingOrderId: orderConcurrency.blockingOrder.id ?? null,
        blockingSymbol: orderConcurrency.blockingOrder.symbol,
        blockingPositionSide:
          orderConcurrency.blockingOrder.positionSide,
        blockingStatus: orderConcurrency.blockingOrder.status,
        reservedNotional: orderConcurrency.reservedNotional,
      },
    );
  const exchangePositions = await getLivePositionSnapshots(
    keys,
    [
      { symbol: trace.symbol, positionSide: "LONG" },
      { symbol: trace.symbol, positionSide: "SHORT" },
    ],
  );
  const existingExchangePosition = findBlockingOpenSymbolPosition([
    {
      symbol: trace.symbol,
      positionSide: "LONG" as const,
      quantity: exchangePositions.get(`${trace.symbol}:LONG`)?.quantity ?? 0,
    },
    {
      symbol: trace.symbol,
      positionSide: "SHORT" as const,
      quantity: exchangePositions.get(`${trace.symbol}:SHORT`)?.quantity ?? 0,
    },
  ], {
    symbol: trace.symbol,
    targetPositionSide: executionDirection.positionSide,
    positionMode: credential.positionMode ?? "ONE_WAY",
  });
  const existingPositionBlockedByStrategy = Boolean(
    existingExchangePosition &&
    (
      config.execution.existingPositionPolicy !== "ALLOW_SAME_DIRECTION" ||
      existingExchangePosition.positionSide !== executionDirection.positionSide
    ),
  );
  if (existingPositionBlockedByStrategy && existingExchangePosition)
    return reject(
      "PILOT_SYMBOL_POSITION_ALREADY_OPEN",
      credential.positionMode === "HEDGE"
        ? `Binance 已存在 ${trace.symbol} ${existingExchangePosition.positionSide === "LONG" ? "多" : "空"}仓；双向持仓不重复新开同一方向`
        : `Binance 已存在 ${trace.symbol} 仓位；单向持仓禁止继续开仓`,
      {
        existingPositionSide: existingExchangePosition.positionSide,
        existingQuantity: existingExchangePosition.quantity,
        positionMode: credential.positionMode ?? "ONE_WAY",
      },
    );
  const openPositionTraces: Array<{
    positionId: string | null;
    strategyId: number;
    symbol: string;
    state: string;
    entryEvidenceJson: string | null;
  }> = [];
  for (const positionIdBatch of sqlValueBatches(
    openPositions.map((position) => String(position.id)),
  )) {
    const rows = await db
      .select({
        positionId: strategyExecutionTraces.positionId,
        strategyId: strategyExecutionTraces.strategyId,
        symbol: strategyExecutionTraces.symbol,
        state: strategyExecutionTraces.state,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
      })
      .from(strategyExecutionTraces)
      .where(inArray(strategyExecutionTraces.positionId, positionIdBatch));
    openPositionTraces.push(...rows);
  }
  const currentMarketClusterId =
    typeof evidence.marketClusterId === "string"
      ? evidence.marketClusterId
      : null;
  const sameMarketClusterOpenPositions = currentMarketClusterId
    ? openPositionTraces.filter((row) => {
        const existing = asRecord(safeParse(row.entryEvidenceJson ?? "{}"));
        return existing.marketClusterId === currentMarketClusterId;
      }).length
    : 0;
  evidence.concurrentExposure = {
    openPositionCountAtEntry: openPositions.length,
    openSymbolsAtEntry: openPositions.map((position) => position.symbol),
    sameMarketClusterOpenPositions,
    marketClusterId: currentMarketClusterId,
    independentOpportunity:
      openPositions.length === 0 || sameMarketClusterOpenPositions === 0,
    observationOnly: true,
  };
  await appendEvent(trace.traceId, trace.strategyId, {
    eventType: "CONCURRENT_EXPOSURE_RECORDED",
    stage: "ORDER",
    outcome: "INFO",
    message: sameMarketClusterOpenPositions
      ? `当前已有 ${sameMarketClusterOpenPositions} 个仓位来自同一触发事实，仅记录重复波段暴露`
      : `当前 ${openPositions.length} 个仓位未发现与本次相同的触发事实`,
    detail: asRecord(evidence.concurrentExposure),
    eventAt: new Date(),
  });

  let executionMarkPrice: number;
  let liveEntrySpreadBps = 0;
  let entryBookDepth: { bidQuantity: number; askQuantity: number } | null = null;
  try {
    const [latestMark] = await getBinanceLiveMarkPrices([trace.symbol]);
    executionMarkPrice = latestMark?.markPrice ?? Number.NaN;
  } catch (error) {
    return defer(
      "PILOT_MARK_PRICE_WAIT",
      "实盘委托前无法取得新鲜标记价格；已冻结下单结论，等待环境恢复",
      { reason: error instanceof Error ? error.message : "标记价格读取失败" },
    );
  }
  try {
    const book = await waitForFreshNexusBookTicker(
      trace.symbol,
      Math.min(1_500, config.trigger.maxSignalDelayMs),
    );
    executionMarkPrice = executionDirection.side === "BUY"
      ? book.askPrice
      : book.bidPrice;
    entryBookDepth = {
      bidQuantity: book.bidQuantity,
      askQuantity: book.askQuantity,
    };
    evidence.nexusBookEyeAtEntry = {
      source: "BINANCE_INDIVIDUAL_BOOK_TICKER_WS",
      ageMs: book.ageMs,
      updateId: book.updateId,
      spreadBps: book.spreadBps,
      imbalance: book.imbalance,
      microPrice: book.microPrice,
      bidQuantity: book.bidQuantity,
      askQuantity: book.askQuantity,
      executableSide: executionDirection.side === "BUY" ? "ASK" : "BID",
      executablePrice: executionMarkPrice,
      directionalImbalance:
        executionDirection.side === "BUY" ? book.imbalance : -book.imbalance,
      staleAfterMs: 500,
    };
    liveEntrySpreadBps = Math.max(0, Number(book.spreadBps) || 0);
  } catch (error) {
    return defer(
      "NEXUS_BOOK_EYE_STALE",
      error instanceof Error
        ? error.message
        : "100毫秒盘口未就绪；已冻结下单结论并等待行情恢复",
      { staleAfterMs: 500, source: "BINANCE_INDIVIDUAL_BOOK_TICKER_WS" },
    );
  }
  const ownEntryRegime = asRecord(evidence.nexusOwnEntryRegime5m);
  const previousAnchorResolution = asRecord(evidence.entryAnchorResolution);
  const atr5m = Number(ownEntryRegime.atr);
  const analyzedConfirmationLevel = Number(
    previousAnchorResolution.confirmationLevel,
  );
  const analyzedInvalidBoundary = Number(
    previousAnchorResolution.invalidBoundary,
  );
  const frozenExecutionDecision = asRecord(
    evidence.frozenExecutionDecision,
  );
  const entryAuthorization = resolveNexusEntryAuthorization(evidence, {
    expectedPositionSide: executionDirection.positionSide,
  });
  if (!entryAuthorization.authorized)
    return reject(
      "NEXUS_EXECUTION_AUTHORIZATION_MISSING",
      "当前执行证据没有显式或冻结授权，已失败关闭并禁止提交订单",
      { entryAuthorization },
    );
  const explorationAuthorized = entryAuthorization.explorationProbe;
  const postExitReentryMinimumQuantity =
    asRecord(evidence.postExitReentryCandidate).eligible === true &&
    asRecord(evidence.postExitReentryCandidate).minimumQuantityOnly === true;
  const configuredMinimumOrderQuantityMultiplier =
    postExitReentryMinimumQuantity
      ? 1
      : config.execution.minimumOrderQuantityMultiplier;
  evidence.resolvedExecutionAuthorization = entryAuthorization;
  const marketEyeDecision = asRecord(
    evidence.nexusMarketEyeDecision,
  );
  const selectedConfirmedPath =
    typeof marketEyeDecision.selectedPath === "string"
      ? marketEyeDecision.selectedPath
      : null;
  const nexusVolumeTiming = asRecord(evidence.nexusVolumeTiming);
  const nexusBookEyeAtEntry = asRecord(evidence.nexusBookEyeAtEntry);
  const adaptiveExecutionContext = {
    confirmedPath: selectedConfirmedPath,
    volumeTimingState:
      typeof nexusVolumeTiming.state === "string"
        ? nexusVolumeTiming.state
        : null,
    bookAgeMs: Number(nexusBookEyeAtEntry.ageMs),
    bookStaleAfterMs: Number(nexusBookEyeAtEntry.staleAfterMs),
    spreadBps: Number(nexusBookEyeAtEntry.spreadBps),
    strategyMaxEntryDistanceAtr: config.trend.maxEntryDistanceAtr,
  };
  const threeMinuteProbabilityStrategy =
    config.trigger.kind === "THREE_MINUTE_PROBABILITY";
  let probabilityDecision:
    ReturnType<typeof evaluateNexusNetExpectancy> | null = null;
  if (
    !threeMinuteProbabilityStrategy &&
    config.probabilityPolicy?.mode === "NET_EXPECTANCY"
  ) {
    const probabilityContextIdentity =
      nexusProbabilityContextFromEvidence(evidence);
    const probabilityContext = await loadNexusProbabilityContext({
      strategyId: trace.strategyId,
      policy: config.probabilityPolicy,
    });
    probabilityDecision = evaluateNexusNetExpectancy({
      policy: config.probabilityPolicy,
      direction: executionDirection.tradeDirection,
      eyeVerdict: String(marketEyeDecision.verdict ?? "UNKNOWN"),
      eyeDataIntegrity: String(
        marketEyeDecision.dataIntegrity ??
          asRecord(evidence.nexusDecisionSnapshot).integrity ??
          "UNAVAILABLE",
      ),
      selectedPath: selectedConfirmedPath,
      marketContextKey: probabilityContextIdentity.marketContextKey,
      samples: probabilityContext.samples,
      stopLossRoePercent: config.risk.stopLossPercent,
      takeProfitSteps: config.risk.takeProfitSteps,
      leverage: config.execution.leverage,
      currentOrderNotionalUsdt:
        config.execution.targetOrderNotionalUsdt *
        config.execution.leverage,
      liveSpreadBps: liveEntrySpreadBps,
      estimatedFundingCostPercent:
        adverseFundingCostRate({
          direction: executionDirection.tradeDirection,
          fundingRate: Number(
            asRecord(evidence.nexusFundingContext).fundingRate,
          ),
        }) * 100,
      coldStart: probabilityContext.coldStart,
    });
    evidence.nexusNetExpectancyDecision = probabilityDecision;
    await appendEvent(trace.traceId, trace.strategyId, {
      eventType: `NEXUS_NET_EXPECTANCY_OBSERVED:${probabilityDecision.code}`,
      stage: "ORDER",
      outcome: "INFO",
      message: `历史期望仅供复盘；当前下单继续由眼睛与大脑证据决定。${probabilityDecision.summary}`,
      detail: probabilityDecision,
      eventAt: new Date(),
    });
  }
  const probabilityEntryExecution =
    resolveNexusProbabilityEntryExecution({
      policy: config.probabilityPolicy,
      probabilityDecision,
      configuredOrderType: config.execution.orderType,
      configuredEntryDistanceExecutionMode:
        config.execution.entryDistanceExecutionMode,
    });
  const effectiveExecutionConfig = {
    ...config.execution,
    orderType: probabilityEntryExecution.orderType,
    entryDistanceExecutionMode:
      probabilityEntryExecution.entryDistanceExecutionMode,
  };
  const selectedStateMachine =
    selectedConfirmedPath ===
    asRecord(evidence.nexusPureStateMachine).machine
      ? asRecord(evidence.nexusPureStateMachine)
      : selectedConfirmedPath ===
          asRecord(evidence.nexusTrendBreakoutStateMachine).machine
        ? asRecord(evidence.nexusTrendBreakoutStateMachine)
        : {};
  const dedicatedMarketStructureStrategy =
    MARKET_STRUCTURE_TRIGGER_KINDS.has(
      config.trigger.kind as
        | "GRID_PRICE_LEVEL"
        | "SCHEDULED_SCAN"
        | "BREAKOUT_RETEST",
    );
  const postExitReentryStrategy =
    asRecord(evidence.postExitReentryCandidate).eligible === true;
  const directionalStructureStrategy =
    threeMinuteProbabilityStrategy ||
    dedicatedMarketStructureStrategy ||
    postExitReentryStrategy;
  const threeMinuteLearningMode = String(
    asRecord(evidence.threeMinuteProbability).learningMode ?? "ACTIVE",
  );
  const threeMinuteForceMinimumQuantity =
    threeMinuteProbabilityStrategy &&
    (
      (
        threeMinuteLearningMode === "CALIBRATING" &&
        config.trigger.threeMinuteProbability?.calibrationMode ===
          "MINIMUM_ORDER"
      ) ||
      threeMinuteLearningMode === "MINIMUM_ORDER"
    );
  if (threeMinuteProbabilityStrategy)
    evidence.threeMinuteExecutionSizing = {
      learningMode: threeMinuteLearningMode,
      forceExchangeMinimumQuantity: threeMinuteForceMinimumQuantity,
      calibrationMode:
        config.trigger.threeMinuteProbability?.calibrationMode ?? null,
      negativeExpectancyMode:
        config.trigger.threeMinuteProbability?.negativeExpectancyMode ?? null,
    };
  const forceExchangeMinimumQuantity =
    probabilityEntryExecution.forceExchangeMinimumQuantity ||
    threeMinuteForceMinimumQuantity;
  const entryAnchors = directionalStructureStrategy
    ? resolveDirectionalEntryAnchors({
        direction: executionDirection.tradeDirection,
        approvedMarkPrice: Number(evidence.executionApprovedMarkPrice),
        atr5m,
        atrStopBuffer: config.risk.atrStopBuffer,
        priceTickSize: symbol.priceTickSize,
      })
    : resolveExplorationLongAnchors({
        explorationAllowed: explorationAuthorized,
        executionMarkPrice,
        liquidationPrice:
          trace.triggerReferencePrice > 0
            ? trace.triggerReferencePrice
            : trace.liquidationPrice,
        atr5m,
        atrStopBuffer: config.risk.atrStopBuffer,
        priceTickSize: symbol.priceTickSize,
        confirmationLevel: analyzedConfirmationLevel,
        invalidBoundary: analyzedInvalidBoundary,
        confirmedPath: selectedConfirmedPath,
        confirmedEvidenceFactIds: Array.isArray(
          selectedStateMachine.evidenceFactIds,
        )
          ? selectedStateMachine.evidenceFactIds.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        marketFacts: Array.isArray(evidence.nexusMarketFactsShadow)
          ? evidence.nexusMarketFactsShadow
          : [],
        frozenDecisionApproved:
          frozenExecutionDecision.approved === true &&
          frozenExecutionDecision.decisionFrozen === true,
        approvedMarkPrice: Number(evidence.executionApprovedMarkPrice),
      });
  if (!entryAnchors)
    return defer(
      "PILOT_ENTRY_ANCHORS_WAIT",
      explorationAuthorized
        ? "探索单缺少可计算的ATR风险边界，等待新鲜行情后重试"
        : "正式入场尚未形成确认位与结构失效边界，继续观察",
      {
        explorationAuthorized,
        atr5m: Number.isFinite(atr5m) ? atr5m : null,
        confirmationLevel: Number.isFinite(analyzedConfirmationLevel)
          ? analyzedConfirmationLevel
          : null,
        invalidBoundary: Number.isFinite(analyzedInvalidBoundary)
          ? analyzedInvalidBoundary
          : null,
      },
    );
  const { confirmationLevel, invalidBoundary } = entryAnchors;
  const entryDistanceMode = entryDistanceExecutionMode(
    effectiveExecutionConfig,
  );
  const effectiveRequestedOrderMode = effectiveEntryOrderMode(
    effectiveExecutionConfig,
  );
  const maxExecutableMarketChaseDistanceAtr = Math.min(
    config.trend.maxEntryDistanceAtr,
    config.execution.adaptiveMarketMaxDistanceAtr ?? 0.2,
  );
  evidence.entryAnchorResolution = {
    ...entryAnchors,
    atr5m,
    atrStopBuffer: config.risk.atrStopBuffer,
    explorationAuthorized,
  };
  const entryRevalidation = directionalStructureStrategy
    ? revalidateDirectionalEntry({
        direction: executionDirection.tradeDirection,
        executionMarkPrice,
        atr5m,
        confirmationLevel,
        invalidBoundary,
        maxEntryDistanceAtr: maxExecutableMarketChaseDistanceAtr,
        requireConfirmedEntryDistance:
          effectiveRequestedOrderMode === "MARKET",
      })
    : revalidateNexusConfirmedLongEntry({
        executionMarkPrice,
        atr5m,
        confirmationLevel,
        invalidBoundary,
        maxEntryDistanceAtr: maxExecutableMarketChaseDistanceAtr,
        // A fixed market order must already be close to confirmed structure.
        // Limit and adaptive entries calculate a non-chasing structural retest
        // price below; applying the market-distance gate here would make their
        // intended wait-for-retest behavior impossible.
        requireConfirmedEntryDistance:
          effectiveRequestedOrderMode === "MARKET" && !explorationAuthorized,
      });
  if (!entryRevalidation.eligible) {
    const detail = {
      revalidationCode: entryRevalidation.code,
      analyzedMarkPrice: markPrice,
      executionMarkPrice,
      finalEntryDistanceAtr: entryRevalidation.entryDistanceAtr,
      maxEntryDistanceAtr: maxExecutableMarketChaseDistanceAtr,
      analyticalMaxEntryDistanceAtr: config.trend.maxEntryDistanceAtr,
      invalidBoundary,
    };
    if (entryRevalidation.code === "STRUCTURE_INVALIDATED")
      return reject(
        "PILOT_ENTRY_STRUCTURE_INVALIDATED",
        "委托前最新价格已跌破结构失效位，本次信号终止",
        detail,
      );
    if (
      nexusEntryWaitDisposition(entryRevalidation.code) ===
      "TERMINATE_FOR_FRESH_ANALYSIS"
    )
      return reject(
        `PILOT_ENTRY_REVALIDATION_TERMINATED:${entryRevalidation.code}`,
        entryRevalidation.code === "PRICE_TOO_FAR"
          ? "委托前价格已经远离原确认位；旧成交时机结束，等待新信号重新分析，禁止复用旧判断追价"
          : "委托前入场结构已不再成立；旧生命周期结束，等待新信号重新分析",
        {
          ...detail,
          decisionFrozen:
            asRecord(evidence.frozenExecutionDecision).approved === true,
          analyticalDecisionReplayed: false,
          executionTimingRevalidated: true,
          freshAnalysisRequired: true,
        },
      );
    return defer(
      `PILOT_ENTRY_REVALIDATION_WAIT:${entryRevalidation.code}`,
      entryRevalidation.code === "PRICE_TOO_FAR"
        ? "委托前价格已远离原确认位，冻结的是方向结论而不是旧成交时机；禁止追价并等待有效期内回踩"
        : "委托前价格尚未重新站稳原确认结构，保留信号等待有效期内复核",
      {
        ...detail,
        decisionFrozen:
          asRecord(evidence.frozenExecutionDecision).approved === true,
        analyticalDecisionReplayed: false,
        executionTimingRevalidated: true,
      },
    );
  }

  const entryOrderAttempt = Math.max(
    1,
    Math.min(2, Math.trunc(Number(evidence.entryOrderAttempt) || 1)),
  );
  const entryOrder = directionalStructureStrategy &&
      executionDirection.tradeDirection === "SHORT"
    ? configuredShortEntryOrder({
        orderType: effectiveRequestedOrderMode,
        markPrice: executionMarkPrice,
        limitOffsetPercent: config.execution.limitOffsetPercent,
        adaptiveMarketMaxDistanceAtr:
          effectiveExecutionConfig.adaptiveMarketMaxDistanceAtr,
        priceTickSize: symbol.priceTickSize,
        brokenSupport: confirmationLevel,
        atr5m,
        adaptiveExecutionContext,
      })
    : configuredEntryOrder({
        orderType: effectiveRequestedOrderMode,
        markPrice: executionMarkPrice,
        limitOffsetPercent: config.execution.limitOffsetPercent,
        adaptiveMarketMaxDistanceAtr:
          effectiveExecutionConfig.adaptiveMarketMaxDistanceAtr,
        explorationProbe: explorationAuthorized,
        priceTickSize: symbol.priceTickSize,
        confirmationLevel,
        invalidBoundary,
        atr5m,
        adaptiveExecutionContext,
      });
  if (!entryOrder) {
    const limitRuleUnavailable =
      !Number.isFinite(symbol.priceTickSize) ||
      symbol.priceTickSize <= 0;
    return defer(
      limitRuleUnavailable
        ? "PILOT_LIMIT_RULES_WAIT"
        : "PILOT_ENTRY_PRICE_WAIT",
      limitRuleUnavailable
        ? "当前限价委托缺少有效交易所价格步长；保留信号并等待合约规则恢复，市价委托不受此项影响"
        : "当前价格距离结构失效位过近，暂不挂出无效限价；保留信号等待价格恢复后重新按交易所步长计算",
      {
        executionMarkPrice,
        priceTickSize: symbol.priceTickSize,
        confirmationLevel,
        invalidBoundary,
        atr5m,
        explorationAuthorized,
      },
    );
  }
  const analyzedEntryOrder = {
    ...entryOrder.analysis,
    configuredMode: config.execution.orderType,
    entryDistanceExecutionMode: entryDistanceMode,
    probabilityExecutionOverride:
      probabilityEntryExecution.probabilityApproved,
    anchorSource: entryAnchors.source,
    explorationDerivedAnchors: entryAnchors.derived,
  };
  const adaptiveShadowOrder = directionalStructureStrategy &&
      executionDirection.tradeDirection === "SHORT"
    ? configuredShortEntryOrder({
        orderType: "ADAPTIVE",
        markPrice: executionMarkPrice,
        limitOffsetPercent: config.execution.limitOffsetPercent,
        adaptiveMarketMaxDistanceAtr:
          effectiveExecutionConfig.adaptiveMarketMaxDistanceAtr,
        priceTickSize: symbol.priceTickSize,
        brokenSupport: confirmationLevel,
        atr5m,
        adaptiveExecutionContext,
      })
    : configuredEntryOrder({
        orderType: "ADAPTIVE",
        markPrice: executionMarkPrice,
        limitOffsetPercent: config.execution.limitOffsetPercent,
        adaptiveMarketMaxDistanceAtr:
          effectiveExecutionConfig.adaptiveMarketMaxDistanceAtr,
        explorationProbe: explorationAuthorized,
        priceTickSize: symbol.priceTickSize,
        confirmationLevel,
        invalidBoundary,
        atr5m,
        adaptiveExecutionContext,
      });
  const entryExecutionShadow = adaptiveShadowOrder
    ? buildEntryExecutionShadow({
        execution: effectiveExecutionConfig,
        decisionMarkPrice: executionMarkPrice,
        actualOrder: entryOrder,
        adaptiveOrder: adaptiveShadowOrder,
      })
    : null;
  evidence.analyzedEntryOrder = analyzedEntryOrder;
  evidence.entryExecutionShadow = entryExecutionShadow;
  evidence.probabilityEntryExecution = probabilityEntryExecution;
  const entryReferencePrice = entryOrder.price ?? executionMarkPrice;
  const dailyNotional = dailyOrders.reduce(
    (sum, order) => sum + order.estimatedNotional,
    0,
  );
  const candidateTraceIds = [
    ...new Set(
      dailyOrders
        .map((order) =>
          liquidationLongTraceIdFromClientOrderId(order.clientOrderId),
        )
        .filter((traceId): traceId is number => traceId !== null),
    ),
  ];
  const ownedTraceIds: number[] = [];
  for (const candidateTraceIdBatch of sqlValueBatches(candidateTraceIds)) {
    const rows = await db
        .select({ id: strategyExecutionTraces.id })
        .from(strategyExecutionTraces)
        .where(
          and(
            eq(strategyExecutionTraces.strategyId, trace.strategyId),
            inArray(strategyExecutionTraces.id, candidateTraceIdBatch),
          ),
        );
    ownedTraceIds.push(...rows.map((row) => row.id));
  }
  const strategyDailyMargin = attributedOrderInitialMargin(
    dailyOrders,
    ownedTraceIds,
    config.execution.leverage,
  );
  const accountCommittedMargin =
    openPositions.reduce(
      (sum, position) =>
        sum + position.quantity * position.markPrice / Math.max(position.leverage, 1),
      0,
    ) +
    pendingOrders.reduce(
      (sum, order) =>
        sum +
        pendingOrderReservedMargin(order, config.execution.leverage),
      0,
    );
  const strategyPositionIds = openPositionTraces
    .filter((row) => row.strategyId === trace.strategyId)
    .map((row) => Number(row.positionId))
    .filter((positionId) => Number.isSafeInteger(positionId));
  const committedMargin = attributedPositionMargin(
    openPositions,
    strategyPositionIds,
  );
  const strategyUnrealizedPnlUsdt = attributedPositionUnrealizedPnl(
    openPositions,
    strategyPositionIds,
  );
  const strategyMarginLimitPercent = config.risk.maxMarginUsagePercent ?? 50;
  const dailyMarginActivity = calculateAutomatedDailyMarginQuota({
    usedMarginUsdt: strategyDailyMargin,
    limitMarginUsdt: config.execution.maxDailyNotionalUsdt,
    unrealizedPnlUsdt: strategyUnrealizedPnlUsdt,
  });
  // Account funding is maintained by the independent account-audit runner.
  // Strategy analysis must never wait for that private REST path: a slow
  // balance refresh used to retain the whole brain-cycle lock and suppress all
  // subsequent opportunities. The saved Binance snapshot is evidence only;
  // Daily accumulated entry margin is telemetry only. Binance remains the
  // authoritative capital boundary when the order is submitted.
  const fundingSnapshot = accountFundingSnapshot(credential);
  const cachedBinanceAvailableBalance = Math.max(
    fundingSnapshot.availableToOpenUsdt ?? 0,
    0,
  );
  const executionReservationCapacity = cachedBinanceAvailableBalance;
  evidence.nexusAccountFundingSnapshot = fundingSnapshot;
  let approvedQuantity = 0;
  let approvedRequiredMargin = 0;
  let marginCapacity:
    ReturnType<typeof calculateStrategyMarginCapacity> | null = null;
  let executableRiskPlan:
    ReturnType<typeof buildPilotRiskPlan> | null = null;
  let profitabilityBaseline:
    ReturnType<typeof executableRiskPlanPayoffProfile> | null = null;
  let waveThesis:
    | ReturnType<typeof buildLiquidationWaveThesis>
    | ReturnType<typeof buildThreeMinuteRoundThesis>
    | ReturnType<typeof buildStructureWakeThesis>
    | null = null;
  try {
    const currentExposures = nexusAutomatedStrategyExposures(
      openPositions.map((position) =>
        nexusPositionRiskExposure({
          strategyId: nexusBoundStrategyId({
            positionId: position.id,
            symbol: position.symbol,
            bindings: openPositionTraces,
          }),
          symbol: position.symbol,
          positionSide: position.positionSide,
          quantity: position.quantity,
          entryPrice: position.entryPrice,
          markPrice: position.markPrice,
          leverage: position.leverage,
          riskPlanJson: position.riskPlanJson,
          executedRiskPlanJson: position.executedRiskPlanJson,
          favorablePrice: position.favorablePrice,
          trailingActivationPercent: position.trailingActivationPercent,
          trailingStopPercent: position.trailingStopPercent,
        })
      ).filter((item) => item !== null),
    );
    const currentEquityUsdt = Math.max(
      0,
      fundingSnapshot.marginEquityUsdt ??
        fundingSnapshot.availableToOpenUsdt ??
        0,
    );
    const sizingCapitalUsdt =
      automatedEntryEquitySizingCapitalUsdt(fundingSnapshot);
    const [equityState, reservedExposures] = await Promise.all([
      updateNexusPortfolioEquityPeak({
        ownerEmail: trace.ownerEmail,
        accountId: trace.accountId,
        currentEquityUsdt,
      }),
      readNexusReservedRiskExposures({
        ownerEmail: trace.ownerEmail,
        accountId: trace.accountId,
        excludeTraceId: trace.traceId,
      }),
    ]);
    const portfolioRisk = calculateNexusPortfolioRiskPlan({
      config: config.risk.portfolioRisk,
      strategyId: trace.strategyId,
      accountEquityUsdt: equityState.currentEquityUsdt,
      peakAccountEquityUsdt: equityState.peakAccountEquityUsdt,
      symbol: trace.symbol,
      positionSide: executionDirection.positionSide,
      entryPrice: entryReferencePrice,
      invalidationPrice: executionDirection.inverted
        ? roeStopInvalidationPrice({
            entryPrice: entryReferencePrice,
            positionSide: executionDirection.positionSide,
            stopLossRoePercent: config.risk.stopLossPercent,
            leverage: config.execution.leverage,
          })
        : invalidBoundary,
      fallbackStopRoePercent: config.risk.stopLossPercent,
      leverage: config.execution.leverage,
      roundTripCostRate: 0.001,
      minOrderQty: symbol.minOrderQty,
      quantityStep: symbol.quantityStep,
      minNotionalUsdt: symbol.minNotionalUsdt,
      currentExposures,
      reservedExposures,
      minimumOrderFloorMode:
        config.execution.minimumOrderFloorMode,
      riskClass: explorationAuthorized
          || threeMinuteForceMinimumQuantity
        ? "LEARNING_PROBE"
        : "STANDARD",
    });
    evidence.nexusPortfolioRisk = portfolioRisk;
    evidence.nexusPortfolioRiskAdvisoryOnly = true;
    const quantitySizingDecision = resolveEvidenceQuantityMultiplier({
      mode: postExitReentryMinimumQuantity
        ? "FIXED"
        : config.execution.quantitySizingMode,
      fixedMultiplier: configuredMinimumOrderQuantityMultiplier,
      eyeVerdict: marketEyeDecision.verdict,
      volumeTimingState: asRecord(evidence.nexusVolumeTiming).state,
      executionTimingEligible: entryRevalidation.eligible,
      strongSizingAllowed:
        !explorationAuthorized &&
        !forceExchangeMinimumQuantity &&
        !postExitReentryMinimumQuantity &&
        Number(asRecord(evidence.nexusDirectionDecision)
          .maximumQuantityMultiplier ?? 2) >= 2,
    });
    const directionQuantityCap = Math.max(
      1,
      Math.min(
        2,
        Math.trunc(Number(
          asRecord(evidence.nexusDirectionDecision)
            .maximumQuantityMultiplier ?? 2,
        )),
      ),
    );
    const appliedQuantityMultiplier = Math.min(
      quantitySizingDecision.multiplier,
      directionQuantityCap,
    );
    evidence.nexusQuantitySizingDecision = {
      ...quantitySizingDecision,
      multiplier: appliedQuantityMultiplier,
      directionQuantityCap,
      directionCapped:
        appliedQuantityMultiplier < quantitySizingDecision.multiplier,
    };
    const configuredSizing = capRiskSizedEntryToConfiguredMargin({
      riskSizedQuantity:
        portfolioRisk.status === "SIZED" ? portfolioRisk.quantity : 0,
      entryPrice: entryReferencePrice,
      leverage: config.execution.leverage,
      minOrderQty: symbol.minOrderQty,
      quantityStep: symbol.quantityStep,
      minNotionalUsdt: symbol.minNotionalUsdt,
      targetMarginUsdt: config.execution.targetOrderNotionalUsdt,
      maxOrderMarginUsdt: config.execution.maxOrderNotionalUsdt,
      sizingCapitalUsdt,
      equityAllocationPercent:
        config.execution.equityAllocationPercent ?? 5,
      minimumPositionNotionalUsdt:
        config.execution.minimumPositionNotionalUsdt ?? 15,
      explorationProbe: explorationAuthorized,
      forceExchangeMinimumQuantity,
      marketOrder: entryOrder.orderType === "MARKET",
      minimumOrderQuantityMultiplier: appliedQuantityMultiplier,
    });
    if (!configuredSizing)
      return reject(
        "NEXUS_CONFIGURED_MARGIN_UNEXECUTABLE",
        `按账户保证金权益 ${sizingCapitalUsdt.toFixed(2)} USDT、单笔分配 ${Number(config.execution.equityAllocationPercent ?? 5).toFixed(2)}% 和单笔保证金额度计算后，无法达到策略最低名义价值 ${Number(config.execution.minimumPositionNotionalUsdt ?? 15).toFixed(2)} USDT 与 Binance 规则的较高者`,
        {
          portfolioRisk,
          strategyDailyMargin,
          cumulativeMarginAdvisoryOnly: true,
          configuredDailyMarginReferenceUsdt:
            config.execution.maxDailyNotionalUsdt,
          strategyUnrealizedPnlUsdt,
          dailyMarginActivity,
          accountDailyNotional: dailyNotional,
        },
      );
    evidence.nexusConfiguredSizing = configuredSizing;
    evidence.nexusConfiguredSizingSummary =
      `账户权益 ${configuredSizing.equityAllocationPercent.toFixed(2)}% 定量：名义价值 ${configuredSizing.notionalUsdt.toFixed(2)} USDT，` +
      `${config.execution.leverage}倍杠杆预计保证金 ${configuredSizing.requiredMarginUsdt.toFixed(2)} USDT`;
    const orderCapacity = calculateAutomatedOrderCapacity({
      usedMarginUsdt: strategyDailyMargin,
      limitMarginUsdt: config.execution.maxDailyNotionalUsdt,
      unrealizedPnlUsdt: strategyUnrealizedPnlUsdt,
      requiredMarginUsdt: configuredSizing.requiredMarginUsdt,
      binanceAvailableMarginUsdt: cachedBinanceAvailableBalance,
    });
    evidence.nexusOrderCapacity = orderCapacity;
    if (!orderCapacity.exchangeExecutable)
      return defer(
        "NEXUS_BINANCE_AVAILABLE_MARGIN_WAIT",
        automatedOrderCapacityMessage(orderCapacity),
        {
          orderCapacity,
          accountFundingStatus: fundingSnapshot.status,
          retryWithoutReanalysis: true,
        },
      );
    marginCapacity = calculateStrategyMarginCapacity({
      availableBalance: executionReservationCapacity,
      committedMargin,
      equityCommittedMargin: accountCommittedMargin,
      requiredMargin: configuredSizing.requiredMarginUsdt,
      maxUsagePercent: strategyMarginLimitPercent,
    });
    evidence.nexusMarginCapacity = {
      ...marginCapacity,
      usableBalance: executionReservationCapacity,
      cachedBinanceAvailableBalance,
      accountFundingStatus: fundingSnapshot.status,
      advisoryOnly: true,
      binanceFundingExecutionGate: true,
      explanation:
        `策略今日已开仓保证金 ${dailyMarginActivity.usedMarginUsdt.toFixed(2)} USDT（仅统计，不拒单、不缩量）；` +
        `Binance 已保存可再开仓快照 ${cachedBinanceAvailableBalance.toFixed(2)} USDT（${fundingSnapshot.status}），作为提交前资金硬边界；` +
        "组合、方向和关联占用仅作运营观察，不参与拒单或缩量",
    };
    const brainKey = strategyRecord.brainKey;
    if (!brainKey)
      return reject(
        "NEXUS_BRAIN_IDENTITY_MISSING",
        "执行大脑缺少不可变 brainKey，已阻止创建实盘意图",
      );
    const executionIntentExpiresAt = resolveFrozenExecutionIntentExpiry({
      traceExpiresAt: trace.expiresAt,
      frozenDecision: frozenExecutionDecision,
      analysisValiditySeconds: config.trigger.analysisValiditySeconds,
    });
    const coordinated = await (
      explorationAuthorized
        ? reserveNexusExplorationExecutionIntent
        : reserveNexusExecutionIntent
    )(
        {
          strategyId: trace.strategyId,
          brainKey,
          configVersion: trace.configVersion,
          traceId: `${trace.traceId}:attempt-${entryOrderAttempt}`,
          intentPurpose: "OPEN_POSITION",
          authoritySource: "ENTRY_BRAIN",
          ownerEmail: trace.ownerEmail,
          accountId: trace.accountId,
          symbol: trace.symbol,
          positionSide: executionDirection.positionSide,
          positionMode: credential.positionMode ?? "ONE_WAY",
          orderType: entryOrder.orderType,
          quantity: configuredSizing.quantity,
          limitPrice: entryOrder.price,
          requiredMarginUsdt: configuredSizing.requiredMarginUsdt,
          riskBudgetUsdt:
            portfolioRisk.unitLossAtInvalidationUsdt *
            configuredSizing.quantity,
          riskClass: portfolioRisk.riskClass,
          priority:
            trace.triggerKind === "LIQUIDATION_WINDOW"
              ? trace.liquidationNotional
              : 0,
          observedAt: trace.receivedAt.getTime(),
          expiresAt: executionIntentExpiresAt,
        },
        executionReservationCapacity,
      );
    if (
      !coordinated.decision.executionOwner ||
      coordinated.decision.status !== "RESERVED"
    ) {
      if (
        coordinated.decision.reasonCode ===
        "INSUFFICIENT_AVAILABLE_MARGIN"
      ) {
        const requiredMarginUsdt = configuredSizing.requiredMarginUsdt;
        const coordinatorAvailableMarginUsdt = Math.max(
          coordinated.snapshot.remainingMarginUsdt,
          0,
        );
        const marginShortfallUsdt = Math.max(
          requiredMarginUsdt - coordinatorAvailableMarginUsdt,
          0,
        );
        return defer(
          "PILOT_AVAILABLE_MARGIN_WAIT",
          automatedOrderCapacityMessage(orderCapacity) +
            `；另有未完成执行预留 ${coordinated.snapshot.alreadyReservedMarginUsdt.toFixed(2)} USDT，` +
            `协调器当前可用 ${coordinatorAvailableMarginUsdt.toFixed(2)} USDT、缺口 ${marginShortfallUsdt.toFixed(2)} USDT；` +
            "保留已批准判断至执行窗口到期，释放预留后只复核交易安全条件",
          {
            requiredMarginUsdt,
            availableMarginUsdt: executionReservationCapacity,
            coordinatorAvailableMarginUsdt,
            marginShortfallUsdt,
            orderCapacity,
            coordinatorDecision: coordinated.decision,
          },
        );
      }
      return reject(
        `NEXUS_COORDINATOR:${coordinated.decision.reasonCode}`,
        coordinated.decision.reason,
        { coordinatorDecision: coordinated.decision },
      );
    }
    const explorationAdmission =
      "explorationAdmission" in coordinated
        ? coordinated.explorationAdmission
        : null;
    approvedQuantity = configuredSizing.quantity;
    approvedRequiredMargin = configuredSizing.requiredMarginUsdt;
    executionIntentKey = coordinated.decision.intentKey;
    executableRiskPlan = buildPilotRiskPlan(
      config,
      approvedQuantity,
      symbol.minOrderQty,
      symbol.quantityStep,
      {
        referencePrice: entryReferencePrice,
        minNotionalUsdt: symbol.minNotionalUsdt,
      },
    );
    profitabilityBaseline = executableRiskPlanPayoffProfile({
      totalQuantity: approvedQuantity,
      takeProfits: executableRiskPlan.takeProfits,
      stopLossRoePercent: config.risk.stopLossPercent,
      leverage: config.execution.leverage,
      estimatedRoundTripFeePercent:
        (config.probabilityPolicy?.estimatedRoundTripFeePercent ?? 0.08) +
        adverseFundingCostRate({
          direction: executionDirection.tradeDirection,
          fundingRate: Number(
            asRecord(evidence.nexusFundingContext).fundingRate,
          ),
        }) * 100,
    });
    if (
      config.trigger.kind !== "THREE_MINUTE_PROBABILITY" &&
      !hasCompleteNetProfitPath(profitabilityBaseline)
    )
      return reject(
        "PILOT_EXECUTABLE_PROFIT_PATH_INVALID",
        "策略保证金额度形成的仓位按交易所步长合并后，无法形成完整净获利路径",
        {
          requestedQuantity: approvedQuantity,
          executableRiskPlan,
          profitabilityBaseline,
        },
      );
    evidence.requestedQuantity = approvedQuantity;
    evidence.executableRiskPlan = executableRiskPlan;
    evidence.profitabilityBaseline = profitabilityBaseline;
    waveThesis = config.trigger.kind === "THREE_MINUTE_PROBABILITY"
      ? buildThreeMinuteRoundThesis({
          traceId: trace.traceId,
          symbol: trace.symbol,
          eventTimeMs: trace.eventTime.getTime(),
          direction: executionDirection.tradeDirection,
          probabilityEvidence: asRecord(evidence.threeMinuteProbability),
          entryOrderAnalysis: analyzedEntryOrder,
          eyeDecision: asRecord(evidence.nexusMarketEyeDecision),
          timeExitSeconds:
            config.trigger.threeMinuteProbability?.timeExitSeconds ?? 300,
        })
      : dedicatedMarketStructureStrategy
        ? buildStructureWakeThesis({
            traceId: trace.traceId,
            symbol: trace.symbol,
            eventTimeMs: trace.eventTime.getTime(),
            triggerKind: config.trigger.kind ?? "LIQUIDATION_WINDOW",
            direction: executionDirection.tradeDirection,
            evidence,
            entryOrderAnalysis: analyzedEntryOrder,
            firstTakeProfitRoePercent:
              executableRiskPlan.takeProfits[0]?.triggerPercent ?? null,
            trailingActivationRoePercent:
              config.risk.trailingActivationPercent,
            profitabilityBaseline,
          })
      : buildLiquidationWaveThesis({
          traceId: trace.traceId,
          symbol: trace.symbol,
          eventTimeMs: trace.eventTime.getTime(),
          evidence,
          entryOrderAnalysis: analyzedEntryOrder,
          firstTakeProfitRoePercent:
            executableRiskPlan.takeProfits[0]?.triggerPercent ?? null,
          trailingActivationRoePercent: config.risk.trailingActivationPercent,
          profitabilityBaseline,
          authorizationMode: entryAuthorization.mode,
        });
    evidence.waveThesis = waveThesis;
    if (waveThesis.status !== "CONFIRMED")
      return reject(
        "PILOT_WAVE_THESIS_INCOMPLETE",
        "入场证据未形成完整波段假设，本次禁止提交验证订单",
        { waveThesis },
      );
    evidence.nexusExecutionCoordinator = coordinated?.snapshot ?? null;
    await db
      .update(strategyExecutionTraces)
      .set({
        entryEvidenceJson: JSON.stringify(evidence),
        updatedAt: new Date(),
      })
      .where(eq(strategyExecutionTraces.id, trace.id));
    await appendEvent(trace.traceId, trace.strategyId, {
      eventType:
        `NEXUS_EXECUTION_AUTHORIZED:${coordinated.decision.status}`,
      stage: "ORDER",
      outcome: "INFO",
      message:
        `${explorationAuthorized && explorationAdmission?.ordinal
          ? `第 ${explorationAdmission.ordinal}/${explorationAdmission.targetOrders} 个NEXUS探索探针已取得唯一名额并缩量至`
          : explorationAuthorized
            ? "NEXUS探索探针已按基础可用资金比例和最低名义门槛定量至"
            : "策略可用资金比例、最低名义门槛和保证金额度均已通过，委托数量为"} ${approvedQuantity}：` +
        `${portfolioRisk.reason}；` +
        `${String(evidence.nexusConfiguredSizingSummary)}；` +
        `中央协调器：${coordinated.decision.reason}`,
      detail: {
        portfolioRisk,
        configuredSizing,
        coordinatorDecision: coordinated.decision,
        explorationAdmission,
        shadowOnly: true,
        orderAffecting: false,
      },
      eventAt: new Date(),
    });
  } catch (error) {
    return reject(
      "NEXUS_EXECUTION_GATE_ERROR",
      "策略保证金额度或中央执行协调器校验失败，禁止提交订单",
      { error: error instanceof Error ? error.message : "未知错误" },
    );
  }
  if (
    !executionIntentKey ||
    approvedQuantity <= 0 ||
    !marginCapacity ||
    !executableRiskPlan ||
    !profitabilityBaseline ||
    !waveThesis
  )
    return reject(
      "NEXUS_EXECUTION_OWNER_MISSING",
      "未取得中央执行权或批准数量、风险计划无效",
    );
  await appendEvent(trace.traceId, trace.strategyId, {
    eventType: "WAVE_THESIS_CONFIRMED",
    stage: "ORDER",
    outcome: "PASSED",
    message: config.trigger.kind === "THREE_MINUTE_PROBABILITY"
      ? "3分钟方向概率、费用后净期望、策略保证金数量与180秒退出路径均已固化"
      : "主导波段、策略保证金数量与可执行净获利路径均已固化",
    detail: asRecord(evidence.waveThesis),
    eventAt: new Date(),
  });
  evidence.marginCapacityAtEntry = {
    basis: "ACCOUNT_EQUITY_PERCENT",
    maxUsagePercent: strategyMarginLimitPercent,
    estimatedAccountEquityUsdt:
      marginCapacity.estimatedAccountEquityUsdt,
    committedMarginBeforeOrderUsdt: committedMargin,
    accountCommittedMarginUsdt: accountCommittedMargin,
    requiredMarginUsdt: approvedRequiredMargin,
    projectedMarginUsdt: marginCapacity.projectedMarginUsdt,
    projectedUsagePercent: marginCapacity.projectedMarginUsagePercent,
    binanceAvailableBalanceAtEntryUsdt: cachedBinanceAvailableBalance,
    openPositionCountAtEntry: openPositions.length,
    pendingOrderCountAtEntry: pendingOrders.length,
  };

  const finalSignalAgeMs = Date.now() - trace.eventTime.getTime();
  const frozenDecision = asRecord(evidence.frozenExecutionDecision);
  const frozenExecutionDeadline = isFrozenExecutionApproval(frozenDecision)
    ? resolveFrozenExecutionDeadline({
        frozenDecision,
        analysisValiditySeconds: config.trigger.analysisValiditySeconds,
      })
    : null;
  const executionExpiresAtMs = resolveFrozenExecutionIntentExpiry({
    traceExpiresAt: trace.expiresAt,
    frozenDecision,
    analysisValiditySeconds: config.trigger.analysisValiditySeconds,
  });
  if (
    !Number.isFinite(finalSignalAgeMs) ||
    finalSignalAgeMs < 0 ||
    !Number.isFinite(executionExpiresAtMs) ||
    Date.now() > executionExpiresAtMs
  )
    return reject(
      "PILOT_SIGNAL_EXPIRED_BEFORE_ORDER",
      frozenExecutionDeadline === null
        ? "信号在实盘委托前已超过分析有效期，本次禁止下单"
        : "已获批订单超过独立执行窗口仍未完成，本次禁止继续使用旧判断",
      {
        finalSignalAgeMs,
        executionExpiresAtMs,
        frozenExecutionWindow: frozenExecutionDeadline !== null,
      },
    );

  const finalExecutableReferencePrice = entryReferencePrice;

  const [claimed] = await db
    .update(strategyExecutionTraces)
    .set({ state: "ORDER_READY", updatedAt: new Date() })
    .where(
      and(
        eq(strategyExecutionTraces.id, trace.id),
        inArray(strategyExecutionTraces.state, [
          "ANALYZING",
          "ARMED",
          "ORDER_READY",
        ]),
      ),
    )
    .returning();
  if (!claimed) return;

  const configuredAttempt = entryOrderAttempt;
  const activeClientOrderId = buildAutomatedEntryClientOrderId({
    standardPrefix: "nql",
    inverted: executionDirection.inverted,
    traceRowId: trace.id,
    traceId: trace.traceId,
    attempt: configuredAttempt,
  });
  const createdAt = new Date();
  // The account snapshot used during analysis can be stale after several
  // strategies fill in the same cycle. Refresh only after this trace has
  // won the local execution reservation, immediately before creating an
  // exchange order, so an otherwise certain Binance rejection becomes a
  // normal bounded wait instead.
  let freshMarginSnapshot: Awaited<ReturnType<typeof getBinanceLiveAccountBalance>>;
  try {
    freshMarginSnapshot = await getBinanceLiveAccountBalance(keys);
  } catch (error) {
    const refreshMessage = error instanceof Error
      ? error.message
      : "Binance 可用保证金刷新失败";
    try {
      await advanceNexusExecutionIntent({
        intentKey: executionIntentKey,
        nextStatus: "REJECTED",
        reasonCode: "PRE_SUBMISSION_MARGIN_REFRESH_FAILED",
        reasonMessage: "交易所可用保证金刷新失败，未创建委托",
        detail: { refreshMessage },
      });
      executionIntentKey = null;
    } catch {
      // The pre-submission reservation can be reconciled by its normal path.
      // A refresh failure must never cause a blind order submission.
    }
    return defer(
      "NEXUS_BINANCE_AVAILABLE_MARGIN_REFRESH_WAIT",
      "已获批判断在委托前无法刷新 Binance 可用保证金，未提交订单，等待下一轮重新核验",
      { refreshMessage, retryWithoutReanalysis: true },
    );
  }
  const freshAvailableMarginUsdt = Number.isFinite(
    freshMarginSnapshot.availableBalance,
  )
    ? Math.max(freshMarginSnapshot.availableBalance, 0)
    : 0;
  const freshOrderCapacity = calculateAutomatedOrderCapacity({
    usedMarginUsdt: strategyDailyMargin,
    limitMarginUsdt: config.execution.maxDailyNotionalUsdt,
    unrealizedPnlUsdt: strategyUnrealizedPnlUsdt,
    requiredMarginUsdt: approvedRequiredMargin,
    binanceAvailableMarginUsdt: freshAvailableMarginUsdt,
  });
  evidence.nexusPreSubmissionMarginRefresh = {
    availableMarginUsdt: freshAvailableMarginUsdt,
    requiredMarginUsdt: approvedRequiredMargin,
    latencyMs: freshMarginSnapshot.latencyMs,
    usedWeight: freshMarginSnapshot.usedWeight,
    canSubmit: freshOrderCapacity.canSubmit,
    staleSnapshotAvailableMarginUsdt: cachedBinanceAvailableBalance,
  };
  if (!freshOrderCapacity.exchangeExecutable) {
    try {
      await advanceNexusExecutionIntent({
        intentKey: executionIntentKey,
        nextStatus: "REJECTED",
        reasonCode: "PRE_SUBMISSION_MARGIN_INSUFFICIENT",
        reasonMessage: "Binance 最新可用保证金不足，未创建委托",
        detail: evidence.nexusPreSubmissionMarginRefresh,
      });
      executionIntentKey = null;
    } catch {
      // Do not submit after a fresh Binance margin shortfall even if a
      // concurrent transition prevents local release in this attempt.
    }
    return defer(
      "NEXUS_BINANCE_AVAILABLE_MARGIN_WAIT",
      automatedOrderCapacityMessage(
        freshOrderCapacity,
        "大脑判断已经通过，但委托前余额已被其他成交占用",
      ),
      {
        orderCapacity: freshOrderCapacity,
        preSubmissionRefresh: evidence.nexusPreSubmissionMarginRefresh,
        retryWithoutReanalysis: true,
      },
    );
  }
  const entryDecisionHandoffJson = JSON.stringify(buildEntryDecisionHandoff({
    traceId: trace.traceId,
    strategyId: trace.strategyId,
    configVersion: trace.configVersion,
    positionSide: executionDirection.positionSide,
    decisionAt: createdAt,
    executionIntentId: executionIntentKey,
    resultCode: trace.resultCode,
    resultMessage: trace.resultMessage,
    entryEvidence: evidence,
  }));
  const inverseExecutionObservation = buildInverseExecutionObservation({
    direction: executionDirection,
    frozenDecision: evidence.frozenExecutionDecision,
    executionStartedAt: executionAttemptStartedAt,
    orderCreatedAt: createdAt,
    approvalPrice: evidence.executionApprovedMarkPrice,
    executionPrice: finalExecutableReferencePrice,
  });
  if (inverseExecutionObservation)
    evidence.inverseExecutionObservation = inverseExecutionObservation;
  const { order: orderEvent } = await createAutomatedEntryOrder({
    ownerEmail: trace.ownerEmail,
    accountId: trace.accountId,
    credentialId: credential.id,
    clientOrderId: activeClientOrderId,
    symbol: trace.symbol,
    side: executionDirection.side,
    positionSide: executionDirection.positionSide,
    orderType: entryOrder.orderType,
    quantity: approvedQuantity,
    referencePrice: entryOrder.price ?? finalExecutableReferencePrice,
    responseJson: JSON.stringify({
      requestedLeverage: config.execution.leverage,
      inverseExecutionObservation:
        evidence.inverseExecutionObservation ?? null,
    }),
    lifecycleId: trace.traceId,
    entryDecisionHandoffJson,
    createdAt,
  });
  if (inverseExecutionObservation) {
    await db
      .update(strategyExecutionTraces)
      .set({
        entryEvidenceJson: JSON.stringify(evidence),
        updatedAt: createdAt,
      })
      .where(eq(strategyExecutionTraces.id, trace.id));
  }
  await observeExecutionQuote({
    recordKey: `ENTRY:${orderEvent.id}`,
    quoteRole: "ENTRY",
    liveOrderEventId: orderEvent.id,
    clientOrderId: activeClientOrderId,
    ownerEmail: trace.ownerEmail,
    accountId: trace.accountId,
    strategyId: trace.strategyId,
    traceId: trace.traceId,
    origin: "STRATEGY_LONG",
    symbol: trace.symbol,
    side: executionDirection.side,
    positionSide: executionDirection.positionSide,
    actualOrderType: entryOrder.orderType,
    actualRequestedPrice: entryOrder.price ?? finalExecutableReferencePrice,
    decisionMarkPrice: executionMarkPrice,
    executableReferencePrice: finalExecutableReferencePrice,
    priceTickSize: symbol.priceTickSize,
    atr5m,
    tradeIntensityRatio:
      Number(asRecord(evidence.nexusVolumeTiming).currentExecutionVolumeRatio) || 1,
    bestBidQuantity: entryBookDepth?.bidQuantity ?? null,
    bestAskQuantity: entryBookDepth?.askQuantity ?? null,
    prospectiveNotionalUsdt: approvedQuantity * finalExecutableReferencePrice,
    entryExecutionShadow,
  });
  let acknowledgedOrder: {
    exchangeOrderId: string | null;
    executedQuantity: number;
    response: Record<string, unknown>;
  } | null = null;
  const effectiveEntryOrderTtlMs = effectiveStrategyEntryOrderTtlMs({
    config,
    exchangeOrderType: entryOrder.orderType,
  });
  try {
    await advanceNexusExecutionIntent({
      intentKey: executionIntentKey,
      nextStatus: "SUBMITTING",
      expiresAtMs: nexusExecutionIntentSettlementDeadline({
        orderCreatedAtMs: createdAt.getTime(),
        orderTtlSeconds: config.execution.orderTtlSeconds,
        orderTtlMs: effectiveEntryOrderTtlMs,
        analysisExpiresAtMs: executionExpiresAtMs,
      }),
      detail: {
        clientOrderId: activeClientOrderId,
        liveOrderEventId: orderEvent.id,
        inverseExecutionObservation,
      },
    });
    const result = await submitLiveEntryOrder(keys, {
      symbol: trace.symbol,
      side: executionDirection.side,
      positionSide: executionDirection.positionSide,
      quantity: approvedQuantity,
      clientOrderId: activeClientOrderId,
      leverage: config.execution.leverage,
      positionMode: credential.positionMode,
      orderType: entryOrder.orderType,
      price: entryOrder.price,
      timeInForce: entryOrder.orderType === "LIMIT" ? "GTC" : undefined,
      requireExactLeverage: true,
    });
    const response = result.data;
    const acknowledgement = readAutomatedEntryAcknowledgement({
      response,
      orderType: entryOrder.orderType,
      fallbackEntryPrice: finalExecutableReferencePrice,
      confirmedLeverage: result.timing.confirmedLeverage,
      requestedLeverage: result.timing.requestedLeverage,
    });
    const executedQuantity = acknowledgement.executedQuantity;
    acknowledgedOrder = {
      exchangeOrderId: acknowledgement.exchangeOrderId,
      executedQuantity,
      response: acknowledgement.response,
    };
    if (acknowledgement.pendingLimit) {
      const pendingRiskPlan = buildPilotRiskPlan(
        config,
        approvedQuantity,
        symbol.minOrderQty,
        symbol.quantityStep,
        {
          referencePrice: finalExecutableReferencePrice,
          minNotionalUsdt: symbol.minNotionalUsdt,
        },
      );
      const pendingStrategyRiskPlan = {
        ...pendingRiskPlan,
        orderOrigin: "STRATEGY" as const,
        riskClass: resolveNexusEntryAuthorization(evidence, {
          allowLegacy: true,
        }).explorationProbe
          ? "LEARNING_PROBE" as const
          : "STANDARD" as const,
        strategyId: trace.strategyId,
        strategyConfigVersion: trace.configVersion,
        traceId: trace.traceId,
        ...threeMinutePositionPlanMetadata(config, evidence),
      };
      const pendingResponseJson = JSON.stringify({
        ...response,
        timeInForce: "GTC",
        strategyOrderQuantity: approvedQuantity,
        confirmedLeverage: result.timing.confirmedLeverage,
        requestedLeverage: result.timing.requestedLeverage,
        strategyPendingEntry: {
          orderOrigin: "STRATEGY",
          leverage: result.timing.confirmedLeverage,
          riskPlan: pendingStrategyRiskPlan,
          trailingActivationPercent: config.risk.trailingActivationPercent,
          trailingStopPercent:
            (config.risk.dynamicTrailingEnabled ?? true)
              ? config.risk.trailingDrawdownPercent
              : 0,
        },
        entryAnalysis: entryOrder.analysis,
        effectiveOrderTtlMs: effectiveEntryOrderTtlMs,
        expiresAt: new Date(effectiveNexusOrderDeadline({
          orderCreatedAtMs: createdAt.getTime(),
          orderTtlSeconds: config.execution.orderTtlSeconds,
          orderTtlMs: effectiveEntryOrderTtlMs,
          analysisExpiresAtMs: executionExpiresAtMs,
        })).toISOString(),
      });
      await synchronizeReservedNexusOrder({
        intentKey: executionIntentKey,
        liveOrderEventId: orderEvent.id,
        nextStatus: "SUBMITTED",
        liveOrderStatus: "PENDING",
        exchangeOrderId: String(response.orderId),
        responseJson: pendingResponseJson,
        detail: {
          liveOrderEventId: orderEvent.id,
          clientOrderId: activeClientOrderId,
          exchangeOrderId: response.orderId,
          executedQuantity: 0,
        },
        reasonCode: "ACKNOWLEDGED_LIMIT_PENDING",
        reasonMessage: "交易所已接受限价单，等待正常订单核对",
        traceSettlement: {
          databaseId: trace.id,
          expectedStates: ["ORDER_READY", "ORDER_PENDING"],
          state: "ORDER_PENDING",
          resultCode: "ANALYZED_LIMIT_PENDING",
          resultMessage: "分析承接价限价已挂出，等待成交或结构失效撤单",
          entryEvidenceJson: JSON.stringify({
            ...evidence,
            entryOrderAttempt: configuredAttempt,
            pendingEntryOwner: "LIQUIDATION_TREND",
          }),
          exchangeOrderId: String(response.orderId),
          completedAt: null,
        },
      });
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: `ANALYZED_LIMIT_PENDING:${configuredAttempt}`,
        stage: "ORDER",
        outcome: "PENDING",
        message: "分析限价已进入订单簿；到期、继续破位或成交时由系统接管",
        detail: {
          clientOrderId: activeClientOrderId,
          exchangeOrderId: response.orderId,
          quantity: approvedQuantity,
          limitPrice: entryOrder.price,
          orderTtlSeconds: config.execution.orderTtlSeconds,
          entryOrderAttempt: configuredAttempt,
          entryAnalysis: entryOrder.analysis,
          effectiveOrderTtlMs: effectiveEntryOrderTtlMs,
          automaticMarketFallback: false,
        },
        eventAt: new Date(),
      });
      return;
    }
    if (!acknowledgement.hasExecutedQuantity)
      throw new BinanceLiveError(
        "Binance 返回的委托未包含有效成交数量",
        502,
        undefined,
        true,
      );
    const effectiveEntryPrice = acknowledgement.effectiveEntryPrice;
    await finalizeFilledEntry({
      trace,
      config,
      credential,
      symbol,
      orderEvent,
      evidence,
      exchangeOrderId: String(response.orderId),
      executedQuantity,
      entryPrice: effectiveEntryPrice,
      leverage: result.timing.confirmedLeverage,
      response: {
        ...response,
        confirmedLeverage: result.timing.confirmedLeverage,
        requestedLeverage: result.timing.requestedLeverage,
      },
      openedAt: resolvedExchangeFillTime(
        response,
        createdAt.getTime(),
      ),
      executionLatencyMs: result.timing.totalMs,
      fillMode: orderEvent.orderType === "LIMIT"
        ? "ANALYZED_LIMIT"
        : "CONFIRMED_MARKET",
      positionSide: executionDirection.positionSide,
      executionIntentSettlement: {
        intentKey: executionIntentKey,
        clientOrderId: activeClientOrderId,
      },
    });
  } catch (error) {
    if (acknowledgedOrder) {
      const recovery = await recoverAcknowledgedAutomatedEntry({
        intentKey: executionIntentKey,
        liveOrderEventId: orderEvent.id,
        clientOrderId: activeClientOrderId,
        exchangeOrderId: acknowledgedOrder.exchangeOrderId,
        executedQuantity: acknowledgedOrder.executedQuantity,
        response: acknowledgedOrder.response,
        orderType: orderEvent.orderType,
        traceDatabaseId: trace.id,
      });
      try {
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: recovery.resultCode,
          stage: "ORDER",
          outcome: recovery.position && recovery.hasFill ? "PASSED" : "PENDING",
          message: recovery.resultMessage,
          detail: {
            liveOrderEventId: orderEvent.id,
            exchangeOrderId: acknowledgedOrder.exchangeOrderId,
            executedQuantity: acknowledgedOrder.executedQuantity,
            positionId: recovery.position?.id ?? null,
          },
          eventAt: new Date(),
        });
      } catch {
        // Recovery observability is best effort and never changes order truth.
      }
      return;
    }
    const unknown = error instanceof BinanceLiveError && error.executionUnknown;
    const message = error instanceof Error ? error.message : "首轮实盘订单提交失败";
    if (unknown) {
      const observedAt = new Date();
      await recordUncertainAutomatedEntry({
        intentKey: executionIntentKey,
        liveOrderEventId: orderEvent.id,
        clientOrderId: activeClientOrderId,
        traceDatabaseId: trace.id,
        resultCode: "PILOT_EXECUTION_UNKNOWN",
        resultMessage: message,
      });
      try {
        await appendEvent(trace.traceId, trace.strategyId, {
          eventType: "PILOT_EXECUTION_UNKNOWN",
          stage: "ORDER",
          outcome: "ERROR",
          message,
          detail: {
            clientOrderId: activeClientOrderId,
            noAutomaticRetry: true,
            configuredSecondOrder: config.execution.allowSecondOrder,
          },
          eventAt: observedAt,
        });
      } catch {
        // 未知执行审计为尽力写入，不改变核对状态。
      }
      return;
    }

    const rejectedAt = new Date();
    await settleRejectedAutomatedEntry({
      intentKey: executionIntentKey,
      liveOrderEventId: orderEvent.id,
      clientOrderId: activeClientOrderId,
      errorMessage: message,
      traceDatabaseId: trace.id,
      traceResultCode: "PILOT_ORDER_REJECTED",
      rejectedAt,
    });
    try {
      await appendEvent(trace.traceId, trace.strategyId, {
        eventType: "PILOT_ORDER_REJECTED",
        stage: "ORDER",
        outcome: "ERROR",
        message,
        detail: {
          clientOrderId: activeClientOrderId,
          noAutomaticRetry: true,
          configuredSecondOrder: config.execution.allowSecondOrder,
        },
        eventAt: rejectedAt,
      });
    } catch {
      // 明确拒单已经原子收口，审计写入失败不能复活订单。
    }
  }
}

function threeMinutePositionPlanMetadata(
  config: LiquidationTrendConfig,
  evidence: Record<string, unknown>,
) {
  if (config.trigger.kind !== "THREE_MINUTE_PROBABILITY") return {};
  const probability = asRecord(evidence.threeMinuteProbability);
  return {
    threeMinuteRound: {
      version: "three-minute-position-plan-v1",
      roundId: String(evidence.roundId ?? probability.roundId ?? ""),
      roundStartedAt: Number(
        evidence.roundStartedAt ?? probability.roundStartedAt,
      ) || null,
      roundEndsAt: Number(evidence.roundEndsAt ?? probability.roundEndsAt) || null,
      modelVersion: String(evidence.modelVersion ?? probability.modelVersion ?? ""),
      factSnapshotId: String(
        probability.factSnapshotId ??
          asRecord(evidence.triggerIdentity).factSnapshotId ??
          "",
      ),
      timeExitSeconds:
        config.trigger.threeMinuteProbability?.timeExitSeconds ?? 300,
      earlyStopEnabled:
        config.trigger.threeMinuteProbability?.earlyStopEnabled === true,
      earlyTakeProfitEnabled:
        config.trigger.threeMinuteProbability?.earlyTakeProfitEnabled === true,
      profitCaptureNetRoePercent:
        config.trigger.threeMinuteProbability?.profitCaptureNetRoePercent ?? 4,
      estimatedRoundTripCostBps:
        (config.trigger.threeMinuteProbability?.estimatedRoundTripFeeBps ?? 8) +
        (config.trigger.threeMinuteProbability?.estimatedSlippageBps ?? 5),
      dynamicProtection: {
        version: "three-minute-dynamic-protection-v1",
        profitMonitoringStartsAboveRoePercent:
          THREE_MINUTE_PROFIT_MONITOR_ROE_PERCENT,
        lockedProfitFloorRoePercent:
          THREE_MINUTE_PROFIT_FLOOR_ROE_PERCENT,
        profitExitRoePercent: THREE_MINUTE_PROFIT_EXIT_ROE_PERCENT,
        lockedLossFloorRoePercent:
          THREE_MINUTE_LOSS_FLOOR_ROE_PERCENT,
        hardStopRoePercent: THREE_MINUTE_HARD_STOP_ROE_PERCENT,
        priority: "BEFORE_TIME_EXIT",
      },
    },
  };
}
async function finalizeFilledEntry(input: {
  trace: typeof strategyExecutionTraces.$inferSelect;
  config: LiquidationTrendConfig;
  credential: typeof exchangeCredentials.$inferSelect;
  symbol: typeof contractSymbols.$inferSelect;
  orderEvent: typeof liveOrderEvents.$inferSelect;
  evidence: Record<string, unknown>;
  positionSide: "LONG" | "SHORT";
  exchangeOrderId: string;
  executedQuantity: number;
  entryPrice: number;
  leverage: number;
  response: unknown;
  openedAt: Date;
  executionLatencyMs: number;
  fillMode:
    | "CONFIRMED_MARKET"
    | "ANALYZED_LIMIT"
    | "ANALYZED_LIMIT_PARTIAL";
  executionIntentSettlement: {
    intentKey?: string;
    traceId?: string;
    clientOrderId?: string;
    nextStatus?: "FILLED" | "CANCELED";
    liveOrderStatus?: "FILLED" | "CANCELED";
    detail?: Record<string, unknown>;
  };
}) {
  const db = getDb();
  const positionSide = input.positionSide;
  const executionDirection = asRecord(input.evidence.executionDirection);
  const inverseExecution = executionDirection.inverted === true;
  const riskPlan = buildPilotRiskPlan(
    input.config,
    input.executedQuantity,
    input.symbol.minOrderQty,
    input.symbol.quantityStep,
    {
      referencePrice: input.entryPrice,
      minNotionalUsdt: input.symbol.minNotionalUsdt,
    },
  );
  const strategyRiskPlan = {
    ...riskPlan,
    orderOrigin: "STRATEGY" as const,
    riskClass: resolveNexusEntryAuthorization(input.evidence, {
      allowLegacy: true,
    })
        .explorationProbe
      ? "LEARNING_PROBE" as const
      : "STANDARD" as const,
    strategyId: input.trace.strategyId,
    strategyConfigVersion: input.trace.configVersion,
    traceId: input.trace.traceId,
    ...threeMinutePositionPlanMetadata(input.config, input.evidence),
    structureInvalidationPrice: inverseExecution
      ? roeStopInvalidationPrice({
          entryPrice: input.entryPrice,
          positionSide,
          stopLossRoePercent: input.config.risk.stopLossPercent,
          leverage: input.leverage,
        })
      : Number(asRecord(input.evidence.entryAnchorResolution).invalidBoundary),
  };
  const contrarianProbe = asRecord(input.evidence.contrarianProbe);
  const contrarianProtectionRoe = Number(
    contrarianProbe.profitRoeBeforeHedge,
  );
  const effectiveTrailingActivationPercent =
    contrarianProbe.version === 2 &&
      Number.isFinite(contrarianProtectionRoe) &&
      contrarianProtectionRoe > 0
      ? Math.min(
          input.config.risk.trailingActivationPercent,
          contrarianProtectionRoe,
        )
      : input.config.risk.trailingActivationPercent;
  const filledResponse = filledPendingOrderResponse(
    input.orderEvent,
    input.response,
    input.config.execution.leverage,
  );
  const existing = await db
    .select()
    .from(livePositions)
    .where(eq(livePositions.sourceEventId, input.orderEvent.id))
    .limit(1)
    .then((rows) => rows[0]);
  const positionLifecycleLink = resolveFilledPositionLifecycleLink({
    traceId: input.trace.traceId,
    orderLifecycleId: input.orderEvent.lifecycleId,
    orderEntryDecisionHandoffJson:
      input.orderEvent.entryDecisionHandoffJson,
    existingPositionLifecycleId: existing?.lifecycleId,
    existingPositionEntryDecisionHandoffJson:
      existing?.entryDecisionHandoffJson,
  });
  const positionPersistedAt = new Date();
  const positionProtection = buildFilledPositionProtection({
    plan: strategyRiskPlan,
    activatedAt: existing ? positionPersistedAt : input.openedAt,
    trailingActivationPercent: effectiveTrailingActivationPercent,
    trailingStopPercent:
      (input.config.risk.dynamicTrailingEnabled ?? true)
        ? input.config.risk.trailingDrawdownPercent
        : 0,
  });
  const positionValues = buildFilledPositionInsertValues({
    ownerEmail: input.trace.ownerEmail,
    accountId: input.trace.accountId,
    credentialId: input.credential.id,
    sourceEventId: input.orderEvent.id,
    handoffOrigin: "STRATEGY",
    lifecycleId: positionLifecycleLink.lifecycleId,
    entryDecisionHandoffJson:
      positionLifecycleLink.entryDecisionHandoffJson,
    symbol: input.trace.symbol,
    instrumentId: input.symbol.instrumentId,
    instrumentRuleVersion: input.symbol.ruleVersion,
    positionSide: input.positionSide,
    quantity: input.executedQuantity,
    entryPrice: input.entryPrice,
    leverage: input.leverage,
    protection: positionProtection,
    openedAt: input.openedAt,
    updatedAt: positionPersistedAt,
  });
  const persistedPosition = await persistFilledAutomatedPosition({
    insertValues: positionValues,
    recoveryValues: buildFilledPositionRecoveryValues({
      lifecycleId: positionLifecycleLink.lifecycleId,
      entryDecisionHandoffJson:
        positionLifecycleLink.entryDecisionHandoffJson,
      positionHandoffKey: positionValues.positionHandoffKey,
      positionHandoffVersion: positionValues.positionHandoffVersion,
      positionHandoffJson: positionValues.positionHandoffJson,
      leverage: input.leverage,
      protection: positionProtection,
      updatedAt: positionPersistedAt,
    }),
  });
  const position = persistedPosition.position;
  const settlePositionLedger = async (settlement: {
    positionId: number;
    resultCode: string;
    resultMessage: string;
    entryEvidenceJson?: string;
  }) => {
    const intentDetail = input.executionIntentSettlement.clientOrderId
      ? buildFilledExecutionIntentDetail({
          clientOrderId: input.executionIntentSettlement.clientOrderId,
          exchangeOrderId: input.exchangeOrderId,
          executedQuantity: input.executedQuantity,
          positionId: settlement.positionId,
        })
      : {
          exchangeOrderId: input.exchangeOrderId,
          executedQuantity: input.executedQuantity,
          positionId: settlement.positionId,
        };
    await settleNexusExecutionIntentWithLiveOrder({
      intentKey: input.executionIntentSettlement.intentKey,
      traceId: input.executionIntentSettlement.traceId,
      liveOrderEventId: input.orderEvent.id,
      nextStatus: input.executionIntentSettlement.nextStatus ?? "FILLED",
      liveOrderStatus: input.executionIntentSettlement.liveOrderStatus,
      exchangeOrderId: input.exchangeOrderId,
      responseJson: JSON.stringify(filledResponse),
      livePositionId: settlement.positionId,
      filledQuantity: input.executedQuantity,
      detail: {
        ...intentDetail,
        ...(input.executionIntentSettlement.detail ?? {}),
      },
      traceSettlement: {
        databaseId: input.trace.id,
        state: "POSITION_OPEN",
        resultCode: settlement.resultCode,
        resultMessage: settlement.resultMessage,
        ...(settlement.entryEvidenceJson !== undefined
          ? { entryEvidenceJson: settlement.entryEvidenceJson }
          : {}),
        exchangeOrderId: input.exchangeOrderId,
        positionId: String(settlement.positionId),
        completedAt: null,
      },
    });
  };
  if (persistedPosition.recovered) {
    await settlePositionLedger({
      positionId: position.id,
      resultCode: "CONFIRMED_FILL_EXISTING_POSITION_RECOVERED",
      resultMessage:
        "真实仓位已存在，订单与策略轨迹已按成交事实恢复",
    });
    try {
      await appendEvent(input.trace.traceId, input.trace.strategyId, {
        eventType: "CONFIRMED_FILL_EXISTING_POSITION_RECOVERED",
        stage: "ORDER",
        outcome: "PASSED",
        message:
          "检测到同一成交订单的真实仓位已存在，已恢复订单与学习轨迹绑定",
        detail: {
          liveOrderEventId: input.orderEvent.id,
          exchangeOrderId: input.exchangeOrderId,
          positionId: position.id,
          strategyOrderQuantity: input.orderEvent.quantity,
          executedQuantity: input.executedQuantity,
          leverage: input.leverage,
        },
        eventAt: new Date(),
      });
    } catch {
      // The recovered order, position and trace binding is authoritative.
    }
    return position;
  }
  const filledProfitabilityBaseline = executableRiskPlanPayoffProfile({
    totalQuantity: input.executedQuantity,
    takeProfits: riskPlan.takeProfits,
    stopLossRoePercent: input.config.risk.stopLossPercent,
    leverage: input.leverage,
    estimatedRoundTripFeePercent:
      (input.config.probabilityPolicy?.estimatedRoundTripFeePercent ?? 0.08) +
      adverseFundingCostRate({
        direction: input.positionSide,
        fundingRate: Number(
          asRecord(input.evidence.nexusFundingContext).fundingRate,
        ),
      }) * 100,
  });
  const filledProfitPathValid =
    input.config.trigger.kind === "THREE_MINUTE_PROBABILITY" ||
    hasCompleteNetProfitPath(filledProfitabilityBaseline);
  const filledEvidence: Record<string, unknown> = {
    ...input.evidence,
    preOrderProfitabilityBaseline: input.evidence.profitabilityBaseline ?? null,
    executableRiskPlan: riskPlan,
    profitabilityBaseline: filledProfitabilityBaseline,
    filledProfitPathValid,
    effectivePositionProtection: {
      trailingActivationRoePercent: effectiveTrailingActivationPercent,
      trailingDrawdownRoePercent: input.config.risk.trailingDrawdownPercent,
      contrarianProbe: contrarianProbe.version === 2,
      automaticOppositeHedgeAllowed: false,
    },
  };
  const traceResultCode = contrarianProbe.version === 2
    ? "CONTRARIAN_PROBE_POSITION_OPEN"
    : inverseExecution
      ? "INVERSE_STRATEGY_POSITION_OPEN"
      : "PILOT_POSITION_OPEN";
  const traceResultMessage = filledProfitPathValid
    ? contrarianProbe.version === 2
      ? "反向探针已成交；达到保护阈值后收紧利润保护，不自动建立相反仓位"
      : inverseExecution
        ? `大脑判断${executionDirection.brainDirection === "LONG" ? "做多" : "做空"}，反人性策略已反向开${positionSide === "LONG" ? "多" : "空"}并进入原有内部风控`
      : input.config.trigger.kind === "THREE_MINUTE_PROBABILITY"
        ? "3分钟概率轮次仓位已成交，180秒计时从真实成交开始"
        : "分析判断对应的实盘仓位已成交并进入内部风控"
    : "部分成交后的实际止盈网格偏离下单前净获利路径，仓位已交由内部风控并记录异常";
  await settlePositionLedger({
    positionId: position.id,
    resultCode: traceResultCode,
    resultMessage: traceResultMessage,
    entryEvidenceJson: JSON.stringify(filledEvidence),
  });
  await appendEvent(input.trace.traceId, input.trace.strategyId, {
    eventType: inverseExecution
      ? "INVERSE_STRATEGY_POSITION_OPEN"
      : contrarianProbe.version === 2
        ? "CONTRARIAN_PROBE_POSITION_OPEN"
      : "PILOT_POSITION_OPEN",
    stage: "ORDER",
    outcome: "PASSED",
    message: `${inverseExecution ? "反人性反向市价" : contrarianProbe.version === 2 ? "反向探针" : input.fillMode === "CONFIRMED_MARKET" ? "确认后市价" : "分析承接限价"}成交，开始独立验证并由原有 ROE 风控管理`,
    detail: {
      accountId: input.trace.accountId,
      symbol: input.trace.symbol,
      positionSide,
      quantity: input.executedQuantity,
      entryPrice: input.entryPrice,
      notional: input.executedQuantity * input.entryPrice,
      leverage: input.leverage,
      exchangeOrderId: input.exchangeOrderId,
      executionLatencyMs: input.executionLatencyMs,
      entryMode: input.fillMode,
      entryAnalysis: input.evidence.analyzedEntryOrder ?? null,
      positionOpenedAt: input.openedAt.toISOString(),
      positionOpenedAtBasis: "BINANCE_ORDER_UPDATE_TIME_WITH_LOCAL_FALLBACK",
      effectiveStopLossRoePercent: input.config.risk.stopLossPercent,
      effectiveTrailingActivationRoePercent:
        effectiveTrailingActivationPercent,
      effectiveTrailingDrawdownRoePercent:
        input.config.risk.trailingDrawdownPercent,
      configuredOrderMode:
        asRecord(input.evidence.analyzedEntryOrder).requestedMode ?? null,
      selectedOrderType:
        asRecord(input.evidence.analyzedEntryOrder).selectedOrderType ?? null,
      entryOrderAttempt:
        Math.max(
          1,
          Math.min(
            2,
            Math.trunc(Number(input.evidence.entryOrderAttempt) || 1),
          ),
        ),
      fillCompletion:
        input.fillMode === "ANALYZED_LIMIT_PARTIAL" ? "PARTIAL" : "FULL",
      executableRiskPlan: riskPlan,
      filledProfitabilityBaseline,
      filledProfitPathValid,
    },
    eventAt: new Date(),
  });
  const explorationOrderFirstBaseline =
    hasExplorationOrderFirstPolicy(filledEvidence);
  try {
      const captureStartedAtMs = Date.now();
      const [marketResult, largeTraderResult, markPositionResult] =
        await Promise.allSettled([
        getBinanceLiveContractUniverse(),
        readLargeTraderPositioning(input.trace, input.config),
        nexusUnifiedMarketData
          .closedCandles({
            symbol: input.trace.symbol,
            interval: "1h",
            source: "MARK_PRICE",
            limit: 73,
          })
          .then((snapshot) => snapshot.rows),
      ]);
      const marketRegime = marketResult.status === "fulfilled"
        ? analyzePostEntryMarketRegime({
            rows: marketResult.value,
            positionSide,
          })
        : unavailablePostEntryMarketRegime(
            positionSide,
            marketResult.reason instanceof Error
              ? marketResult.reason.message
              : "成交后统一行情基线暂不可用",
          );
      const largeTraderPositioning = largeTraderResult.status === "fulfilled"
        ? largeTraderResult.value
        : analyzeLargeTraderLongPositioning(
            {
              symbol: input.trace.symbol,
              observedAt: Date.now(),
              openInterestValue: [],
              topPositionLongShortRatio: [],
              topAccountLongShortRatio: [],
              takerBuySellRatio: [],
            },
            input.config.largeTrader,
          );
      const entryMarkPosition =
        markPositionResult.status === "fulfilled"
          ? analyzeMarkPricePosition(
              Number(
                asRecord(
                  filledEvidence.explorationPreEntryObservation,
                ).executionMarkPrice,
              ) || input.entryPrice,
              markPositionResult.value,
            )
          : null;
      if (entryMarkPosition?.hours72Complete)
        Object.assign(filledEvidence, entryMarkPosition, {
          entryMarkPositionSource:
            "POST_FILL_MARK_PRICE_1H_CANDLES",
          entryMarkPositionCapturedAt: new Date().toISOString(),
        });
      const entryObservationBaseline = buildPostFillObservationBaseline({
        positionOpenedAtMs: input.openedAt.getTime(),
        captureStartedAtMs,
        captureCompletedAtMs: Date.now(),
        marketRegime: asRecord(marketRegime),
        largeTraderPositioning: asRecord(largeTraderPositioning),
      });
      filledEvidence.entryObservationBaseline = entryObservationBaseline;
      await db
        .update(strategyExecutionTraces)
        .set({
          entryEvidenceJson: JSON.stringify(filledEvidence),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(strategyExecutionTraces.id, input.trace.id),
            eq(strategyExecutionTraces.state, "POSITION_OPEN"),
          ),
        );
      await appendEvent(input.trace.traceId, input.trace.strategyId, {
        eventType: `POST_FILL_BASELINE:${entryObservationBaseline.completeness}`,
        stage: "POSITION_MANAGEMENT",
        outcome: entryObservationBaseline.completeness === "COMPLETE"
          ? "PASSED"
          : "INFO",
        message: entryObservationBaseline.completeness === "COMPLETE"
          ? `${explorationOrderFirstBaseline ? "探索单" : "策略单"}成交后大盘与大户基线已记录，用于5/30/60分钟因果对比`
          : `${explorationOrderFirstBaseline ? "探索单" : "策略单"}已成交并由风控接管；观察基线部分缺失，后续样本将明确标记缺失维度`,
        detail: {
          ...entryObservationBaseline,
          dataSourceCost: {
            marketRegime: "CENTRAL_WEBSOCKET_ZERO_REST_WEIGHT",
            largeTraderPositioning:
              "FOUR_FUTURES_DATA_REQUESTS_WITH_5M_CACHE_AND_800_REQUEST_GUARD",
            entryMarkPosition:
              "ONE_MARK_PRICE_KLINE_REQUEST_PER_CONFIRMED_FILL",
          },
          entryMarkPosition,
          orderSubmissionBlocked: false,
          explorationOrderFirst: explorationOrderFirstBaseline,
        },
        eventAt: new Date(),
      });
  } catch (error) {
    try {
      await appendEvent(input.trace.traceId, input.trace.strategyId, {
        eventType: "POST_FILL_BASELINE:FAILED",
        stage: "POSITION_MANAGEMENT",
        outcome: "INFO",
        message:
          "策略单已成交并由风控接管；成交后观察基线采集失败，不影响仓位与后续样本",
        detail: {
          error: error instanceof Error ? error.message : "观察基线采集失败",
          orderSubmissionBlocked: false,
          positionManagementBlocked: false,
          explorationOrderFirst: explorationOrderFirstBaseline,
        },
        eventAt: new Date(),
      });
    } catch {
      // A best-effort learning write must never turn a confirmed fill into
      // an order failure or prevent the live-risk worker from taking over.
    }
  }
  try {
    const strategyModelProgress = await currentStrategyModelProgress(
      input.trace,
      input.config.execution.explorationOrderTarget,
    );
    filledEvidence.strategyModelProgress = strategyModelProgress;
    await db
      .update(strategyExecutionTraces)
      .set({
        entryEvidenceJson: JSON.stringify(filledEvidence),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(strategyExecutionTraces.id, input.trace.id),
          eq(strategyExecutionTraces.state, "POSITION_OPEN"),
        ),
      );
    await appendEvent(input.trace.traceId, input.trace.strategyId, {
      eventType: `MODEL_PHASE:${strategyModelProgress.phase}`,
      stage: "POSITION_MANAGEMENT",
      outcome: "INFO",
      message:
        strategyModelProgress.phase === "EXPLORATION_10"
          ? `终身前 ${strategyModelProgress.targetOrders} 单启动探索：已提交或持有 ${strategyModelProgress.committedEntryOrders}/${strategyModelProgress.targetOrders} 个真实入场，本单成交后继续完成1/3/5/15/30/60分钟验证`
          : strategyModelProgress.phase === "DAILY_REINFORCEMENT"
            ? `今日强化学习继续收集已确认信号样本 ${strategyModelProgress.dailyCommittedEntryOrders}/${strategyModelProgress.dailyReinforcementTargetOrders}；每日学习不恢复先下单权限`
          : strategyModelProgress.phase === "EVIDENCE_COLLECTION"
            ? `终身前 ${strategyModelProgress.targetOrders} 个启动探针名额已用完；已精确结算 ${strategyModelProgress.completedExactNetOrders}/${strategyModelProgress.learningTargetOrders} 个周期，后续入场必须由眼睛确认`
            : `${strategyModelProgress.learningTargetOrders} 个学习周期已完成，本单进入真实数据验证与参数优化阶段，仍须由眼睛确认`,
      detail: {
        ...strategyModelProgress,
        positionId: position.id,
        historicalPerformanceGateApplied: false,
      },
      eventAt: new Date(),
    });
  } catch {
    // Model progress is post-fill observability only. A reporting failure must
    // never unwind or misreport the already persisted live position.
  }
  if (!filledProfitPathValid)
    await appendEvent(input.trace.traceId, input.trace.strategyId, {
      eventType: "FILLED_PROFIT_PATH_DRIFT",
      stage: "ORDER",
      outcome: "ERROR",
      message:
        "实际成交数量按交易所步长重算后不再满足下单前净获利路径；不追加仓位，保留真实样本并继续执行止损保护",
      detail: {
        requestedQuantity:
          finiteNumber(input.evidence.requestedQuantity, Number.NaN),
        executedQuantity: input.executedQuantity,
        executableRiskPlan: riskPlan,
        filledProfitabilityBaseline,
        orderSubmissionAllowed: false,
      },
      eventAt: new Date(),
    });
  await writeAudit(
    { email: input.trace.ownerEmail, accountId: input.trace.accountId },
    "LIQUIDATION_PILOT_LIVE_ORDER",
    "live_position",
    String(position.id),
    {
      traceId: input.trace.traceId,
      symbol: input.trace.symbol,
      quantity: input.executedQuantity,
      entryPrice: input.entryPrice,
      leverage: input.leverage,
      requestedLeverage: input.config.execution.leverage,
      leverageAdjusted: input.leverage !== input.config.execution.leverage,
      exchangeOrderId: input.exchangeOrderId,
      entryMode: input.fillMode,
    },
  );
  return position;
}

async function currentStrategyModelProgress(
  trace: typeof strategyExecutionTraces.$inferSelect,
  orderFirstEntryTarget?: number,
) {
  const counts = await readStrategyModelProgressCounts({
    ownerEmail: trace.ownerEmail,
    strategyId: trace.strategyId,
    configVersion: trace.configVersion,
  });
  return strategyModelPhase({
    ...counts,
    orderFirstEntryTarget,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sqlValueBatches<T>(values: T[], batchSize = 50) {
  const unique = [...new Set(values)];
  const batches: T[][] = [];
  for (let index = 0; index < unique.length; index += batchSize)
    batches.push(unique.slice(index, index + batchSize));
  return batches;
}

function finiteNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function appendEvent(
  traceId: string,
  strategyId: number,
  event: {
    eventType: string;
    stage:
      | "SIGNAL"
      | "POSITION"
      | "TREND_1H"
      | "STRUCTURE_30M"
      | "LIQUIDITY_SWEEP_5M"
      | "RECLAIM_5M"
      | "ENTRY_3M"
      | "ORDER"
      | "POSITION_MANAGEMENT";
    outcome: "PASSED" | "PENDING" | "REJECTED" | "INFO" | "ERROR";
    message: string;
    detail: unknown;
    eventAt: Date;
  },
) {
  const db = getDb();
  const [duplicate] = await db
    .select({ id: strategyExecutionEvents.id })
    .from(strategyExecutionEvents)
    .where(
      and(
        eq(strategyExecutionEvents.traceId, traceId),
        eq(strategyExecutionEvents.eventType, event.eventType),
      ),
    )
    .limit(1);
  if (duplicate) return false;
  const last = await db
    .select({ sequence: strategyExecutionEvents.sequence })
    .from(strategyExecutionEvents)
    .where(eq(strategyExecutionEvents.traceId, traceId))
    .orderBy(desc(strategyExecutionEvents.sequence))
    .limit(1)
    .then((rows) => rows[0]);
  const [created] = await db
    .insert(strategyExecutionEvents)
    .values({
      traceId,
      strategyId,
      sequence: (last?.sequence ?? 0) + 1,
      eventType: event.eventType,
      stage: event.stage,
      outcome: event.outcome,
      message: event.message,
      detailJson: JSON.stringify(event.detail),
      eventAt: event.eventAt,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return Boolean(created);
}

async function deterministicTraceId(
  strategyId: number,
  accountId: string,
  item: {
    id: string;
    symbol: string;
    side: string;
    averagePrice: number;
    notional: number;
  },
) {
  const source = `${strategyId}:${accountId}:${item.id}:${item.symbol}:${item.side}:${item.averagePrice}:${item.notional}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `liq_${hex.slice(0, 40)}`;
}

function safeParse(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
