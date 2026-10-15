import { env } from "cloudflare:workers";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lte, ne, notExists, notLike, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { backgroundRepairTasks, contractSymbols, exchangeCredentials, executionIntents, liveOrderEvents, livePositionAdditionEvidence, livePositionAdditions, livePositionReductions, livePositions, nexusEyeFactSnapshots, riskStates, strategies, strategyExecutionEventRollups, strategyExecutionEvents, strategyExecutionSummaries, strategyExecutionTraces, strategyLearningCycles, strategyLearningReviews, strategyParameterSuggestions, strategyPositionEvidence, tradingAccounts } from "../../../../db/schema";
import { BinanceLiveError, LOCAL_POSITION_MISSING_CODE, getBinanceLargeTraderPositioningSnapshot, getBinanceLiveContractUniverse, getBinanceLiveKlinesRange, getBinanceLiveLiquidationEvents, getBinanceLiveMarkPriceKlinesRange, getBinanceLiveMarkPrices, getBinanceLiveOrderTrades, getBinanceLiveSystemMetrics, getLiveAccountPositionSnapshots, getLivePositionSnapshot, getLivePositionSnapshots, getNexusPrivateOrderEvents, waitForFreshNexusBookTicker } from "../../../../lib/binance-usdm-live";
import { queryLiveOrder, submitLiveEntryOrder, submitLiveReduceMarketOrder } from "../../../../lib/execution/exchange-order-gateway";
import { credentialContext, decryptCredential } from "../../../../lib/credential-vault";
import { positionRoePercent, priceAtRoePercent } from "../../../../lib/position-roe";
import {
  capitalPreservationStopHit,
  capitalPreservationStopRoePercent,
  maximumConfiguredStopRoePercent,
  withCapitalPreservationStop,
} from "../../../../lib/capital-preservation-stop";
import { monotonicFavorablePrice } from "../../../../lib/monotonic-favorable-price";
import {
  resolveLiquidationTrendConfig,
  type LiquidationTrendConfig,
} from "../../../../lib/liquidation-trend-config";
import {
  buildExitCounterfactualPath,
  classifyExitCounterfactualDetailed,
  dueExitCounterfactualHorizons,
  EXIT_COUNTERFACTUAL_VERSION,
  exitCounterfactualObservationBatchSize,
  isExitCounterfactualVersion,
  preExitAverageTrueRangePercent,
  resolveExitCounterfactualMaterialMove,
  type ExitCounterfactualExitReason,
} from "../../../../lib/exit-counterfactual";
import { loadBoundLiquidationTrendConfig } from "../../../../lib/bound-liquidation-config";
import {
  analyzePostEntryPerformance,
  buildAggregateParameterSuggestions,
  evaluatePostEntryCausalCompleteness,
} from "../../../../lib/strategy-post-entry-analysis";
import { analyzeMarkPricePosition } from "../../../../lib/nexus-market-position-observation";
import { accountFundingSnapshot } from "../../../../lib/account-funding-snapshot";
import { analyzePostEntryMarketRegime, unavailablePostEntryMarketRegime } from "../../../../lib/post-entry-market-regime";
import { getCoinGlassWebLiquidationContext } from "../../../../lib/coinglass-web-liquidations";
import { analyzePostEntryLiquidationRegime } from "../../../../lib/post-entry-liquidation-regime";
import { analyzePostEntryFundingVolumeObservation } from "../../../../lib/post-entry-funding-volume-observation";
import { adverseFundingCostRate } from "../../../../lib/nexus-funding-context";
import { analyzePostEntryTradeVolume } from "../../../../lib/post-entry-trade-volume-observation";
import { analyzePostEntryTrendPath } from "../../../../lib/post-entry-trend-path";
import { nexusUnifiedMarketData } from "../../../../lib/nexus-unified-market-data-live";
import { analyzeNexusMultiHourContext } from "../../../../lib/nexus-multi-hour-context";
import { resolvePositionHoldingMandate } from "../../../../lib/position-holding-mandate";
import { analyzePostEntryContractTrend } from "../../../../lib/post-entry-contract-trend";
import {
  resolveStrategyTerminalLearningScope,
  sameStrategyTerminalLearningScope,
} from "../../../../lib/strategy-terminal-learning-scope";
import {
  loadNextTerminalLearningCandidate,
} from "../../../../lib/position-lifecycle/terminal-learning-candidate-service";
import {
  decisionEngineVersionFromEvidence,
  LIQUIDATION_DECISION_ENGINE_VERSION,
} from "../../../../lib/liquidation-decision-engine";
import {
  counterfactualMinuteOffset,
  isDecisionAnchoredCounterfactualEvidence,
  rejectedSignalCounterfactualDirection,
  rejectedSignalCounterfactualAnchor,
  REJECTED_SIGNAL_COUNTERFACTUAL_CHECKPOINT_MINUTES,
} from "../../../../lib/rejected-signal-counterfactual";
import {
  isNexusBrainShadowSkippedTrace,
  nexusBrainShadowCounterfactualDirection,
  NEXUS_BRAIN_SHADOW_CAUSAL_EVIDENCE,
  NEXUS_BRAIN_SHADOW_CHECKPOINT_MINUTES,
  NEXUS_BRAIN_SHADOW_SKIPPED_RESULT_CODE,
  shadowCounterfactualEvidenceComplete,
  shadowCounterfactualMinuteDue,
} from "../../../../lib/nexus-brain-shadow-counterfactual";
import {
  isThreeMinuteObserveOnlyShadowTrace,
  summarizeThreeMinuteShadowOutcomes,
  THREE_MINUTE_OBSERVE_ONLY_CAUSAL_EVIDENCE,
  THREE_MINUTE_OBSERVE_ONLY_SHADOW_RESULT_CODE,
  threeMinuteShadowNetRoeEstimate,
} from "../../../../lib/three-minute-shadow-observation";
import {
  buildNexusSentinelShadowEntryValidation,
  NEXUS_SENTINEL_SHADOW_ENTRY_HORIZONS,
} from "../../../../lib/nexus-sentinel-shadow-entry-validation.ts";
import {
  transitionNexusOrderState,
  type NexusOrderState,
} from "../../../../lib/nexus-order-state-machine";
import {
  recoverableEntryQuantity,
  recoveredStrategyTraceState,
  resolveUnknownEntryOrder,
  strategyTraceIdFromClientOrderId,
} from "../../../../lib/live-order-reconciliation";
import {
  advanceNexusExecutionIntent,
  reconcileTerminalNexusExecutionIntents,
  settleNexusExecutionIntentWithLiveOrder,
} from "../../../../lib/nexus-execution-intent-store";
import {
  authorizePositionIncreaseEntry,
} from "../../../../lib/entry/position-increase-entry-authorization";
import {
  filledPendingOrderResponse,
  pendingOrderLeverage,
  pendingOrderReservedMargin,
} from "../../../../lib/live-order-reserved-margin";
import { observeExecutionQuote } from "../../../../lib/execution-quote-shadow-store";
import { buildExecutionShadowBrainEvidence } from "../../../../lib/execution-shadow-brain-evidence";
import {
  liveOrderStatusFromExchange,
  liveOrderStatusFromNexusState,
} from "../../../../lib/live-order-status";
import {
  liveOrderFillIsConfirmed,
  resolveLiveOrderFill,
  resolveLiveOrderTradeFill,
  resolveStoredLiveOrderFill,
} from "../../../../lib/live-order-fill";
import { evaluateRelativeStrengthPairLifecycles } from "../../../../lib/relative-strength-pair-lifecycle";
import { buildNexusExperienceParameterSuggestions } from "../../../../lib/nexus-experience-consumption";
import { reconcileNexusConfigValidation } from "../../../../lib/nexus-config-validation-runtime";
import { reconcileLiquidationFactorLearningCandidate } from "../../../../lib/liquidation-factor-learning-runtime";

const privateOrderSequenceByCredential = new Map<number, number>();
import {
  readTradingStrategyDailyPnl,
  writeAudit,
} from "../../control/shared";
import { attachReductionSettlement, buildReductionSettlement, resolveReductionSettlement } from "../../../../lib/live-reduction-settlement";
import { resolveExchangeZeroClose } from "../../../../lib/live-close-convergence";
import { reductionAccountingPnl } from "../../../../lib/live-reduction-accounting";
import {
  reductionSettlementRetryDue,
  scheduleReductionSettlementRetry,
  terminalizeReductionSettlementRetry,
} from "../../../../lib/live-reduction-settlement-retry";
import { analyzePostEntryBreakdownObservation } from "../../../../lib/post-entry-breakdown-observation";
import { analyzeEntryThesisInvalidation } from "../../../../lib/post-entry-thesis-invalidation";
import { resolvePostEntryStructureContext } from "../../../../lib/post-entry-structure-context";
import { postFirstTakeProfitProtection } from "../../../../lib/post-entry-profit-protection";
import { dynamicProfitProtection } from "../../../../lib/dynamic-profit-protection";
import {
  decideDynamicProfitReduction,
  type DynamicProfitReductionDecision,
} from "../../../../lib/dynamic-profit-reduction";
import { buildLiquidationMarketTriggerCandidates } from "../../../../lib/liquidation-market-trigger";
import { analyzeLargeTraderLongPositioning, type LargeTraderPositioning } from "../../../../lib/large-trader-positioning";
import { analyzePostEntryLargeTraderObservation, unavailablePostEntryLargeTraderObservation } from "../../../../lib/post-entry-large-trader-observation";
import { entryLargeTraderPositioning } from "../../../../lib/strategy-entry-observation-baseline";
import { STRATEGY_LEARNING_SCHEMA_VERSION } from "../../../../lib/strategy-learning-version";
import {
  applyStopLossExecution,
  applyTakeProfitExecution,
  applyDynamicProfitReductionExecution,
  applyEvidenceRiskReductionExecution,
  observeDynamicProfitProtectionFloor,
  observeDynamicProfitSoftActivation,
  type ExecutedRiskProgress,
  normalizeExecutedRiskProgress,
  reanchorProgressAfterAddition,
  recordVerifiedTakeProfitExecution,
  remainingTakeProfitQuantity,
  recordTakeProfitDeferral,
  resetGridProgressPreservingDynamic,
} from "../../../../lib/risk-execution-progress";
import {
  decideTailWaveExit,
  type TailWaveExitDecision,
} from "../../../../lib/tail-wave-exit";
import {
  normalizeRiskProtectionMode,
  rebalanceRiskPlan,
} from "../../../../lib/risk-plan-rebalance";
import { certifyOpenPositionProtection } from "../../../../lib/position-protection-certification";
import { resolveFinalPositionFundingContext } from "../../../../lib/live-position-funding";
import { aggregatePositionReductionCycle } from "../../../../lib/live-position-cycle-accounting";
import {
  committedStrategyEntryCount,
  committedStrategyEntryCountForTradingDay,
  STRATEGY_LEARNING_SAMPLE_TARGET,
  strategyModelPhase,
} from "../../../../lib/strategy-model-phase";
import {
  selectStrategyLearningTraceContextsWithinBudget,
  STRATEGY_LEARNING_RUNTIME_OBSERVATION_ROW_LIMIT,
  STRATEGY_LEARNING_RUNTIME_TRACE_ID_LIMIT,
  STRATEGY_LEARNING_RUNTIME_TRACE_CONTEXT_BUDGET_BYTES,
} from "../../../../lib/strategy-learning-memory-budget";
import { liquidationGuard } from "../../../../lib/live-position-protection";
import {
  normalizeReduceQuantity,
  normalizePartialReduceQuantity,
  promoteReduceQuantityForMinNotional,
  quantityStepTolerance,
  subtractOrderQuantity,
} from "../../../../lib/order-quantity";
import {
  evaluateTakeProfitExecution,
  takeProfitFillConsumesGrid,
  type TakeProfitExecutionGuard,
} from "../../../../lib/take-profit-execution-guard";
import {
  evaluateProfitReductionExecution,
  type ProfitReductionExecutionGuard,
} from "../../../../lib/profit-reduction-execution-guard";
import {
  accountPositionQuantityDifferences,
  fourHourPositionReconciliationDue,
} from "../../../../lib/account-position-reconciliation";
import {
  decidePositionAutonomy,
} from "../../../../lib/position-autonomy-policy";
import {
  observePositionWaveStructure,
} from "../../../../lib/post-entry-wave-observation";
import {
  analyzePositionManagementDecision,
  POSITION_MANAGEMENT_MODEL_VERSION,
  type PositionManagementDecision,
} from "../../../../lib/post-entry-position-management";
import { mergeRiskPlanWithPositionMemory, readNexusPositionMemory } from "../../../../lib/nexus-position-memory";
import { buildPositionThesisUpdate } from "../../../../lib/position-thesis-update";
import { bindPositionManagementExecution } from "../../../../lib/position-management-execution-binding";
import { selectPositionEvidenceRiskExecution } from "../../../../lib/position-evidence-risk-execution";
import { gatePositionManagementDecision } from "../../../../lib/position-management-evidence-gate";
import {
  buildPilotRiskPlan,
  LIQUIDATION_PILOT_LIMITS,
  smallestPilotQuantity,
} from "../../../../lib/liquidation-live-execution";
import {
  evaluateAutomatedEntryRestCapacity,
  projectRemainingRestWeight,
} from "../../../../lib/execution/automated-entry-context";
import {
  readAutomatedEntryAcknowledgement,
} from "../../../../lib/execution/automated-entry-order";
import { calculateStrategyMarginCapacity } from "../../../../lib/strategy-margin-capacity.mjs";
import {
  automatedOrderCapacityMessage,
  calculateAutomatedOrderCapacity,
} from "../../../../lib/automated-order-capacity.mjs";
import { chinaTradingDayWindow } from "../../../../lib/trading-calendar";
import {
  combinePositionAddition,
  estimatePositionAdditionNetEffect,
  positionAdditionFillAnchor,
  revalidatePositionAdditionOpportunity,
  selectPositionAdditionLearningMark,
} from "../../../../lib/live-position-addition";
import {
  POST_ENTRY_LONG_HOLD_MINUTES,
  POST_ENTRY_MODEL_MINUTES,
  POST_ENTRY_STORED_MINUTES,
  duePostEntryObservationMinute,
  entryStructureReassessmentMinute,
  isRecurringPostEntryHoldObservationMinute,
  postEntryBackfillKlinePlan,
  postEntryObservationType,
} from "../../../../lib/post-entry-observation-schedule";
import {
  ACTUAL_POSITION_EVIDENCE_TASK,
  backgroundRepairFailure,
} from "../../../../lib/background-repair-task";
import {
  strategyTerminalObservationMinute,
} from "../../../../lib/strategy-trace-lifecycle";
import {
  resolveThreeMinutePositionPlan,
  threeMinuteEarlyExitCounterfactualDue,
  threeMinuteProfitCaptureHit,
  threeMinuteTimeExitDue,
} from "../../../../lib/three-minute-round";
import { advanceThreeMinuteDynamicProtection } from
  "../../../../lib/three-minute-dynamic-protection";
import { buildThreeMinuteParameterCandidate } from
  "../../../../lib/three-minute-learning";
import { analyzeExplorationPositionGateReplay } from "../../../../lib/exploration-position-gate-replay";
import { buildEntryStructureBaseline } from "../../../../lib/entry-structure-baseline";
import {
  entryStructureReassessmentRequired,
  usableEntryStructureBaseline,
} from "../../../../lib/entry-structure-reassessment";
import {
  analyzeContrarianProbeLifecycle,
  strategyBranchFamily,
} from "../../../../lib/contrarian-probe-lifecycle";
import {
  advanceNexusPositionState,
  nexusManagedPositionKey,
  parseNexusPositionStateSnapshot,
  type NexusPositionStateSnapshot,
} from "../../../../lib/nexus-position-state-machine";
import {
  summarizePositionMarketMicrostructure,
} from "../../../../lib/position-lifecycle/position-market-microstructure";
import {
  evaluatePositionMicrostructureProtection,
} from "../../../../lib/position-lifecycle/position-microstructure-protection";
import {
  entryProbeInvalidBoundary,
  evaluatePositionEntryProbe,
} from "../../../../lib/position-lifecycle/position-entry-probe";
import {
  buildNexusDailyReinforcement,
  buildNexusLearningCycle,
  attachNexusBrainCollaborationMemory,
  nexusRequiredLearningCheckpointMinutes,
  nexusLearningIdentityChain,
  nexusPreTradeEvidenceIntegrity,
  nexusPreTradeFactIds,
  type NexusLearningCycle,
} from "../../../../lib/nexus-learning-cycle";
import { compactTerminalNexusMarketFactsEvidence } from "../../../../lib/nexus-market-facts";
import {
  compactNexusEyeDecision,
  buildStrategyTerminalArchive,
  extractNexusEyeFactSnapshots,
  keyStrategyRetentionEvents,
  resolveStrategyEventRetentionMode,
  STRATEGY_EVENT_ARCHIVE_VERSION,
  STRATEGY_EVENT_DETAIL_RETENTION_MS,
  strategyEventDeletionDecision,
  strategyEventRetentionEligibility,
  strategyEventLearningStatus,
  strategyTerminalArchiveSourceMaterial,
} from "../../../../lib/strategy-event-retention";
import {
  finalizeNexusFastLearningObservation,
  loadNexusBrainMemoryCasesForAccount,
  markNexusLearningCycleSettlementRefreshPending,
  saveNexusLearningCycle,
} from "../../../../lib/nexus-learning-cycle-store";
import {
  buildTerminalSemiAutoLearningReceipt,
} from "../../../../lib/terminal-strategy-learning-receipt";
import {
  buildNexusBrainCollaborationMemory,
  createNexusBrainMemoryCase,
  resolveNexusBrainMemoryMarketMeasures,
} from "../../../../lib/nexus-brain-collaboration-memory";
import { buildNexusEvidenceReliabilityMemory } from "../../../../lib/nexus-evidence-reliability-memory";
import { buildNexusEvidenceRegimeContrast } from "../../../../lib/nexus-evidence-regime-contrast";
import { buildNexusEvidenceTemporalDrift } from "../../../../lib/nexus-evidence-temporal-drift";
import { buildNexusEvidenceConfidenceDecay } from "../../../../lib/nexus-evidence-confidence-decay";
import { buildNexusSimilarContextReview } from "../../../../lib/nexus-similar-context-review";
import { resolveNexusEntryAuthorization } from "../../../../lib/nexus-entry-authorization";
import { buildNexusLifecycleRetrospective } from "../../../../lib/nexus-lifecycle-retrospective";
import { summarizeNexusOpportunityLifecycles } from "../../../../lib/nexus-opportunity-lifecycle";
import { buildNexusLearningMarketContext } from "../../../../lib/nexus-learning-market-context";
import { nexusProbabilityContextFromEvidence } from
  "../../../../lib/nexus-probability-context";
import { buildNexusCrossDayReinforcement } from "../../../../lib/nexus-cross-day-reinforcement";
import {
  activateProtectionPlan,
  buildInstrumentId,
  effectiveSoftProtection,
  rebuildProtectionAfterAddition,
} from "../../../../lib/position-protection-version";
import {
  authorizedStructureExitHandoffFresh,
  assessCapitalEfficiencyWave,
  capitalEfficiencyExitUsesContinuousMonitoring,
  dueCapitalEfficiencyExitObservationMinute,
  isCapitalEfficiencyExitObservationMinute,
  normalizeStructureExitExecutionMode,
  positionIntelligenceHandoffFresh,
  readCapitalEfficiencyExitRule,
  structureExitExecutionAuthorized,
  type CapitalEfficiencyExitRule,
  type StructureExitExecutionMode,
} from "../../../../lib/structure-exit-policy";
import {
  createDurableStructureExitIntent,
} from "../../../../lib/durable-structure-exit-intent";
import {
  loadActiveStructureExitIntents,
  persistActiveStructureExitIntent,
} from "../../../../lib/position-lifecycle/structure-exit-intent-store";
import { evaluateAutomatedOrderConcurrency } from "../../../../lib/automated-order-concurrency";
import {
  positionIntelligenceUrgency,
  prioritizePositionIntelligenceWorkIds,
  selectProtectionWorkIds,
  selectRotatingWorkIds,
} from "../../../../lib/live-risk-work-budget";
import {
  evaluatePostExitReentry,
  POST_EXIT_REENTRY_VERSION,
  type PostExitReentryEvaluation,
} from "../../../../lib/post-exit-reentry";
import { resolveNexusTradingArchitecture } from "../../../../lib/nexus-trading-architecture";
import { resolveStrategyEntryTimingProfile } from "../../../../lib/strategy-entry-timing";
import { resolveStrategyExecutionDirection } from "../../../../lib/strategy-execution-direction";
import {
  buildPositionObservationTiming,
  duePositionObservationCandidates,
  positionObservationCausalLearningEligible,
  positionObservationStorageStatus,
  positionObservationSampleKey,
} from "../../../../lib/position-observation-timing";
import {
  compactPositionObservationEventDetail,
  positionObservationEvidenceForStorage,
  positionObservationEventType,
  positionObservationRequiresFullSnapshot,
  type PositionObservationEventKind,
} from "../../../../lib/position-observation-persistence";
import {
  appendStrategyProfitProtectionActivation,
  appendStrategyPositionManagementEvent,
  backfillStrategyReductionEvents,
} from "../../../../lib/position-lifecycle/strategy-position-event-store";
import {
  dispatchAuxiliaryLiveRiskPlane,
} from "../../../../lib/position-lifecycle/live-risk-runtime-planes";
import {
  settleClosedStrategyTraces,
} from "../../../../lib/position-lifecycle/terminal-strategy-learning-handoff";
import {
  recordLivePositionReduction,
} from "../../../../lib/position-lifecycle/position-reduction-ledger";
import {
  additionalEntryOrdersForPosition,
  reconcileMissingLocalPosition,
} from "../../../../lib/position-lifecycle/position-reconciliation-runtime";
import {
  buildFilledPositionHandoff,
  FILLED_POSITION_HANDOFF_CONTRACT_VERSION,
} from "../../../../lib/position-lifecycle/filled-position-handoff";

export const dynamic = "force-dynamic";

type RiskLevel = { triggerPercent: number; closePercent: number; closeQuantity?: number };
type RiskPlan = {
  takeProfits: RiskLevel[];
  stopLosses: RiskLevel[];
  capitalPreservationStopRoePercent: number | null;
  minimumObservationMinutes: number;
  liquidationGuardBufferPercent: number;
  structureExitExecutionMode: StructureExitExecutionMode;
  capitalEfficiencyExit?: unknown;
  capitalEfficiencyExitRule: CapitalEfficiencyExitRule | null;
  tailWaveExit?: unknown;
};
type ExecutedPlan = ExecutedRiskProgress;
const POSITION_RECONCILE_INTERVAL_MS = 30_000;
const lastPositionReconcileAt = new Map<string, number>();
let openPositionReconciliationRunning = false;
let nextOpenPositionReconciliationAt = 0;
let lastOpenPositionReconciliation = {
  closedIds: new Set<number>(),
  blockedGroupKeys: new Set<string>(),
  completedAt: null as Date | null,
  error: null as string | null,
};
const fullAccountReconcileInFlight = new Set<number>();
const fullAccountReconcileLastAttemptAt = new Map<number, number>();
const fullAccountReconcileLastCompletedAt = new Map<number, number>();
const FULL_ACCOUNT_RECONCILE_ERROR_RETRY_MS = 5 * 60_000;
let fullAccountReconcileRunning = false;
let lastFullAccountReconcileSummary = {
  accounts: 0,
  checked: 0,
  matched: 0,
  mismatched: 0,
  locallyClosed: 0,
  ghostRowsClosed: 0,
  operatorAlerts: 0,
  errors: 0,
  deferred: 0,
  errorDetails: [] as Array<{ credentialId: number; message: string }>,
  completedAt: null as string | null,
};
let entryStructureReassessmentPriorityPositionId: number | null = null;
// Deep position intelligence intentionally runs on its own internal request.
// It performs multi-timeframe/market-context reads and must never share the
// five-second deterministic protection deadline.
const POSITION_INTELLIGENCE_BUDGET_PER_CYCLE = 1;
let positionIntelligenceCursor = 0;
const POSITION_INTELLIGENCE_HANDOFF_TTL_MS = 2 * 60_000;
const positionIntelligenceOpportunityByPosition = new Map<
  number,
  {
    opportunity: NonNullable<
      Awaited<ReturnType<typeof recordLiquidationPositionEvidence>>
    >;
    expiresAt: number;
  }
>();
const POSITION_PROTECTION_MAINTENANCE_BUDGET_PER_CYCLE = 1;
// Keep each five-second protection heartbeat bounded. Immediate triggers stay
// ahead of maintenance, but rotate in batches instead of making one request
// serially process every open position during a market-wide move.
// Submit at most one exchange reduction per heartbeat.  A protective close
// performs a live position check and an acknowledged order write; batching
// several of those sequentially made the whole request exceed the runner's
// deadline and disabled protection for every position.
const POSITION_PROTECTION_PRIORITY_BUDGET_PER_CYCLE = 1;
let positionProtectionMaintenanceCursor = 0;
let positionProtectionPriorityCursor = 0;
const liveRiskFavorablePriceByPosition = new Map<number, number>();
let liveRiskAuxiliaryReconciliationRunning = false;
let reductionSettlementBackfillRunning = false;
let lastLiveRiskAuxiliaryReconciliation = {
  pendingCloseReconciliation: {
    checked: 0,
    reconciled: 0,
    released: 0,
    waiting: 0,
    errors: 0,
  },
  privateOrderReconciliation: {
    accounts: 0,
    events: 0,
    updated: 0,
    ignored: 0,
  },
  unknownEntryOrderReconciliation: {
    checked: 0,
    reconciled: 0,
    waiting: 0,
    errors: 0,
  },
  executionIntentReconciliation: {
    checked: false,
    repaired: 0,
  },
  positionAdditionReconciliation: {
    reconciled: 0,
    rejected: 0,
    deferred: 0,
    errors: 0,
  },
  errors: 0,
  completedAt: null as string | null,
};
let lastClosedPositionAdditionBackfillAt = 0;
const STRATEGY_LEARNING_REFRESH_INTERVAL_MS = 30_000;
const STRATEGY_LEARNING_GLOBAL_COOLDOWN_MS = 60_000;
const STRATEGY_LEARNING_PER_VERSION_COOLDOWN_MS = 15 * 60_000;
let nextStrategyLearningRefreshAt = 0;
const strategyLearningRefreshActiveKeys = new Set<string>();
let strategyLearningLastGlobalCompletedAt = 0;
let exitCounterfactualReductionCursor = 0;
let threeMinuteCounterfactualPositionCursor = 0;
const TERMINAL_FACT_COMPACTION_MIN_AGE_MS = 24 * 60 * 60_000;
const TERMINAL_FACT_COMPACTION_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
const TERMINAL_FACT_COMPACTION_BATCH_SIZE = 5;
const TERMINAL_EVENT_DELETE_BATCH_SIZE = 500;
let terminalFactCompactionCursor = 0;
let nextTerminalFactCompactionSweepAt = 0;
const strategyLearningLastCompletedAt = new Map<string, number>();
const postEntryLargeTraderCache = new Map<string, {
  expiresAt: number;
  value: LargeTraderPositioning;
}>();

async function pendingDuePositionObservationPriorityIds(
  positions: Array<{
    id: number;
    openedAt: Date;
    lifecycleId: string | null;
    riskPlanJson: string;
    entryPrice: number;
    markPrice: number;
    favorablePrice: number | null;
    leverage: number;
    positionSide: "LONG" | "SHORT";
    trailingActivationPercent: number;
    trailingStopPercent: number;
  }>,
  nowMs: number,
) {
  const dueForPosition = (
    position: (typeof positions)[number],
    recordedMinuteOffsets: readonly number[] = [],
  ) => {
    const standard = duePositionObservationCandidates({
      nowMs,
      positions: [{
        id: position.id,
        openedAtMs: position.openedAt.getTime(),
        recordedMinuteOffsets,
      }],
    })[0] ?? null;
    const rule = parseRiskPlan(position.riskPlanJson)
      .capitalEfficiencyExitRule;
    const continuousMinute = dueCapitalEfficiencyExitObservationMinute({
      rule,
      elapsedMs: nowMs - position.openedAt.getTime(),
      recordedMinuteOffsets,
    });
    const continuous = continuousMinute === null
      ? null
      : {
          id: position.id,
          minuteOffset: continuousMinute,
          scheduledAtMs:
            position.openedAt.getTime() + continuousMinute * 60_000,
        };
    if (!standard) return continuous;
    if (!continuous) return standard;
    return standard.scheduledAtMs <= continuous.scheduledAtMs
      ? standard
      : continuous;
  };
  const provisionalDue = positions.flatMap((position) => {
    const due = dueForPosition(position);
    return due
      ? [{
          ...due,
          lifecycleId: position.lifecycleId,
          riskPlanJson: position.riskPlanJson,
        }]
      : [];
  }).sort(
    (left, right) =>
      left.scheduledAtMs - right.scheduledAtMs || left.id - right.id,
  );
  if (!provisionalDue.length) return [];
  const db = getDb();
  const positionIds = provisionalDue.map((item) => String(item.id));
  const lifecycleIds = provisionalDue.flatMap((item) =>
    item.lifecycleId ? [item.lifecycleId] : []
  );
  const traceRows = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      positionId: strategyExecutionTraces.positionId,
    })
    .from(strategyExecutionTraces)
    .where(
      lifecycleIds.length
        ? or(
            inArray(strategyExecutionTraces.traceId, lifecycleIds),
            inArray(strategyExecutionTraces.positionId, positionIds),
          )
        : inArray(strategyExecutionTraces.positionId, positionIds),
    );
  const traceByPositionId = new Map(
    traceRows.flatMap((row) =>
      row.positionId ? [[row.positionId, row.traceId] as const] : [],
    ),
  );
  const provisionalDueWithTrace = provisionalDue.map((item) => ({
    ...item,
    traceId:
      item.lifecycleId ??
      traceByPositionId.get(String(item.id)) ??
      `manual-position-${item.id}`,
  }));
  const traceIds = [
    ...new Set(provisionalDueWithTrace.map((item) => item.traceId)),
  ];
  const recordedRows = await db
    .select({
      traceId: strategyPositionEvidence.traceId,
      minuteOffset: strategyPositionEvidence.minuteOffset,
      createdAt: strategyPositionEvidence.createdAt,
    })
    .from(strategyPositionEvidence)
    .where(inArray(strategyPositionEvidence.traceId, traceIds));
  const recordedMinuteOffsetsByTrace = new Map<string, number[]>();
  const lastObservedAtByTrace = new Map<string, number>();
  for (const row of recordedRows) {
    const offsets = recordedMinuteOffsetsByTrace.get(row.traceId) ?? [];
    offsets.push(row.minuteOffset);
    recordedMinuteOffsetsByTrace.set(row.traceId, offsets);
    lastObservedAtByTrace.set(
      row.traceId,
      Math.max(
        lastObservedAtByTrace.get(row.traceId) ?? 0,
        row.createdAt.getTime(),
      ),
    );
  }
  const positionById = new Map(positions.map((item) => [item.id, item]));
  const dueIds = provisionalDueWithTrace.flatMap((item) => {
    const position = positionById.get(item.id);
    if (!position) return [];
    const due = dueForPosition(
      position,
      recordedMinuteOffsetsByTrace.get(item.traceId) ?? [],
    );
    return due ? [due] : [];
  }).map((item) => item.id);
  const traceByDuePositionId = new Map(
    provisionalDueWithTrace.map((item) => [item.id, item.traceId]),
  );
  const scheduledAtById = new Map(
    provisionalDueWithTrace.map((item) => [item.id, item.scheduledAtMs]),
  );
  const urgencyById = new Map(
    dueIds.map((id) => {
      const position = positionById.get(id);
      if (!position) return [id, 0] as const;
      const currentRoePercent = positionRoePercent(
        position.entryPrice,
        position.markPrice,
        position.leverage,
        position.positionSide,
      );
      const favorableRoePercent = positionRoePercent(
        position.entryPrice,
        position.favorablePrice ?? position.entryPrice,
        position.leverage,
        position.positionSide,
      );
      return [id, positionIntelligenceUrgency({
        currentRoePercent,
        capitalStopRoePercent:
          parseRiskPlan(position.riskPlanJson)
            .capitalPreservationStopRoePercent,
        favorableRoePercent,
        trailingActivationRoePercent: position.trailingActivationPercent,
        trailingGivebackRoePoints: position.trailingStopPercent,
      })] as const;
    }),
  );
  return prioritizePositionIntelligenceWorkIds({
    ids: dueIds,
    lastObservedAtById: new Map(dueIds.map((id) => [
      id,
      lastObservedAtByTrace.get(traceByDuePositionId.get(id) ?? "") ?? 0,
    ])),
    scheduledAtById,
    urgencyById,
    nowMs,
  });
}

function parseRiskPlan(value: string): RiskPlan {
  try {
    const plan = JSON.parse(value) as Partial<RiskPlan>;
    return {
      takeProfits: Array.isArray(plan.takeProfits) ? plan.takeProfits : [],
      stopLosses: Array.isArray(plan.stopLosses) ? plan.stopLosses : [],
      capitalPreservationStopRoePercent:
        capitalPreservationStopRoePercent(plan),
      minimumObservationMinutes:
        Number.isInteger(plan.minimumObservationMinutes) &&
        Number(plan.minimumObservationMinutes) >= 0
          ? Number(plan.minimumObservationMinutes)
          : 0,
      liquidationGuardBufferPercent:
        Number.isFinite(plan.liquidationGuardBufferPercent) &&
        Number(plan.liquidationGuardBufferPercent) > 0
          ? Number(plan.liquidationGuardBufferPercent)
          : 5,
      structureExitExecutionMode: normalizeStructureExitExecutionMode(),
      capitalEfficiencyExitRule: readCapitalEfficiencyExitRule(),
      tailWaveExit: plan.tailWaveExit,
    };
  } catch {
    return {
      takeProfits: [],
      stopLosses: [],
      capitalPreservationStopRoePercent: null,
      minimumObservationMinutes: 0,
      liquidationGuardBufferPercent: 5,
      structureExitExecutionMode: normalizeStructureExitExecutionMode(),
      capitalEfficiencyExitRule: readCapitalEfficiencyExitRule(),
      tailWaveExit: undefined,
    };
  }
}

function parseExecutedPlan(value: string): ExecutedPlan {
  try {
    return normalizeExecutedRiskProgress(
      JSON.parse(value) as Partial<ExecutedPlan>,
    );
  } catch {
    return normalizeExecutedRiskProgress(null);
  }
}

function finiteNumberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function riskPlanAtrPrice(value: string) {
  const plan = asRecord(parseJson(value));
  const entryStructureBaseline = asRecord(plan.entryStructureBaseline);
  const opportunityContext = asRecord(plan.opportunityContext);
  const opportunityBaseline = asRecord(
    opportunityContext.entryStructureBaseline,
  );
  for (const candidate of [
    entryStructureBaseline.atr5m,
    opportunityBaseline.atr5m,
    asRecord(plan.entryEvidence).atr5m,
  ]) {
    const atr = Number(candidate);
    if (Number.isFinite(atr) && atr > 0) return atr;
  }
  return null;
}

function rebuildProtectionAfterReduction(input: {
  riskPlanJson: string;
  executedRiskPlanJson: string;
  remainingQuantity: number;
  minOrderQty: number;
  quantityStep: number;
  trailingStopPercent: number;
  nextPositionVersion: number;
  nextProtectionVersion: number;
  nowMs: number;
  source: "AUTO_REDUCTION" | "RECONCILIATION";
}) {
  const rebalanced = rebalanceRiskPlan(
    asRecord(parseJson(input.riskPlanJson)),
    input.remainingQuantity,
    input.minOrderQty,
    input.quantityStep,
    asRecord(parseJson(input.executedRiskPlanJson)),
    input.trailingStopPercent,
  );
  return {
    plan: activateProtectionPlan({
      plan: rebalanced.plan,
      positionVersion: input.nextPositionVersion,
      protectionVersion: input.nextProtectionVersion,
      nowMs: input.nowMs,
      source: input.source,
    }),
    executed: resetGridProgressPreservingDynamic(
      normalizeExecutedRiskProgress(
        asRecord(parseJson(input.executedRiskPlanJson)),
      ),
    ),
    takeProfitGrids: rebalanced.takeProfitGrids,
    stopLossGrids: rebalanced.stopLossGrids,
  };
}

function riskPlanNeedsQuantityRebalance(
  plan: Record<string, unknown>,
  quantity: number,
  quantityStep: number,
) {
  const tolerance = Math.max(1e-10, quantityStep * 1e-6);
  const mismatches = (value: unknown) => {
    if (!Array.isArray(value) || value.length === 0) return false;
    const total = value.reduce(
      (sum, level) =>
        sum +
        Number(
          level && typeof level === "object"
            ? (level as { closeQuantity?: unknown }).closeQuantity
            : 0,
        ),
      0,
    );
    return !Number.isFinite(total) || Math.abs(total - quantity) > tolerance;
  };
  return mismatches(plan.takeProfits) || mismatches(plan.stopLosses);
}

function authorized(request: Request) {
  const configured = (env as unknown as { NQ_INTERNAL_RISK_TOKEN?: string }).NQ_INTERNAL_RISK_TOKEN ?? "";
  return configured.length >= 32 && request.headers.get("authorization") === `Bearer ${configured}`;
}

async function reconcileOpenPositionsWithBinance(
  candidates: Array<typeof livePositions.$inferSelect>,
  now: Date,
) {
  const db = getDb();
  const closedIds = new Set<number>();
  const blockedGroupKeys = new Set<string>();
  const credentialGroups = new Map<
    number,
    Array<typeof livePositions.$inferSelect>
  >();
  for (const position of candidates) {
    const group = credentialGroups.get(position.credentialId) ?? [];
    group.push(position);
    credentialGroups.set(position.credentialId, group);
  }
  for (const [credentialId, positions] of credentialGroups) {
    const key = `credential:${credentialId}`;
    if (now.getTime() - (lastPositionReconcileAt.get(key) ?? 0) < POSITION_RECONCILE_INTERVAL_MS)
      continue;
    lastPositionReconcileAt.set(key, now.getTime());
    const sample = positions[0]!;
    try {
      const [credential] = await db.select().from(exchangeCredentials).where(and(
        eq(exchangeCredentials.id, sample.credentialId),
        eq(exchangeCredentials.ownerEmail, sample.ownerEmail),
      )).limit(1);
      if (!credential) continue;
      const keys = {
        apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(sample.ownerEmail, sample.accountId, "api-key")),
        secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(sample.ownerEmail, sample.accountId, "secret-key")),
      };
      const targets = [
        ...new Map(
          positions.map((position) => [
            `${position.symbol}:${position.positionSide}`,
            {
              symbol: position.symbol,
              positionSide: position.positionSide,
            },
          ]),
        ).values(),
      ];
      const snapshots = await getLivePositionSnapshots(keys, targets);
      const hedgeMode = [...snapshots.values()].some(
        (snapshot) => snapshot.hedgeMode,
      );
      await db.update(exchangeCredentials).set({
        positionMode: hedgeMode ? "HEDGE" : "ONE_WAY",
        updatedAt: new Date(),
      }).where(eq(exchangeCredentials.id, credential.id));
      for (const target of targets) {
        const exchangePosition = snapshots.get(
          `${target.symbol}:${target.positionSide}`,
        );
        if (!exchangePosition) continue;
        const matchingPositions = await db.select().from(livePositions).where(and(
          eq(livePositions.ownerEmail, sample.ownerEmail),
          eq(livePositions.accountId, sample.accountId),
          eq(livePositions.credentialId, credentialId),
          eq(livePositions.symbol, target.symbol),
          eq(livePositions.positionSide, target.positionSide),
          eq(livePositions.status, "OPEN"),
        ));
        if (exchangePosition.quantity > 0) {
          const aggregateEntryPrice =
            exchangePosition.entryPrice > 0
              ? exchangePosition.entryPrice
              : matchingPositions[0]?.entryPrice;
          const aggregateMarkPrice =
            exchangePosition.markPrice > 0
              ? exchangePosition.markPrice
              : aggregateEntryPrice;
          const [symbolRule] = await db
            .select()
            .from(contractSymbols)
            .where(eq(contractSymbols.symbol, target.symbol))
            .limit(1);
          await Promise.all(
            matchingPositions.map((position) => {
              const basisChanged =
                Number.isFinite(aggregateEntryPrice) &&
                Math.abs(
                  (aggregateEntryPrice ?? position.entryPrice) -
                    position.entryPrice,
                ) >
                  Math.max(
                    1e-12,
                    Math.abs(position.entryPrice) * 1e-10,
                  );
              const currentPlan = asRecord(parseJson(position.riskPlanJson));
              const gridRepairRequired = Boolean(symbolRule) &&
                riskPlanNeedsQuantityRebalance(
                  currentPlan,
                  position.quantity,
                  symbolRule.quantityStep,
                );
              const protectionChanged = Boolean(symbolRule) &&
                (basisChanged || gridRepairRequired);
              const nextPositionVersion = protectionChanged
                ? position.positionVersion + 1
                : position.positionVersion;
              const nextProtectionVersion = protectionChanged
                ? position.protectionVersion + 1
                : position.protectionVersion;
              const rebuilt = protectionChanged && symbolRule
                ? rebalanceRiskPlan(
                    currentPlan,
                    position.quantity,
                    symbolRule.minOrderQty,
                    symbolRule.quantityStep,
                    asRecord(parseJson(position.executedRiskPlanJson)),
                    position.trailingStopPercent,
                  )
                : null;
              const riskPlan = rebuilt
                ? activateProtectionPlan({
                    plan: rebuilt.plan,
                    positionVersion: nextPositionVersion,
                    protectionVersion: nextProtectionVersion,
                    nowMs: now.getTime(),
                    source: "RECONCILIATION",
                  })
                : currentPlan;
              return db.update(livePositions).set({
                // Binance aggregates one account/symbol/direction into one
                // position. Every local allocation must therefore use the
                // same exchange cost basis for ROE decisions, while retaining
                // its own allocated quantity and risk plan.
                entryPrice: aggregateEntryPrice ?? position.entryPrice,
                markPrice: aggregateMarkPrice ?? position.markPrice,
                liquidationPrice: Number.isFinite(
                  exchangePosition.liquidationPrice,
                )
                  ? exchangePosition.liquidationPrice > 0
                    ? exchangePosition.liquidationPrice
                    : null
                  : position.liquidationPrice,
                liquidationPriceRaw:
                  exchangePosition.liquidationPriceRaw,
                liquidationPriceStatus:
                  exchangePosition.liquidationPriceStatus,
                liquidationPriceObservedAt: new Date(
                  exchangePosition.liquidationPriceObservedAt,
                ),
                leverage:
                  Number.isFinite(exchangePosition.leverage) &&
                  exchangePosition.leverage > 0
                    ? exchangePosition.leverage
                    : position.leverage,
                // Only reset a peak when the exchange cost basis actually
                // changes. Periodic reconciliation must preserve the running
                // favorable peak used by trailing protection.
                favorablePrice: monotonicFavorablePrice({
                  positionSide: position.positionSide,
                  entryPrice: aggregateEntryPrice ?? position.entryPrice,
                  previousFavorablePrice: position.favorablePrice,
                  currentMarkPrice: aggregateMarkPrice ?? position.markPrice,
                  reset: basisChanged,
                }),
                positionVersion: nextPositionVersion,
                protectionVersion: nextProtectionVersion,
                protectionState: protectionChanged
                  ? "ACTIVE"
                  : position.protectionState,
                protectionUpdatedAt: protectionChanged
                  ? now
                  : position.protectionUpdatedAt,
                riskPlanJson: JSON.stringify(riskPlan),
                executedRiskPlanJson: rebuilt
                  ? '{"takeProfits":[],"stopLosses":[]}'
                  : position.executedRiskPlanJson,
                // A Binance basis-price correction restarts the favorable
                // peak only; it never changes dynamic versus fixed stop mode.
                trailingActivationPercent: position.trailingActivationPercent,
                trailingStopPercent: position.trailingStopPercent,
                updatedAt: new Date(),
              }).where(and(
                eq(livePositions.id, position.id),
                eq(livePositions.positionVersion, position.positionVersion),
                eq(livePositions.protectionVersion, position.protectionVersion),
              ));
            }),
          );
          const localAllocatedQuantity = matchingPositions.reduce(
            (sum, position) => sum + position.quantity,
            0,
          );
          const quantityTolerance = Math.max(
            1e-8,
            exchangePosition.quantity * 1e-8,
          );
          if (
            Math.abs(localAllocatedQuantity - exchangePosition.quantity) >
            quantityTolerance
          ) {
            const groupKey = `${credentialId}:${target.symbol}:${target.positionSide}`;
            blockedGroupKeys.add(groupKey);
            await Promise.all(
              matchingPositions.map((position) =>
                db.update(livePositions).set({
                  lastError:
                    `本地分配数量 ${localAllocatedQuantity} 与 Binance 聚合数量 ${exchangePosition.quantity} 不一致，已停止自动减仓并等待对账`,
                  updatedAt: new Date(),
                }).where(eq(livePositions.id, position.id)),
              ),
            );
          }
          continue;
        }
        await Promise.all(
          matchingPositions.map(async (position) => {
            await reconcileMissingLocalPosition(
              position,
              credential,
              keys,
              writeAudit,
            );
            closedIds.add(position.id);
          }),
        );
      }
    } catch {
      lastPositionReconcileAt.delete(key);
    }
  }
  return { closedIds, blockedGroupKeys };
}

async function runOpenPositionReconciliation(
  candidates: Array<typeof livePositions.$inferSelect>,
  now: Date,
) {
  if (openPositionReconciliationRunning)
    return { ...lastOpenPositionReconciliation, running: true, scheduled: false };
  if (now.getTime() < nextOpenPositionReconciliationAt)
    return { ...lastOpenPositionReconciliation, running: false, scheduled: false };
  openPositionReconciliationRunning = true;
  nextOpenPositionReconciliationAt = now.getTime() + POSITION_RECONCILE_INTERVAL_MS;
  try {
    const { closedIds, blockedGroupKeys } =
      await reconcileOpenPositionsWithBinance([...candidates], now);
    lastOpenPositionReconciliation = {
      closedIds,
      blockedGroupKeys,
      completedAt: new Date(),
      error: null,
    };
  } catch (error) {
    nextOpenPositionReconciliationAt = Date.now() + 5_000;
    lastOpenPositionReconciliation = {
      ...lastOpenPositionReconciliation,
      error: error instanceof Error ? error.message : "真实仓位对账失败",
    };
  } finally {
    openPositionReconciliationRunning = false;
  }
  return {
    ...lastOpenPositionReconciliation,
    running: false,
    scheduled: true,
  };
}

const FULL_ACCOUNT_RECONCILE_COMPLETED =
  "FULL_ACCOUNT_POSITION_RECONCILE_COMPLETED";
const FULL_ACCOUNT_POSITION_MISMATCH = "FULL_ACCOUNT_POSITION_MISMATCH";
const FULL_ACCOUNT_RECONCILE_FAILED =
  "FULL_ACCOUNT_POSITION_RECONCILE_FAILED";

function recoveredUnknownEntryRequiresReview(
  position: typeof livePositions.$inferSelect,
) {
  const plan = asRecord(parseJson(position.riskPlanJson));
  const recovery = asRecord(plan.recovery);
  return (
    position.protectionState === "ERROR" &&
    plan.orderOrigin === "RECOVERED_UNKNOWN_ENTRY" &&
    recovery.requiresOperatorReview === true
  );
}

async function reconcileFullAccountPositionsEveryFourHours(now: Date) {
  const db = getDb();
  const credentials = await db
    .select()
    .from(exchangeCredentials)
    .where(and(
      eq(exchangeCredentials.environment, "LIVE"),
      eq(exchangeCredentials.connectionStatus, "VERIFIED"),
    ));
  const result = {
    accounts: 0,
    checked: 0,
    matched: 0,
    mismatched: 0,
    locallyClosed: 0,
    ghostRowsClosed: 0,
    operatorAlerts: 0,
    errors: 0,
    deferred: 0,
    errorDetails: [] as Array<{
      credentialId: number;
      message: string;
    }>,
  };
  for (const credential of credentials) {
    result.accounts += 1;
    if (fullAccountReconcileInFlight.has(credential.id)) {
      result.deferred += 1;
      continue;
    }
    if (
      now.getTime() -
          (fullAccountReconcileLastAttemptAt.get(credential.id) ?? 0) <
        FULL_ACCOUNT_RECONCILE_ERROR_RETRY_MS
    ) {
      result.deferred += 1;
      continue;
    }
    if (!fourHourPositionReconciliationDue({
      nowMs: now.getTime(),
      lastCompletedAtMs:
        fullAccountReconcileLastCompletedAt.get(credential.id) ?? null,
    })) {
      result.deferred += 1;
      continue;
    }
    fullAccountReconcileLastAttemptAt.set(credential.id, now.getTime());
    fullAccountReconcileInFlight.add(credential.id);
    try {
      const keys = {
        apiKey: await decryptCredential(
          credential.apiKeyCiphertext,
          credential.apiKeyIv,
          credentialContext(
            credential.ownerEmail,
            credential.accountId,
            "api-key",
          ),
        ),
        secretKey: await decryptCredential(
          credential.secretKeyCiphertext,
          credential.secretKeyIv,
          credentialContext(
            credential.ownerEmail,
            credential.accountId,
            "secret-key",
          ),
        ),
      };
      const [snapshot, localPositions, pendingOrders] = await Promise.all([
        getLiveAccountPositionSnapshots(keys),
        db.select().from(livePositions).where(and(
          eq(livePositions.ownerEmail, credential.ownerEmail),
          eq(livePositions.accountId, credential.accountId),
          eq(livePositions.credentialId, credential.id),
          eq(livePositions.status, "OPEN"),
        )),
        db.select({
          symbol: liveOrderEvents.symbol,
          positionSide: liveOrderEvents.positionSide,
        }).from(liveOrderEvents).where(and(
          eq(liveOrderEvents.ownerEmail, credential.ownerEmail),
          eq(liveOrderEvents.accountId, credential.accountId),
          eq(liveOrderEvents.credentialId, credential.id),
          inArray(liveOrderEvents.status, [
            "PENDING",
            "SUBMITTED",
            "NEW",
            "PARTIALLY_FILLED",
            "CANCEL_PENDING",
            "EXECUTION_UNKNOWN",
          ]),
        )),
      ]);
      await db.update(exchangeCredentials).set({
        positionMode: snapshot.hedgeMode ? "HEDGE" : "ONE_WAY",
        updatedAt: now,
      }).where(eq(exchangeCredentials.id, credential.id));
      const differences = accountPositionQuantityDifferences({
        local: localPositions.map((position) => ({
          symbol: position.symbol,
          positionSide: position.positionSide,
          quantity: position.quantity,
        })),
        exchange: snapshot.positions.map((position) => ({
          symbol: position.symbol,
          positionSide: position.positionSide,
          quantity: position.quantity,
        })),
      });
      result.checked += 1;
      for (const difference of differences) {
        const groupPositions = localPositions.filter(
          (position) =>
            position.symbol === difference.symbol &&
            position.positionSide === difference.positionSide,
        );
        if (difference.kind === "MATCH") {
          result.matched += 1;
          await Promise.all(groupPositions.map((position) =>
            db.update(livePositions).set({ lastError: null, updatedAt: now })
              .where(and(
                eq(livePositions.id, position.id),
                eq(livePositions.status, "OPEN"),
                like(
                  livePositions.lastError,
                  "四小时全账户核对发现数量差异%",
                ),
              ))
          ));
          continue;
        }
        result.mismatched += 1;
        const groupHasPendingOrder = pendingOrders.some(
          (order) =>
            order.symbol === difference.symbol &&
            order.positionSide === difference.positionSide,
        );
        if (
          difference.kind === "LOCAL_ONLY" &&
          !groupHasPendingOrder
        ) {
          for (const position of groupPositions) {
            await reconcileMissingLocalPosition(
              position,
              credential,
              keys,
              writeAudit,
            );
            result.locallyClosed += 1;
          }
          continue;
        }
        const tolerance = Math.max(
          1e-8,
          difference.localQuantity * 1e-8,
          difference.exchangeQuantity * 1e-8,
        );
        const recoverableGhosts = groupPositions.filter(
          (position) =>
            recoveredUnknownEntryRequiresReview(position) &&
            Math.abs(position.quantity - difference.difference) <= tolerance,
        );
        if (
          difference.kind === "QUANTITY_MISMATCH" &&
          difference.difference > 0 &&
          recoverableGhosts.length === 1 &&
          !groupHasPendingOrder
        ) {
          const ghost = recoverableGhosts[0]!;
          const [closed] = await db.update(livePositions).set({
            status: "CLOSED",
            exitReason: "EXTERNAL",
            closedAt: now,
            riskLeaseUntil: null,
            pendingCloseClientOrderId: null,
            pendingCloseReason: null,
            pendingCloseQuantity: null,
            pendingClosePlanJson: null,
            lastError:
              "四小时全账户核对确认该恢复记录未对应 Binance 实际仓位；仅关闭本地记录，未发送交易指令",
            updatedAt: now,
          }).where(and(
            eq(livePositions.id, ghost.id),
            eq(livePositions.status, "OPEN"),
            eq(livePositions.protectionState, "ERROR"),
            eq(livePositions.quantity, ghost.quantity),
          )).returning({ id: livePositions.id });
          if (closed) {
            result.ghostRowsClosed += 1;
            await writeAudit(
              {
                email: credential.ownerEmail,
                accountId: credential.accountId,
              },
              "FULL_ACCOUNT_GHOST_POSITION_RECONCILED",
              "live_position",
              String(ghost.id),
              {
                symbol: difference.symbol,
                positionSide: difference.positionSide,
                localQuantity: difference.localQuantity,
                exchangeQuantity: difference.exchangeQuantity,
                ghostQuantity: ghost.quantity,
                reconciliation: "LOCAL_LEDGER_ONLY_NO_EXCHANGE_ORDER",
              },
            );
            continue;
          }
        }
        const message =
          `四小时全账户核对发现数量差异：本地 ${difference.localQuantity}，` +
          `Binance ${difference.exchangeQuantity}；未猜测改账，等待运营核对`;
        await Promise.all(groupPositions.map((position) =>
          db.update(livePositions).set({ lastError: message, updatedAt: now })
            .where(and(
              eq(livePositions.id, position.id),
              eq(livePositions.status, "OPEN"),
            ))
        ));
        await writeAudit(
          {
            email: credential.ownerEmail,
            accountId: credential.accountId,
          },
          FULL_ACCOUNT_POSITION_MISMATCH,
          "live_position_group",
          `${credential.id}:${difference.symbol}:${difference.positionSide}`,
          {
            credentialId: credential.id,
            symbol: difference.symbol,
            positionSide: difference.positionSide,
            kind: difference.kind,
            localQuantity: difference.localQuantity,
            exchangeQuantity: difference.exchangeQuantity,
            difference: difference.difference,
            pendingOrder: groupHasPendingOrder,
            requiresOperatorConfirmation: true,
          },
        );
        result.operatorAlerts += 1;
      }
      fullAccountReconcileLastCompletedAt.set(credential.id, now.getTime());
      await writeAudit(
        {
          email: credential.ownerEmail,
          accountId: credential.accountId,
        },
        FULL_ACCOUNT_RECONCILE_COMPLETED,
        "exchange_credential",
        String(credential.id),
        {
          credentialId: credential.id,
          hedgeMode: snapshot.hedgeMode,
          exchangeGroups: snapshot.positions.length,
          localGroups: new Set(
            localPositions.map(
              (position) => `${position.symbol}:${position.positionSide}`,
            ),
          ).size,
          matched: differences.filter((item) => item.kind === "MATCH").length,
          mismatched: differences.filter((item) => item.kind !== "MATCH").length,
          latencyMs: snapshot.latencyMs,
          usedWeight: snapshot.usedWeight,
        },
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message.slice(0, 240)
        : "四小时全账户仓位核对失败";
      result.errors += 1;
      result.errorDetails.push({
        credentialId: credential.id,
        message,
      });
      // A long-running runner usually consumes the response before an
      // operator can inspect it. Persist a sanitised failure so a four-hour
      // reconciliation can never fail silently. Never include credentials or
      // upstream request headers in this record.
      console.error(JSON.stringify({
        scope: "full-account-position-reconciliation",
        credentialId: credential.id,
        message,
      }));
      try {
        await writeAudit(
          {
            email: credential.ownerEmail,
            accountId: credential.accountId,
          },
          FULL_ACCOUNT_RECONCILE_FAILED,
          "exchange_credential",
          String(credential.id),
          { credentialId: credential.id, message },
        );
      } catch {
        // The original error remains in the service log even if audit storage
        // itself is the failing dependency.
      }
    } finally {
      fullAccountReconcileInFlight.delete(credential.id);
    }
  }
  return result;
}

async function runFullAccountPositionReconciliation(now: Date) {
  if (fullAccountReconcileRunning) {
    return {
      ...lastFullAccountReconcileSummary,
      running: true,
      scheduled: false,
    };
  }
  fullAccountReconcileRunning = true;
  try {
    const summary = await reconcileFullAccountPositionsEveryFourHours(now);
    lastFullAccountReconcileSummary = {
      ...summary,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error(JSON.stringify({
      scope: "full-account-position-reconciliation-scheduler",
      message: error instanceof Error
        ? error.message.slice(0, 240)
        : "四小时全账户仓位核对调度失败",
    }));
  } finally {
    fullAccountReconcileRunning = false;
  }
  return {
    ...lastFullAccountReconcileSummary,
    running: false,
    scheduled: true,
  };
}







type PositionManagementOpportunity = PositionManagementDecision & {
  observedMinute: number;
  opportunityId: string;
  traceId: string;
  observedAtMs: number;
  validUntilMs: number;
  structureExitAuthorized: boolean;
  evidenceRiskReductionAuthorized: boolean;
  evidenceRiskExitAuthorized: boolean;
  evidenceRiskClosePercent: number | null;
  capitalEfficiencyWaveAssessment: ReturnType<
    typeof assessCapitalEfficiencyWave
  >;
  evidenceGate?: {
    effective: boolean;
  };
  nexusPositionStateMachine?: NexusPositionStateSnapshot | null;
};
type PositionAdditionExecutionOutcome = {
  executed: boolean;
  attempted: boolean;
  reason: string;
  currentRoePercent?: number | null;
  recoveryFromTroughRoePoints?: number | null;
  quantity?: number;
  entryPrice?: number;
  detail?: string;
};
type PositionManagementActionReference = {
  opportunityId: string;
  traceId: string;
  observedMinute: number;
  observedAtMs: number;
  validUntilMs: number | null;
};
const POSITION_ADDITION_MODEL_MINUTES = [5, 30, 60] as const;

function positionManagementActionReference(
  opportunity: PositionManagementOpportunity | null,
): PositionManagementActionReference | null {
  if (!opportunity?.opportunityId || !opportunity.traceId) return null;
  return {
    opportunityId: opportunity.opportunityId,
    traceId: opportunity.traceId,
    observedMinute: opportunity.observedMinute,
    observedAtMs: opportunity.observedAtMs,
    validUntilMs: opportunity.validUntilMs,
  };
}

function trailingEvidenceMode(
  opportunity: PositionManagementOpportunity | null,
): Parameters<typeof dynamicProfitProtection>[0]["evidenceMode"] {
  if (!opportunity?.evidenceGate?.effective) return "UNAVAILABLE";
  if (opportunity.state === "TREND_INVALIDATED") return "INVALIDATED";
  if (
    opportunity.contractTrendProfile?.observationHorizonExpired === true &&
    opportunity.action === "TIGHTEN_PROFIT_PROTECTION"
  ) return "HORIZON_EXPIRED";
  if (
    opportunity.contractTrendProfile?.profitProtectionBias ===
    "ALLOW_NORMAL_PULLBACK"
  ) return "CONTINUATION";
  if (
    opportunity.contractTrendProfile?.profitProtectionBias ===
    "TIGHTEN_ON_GIVEBACK"
  ) return "WEAKENING";
  if (
    opportunity.state === "PROFIT_CONTINUATION" ||
    opportunity.continuationEvidence
  ) return "CONTINUATION";
  if (opportunity.state === "PROFIT_PROTECT") return "WEAKENING";
  return "NEUTRAL";
}

async function recordPositionManagementReductionOutcome(input: {
  reference: PositionManagementActionReference | null;
  reason: "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP" | "TIME_EXIT";
  structureExit: boolean;
  clientOrderId: string;
  exchangeOrderId: string;
  quantity: number;
  exitPrice: number;
  remainingQuantity: number;
  closed: boolean;
}) {
  if (!input.reference) return;
  const db = getDb();
  const [sample] = await db
    .select({
      id: strategyPositionEvidence.id,
      strategyId: strategyPositionEvidence.strategyId,
      evidenceJson: strategyPositionEvidence.evidenceJson,
    })
    .from(strategyPositionEvidence)
    .where(and(
      eq(strategyPositionEvidence.traceId, input.reference.traceId),
      eq(
        strategyPositionEvidence.minuteOffset,
        input.reference.observedMinute,
      ),
    ))
    .limit(1);
  if (!sample) return;
  const evidence = asRecord(parseJson(sample.evidenceJson));
  const previous = asRecord(evidence.positionManagementExecutionOutcome);
  if (
    String(previous.exchangeOrderId ?? "") === input.exchangeOrderId &&
    previous.status === "EXECUTED"
  ) return;
  await db
    .update(strategyPositionEvidence)
    .set({
      evidenceJson: JSON.stringify({
        ...evidence,
        positionManagementExecutionOutcome: {
          opportunityId: input.reference.opportunityId,
          observedAtMs: input.reference.observedAtMs,
          validUntilMs: input.reference.validUntilMs,
          status: "EXECUTED",
          executor: input.structureExit
            ? "DISCIPLINARY_MARKET_EXIT"
            : "CONFIGURED_RISK_PLAN",
          reason: input.reason,
          clientOrderId: input.clientOrderId,
          exchangeOrderId: input.exchangeOrderId,
          quantity: input.quantity,
          exitPrice: input.exitPrice,
          remainingQuantity: input.remainingQuantity,
          closed: input.closed,
          recordedAtMs: Date.now(),
        },
      }),
    })
    .where(eq(strategyPositionEvidence.id, sample.id));
  if (sample.strategyId > 0)
    await appendStrategyPositionManagementEvent({
      traceId: input.reference.traceId,
      strategyId: sample.strategyId,
      eventType:
        `POSITION_MANAGEMENT_EXECUTED:${input.reference.opportunityId}`,
      outcome: "INFO",
      message:
        `持仓判断 ${input.reference.opportunityId} 已由` +
        `${input.structureExit ? "结构退出" : "既定保护计划"}执行；` +
        `成交 ${input.quantity}，剩余 ${input.remainingQuantity}。`,
      detail: {
        opportunityId: input.reference.opportunityId,
        executor: input.structureExit
          ? "DISCIPLINARY_MARKET_EXIT"
          : "CONFIGURED_RISK_PLAN",
        reason: input.reason,
        clientOrderId: input.clientOrderId,
        exchangeOrderId: input.exchangeOrderId,
        quantity: input.quantity,
        exitPrice: input.exitPrice,
        remainingQuantity: input.remainingQuantity,
        closed: input.closed,
      },
      eventAt: new Date(),
    });
}

async function recordPositionAdditionExecutionOutcome(
  opportunity: PositionManagementOpportunity | null,
  outcome: PositionAdditionExecutionOutcome,
) {
  if (
    !opportunity ||
    !["ADD_ELIGIBLE", "SCALE_IN_ELIGIBLE"].includes(opportunity.action)
  ) return;
  const db = getDb();
  const [sample] = await db
    .select({
      id: strategyPositionEvidence.id,
      evidenceJson: strategyPositionEvidence.evidenceJson,
    })
    .from(strategyPositionEvidence)
    .where(and(
      eq(strategyPositionEvidence.traceId, opportunity.traceId),
      eq(strategyPositionEvidence.minuteOffset, opportunity.observedMinute),
    ))
    .limit(1);
  if (!sample) return;
  const evidence = asRecord(parseJson(sample.evidenceJson));
  await db
    .update(strategyPositionEvidence)
    .set({
      evidenceJson: JSON.stringify({
        ...evidence,
        positionAdditionExecution: {
          opportunityId: opportunity.opportunityId,
          evaluatedAtMs: Date.now(),
          executed: outcome.executed,
          attempted: outcome.attempted,
          reason: outcome.reason,
          currentRoePercent: outcome.currentRoePercent ?? null,
          recoveryFromTroughRoePoints:
            outcome.recoveryFromTroughRoePoints ?? null,
          quantity: outcome.quantity ?? null,
          entryPrice: outcome.entryPrice ?? null,
          detail: outcome.detail ?? null,
        },
      }),
    })
    .where(eq(strategyPositionEvidence.id, sample.id));
}

async function recordPositionAdditionEvidence(input: {
  position: typeof livePositions.$inferSelect;
  markPrice: number;
  backfillBudget: { remaining: number };
  terminalClose?: {
    closedAtMs: number;
    exitPrice: number;
  } | null;
}) {
  if (
    input.position.additionCount <= 0 &&
    !input.position.lastAdditionClientOrderId
  ) return 0;
  const db = getDb();
  const additions = await db
    .select()
    .from(livePositionAdditions)
    .where(and(
      eq(livePositionAdditions.positionId, input.position.id),
      eq(livePositionAdditions.status, "SUBMITTED"),
      isNotNull(livePositionAdditions.entryPrice),
    ))
    .orderBy(desc(livePositionAdditions.createdAt))
    .limit(5);
  if (!additions.length) return 0;
  const existingSamples = await db
    .select({
      additionId: livePositionAdditionEvidence.additionId,
      minuteOffset: livePositionAdditionEvidence.minuteOffset,
    })
    .from(livePositionAdditionEvidence)
    .where(inArray(
      livePositionAdditionEvidence.additionId,
      additions.map((addition) => addition.id),
    ));
  const existingKeys = new Set(
    existingSamples.map(
      (sample) => `${sample.additionId}:${sample.minuteOffset}`,
    ),
  );
  let inserted = 0;
  const sampledAt = new Date();
  for (const addition of additions) {
    if (!addition.entryPrice || addition.entryPrice <= 0) continue;
    const additionResponse = asRecord(parseJson(addition.responseJson));
    const fillAnchor = positionAdditionFillAnchor({
      exchangeOrder: additionResponse,
      createdAtMs: addition.createdAt.getTime(),
      confirmedAtMs: addition.updatedAt.getTime(),
      observedAtMs: sampledAt.getTime(),
    });
    const elapsedMinutes = Math.floor(
      (sampledAt.getTime() - fillAnchor.anchorAtMs) / 60_000,
    );
    const candidateMilestones = input.terminalClose
      ? [...POSITION_ADDITION_MODEL_MINUTES]
      : POSITION_ADDITION_MODEL_MINUTES.filter(
          (minuteOffset) => elapsedMinutes >= minuteOffset,
        );
    const missingMilestones = candidateMilestones.filter(
      (minuteOffset) =>
        !existingKeys.has(`${addition.id}:${minuteOffset}`),
    );
    if (!missingMilestones.length) continue;
    const delayedMilestones = missingMilestones.filter(
      (minuteOffset) =>
        sampledAt.getTime() -
          (fillAnchor.anchorAtMs + minuteOffset * 60_000) >
          90_000 &&
        (
          !input.terminalClose ||
          fillAnchor.anchorAtMs + minuteOffset * 60_000 <
            input.terminalClose.closedAtMs
        ),
    );
    let backfillCandles: Awaited<
      ReturnType<typeof getBinanceLiveMarkPriceKlinesRange>
    > = [];
    if (delayedMilestones.length && input.backfillBudget.remaining > 0) {
      input.backfillBudget.remaining -= 1;
      const finalOffset = Math.max(...delayedMilestones);
      try {
        backfillCandles = await getBinanceLiveMarkPriceKlinesRange(
          addition.symbol,
          "1m",
          Math.floor(fillAnchor.anchorAtMs / 60_000) * 60_000,
          fillAnchor.anchorAtMs + (finalOffset + 1) * 60_000,
          Math.min(100, finalOffset + 2),
        );
      } catch {
        // 历史标记价格缺失时不以恢复时现价伪造旧时间点样本。
      }
    }
    for (const minuteOffset of missingMilestones) {
      const scheduledAt = new Date(
        fillAnchor.anchorAtMs + minuteOffset * 60_000,
      );
      const learningMark = selectPositionAdditionLearningMark({
        scheduledAtMs: scheduledAt.getTime(),
        sampledAtMs: sampledAt.getTime(),
        liveMarkPrice: input.markPrice,
        candles: backfillCandles,
        terminalClose: input.terminalClose,
      });
      if (!learningMark) continue;
      const additionRoePercent = positionRoePercent(
        addition.entryPrice,
        learningMark.markPrice,
        input.position.leverage,
        input.position.positionSide,
      );
      const additionDecision = asRecord(parseJson(addition.decisionJson));
      const additionModelVersion =
        typeof additionDecision.modelVersion === "string"
          ? additionDecision.modelVersion
          : POSITION_MANAGEMENT_MODEL_VERSION;
      const previousQuantity = Number(
        additionResponse.previousQuantity ??
          additionDecision.previousQuantity,
      );
      const previousEntryPrice = Number(
        additionResponse.previousEntryPrice ??
          additionDecision.previousEntryPrice,
      );
      const rawCompositeEntryPrice = Number(
        additionResponse.combinedEntryPrice,
      );
      const compositeEntryPrice =
        Number.isFinite(rawCompositeEntryPrice) &&
          rawCompositeEntryPrice > 0
          ? rawCompositeEntryPrice
          : input.position.entryPrice;
      const compositeRoePercent = positionRoePercent(
        compositeEntryPrice,
        learningMark.markPrice,
        input.position.leverage,
        input.position.positionSide,
      );
      const counterfactualOriginalRoePercent =
        Number.isFinite(previousEntryPrice) && previousEntryPrice > 0
          ? positionRoePercent(
              previousEntryPrice,
              learningMark.markPrice,
              input.position.leverage,
              input.position.positionSide,
            )
          : null;
      const compositeRoeImprovement =
        counterfactualOriginalRoePercent === null
          ? null
          : compositeRoePercent - counterfactualOriginalRoePercent;
      const netEffect =
        compositeRoeImprovement !== null &&
          Number.isFinite(previousQuantity) &&
          previousQuantity > 0 &&
          Number.isFinite(previousEntryPrice) &&
          previousEntryPrice > 0
          ? estimatePositionAdditionNetEffect({
              previousQuantity,
              previousEntryPrice,
              addedQuantity: addition.quantity,
              addedEntryPrice: addition.entryPrice,
              leverage: input.position.leverage,
              grossAdditionRoePercent: additionRoePercent,
              grossCompositeRoeImprovement: compositeRoeImprovement,
            })
          : null;
      const [written] = await db
        .insert(livePositionAdditionEvidence)
        .values({
          additionId: addition.id,
          positionId: input.position.id,
          minuteOffset,
          scheduledAt,
          sampledAt,
          sampleDelayMs: sampledAt.getTime() - scheduledAt.getTime(),
          markPrice: learningMark.markPrice,
          additionEntryPrice: addition.entryPrice,
          additionRoePercent,
          compositeEntryPrice,
          compositeRoePercent,
          evidenceJson: JSON.stringify({
            modelVersion: additionModelVersion,
            source: learningMark.source,
            candleOpenTime: learningMark.candleOpenTime,
            candleCloseTime: learningMark.candleCloseTime,
            fillAnchorAtMs: fillAnchor.anchorAtMs,
            fillAnchorSource: fillAnchor.source,
            terminalClosedAtMs: input.terminalClose?.closedAtMs ?? null,
            decision: parseJson(addition.decisionJson),
            previousEntryPrice:
              Number.isFinite(previousEntryPrice) && previousEntryPrice > 0
                ? previousEntryPrice
                : null,
            counterfactualOriginalRoePercent,
            compositeRoeImprovement,
            estimatedRoundTripFeePercent:
              netEffect?.estimatedRoundTripFeePercent ?? null,
            estimatedAdditionFeeRoePercent:
              netEffect?.estimatedAdditionFeeRoePercent ?? null,
            estimatedCompositeFeeRoePercent:
              netEffect?.estimatedCompositeFeeRoePercent ?? null,
            netAdditionRoePercent:
              netEffect?.netAdditionRoePercent ?? null,
            netCompositeRoeImprovement:
              netEffect?.netCompositeRoeImprovement ?? null,
            purpose:
              "COMPARE_FEE_ADJUSTED_ADD_ON_WITH_COMPOSITE_POSITION_AT_5_30_60_MINUTES",
          }),
          createdAt: sampledAt,
        })
        .onConflictDoNothing()
        .returning({ id: livePositionAdditionEvidence.id });
      if (written) inserted += 1;
      if (written) existingKeys.add(`${addition.id}:${minuteOffset}`);
    }
  }
  return inserted;
}

async function backfillClosedPositionAdditionEvidence(
  now: Date,
  backfillBudget: { remaining: number },
) {
  if (
    now.getTime() - lastClosedPositionAdditionBackfillAt <
    POSITION_RECONCILE_INTERVAL_MS
  )
    return { sampled: 0, deferred: true, reason: "INTERVAL_WAIT" };
  lastClosedPositionAdditionBackfillAt = now.getTime();
  const db = getDb();
  const positions = await db
    .select()
    .from(livePositions)
    .where(and(
      eq(livePositions.status, "CLOSED"),
      isNotNull(livePositions.closedAt),
      isNotNull(livePositions.lastAdditionClientOrderId),
    ))
    .orderBy(desc(livePositions.closedAt))
    .limit(20);
  if (!positions.length)
    return { sampled: 0, deferred: false, reason: "NO_CLOSED_ADDITION" };
  const additions = await db
    .select({
      id: livePositionAdditions.id,
      positionId: livePositionAdditions.positionId,
    })
    .from(livePositionAdditions)
    .where(and(
      inArray(
        livePositionAdditions.positionId,
        positions.map((position) => position.id),
      ),
      eq(livePositionAdditions.status, "SUBMITTED"),
    ));
  if (!additions.length)
    return { sampled: 0, deferred: false, reason: "NO_FILLED_ADDITION" };
  const evidence = await db
    .select({
      additionId: livePositionAdditionEvidence.additionId,
      minuteOffset: livePositionAdditionEvidence.minuteOffset,
    })
    .from(livePositionAdditionEvidence)
    .where(inArray(
      livePositionAdditionEvidence.additionId,
      additions.map((addition) => addition.id),
    ));
  const evidenceKeys = new Set(
    evidence.map((row) => `${row.additionId}:${row.minuteOffset}`),
  );
  const incompletePositionId = additions.find((addition) =>
    POSITION_ADDITION_MODEL_MINUTES.some(
      (minuteOffset) =>
        !evidenceKeys.has(`${addition.id}:${minuteOffset}`),
    )
  )?.positionId;
  const position = positions.find(
    (candidate) => candidate.id === incompletePositionId,
  );
  if (
    !position ||
    !position.closedAt ||
    !Number.isFinite(position.markPrice) ||
    position.markPrice <= 0
  )
    return { sampled: 0, deferred: false, reason: "NO_INCOMPLETE_TERMINAL" };
  const sampled = await recordPositionAdditionEvidence({
    position,
    markPrice: position.markPrice,
    backfillBudget,
    terminalClose: {
      closedAtMs: position.closedAt.getTime(),
      exitPrice: position.markPrice,
    },
  });
  return {
    sampled,
    deferred: sampled === 0,
    reason: sampled ? "TERMINAL_SAMPLES_WRITTEN" : "TERMINAL_SAMPLE_WAIT",
    positionId: position.id,
  };
}

async function maybeExecutePositionAddition(input: {
  position: typeof livePositions.$inferSelect;
  currentRoePercent: number;
  opportunity: PositionManagementOpportunity | null;
}) {
  const { position, currentRoePercent, opportunity } = input;
  // Duplicate new entries remain forbidden. This independent addition intent
  // is available only to a strategy-owned position. Rebound and profitable
  // continuation additions have separate, default-off strategy switches;
  // manual and semi-auto positions never enter this executor.
  if (
    !opportunity ||
    !["ADD_ELIGIBLE", "SCALE_IN_ELIGIBLE"].includes(opportunity.action)
  )
    return { executed: false, attempted: false, reason: "NO_ELIGIBLE_ADD_ON" };
  if (!position.positionHandoffKey)
    return {
      executed: false,
      attempted: false,
      reason: "POSITION_HANDOFF_MISSING",
    };
  const additionMode =
    opportunity.action === "SCALE_IN_ELIGIBLE"
      ? "PROFIT_SCALE_IN" as const
      : "REBOUND_ADD_ON" as const;
  if (!opportunity.nexusPositionStateMachine?.additionCandidate)
    return {
      executed: false,
      attempted: false,
      reason: "ADD_ON_WAITING_FOR_SECOND_INDEPENDENT_CONFIRMATION",
    };
  if (additionMode === "REBOUND_ADD_ON" && currentRoePercent >= 0)
    return {
      executed: false,
      attempted: false,
      reason: "REBOUND_ADD_ON_REQUIRES_OPEN_LOSS",
      currentRoePercent,
    };
  if (additionMode === "PROFIT_SCALE_IN" && currentRoePercent <= 0)
    return {
      executed: false,
      attempted: false,
      reason: "PROFIT_SCALE_IN_REQUIRES_OPEN_PROFIT",
      currentRoePercent,
    };
  const nowMs = Date.now();
  if (
    !opportunity.opportunityId ||
    !Number.isFinite(opportunity.observedAtMs) ||
    !Number.isFinite(opportunity.validUntilMs) ||
    nowMs < opportunity.observedAtMs ||
    nowMs > opportunity.validUntilMs
  )
    return {
      executed: false,
      attempted: false,
      reason: "ADD_ON_OPPORTUNITY_EXPIRED",
    };
  const db = getDb();
  const positionMemory = readNexusPositionMemory(position.riskPlanJson, position);
  const [trace] = await db
    .select({
      strategyId: strategyExecutionTraces.strategyId,
      configVersion: strategyExecutionTraces.configVersion,
      configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
    })
    .from(strategyExecutionTraces)
    .where(and(
      positionMemory.traceId
        ? eq(strategyExecutionTraces.traceId, positionMemory.traceId)
        : eq(strategyExecutionTraces.positionId, String(position.id)),
      eq(strategyExecutionTraces.ownerEmail, position.ownerEmail),
      eq(strategyExecutionTraces.accountId, position.accountId),
      eq(strategyExecutionTraces.state, "POSITION_OPEN"),
    ))
    .limit(1);
  if (!trace)
    return { executed: false, attempted: false, reason: "MANUAL_POSITION" };
  const config = await loadBoundLiquidationTrendConfig(trace);
  const management = config.risk.positionManagement;
  if (
    !management ||
    (additionMode === "REBOUND_ADD_ON"
      ? !management.addOnEnabled
      : !management.profitScaleInEnabled)
  )
    return { executed: false, attempted: false, reason: "ADD_ON_DISABLED" };
  const progress = parseExecutedPlan(position.executedRiskPlanJson);
  if (progress.takeProfits.length || progress.stopLosses.length)
    return {
      executed: false,
      attempted: false,
      reason: "POSITION_ALREADY_REDUCED",
    };

  const additions = await db
    .select()
    .from(livePositionAdditions)
    .where(eq(livePositionAdditions.positionId, position.id))
    .orderBy(desc(livePositionAdditions.createdAt))
    .limit(20);
  const committedAdditions = additions.filter((addition) =>
    ["PENDING", "SUBMITTED", "EXECUTION_UNKNOWN"].includes(addition.status)
  );
  if (committedAdditions.length >= management.maxAddOnsPerPosition)
    return { executed: false, attempted: false, reason: "ADD_ON_COUNT_LIMIT" };
  const latestCommitted = committedAdditions[0];
  const latestCommittedAnchor = latestCommitted
    ? positionAdditionFillAnchor({
        exchangeOrder:
          latestCommitted.status === "SUBMITTED"
            ? asRecord(parseJson(latestCommitted.responseJson))
            : null,
        createdAtMs: latestCommitted.createdAt.getTime(),
        confirmedAtMs:
          latestCommitted.status === "SUBMITTED"
            ? latestCommitted.updatedAt.getTime()
            : null,
      }).anchorAtMs
    : null;
  if (
    latestCommitted &&
    latestCommittedAnchor !== null &&
    Date.now() - latestCommittedAnchor <
      management.minMinutesBetweenAddOns * 60_000
  )
    return { executed: false, attempted: false, reason: "ADD_ON_COOLDOWN" };

  const [
    symbol,
    credential,
    account,
    strategy,
    sameDirectionPositions,
  ] =
    await Promise.all([
      db
        .select()
        .from(contractSymbols)
        .where(and(
          eq(contractSymbols.symbol, position.symbol),
          eq(contractSymbols.isActive, true),
        ))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select()
        .from(exchangeCredentials)
        .where(and(
          eq(exchangeCredentials.id, position.credentialId),
          eq(exchangeCredentials.ownerEmail, position.ownerEmail),
        ))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select()
        .from(tradingAccounts)
        .where(and(
          eq(tradingAccounts.ownerEmail, position.ownerEmail),
          eq(tradingAccounts.accountId, position.accountId),
        ))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({
          status: strategies.status,
          brainKey: strategies.brainKey,
          configVersion: strategies.configVersion,
          configJson: strategies.configJson,
        })
        .from(strategies)
        .where(and(
          eq(strategies.id, trace.strategyId),
          eq(strategies.ownerEmail, position.ownerEmail),
          eq(strategies.accountId, position.accountId),
        ))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ id: livePositions.id })
        .from(livePositions)
        .where(and(
          eq(livePositions.ownerEmail, position.ownerEmail),
          eq(livePositions.accountId, position.accountId),
          eq(livePositions.symbol, position.symbol),
          eq(livePositions.positionSide, position.positionSide),
          inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
        )),
    ]);
  if (!symbol || !credential || !account)
    return { executed: false, attempted: false, reason: "ACCOUNT_OR_SYMBOL_MISSING" };
  if (!strategy || strategy.status !== "RUNNING")
    return { executed: false, attempted: false, reason: "STRATEGY_NOT_RUNNING" };
  if (
    additionMode === "REBOUND_ADD_ON" &&
    currentRoePercent < -management.maxAddOnLossRoePercent
  )
    return {
      executed: false,
      attempted: false,
      reason: "LOSS_EXCEEDS_ADD_ON_RANGE",
    };
  if (sameDirectionPositions.length !== 1)
    return {
      executed: false,
      attempted: false,
      reason: "AMBIGUOUS_AGGREGATED_POSITION",
    };
  if (
    !account.isActive ||
    account.executionMode !== "LIVE" ||
    account.accountType === "MAIN" ||
    credential.connectionStatus !== "VERIFIED" ||
    credential.lastError ||
    !credential.lastVerifiedAt
  )
    return { executed: false, attempted: false, reason: "ACCOUNT_NOT_READY" };

  const systemMetrics = await getBinanceLiveSystemMetrics();
  const restCapacity = evaluateAutomatedEntryRestCapacity({
    rest: systemMetrics.rest,
    requiredRemainingWeight:
      LIQUIDATION_PILOT_LIMITS.minRestRemainingWeightBeforeEntry,
  });
  if (!restCapacity.allowed)
    return { executed: false, attempted: false, reason: "REST_CAPACITY_WAIT" };

  const strategyDailyPnl = await readTradingStrategyDailyPnl(
    { email: position.ownerEmail, accountId: position.accountId },
    account,
    trace.strategyId,
  );
  const effectiveDailyLossLimit = config.risk.dailyLossLimitUsdt;
  if (strategyDailyPnl.dailyPnl <= -effectiveDailyLossLimit)
    return { executed: false, attempted: false, reason: "DAILY_LOSS_LIMIT" };

  const { startedAt: dayStartedAt } = chinaTradingDayWindow();
  const [openPositions, pendingOrders, dailyOrders] = await Promise.all([
    db
      .select({
        quantity: livePositions.quantity,
        markPrice: livePositions.markPrice,
        leverage: livePositions.leverage,
      })
      .from(livePositions)
      .where(and(
        eq(livePositions.ownerEmail, position.ownerEmail),
        eq(livePositions.accountId, position.accountId),
        inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
      )),
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
      .where(and(
        eq(liveOrderEvents.ownerEmail, position.ownerEmail),
        eq(liveOrderEvents.accountId, position.accountId),
        eq(liveOrderEvents.testOnly, false),
        inArray(liveOrderEvents.status, [
          "PENDING",
          "NEW",
          "PARTIALLY_FILLED",
          "CANCEL_PENDING",
          "EXECUTION_UNKNOWN",
        ]),
      )),
    db
      .select({ estimatedNotional: liveOrderEvents.estimatedNotional })
      .from(liveOrderEvents)
      .where(and(
        eq(liveOrderEvents.ownerEmail, position.ownerEmail),
        eq(liveOrderEvents.accountId, position.accountId),
        eq(liveOrderEvents.testOnly, false),
        gte(liveOrderEvents.createdAt, dayStartedAt),
        inArray(liveOrderEvents.status, [
          "PENDING",
          "NEW",
          "PARTIALLY_FILLED",
          "SUBMITTED",
          "FILLED",
          "CANCEL_PENDING",
          "EXECUTION_UNKNOWN",
        ]),
      )),
  ]);
  const orderConcurrency = evaluateAutomatedOrderConcurrency({
    orders: pendingOrders,
    targetSymbol: position.symbol,
    targetPositionSide: position.positionSide,
    positionMode: credential.positionMode ?? "ONE_WAY",
  });
  if (
    !orderConcurrency.allowed &&
    (
      orderConcurrency.code === "EXECUTION_UNKNOWN_ORDER" ||
      config.execution.sameLegWorkingOrderPolicy !== "ALLOW"
    )
  )
    return {
      executed: false,
      attempted: false,
      reason: orderConcurrency.code === "EXECUTION_UNKNOWN_ORDER"
        ? "EXECUTION_UNKNOWN_ORDER"
        : "SAME_LEG_PENDING_ORDER",
    };
  let executionMark: Awaited<ReturnType<typeof getBinanceLiveMarkPrices>>[number];
  try {
    [executionMark] = await getBinanceLiveMarkPrices([position.symbol]);
  } catch {
    return { executed: false, attempted: false, reason: "ADD_ON_MARK_STALE" };
  }
  const revalidation = revalidatePositionAdditionOpportunity({
    nowMs: Date.now(),
    observedAtMs: opportunity.observedAtMs,
    validUntilMs: opportunity.validUntilMs,
    markTimeMs: Number(executionMark?.time),
    maxMarkAgeMs: 5_000,
    markPrice: Number(executionMark?.markPrice),
    entryPrice: position.entryPrice,
    leverage: position.leverage,
    positionSide: position.positionSide,
    worstRoePercent: opportunity.worstRoePercent,
    bestRoePercent: opportunity.bestRoePercent,
    bottomRecoveryRoePoints: management.bottomRecoveryRoePoints,
    maxAddOnLossRoePercent: management.maxAddOnLossRoePercent,
    mode: additionMode,
    maxProfitGivebackRoePoints: management.profitGivebackRoePoints,
  });
  if (!revalidation.allowed)
    return {
      executed: false,
      attempted: false,
      reason: revalidation.reason,
      currentRoePercent: revalidation.currentRoePercent,
      recoveryFromTroughRoePoints:
        revalidation.recoveryFromTroughRoePoints,
    };
  const executionMarkPrice = Number(executionMark.markPrice);
  const revalidatedRoePercent = Number(revalidation.currentRoePercent);
  const size = smallestPilotQuantity({
    markPrice: executionMarkPrice,
    minOrderQty: symbol.minOrderQty,
    quantityStep: symbol.quantityStep,
    minNotionalUsdt: symbol.minNotionalUsdt,
    leverage: position.leverage,
    targetNotionalUsdt: management.addOnNotionalUsdt,
    maxOrderNotionalUsdt: config.execution.maxOrderNotionalUsdt,
  });
  if (!size)
    return { executed: false, attempted: false, reason: "ADD_ON_SIZE_INVALID" };
  const dailyMargin = dailyOrders.reduce(
    (sum, order) => sum + order.estimatedNotional,
    0,
  ) / Math.max(position.leverage, 1);
  const requiredMargin = size.requiredMargin;
  // Funding synchronization belongs to the independent account-audit plane.
  // A slow Binance account endpoint must never hold the position-intelligence
  // or protection lanes. Daily accumulated entry margin is telemetry only;
  // Binance performs the authoritative exchange-side margin check.
  const fundingSnapshot = accountFundingSnapshot(credential);
  const cachedBinanceAvailableBalance = Math.max(
    fundingSnapshot.availableToOpenUsdt ?? 0,
    0,
  );
  const executionReservationCapacity = cachedBinanceAvailableBalance;
  const orderCapacity = calculateAutomatedOrderCapacity({
    usedMarginUsdt: dailyMargin,
    limitMarginUsdt: config.execution.maxDailyNotionalUsdt,
    requiredMarginUsdt: requiredMargin,
    binanceAvailableMarginUsdt: cachedBinanceAvailableBalance,
  });
  if (!orderCapacity.canSubmit)
    return {
      executed: false,
      attempted: false,
      reason: orderCapacity.blockerCode,
      capacityMessage: automatedOrderCapacityMessage(
        orderCapacity,
        "加仓证据已经通过",
      ),
      dailyMarginUsdt: orderCapacity.usedMarginUsdt,
      dailyMarginAdvisoryOnly: true,
      requiredMarginUsdt: orderCapacity.requiredMarginUsdt,
      configuredDailyMarginReferenceUsdt:
        orderCapacity.configuredLimitMarginUsdt,
    };
  const committedMargin =
    openPositions.reduce(
      (sum, row) =>
        sum + row.quantity * row.markPrice / Math.max(row.leverage, 1),
      0,
    ) +
    pendingOrders.reduce(
      (sum, row) =>
        sum + pendingOrderReservedMargin(row, position.leverage),
      0,
    );
  const capacity = calculateStrategyMarginCapacity({
    availableBalance: executionReservationCapacity,
    committedMargin,
    requiredMargin,
    maxUsagePercent: config.risk.maxMarginUsagePercent,
  });
  // Add-ons share the same authoritative capital boundary as new entries.
  // Idempotency, unknown-order and central reservation gates prevent system
  // runaway without a second hidden reserve-percent rejection.
  const usableBalance = executionReservationCapacity;

  const sequence = committedAdditions.length + 1;
  const finalRevalidation = revalidatePositionAdditionOpportunity({
    nowMs: Date.now(),
    observedAtMs: opportunity.observedAtMs,
    validUntilMs: opportunity.validUntilMs,
    markTimeMs: executionMark.time,
    maxMarkAgeMs: 5_000,
    markPrice: executionMarkPrice,
    entryPrice: position.entryPrice,
    leverage: position.leverage,
    positionSide: position.positionSide,
    worstRoePercent: opportunity.worstRoePercent,
    bestRoePercent: opportunity.bestRoePercent,
    bottomRecoveryRoePoints: management.bottomRecoveryRoePoints,
    maxAddOnLossRoePercent: management.maxAddOnLossRoePercent,
    mode: additionMode,
    maxProfitGivebackRoePoints: management.profitGivebackRoePoints,
  });
  if (!finalRevalidation.allowed)
    return {
      executed: false,
      attempted: false,
      reason: finalRevalidation.reason,
    };
  if (!strategy.brainKey)
    return {
      executed: false,
      attempted: false,
      reason: "ENTRY_BRAIN_IDENTITY_MISSING",
    };
  const additionTraceId = [
    position.lifecycleId ?? `position-${position.id}`,
    "increase",
    opportunity.opportunityId,
  ].join(":");
  const coordinatedIncrease = await authorizePositionIncreaseEntry(
    {
      strategyId: trace.strategyId,
      brainKey: strategy.brainKey,
      configVersion: strategy.configVersion ?? trace.configVersion,
      traceId: additionTraceId,
      livePositionId: position.id,
      positionHandoffKey: position.positionHandoffKey,
      ownerEmail: position.ownerEmail,
      accountId: position.accountId,
      symbol: position.symbol,
      positionSide: position.positionSide,
      positionMode: credential.positionMode ?? "ONE_WAY",
      orderType: "MARKET",
      quantity: size.quantity,
      requiredMarginUsdt: requiredMargin,
      riskBudgetUsdt: requiredMargin,
      riskClass: "STANDARD",
      priority: additionMode === "PROFIT_SCALE_IN" ? 65 : 35,
      observedAt: opportunity.observedAtMs,
      expiresAt: opportunity.validUntilMs,
    },
    executionReservationCapacity,
  );
  if (
    !coordinatedIncrease.decision.executionOwner ||
    coordinatedIncrease.decision.status !== "RESERVED"
  )
    return {
      executed: false,
      attempted: false,
      reason: coordinatedIncrease.decision.reasonCode,
      detail: coordinatedIncrease.decision.reason,
    };
  const executionIntentKey = coordinatedIncrease.decision.intentKey;
  const clientOrderId =
    `nqa_${position.id}_${opportunity.observedMinute}_${sequence}`.slice(0, 36);
  const createdAt = new Date();
  const decisionDetail = {
    ...opportunity,
    configVersion: strategy.configVersion ?? trace.configVersion,
    sourceTraceConfigVersion: trace.configVersion,
    previousQuantity: position.quantity,
    previousEntryPrice: position.entryPrice,
    addOnNotionalUsdt: size.notional,
    requiredMarginUsdt: requiredMargin,
    orderCapacity,
    orderCapacityMessage: automatedOrderCapacityMessage(
      orderCapacity,
      "加仓证据已经通过",
    ),
    marginCapacity: capacity,
    marginCapacityAdvisoryOnly: true,
    binanceAvailableBalanceAtDecisionUsdt: usableBalance,
    cachedBinanceAvailableBalanceAtDecisionUsdt:
      cachedBinanceAvailableBalance,
    accountFundingStatusAtDecision: fundingSnapshot.status,
    dailyMarginAtDecisionUsdt: dailyMargin,
    configuredDailyMarginReferenceUsdt:
      config.execution.maxDailyNotionalUsdt,
    cumulativeMarginAdvisoryOnly: true,
    executionMarkPrice,
    executionMarkTime: executionMark.time,
    revalidatedRoePercent,
    addOnMode:
      additionMode === "PROFIT_SCALE_IN"
        ? "PROFIT_CONTINUATION_SCALE_IN"
        : "BOTTOM_REBOUND_ADD_ON",
    revalidatedRecoveryFromTroughRoePoints:
      revalidation.recoveryFromTroughRoePoints,
  };
  const [addition] = await db
    .insert(livePositionAdditions)
    .values({
      positionId: position.id,
      lifecycleId: position.lifecycleId,
      basePositionVersion: position.positionVersion,
      ownerEmail: position.ownerEmail,
      accountId: position.accountId,
      clientOrderId,
      symbol: position.symbol,
      positionSide: position.positionSide,
      quantity: size.quantity,
      notionalUsdt: size.notional,
      status: "PENDING",
      decisionJson: JSON.stringify(decisionDetail),
      responseJson: JSON.stringify({
        requestedLeverage: position.leverage,
      }),
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!addition) {
    await advanceNexusExecutionIntent({
      intentKey: executionIntentKey,
      nextStatus: "REJECTED",
      reasonCode: "POSITION_ADDITION_DUPLICATE",
      reasonMessage: "同一持仓加仓机会已经存在，已释放重复执行授权",
      detail: {
        positionId: position.id,
        positionHandoffKey: position.positionHandoffKey,
        clientOrderId,
      },
    });
    return { executed: false, attempted: false, reason: "IDEMPOTENT_DUPLICATE" };
  }
  let orderEvent: typeof liveOrderEvents.$inferSelect | undefined;
  try {
    [orderEvent] = await db
      .insert(liveOrderEvents)
      .values({
        ownerEmail: position.ownerEmail,
        accountId: position.accountId,
        credentialId: credential.id,
        clientOrderId,
        symbol: position.symbol,
        side: position.positionSide === "LONG" ? "BUY" : "SELL",
        positionSide: position.positionSide,
        orderType: "MARKET",
        quantity: size.quantity,
        referencePrice: executionMarkPrice,
        estimatedNotional: size.notional,
        testOnly: false,
        status: "PENDING",
        responseJson: JSON.stringify({
          requestedLeverage: position.leverage,
        }),
        lifecycleId: position.lifecycleId,
        entryDecisionHandoffJson: position.entryDecisionHandoffJson,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
  } catch (error) {
    const message =
      error instanceof Error
        ? `补仓委托账本创建失败：${error.message}`
        : "补仓委托账本创建失败";
    await db
      .update(livePositionAdditions)
      .set({
        status: "REJECTED",
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(livePositionAdditions.id, addition.id));
    await advanceNexusExecutionIntent({
      intentKey: executionIntentKey,
      nextStatus: "REJECTED",
      reasonCode: "ORDER_LEDGER_CREATE_FAILED",
      reasonMessage: message,
      detail: {
        positionId: position.id,
        positionHandoffKey: position.positionHandoffKey,
        positionAdditionId: addition.id,
        clientOrderId,
      },
    });
    throw error;
  }
  if (!orderEvent) {
    await db
      .update(livePositionAdditions)
      .set({
        status: "REJECTED",
        lastError: "补仓委托账本未返回记录，未向交易所发送订单",
        updatedAt: new Date(),
      })
      .where(eq(livePositionAdditions.id, addition.id));
    await advanceNexusExecutionIntent({
      intentKey: executionIntentKey,
      nextStatus: "REJECTED",
      reasonCode: "ORDER_LEDGER_NOT_CREATED",
      reasonMessage: "补仓委托账本未返回记录，已释放执行授权",
      detail: {
        positionId: position.id,
        positionHandoffKey: position.positionHandoffKey,
        positionAdditionId: addition.id,
        clientOrderId,
      },
    });
    return {
      executed: false,
      attempted: false,
      reason: "ORDER_LEDGER_NOT_CREATED",
    };
  }
  try {
    await advanceNexusExecutionIntent({
      intentKey: executionIntentKey,
      nextStatus: "SUBMITTING",
      detail: {
        liveOrderEventId: orderEvent.id,
        livePositionId: position.id,
        positionHandoffKey: position.positionHandoffKey,
        positionAdditionId: addition.id,
        clientOrderId,
      },
    });
  } catch (error) {
    const message = error instanceof Error
      ? `补仓执行授权交接失败：${error.message}`
      : "补仓执行授权交接失败";
    await db.batch([
      db
        .update(liveOrderEvents)
        .set({
          status: "REJECTED",
          responseJson: JSON.stringify({ error: message }),
          updatedAt: new Date(),
        })
        .where(eq(liveOrderEvents.id, orderEvent.id)),
      db
        .update(livePositionAdditions)
        .set({
          status: "REJECTED",
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(livePositionAdditions.id, addition.id)),
    ]);
    return {
      executed: false,
      attempted: false,
      reason: "ENTRY_AUTHORIZATION_HANDOFF_FAILED",
      detail: message,
    };
  }
  await observeExecutionQuote({
    recordKey: `ADD:${addition.id}`,
    quoteRole: "ADD",
    liveOrderEventId: orderEvent.id,
    positionId: position.id,
    positionAdditionId: addition.id,
    clientOrderId,
    ownerEmail: position.ownerEmail,
    accountId: position.accountId,
    strategyId: trace.strategyId,
    traceId: typeof asRecord(position.riskPlanJson).traceId === "string"
      ? String(asRecord(position.riskPlanJson).traceId)
      : null,
    origin: position.positionSide === "LONG" ? "STRATEGY_LONG" : "STRATEGY_SHORT",
    symbol: position.symbol,
    side: position.positionSide === "LONG" ? "BUY" : "SELL",
    positionSide: position.positionSide,
    actualOrderType: "MARKET",
    actualRequestedPrice: executionMarkPrice,
    decisionMarkPrice: executionMarkPrice,
    executableReferencePrice: executionMarkPrice,
    priceTickSize: symbol.priceTickSize,
    atr5m: Number(asRecord(position.riskPlanJson).atr5m) || null,
    prospectiveNotionalUsdt: size.notional,
    urgency: additionMode === "PROFIT_SCALE_IN" ? 0.65 : 0.35,
  });

  let exchangeFillConfirmed = false;
  let centralSettlementCompleted = false;
  try {
    const keys = {
      apiKey: await decryptCredential(
        credential.apiKeyCiphertext,
        credential.apiKeyIv,
        credentialContext(position.ownerEmail, position.accountId, "api-key"),
      ),
      secretKey: await decryptCredential(
        credential.secretKeyCiphertext,
        credential.secretKeyIv,
        credentialContext(position.ownerEmail, position.accountId, "secret-key"),
      ),
    };
    const result = await submitLiveEntryOrder(keys, {
      symbol: position.symbol,
      side: position.positionSide === "LONG" ? "BUY" : "SELL",
      positionSide: position.positionSide,
      quantity: size.quantity,
      clientOrderId,
      leverage: position.leverage,
      positionMode: credential.positionMode,
      orderType: "MARKET",
    });
    const acknowledgement = readAutomatedEntryAcknowledgement({
      response: result.data,
      orderType: "MARKET",
      fallbackEntryPrice: executionMarkPrice,
      confirmedLeverage: result.timing.confirmedLeverage,
      requestedLeverage: result.timing.requestedLeverage,
    });
    const executedQuantity = acknowledgement.executedQuantity;
    const entryPrice = acknowledgement.averagePrice;
    if (
      acknowledgement.canonicalOrderStatus !== "FILLED" ||
      !acknowledgement.hasExecutedQuantity ||
      entryPrice === null
    )
      throw new BinanceLiveError(
        "补仓订单已提交但成交结果不完整，进入订单号对账",
        503,
        undefined,
        true,
      );
    exchangeFillConfirmed = true;
    const { combinedQuantity, combinedEntryPrice } = combinePositionAddition({
      currentQuantity: position.quantity,
      currentEntryPrice: position.entryPrice,
      addedQuantity: executedQuantity,
      addedEntryPrice: entryPrice,
    });
    let syncedQuantity = combinedQuantity;
    let syncedEntryPrice = combinedEntryPrice;
    let syncedMarkPrice = executionMarkPrice;
    let syncedLiquidationPrice = position.liquidationPrice;
    let syncedLiquidationPriceRaw = position.liquidationPriceRaw;
    let syncedLiquidationPriceStatus = position.liquidationPriceStatus;
    let syncedLiquidationPriceObservedAt =
      position.liquidationPriceObservedAt;
    try {
      const exchangePosition = await getLivePositionSnapshot(
        keys,
        position.symbol,
        position.positionSide,
      );
      if (exchangePosition.quantity > 0) {
        syncedQuantity = exchangePosition.quantity;
        syncedEntryPrice = exchangePosition.entryPrice || combinedEntryPrice;
        syncedMarkPrice = exchangePosition.markPrice || executionMarkPrice;
        syncedLiquidationPrice =
          exchangePosition.liquidationPriceStatus === "AVAILABLE"
            ? exchangePosition.liquidationPrice
            : null;
        syncedLiquidationPriceRaw =
          exchangePosition.liquidationPriceRaw;
        syncedLiquidationPriceStatus =
          exchangePosition.liquidationPriceStatus;
        syncedLiquidationPriceObservedAt = new Date(
          exchangePosition.liquidationPriceObservedAt,
        );
      }
    } catch {
      // 持仓快照偶发延迟时，先按成交回报计算补仓均价；下一轮风控会继续同步 Binance 真实仓位。
    }
    const combinedRiskPlan = buildPilotRiskPlan(
      config,
      syncedQuantity,
      symbol.minOrderQty,
      symbol.quantityStep,
      {
        referencePrice: syncedEntryPrice,
        minNotionalUsdt: symbol.minNotionalUsdt,
      },
    );
    const nextPositionVersion = position.positionVersion + 1;
    const nextProtectionVersion = position.protectionVersion + 1;
    const protectionUpdatedAt = new Date();
    const mergedRiskPlan = mergeRiskPlanWithPositionMemory(
      position.riskPlanJson,
      combinedRiskPlan,
    );
    const postAdditionRiskPlan = rebuildProtectionAfterAddition({
      plan: mergedRiskPlan,
      rebalancedTakeProfits: combinedRiskPlan.takeProfits,
      rebalancedStopLosses: combinedRiskPlan.stopLosses,
      nextPositionVersion,
      nextProtectionVersion,
      nowMs: protectionUpdatedAt.getTime(),
      source: "AUTO_ADD_ON",
    });
    const postAdditionProgress = reanchorProgressAfterAddition({
      progress: parseExecutedPlan(position.executedRiskPlanJson),
      newPositionQuantity: syncedQuantity,
    });
    const responseJson = JSON.stringify({
      ...result.data,
      timing: result.timing,
      previousQuantity: position.quantity,
      previousEntryPrice: position.entryPrice,
      combinedQuantity,
      combinedEntryPrice,
      syncedQuantity,
      syncedEntryPrice,
      syncedLiquidationPrice,
    });
    const [positionApplied] = await db
      .update(livePositions)
      .set({
        quantity: syncedQuantity,
        entryPrice: syncedEntryPrice,
        markPrice: syncedMarkPrice,
        leverage: result.timing.confirmedLeverage,
        liquidationPrice: syncedLiquidationPrice,
        liquidationPriceRaw: syncedLiquidationPriceRaw,
        liquidationPriceStatus: syncedLiquidationPriceStatus,
        liquidationPriceObservedAt: syncedLiquidationPriceObservedAt,
        instrumentId: position.instrumentId ?? symbol.instrumentId ??
          buildInstrumentId({ symbol: position.symbol }),
        instrumentRuleVersion: symbol.ruleVersion,
        positionVersion: nextPositionVersion,
        protectionVersion: nextProtectionVersion,
        protectionState: "ACTIVE",
        protectionUpdatedAt,
        riskPlanJson: JSON.stringify(postAdditionRiskPlan),
        executedRiskPlanJson: JSON.stringify(postAdditionProgress),
        trailingActivationPercent: position.trailingActivationPercent,
        trailingStopPercent: position.trailingStopPercent,
        favorablePrice: syncedMarkPrice,
        additionCount: position.additionCount + 1,
        lastAdditionClientOrderId: clientOrderId,
        riskLeaseUntil: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(livePositions.id, position.id),
        eq(livePositions.status, "OPEN"),
        eq(livePositions.positionVersion, position.positionVersion),
        eq(livePositions.protectionVersion, position.protectionVersion),
        or(
          isNull(livePositions.lastAdditionClientOrderId),
          eq(
            livePositions.lastAdditionClientOrderId,
            position.lastAdditionClientOrderId ?? "",
          ),
        ),
      ))
      .returning({ id: livePositions.id });
    if (!positionApplied)
      throw new BinanceLiveError(
        "补仓已经成交，但仓位版本发生变化，进入订单号幂等对账",
        503,
        undefined,
        true,
      );
    await settleNexusExecutionIntentWithLiveOrder({
      intentKey: executionIntentKey,
      liveOrderEventId: orderEvent.id,
      nextStatus: "FILLED",
      exchangeOrderId: String(result.data.orderId),
      responseJson,
      livePositionId: position.id,
      filledQuantity: executedQuantity,
      detail: {
        positionAdditionId: addition.id,
        clientOrderId,
        positionHandoffKey: position.positionHandoffKey,
        positionVersion: nextPositionVersion,
        protectionVersion: nextProtectionVersion,
      },
      reasonCode: "POSITION_INCREASE_FILLED",
      reasonMessage: "加仓成交已由入场域结算，并交回持仓生命周期管理",
    });
    centralSettlementCompleted = true;
    await db
      .update(livePositionAdditions)
      .set({
        exchangeOrderId: String(result.data.orderId),
        quantity: executedQuantity,
        entryPrice,
        notionalUsdt: executedQuantity * entryPrice,
        status: "SUBMITTED",
        appliedPositionVersion: nextPositionVersion,
        protectionVersion: nextProtectionVersion,
        responseJson,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(livePositionAdditions.id, addition.id));
    await writeAudit(
      { email: position.ownerEmail, accountId: position.accountId },
      "LIVE_POSITION_ADD_ON_FILLED",
      "live_position",
      String(position.id),
      {
        clientOrderId,
        exchangeOrderId: result.data.orderId,
        symbol: position.symbol,
        currentRoePercent: revalidatedRoePercent,
        decisionRoePercent: currentRoePercent,
        executedQuantity,
        entryPrice,
        combinedQuantity: syncedQuantity,
        combinedEntryPrice: syncedEntryPrice,
        liquidationPrice: syncedLiquidationPrice,
        previousPositionVersion: position.positionVersion,
        positionVersion: nextPositionVersion,
        protectionVersion: nextProtectionVersion,
        protectionState: "ACTIVE",
        riskGridsRebalanced: true,
        decision: opportunity,
      },
    );
    return {
      executed: true,
      attempted: true,
      reason: "ADD_ON_FILLED",
      quantity: executedQuantity,
      entryPrice,
    };
  } catch (error) {
    const executionUnknown =
      exchangeFillConfirmed ||
      (error instanceof BinanceLiveError && error.executionUnknown);
    const status = executionUnknown ? "EXECUTION_UNKNOWN" : "REJECTED";
    const message = error instanceof Error ? error.message : "自动补仓失败";
    if (!centralSettlementCompleted) {
      await db
        .update(liveOrderEvents)
        .set({
          status,
          responseJson: JSON.stringify({
            error: message,
            executionUnknown,
          }),
          updatedAt: new Date(),
        })
        .where(eq(liveOrderEvents.id, orderEvent.id));
      try {
        await advanceNexusExecutionIntent({
          intentKey: executionIntentKey,
          nextStatus: status,
          reasonCode: status === "EXECUTION_UNKNOWN"
            ? "POSITION_INCREASE_EXECUTION_UNKNOWN"
            : "POSITION_INCREASE_REJECTED",
          reasonMessage: message,
          detail: {
            liveOrderEventId: orderEvent.id,
            livePositionId: position.id,
            positionHandoffKey: position.positionHandoffKey,
            positionAdditionId: addition.id,
            clientOrderId,
          },
        });
      } catch {
        // The exchange order remains the reconciliation source of truth. A
        // later live-risk pass repairs the intent without resubmitting.
      }
    }
    await db
      .update(livePositionAdditions)
      .set({
        status,
        lastError: message,
        responseJson: JSON.stringify({
          error: message,
          executionUnknown,
        }),
        updatedAt: new Date(),
      })
      .where(eq(livePositionAdditions.id, addition.id));
    await writeAudit(
      { email: position.ownerEmail, accountId: position.accountId },
      executionUnknown
        ? "LIVE_POSITION_ADD_ON_EXECUTION_UNKNOWN"
        : "LIVE_POSITION_ADD_ON_REJECTED",
      "live_position",
      String(position.id),
      { clientOrderId, symbol: position.symbol, error: message },
    );
    return {
      executed: false,
      attempted: true,
      executionUnknown,
      reason: status,
      detail: message,
    };
  }
}

async function settlePositionIncreaseIntentIfPresent(input: {
  liveOrderEventId: number;
  livePositionId: number;
  positionHandoffKey: string | null;
  nextStatus: "FILLED" | "CANCELED" | "REJECTED";
  liveOrderStatus?: "FILLED" | "CANCELED" | "EXPIRED" | "REJECTED";
  exchangeOrderId?: string | null;
  responseJson?: string;
  filledQuantity?: number;
  detail?: Record<string, unknown>;
  reasonCode: string;
  reasonMessage: string;
}) {
  const db = getDb();
  const [intent] = await db
    .select({
      intentKey: executionIntents.intentKey,
      intentPurpose: executionIntents.intentPurpose,
      livePositionId: executionIntents.livePositionId,
      positionHandoffKey: executionIntents.positionHandoffKey,
    })
    .from(executionIntents)
    .where(eq(executionIntents.liveOrderEventId, input.liveOrderEventId))
    .orderBy(desc(executionIntents.id))
    .limit(1);
  if (!intent) return false;
  if (
    intent.intentPurpose !== "INCREASE_POSITION" ||
    intent.livePositionId !== input.livePositionId ||
    !input.positionHandoffKey ||
    intent.positionHandoffKey !== input.positionHandoffKey
  )
    throw new Error("补仓执行意图与持仓交接身份不一致，禁止自动结算");
  await settleNexusExecutionIntentWithLiveOrder({
    intentKey: intent.intentKey,
    liveOrderEventId: input.liveOrderEventId,
    nextStatus: input.nextStatus,
    liveOrderStatus: input.liveOrderStatus,
    exchangeOrderId: input.exchangeOrderId,
    responseJson: input.responseJson,
    livePositionId: input.livePositionId,
    filledQuantity: input.filledQuantity,
    detail: {
      ...(input.detail ?? {}),
      positionHandoffKey: input.positionHandoffKey,
      reconciliationSource: "POSITION_ADDITION_LEDGER",
    },
    reasonCode: input.reasonCode,
    reasonMessage: input.reasonMessage,
  });
  return true;
}

async function reconcilePendingPositionAdditions(now: Date) {
  const db = getDb();
  const pending = await db
    .select()
    .from(livePositionAdditions)
    .where(and(
      or(
        inArray(livePositionAdditions.status, [
          "PENDING",
          "EXECUTION_UNKNOWN",
        ]),
        and(
          eq(livePositionAdditions.status, "REJECTED"),
          gte(
            livePositionAdditions.createdAt,
            new Date(now.getTime() - 7 * 24 * 60 * 60_000),
          ),
          or(
            like(
              livePositionAdditions.lastError,
              "%Order does not exist%",
            ),
            like(livePositionAdditions.lastError, "%订单不存在%"),
          ),
        ),
      ),
      lte(
        livePositionAdditions.updatedAt,
        new Date(now.getTime() - 15_000),
      ),
    ))
    .orderBy(asc(livePositionAdditions.updatedAt))
    .limit(10);
  let reconciled = 0;
  let rejected = 0;
  let deferred = 0;
  let errors = 0;
  for (const addition of pending) {
    const [position, credential, symbol, trace, orderEvent] =
      await Promise.all([
        db
          .select()
          .from(livePositions)
          .where(eq(livePositions.id, addition.positionId))
          .limit(1)
          .then((rows) => rows[0]),
        db
          .select()
          .from(exchangeCredentials)
          .where(and(
            eq(exchangeCredentials.ownerEmail, addition.ownerEmail),
            eq(exchangeCredentials.accountId, addition.accountId),
          ))
          .limit(1)
          .then((rows) => rows[0]),
        db
          .select()
          .from(contractSymbols)
          .where(eq(contractSymbols.symbol, addition.symbol))
          .limit(1)
          .then((rows) => rows[0]),
        db
          .select({
            strategyId: strategyExecutionTraces.strategyId,
            configVersion: strategyExecutionTraces.configVersion,
            configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
          })
          .from(strategyExecutionTraces)
          .where(
            addition.lifecycleId
              ? eq(strategyExecutionTraces.traceId, addition.lifecycleId)
              : eq(
                  strategyExecutionTraces.positionId,
                  String(addition.positionId),
                ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        db
          .select()
          .from(liveOrderEvents)
          .where(eq(
            liveOrderEvents.clientOrderId,
            addition.clientOrderId,
          ))
          .limit(1)
          .then((rows) => rows[0]),
      ]);
    if (!position || !credential || !symbol || !orderEvent) {
      errors += 1;
      continue;
    }
    try {
      const keys = {
        apiKey: await decryptCredential(
          credential.apiKeyCiphertext,
          credential.apiKeyIv,
          credentialContext(
            addition.ownerEmail,
            addition.accountId,
            "api-key",
          ),
        ),
        secretKey: await decryptCredential(
          credential.secretKeyCiphertext,
          credential.secretKeyIv,
          credentialContext(
            addition.ownerEmail,
            addition.accountId,
            "secret-key",
          ),
        ),
      };
      const storedOrderResponse = asRecord(parseJson(orderEvent.responseJson));
      const storedFill = resolveStoredLiveOrderFill(
        storedOrderResponse,
        orderEvent.exchangeOrderId,
      );
      let exchangeData = storedFill.data;
      let fill = storedFill.fill;
      if (!liveOrderFillIsConfirmed(fill)) {
        const queried = await queryLiveOrder(
          keys,
          addition.symbol,
          addition.clientOrderId,
        );
        exchangeData = queried.data;
        fill = resolveLiveOrderFill(exchangeData);
      }
      if (fill.executedQuantity > 0 && fill.executionPrice <= 0 &&
        fill.exchangeOrderId) {
        const trades = await getBinanceLiveOrderTrades(
          keys,
          addition.symbol,
          fill.exchangeOrderId,
        );
        const tradeFill = resolveLiveOrderTradeFill(trades);
        if (tradeFill.executedQuantity > 0 && tradeFill.executionPrice > 0)
          fill = {
            ...fill,
            executedQuantity: tradeFill.executedQuantity,
            executionPrice: tradeFill.executionPrice,
          };
      }
      const exchangeStatus = fill.status;
      const executedQuantity = fill.executedQuantity;
      const entryPrice = fill.executionPrice;
      if (
        ["CANCELED", "REJECTED", "EXPIRED"].includes(exchangeStatus) &&
        executedQuantity <= 0
      ) {
        const message = `Binance 补仓委托状态为 ${exchangeStatus}`;
        const exchangeOrderId = String(
          exchangeData.orderId ?? orderEvent.exchangeOrderId ?? "",
        );
        const responseJson = JSON.stringify(exchangeData);
        const intentSettled = await settlePositionIncreaseIntentIfPresent({
          liveOrderEventId: orderEvent.id,
          livePositionId: position.id,
          positionHandoffKey: position.positionHandoffKey,
          nextStatus: exchangeStatus === "REJECTED" ? "REJECTED" : "CANCELED",
          liveOrderStatus: exchangeStatus as "CANCELED" | "EXPIRED" | "REJECTED",
          exchangeOrderId,
          responseJson,
          filledQuantity: 0,
          detail: {
            positionAdditionId: addition.id,
            clientOrderId: addition.clientOrderId,
          },
          reasonCode: `POSITION_INCREASE_${exchangeStatus}`,
          reasonMessage: message,
        });
        if (!intentSettled) {
          await db
            .update(liveOrderEvents)
            .set({
              exchangeOrderId,
              status: "REJECTED",
              responseJson,
              updatedAt: new Date(),
            })
            .where(eq(liveOrderEvents.id, orderEvent.id));
        }
        await db
          .update(livePositionAdditions)
          .set({
            exchangeOrderId,
            status: "REJECTED",
            responseJson,
            lastError: message,
            updatedAt: new Date(),
          })
          .where(eq(livePositionAdditions.id, addition.id));
        rejected += 1;
        continue;
      }
      if (!liveOrderFillIsConfirmed(fill)) {
        deferred += 1;
        continue;
      }

      let reconciledPositionVersion = position.positionVersion;
      let reconciledProtectionVersion = position.protectionVersion;
      let localPositionUpdated = false;
      let positionReopened = false;
      if (position.status === "CLOSED") {
        const snapshot = await getLivePositionSnapshot(
          keys,
          addition.symbol,
          addition.positionSide,
        );
        const representedRows = await db
          .select({ quantity: livePositions.quantity })
          .from(livePositions)
          .where(and(
            eq(livePositions.ownerEmail, addition.ownerEmail),
            eq(livePositions.accountId, addition.accountId),
            eq(livePositions.credentialId, position.credentialId),
            eq(livePositions.symbol, addition.symbol),
            eq(livePositions.positionSide, addition.positionSide),
            inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
          ));
        const representedQuantity = representedRows.reduce(
          (sum, row) => sum + Math.max(0, row.quantity),
          0,
        );
        const missingQuantity = Math.max(
          0,
          snapshot.quantity - representedQuantity,
        );
        const quantityTolerance = Math.max(
          1e-8,
          snapshot.quantity * 1e-8,
        );
        if (missingQuantity > quantityTolerance) {
          const nextPositionVersion = position.positionVersion + 1;
          const nextProtectionVersion = position.protectionVersion + 1;
          const rebalanced = rebalanceRiskPlan(
            asRecord(parseJson(position.riskPlanJson)),
            missingQuantity,
            symbol.minOrderQty,
            symbol.quantityStep,
            {},
            position.trailingStopPercent,
          );
          const restoredPlan = rebuildProtectionAfterAddition({
            plan: rebalanced.plan,
            rebalancedTakeProfits: Array.isArray(rebalanced.plan.takeProfits)
              ? rebalanced.plan.takeProfits
              : [],
            rebalancedStopLosses: Array.isArray(rebalanced.plan.stopLosses)
              ? rebalanced.plan.stopLosses
              : [],
            nextPositionVersion,
            nextProtectionVersion,
            nowMs: now.getTime(),
            source: "RECONCILIATION",
          });
          const restoredProgress = reanchorProgressAfterAddition({
            progress: parseExecutedPlan(position.executedRiskPlanJson),
            newPositionQuantity: missingQuantity,
          });
          const [restored] = await db
            .update(livePositions)
            .set({
              quantity: missingQuantity,
              entryPrice: snapshot.entryPrice > 0
                ? snapshot.entryPrice
                : entryPrice,
              markPrice: snapshot.markPrice > 0
                ? snapshot.markPrice
                : entryPrice,
              liquidationPrice:
                Number.isFinite(snapshot.liquidationPrice) &&
                  snapshot.liquidationPrice > 0
                  ? snapshot.liquidationPrice
                  : null,
              liquidationPriceRaw: snapshot.liquidationPriceRaw,
              liquidationPriceStatus: snapshot.liquidationPriceStatus,
              liquidationPriceObservedAt: new Date(
                snapshot.liquidationPriceObservedAt,
              ),
              leverage:
                Number.isFinite(snapshot.leverage) && snapshot.leverage > 0
                  ? snapshot.leverage
                  : position.leverage,
              positionVersion: nextPositionVersion,
              protectionVersion: nextProtectionVersion,
              protectionState: "ACTIVE",
              protectionUpdatedAt: now,
              riskPlanJson: JSON.stringify(restoredPlan),
              executedRiskPlanJson: JSON.stringify(restoredProgress),
              favorablePrice: snapshot.markPrice > 0
                ? snapshot.markPrice
                : entryPrice,
              additionCount: position.additionCount + 1,
              lastAdditionClientOrderId: addition.clientOrderId,
              status: "OPEN",
              exitReason: null,
              closedAt: null,
              riskLeaseUntil: null,
              pendingCloseClientOrderId: null,
              pendingCloseReason: null,
              pendingCloseQuantity: null,
              pendingClosePlanJson: null,
              lastError: null,
              updatedAt: now,
            })
            .where(and(
              eq(livePositions.id, position.id),
              eq(livePositions.status, "CLOSED"),
              eq(livePositions.positionVersion, position.positionVersion),
              eq(livePositions.protectionVersion, position.protectionVersion),
            ))
            .returning({ id: livePositions.id });
          if (!restored) {
            deferred += 1;
            continue;
          }
          reconciledPositionVersion = nextPositionVersion;
          reconciledProtectionVersion = nextProtectionVersion;
          localPositionUpdated = true;
          positionReopened = true;
        }
      }
      if (
        position.status === "OPEN" &&
        position.lastAdditionClientOrderId !== addition.clientOrderId
      ) {
        const { combinedQuantity, combinedEntryPrice } =
          combinePositionAddition({
            currentQuantity: position.quantity,
            currentEntryPrice: position.entryPrice,
            addedQuantity: executedQuantity,
            addedEntryPrice: entryPrice,
          });
        const riskPlan = trace
          ? buildPilotRiskPlan(
              await loadBoundLiquidationTrendConfig(trace),
              combinedQuantity,
              symbol.minOrderQty,
              symbol.quantityStep,
              {
                referencePrice: combinedEntryPrice,
                minNotionalUsdt: symbol.minNotionalUsdt,
              },
            )
          : rebalanceRiskPlan(
              asRecord(parseJson(position.riskPlanJson)),
              combinedQuantity,
              symbol.minOrderQty,
              symbol.quantityStep,
              asRecord(parseJson(position.executedRiskPlanJson)),
              position.trailingStopPercent,
            ).plan;
        const nextPositionVersion = position.positionVersion + 1;
        const nextProtectionVersion = position.protectionVersion + 1;
        const mergedPlan = mergeRiskPlanWithPositionMemory(
          position.riskPlanJson,
          riskPlan,
        );
        const suspendedPlan = rebuildProtectionAfterAddition({
          plan: mergedPlan,
          rebalancedTakeProfits: Array.isArray(mergedPlan.takeProfits)
            ? mergedPlan.takeProfits
            : [],
          rebalancedStopLosses: Array.isArray(mergedPlan.stopLosses)
            ? mergedPlan.stopLosses
            : [],
          nextPositionVersion,
          nextProtectionVersion,
          nowMs: now.getTime(),
          source: trace ? "AUTO_ADD_ON" : "MANUAL_ADD_ON",
        });
        const reconciledAdditionProgress = reanchorProgressAfterAddition({
          progress: parseExecutedPlan(position.executedRiskPlanJson),
          newPositionQuantity: combinedQuantity,
        });
        const [applied] = await db
          .update(livePositions)
          .set({
            quantity: combinedQuantity,
            entryPrice: combinedEntryPrice,
            markPrice: entryPrice,
            instrumentId:
              symbol.instrumentId ??
              buildInstrumentId({ symbol: position.symbol }),
            instrumentRuleVersion: symbol.ruleVersion,
            positionVersion: nextPositionVersion,
            protectionVersion: nextProtectionVersion,
            protectionState: "ACTIVE",
            protectionUpdatedAt: now,
            riskPlanJson: JSON.stringify(suspendedPlan),
            executedRiskPlanJson: JSON.stringify(
              reconciledAdditionProgress,
            ),
            favorablePrice: entryPrice,
            additionCount: position.additionCount + 1,
            lastAdditionClientOrderId: addition.clientOrderId,
            trailingActivationPercent: position.trailingActivationPercent,
            trailingStopPercent: position.trailingStopPercent,
            riskLeaseUntil: null,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(livePositions.id, position.id),
            eq(livePositions.status, "OPEN"),
            eq(livePositions.positionVersion, position.positionVersion),
            eq(livePositions.protectionVersion, position.protectionVersion),
            or(
              isNull(livePositions.lastAdditionClientOrderId),
              eq(
                livePositions.lastAdditionClientOrderId,
                position.lastAdditionClientOrderId ?? "",
              ),
            ),
          ))
          .returning({ id: livePositions.id });
        if (!applied) {
          deferred += 1;
          continue;
        }
        reconciledPositionVersion = nextPositionVersion;
        reconciledProtectionVersion = nextProtectionVersion;
        localPositionUpdated = true;
      } else if (
        position.status === "OPEN" &&
        position.lastAdditionClientOrderId === addition.clientOrderId
      ) {
        reconciledPositionVersion = position.positionVersion;
        reconciledProtectionVersion = position.protectionVersion;
        localPositionUpdated = true;
      }
      const reconciledExchangeOrderId = String(
        exchangeData.orderId ?? orderEvent.exchangeOrderId ?? "",
      );
      const reconciledResponseJson = JSON.stringify(exchangeData);
      const intentSettled = await settlePositionIncreaseIntentIfPresent({
        liveOrderEventId: orderEvent.id,
        livePositionId: position.id,
        positionHandoffKey: position.positionHandoffKey,
        nextStatus: "FILLED",
        exchangeOrderId: reconciledExchangeOrderId,
        responseJson: reconciledResponseJson,
        filledQuantity: executedQuantity,
        detail: {
          positionAdditionId: addition.id,
          clientOrderId: addition.clientOrderId,
          positionVersion: reconciledPositionVersion,
          protectionVersion: reconciledProtectionVersion,
        },
        reasonCode: "POSITION_INCREASE_RECONCILED_FILLED",
        reasonMessage: "加仓成交已按交易所终态完成授权结算",
      });
      if (!intentSettled) {
        await db
          .update(liveOrderEvents)
          .set({
            exchangeOrderId: reconciledExchangeOrderId,
            status: "FILLED",
            responseJson: reconciledResponseJson,
            updatedAt: new Date(),
          })
          .where(eq(liveOrderEvents.id, orderEvent.id));
      }
      await db
        .update(livePositionAdditions)
        .set({
          exchangeOrderId: reconciledExchangeOrderId,
          quantity: executedQuantity,
          entryPrice,
          notionalUsdt: executedQuantity * entryPrice,
          status: "SUBMITTED",
          appliedPositionVersion: reconciledPositionVersion,
          protectionVersion: reconciledProtectionVersion,
          responseJson: reconciledResponseJson,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(livePositionAdditions.id, addition.id));
      await writeAudit(
        { email: addition.ownerEmail, accountId: addition.accountId },
        "LIVE_POSITION_ADD_ON_RECONCILED",
        "live_position",
        String(addition.positionId),
        {
          clientOrderId: addition.clientOrderId,
          exchangeOrderId:
            exchangeData.orderId ?? orderEvent.exchangeOrderId,
          symbol: addition.symbol,
          executedQuantity,
          entryPrice,
          positionStatusAtReconciliation: position.status,
          localPositionUpdated,
          positionReopened,
          positionVersion: reconciledPositionVersion,
          protectionVersion: reconciledProtectionVersion,
          protectionState:
            localPositionUpdated
              ? "ACTIVE"
              : position.protectionState,
          riskGridsRebalanced: localPositionUpdated,
        },
      );
      reconciled += 1;
    } catch (error) {
      if (
        error instanceof BinanceLiveError &&
        error.code === -2013 &&
        now.getTime() - addition.createdAt.getTime() >= 120_000
      ) {
        const message = "Binance 在两分钟内未找到该补仓委托，已按未成交释放";
        const responseJson = JSON.stringify({
          code: error.code,
          message,
        });
        const intentSettled = await settlePositionIncreaseIntentIfPresent({
          liveOrderEventId: orderEvent.id,
          livePositionId: position.id,
          positionHandoffKey: position.positionHandoffKey,
          nextStatus: "REJECTED",
          liveOrderStatus: "REJECTED",
          exchangeOrderId: orderEvent.exchangeOrderId,
          responseJson,
          filledQuantity: 0,
          detail: {
            positionAdditionId: addition.id,
            clientOrderId: addition.clientOrderId,
          },
          reasonCode: "POSITION_INCREASE_ORDER_NOT_FOUND",
          reasonMessage: message,
        });
        if (!intentSettled) {
          await db
            .update(liveOrderEvents)
            .set({
              status: "REJECTED",
              responseJson,
              updatedAt: new Date(),
            })
            .where(eq(liveOrderEvents.id, orderEvent.id));
        }
        await db
          .update(livePositionAdditions)
          .set({
            status: "REJECTED",
            lastError: message,
            updatedAt: new Date(),
          })
          .where(eq(livePositionAdditions.id, addition.id));
        rejected += 1;
        continue;
      }
      errors += 1;
    }
  }
  return { reconciled, rejected, deferred, errors };
}

async function reconcilePrivateOrderStreamEvents() {
  const db = getDb();
  const credentials = await db
    .select()
    .from(exchangeCredentials)
    .where(eq(exchangeCredentials.connectionStatus, "VERIFIED"));
  let accounts = 0;
  let events = 0;
  let updated = 0;
  let ignored = 0;
  for (const credential of credentials) {
    try {
      const apiKey = await decryptCredential(
        credential.apiKeyCiphertext,
        credential.apiKeyIv,
        credentialContext(
          credential.ownerEmail,
          credential.accountId,
          "api-key",
        ),
      );
      let cursor = privateOrderSequenceByCredential.get(credential.id) || 0;
      let snapshot = await getNexusPrivateOrderEvents({ apiKey }, cursor);
      if (snapshot.lastSequence < cursor) {
        cursor = 0;
        snapshot = await getNexusPrivateOrderEvents({ apiKey }, 0);
      }
      accounts += 1;
      for (const event of snapshot.rows) {
        events += 1;
        const [order] = await db
          .select()
          .from(liveOrderEvents)
          .where(
            and(
              eq(liveOrderEvents.credentialId, credential.id),
              eq(liveOrderEvents.clientOrderId, event.clientOrderId),
            ),
          )
          .limit(1);
        if (!order) {
          ignored += 1;
          continue;
        }
        const response = asRecord(parseJson(order.responseJson));
        const priorLifecycle = asRecord(
          response.nexusPrivateOrderLifecycle,
        );
        const priorState = String(
          priorLifecycle.state ||
            (order.status === "PENDING" || order.status === "EXECUTION_UNKNOWN"
              ? "SENT"
              : "ACKNOWLEDGED"),
        ) as NexusOrderState;
        let nextState: NexusOrderState;
        try {
          nextState = transitionNexusOrderState(priorState, event.state);
        } catch {
          ignored += 1;
          continue;
        }
        const nextStatus = liveOrderStatusFromNexusState(
          nextState,
          event.cumulativeQuantity,
        );
        await db
          .update(liveOrderEvents)
          .set({
            exchangeOrderId:
              event.exchangeOrderId || order.exchangeOrderId,
            status: nextStatus,
            responseJson: JSON.stringify({
              ...response,
              nexusPrivateOrderLifecycle: {
                source: "BINANCE_PRIVATE_WEBSOCKET",
                sequence: event.sequence,
                state: nextState,
                exchangeStatus: event.exchangeStatus,
                executionType: event.executionType,
                originalQuantity: event.originalQuantity,
                cumulativeQuantity: event.cumulativeQuantity,
                averagePrice: event.averagePrice,
                realizedProfit: event.realizedProfit,
                commission: event.commission,
                commissionAsset: event.commissionAsset,
                eventTime: event.eventTime,
                transactionTime: event.transactionTime,
                receivedAt: event.receivedAt,
              },
            }),
            updatedAt: new Date(event.eventTime),
          })
          .where(eq(liveOrderEvents.id, order.id));
        updated += 1;
      }
      privateOrderSequenceByCredential.set(
        credential.id,
        snapshot.lastSequence,
      );
    } catch {
      ignored += 1;
    }
  }
  return { accounts, events, updated, ignored };
}

async function reconcileUnknownEntryOrders() {
  const db = getDb();
  const reconciliationBatchSize = 8;
  const orphanFilledCandidates = await db
    .select({
      id: liveOrderEvents.id,
      accountId: liveOrderEvents.accountId,
      credentialId: liveOrderEvents.credentialId,
      symbol: liveOrderEvents.symbol,
      positionSide: liveOrderEvents.positionSide,
    })
    .from(liveOrderEvents)
    .leftJoin(
      livePositions,
      eq(livePositions.sourceEventId, liveOrderEvents.id),
    )
    .where(
      and(
        eq(liveOrderEvents.testOnly, false),
        eq(liveOrderEvents.status, "FILLED"),
        notLike(liveOrderEvents.clientOrderId, "nqa_%"),
        notLike(
          liveOrderEvents.responseJson,
          "%positionRecoveryResolvedAt%",
        ),
        isNull(livePositions.id),
      ),
    )
    .orderBy(desc(liveOrderEvents.id))
    .limit(24);
  // Only the newest unbound fill for one account/symbol/side may claim the
  // current Binance position. Older fills may already have completed their
  // lifecycle and must not be mistaken for today's live exposure.
  const orphanFilledIds: number[] = [];
  const orphanExposureKeys = new Set<string>();
  for (const candidate of orphanFilledCandidates) {
    const key = [
      candidate.accountId,
      candidate.credentialId,
      candidate.symbol,
      candidate.positionSide,
    ].join(":");
    if (orphanExposureKeys.has(key)) continue;
    orphanExposureKeys.add(key);
    orphanFilledIds.push(candidate.id);
    if (orphanFilledIds.length >= 3) break;
  }
  const terminalTraceWorkingIds = await db
    .select({ id: liveOrderEvents.id })
    .from(liveOrderEvents)
    .innerJoin(
      strategyExecutionTraces,
      eq(strategyExecutionTraces.traceId, liveOrderEvents.lifecycleId),
    )
    .where(
      and(
        eq(liveOrderEvents.testOnly, false),
        notLike(liveOrderEvents.clientOrderId, "nqa_%"),
        inArray(liveOrderEvents.status, [
          "PENDING",
          "NEW",
          "PARTIALLY_FILLED",
          "CANCEL_PENDING",
          "EXECUTION_UNKNOWN",
        ]),
        inArray(strategyExecutionTraces.state, [
          "CLOSED",
          "EXPIRED",
          "REJECTED",
          "CANCELED",
        ]),
      ),
    )
    .orderBy(asc(liveOrderEvents.updatedAt), asc(liveOrderEvents.id))
    .limit(3);
  const terminalTraceWorkingIdSet = new Set(
    terminalTraceWorkingIds.map((row) => row.id),
  );
  const unknownRows = await db
    .select()
    .from(liveOrderEvents)
    .where(
      and(
        eq(liveOrderEvents.testOnly, false),
        notLike(liveOrderEvents.clientOrderId, "nqa_%"),
        inArray(liveOrderEvents.status, [
          "PENDING",
          "CANCEL_PENDING",
          "EXECUTION_UNKNOWN",
        ]),
      ),
    )
    .orderBy(asc(liveOrderEvents.id))
    .limit(Math.max(
      0,
      reconciliationBatchSize -
        orphanFilledIds.length -
        terminalTraceWorkingIds.length,
    ));
  const orphanSubmittedIds = await db
    .select({ id: liveOrderEvents.id })
    .from(liveOrderEvents)
    .leftJoin(
      livePositions,
      eq(livePositions.sourceEventId, liveOrderEvents.id),
    )
    .where(
      and(
        eq(liveOrderEvents.testOnly, false),
        notLike(liveOrderEvents.clientOrderId, "nqa_%"),
        inArray(liveOrderEvents.status, ["SUBMITTED", "EXECUTION_UNKNOWN"]),
        like(
          liveOrderEvents.responseJson,
          "%EXCHANGE_CONFIRMED_EXECUTION%",
        ),
        notLike(
          liveOrderEvents.responseJson,
          "%positionRecoveryResolvedAt%",
        ),
        isNull(livePositions.id),
      ),
    )
    .orderBy(asc(liveOrderEvents.id))
    .limit(Math.max(
      0,
      reconciliationBatchSize -
        orphanFilledIds.length -
        terminalTraceWorkingIds.length -
        unknownRows.length,
    ));
  const orphanSubmittedRows = orphanSubmittedIds.length
    ? await db
        .select()
        .from(liveOrderEvents)
        .where(
          inArray(
            liveOrderEvents.id,
            orphanSubmittedIds.map((row) => row.id),
          ),
        )
        .orderBy(asc(liveOrderEvents.id))
    : [];
  const orphanFilledRows = orphanFilledIds.length
    ? await db
        .select()
        .from(liveOrderEvents)
        .where(inArray(liveOrderEvents.id, orphanFilledIds))
        .orderBy(desc(liveOrderEvents.id))
    : [];
  const terminalTraceWorkingRows = terminalTraceWorkingIds.length
    ? await db
        .select()
        .from(liveOrderEvents)
        .where(inArray(
          liveOrderEvents.id,
          terminalTraceWorkingIds.map((row) => row.id),
        ))
        .orderBy(asc(liveOrderEvents.updatedAt), asc(liveOrderEvents.id))
    : [];
  const rows = [
    ...orphanFilledRows,
    ...terminalTraceWorkingRows,
    ...unknownRows,
    ...orphanSubmittedRows,
  ].filter(
    (row, index, all) => all.findIndex((item) => item.id === row.id) === index,
  ).slice(0, reconciliationBatchSize);
  let reconciled = 0;
  let waiting = 0;
  let errors = 0;
  let terminalTraceWorking = 0;
  for (const order of rows) {
    try {
      const [credential] = await db
        .select()
        .from(exchangeCredentials)
        .where(
          and(
            eq(exchangeCredentials.id, order.credentialId),
            eq(exchangeCredentials.ownerEmail, order.ownerEmail),
          ),
        )
        .limit(1);
      if (!credential) {
        errors += 1;
        continue;
      }
      const keys = {
        apiKey: await decryptCredential(
          credential.apiKeyCiphertext,
          credential.apiKeyIv,
          credentialContext(
            order.ownerEmail,
            order.accountId,
            "api-key",
          ),
        ),
        secretKey: await decryptCredential(
          credential.secretKeyCiphertext,
          credential.secretKeyIv,
          credentialContext(
            order.ownerEmail,
            order.accountId,
            "secret-key",
          ),
        ),
      };
      const queried = await queryLiveOrder(
        keys,
        order.symbol,
        order.clientOrderId,
      );
      const exchangeStatus = String(
        queried.data.status ?? "",
      ).toUpperCase();
      const executedQuantity = Number(queried.data.executedQty) || 0;
      const canonicalStatus = liveOrderStatusFromExchange(
        exchangeStatus,
        executedQuantity,
      );
      const resolution = resolveUnknownEntryOrder(
        exchangeStatus,
        executedQuantity,
      );
      if (resolution === "WAIT") {
        await db
          .update(liveOrderEvents)
          .set({
            exchangeOrderId:
              String(queried.data.orderId || "") || order.exchangeOrderId,
            status: canonicalStatus,
            responseJson: JSON.stringify({
              ...asRecord(parseJson(order.responseJson)),
              ...queried.data,
              lifecycleSynchronizedAt: new Date().toISOString(),
            }),
            updatedAt: new Date(),
          })
          .where(eq(liveOrderEvents.id, order.id));
        waiting += 1;
        if (terminalTraceWorkingIdSet.has(order.id))
          terminalTraceWorking += 1;
        continue;
      }
      const confirmedExecution =
        resolution === "CONFIRMED_EXECUTION";
      const stored = asRecord(parseJson(order.responseJson));
      let recoveredPositionId: number | null = null;
      const strategyTraceId = strategyTraceIdFromClientOrderId(
        order.clientOrderId,
      );
      const [strategyTraceReference] =
        Number.isSafeInteger(strategyTraceId) && strategyTraceId! > 0
          ? await db
              .select({
                traceId: strategyExecutionTraces.traceId,
                strategyId: strategyExecutionTraces.strategyId,
              })
              .from(strategyExecutionTraces)
              .where(eq(strategyExecutionTraces.id, strategyTraceId!))
              .limit(1)
          : [];
      if (confirmedExecution) {
        const contractSymbol = await db
          .select()
          .from(contractSymbols)
          .where(eq(contractSymbols.symbol, order.symbol))
          .limit(1)
          .then((items) => items[0]);
        const representedRows = await db
          .select()
          .from(livePositions)
          .where(
            and(
              eq(livePositions.ownerEmail, order.ownerEmail),
              eq(livePositions.accountId, order.accountId),
              eq(livePositions.credentialId, order.credentialId),
              eq(livePositions.symbol, order.symbol),
              eq(livePositions.positionSide, order.positionSide),
              inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
            ),
          );
        const sourceRepresented = representedRows.find(
          (represented) => represented.sourceEventId === order.id,
        );
        let snapshot: Awaited<ReturnType<typeof getLivePositionSnapshot>> | null = null;
        if (representedRows.length > 0 && !sourceRepresented) {
          try {
            snapshot = await getLivePositionSnapshot(
              keys,
              order.symbol,
              order.positionSide,
            );
          } catch {
            // Aggregate same-side exposure needs positionRisk before it can be
            // merged safely. A brand-new missing position does not.
          }
        }
        const orderAveragePrice = Number(queried.data.avgPrice) ||
          (executedQuantity > 0
            ? Number(
                ("cumQuote" in queried.data ? queried.data.cumQuote : 0) || 0,
              ) / executedQuantity
            : 0) ||
          Number(queried.data.price) ||
          order.referencePrice;
        const strategyPendingEntry = asRecord(stored.strategyPendingEntry);
        const manualPendingEntry = asRecord(stored.manualPendingEntry);
        const pendingEntry = Object.keys(strategyPendingEntry).length
          ? strategyPendingEntry
          : manualPendingEntry;
        const recoveredLeverage = pendingOrderLeverage(
          order,
          Number(snapshot?.leverage) || Number(pendingEntry.leverage) || 1,
        );
        const recoveryBasis = {
          quantity: snapshot?.quantity && snapshot.quantity > 0
            ? snapshot.quantity
            : executedQuantity,
          entryPrice: snapshot?.entryPrice && snapshot.entryPrice > 0
            ? snapshot.entryPrice
            : orderAveragePrice,
          markPrice: snapshot?.markPrice && snapshot.markPrice > 0
            ? snapshot.markPrice
            : orderAveragePrice,
          liquidationPrice: snapshot?.liquidationPrice ?? null,
          liquidationPriceRaw: snapshot?.liquidationPriceRaw ?? null,
          liquidationPriceStatus:
            snapshot?.liquidationPriceStatus ?? "UNKNOWN",
          liquidationPriceObservedAt:
            snapshot?.liquidationPriceObservedAt ?? null,
          leverage: recoveredLeverage,
        };
        if (
          recoveryBasis.quantity > 0 &&
          recoveryBasis.entryPrice > 0 &&
          recoveryBasis.markPrice > 0
        ) {
          const storedRiskPlan = asRecord(pendingEntry.riskPlan);
          const hasStoredRiskPlan = Object.keys(storedRiskPlan).length > 0;
          const hasStoredProtection = hasStoredRiskPlan ||
            Array.isArray(pendingEntry.takeProfits) ||
            Array.isArray(pendingEntry.stopLosses);
          const recoveredDynamicProfitProtectionEnabled =
            pendingEntry.dynamicProfitProtectionEnabled !== false &&
            Number(pendingEntry.trailingStopPercent) > 0;
          const riskPlan = {
            ...(hasStoredRiskPlan
              ? storedRiskPlan
              : {
                  calculationMode: "ROE",
                  orderOrigin:
                    typeof pendingEntry.orderOrigin === "string"
                      ? pendingEntry.orderOrigin
                      : "RECOVERED_UNKNOWN_ENTRY",
                  opportunityContext: pendingEntry.opportunityContext ?? null,
                  entryStructureBaseline:
                    pendingEntry.entryStructureBaseline ?? null,
                  dynamicProfitProtectionEnabled:
                    recoveredDynamicProfitProtectionEnabled,
                  capitalPreservationStopVersion:
                    "nexus-capital-preservation-stop-v1",
                  capitalPreservationStopRoePercent:
                    Number(pendingEntry.capitalPreservationStopRoePercent) > 0
                      ? Number(
                          pendingEntry.capitalPreservationStopRoePercent,
                        )
                      : null,
                  takeProfits: Array.isArray(pendingEntry.takeProfits)
                    ? pendingEntry.takeProfits
                    : [],
                  stopLosses: !recoveredDynamicProfitProtectionEnabled &&
                    Array.isArray(pendingEntry.stopLosses)
                    ? pendingEntry.stopLosses
                    : [],
                }),
            recovery: {
              ...asRecord(storedRiskPlan.recovery),
              version: 1,
              source: "UNKNOWN_ENTRY_RECONCILIATION",
              protectionRecovered: hasStoredProtection,
              requiresOperatorReview: !hasStoredProtection,
            },
          };
          const openedAtValue = Number(
            queried.data.time ?? queried.data.updateTime,
          );
          const representedQuantity = representedRows.reduce(
            (sum, position) => sum + Math.max(0, position.quantity),
            0,
          );
          const recoveredQuantity = recoverableEntryQuantity(
            executedQuantity,
            recoveryBasis.quantity,
            representedQuantity,
          );
          if (!snapshot && representedRows.length > 0 && !sourceRepresented) {
            // Without the aggregate positionRisk basis, a second same-side
            // fill cannot safely rewrite an existing position's average price.
            waiting += 1;
            continue;
          }
          let position: { id: number } | null = sourceRepresented
            ? { id: sourceRepresented.id }
            : representedRows[0]
              ? { id: representedRows[0].id }
            : null;
          if (recoveredQuantity > 1e-12 && !sourceRepresented) {
            const recoveredOpenedAt =
              Number.isFinite(openedAtValue) && openedAtValue > 0
                ? new Date(openedAtValue)
                : new Date();
            const positionHandoff = buildFilledPositionHandoff({
              origin: "LEGACY_ADOPTED",
              sourceEventId: order.id,
              lifecycleId: order.lifecycleId,
              entryDecisionHandoffJson: order.entryDecisionHandoffJson,
              symbol: order.symbol,
              positionSide: order.positionSide,
              quantity: recoveredQuantity,
              entryPrice: recoveryBasis.entryPrice,
              leverage: recoveryBasis.leverage,
              filledAt: recoveredOpenedAt,
            });
            const [createdPosition] = await db
              .insert(livePositions)
              .values({
                ownerEmail: order.ownerEmail,
                accountId: order.accountId,
                credentialId: order.credentialId,
                sourceEventId: order.id,
                lifecycleId: order.lifecycleId,
                entryDecisionHandoffJson: order.entryDecisionHandoffJson,
                positionHandoffKey: positionHandoff.handoffKey,
                positionHandoffVersion:
                  FILLED_POSITION_HANDOFF_CONTRACT_VERSION,
                positionHandoffJson: JSON.stringify(positionHandoff),
                symbol: order.symbol,
                instrumentId: contractSymbol?.instrumentId ??
                  buildInstrumentId({ symbol: order.symbol }),
                instrumentRuleVersion: contractSymbol?.ruleVersion ?? 1,
                positionSide: order.positionSide,
                quantity: recoveredQuantity,
                entryPrice: recoveryBasis.entryPrice,
                markPrice: recoveryBasis.markPrice,
                liquidationPrice: Number.isFinite(recoveryBasis.liquidationPrice) &&
                    Number(recoveryBasis.liquidationPrice) > 0
                  ? recoveryBasis.liquidationPrice
                  : null,
                liquidationPriceRaw: recoveryBasis.liquidationPriceRaw,
                liquidationPriceStatus:
                  recoveryBasis.liquidationPriceStatus,
                liquidationPriceObservedAt:
                  recoveryBasis.liquidationPriceObservedAt === null
                    ? null
                    : new Date(recoveryBasis.liquidationPriceObservedAt),
                leverage:
                  Number.isFinite(recoveryBasis.leverage) && recoveryBasis.leverage > 0
                    ? recoveryBasis.leverage
                    : Math.max(1, Number(pendingEntry.leverage) || 1),
                riskPlanJson: JSON.stringify(activateProtectionPlan({
                  plan: riskPlan,
                  nowMs: Date.now(),
                  state: hasStoredProtection ? "ACTIVE" : "ERROR",
                })),
                protectionState: hasStoredProtection ? "ACTIVE" : "ERROR",
                trailingActivationPercent: Math.max(
                  0,
                  hasStoredProtection
                    ? Number(pendingEntry.trailingActivationPercent) || 0
                    : 0,
                ),
                trailingStopPercent: Math.max(
                  0,
                  hasStoredProtection
                    ? Number(pendingEntry.trailingStopPercent) || 0
                    : 0,
                ),
                favorablePrice: recoveryBasis.markPrice,
                status: "OPEN",
                lastError: hasStoredProtection
                  ? null
                  : "该仓位由未知订单核对恢复；原保护参数不可证明，请立即检查并重新配置止盈止损",
                openedAt: recoveredOpenedAt,
                updatedAt: new Date(),
              })
              .onConflictDoNothing()
              .returning({ id: livePositions.id });
            const [sourcePosition] = createdPosition
              ? [createdPosition]
              : await db
                  .select({ id: livePositions.id })
                  .from(livePositions)
                  .where(eq(livePositions.sourceEventId, order.id))
                  .limit(1);
            position = sourcePosition ?? position;
          }
          recoveredPositionId = position?.id ?? null;
          if (!recoveredPositionId)
            throw new Error("成交已确认，但本地仓位恢复失败");
          await Promise.all(representedRows.map((represented) => {
            const basisChanged =
              Math.abs(represented.entryPrice - recoveryBasis.entryPrice) >
                Math.max(1e-12, Math.abs(represented.entryPrice) * 1e-10);
            const nextPositionVersion = basisChanged
              ? represented.positionVersion + 1
              : represented.positionVersion;
            const nextProtectionVersion = basisChanged
              ? represented.protectionVersion + 1
              : represented.protectionVersion;
            const currentPlan = asRecord(parseJson(represented.riskPlanJson));
            const nextPlan = basisChanged
              ? rebuildProtectionAfterAddition({
                  plan: currentPlan,
                  rebalancedTakeProfits: Array.isArray(
                      currentPlan.takeProfits,
                  )
                    ? currentPlan.takeProfits
                    : [],
                  rebalancedStopLosses: Array.isArray(
                      currentPlan.stopLosses,
                    )
                    ? currentPlan.stopLosses
                    : [],
                  nextPositionVersion,
                  nextProtectionVersion,
                  nowMs: Date.now(),
                  source: "AUTO_ADD_ON",
                })
              : currentPlan;
            return db
              .update(livePositions)
              .set({
                quantity:
                  represented.sourceEventId === order.id &&
                    recoveredQuantity > 1e-12
                    ? represented.quantity + recoveredQuantity
                    : represented.quantity,
                entryPrice: recoveryBasis.entryPrice,
                markPrice: recoveryBasis.markPrice,
                liquidationPrice: Number.isFinite(recoveryBasis.liquidationPrice)
                  ? Number(recoveryBasis.liquidationPrice) > 0
                    ? recoveryBasis.liquidationPrice
                    : null
                  : represented.liquidationPrice,
                liquidationPriceRaw: recoveryBasis.liquidationPriceRaw ??
                  represented.liquidationPriceRaw,
                liquidationPriceStatus:
                  recoveryBasis.liquidationPriceStatus === "UNKNOWN"
                    ? represented.liquidationPriceStatus
                    : recoveryBasis.liquidationPriceStatus,
                liquidationPriceObservedAt:
                  recoveryBasis.liquidationPriceObservedAt === null
                    ? represented.liquidationPriceObservedAt
                    : new Date(recoveryBasis.liquidationPriceObservedAt),
                leverage:
                  Number.isFinite(recoveryBasis.leverage) && recoveryBasis.leverage > 0
                    ? recoveryBasis.leverage
                    : Math.max(1, Number(pendingEntry.leverage) || 1),
                instrumentId: represented.instrumentId ??
                  contractSymbol?.instrumentId ??
                  buildInstrumentId({ symbol: order.symbol }),
                instrumentRuleVersion:
                  contractSymbol?.ruleVersion ??
                  represented.instrumentRuleVersion,
                positionVersion: nextPositionVersion,
                protectionVersion: nextProtectionVersion,
                protectionState: basisChanged
                  ? "ACTIVE"
                  : represented.protectionState,
                protectionUpdatedAt: basisChanged
                  ? new Date()
                  : represented.protectionUpdatedAt,
                riskPlanJson: JSON.stringify(nextPlan),
                trailingActivationPercent:
                  represented.trailingActivationPercent,
                trailingStopPercent: represented.trailingStopPercent,
                favorablePrice: monotonicFavorablePrice({
                  positionSide: represented.positionSide,
                  entryPrice: recoveryBasis.entryPrice,
                  previousFavorablePrice: represented.favorablePrice,
                  currentMarkPrice: recoveryBasis.markPrice,
                  reset: basisChanged,
                }),
                updatedAt: new Date(),
              })
              .where(and(
                eq(livePositions.id, represented.id),
                eq(
                  livePositions.positionVersion,
                  represented.positionVersion,
                ),
                eq(
                  livePositions.protectionVersion,
                  represented.protectionVersion,
                ),
              ));
          }));
        }
      }
      const reconciledAt = new Date();
      const exchangeOrderId =
        String(queried.data.orderId || "") || order.exchangeOrderId;
      const reconciledResponse =
        Number.isSafeInteger(strategyTraceId) && strategyTraceId! > 0
          ? filledPendingOrderResponse(
              order,
              queried.data,
              pendingOrderLeverage(order, 1),
            )
          : {
              ...stored,
              ...queried.data,
            };
      const orderUpdate = db
        .update(liveOrderEvents)
        .set({
          exchangeOrderId,
          status: canonicalStatus,
          responseJson: JSON.stringify({
            ...reconciledResponse,
            executionUnknownReconciledAt: reconciledAt.toISOString(),
            executionUnknownResolution: confirmedExecution
              ? "EXCHANGE_CONFIRMED_EXECUTION"
              : "EXCHANGE_CONFIRMED_NO_FILL",
            recoveredPositionId,
            positionRecoveryResolvedAt: confirmedExecution
              ? reconciledAt.toISOString()
              : null,
          }),
          updatedAt: reconciledAt,
        })
        .where(
          and(
            eq(liveOrderEvents.id, order.id),
            inArray(liveOrderEvents.status, [
              "PENDING",
              "NEW",
              "PARTIALLY_FILLED",
              "CANCEL_PENDING",
              "EXECUTION_UNKNOWN",
              "SUBMITTED",
              "FILLED",
            ]),
          ),
        );
      if (Number.isSafeInteger(strategyTraceId) && strategyTraceId! > 0) {
        const traceState = recoveredStrategyTraceState({
          confirmedExecution,
          canonicalOrderStatus: canonicalStatus,
        });
        const traceResultCode = confirmedExecution
          ? "ORDER_FILLED_POSITION_RECOVERED"
          : `UNKNOWN_ORDER_${canonicalStatus}`;
        const traceUpdate = db
          .update(strategyExecutionTraces)
          .set({
            state: traceState,
            resultCode: traceResultCode,
            resultMessage: confirmedExecution
              ? "交易所成交、真实仓位、执行意图与策略学习轨迹已恢复一致"
              : `交易所确认订单未成交并已${canonicalStatus === "EXPIRED" ? "过期" : canonicalStatus === "REJECTED" ? "拒绝" : "撤销"}，不会重复提交`,
            exchangeOrderId,
            positionId: confirmedExecution && recoveredPositionId
              ? String(recoveredPositionId)
              : null,
            completedAt: confirmedExecution ? null : reconciledAt,
            updatedAt: reconciledAt,
          })
          .where(
            and(
              eq(strategyExecutionTraces.id, strategyTraceId!),
              eq(strategyExecutionTraces.ownerEmail, order.ownerEmail),
              eq(strategyExecutionTraces.accountId, order.accountId),
              eq(strategyExecutionTraces.symbol, order.symbol),
              inArray(strategyExecutionTraces.state, [
                "ORDER_READY",
                "ORDER_PENDING",
                "EXECUTION_UNKNOWN",
                "CLOSED",
                "EXPIRED",
                "REJECTED",
                "CANCELED",
              ]),
            ),
          );
        await db.batch([orderUpdate, traceUpdate]);
      } else {
        await orderUpdate;
      }
      if (
        Number.isSafeInteger(strategyTraceId) &&
        strategyTraceId! > 0 &&
        ["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(
          canonicalStatus,
        )
      ) {
        try {
          await settleNexusExecutionIntentWithLiveOrder({
            traceId: order.lifecycleId ?? undefined,
            liveOrderEventId: order.id,
            nextStatus: canonicalStatus === "FILLED"
              ? "FILLED"
              : canonicalStatus === "REJECTED"
                ? "REJECTED"
                : "CANCELED",
            liveOrderStatus: canonicalStatus as
              | "FILLED"
              | "CANCELED"
              | "EXPIRED"
              | "REJECTED",
            exchangeOrderId,
            livePositionId: recoveredPositionId,
            filledQuantity: executedQuantity,
            detail: {
              reconciliationSource:
                "TERMINAL_TRACE_WORKING_ORDER_REPAIR",
              exchangeStatus,
            },
            reasonCode: `EXCHANGE_TERMINAL_${canonicalStatus}`,
            reasonMessage:
              "已按交易所真实终态统一收口订单、执行意图和资金预留",
          });
        } catch {
          // The terminal order and trace truth is already durable. The
          // execution-intent reconciliation immediately following this lane
          // retries the remaining binding without creating another order.
        }
      }
      if (confirmedExecution && strategyTraceReference) {
        try {
          await appendStrategyPositionManagementEvent({
            traceId: strategyTraceReference.traceId,
            strategyId: strategyTraceReference.strategyId,
            eventType:
              "POSITION_OPEN_RECOVERED_FROM_ORDER_RECONCILIATION",
            outcome: "PASSED",
            message:
              "Binance 成交、执行意图、真实仓位和策略轨迹已完成恢复闭环",
            detail: {
              liveOrderEventId: order.id,
              exchangeOrderId,
              recoveredPositionId,
              executedQuantity,
              originalOrderStatus: order.status,
              resolution: "EXCHANGE_CONFIRMED_EXECUTION",
            },
            eventAt: reconciledAt,
          });
        } catch {
          // 订单、仓位、轨迹和执行意图已形成持久化事实；诊断事件可由
          // 后续生命周期巡检补齐，不能反向改变真实成交状态。
        }
      }
      reconciled += 1;
    } catch {
      errors += 1;
      if (terminalTraceWorkingIdSet.has(order.id)) {
        const repairFailedAt = new Date();
        await db.batch([
          db
            .update(liveOrderEvents)
            .set({
              status: "EXECUTION_UNKNOWN",
              responseJson: JSON.stringify({
                ...asRecord(parseJson(order.responseJson)),
                terminalTraceRepairFailedAt:
                  repairFailedAt.toISOString(),
                terminalTraceRepairRequired: true,
              }),
              updatedAt: repairFailedAt,
            })
            .where(eq(liveOrderEvents.id, order.id)),
          db
            .update(strategyExecutionTraces)
            .set({
              state: "EXECUTION_UNKNOWN",
              resultCode: "TERMINAL_TRACE_ORDER_VERIFICATION_FAILED",
              resultMessage:
                "本地轨迹已结束但交易所订单终态暂不可确认，禁止重复下单并继续核对",
              completedAt: null,
              updatedAt: repairFailedAt,
            })
            .where(eq(strategyExecutionTraces.traceId, order.lifecycleId ?? "")),
        ]);
        terminalTraceWorking += 1;
      }
    }
  }
  return {
    checked: rows.length,
    reconciled,
    waiting,
    errors,
    terminalTraceWorking,
  };
}

async function reconcilePendingLivePositionClosures(
  now: Date,
  limit = 3,
) {
  const db = getDb();
  // Historical versions could leave a close intent on an already-closed row.
  // Clear that inert state before looking at real pending positions.
  await db
    .update(livePositions)
    .set({
      riskLeaseUntil: null,
      pendingCloseClientOrderId: null,
      pendingCloseReason: null,
      pendingCloseQuantity: null,
      pendingClosePlanJson: null,
      updatedAt: now,
    })
    .where(and(
      eq(livePositions.status, "CLOSED"),
      isNotNull(livePositions.pendingCloseClientOrderId),
    ));
  const positions = await db
    .select()
    .from(livePositions)
    .where(and(
      isNotNull(livePositions.pendingCloseClientOrderId),
      or(
        eq(livePositions.status, "OPEN"),
        eq(livePositions.status, "EXECUTION_UNKNOWN"),
      ),
    ))
    .orderBy(asc(livePositions.updatedAt))
    .limit(limit);
  let reconciled = 0;
  let released = 0;
  let waiting = 0;
  let errors = 0;

  for (const position of positions) {
    const clientOrderId = position.pendingCloseClientOrderId;
    if (!clientOrderId) continue;
    const reason = position.pendingCloseReason ?? "MANUAL";
    try {
      const [credential, quantityRule] = await Promise.all([
        db
          .select()
          .from(exchangeCredentials)
          .where(and(
            eq(exchangeCredentials.id, position.credentialId),
            eq(exchangeCredentials.ownerEmail, position.ownerEmail),
          ))
          .limit(1)
          .then((rows) => rows[0]),
        db
          .select({
            minOrderQty: contractSymbols.minOrderQty,
            quantityStep: contractSymbols.quantityStep,
          })
          .from(contractSymbols)
          .where(eq(contractSymbols.symbol, position.symbol))
          .limit(1)
          .then((rows) => rows[0]),
      ]);
      if (!credential || !quantityRule) {
        errors += 1;
        continue;
      }
      const keys = {
        apiKey: await decryptCredential(
          credential.apiKeyCiphertext,
          credential.apiKeyIv,
          credentialContext(position.ownerEmail, position.accountId, "api-key"),
        ),
        secretKey: await decryptCredential(
          credential.secretKeyCiphertext,
          credential.secretKeyIv,
          credentialContext(position.ownerEmail, position.accountId, "secret-key"),
        ),
      };
      // The current Binance position is the authoritative close state. A
      // reduce-only order can be filled before avgPrice or user-trade rows are
      // readable. Do not keep a ghost position open while waiting for those
      // accounting details: converge the position first, then backfill fees
      // and exact PnL independently.
      const exchangePosition = await getLivePositionSnapshot(
        keys,
        position.symbol,
        position.positionSide,
      );
      if (exchangePosition.quantity <= 1e-12) {
        const zeroClose = resolveExchangeZeroClose({
          localQuantity: position.quantity,
          entryPrice: position.entryPrice,
          lastMarkPrice: position.markPrice,
          positionSide: position.positionSide,
        });
        if (!zeroClose) {
          errors += 1;
          continue;
        }
        const settlement = buildReductionSettlement({
          localGrossRealizedPnl: zeroClose.localGrossRealizedPnl,
          executedQuantity: zeroClose.executedQuantity,
          entryOrderQuantity: null,
          entryTrades: [],
          exitTrades: [],
          fundingAttribution: "UNAVAILABLE",
        });
        await recordLivePositionReduction({
            positionId: position.id,
            lifecycleId: position.lifecycleId,
            ownerEmail: position.ownerEmail,
            accountId: position.accountId,
            clientOrderId,
            exchangeOrderId: clientOrderId,
            symbol: position.symbol,
            positionSide: position.positionSide,
            quantity: zeroClose.executedQuantity,
            exitPrice: zeroClose.provisionalExitPrice,
            realizedPnl: settlement.grossRealizedPnl,
            reason,
            responseJson: JSON.stringify(attachReductionSettlement({
              status: "FILLED",
              clientOrderId,
              nexusReconciliation: {
                basis: "BINANCE_POSITION_ZERO",
                provisionalExitPrice: true,
                tradeDetailsPending: true,
              },
            }, settlement)),
            createdAt: now,
          }, { idempotent: true });
        const updated = await db
          .update(livePositions)
          .set({
            quantity: zeroClose.executedQuantity,
            markPrice: zeroClose.provisionalExitPrice,
            status: "CLOSED",
            exitReason: reason,
            realizedPnl: position.realizedPnl + settlement.grossRealizedPnl,
            closedAt: now,
            riskLeaseUntil: null,
            pendingCloseClientOrderId: null,
            pendingCloseReason: null,
            pendingCloseQuantity: null,
            pendingClosePlanJson: null,
            lastError: null,
            updatedAt: now,
          })
          .where(and(
            eq(livePositions.id, position.id),
            eq(livePositions.pendingCloseClientOrderId, clientOrderId),
          ))
          .returning({ id: livePositions.id });
        if (updated.length === 0) {
          waiting += 1;
          continue;
        }
        await writeAudit(
          { email: position.ownerEmail, accountId: position.accountId },
          "RECONCILE_LIVE_CLOSE_FROM_POSITION_ZERO",
          "live_position",
          String(position.id),
          {
            clientOrderId,
            executedQuantity: zeroClose.executedQuantity,
            provisionalExitPrice: zeroClose.provisionalExitPrice,
            tradeDetailsPending: true,
          },
        );
        reconciled += 1;
        continue;
      }
      const result = await queryLiveOrder(keys, position.symbol, clientOrderId);
      let fill = resolveLiveOrderFill(result.data);
      if (
        fill.executedQuantity > 0 &&
        fill.executionPrice <= 0 &&
        fill.exchangeOrderId
      ) {
        const trades = await getBinanceLiveOrderTrades(
          keys,
          position.symbol,
          fill.exchangeOrderId,
        );
        const tradeFill = resolveLiveOrderTradeFill(trades);
        if (tradeFill.executedQuantity > 0 && tradeFill.executionPrice > 0)
          fill = {
            ...fill,
            executedQuantity: tradeFill.executedQuantity,
            executionPrice: tradeFill.executionPrice,
          };
      }
      if (
        ["CANCELED", "EXPIRED", "REJECTED"].includes(fill.status) &&
        fill.executedQuantity <= 0
      ) {
        await db
          .update(livePositions)
          .set({
            status: "OPEN",
            riskLeaseUntil: null,
            pendingCloseClientOrderId: null,
            pendingCloseReason: null,
            pendingCloseQuantity: null,
            pendingClosePlanJson: null,
            lastError: `Binance 平仓委托已${fill.status}且未成交，仓位已解除占用并继续保护`,
            updatedAt: now,
          })
          .where(and(
            eq(livePositions.id, position.id),
            eq(livePositions.pendingCloseClientOrderId, clientOrderId),
          ));
        await writeAudit(
          { email: position.ownerEmail, accountId: position.accountId },
          "RECONCILE_LIVE_CLOSE_NOT_FILLED",
          "live_position",
          String(position.id),
          { clientOrderId, status: fill.status },
        );
        released += 1;
        continue;
      }
      if (["NEW", "PARTIALLY_FILLED", "PENDING_NEW"].includes(fill.status)) {
        waiting += 1;
        continue;
      }
      if (
        fill.executedQuantity <= 0 ||
        fill.executionPrice <= 0 ||
        !Number.isFinite(fill.executedQuantity) ||
        !Number.isFinite(fill.executionPrice)
      ) {
        waiting += 1;
        continue;
      }

      const executedQuantity = Math.min(
        position.quantity,
        fill.executedQuantity,
      );
      const exitPrice = fill.executionPrice;
      const remainingQuantity = subtractOrderQuantity(
        position.quantity,
        executedQuantity,
        quantityRule.quantityStep,
      );
      if (!Number.isFinite(remainingQuantity)) {
        errors += 1;
        continue;
      }
      const closed = remainingQuantity <= 1e-12;
      const closedAt = now;
      const localGrossRealizedPnl = position.positionSide === "LONG"
        ? (exitPrice - position.entryPrice) * executedQuantity
        : (position.entryPrice - exitPrice) * executedQuantity;
      const settlement = buildReductionSettlement({
        localGrossRealizedPnl,
        executedQuantity,
        entryOrderQuantity: null,
        entryTrades: [],
        exitTrades: [],
        fundingAttribution: closed ? "UNAVAILABLE" : "NOT_REQUESTED_PARTIAL",
      });
      const realizedPnl = settlement.grossRealizedPnl;
      let executed = parseExecutedPlan(position.executedRiskPlanJson);
      const plan = parseRiskPlan(position.riskPlanJson);
      const pending = asRecord(parseJson(position.pendingClosePlanJson ?? "{}"));
      const pendingEvidenceRisk = asRecord(pending.evidenceRisk);
      const indexes = Array.isArray(pending.indexes)
        ? pending.indexes.filter((value): value is number => Number.isInteger(value))
        : [];
      const takeProfitFillGuard = reason === "TAKE_PROFIT"
        ? takeProfitFillConsumesGrid({
            positionSide: position.positionSide,
            entryPrice: position.entryPrice,
            exitPrice,
            leverage: position.leverage,
            quantity: executedQuantity,
            triggerRoePercent: Math.min(
              ...indexes.map((index) =>
                Number(plan.takeProfits[index]?.triggerPercent),
              ).filter(Number.isFinite),
            ),
          })
        : null;
      if (reason === "STOP_LOSS" && !pendingEvidenceRisk.action)
        executed = applyStopLossExecution({ progress: executed, indexes });
      if (
        reason === "STOP_LOSS" &&
        pendingEvidenceRisk.action === "REDUCE_PARTIAL"
      ) executed = applyEvidenceRiskReductionExecution({
        progress: executed,
        executedQuantity,
        reductionPercent: Number(pendingEvidenceRisk.reductionPercent),
        executedAtMs: closedAt.getTime(),
        opportunityId:
          typeof pendingEvidenceRisk.opportunityId === "string"
            ? pendingEvidenceRisk.opportunityId
            : null,
      });
      if (reason === "TAKE_PROFIT" && takeProfitFillGuard?.eligible) {
        executed = applyTakeProfitExecution({
          progress: executed,
          levels: indexes.map((index) => ({
            index,
            plannedQuantity: Number(plan.takeProfits[index]?.closeQuantity ?? 0),
          })),
          executedQuantity,
        });
        executed = recordVerifiedTakeProfitExecution({
          progress: executed,
          executedQuantity,
          executedAtMs: closedAt.getTime(),
        });
      }
      const dynamicProfitReduction = pending.dynamicProfitReduction &&
        typeof pending.dynamicProfitReduction === "object"
        ? pending.dynamicProfitReduction as unknown as DynamicProfitReductionDecision
        : null;
      if (
        reason === "TRAILING_STOP" &&
        dynamicProfitReduction &&
        dynamicProfitReduction.stage > 0
      ) executed = applyDynamicProfitReductionExecution({
        progress: executed,
        stage: dynamicProfitReduction.stage,
        anchorQuantity: dynamicProfitReduction.anchorQuantity,
        executedQuantity,
        triggerRoePercent: positionRoePercent(
          position.entryPrice,
          exitPrice,
          position.leverage,
          position.positionSide,
        ),
        executedAtMs: closedAt.getTime(),
      });
      const nextPositionVersion = position.positionVersion + 1;
      const nextProtectionVersion = position.protectionVersion + 1;
      const reductionProtection = closed
        ? null
        : rebuildProtectionAfterReduction({
            riskPlanJson: position.riskPlanJson,
            executedRiskPlanJson: JSON.stringify(executed),
            remainingQuantity,
            minOrderQty: quantityRule.minOrderQty,
            quantityStep: quantityRule.quantityStep,
            trailingStopPercent: position.trailingStopPercent,
            nextPositionVersion,
            nextProtectionVersion,
            nowMs: closedAt.getTime(),
            source: "RECONCILIATION",
          });
      await recordLivePositionReduction({
          positionId: position.id,
          lifecycleId: position.lifecycleId,
          ownerEmail: position.ownerEmail,
          accountId: position.accountId,
          clientOrderId,
          exchangeOrderId: String(fill.exchangeOrderId ?? result.data.orderId),
          symbol: position.symbol,
          positionSide: position.positionSide,
          quantity: executedQuantity,
          exitPrice,
          realizedPnl,
          reason,
          responseJson: JSON.stringify({
            ...attachReductionSettlement(result.data, settlement),
            structureExit: pending.structureExit === true,
            protectionTrigger:
              pendingEvidenceRisk.action === "REDUCE_PARTIAL"
                ? "EVIDENCE_RISK_PARTIAL_REDUCTION"
                : pendingEvidenceRisk.action === "EXIT_FULL"
                  ? "EVIDENCE_RISK_FULL_EXIT"
                  : reason,
            accountDrawdownExit: pending.accountDrawdownExit ?? null,
            positionManagement: pending.positionManagement ?? null,
            evidenceRisk: pending.evidenceRisk ?? null,
            executionAdjustment: pending.executionAdjustment ?? null,
            takeProfitExecutionGuard: takeProfitFillGuard,
            takeProfitGridConsumed:
              reason !== "TAKE_PROFIT" || takeProfitFillGuard?.eligible === true,
          }),
          createdAt: closedAt,
        }, { idempotent: true });
      const updated = await db
        .update(livePositions)
        .set({
          quantity: closed ? executedQuantity : remainingQuantity,
          markPrice: exitPrice,
          riskPlanJson: reductionProtection
            ? JSON.stringify(reductionProtection.plan)
            : position.riskPlanJson,
          executedRiskPlanJson: JSON.stringify(
            reductionProtection?.executed ?? executed,
          ),
          positionVersion: closed ? position.positionVersion : nextPositionVersion,
          protectionVersion: closed ? position.protectionVersion : nextProtectionVersion,
          protectionState: closed ? position.protectionState : "ACTIVE",
          protectionUpdatedAt: closed ? position.protectionUpdatedAt : closedAt,
          status: closed ? "CLOSED" : "OPEN",
          exitReason: closed ? reason : null,
          realizedPnl: position.realizedPnl + realizedPnl,
          closedAt: closed ? closedAt : null,
          riskLeaseUntil: null,
          pendingCloseClientOrderId: null,
          pendingCloseReason: null,
          pendingCloseQuantity: null,
          pendingClosePlanJson: null,
          lastError: null,
          updatedAt: closedAt,
        })
        .where(and(
          eq(livePositions.id, position.id),
          eq(livePositions.positionVersion, position.positionVersion),
          eq(livePositions.protectionVersion, position.protectionVersion),
          eq(livePositions.pendingCloseClientOrderId, clientOrderId),
        ))
        .returning({ id: livePositions.id });
      if (updated.length === 0) {
        waiting += 1;
        continue;
      }
      await writeAudit(
        { email: position.ownerEmail, accountId: position.accountId },
        "RECONCILE_LIVE_RISK_EXECUTION",
        "live_position",
        String(position.id),
        {
          clientOrderId,
          exchangeOrderId: fill.exchangeOrderId ?? result.data.orderId,
          executedQuantity,
          exitPrice,
          remainingQuantity,
          protectionRebalanced: Boolean(reductionProtection),
        },
      );
      reconciled += 1;
    } catch (error) {
      const staleForMs = now.getTime() - position.updatedAt.getTime();
      if (
        error instanceof BinanceLiveError &&
        error.code === -2013 &&
        staleForMs >= 30_000
      ) {
        await db
          .update(livePositions)
          .set({
            status: "OPEN",
            riskLeaseUntil: null,
            pendingCloseClientOrderId: null,
            pendingCloseReason: null,
            pendingCloseQuantity: null,
            pendingClosePlanJson: null,
            lastError: "Binance 未找到旧平仓委托，系统已解除占用，可重新平仓",
            updatedAt: now,
          })
          .where(and(
            eq(livePositions.id, position.id),
            eq(livePositions.pendingCloseClientOrderId, clientOrderId),
          ));
        await writeAudit(
          { email: position.ownerEmail, accountId: position.accountId },
          "RECONCILE_LIVE_CLOSE_ORDER_NOT_FOUND",
          "live_position",
          String(position.id),
          { clientOrderId, code: error.code, staleForMs },
        );
        released += 1;
        continue;
      }
      errors += 1;
    }
  }
  return {
    checked: positions.length,
    reconciled,
    released,
    waiting,
    errors,
  };
}

async function runLiveRiskAuxiliaryReconciliation(now: Date) {
  if (liveRiskAuxiliaryReconciliationRunning) {
    return {
      ...lastLiveRiskAuxiliaryReconciliation,
      running: true,
      scheduled: false,
    };
  }
  liveRiskAuxiliaryReconciliationRunning = true;
  try {
    let errors = 0;
    const safely = async <T>(task: () => Promise<T>, fallback: T) => {
      try {
        return await task();
      } catch {
        errors += 1;
        return fallback;
      }
    };
    // A blocked close is the highest-priority reconciliation. It runs before
    // entry/add-on maintenance, but remains off the five-second protection
    // lane so signed exchange reads can never delay a new protective close.
    const pendingCloseReconciliation = await safely(
      () => reconcilePendingLivePositionClosures(now),
      { checked: 0, reconciled: 0, released: 0, waiting: 0, errors: 1 },
    );
    // Order-stream repair, add-on reconciliation and unknown-entry lookup can
    // each wait on a signed Binance request.  Add-ons must run first after the
    // private stream so their fill is merged into the existing position and
    // can never be mistaken for an independent entry.
    const privateOrderReconciliation = await safely(
      () => reconcilePrivateOrderStreamEvents(),
      { accounts: 0, events: 0, updated: 0, ignored: 1 },
    );
    const positionAdditionReconciliation = await safely(
      () => reconcilePendingPositionAdditions(now),
      { reconciled: 0, rejected: 0, deferred: 0, errors: 1 },
    );
    const unknownEntryOrderReconciliation = await safely(
      () => reconcileUnknownEntryOrders(),
      {
        checked: 0,
        reconciled: 0,
        waiting: 0,
        errors: 1,
        terminalTraceWorking: 0,
      },
    );
    const executionIntentReconciliation = await safely(
      async () => {
        const repairedIds = await reconcileTerminalNexusExecutionIntents();
        return { checked: true, repaired: repairedIds.length };
      },
      { checked: false, repaired: 0 },
    );
    lastLiveRiskAuxiliaryReconciliation = {
      pendingCloseReconciliation,
      privateOrderReconciliation,
      unknownEntryOrderReconciliation,
      executionIntentReconciliation,
      positionAdditionReconciliation,
      errors,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error(JSON.stringify({
      scope: "live-risk-auxiliary-reconciliation",
      message: error instanceof Error
        ? error.message.slice(0, 240)
        : "辅助订单对账失败",
    }));
  } finally {
    liveRiskAuxiliaryReconciliationRunning = false;
  }
  return {
    ...lastLiveRiskAuxiliaryReconciliation,
    running: false,
    scheduled: true,
  };
}

let liveRiskPositionIntelligenceRunning = false;

function hasPositionIntelligenceOpportunity(positionId: number) {
  const cached = positionIntelligenceOpportunityByPosition.get(positionId);
  if (!cached) return false;
  if (positionIntelligenceHandoffFresh({
    validUntilMs: cached.opportunity.validUntilMs,
    cachedUntilMs: cached.expiresAt,
  })) return true;
  positionIntelligenceOpportunityByPosition.delete(positionId);
  return false;
}

function hasAuthorizedPositionIntelligenceExit(positionId: number) {
  const cached = positionIntelligenceOpportunityByPosition.get(positionId);
  if (!cached) return false;
  if (!hasPositionIntelligenceOpportunity(positionId)) return false;
  return authorizedStructureExitHandoffFresh({
    structureExitAuthorized: cached.opportunity.structureExitAuthorized,
    validUntilMs: cached.opportunity.validUntilMs,
    cachedUntilMs: cached.expiresAt,
  });
}

function peekPositionIntelligenceOpportunity(positionId: number) {
  if (!hasPositionIntelligenceOpportunity(positionId)) return null;
  return positionIntelligenceOpportunityByPosition.get(positionId)
    ?.opportunity ?? null;
}

function takePositionIntelligenceOpportunity(positionId: number) {
  if (!hasPositionIntelligenceOpportunity(positionId)) return null;
  const cached = positionIntelligenceOpportunityByPosition.get(positionId);
  positionIntelligenceOpportunityByPosition.delete(positionId);
  return cached?.opportunity ?? null;
}

async function executePositionIntelligenceCycle() {
  const startedAt = Date.now();
  const db = getDb();
  const candidates = await db
    .select()
    .from(livePositions)
    .where(eq(livePositions.status, "OPEN"));
  const openPositionIds = candidates.map((position) => position.id);
  if (!candidates.length)
    return {
      checked: 0,
      sampled: 0,
      positionId: null,
      symbol: null,
      total: 0,
      due: 0,
      openPositionIds,
      durationMs: Date.now() - startedAt,
    };
  // Entry-structure reconstruction belongs to this slower intelligence plane,
  // never to the five-second deterministic protection lane. Repair at most one
  // legacy strategy position per cycle, then immediately reassess that same
  // position as observation-only. This drains old evidence gaps without a REST
  // burst or any coupling to stop/take/liquidation protection.
  const entryStructureBackfill = await backfillEntryStructureEvidence(
    new Date(startedAt),
    candidates.map((position) => position.id),
  );
  const persistedReassessmentTarget = entryStructureBackfill.positionId
    ? null
    : await findEntryStructureReassessmentTarget(
        candidates.map((position) => position.id),
      );
  const immediateReassessmentPositionId =
    entryStructureBackfill.positionId ??
    entryStructureReassessmentPriorityPositionId;
  const reassessmentPositionId =
    immediateReassessmentPositionId ??
    persistedReassessmentTarget?.positionId ??
    null;
  const duePriorityIds = await pendingDuePositionObservationPriorityIds(
    candidates,
    startedAt,
  );
  const intelligenceDueIds = [
    ...(immediateReassessmentPositionId
      ? [immediateReassessmentPositionId]
      : []),
    ...duePriorityIds,
  ];
  if (!intelligenceDueIds.length)
    return {
      checked: 0,
      sampled: 0,
      positionId: null,
      symbol: null,
      total: candidates.length,
      due: 0,
      openPositionIds,
      entryStructureBackfill,
      durationMs: Date.now() - startedAt,
    };
  const selection = selectRotatingWorkIds({
    // Deep intelligence is event driven. Rotating every open position caused
    // expensive post-entry/addition reads even when no checkpoint was due,
    // competing with the five-second deterministic protection request.
    ids: intelligenceDueIds,
    cursor: positionIntelligenceCursor,
    budget: POSITION_INTELLIGENCE_BUDGET_PER_CYCLE,
    // Only a one-time structure reconstruction may jump the queue. Ordinary
    // due positions must use the rotating cursor; treating every due id as a
    // priority previously selected the first old position every cycle and
    // starved the rest of the portfolio indefinitely.
    priorityIds: immediateReassessmentPositionId
      ? [immediateReassessmentPositionId]
      : [],
  });
  positionIntelligenceCursor = selection.nextCursor;
  const selectedId = selection.selectedIds[0];
  const position = candidates.find((row) => row.id === selectedId);
  if (!position)
    return {
      checked: 0,
      sampled: 0,
      positionId: null,
      symbol: null,
      total: candidates.length,
      due: new Set(intelligenceDueIds).size,
      openPositionIds,
      entryStructureBackfill,
      durationMs: Date.now() - startedAt,
    };

  const [markSnapshot] = await getBinanceLiveMarkPrices([position.symbol]);
  if (
    !markSnapshot ||
    !Number.isFinite(markSnapshot.markPrice) ||
    markSnapshot.markPrice <= 0 ||
    Date.now() - markSnapshot.time > 5_000
  ) throw new Error(`仓位学习行情不可用：${position.symbol}`);

  const markPrice = markSnapshot.markPrice;
  const favorablePrice = monotonicFavorablePrice({
    positionSide: position.positionSide,
    entryPrice: position.entryPrice,
    previousFavorablePrice:
      liveRiskFavorablePriceByPosition.get(position.id) ??
      position.favorablePrice,
    currentMarkPrice: markPrice,
  }) ?? position.entryPrice;
  liveRiskFavorablePriceByPosition.set(position.id, favorablePrice);
  const currentRoePercent = positionRoePercent(
    position.entryPrice,
    markPrice,
    position.leverage,
    position.positionSide,
  );
  const favorableRoePercent = positionRoePercent(
    position.entryPrice,
    favorablePrice,
    position.leverage,
    position.positionSide,
  );
  const opportunity = await recordLiquidationPositionEvidence(
    position,
    markPrice,
    currentRoePercent,
    favorableRoePercent,
    {
      forceEntryStructureReassessment:
        reassessmentPositionId === position.id,
      fundingRate: markSnapshot.fundingRate,
      nextFundingTime: markSnapshot.nextFundingTime,
      markEventAt: markSnapshot.time,
      markReceivedAt: markSnapshot.receivedAt,
      markSnapshotAgeMs: markSnapshot.snapshotAgeMs,
      markTransportLatencyMs: markSnapshot.transportLatencyMs,
    },
  );
  if (opportunity)
    positionIntelligenceOpportunityByPosition.set(position.id, {
      opportunity,
      expiresAt: Date.now() + POSITION_INTELLIGENCE_HANDOFF_TTL_MS,
    });
  // Intelligent additions are deliberately executed on this slower plane.
  // The five-second protection lane must never decrypt credentials, inspect
  // account state or submit an add-on order for a position that has no close
  // trigger. This keeps automatic addition available without coupling it to
  // time-critical stop/take/liquidation protection.
  let addition: Awaited<ReturnType<typeof maybeExecutePositionAddition>> | null = null;
  try {
    addition = await maybeExecutePositionAddition({
      position,
      currentRoePercent,
      opportunity,
    });
    await recordPositionAdditionExecutionOutcome(opportunity, addition);
  } catch {
    // Addition analysis/execution failure belongs to the intelligence plane;
    // the independent protection runner continues without waiting for it.
  }
  if (entryStructureReassessmentPriorityPositionId === position.id)
    entryStructureReassessmentPriorityPositionId = null;
  return {
    checked: 1,
    sampled: opportunity === null ? 0 : 1,
    additionExecuted: addition?.executed === true,
    positionId: position.id,
    symbol: position.symbol,
    total: candidates.length,
    due: new Set(intelligenceDueIds).size,
    openPositionIds,
    entryStructureBackfill,
    durationMs: Date.now() - startedAt,
  };
}

async function runPositionIntelligenceCycle() {
  if (liveRiskPositionIntelligenceRunning)
    return {
      checked: 0,
      sampled: 0,
      positionId: null,
      symbol: null,
      durationMs: 0,
      running: true,
    };
  liveRiskPositionIntelligenceRunning = true;
  try {
    return {
      ...(await executePositionIntelligenceCycle()),
      running: false,
    };
  } finally {
    liveRiskPositionIntelligenceRunning = false;
  }
}

async function backfillOpenPositionCapitalPreservationStops(
  positions: Array<typeof livePositions.$inferSelect>,
  now: Date,
) {
  const targets = positions
    .filter(
      (position) =>
        capitalPreservationStopRoePercent(
          asRecord(parseJson(position.riskPlanJson)),
        ) === null,
    )
    .slice(0, 10);
  if (!targets.length)
    return { checked: 0, updated: 0, unresolved: 0, errors: 0 };
  const db = getDb();
  const positionIds = targets.map((position) => String(position.id));
  const lifecycleIds = targets.flatMap((position) =>
    position.lifecycleId ? [position.lifecycleId] : []
  );
  const traces = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
      configVersion: strategyExecutionTraces.configVersion,
      configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
      positionId: strategyExecutionTraces.positionId,
    })
    .from(strategyExecutionTraces)
    .where(
      lifecycleIds.length
        ? or(
            inArray(strategyExecutionTraces.traceId, lifecycleIds),
            inArray(strategyExecutionTraces.positionId, positionIds),
          )
        : inArray(strategyExecutionTraces.positionId, positionIds),
    )
    .orderBy(desc(strategyExecutionTraces.id));
  const traceByPositionId = new Map<string, (typeof traces)[number]>();
  for (const trace of traces) {
    if (trace.positionId && !traceByPositionId.has(trace.positionId))
      traceByPositionId.set(trace.positionId, trace);
    if (trace.traceId && !traceByPositionId.has(trace.traceId))
      traceByPositionId.set(trace.traceId, trace);
  }
  let updated = 0;
  let unresolved = 0;
  let errors = 0;
  for (const position of targets) {
    try {
      const currentPlan = asRecord(parseJson(position.riskPlanJson));
      let stopRoePercent = maximumConfiguredStopRoePercent(
        currentPlan.stopLosses,
      );
      if (stopRoePercent === null) {
        const trace =
          (position.lifecycleId
            ? traceByPositionId.get(position.lifecycleId)
            : null) ?? traceByPositionId.get(String(position.id));
        if (trace) {
          const config = await loadBoundLiquidationTrendConfig(trace);
          stopRoePercent = Number(config.risk.stopLossPercent);
        }
      }
      if (
        stopRoePercent === null ||
        !Number.isFinite(stopRoePercent) ||
        stopRoePercent <= 0
      ) {
        unresolved += 1;
        continue;
      }
      const nextProtectionVersion = position.protectionVersion + 1;
      const activatedPlan = activateProtectionPlan({
        plan: withCapitalPreservationStop(currentPlan, stopRoePercent),
        positionVersion: position.positionVersion,
        protectionVersion: nextProtectionVersion,
        nowMs: now.getTime(),
        source: "RECONCILIATION",
      });
      const rows = await db
        .update(livePositions)
        .set({
          riskPlanJson: JSON.stringify(activatedPlan),
          protectionVersion: nextProtectionVersion,
          protectionState: "ACTIVE",
          protectionUpdatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(livePositions.id, position.id),
            eq(livePositions.status, "OPEN"),
            eq(livePositions.positionVersion, position.positionVersion),
            eq(livePositions.protectionVersion, position.protectionVersion),
            or(
              isNull(livePositions.riskLeaseUntil),
              lte(livePositions.riskLeaseUntil, now),
            ),
          ),
        )
        .returning({ id: livePositions.id });
      if (rows.length) updated += 1;
    } catch {
      errors += 1;
    }
  }
  return {
    checked: targets.length,
    updated,
    unresolved,
    errors,
  };
}

async function recordOneThreeMinuteExitCounterfactual(now: Date) {
  const deferred = (reason: string, errors = 0) => ({
    checked: 0,
    written: 0,
    errors,
    deferred: true,
    reason,
  });
  let metrics;
  try {
    metrics = await getBinanceLiveSystemMetrics();
  } catch {
    return deferred("SYSTEM_METRICS_UNAVAILABLE", 1);
  }
  const remainingWeight = projectRemainingRestWeight(metrics.rest);
  if (!Number.isFinite(remainingWeight) || remainingWeight < 150)
    return deferred("REST_WEIGHT_RESERVED");
  const db = getDb();
  const rows = await db
    .select({
      positionId: livePositions.id,
      symbol: livePositions.symbol,
      positionSide: livePositions.positionSide,
      entryPrice: livePositions.entryPrice,
      leverage: livePositions.leverage,
      riskPlanJson: livePositions.riskPlanJson,
      openedAt: livePositions.openedAt,
      closedAt: livePositions.closedAt,
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
    })
    .from(livePositions)
    .innerJoin(
      strategyExecutionTraces,
      eq(strategyExecutionTraces.positionId, livePositions.id),
    )
    .where(and(
      eq(livePositions.status, "CLOSED"),
      isNotNull(livePositions.closedAt),
      like(
        livePositions.riskPlanJson,
        '%"version":"three-minute-position-plan-v1"%',
      ),
      gte(
        livePositions.openedAt,
        new Date(now.getTime() - 7 * 24 * 60 * 60_000),
      ),
      threeMinuteCounterfactualPositionCursor > 0
        ? gt(livePositions.id, threeMinuteCounterfactualPositionCursor)
        : undefined,
    ))
    .orderBy(asc(livePositions.id))
    .limit(200);
  if (!rows.length) {
    threeMinuteCounterfactualPositionCursor = 0;
    return deferred("NO_RECENT_THREE_MINUTE_EXIT");
  }
  const traceIds = [...new Set(rows.map((row) => row.traceId))];
  const recordedTraceIds = new Set<string>();
  for (const batch of sqlValueBatches(traceIds)) {
    const events = await db
      .select({ traceId: strategyExecutionEvents.traceId })
      .from(strategyExecutionEvents)
      .where(and(
        inArray(strategyExecutionEvents.traceId, batch),
        eq(
          strategyExecutionEvents.eventType,
          "THREE_MINUTE_COUNTERFACTUAL_180S",
        ),
      ));
    for (const event of events) recordedTraceIds.add(event.traceId);
  }
  const target = rows.find((row) => {
    if (!row.closedAt || recordedTraceIds.has(row.traceId)) return false;
    const plan = resolveThreeMinutePositionPlan(
      asRecord(parseJson(row.riskPlanJson)).threeMinuteRound,
    );
    if (!plan) return false;
    return threeMinuteEarlyExitCounterfactualDue({
      openedAtMs: row.openedAt.getTime(),
      closedAtMs: row.closedAt.getTime(),
      nowMs: now.getTime(),
      holdSeconds: plan.timeExitSeconds,
    });
  });
  threeMinuteCounterfactualPositionCursor =
    target?.positionId ?? rows.at(-1)?.positionId ?? 0;
  if (!target?.closedAt) return deferred("NO_DUE_THREE_MINUTE_COUNTERFACTUAL");
  const plan = resolveThreeMinutePositionPlan(
    asRecord(parseJson(target.riskPlanJson)).threeMinuteRound,
  );
  if (!plan) return deferred("THREE_MINUTE_POSITION_PLAN_INVALID", 1);
  const holdSeconds = plan.timeExitSeconds;
  const dueAtMs = target.openedAt.getTime() + holdSeconds * 1_000;
  const minuteMs = 60_000;
  let candles;
  try {
    candles = await getBinanceLiveMarkPriceKlinesRange(
      target.symbol,
      "1m",
      Math.floor(target.openedAt.getTime() / minuteMs) * minuteMs,
      dueAtMs + minuteMs,
      Math.max(5, Math.ceil(holdSeconds / 60) + 3),
    );
  } catch {
    return deferred("THREE_MINUTE_COUNTERFACTUAL_KLINES_UNAVAILABLE", 1);
  }
  const observed = candles.filter((candle) =>
    candle.closeTime > target.openedAt.getTime() &&
    candle.closeTime <= dueAtMs
  );
  const horizon = observed.at(-1);
  if (!horizon) return deferred("THREE_MINUTE_COUNTERFACTUAL_MARK_UNAVAILABLE");
  const theoreticalRoePercent = positionRoePercent(
    target.entryPrice,
    horizon.close,
    target.leverage,
    target.positionSide,
  );
  if (!Number.isFinite(theoreticalRoePercent))
    return deferred("THREE_MINUTE_COUNTERFACTUAL_ROE_INVALID", 1);
  const favorableRoe = observed.map((candle) =>
    positionRoePercent(
      target.entryPrice,
      target.positionSide === "LONG" ? candle.high : candle.low,
      target.leverage,
      target.positionSide,
    )
  ).filter(Number.isFinite);
  const adverseRoe = observed.map((candle) =>
    positionRoePercent(
      target.entryPrice,
      target.positionSide === "LONG" ? candle.low : candle.high,
      target.leverage,
      target.positionSide,
    )
  ).filter(Number.isFinite);
  const evidence = {
    source: "BINANCE_MARK_PRICE_KLINE",
    evidenceCompleteness: "THREE_MINUTE_COUNTERFACTUAL",
    sampleType: "THREE_MINUTE_COUNTERFACTUAL_180S",
    modelCheckpoint: true,
    longHoldObservation: false,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
    positionSide: target.positionSide,
    leverage: target.leverage,
    actualClosedAt: target.closedAt.toISOString(),
    theoreticalDueAt: new Date(dueAtMs).toISOString(),
    earlyExitSeconds: Math.max(
      0,
      Math.round((dueAtMs - target.closedAt.getTime()) / 1_000),
    ),
    theoreticalRoePercent,
    purpose:
      "COMPARE_EARLY_EXIT_WITH_FIXED_180_SECOND_COUNTERFACTUAL_WITHOUT_CHANGING_ACTUAL_PNL",
  };
  const [created] = await db
    .insert(strategyPositionEvidence)
    .values({
      traceId: target.traceId,
      strategyId: target.strategyId,
      minuteOffset: 3,
      scheduledAt: new Date(dueAtMs),
      sampledAt: new Date(horizon.closeTime),
      sampleDelayMs: Math.max(0, now.getTime() - dueAtMs),
      status: "MISSED",
      markPrice: horizon.close,
      entryPrice: target.entryPrice,
      remainingQty: 0,
      unrealizedPnl: null,
      netPnlEstimate: null,
      roePercent: theoreticalRoePercent,
      mfeRoePercent: favorableRoe.length ? Math.max(...favorableRoe) : null,
      maeRoePercent: adverseRoe.length ? Math.min(...adverseRoe) : null,
      evidenceJson: JSON.stringify(evidence),
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: strategyPositionEvidence.id });
  const eventWritten = await appendStrategyPositionManagementEvent({
    traceId: target.traceId,
    strategyId: target.strategyId,
    eventType: "THREE_MINUTE_COUNTERFACTUAL_180S",
    outcome: "INFO",
    message:
      `提前退出后的180秒理论复核：原方向ROE ${signedPercent(theoreticalRoePercent)}；` +
      "仅用于退出时机学习，不改变真实收益。",
    detail: evidence,
    eventAt: new Date(dueAtMs),
  });
  if (created || eventWritten) {
    try {
      const [trace] = await db
        .select()
        .from(strategyExecutionTraces)
        .where(eq(strategyExecutionTraces.traceId, target.traceId))
        .limit(1);
      if (trace) await refreshStrategyParameterSuggestions(trace, {
        durableBacklog: true,
      });
    } catch {
      // Counterfactual fact is durable; suggestion refresh can retry later.
    }
  }
  return {
    checked: 1,
    written: created || eventWritten ? 1 : 0,
    errors: 0,
    deferred: false,
    positionId: target.positionId,
    traceId: target.traceId,
    dueAt: new Date(dueAtMs).toISOString(),
  };
}

async function maybeCreatePostExitReentryTrace(input: {
  target: {
    positionId: number;
    symbol: string;
    positionSide: "LONG" | "SHORT";
    traceId: string;
    strategyId: number;
    ownerEmail: string;
    accountId: string;
  };
  evaluation: PostExitReentryEvaluation;
  now: Date;
}) {
  if (!input.evaluation.eligible)
    return { created: false, reason: input.evaluation.code };
  const db = getDb();
  const [strategy] = await db
    .select({
      id: strategies.id,
      ownerEmail: strategies.ownerEmail,
      accountId: strategies.accountId,
      strategyType: strategies.strategyType,
      status: strategies.status,
      configVersion: strategies.configVersion,
      configJson: strategies.configJson,
    })
    .from(strategies)
    .where(and(
      eq(strategies.id, input.target.strategyId),
      eq(strategies.ownerEmail, input.target.ownerEmail),
      eq(strategies.accountId, input.target.accountId),
    ))
    .limit(1);
  if (!strategy || strategy.status !== "RUNNING")
    return { created: false, reason: "STRATEGY_NOT_RUNNING" };
  const resolved = resolveLiquidationTrendConfig(parseJson(strategy.configJson));
  if (!resolved.config)
    return { created: false, reason: "CURRENT_CONFIG_INVALID" };
  const config = resolved.config;
  const brainDirection = (["LONG", "SHORT"] as const).find((direction) =>
    resolveStrategyExecutionDirection({
      mode: config.execution.directionMode,
      brainDirection: direction,
    }).tradeDirection === input.target.positionSide
  );
  if (!brainDirection)
    return { created: false, reason: "REENTRY_DIRECTION_UNRESOLVED" };
  const directionAllowed = config.direction === "BOTH" ||
    (config.direction === "LONG_ONLY" && brainDirection === "LONG") ||
    (config.direction === "SHORT_ONLY" && brainDirection === "SHORT");
  if (!directionAllowed)
    return { created: false, reason: "CURRENT_STRATEGY_DIRECTION_REJECTED" };

  const traceId = `reentry-${input.target.positionId}`;
  const [existingTrace] = await db
    .select({ id: strategyExecutionTraces.id })
    .from(strategyExecutionTraces)
    .where(eq(strategyExecutionTraces.traceId, traceId))
    .limit(1);
  if (existingTrace)
    return { created: false, reason: "SOURCE_EXIT_ALREADY_CONSUMED" };

  const [openExposure, workingOrder, latestTrace] = await Promise.all([
    db.select({ id: livePositions.id })
      .from(livePositions)
      .where(and(
        eq(livePositions.ownerEmail, input.target.ownerEmail),
        eq(livePositions.accountId, input.target.accountId),
        eq(livePositions.symbol, input.target.symbol),
        eq(livePositions.positionSide, input.target.positionSide),
        inArray(livePositions.status, ["OPEN", "EXECUTION_UNKNOWN"]),
      ))
      .limit(1)
      .then((rows) => rows[0]),
    db.select({ id: liveOrderEvents.id })
      .from(liveOrderEvents)
      .where(and(
        eq(liveOrderEvents.ownerEmail, input.target.ownerEmail),
        eq(liveOrderEvents.accountId, input.target.accountId),
        eq(liveOrderEvents.symbol, input.target.symbol),
        eq(liveOrderEvents.positionSide, input.target.positionSide),
        eq(liveOrderEvents.testOnly, false),
        inArray(liveOrderEvents.status, [
          "PENDING",
          "NEW",
          "PARTIALLY_FILLED",
          "CANCEL_PENDING",
          "EXECUTION_UNKNOWN",
        ]),
      ))
      .limit(1)
      .then((rows) => rows[0]),
    db.select({ createdAt: strategyExecutionTraces.createdAt })
      .from(strategyExecutionTraces)
      .where(and(
        eq(strategyExecutionTraces.strategyId, strategy.id),
        eq(strategyExecutionTraces.ownerEmail, input.target.ownerEmail),
        eq(strategyExecutionTraces.accountId, input.target.accountId),
        eq(strategyExecutionTraces.symbol, input.target.symbol),
        eq(strategyExecutionTraces.triggerDirection, brainDirection),
      ))
      .orderBy(desc(strategyExecutionTraces.createdAt))
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (openExposure)
    return { created: false, reason: "SAME_DIRECTION_POSITION_EXISTS" };
  if (workingOrder)
    return { created: false, reason: "SAME_DIRECTION_WORKING_ORDER_EXISTS" };
  if (
    latestTrace &&
    latestTrace.createdAt.getTime() >=
      input.now.getTime() - config.trigger.cooldownMinutes * 60_000
  ) return { created: false, reason: "STRATEGY_COOLDOWN" };

  const eventAtMs = input.evaluation.confirmationAtMs ?? input.now.getTime();
  const referencePrice = input.evaluation.confirmationPrice ?? 0;
  if (!(referencePrice > 0))
    return { created: false, reason: "REENTRY_REFERENCE_PRICE_INVALID" };
  const factSnapshotId =
    `${input.evaluation.candidateId}:${input.evaluation.horizonMinutes}m`;
  const nexusArchitecture = resolveNexusTradingArchitecture({
    config,
    strategyType: strategy.strategyType,
  });
  const entryTimingProfile = resolveStrategyEntryTimingProfile({
    config,
    strategyType: strategy.strategyType,
  });
  const executionDirection = resolveStrategyExecutionDirection({
    mode: config.execution.directionMode,
    brainDirection,
  });
  const entryEvidence = {
    symbol: input.target.symbol,
    decisionEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
    nexusArchitecture,
    entryTimingProfile,
    triggerIdentity: {
      version: POST_EXIT_REENTRY_VERSION,
      wakeId: traceId,
      triggerKind: "BREAKOUT_RETEST",
      triggerVersion: POST_EXIT_REENTRY_VERSION,
      direction: brainDirection,
      factSnapshotId,
      sourceId: input.evaluation.candidateId,
      referencePrice,
      eventAt: eventAtMs,
      receivedAt: input.now.getTime(),
      expiresAt:
        input.now.getTime() + config.trigger.analysisValiditySeconds * 1_000,
      canAuthorizeOrder: false,
    },
    strategyTriggerEvidence: input.evaluation,
    postExitReentryCandidate: input.evaluation,
    sourceExitLifecycle: {
      traceId: input.target.traceId,
      positionId: input.target.positionId,
      terminal: true,
      inheritedRiskPlan: false,
      inheritedExecutionIntent: false,
    },
    marketClusterId: factSnapshotId,
    marketClusterType: "POST_EXIT_REENTRY",
    brainDecisionDirection: brainDirection,
    tradeDirection: brainDirection,
    executionDirection: executionDirection.tradeDirection,
    signalMarkPrice: referencePrice,
    signalMarkTime: eventAtMs,
    signalMarkSource: "POST_EXIT_CLOSED_KLINE_CONFIRMATION",
    minimumQuantityOnly: true,
    orderAffecting: false,
    liveConfigMutationAllowed: false,
  };
  const [created] = await db
    .insert(strategyExecutionTraces)
    .values({
      traceId,
      strategyId: strategy.id,
      strategyRunId: `reentry-${input.now.toISOString().slice(0, 10)}`,
      configVersion: strategy.configVersion,
      ownerEmail: input.target.ownerEmail,
      accountId: input.target.accountId,
      symbol: input.target.symbol,
      triggerKind: "BREAKOUT_RETEST",
      triggerVersion: POST_EXIT_REENTRY_VERSION,
      triggerDirection: brainDirection,
      triggerReferencePrice: referencePrice,
      triggerFactSnapshotId: factSnapshotId,
      triggerSourceId: input.evaluation.candidateId,
      liquidationSide: brainDirection === "LONG" ? "SELL" : "BUY",
      liquidationPrice: referencePrice,
      liquidationNotional: 0,
      eventTime: new Date(eventAtMs),
      receivedAt: input.now,
      expiresAt: new Date(
        input.now.getTime() + config.trigger.analysisValiditySeconds * 1_000,
      ),
      state: "ANALYZING",
      resultCode: null,
      resultMessage: null,
      configSnapshotJson: strategy.configJson,
      entryEvidenceJson: JSON.stringify(entryEvidence),
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
    })
    .onConflictDoNothing()
    .returning({ id: strategyExecutionTraces.id });
  if (!created)
    return { created: false, reason: "SOURCE_EXIT_ALREADY_CONSUMED" };
  await appendStrategyPositionManagementEvent({
    traceId,
    strategyId: strategy.id,
    eventType: "POST_EXIT_REENTRY_WAKE_RECEIVED",
    outcome: "PASSED",
    message:
      `${input.target.symbol} 退出后触底再入场候选已建立；旧仓保持终局，` +
      "当前候选进入统一眼睛和大脑复核，不直接下单。",
    detail: entryEvidence,
    eventAt: input.now,
  });
  await appendStrategyPositionManagementEvent({
    traceId: input.target.traceId,
    strategyId: strategy.id,
    eventType: "POST_EXIT_REENTRY_CANDIDATE_CREATED",
    outcome: "INFO",
    message:
      `退出后 ${input.evaluation.horizonMinutes} 分钟形成独立再入场候选；` +
      "新订单如获批将使用新生命周期和最小下单量。",
    detail: {
      ...input.evaluation,
      reentryTraceId: traceId,
      sourceLifecycleRemainsTerminal: true,
    },
    eventAt: input.now,
  });
  return { created: true, reason: "POST_EXIT_REENTRY_TRACE_CREATED", traceId };
}

async function recordExitCounterfactualBatch(now: Date) {
  const deferred = (reason: string, errors = 0) => ({
    checked: 0,
    written: 0,
    reentryCreated: 0,
    errors,
    deferred: true,
    reason,
  });
  let metrics;
  try {
    metrics = await getBinanceLiveSystemMetrics();
  } catch {
    return deferred("SYSTEM_METRICS_UNAVAILABLE", 1);
  }
  const remainingWeight = projectRemainingRestWeight(metrics.rest);
  const targetLimit = exitCounterfactualObservationBatchSize({
    remainingWeight,
    reserveWeight: 150,
    weightPerTarget: 2,
    maximumTargets: 8,
  });
  if (targetLimit < 1)
    return deferred("REST_WEIGHT_RESERVED");
  const db = getDb();
  const rows = await db
    .select({
      reductionId: livePositionReductions.id,
      reductionReason: livePositionReductions.reason,
      reductionQuantity: livePositionReductions.quantity,
      reductionExitPrice: livePositionReductions.exitPrice,
      reductionRealizedPnl: livePositionReductions.realizedPnl,
      reductionResponseJson: livePositionReductions.responseJson,
      reductionCreatedAt: livePositionReductions.createdAt,
      positionId: livePositions.id,
      symbol: livePositions.symbol,
      positionSide: livePositions.positionSide,
      entryPrice: livePositions.entryPrice,
      leverage: livePositions.leverage,
      riskPlanJson: livePositions.riskPlanJson,
      exitReason: livePositions.exitReason,
      closedAt: livePositions.closedAt,
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
      configVersion: strategyExecutionTraces.configVersion,
      configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
      ownerEmail: livePositions.ownerEmail,
      accountId: livePositions.accountId,
    })
    .from(livePositionReductions)
    .innerJoin(
      livePositions,
      eq(livePositions.id, livePositionReductions.positionId),
    )
    .innerJoin(
      strategyExecutionTraces,
      eq(strategyExecutionTraces.positionId, livePositions.id),
    )
    .where(
      and(
        ne(strategyExecutionTraces.triggerKind, "THREE_MINUTE_PROBABILITY"),
        or(
          eq(livePositionReductions.reason, "STOP_LOSS"),
          eq(livePositionReductions.reason, "TAKE_PROFIT"),
          eq(livePositionReductions.reason, "TRAILING_STOP"),
          eq(livePositionReductions.reason, "TIME_EXIT"),
        ),
        gte(
          livePositionReductions.createdAt,
          new Date(now.getTime() - 7 * 24 * 60 * 60_000),
        ),
        exitCounterfactualReductionCursor > 0
          ? gt(livePositionReductions.id, exitCounterfactualReductionCursor)
          : undefined,
      ),
    )
    .orderBy(asc(livePositionReductions.id))
    .limit(240);
  if (!rows.length) {
    exitCounterfactualReductionCursor = 0;
    return deferred("NO_RECENT_EXIT_REDUCTION");
  }
  const traceIds = [...new Set(rows.map((row) => row.traceId))];
  const existingEvents: Array<{
    traceId: string;
    eventType: string;
    detailJson: string;
  }> = [];
  for (const batch of sqlValueBatches(traceIds))
    existingEvents.push(...await db
      .select({
        traceId: strategyExecutionEvents.traceId,
        eventType: strategyExecutionEvents.eventType,
        detailJson: strategyExecutionEvents.detailJson,
      })
      .from(strategyExecutionEvents)
      .where(and(
        inArray(strategyExecutionEvents.traceId, batch),
        like(
          strategyExecutionEvents.eventType,
          "POSITION_EXIT_COUNTERFACTUAL_%",
        ),
      )));
  const recordedByReduction = new Map<string, Set<number>>();
  const recordedByLegacyPosition = new Map<string, Set<number>>();
  for (const event of existingEvents) {
    const detail = asRecord(parseJson(event.detailJson));
    const horizon = Number(detail.horizonMinutes);
    if (!Number.isInteger(horizon)) continue;
    const reductionId = Number(detail.reductionId);
    const positionId = Number(detail.positionId);
    const key = Number.isInteger(reductionId) && reductionId > 0
      ? `${event.traceId}:reduction:${reductionId}`
      : Number.isInteger(positionId) && positionId > 0
        ? `${event.traceId}:position:${positionId}`
        : null;
    if (!key) continue;
    const collection = Number.isInteger(reductionId) && reductionId > 0
      ? recordedByReduction
      : recordedByLegacyPosition;
    const recorded = collection.get(key) ?? new Set<number>();
    recorded.add(horizon);
    collection.set(key, recorded);
  }
  const recordedHorizonsFor = (row: (typeof rows)[number]) => {
    const recorded = new Set(
      recordedByReduction.get(
        `${row.traceId}:reduction:${row.reductionId}`,
      ) ?? [],
    );
    const reductionMatchesLegacyFinalExit =
      row.closedAt !== null &&
      row.exitReason === row.reductionReason &&
      Math.abs(
        row.closedAt.getTime() - row.reductionCreatedAt.getTime(),
      ) <= 2 * 60_000;
    if (reductionMatchesLegacyFinalExit) {
      for (const horizon of recordedByLegacyPosition.get(
        `${row.traceId}:position:${row.positionId}`,
      ) ?? []) recorded.add(horizon);
    }
    return recorded;
  };
  const targets = rows.filter((row) =>
    dueExitCounterfactualHorizons({
      closedAtMs: row.reductionCreatedAt.getTime(),
      nowMs: now.getTime(),
      recordedHorizons: recordedHorizonsFor(row),
    }).length > 0
  ).slice(0, targetLimit);
  if (!targets.length) {
    exitCounterfactualReductionCursor = rows.at(-1)?.reductionId ?? 0;
    return deferred("NO_DUE_EXIT_COUNTERFACTUAL");
  }
  exitCounterfactualReductionCursor = targets.at(-1)?.reductionId ?? 0;
  let written = 0;
  let reentryCreated = 0;
  let errors = 0;
  const refreshedTraceIds = new Set<string>();
  const targetResults: Array<{
    reductionId: number;
    traceId: string;
    dueHorizons: number[];
  }> = [];
  for (const target of targets) {
    const exitReason = normalizeExitCounterfactualReason(
      target.reductionReason,
    );
    const exitAtMs = target.reductionCreatedAt.getTime();
    const exitPrice = Number(target.reductionExitPrice);
    const dueHorizons = dueExitCounterfactualHorizons({
      closedAtMs: exitAtMs,
      nowMs: now.getTime(),
      recordedHorizons: recordedHorizonsFor(target),
    });
    targetResults.push({
      reductionId: target.reductionId,
      traceId: target.traceId,
      dueHorizons,
    });
    if (!exitReason || !Number.isFinite(exitPrice) || exitPrice <= 0) {
      errors += 1;
      continue;
    }
    const maximumHorizon = Math.max(...dueHorizons);
    const minuteMs = 60_000;
    const klineStart = Math.max(
      0,
      Math.floor(exitAtMs / minuteMs) * minuteMs - 21 * minuteMs,
    );
    let candles;
    let tradeCandles;
    try {
      [candles, tradeCandles] = await Promise.all([
        getBinanceLiveMarkPriceKlinesRange(
          target.symbol,
          "1m",
          klineStart,
          exitAtMs + (maximumHorizon + 1) * minuteMs,
          maximumHorizon + 25,
        ),
        getBinanceLiveKlinesRange(
          target.symbol,
          "1m",
          klineStart,
          exitAtMs + (maximumHorizon + 1) * minuteMs,
          maximumHorizon + 25,
        ),
      ]);
    } catch {
      errors += 1;
      continue;
    }
    const exitRoePercent = positionRoePercent(
      target.entryPrice,
      exitPrice,
      target.leverage,
      target.positionSide,
    );
    let boundConfig: LiquidationTrendConfig | null = null;
    try {
      boundConfig = await loadBoundLiquidationTrendConfig(target);
    } catch {
      boundConfig = null;
    }
    let capitalStopRoePercent = capitalPreservationStopRoePercent(
      asRecord(parseJson(target.riskPlanJson)),
    );
    if (capitalStopRoePercent === null && boundConfig) {
      const configured = Number(boundConfig.risk.stopLossPercent);
      capitalStopRoePercent = Number.isFinite(configured) && configured > 0
        ? configured
        : null;
    }
    const response = asRecord(parseJson(target.reductionResponseJson));
    const accounting = reductionAccountingPnl({
      realizedPnl: target.reductionRealizedPnl,
      responseJson: target.reductionResponseJson,
    });
    const reductionNotional = Math.abs(
      target.reductionQuantity * exitPrice,
    );
    const roundTripCostPercent =
      accounting.commissionAsset === "USDT" &&
        reductionNotional > 0 &&
        accounting.exitCommission !== null &&
        accounting.entryCommissionAllocated !== null
        ? (accounting.exitCommission + accounting.entryCommissionAllocated) /
          reductionNotional * 100
        : null;
    const executionAudit = asRecord(response._nexusExecutionAudit);
    const executablePrice = Number(executionAudit.preSubmitExecutablePrice);
    const executionSlippagePercent =
      Number.isFinite(executablePrice) && executablePrice > 0
        ? Math.max(
            0,
            (target.positionSide === "LONG"
              ? executablePrice - exitPrice
              : exitPrice - executablePrice) / executablePrice * 100,
          )
        : null;
    const preExitAtrPercent = preExitAverageTrueRangePercent({
      exitPrice,
      exitAtMs,
      candles,
      periods: 14,
    });
    const materialMove = resolveExitCounterfactualMaterialMove({
      roundTripCostPercent,
      executionSlippagePercent,
      preExitAtrPercent,
    });
    const tailWaveExit = asRecord(response.tailWaveExit);
    const tailWaveReasonCode = String(
      tailWaveExit.reasonCode ?? tailWaveExit.code ?? tailWaveExit.action ?? "",
    ).trim() || null;
    for (const horizonMinutes of dueHorizons) {
      const horizonAtMs = exitAtMs + horizonMinutes * minuteMs;
      const path = buildExitCounterfactualPath({
        positionSide: target.positionSide,
        exitPrice,
        exitAtMs,
        horizonAtMs,
        evaluatedAtMs: now.getTime(),
        materialMovePercent: materialMove.percent,
        markPriceCandles: candles,
        tradeCandles,
      });
      if (!path.causallyClosed) continue;
      const classification = classifyExitCounterfactualDetailed({
        exitReason,
        directionReturnPercent: path.directionReturnPercent,
        exitRoePercent,
        capitalPreservationStopRoePercent: capitalStopRoePercent,
        materialMovePercent: materialMove.percent,
      });
      const observed = candles.filter(
        (candle) =>
          candle.closeTime > exitAtMs &&
          candle.closeTime <= horizonAtMs,
      );
      const observedTrades = tradeCandles.filter(
        (candle) =>
          candle.closeTime > exitAtMs &&
          candle.closeTime <= horizonAtMs,
      );
      const reentryEvaluation =
        (exitReason === "STOP_LOSS" || exitReason === "TRAILING_STOP") &&
          classification.pathOutcome === "EXIT_EARLY"
          ? evaluatePostExitReentry({
              sourcePositionId: target.positionId,
              sourceTraceId: target.traceId,
              positionSide: target.positionSide,
              exitReason,
              classification: classification.classification,
              exitPrice,
              leverage: target.leverage,
              closedAtMs: exitAtMs,
              evaluatedAtMs: horizonAtMs,
              horizonMinutes,
              markPriceCandles: observed,
              tradeCandles: observedTrades,
              minimumRecoveryRoePoints:
                boundConfig?.risk.positionManagement
                  ?.bottomRecoveryRoePoints,
              minimumVolumeRatio: 1,
            })
          : null;
      const reentryHandoff = reentryEvaluation
        ? await maybeCreatePostExitReentryTrace({
            target,
            evaluation: reentryEvaluation,
            now,
          })
        : null;
      if (reentryHandoff?.created) reentryCreated += 1;
      const detail = {
        version: EXIT_COUNTERFACTUAL_VERSION,
        reductionId: target.reductionId,
        positionId: target.positionId,
        exitReason,
        exitAtMs,
        labelAvailableAtMs: horizonAtMs,
        horizonMinutes,
        positionSide: target.positionSide,
        exitPrice,
        exitRoePercent,
        capitalPreservationStopRoePercent: capitalStopRoePercent,
        classification: classification.classification,
        pathOutcome: classification.pathOutcome,
        executionTiming: classification.executionTiming,
        ...path,
        materialMove,
        roundTripCostPercent,
        executionSlippagePercent,
        preExitAtrPercent,
        settlementStatus: accounting.settlementStatus,
        protectionTrigger: String(response.protectionTrigger ?? "").trim() ||
          null,
        tailWaveReasonCode,
        postExitReentryEvaluation: reentryEvaluation,
        postExitReentryHandoff: reentryHandoff,
        historicalLabelOnly: true,
        orderAffecting: false,
        liveConfigMutationAllowed: false,
      };
      if (await appendStrategyPositionManagementEvent({
        traceId: target.traceId,
        strategyId: target.strategyId,
        eventType: `POSITION_EXIT_COUNTERFACTUAL_${horizonMinutes}M`,
        outcome:
          classification.pathOutcome === "EXIT_CONFIRMED"
            ? "PASSED"
            : "INFO",
        message:
          `${exitReason} 后 ${horizonMinutes} 分钟复核：` +
          `${classification.pathOutcome}，原持仓方向价格变化 ` +
          `${signedPercent(path.directionReturnPercent)}；仅作历史标签。`,
        detail,
        eventAt: new Date(horizonAtMs),
      })) {
        written += 1;
        refreshedTraceIds.add(target.traceId);
      }
    }
  }
  for (const traceId of refreshedTraceIds) {
    const target = targets.find((item) => item.traceId === traceId);
    if (!target) continue;
    try {
      await refreshStrategyParameterSuggestions(target, {
        durableBacklog: true,
      });
    } catch {
      errors += 1;
    }
  }
  return {
    checked: targets.length,
    written,
    reentryCreated,
    errors,
    deferred: false,
    targetLimit,
    targets: targetResults,
  };
}

function normalizeExitCounterfactualReason(
  value: unknown,
): ExitCounterfactualExitReason | null {
  return value === "STOP_LOSS" ||
      value === "TAKE_PROFIT" ||
      value === "TRAILING_STOP" ||
      value === "TIME_EXIT"
    ? value
    : null;
}

function positiveIntegerOrNull(value: unknown) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function signedPercent(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? "--"
    : `${value >= 0 ? "+" : ""}${value.toFixed(4)}%`;
}

async function compactOneTerminalMarketFactBatch(now: Date) {
  const deferred = (reason: string) => ({
    scanned: 0,
    compacted: 0,
    bytesRemoved: 0,
    factsArchived: 0,
    summariesCreated: 0,
    eventRollupsCreated: 0,
    rawEventsDeleted: 0,
    cleanupEnabled: false,
    retentionMode: "PREVIEW",
    previewEligibleSummaries: 0,
    previewEligibleEvents: 0,
    deferred: true,
    reason,
  });
  if (now.getTime() < nextTerminalFactCompactionSweepAt)
    return deferred("SWEEP_INTERVAL");
  const db = getDb();
  const rows = await db
    .select({
      id: strategyExecutionTraces.id,
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
      configVersion: strategyExecutionTraces.configVersion,
      ownerEmail: strategyExecutionTraces.ownerEmail,
      accountId: strategyExecutionTraces.accountId,
      symbol: strategyExecutionTraces.symbol,
      triggerKind: strategyExecutionTraces.triggerKind,
      triggerVersion: strategyExecutionTraces.triggerVersion,
      triggerFactSnapshotId:
        strategyExecutionTraces.triggerFactSnapshotId,
      state: strategyExecutionTraces.state,
      resultCode: strategyExecutionTraces.resultCode,
      resultMessage: strategyExecutionTraces.resultMessage,
      eventTime: strategyExecutionTraces.eventTime,
      completedAt: strategyExecutionTraces.completedAt,
      exchangeOrderId: strategyExecutionTraces.exchangeOrderId,
      positionId: strategyExecutionTraces.positionId,
      configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(and(
      terminalFactCompactionCursor > 0
        ? gt(strategyExecutionTraces.id, terminalFactCompactionCursor)
        : undefined,
      or(
        eq(strategyExecutionTraces.state, "EXPIRED"),
        eq(strategyExecutionTraces.state, "CANCELED"),
        eq(strategyExecutionTraces.state, "REJECTED"),
        eq(strategyExecutionTraces.state, "CLOSED"),
      ),
      isNotNull(strategyExecutionTraces.completedAt),
      lte(
        strategyExecutionTraces.completedAt,
        new Date(now.getTime() - TERMINAL_FACT_COMPACTION_MIN_AGE_MS),
      ),
    ))
    .orderBy(asc(strategyExecutionTraces.id))
    .limit(TERMINAL_FACT_COMPACTION_BATCH_SIZE);
  if (!rows.length) {
    terminalFactCompactionCursor = 0;
    nextTerminalFactCompactionSweepAt =
      now.getTime() + TERMINAL_FACT_COMPACTION_SWEEP_INTERVAL_MS;
    return deferred("SWEEP_COMPLETE");
  }
  terminalFactCompactionCursor = rows.at(-1)?.id ??
    terminalFactCompactionCursor;
  let compacted = 0;
  let bytesRemoved = 0;
  let factsArchived = 0;
  let summariesCreated = 0;
  let eventRollupsCreated = 0;
  for (const row of rows) {
    const [existingSummary] = await db
      .select({ id: strategyExecutionSummaries.id })
      .from(strategyExecutionSummaries)
      .where(eq(strategyExecutionSummaries.traceId, row.traceId))
      .limit(1);
    if (existingSummary) continue;
    const current = asRecord(parseJson(row.entryEvidenceJson));
    const eyeFacts = extractNexusEyeFactSnapshots(current);
    for (let offset = 0; offset < eyeFacts.facts.length; offset += 8) {
      const facts = eyeFacts.facts.slice(offset, offset + 8);
      if (!facts.length) continue;
      await db.insert(nexusEyeFactSnapshots).values(facts.map((fact) => ({
        factId: fact.factId,
        symbol: fact.symbol,
        kind: fact.kind,
        interval: fact.interval,
        source: fact.source,
        eventAt: new Date(fact.eventAtMs),
        receivedAt: new Date(fact.receivedAtMs),
        expiresAt: new Date(fact.expiresAtMs),
        factJson: fact.factJson,
        createdAt: now,
        updatedAt: now,
      }))).onConflictDoNothing();
    }
    factsArchived += eyeFacts.facts.length;
    const events = await db
      .select()
      .from(strategyExecutionEvents)
      .where(and(
        eq(strategyExecutionEvents.traceId, row.traceId),
        eq(strategyExecutionEvents.strategyId, row.strategyId),
      ))
      .orderBy(asc(strategyExecutionEvents.sequence));
    const eventGroups = new Map<string, {
      eventType: string;
      stage: typeof events[number]["stage"];
      outcome: typeof events[number]["outcome"];
      count: number;
      firstEventAt: Date;
      lastEventAt: Date;
    }>();
    for (const event of events) {
      const key = `${event.eventType}\u0000${event.outcome}`;
      const group = eventGroups.get(key);
      if (group) {
        group.count += 1;
        if (event.eventAt < group.firstEventAt)
          group.firstEventAt = event.eventAt;
        if (event.eventAt > group.lastEventAt) {
          group.lastEventAt = event.eventAt;
          group.stage = event.stage;
        }
      } else {
        eventGroups.set(key, {
          eventType: event.eventType,
          stage: event.stage,
          outcome: event.outcome,
          count: 1,
          firstEventAt: event.eventAt,
          lastEventAt: event.eventAt,
        });
      }
    }
    const groupedEvents = [...eventGroups.values()];
    for (let offset = 0; offset < groupedEvents.length; offset += 5) {
      const groups = groupedEvents.slice(offset, offset + 5);
      await db.insert(strategyExecutionEventRollups).values(groups.map((group) => ({
        traceId: row.traceId,
        strategyId: row.strategyId,
        configVersion: row.configVersion,
        ownerEmail: row.ownerEmail,
        accountId: row.accountId,
        eventType: group.eventType,
        stage: group.stage,
        outcome: group.outcome,
        occurrenceCount: group.count,
        firstEventAt: group.firstEventAt,
        lastEventAt: group.lastEventAt,
        createdAt: now,
        updatedAt: now,
      }))).onConflictDoUpdate({
        target: [
          strategyExecutionEventRollups.traceId,
          strategyExecutionEventRollups.eventType,
          strategyExecutionEventRollups.outcome,
        ],
        set: {
          stage: sql`excluded.stage`,
          occurrenceCount: sql`excluded.occurrence_count`,
          firstEventAt: sql`excluded.first_event_at`,
          lastEventAt: sql`excluded.last_event_at`,
          updatedAt: now,
        },
      });
      eventRollupsCreated += groups.length;
    }
    const orderPrefix = `${row.id}`;
    const [linkedOrder] = await db
      .select({ id: liveOrderEvents.id })
      .from(liveOrderEvents)
      .where(and(
        eq(liveOrderEvents.ownerEmail, row.ownerEmail),
        or(
          like(liveOrderEvents.clientOrderId, `nql_${orderPrefix}_%`),
          like(liveOrderEvents.clientOrderId, `nqs_${orderPrefix}_%`),
          like(liveOrderEvents.clientOrderId, `nqi_${orderPrefix}_%`),
          like(liveOrderEvents.clientOrderId, `nqp_${orderPrefix}_%`),
        ),
      ))
      .limit(1);
    const [learningCycle] = await db
      .select({
        learningKey: strategyLearningCycles.learningKey,
        terminalStatus: strategyLearningCycles.terminalStatus,
        eligibility: strategyLearningCycles.eligibility,
        exactNetAvailable: strategyLearningCycles.exactNetAvailable,
        exactNetPnlUsdt: strategyLearningCycles.exactNetPnlUsdt,
        blockedReasonsJson: strategyLearningCycles.blockedReasonsJson,
        detailJson: strategyLearningCycles.detailJson,
      })
      .from(strategyLearningCycles)
      .where(eq(strategyLearningCycles.traceId, row.traceId))
      .orderBy(desc(strategyLearningCycles.updatedAt))
      .limit(1);
    const learningStatus = strategyEventLearningStatus({
      terminalState: row.state,
      learningCycle,
    });
    const hadOrder = Boolean(row.exchangeOrderId || linkedOrder);
    const hadPosition = Boolean(row.positionId);
    const archivedPositionId = Number(row.positionId);
    const [archivedPosition, archivedReductions, archivedObservations] =
      Number.isInteger(archivedPositionId) && archivedPositionId > 0
        ? await Promise.all([
            db
              .select()
              .from(livePositions)
              .where(eq(livePositions.id, archivedPositionId))
              .limit(1)
              .then((items) => items[0] ?? null),
            db
              .select()
              .from(livePositionReductions)
              .where(eq(livePositionReductions.positionId, archivedPositionId))
              .orderBy(asc(livePositionReductions.createdAt)),
            db
              .select({
                mfeRoePercent: strategyPositionEvidence.mfeRoePercent,
                maeRoePercent: strategyPositionEvidence.maeRoePercent,
              })
              .from(strategyPositionEvidence)
              .where(eq(strategyPositionEvidence.traceId, row.traceId)),
          ])
        : [null, [], []] as const;
    const result = compactTerminalNexusMarketFactsEvidence(current);
    const nextJson = result.changed
      ? JSON.stringify(result.evidence)
      : row.entryEvidenceJson;
    const keyEvents = keyStrategyRetentionEvents(events.map((event) => ({
      eventType: event.eventType,
      stage: event.stage,
      outcome: event.outcome,
      message: event.message,
      detailJson: event.detailJson,
      eventAtMs: event.eventAt.getTime(),
    })));
    const sourceMaterial = strategyTerminalArchiveSourceMaterial({
      traceId: row.traceId,
      traceDatabaseId: row.id,
      strategyId: row.strategyId,
      configVersion: row.configVersion,
      ownerEmail: row.ownerEmail,
      accountId: row.accountId,
      symbol: row.symbol,
      triggerKind: row.triggerKind,
      triggerVersion: row.triggerVersion,
      triggerFactSnapshotId: row.triggerFactSnapshotId,
      terminalState: row.state,
      resultCode: row.resultCode,
      completedAtMs: row.completedAt!.getTime(),
      hadOrder,
      hadPosition,
      learningStatus,
      entryEvidenceJson: row.entryEvidenceJson,
      events: events.map((event) => ({
        sequence: event.sequence,
        eventType: event.eventType,
        outcome: event.outcome,
        eventAtMs: event.eventAt.getTime(),
        detailJson: event.detailJson,
      })),
    });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sourceMaterial),
    );
    const sourceChecksum = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const archive = buildStrategyTerminalArchive({
      identity: {
        traceId: row.traceId,
        traceDatabaseId: row.id,
        strategyId: row.strategyId,
        configVersion: row.configVersion,
        ownerEmail: row.ownerEmail,
        accountId: row.accountId,
        symbol: row.symbol,
        triggerKind: row.triggerKind,
        triggerVersion: row.triggerVersion,
        triggerFactSnapshotId: row.triggerFactSnapshotId,
      },
      configSnapshotJson: row.configSnapshotJson,
      entryEvidence: current,
      terminal: {
        state: row.state,
        resultCode: row.resultCode,
        resultMessage: row.resultMessage,
        eventTimeMs: row.eventTime.getTime(),
        completedAtMs: row.completedAt!.getTime(),
        hadOrder,
        hadPosition,
      },
      position: archivedPosition
        ? {
            id: archivedPosition.id,
            positionSide: archivedPosition.positionSide,
            quantity: archivedPosition.quantity,
            entryPrice: archivedPosition.entryPrice,
            exitPrice: archivedPosition.markPrice,
            leverage: archivedPosition.leverage,
            openedAtMs: archivedPosition.openedAt.getTime(),
            closedAtMs: archivedPosition.closedAt?.getTime() ?? null,
            exitReason: archivedPosition.exitReason,
            realizedPnl: archivedPosition.realizedPnl,
          }
        : null,
      reductions: archivedReductions.map((reduction) => ({
        quantity: reduction.quantity,
        exitPrice: reduction.exitPrice,
        reason: reduction.reason,
        realizedPnl: reduction.realizedPnl,
        createdAtMs: reduction.createdAt.getTime(),
        settlement: reductionAccountingPnl(reduction),
      })),
      mfeRoePercent: archivedObservations.reduce<number | null>(
        (maximum, observation) =>
          observation.mfeRoePercent === null
            ? maximum
            : maximum === null
              ? observation.mfeRoePercent
              : Math.max(maximum, observation.mfeRoePercent),
        null,
      ),
      maeRoePercent: archivedObservations.reduce<number | null>(
        (minimum, observation) =>
          observation.maeRoePercent === null
            ? minimum
            : minimum === null
              ? observation.maeRoePercent
              : Math.min(minimum, observation.maeRoePercent),
        null,
      ),
      learning: learningCycle
        ? {
            learningKey: learningCycle.learningKey,
            terminalStatus: learningCycle.terminalStatus,
            eligibility: learningCycle.eligibility,
            exactNetAvailable: learningCycle.exactNetAvailable,
            exactNetPnlUsdt: learningCycle.exactNetPnlUsdt,
            blockedReasons: parseJson(learningCycle.blockedReasonsJson),
            detail: parseJson(learningCycle.detailJson),
          }
        : null,
      keyEvents,
      sourceChecksum,
    });
    const [updated] = await db
      .update(strategyExecutionTraces)
      .set({ entryEvidenceJson: nextJson, updatedAt: now })
      .where(and(
        eq(strategyExecutionTraces.id, row.id),
        or(
          eq(strategyExecutionTraces.state, "EXPIRED"),
          eq(strategyExecutionTraces.state, "CANCELED"),
          eq(strategyExecutionTraces.state, "REJECTED"),
          eq(strategyExecutionTraces.state, "CLOSED"),
        ),
      ))
      .returning({ id: strategyExecutionTraces.id });
    if (!updated) continue;
    await db.insert(strategyExecutionSummaries).values({
      traceId: row.traceId,
      traceDatabaseId: row.id,
      strategyId: row.strategyId,
      configVersion: row.configVersion,
      ownerEmail: row.ownerEmail,
      accountId: row.accountId,
      symbol: row.symbol,
      triggerKind: row.triggerKind,
      triggerVersion: row.triggerVersion,
      triggerFactSnapshotId: row.triggerFactSnapshotId,
      terminalState: row.state,
      resultCode: row.resultCode,
      resultMessage: row.resultMessage,
      eventTime: row.eventTime,
      completedAt: row.completedAt!,
      hadOrder,
      hadPosition,
      learningStatus,
      eyeDecisionJson: JSON.stringify(compactNexusEyeDecision(current)),
      marketFactIdsJson: JSON.stringify(eyeFacts.factIds),
      keyEventsJson: JSON.stringify(keyEvents),
      archiveJson: JSON.stringify(archive),
      rawEventCount: events.length,
      rawEventBytes: events.reduce(
        (sum, event) => sum + event.message.length + event.detailJson.length,
        0,
      ),
      rawEvidenceBytes: row.entryEvidenceJson.length,
      compactEvidenceBytes: nextJson.length,
      sourceChecksum,
      archiveVersion: STRATEGY_EVENT_ARCHIVE_VERSION,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    summariesCreated += 1;
    if (result.changed) compacted += 1;
    bytesRemoved += Math.max(0, row.entryEvidenceJson.length - nextJson.length);
  }
  const retentionEnv = env as unknown as {
    NEXUS_EVENT_RETENTION_MODE?: string;
    NEXUS_EVENT_RETENTION_CLEANUP_ENABLED?: string;
    NEXUS_EVENT_RETENTION_DELETE_CONFIRMATION?: string;
  };
  const retentionMode = resolveStrategyEventRetentionMode({
    mode: retentionEnv.NEXUS_EVENT_RETENTION_MODE,
    cleanupEnabled: retentionEnv.NEXUS_EVENT_RETENTION_CLEANUP_ENABLED,
    deleteConfirmation:
      retentionEnv.NEXUS_EVENT_RETENTION_DELETE_CONFIRMATION,
  });
  let rawEventsDeleted = 0;
  let previewEligibleSummaries = 0;
  let previewEligibleEvents = 0;
  const cleanupRows = await db
    .select()
    .from(strategyExecutionSummaries)
    .where(and(
      isNull(strategyExecutionSummaries.rawEventsDeletedAt),
      lte(
        strategyExecutionSummaries.completedAt,
        new Date(now.getTime() - STRATEGY_EVENT_DETAIL_RETENTION_MS),
      ),
    ))
    .orderBy(asc(strategyExecutionSummaries.id))
    .limit(5);
  for (const summary of cleanupRows) {
    const [learningCycle] = await db
      .select({
        terminalStatus: strategyLearningCycles.terminalStatus,
        eligibility: strategyLearningCycles.eligibility,
      })
      .from(strategyLearningCycles)
      .where(eq(strategyLearningCycles.traceId, summary.traceId))
      .orderBy(desc(strategyLearningCycles.updatedAt))
      .limit(1);
    const learningStatus = strategyEventLearningStatus({
      terminalState: summary.terminalState,
      learningCycle,
    });
    if (learningStatus !== summary.learningStatus)
      await db.update(strategyExecutionSummaries).set({
        learningStatus,
        updatedAt: now,
      }).where(eq(strategyExecutionSummaries.id, summary.id));
    const eligibility = strategyEventRetentionEligibility({
      terminalState: summary.terminalState,
      resultCode: summary.resultCode,
      completedAtMs: summary.completedAt.getTime(),
      nowMs: now.getTime(),
      hadOrder: summary.hadOrder,
      hadPosition: summary.hadPosition,
      learningStatus,
    });
    if (!eligibility.eligible) continue;
    const eventIds = await db
      .select({ id: strategyExecutionEvents.id })
      .from(strategyExecutionEvents)
      .where(eq(strategyExecutionEvents.traceId, summary.traceId))
      .orderBy(asc(strategyExecutionEvents.id))
      .limit(TERMINAL_EVENT_DELETE_BATCH_SIZE);
    previewEligibleSummaries += 1;
    previewEligibleEvents += eventIds.length;
    const deletionDecision = strategyEventDeletionDecision({
      terminalState: summary.terminalState,
      resultCode: summary.resultCode,
      completedAtMs: summary.completedAt.getTime(),
      nowMs: now.getTime(),
      hadOrder: summary.hadOrder,
      hadPosition: summary.hadPosition,
      learningStatus,
      cleanupEnabled: retentionMode.deleteEnabled,
    });
    if (!deletionDecision.eligible) continue;
    if (eventIds.length) {
      await db.delete(strategyExecutionEvents).where(inArray(
        strategyExecutionEvents.id,
        eventIds.map((event) => event.id),
      ));
      rawEventsDeleted += eventIds.length;
    }
    const [remaining] = await db
      .select({ id: strategyExecutionEvents.id })
      .from(strategyExecutionEvents)
      .where(eq(strategyExecutionEvents.traceId, summary.traceId))
      .limit(1);
    if (!remaining)
      await db.update(strategyExecutionSummaries).set({
        rawEventsDeletedAt: now,
        updatedAt: now,
      }).where(eq(strategyExecutionSummaries.id, summary.id));
  }
  return {
    scanned: rows.length,
    compacted,
    bytesRemoved,
    factsArchived,
    summariesCreated,
    eventRollupsCreated,
    rawEventsDeleted,
    cleanupEnabled: retentionMode.deleteEnabled,
    retentionMode: retentionMode.effectiveMode,
    previewEligibleSummaries,
    previewEligibleEvents,
    deferred: false,
    reason: retentionMode.deleteEnabled
      ? "TERMINAL_EVENTS_ARCHIVED_AND_CLEANED"
      : "TERMINAL_EVENTS_ARCHIVED_PREVIEW_ONLY",
  };
}

async function runAccountAuditCycle() {
  const db = getDb();
  const startedAt = Date.now();
  const now = new Date(startedAt);
  // A request-scoped runtime may cancel detached promises as soon as the
  // response is returned. Account audit health must therefore mean that the
  // reconciliation work actually completed, not merely that it was queued.
  // Keep the three exchange reconciliation lanes serialized as well: they
  // update overlapping order/position rows and running them concurrently can
  // create avoidable SQLITE_BUSY contention.
  const auxiliaryScheduling = await runLiveRiskAuxiliaryReconciliation(now);
  const pendingCloseReconciliation =
    auxiliaryScheduling.pendingCloseReconciliation;

  const fullAccountScheduling =
    await runFullAccountPositionReconciliation(now);

  const openPositions = await db
    .select()
    .from(livePositions)
    .where(eq(livePositions.status, "OPEN"))
    .limit(100);
  const openPositionScheduling = await runOpenPositionReconciliation(
    openPositions,
    now,
  );

  const capitalPreservationStopBackfill =
    await backfillOpenPositionCapitalPreservationStops(openPositions, now);

  // Strategy trace settlement is DB/account truth maintenance. It belongs on
  // this independent plane, never on the five-second protective-close lane.
  // This releases strategy/symbol branch ownership after a real position has
  // closed without changing any entry analysis or risk parameter.
  let strategyTraceSettlement = {
    settled: 0,
    learningErrors: 0,
    errors: 0,
  };
  try {
    strategyTraceSettlement = {
      ...(await settleClosedStrategyTraces(
        now,
        refreshStrategyParameterSuggestions,
      )),
      errors: 0,
    };
  } catch {
    strategyTraceSettlement.errors = 1;
  }

  // The two-second order lane normally completes exact commission/funding
  // settlement. Account audit remains the durable fallback without ever
  // delaying the five-second protection lane.
  let reductionSettlementBackfill: Awaited<
    ReturnType<typeof backfillPendingReductionSettlement>
  > = {
    updated: 0,
    exact: false,
    errors: 0,
    deferred: true,
    reason: "NOT_RUN",
  };
  try {
    reductionSettlementBackfill =
      await runPendingReductionSettlementBackfill(now);
  } catch {
    reductionSettlementBackfill = {
      ...reductionSettlementBackfill,
      errors: 1,
      reason: "SETTLEMENT_BACKFILL_FAILED",
    };
  }

  const threeMinuteExitCounterfactual =
    await recordOneThreeMinuteExitCounterfactual(now);
  const exitCounterfactual = await recordExitCounterfactualBatch(now);

  // Rejected-entry shadow validation is historical learning work. Backfill one
  // mature trace on the five-minute account-audit plane so it cannot delay
  // order authorization or the five-second position-protection heartbeat.
  let sentinelShadowEntryBackfill: Awaited<
    ReturnType<typeof backfillOneSentinelShadowEntryEvidence>
  >;
  try {
    sentinelShadowEntryBackfill =
      await backfillOneSentinelShadowEntryEvidence(now);
  } catch {
    sentinelShadowEntryBackfill = {
      sampled: 0,
      errors: 1,
      deferred: true,
    };
  }

  let terminalFactCompaction: Awaited<
    ReturnType<typeof compactOneTerminalMarketFactBatch>
  >;
  try {
    terminalFactCompaction = await compactOneTerminalMarketFactBatch(now);
  } catch (error) {
    terminalFactCompaction = {
      scanned: 0,
      compacted: 0,
      bytesRemoved: 0,
      factsArchived: 0,
      summariesCreated: 0,
      eventRollupsCreated: 0,
      rawEventsDeleted: 0,
      cleanupEnabled: false,
      retentionMode: "PREVIEW" as const,
      previewEligibleSummaries: 0,
      previewEligibleEvents: 0,
      deferred: true,
      reason: error instanceof Error
        ? `TERMINAL_FACT_COMPACTION_FAILED:${error.message}`
        : "TERMINAL_FACT_COMPACTION_FAILED",
    };
  }

  return {
    plane: "ACCOUNT_AUDIT",
    pendingCloseReconciliation,
    scheduledBalanceRefreshes: 0,
    auxiliaryReconciliation: {
      ...lastLiveRiskAuxiliaryReconciliation,
      running: false,
      scheduled: auxiliaryScheduling.scheduled,
    },
    fullAccountPositionReconciliation: {
      ...lastFullAccountReconcileSummary,
      running: false,
      scheduled: fullAccountScheduling.scheduled,
    },
    openPositionReconciliation: {
      ...lastOpenPositionReconciliation,
      running: false,
      scheduled: openPositionScheduling.running,
    },
    capitalPreservationStopBackfill,
    strategyTraceSettlement,
    reductionSettlementBackfill,
    threeMinuteExitCounterfactual,
    exitCounterfactual,
    sentinelShadowEntryBackfill,
    terminalFactCompaction,
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };
}

async function runStrategyLearningMaintenanceCycle() {
  const startedAt = Date.now();
  let strategyLearningRefresh: Awaited<
    ReturnType<typeof refreshOneCurrentStrategyLearningSnapshot>
  >;
  try {
    strategyLearningRefresh =
      await refreshOneCurrentStrategyLearningSnapshot(new Date(startedAt));
  } catch (error) {
    strategyLearningRefresh = {
      refreshed: 0,
      errors: 1,
      deferred: true,
      reason: error instanceof Error
        ? `LEARNING_BACKLOG_FAILED:${error.message}`
        : "LEARNING_BACKLOG_FAILED",
    };
  }
  return {
    plane: "STRATEGY_LEARNING",
    strategyLearningRefresh,
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };
}

async function runOrderReconciliationCycle() {
  const startedAt = Date.now();
  // Pending reduce-only fills block the operator from acting on that position.
  // Reconcile one oldest close on the two-second order lane instead of making
  // it wait for the five-minute full account audit. The account audit remains
  // the durable fallback and can process a larger batch.
  const pendingCloseReconciliation =
    await reconcilePendingLivePositionClosures(new Date(startedAt), 1);
  const unknownEntryOrderReconciliation = await reconcileUnknownEntryOrders();
  let reductionSettlementBackfill: Awaited<
    ReturnType<typeof backfillPendingReductionSettlement>
  > = {
    updated: 0,
    exact: false,
    errors: 0,
    deferred: true,
    reason: "NOT_RUN",
  };
  try {
    reductionSettlementBackfill =
      await runPendingReductionSettlementBackfill(new Date());
  } catch {
    reductionSettlementBackfill = {
      ...reductionSettlementBackfill,
      errors: 1,
      reason: "SETTLEMENT_BACKFILL_FAILED",
    };
  }
  return {
    pendingCloseReconciliation,
    unknownEntryOrderReconciliation,
    reductionSettlementBackfill,
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "内部风控凭据无效" }, { status: 401 });
  if ((env as unknown as { NQ_LIVE_RISK_ALLOWED?: string }).NQ_LIVE_RISK_ALLOWED !== "true") return Response.json({ error: "服务器实盘保护性减仓进程未开放" }, { status: 423 });
  const mode = new URL(request.url).searchParams.get("mode");
  const auxiliaryPlane = await dispatchAuxiliaryLiveRiskPlane({
    queryMode: mode,
    runPositionIntelligence: runPositionIntelligenceCycle,
    runAccountAudit: runAccountAuditCycle,
    runStrategyLearning: runStrategyLearningMaintenanceCycle,
    runOrderReconciliation: runOrderReconciliationCycle,
  });
  if (auxiliaryPlane.handled) return Response.json(auxiliaryPlane.result);
  const db = getDb();
  const riskCycleStartedAt = Date.now();
  const now = new Date(riskCycleStartedAt);
  // The five-second protection lane is deliberately deterministic. Account,
  // order and learning maintenance belong to their independent runners and
  // must never delay a triggered close.
  const maintenance = {
    due: false,
    lane: null,
    laneCount: 0,
    reason: "ISOLATED_AUXILIARY_PLANES",
  };
  await db.update(riskStates).set({ riskHeartbeatAt: now });
  // Account balances, private-order reconciliation and full-account position
  // comparison run on the independent account-audit plane. The deterministic
  // five-second protection loop must never wait for those signed REST reads.
  const scheduledBalanceRefreshes = 0;
  const backgroundErrors = 0;
  const auxiliaryReconciliation = {
    ...lastLiveRiskAuxiliaryReconciliation,
    running: liveRiskAuxiliaryReconciliationRunning,
    scheduled: false,
  };
  const {
    privateOrderReconciliation,
    unknownEntryOrderReconciliation,
    executionIntentReconciliation,
    positionAdditionReconciliation,
  } = auxiliaryReconciliation;
  const fullAccountPositionReconciliation = {
    ...lastFullAccountReconcileSummary,
    running: fullAccountReconcileRunning,
    scheduled: false,
  };
  const reconciledUnknown = 0;
  let reconciledMissing = 0;
  // Signed exchange reconciliation belongs exclusively to the account/order
  // planes. Protection reads only the local OPEN ledger and current mark data.
  const candidates = await db.select().from(livePositions).where(eq(livePositions.status, "OPEN")).limit(100);
  const protectionModeNormalization = {
    updated: 0,
    removedFixedStopLevels: 0,
    errors: 0,
  };
  // Historical protection-plan normalization is a compatibility concern, not
  // a prerequisite for deciding whether an OPEN position must be reduced.
  // Persisting every stale row (plus one audit row per position) on the
  // five-second lane made the first production cycle exceed the runner's
  // deadline when dozens of positions were open.  Normalize the candidate in
  // memory for this decision; durable migration belongs to account-audit.
  for (const candidate of candidates) {
    const normalized = normalizeRiskProtectionMode(
      asRecord(parseJson(candidate.riskPlanJson)),
      candidate.trailingStopPercent,
    );
    if (!normalized.changed) continue;
    candidate.riskPlanJson = JSON.stringify(normalized.plan);
    protectionModeNormalization.updated += 1;
    protectionModeNormalization.removedFixedStopLevels +=
      normalized.staleFixedStopCount;
  }
  const protectionCertification = certifyOpenPositionProtection(
    candidates.map((candidate) => ({
      id: candidate.id,
      symbol: candidate.symbol,
      status: candidate.status,
      protectionState: candidate.protectionState,
      riskPlanJson: candidate.riskPlanJson,
      trailingActivationPercent: candidate.trailingActivationPercent,
      trailingStopPercent: candidate.trailingStopPercent,
      pendingCloseClientOrderId: candidate.pendingCloseClientOrderId,
    })),
  );
  const durableStructureExitIntentByPosition =
    await loadActiveStructureExitIntents(candidates);
  const isolatedMaintenanceWork = {
    strategyReductionEvents: {
      written: 0,
      errors: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
    strategyTraceSettlement: {
      settled: 0,
      learningErrors: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
    strategyLearningRefresh: {
      refreshed: 0,
      errors: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
    closedPositionAdditionBackfill: {
      sampled: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
    actualPositionRepairQueue: {
      queued: 0,
      reopened: 0,
      incomplete: 0,
      errors: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
    rejectedSignalEvidence: {
      sampled: 0,
      errors: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
    actualPositionBackfill: {
      sampled: 0,
      errors: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
    entryMarketPositionBackfill: {
      updated: 0,
      errors: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
    entryStructureBackfill: {
      updated: 0,
      errors: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
    rejectedSignalBackfill: {
      sampled: 0,
      errors: 0,
      deferred: true,
      reason: "ISOLATED_AUXILIARY_PLANES",
    },
  };
  if (!candidates.length) {
    return Response.json({ checked: 0, triggered: 0, errors: 0, backgroundErrors, maintenance, scheduledBalanceRefreshes, reconciledUnknown, reconciledMissing, protectionModeNormalization, protectionCertification, ...isolatedMaintenanceWork, positionAdditionReconciliation, fullAccountPositionReconciliation, privateOrderReconciliation, executionIntentReconciliation, unknownEntryOrderReconciliation, checkedAt: now.toISOString() });
  }
  // Deep learning is scheduled by the runner through mode=intelligence.
  // Keeping this set empty is deliberate: the protection response must never
  // wait for K-line, liquidation, funding or large-trader analysis.
  let markRows;
  try {
    const symbols = [...new Set(candidates.map((item) => item.symbol))];
    // The local WebSocket cache is retried by the next five-second heartbeat.
    // Never spend up to 21 seconds retrying inside one close-critical cycle.
    markRows = await getBinanceLiveMarkPrices(symbols, {
      timeoutMs: 2_500,
      includeHistory: true,
    });
  } catch (error) {
    if (error instanceof BinanceLiveError && [418, 429].includes(error.status)) {
      const retryAfterSeconds = Math.max(5, Math.ceil(error.retryAfterSeconds ?? 60));
      return Response.json(
        { error: "Binance 行情请求已限流，风控巡检按交易所要求退避", retryAfterSeconds, protectionCertification },
        { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
      );
    }
    if (error instanceof BinanceLiveError && error.status === 503) {
      // The central WebSocket proxy uses a short 503 while a fresh mark-price
      // frame is arriving.  Propagate that short freshness retry instead of
      // turning it into a 30-second risk blackout in the runner.
      const retryAfterSeconds = Math.min(
        5,
        Math.max(1, Math.ceil(error.retryAfterSeconds ?? 2)),
      );
      return Response.json(
        {
          error: error.message || "系统 WebSocket 标记价格暂不可用",
          retryAfterSeconds,
          protectionCertification,
        },
        {
          status: 503,
          headers: { "retry-after": String(retryAfterSeconds) },
        },
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Binance 标记价格暂不可用", protectionCertification },
      // A generic internal proxy/network interruption is not an exchange rate
      // limit.  Keep the protection loop on its normal five-second recovery
      // cadence instead of creating a thirty-second blind interval.
      { status: 503, headers: { "retry-after": "5" } },
    );
  }
  const staleMark = markRows.find((item) => Date.now() - item.time > 5_000);
  if (staleMark) {
    return Response.json(
      { error: `系统 WebSocket 行情已过期，停止风控判断：${staleMark.symbol}`, protectionCertification },
      { status: 503, headers: { "retry-after": "2" } },
    );
  }
  const markBySymbol = new Map(markRows.map((item) => [item.symbol, item]));
  const marketMicrostructureByPosition = new Map<
    number,
    ReturnType<typeof summarizePositionMarketMicrostructure>
  >();
  const microstructureProtectionByPosition = new Map<
    number,
    ReturnType<typeof evaluatePositionMicrostructureProtection>
  >();
  const relativeStrengthPairLifecycleByPosition =
    evaluateRelativeStrengthPairLifecycles({
      positions: candidates.map((position) => ({
        id: position.id,
        symbol: position.symbol,
        positionSide: position.positionSide,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        leverage: position.leverage,
        openedAt: position.openedAt,
        riskPlanJson: position.riskPlanJson,
      })),
      marks: markRows,
      nowMs: now.getTime(),
      recoveryGraceMs: 30_000,
    });
  const accountDrawdownIntentByPosition = new Map<number, {
    phase: "DEFENSIVE" | "HARD_STOP";
    drawdownPercent: number;
    requiredReturnToPeakPercent: number | null;
  }>();
  const openPositionIds = new Set(candidates.map((item) => item.id));
  for (const positionId of liveRiskFavorablePriceByPosition.keys()) {
    if (!openPositionIds.has(positionId))
      liveRiskFavorablePriceByPosition.delete(positionId);
  }
  const immediateProtectionIds: number[] = [];
  for (const candidate of candidates) {
    if (accountDrawdownIntentByPosition.has(candidate.id)) {
      immediateProtectionIds.push(candidate.id);
      continue;
    }
    if (
      relativeStrengthPairLifecycleByPosition.get(candidate.id)?.closeRequired
    ) {
      immediateProtectionIds.push(candidate.id);
      continue;
    }
    const markSnapshot = markBySymbol.get(candidate.symbol);
    const markPrice = markSnapshot?.markPrice;
    if (!Number.isFinite(markPrice) || !markPrice || markPrice <= 0) {
      // Missing market facts cannot authorize a close. Let the rotating
      // maintenance slot record the fault without crowding actual stops,
      // takes and liquidation protection out of the priority lane.
      continue;
    }
    const favorablePrice = monotonicFavorablePrice({
      positionSide: candidate.positionSide,
      entryPrice: candidate.entryPrice,
      previousFavorablePrice:
        liveRiskFavorablePriceByPosition.get(candidate.id) ??
        candidate.favorablePrice,
      currentMarkPrice: markPrice,
    }) ?? candidate.entryPrice;
    liveRiskFavorablePriceByPosition.set(candidate.id, favorablePrice);
    // Preserve an intracycle peak even when routine persistence for this
    // position rotates to a later cycle. Dynamic protection must not forget a
    // favorable move merely because dozens of other positions are open.
    candidate.favorablePrice = favorablePrice;
    if (
      candidate.pendingCloseClientOrderId ||
      /ReduceOnly Order is rejected/i.test(candidate.lastError ?? "")
    ) {
      immediateProtectionIds.push(candidate.id);
      continue;
    }
    // Deep intelligence is intentionally isolated from the deterministic
    // protection loop. Once it authorizes a still-fresh structure exit, the
    // next heartbeat must promote that position into the priority lane;
    // ordinary maintenance rotation previously outlived the handoff lease and
    // silently discarded an already-authorized exit.
    const candidateRiskPlan = asRecord(parseJson(candidate.riskPlanJson));
    const candidateThreeMinutePlan = resolveThreeMinutePositionPlan(
      candidateRiskPlan.threeMinuteRound,
    );
    const candidateIsThreeMinutePosition = candidateThreeMinutePlan !== null;
    if (
      !candidateIsThreeMinutePosition &&
      (
        durableStructureExitIntentByPosition.has(candidate.id) ||
        hasAuthorizedPositionIntelligenceExit(candidate.id)
      )
    ) {
      immediateProtectionIds.push(candidate.id);
      continue;
    }
    try {
      const currentRoePercent = positionRoePercent(
        candidate.entryPrice,
        markPrice,
        candidate.leverage,
        candidate.positionSide,
      );
      const favorableRoePercent = positionRoePercent(
        candidate.entryPrice,
        favorablePrice,
        candidate.leverage,
        candidate.positionSide,
      );
      if (
        !Number.isFinite(currentRoePercent) ||
        !Number.isFinite(favorableRoePercent)
      ) {
        continue;
      }
      const marketMicrostructure = summarizePositionMarketMicrostructure({
        positionSide: candidate.positionSide,
        entryPrice: candidate.entryPrice,
        markPrice,
        observedAtMs: markSnapshot.time,
        samples: markSnapshot.history,
      });
      const currentPositionEvidence = peekPositionIntelligenceOpportunity(
        candidate.id,
      );
      const microstructureProtection =
        evaluatePositionMicrostructureProtection({
          microstructure: marketMicrostructure,
          currentRoePercent,
          favorableRoePercent,
          causalEvidenceMode: trailingEvidenceMode(currentPositionEvidence),
          monitoringStartRoePercent: 1,
        });
      marketMicrostructureByPosition.set(candidate.id, marketMicrostructure);
      microstructureProtectionByPosition.set(
        candidate.id,
        microstructureProtection,
      );
      const positionMemory = readNexusPositionMemory(
        candidate.riskPlanJson,
        candidate,
      );
      const entryProbe = evaluatePositionEntryProbe({
        positionSide: candidate.positionSide,
        openedAtMs: candidate.openedAt.getTime(),
        observedAtMs: markSnapshot.time,
        invalidBoundary: entryProbeInvalidBoundary({
          positionSide: candidate.positionSide,
          baseline: positionMemory.entryStructureBaseline,
        }),
        microstructure: marketMicrostructure,
      });
      if (
        entryProbe.exitAuthorized ||
        microstructureProtection.earlyProtectionAuthorized ||
        microstructureProtection.lossExitUrgency
      ) {
        immediateProtectionIds.push(candidate.id);
        continue;
      }
      const rawRiskPlan = candidateRiskPlan;
      const threeMinutePlan = resolveThreeMinutePositionPlan(
        rawRiskPlan.threeMinuteRound,
      );
      const threeMinutePosition = threeMinutePlan !== null;
      const timeExitDue = threeMinutePlan !== null && threeMinuteTimeExitDue({
        openedAtMs: candidate.openedAt.getTime(),
        nowMs: now.getTime(),
        holdSeconds: threeMinutePlan.timeExitSeconds,
      });
      const dynamicStopModeEnabled =
        !threeMinutePosition &&
        rawRiskPlan.dynamicProfitProtectionEnabled !== false &&
        candidate.trailingStopPercent > 0;
      const plan = parseRiskPlan(candidate.riskPlanJson);
      const softProtection = effectiveSoftProtection({
        plan: rawRiskPlan,
        positionVersion: candidate.positionVersion,
        protectionVersion: candidate.protectionVersion,
      });
      const previousExecuted = parseExecutedPlan(
        candidate.executedRiskPlanJson,
      );
      const threeMinuteDynamicProtection = threeMinutePosition
        ? advanceThreeMinuteDynamicProtection({
            progress: previousExecuted.threeMinuteDynamicProtection,
            currentRoePercent,
            observedAtMs: markSnapshot.time,
          })
        : null;
      const executed = observeDynamicProfitSoftActivation({
        progress: previousExecuted,
        enabled: dynamicStopModeEnabled && softProtection.executable,
        currentQuantity: candidate.quantity,
        currentRoePercent,
        activationRoePercent:
          microstructureProtection.activationRoePercentOverride ?? 2,
        observedAtMs: Date.now(),
      });
      const dynamicTrailing = dynamicProfitProtection({
        enabled: dynamicStopModeEnabled,
        entryPrice: candidate.entryPrice,
        leverage: candidate.leverage,
        currentRoePercent,
        favorableRoePercent,
        atrPrice: riskPlanAtrPrice(candidate.riskPlanJson),
        configuredActivationRoePercent:
          microstructureProtection.activationRoePercentOverride ??
          candidate.trailingActivationPercent,
        configuredGivebackRoePoints: candidate.trailingStopPercent,
        observationRoePercent: 1,
        lockedFloorRoePercent:
          executed.dynamicProfitReduction?.lockedProtectionFloorRoePercent ??
          null,
      });
      const postProfitProtection = postFirstTakeProfitProtection({
        leverage: candidate.leverage,
        completedTakeProfitLevels: Math.max(
          executed.takeProfits.length,
          executed.verifiedProfitTaking?.count ?? 0,
        ),
        realizedPnlUsdt: candidate.realizedPnl,
        currentRoePercent,
        configuredTrailingFloorRoePercent:
          dynamicTrailing.effectiveFloorRoePercent,
      });
      const immediateDynamicProfitReduction = decideDynamicProfitReduction({
        protection: dynamicTrailing,
        currentRoePercent,
        firstTakeProfitRoePercent:
          Number.isFinite(Number(plan.takeProfits[0]?.triggerPercent))
            ? Number(plan.takeProfits[0]?.triggerPercent)
            : null,
        completedTakeProfitLevels: Math.max(
          executed.takeProfits.length,
          executed.verifiedProfitTaking?.count ?? 0,
        ),
        currentQuantity: candidate.quantity,
        progress: executed.dynamicProfitReduction,
        nowMs: Date.now(),
        economics: {
          positionSide: candidate.positionSide,
          entryPrice: candidate.entryPrice,
          executablePrice: markPrice,
        },
      });
      const liquidationProtection = liquidationGuard({
        positionSide: candidate.positionSide,
        markPrice,
        liquidationPrice: candidate.liquidationPrice,
        bufferPercent: plan.liquidationGuardBufferPercent,
      });
      const configuredStopHit =
        (!threeMinutePosition || threeMinutePlan?.earlyStopEnabled === true) &&
        softProtection.executable &&
        !dynamicStopModeEnabled &&
        plan.stopLosses.some(
          (level, index) =>
            !executed.stopLosses.includes(index) &&
            currentRoePercent <= -level.triggerPercent,
        );
      const capitalStopHit = capitalPreservationStopHit({
        plan: rawRiskPlan,
        currentRoePercent,
        executable:
          softProtection.executable &&
          (!threeMinutePosition || threeMinutePlan?.earlyStopEnabled === true),
      }).hit;
      const configuredTakeHit =
        (!threeMinutePosition ||
          threeMinutePlan?.earlyTakeProfitEnabled === true) &&
        plan.takeProfits.some(
        (level, index) =>
          !executed.takeProfits.includes(index) &&
          remainingTakeProfitQuantity(
            executed,
            index,
            Number(level.closeQuantity ?? 0),
          ) > 1e-12 &&
          currentRoePercent >= level.triggerPercent,
      );
      const profitCaptureHit = threeMinutePosition &&
        threeMinuteProfitCaptureHit({
          currentGrossRoePercent: currentRoePercent,
          leverage: candidate.leverage,
          plan: threeMinutePlan,
        });
      if (
        timeExitDue ||
        profitCaptureHit ||
        threeMinuteDynamicProtection?.action !== "NONE" ||
        threeMinuteDynamicProtection?.stateChanged === true ||
        liquidationProtection.hit ||
        capitalStopHit ||
        configuredStopHit ||
        configuredTakeHit ||
        (
          softProtection.executable &&
          dynamicStopModeEnabled &&
          (
            dynamicTrailing.hit ||
            immediateDynamicProfitReduction.action !== "NONE" ||
            postProfitProtection.hit
          )
        )
      ) immediateProtectionIds.push(candidate.id);
    } catch {
      // Invalid compatibility data is not permission to trade. It rotates
      // through maintenance while deterministic close triggers stay first.
    }
  }
  const protectionWorkSelection = selectProtectionWorkIds({
    ids: candidates.map((item) => item.id),
    cursor: positionProtectionMaintenanceCursor,
    maintenanceBudget: POSITION_PROTECTION_MAINTENANCE_BUDGET_PER_CYCLE,
    priorityCursor: positionProtectionPriorityCursor,
    priorityBudget: POSITION_PROTECTION_PRIORITY_BUDGET_PER_CYCLE,
    priorityIds: immediateProtectionIds,
    maintenancePriorityIds: [],
  });
  positionProtectionMaintenanceCursor = protectionWorkSelection.nextCursor;
  positionProtectionPriorityCursor =
    protectionWorkSelection.nextPriorityCursor;
  const protectionWorkIds = new Set(protectionWorkSelection.selectedIds);
  const freshMarkForSymbol = async (symbol: string) => {
    const current = markBySymbol.get(symbol);
    if (current && Date.now() - current.time <= 5_000) return current;
    // The heartbeat already acquired one bounded WebSocket snapshot for every
    // open symbol. Re-fetching the complete symbol set once per missing row
    // multiplied a single market-data gap into N sequential network waits and
    // made close protection miss its deadline. A missing mark is not trading
    // permission; record it and retry from the next five-second snapshot.
    return null;
  };
  const symbolRules = await db
    .select()
    .from(contractSymbols)
    .where(
      inArray(
        contractSymbols.symbol,
        [...new Set(candidates.map((item) => item.symbol))],
      ),
    );
  const symbolRuleBySymbol = new Map(
    symbolRules.map((item) => [item.symbol, item]),
  );
  let checked = 0;
  let triggered = 0;
  let errors = 0;

  for (const candidate of candidates) {
    if (!protectionWorkIds.has(candidate.id)) continue;
    // Pending close intents are owned exclusively by the independent order
    // reconciler. Do not acquire the five-second protection lease for them:
    // that lease write also advances updatedAt and would keep resetting the
    // stale-order age used to release a Binance -2013 ghost intent.
    if (candidate.pendingCloseClientOrderId) continue;
    const leaseUntil = new Date(Date.now() + 15_000);
    const [position] = await db.update(livePositions).set({ riskLeaseUntil: leaseUntil, updatedAt: now }).where(and(eq(livePositions.id, candidate.id), eq(livePositions.status, "OPEN"), eq(livePositions.positionVersion, candidate.positionVersion), eq(livePositions.protectionVersion, candidate.protectionVersion), or(isNull(livePositions.riskLeaseUntil), lte(livePositions.riskLeaseUntil, now)))).returning();
    if (!position) continue;
    checked += 1;
    const positionSymbolRule = symbolRuleBySymbol.get(position.symbol);
    if (!positionSymbolRule) {
      errors += 1;
      await db
        .update(livePositions)
        .set({
          riskLeaseUntil: null,
          lastError: "合约数量规则不存在，无法按最小步长执行减仓",
          updatedAt: new Date(),
        })
        .where(eq(livePositions.id, position.id));
      continue;
    }
    let markSnapshot;
    try {
      markSnapshot = await freshMarkForSymbol(position.symbol);
    } catch {
      markSnapshot = null;
    }
    const markPrice = markSnapshot?.markPrice;
    if (!markSnapshot || !markPrice) { errors += 1; await db.update(livePositions).set({ riskLeaseUntil: null, lastError: "缺少新鲜的 Binance WebSocket 标记价格", updatedAt: new Date() }).where(eq(livePositions.id, position.id)); continue; }
    const marketMicrostructure = marketMicrostructureByPosition.get(
      position.id,
    ) ?? summarizePositionMarketMicrostructure({
      positionSide: position.positionSide,
      entryPrice: position.entryPrice,
      markPrice,
      observedAtMs: markSnapshot.time,
      samples: markSnapshot.history,
    });
    if (/ReduceOnly Order is rejected/i.test(position.lastError ?? "")) {
      try {
        const [credential] = await db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, position.credentialId), eq(exchangeCredentials.ownerEmail, position.ownerEmail))).limit(1);
        if (!credential) throw new Error("实盘密钥不存在，无法核对 ReduceOnly 拒绝后的真实仓位");
        const keys = { apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(position.ownerEmail, position.accountId, "api-key")), secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(position.ownerEmail, position.accountId, "secret-key")) };
        const exchangePosition = await getLivePositionSnapshot(keys, position.symbol, position.positionSide);
        await db.update(exchangeCredentials).set({ positionMode: exchangePosition.hedgeMode ? "HEDGE" : "ONE_WAY", updatedAt: new Date() }).where(eq(exchangeCredentials.id, credential.id));
        if (!Number.isFinite(exchangePosition.quantity) || exchangePosition.quantity <= 0) {
          await db.update(livePositions).set({ status: "CLOSED", exitReason: "EXTERNAL", closedAt: new Date(), riskLeaseUntil: null, pendingCloseClientOrderId: null, pendingCloseReason: null, pendingCloseQuantity: null, pendingClosePlanJson: null, lastError: "Binance 当前方向仓位为 0，已同步关闭错误的本地仓位记录", updatedAt: new Date() }).where(eq(livePositions.id, position.id));
          await writeAudit({ email: position.ownerEmail, accountId: position.accountId }, "RECONCILE_REDUCE_ONLY_MISSING_POSITION", "live_position", String(position.id), { symbol: position.symbol, positionSide: position.positionSide });
          continue;
        }
        const reconciledEntryPrice = exchangePosition.entryPrice > 0
          ? exchangePosition.entryPrice
          : position.entryPrice;
        const reconciledMarkPrice = exchangePosition.markPrice > 0
          ? exchangePosition.markPrice
          : markPrice;
        const basisChanged = Math.abs(reconciledEntryPrice - position.entryPrice) >
          Math.max(1e-12, Math.abs(position.entryPrice) * 1e-10);
        await db.update(livePositions).set({
          entryPrice: reconciledEntryPrice,
          markPrice: reconciledMarkPrice,
          liquidationPrice: Number.isFinite(exchangePosition.liquidationPrice)
            ? exchangePosition.liquidationPrice > 0
              ? exchangePosition.liquidationPrice
              : null
            : position.liquidationPrice,
          liquidationPriceRaw: exchangePosition.liquidationPriceRaw,
          liquidationPriceStatus: exchangePosition.liquidationPriceStatus,
          liquidationPriceObservedAt: new Date(
            exchangePosition.liquidationPriceObservedAt,
          ),
          favorablePrice: monotonicFavorablePrice({
            positionSide: position.positionSide,
            entryPrice: reconciledEntryPrice,
            previousFavorablePrice: position.favorablePrice,
            currentMarkPrice: reconciledMarkPrice,
            reset: basisChanged,
          }),
          riskLeaseUntil: null,
          pendingCloseClientOrderId: null,
          pendingCloseReason: null,
          pendingCloseQuantity: null,
          pendingClosePlanJson: null,
          lastError: null,
          updatedAt: new Date(),
        }).where(eq(livePositions.id, position.id));
        await writeAudit({ email: position.ownerEmail, accountId: position.accountId }, "RECONCILE_REDUCE_ONLY_LIVE_POSITION", "live_position", String(position.id), { symbol: position.symbol, positionSide: position.positionSide, localAllocatedQuantity: position.quantity, exchangeAggregateQuantity: exchangePosition.quantity, hedgeMode: exchangePosition.hedgeMode });
        continue;
      } catch (error) {
        errors += 1;
        await db.update(livePositions).set({ riskLeaseUntil: null, lastError: `ReduceOnly Order is rejected. 核对失败：${error instanceof Error ? error.message : "未知错误"}`, updatedAt: new Date() }).where(eq(livePositions.id, position.id));
        continue;
      }
    }
    const favorablePrice = monotonicFavorablePrice({
      positionSide: position.positionSide,
      entryPrice: position.entryPrice,
      previousFavorablePrice: position.favorablePrice,
      currentMarkPrice: markPrice,
    }) ?? position.entryPrice;
    const currentRoePercent = positionRoePercent(position.entryPrice, markPrice, position.leverage, position.positionSide);
    const favorableRoePercent = positionRoePercent(position.entryPrice, favorablePrice, position.leverage, position.positionSide);
    if (!Number.isFinite(currentRoePercent) || !Number.isFinite(favorableRoePercent)) { errors += 1; await db.update(livePositions).set({ riskLeaseUntil: null, lastError: "仓位收益率计算失败", updatedAt: new Date() }).where(eq(livePositions.id, position.id)); continue; }
    const microstructureProtectionPreview =
      microstructureProtectionByPosition.get(position.id) ??
      evaluatePositionMicrostructureProtection({
        microstructure: marketMicrostructure,
        currentRoePercent,
        favorableRoePercent,
        causalEvidenceMode: trailingEvidenceMode(
          peekPositionIntelligenceOpportunity(position.id),
        ),
        monitoringStartRoePercent: 1,
      });
    const rawRiskPlan = asRecord(parseJson(position.riskPlanJson));
    const positionMemory = readNexusPositionMemory(
      position.riskPlanJson,
      position,
    );
    const entryProbe = evaluatePositionEntryProbe({
      positionSide: position.positionSide,
      openedAtMs: position.openedAt.getTime(),
      observedAtMs: markSnapshot.time,
      invalidBoundary: entryProbeInvalidBoundary({
        positionSide: position.positionSide,
        baseline: positionMemory.entryStructureBaseline,
      }),
      microstructure: marketMicrostructure,
    });
    const threeMinutePlan = resolveThreeMinutePositionPlan(
      rawRiskPlan.threeMinuteRound,
    );
    const threeMinutePosition = threeMinutePlan !== null;
    const timeExitDue = threeMinutePlan !== null && threeMinuteTimeExitDue({
      openedAtMs: position.openedAt.getTime(),
      nowMs: now.getTime(),
      holdSeconds: threeMinutePlan.timeExitSeconds,
    });
    const previousExecuted = parseExecutedPlan(
      position.executedRiskPlanJson,
    );
    const threeMinuteDynamicProtection = threeMinutePosition
      ? advanceThreeMinuteDynamicProtection({
          progress: previousExecuted.threeMinuteDynamicProtection,
          currentRoePercent,
          observedAtMs: markSnapshot.time,
        })
      : null;
    const provisionalDynamicTrailing = dynamicProfitProtection({
      enabled:
        !threeMinutePosition &&
        rawRiskPlan.dynamicProfitProtectionEnabled !== false &&
        position.trailingStopPercent > 0,
      entryPrice: position.entryPrice,
      leverage: position.leverage,
      currentRoePercent,
      favorableRoePercent,
      atrPrice: riskPlanAtrPrice(position.riskPlanJson),
      configuredActivationRoePercent:
        microstructureProtectionPreview.activationRoePercentOverride ??
        position.trailingActivationPercent,
      configuredGivebackRoePoints: position.trailingStopPercent,
      observationRoePercent: 1,
      lockedFloorRoePercent:
        previousExecuted.dynamicProfitReduction
          ?.lockedProtectionFloorRoePercent ?? null,
    });
    const dynamicStopModeEnabled = provisionalDynamicTrailing.enabled;
    const plan = parseRiskPlan(position.riskPlanJson);
    const softProtection = effectiveSoftProtection({
      plan: asRecord(parseJson(position.riskPlanJson)),
      positionVersion: position.positionVersion,
      protectionVersion: position.protectionVersion,
    });
    let executed = observeDynamicProfitSoftActivation({
      progress: previousExecuted,
      enabled: dynamicStopModeEnabled && softProtection.executable,
      currentQuantity: position.quantity,
      currentRoePercent,
      activationRoePercent:
        microstructureProtectionPreview.activationRoePercentOverride ?? 2,
      observedAtMs: Date.now(),
    });
    if (threeMinuteDynamicProtection)
      executed.threeMinuteDynamicProtection =
        threeMinuteDynamicProtection.progress;
    const relativeStrengthPairLifecycle =
      relativeStrengthPairLifecycleByPosition.get(position.id) ?? null;
    if (relativeStrengthPairLifecycle)
      Object.assign(executed, { relativeStrengthPairLifecycle });
    const provisionalPostProfitProtection = postFirstTakeProfitProtection({
      leverage: position.leverage,
      completedTakeProfitLevels: Math.max(
        executed.takeProfits.length,
        executed.verifiedProfitTaking?.count ?? 0,
      ),
      realizedPnlUsdt: position.realizedPnl,
      currentRoePercent,
      configuredTrailingFloorRoePercent:
        provisionalDynamicTrailing.effectiveFloorRoePercent,
    });
    const provisionalTrailingHit =
      softProtection.executable &&
      dynamicStopModeEnabled &&
      (
        provisionalDynamicTrailing.hit ||
        provisionalPostProfitProtection.hit
      );
    const liquidationProtection = liquidationGuard({
      positionSide: position.positionSide,
      markPrice,
      liquidationPrice: position.liquidationPrice,
      bufferPercent: plan.liquidationGuardBufferPercent,
    });
    const crossedStops = plan.stopLosses
      .map((level, index) => ({
        level,
        index,
        plannedQuantity: Number(level.closeQuantity ?? position.quantity),
      }))
      .filter(({ level, index }) =>
        (!threeMinutePosition || threeMinutePlan?.earlyStopEnabled === true) &&
        softProtection.executable &&
        !dynamicStopModeEnabled &&
        !executed.stopLosses.includes(index) &&
        currentRoePercent <= -level.triggerPercent
      );
    const capitalStop = capitalPreservationStopHit({
      plan: rawRiskPlan,
      currentRoePercent,
      executable:
        softProtection.executable &&
        (!threeMinutePosition || threeMinutePlan?.earlyStopEnabled === true),
    });
    const crossedTakes = plan.takeProfits
      .map((level, index) => {
        const plannedQuantity = Number(level.closeQuantity ?? 0);
        const closeQuantity = remainingTakeProfitQuantity(
          executed,
          index,
          plannedQuantity,
        );
        return {
          level: { ...level, closeQuantity },
          index,
          plannedQuantity,
        };
      })
      .filter(({ level, index }) =>
        (!threeMinutePosition ||
          threeMinutePlan?.earlyTakeProfitEnabled === true) &&
        !executed.takeProfits.includes(index) &&
        Number(level.closeQuantity) > 1e-12 &&
        currentRoePercent >= level.triggerPercent
      );
    const profitCaptureHit = threeMinutePosition &&
      threeMinuteProfitCaptureHit({
        currentGrossRoePercent: currentRoePercent,
        leverage: position.leverage,
        plan: threeMinutePlan,
      });
    const threeMinuteDynamicTakeProfitHit =
      threeMinuteDynamicProtection?.action === "TAKE_PROFIT";
    const threeMinuteDynamicTrailingHit =
      threeMinuteDynamicProtection?.action === "TRAILING_STOP";
    const threeMinuteDynamicStopLossHit =
      threeMinuteDynamicProtection?.action === "STOP_LOSS";
    const positionManagementOpportunity: Awaited<
      ReturnType<typeof recordLiquidationPositionEvidence>
    > | null = takePositionIntelligenceOpportunity(position.id);
    const positionEvidenceMode = trailingEvidenceMode(
      positionManagementOpportunity,
    );
    const microstructureProtection =
      evaluatePositionMicrostructureProtection({
        microstructure: marketMicrostructure,
        currentRoePercent,
        favorableRoePercent,
        causalEvidenceMode: positionEvidenceMode,
        monitoringStartRoePercent: 1,
      });
    executed = observeDynamicProfitSoftActivation({
      progress: executed,
      enabled: dynamicStopModeEnabled && softProtection.executable,
      currentQuantity: position.quantity,
      currentRoePercent,
      activationRoePercent:
        microstructureProtection.activationRoePercentOverride ?? 2,
      observedAtMs: Date.now(),
    });
    const dynamicTrailing = dynamicProfitProtection({
      enabled: dynamicStopModeEnabled,
      entryPrice: position.entryPrice,
      leverage: position.leverage,
      currentRoePercent,
      favorableRoePercent,
      atrPrice: riskPlanAtrPrice(position.riskPlanJson),
      configuredActivationRoePercent:
        microstructureProtection.activationRoePercentOverride ??
        position.trailingActivationPercent,
      configuredGivebackRoePoints: position.trailingStopPercent,
      observationRoePercent: 1,
      evidenceMode: positionEvidenceMode,
      lockedFloorRoePercent:
        executed.dynamicProfitReduction?.lockedProtectionFloorRoePercent ??
        null,
    });
    executed = observeDynamicProfitProtectionFloor({
      progress: executed,
      enabled:
        softProtection.executable &&
        dynamicTrailing.armed,
      currentQuantity: position.quantity,
      effectiveFloorRoePercent: dynamicTrailing.effectiveFloorRoePercent,
    });
    const trailingTriggerRoePercent =
      dynamicTrailing.effectiveFloorRoePercent;
    const trailingPrice = trailingTriggerRoePercent === null
      ? null
      : priceAtRoePercent(
          position.entryPrice,
          trailingTriggerRoePercent,
          position.leverage,
          position.positionSide,
        );
    const postProfitProtection = postFirstTakeProfitProtection({
      leverage: position.leverage,
      completedTakeProfitLevels: Math.max(
        executed.takeProfits.length,
        executed.verifiedProfitTaking?.count ?? 0,
      ),
      realizedPnlUsdt: position.realizedPnl,
      currentRoePercent,
      configuredTrailingFloorRoePercent: trailingTriggerRoePercent,
    });
    const dynamicProfitReduction = decideDynamicProfitReduction({
      protection: dynamicTrailing,
      currentRoePercent,
      firstTakeProfitRoePercent:
        Number.isFinite(Number(plan.takeProfits[0]?.triggerPercent))
          ? Number(plan.takeProfits[0]?.triggerPercent)
          : null,
      completedTakeProfitLevels: Math.max(
        executed.takeProfits.length,
        executed.verifiedProfitTaking?.count ?? 0,
      ),
      currentQuantity: position.quantity,
      progress: executed.dynamicProfitReduction,
      nowMs: Date.now(),
      economics: {
        positionSide: position.positionSide,
        entryPrice: position.entryPrice,
        executablePrice: markPrice,
      },
    });
    const tailWaveExitDecision = decideTailWaveExit({
      plan: plan.tailWaveExit,
      progress: executed.tailWaveExit,
      verifiedTakeProfitCount:
        executed.verifiedProfitTaking?.count ?? 0,
      currentQuantity: position.quantity,
      currentRoePercent,
      softTriggerRoePercent: trailingTriggerRoePercent,
      hardFloorRoePercent:
        postProfitProtection.feeCoveredFloorRoePercent ??
        dynamicTrailing.feeCoveredFloorRoePercent,
      atrRoePercent: dynamicTrailing.atrRoePercent,
      evidenceMode: dynamicTrailing.evidenceMode,
      softTriggerHit:
        dynamicTrailing.hit || postProfitProtection.hit,
      nowMs: Date.now(),
    });
    executed.tailWaveExit = tailWaveExitDecision.progress;
    const trailingHit =
      softProtection.executable &&
      dynamicStopModeEnabled &&
      (
        tailWaveExitDecision.action === "EXIT_NOW" ||
        (
          !tailWaveExitDecision.suppressImmediateTrailingClose &&
          (dynamicTrailing.hit || postProfitProtection.hit)
        ) ||
        dynamicProfitReduction.action !== "NONE"
      );
    const pendingPlan = parseJson(position.pendingClosePlanJson ?? "{}") as {
      indexes?: number[];
      profitCapture?: boolean;
      structureExit?: boolean;
      accountDrawdownExit?: {
        phase: "DEFENSIVE" | "HARD_STOP";
        drawdownPercent: number;
        requiredReturnToPeakPercent: number | null;
      } | null;
      autonomousTrigger?: string;
      positionManagement?: PositionManagementActionReference | null;
      dynamicProfitReduction?: DynamicProfitReductionDecision | null;
      tailWaveExit?: TailWaveExitDecision | null;
      threeMinuteDynamicProtection?: Record<string, unknown> | null;
      evidenceRisk?: {
        action: "REDUCE_PARTIAL" | "EXIT_FULL";
        reductionPercent: number;
        opportunityId: string | null;
      } | null;
      relativeStrengthPairLifecycle?: Record<string, unknown> | null;
      executionAdjustment?: Record<string, unknown> | null;
    };
    const pendingIndexes = Array.isArray(pendingPlan.indexes) ? pendingPlan.indexes.filter(Number.isInteger) : [];
    const effectiveDynamicProfitReduction =
      pendingPlan.dynamicProfitReduction ?? dynamicProfitReduction;
    const effectiveTailWaveExit =
      pendingPlan.tailWaveExit ?? tailWaveExitDecision;
    const latchedReason =
      position.pendingCloseClientOrderId &&
      (
        position.pendingCloseReason === "STOP_LOSS" ||
        position.pendingCloseReason === "TAKE_PROFIT" ||
        position.pendingCloseReason === "TRAILING_STOP" ||
        position.pendingCloseReason === "TIME_EXIT"
      )
        ? position.pendingCloseReason
        : null;
    const durableStructureExitIntent = threeMinutePosition
      ? null
      : durableStructureExitIntentByPosition.get(position.id) ?? null;
    const currentEvidenceRisk = !threeMinutePosition &&
        positionManagementOpportunity?.evidenceGate?.effective === true &&
        (
          positionManagementOpportunity.evidenceRiskReductionAuthorized ||
          positionManagementOpportunity.evidenceRiskExitAuthorized
        )
      ? {
          action: positionManagementOpportunity.evidenceRiskExitAuthorized
            ? "EXIT_FULL" as const
            : "REDUCE_PARTIAL" as const,
          reductionPercent:
            positionManagementOpportunity.evidenceRiskExitAuthorized
              ? 100
              : Number(
                  positionManagementOpportunity.evidenceRiskClosePercent,
                ),
          opportunityId: positionManagementOpportunity.opportunityId,
        }
      : null;
    const evidenceRiskFullExit =
      (pendingPlan.evidenceRisk ?? currentEvidenceRisk)?.action ===
        "EXIT_FULL";
    const probeExit = !threeMinutePosition && entryProbe.exitAuthorized;
    const structureExit = !threeMinutePosition &&
      (
        probeExit ||
        evidenceRiskFullExit ||
        durableStructureExitIntent !== null ||
        structureExitExecutionAuthorized({
          analysisAuthorized:
            positionManagementOpportunity?.structureExitAuthorized === true,
          mode: plan.structureExitExecutionMode,
          softProtectionExecutable: softProtection.executable,
          currentRoePercent,
        })
      );
    const positionManagementReference =
      pendingPlan.positionManagement ??
      (durableStructureExitIntent
        ? {
            opportunityId: durableStructureExitIntent.opportunityId,
            traceId: durableStructureExitIntent.traceId,
            observedMinute: durableStructureExitIntent.observedMinute,
            observedAtMs: durableStructureExitIntent.observedAtMs,
            validUntilMs: null,
          }
        :
        (structureExit
          ? positionManagementActionReference(positionManagementOpportunity)
          : null));
    const autonomyDecision = decidePositionAutonomy({
      liquidationPriceAvailable: liquidationProtection.available,
      liquidationGuardHit: liquidationProtection.hit,
      configuredStopHit: capitalStop.hit ||
        crossedStops.length > 0 ||
        threeMinuteDynamicStopLossHit,
      takeProfitHit:
        crossedTakes.length > 0 ||
        profitCaptureHit ||
        threeMinuteDynamicTakeProfitHit,
      trailingProtectionHit:
        trailingHit || threeMinuteDynamicTrailingHit,
      structureInvalidated: structureExit,
    });
    const pairExitRequired =
      relativeStrengthPairLifecycle?.closeRequired === true;
    const accountDrawdownExit =
      accountDrawdownIntentByPosition.get(position.id) ?? null;
    const evidenceRiskExecution = selectPositionEvidenceRiskExecution({
      pending: pendingPlan.evidenceRisk,
      candidate: currentEvidenceRisk,
      latchedClose: Boolean(latchedReason),
      accountDrawdownExit: Boolean(accountDrawdownExit),
      pairExit: pairExitRequired,
      timeExit: timeExitDue,
      autonomyAction: autonomyDecision.action,
      autonomyReason: autonomyDecision.reason,
    });
    const reason:
      | "STOP_LOSS"
      | "TAKE_PROFIT"
      | "TRAILING_STOP"
      | "TIME_EXIT"
      | null =
      accountDrawdownExit
        ? "STOP_LOSS"
        : pairExitRequired
        ? "STOP_LOSS"
        : latchedReason ??
      (profitCaptureHit
        ? "TAKE_PROFIT"
        : autonomyDecision.action === "AUTONOMOUS_CLOSE"
        ? autonomyDecision.reason === "TAKE_PROFIT"
          ? "TAKE_PROFIT"
          : autonomyDecision.reason === "TRAILING_PROTECTION"
            ? "TRAILING_STOP"
            : "STOP_LOSS"
        : evidenceRiskExecution?.action === "REDUCE_PARTIAL"
          ? "STOP_LOSS"
        : timeExitDue
          ? "TIME_EXIT"
          : null);
    const protectionDetectedAt = reason ? Date.now() : null;
    const liquidationGuardLevel = {
      index: plan.stopLosses.length,
      level: {
        triggerPercent: Math.max(0, -currentRoePercent),
        closePercent: 100,
        closeQuantity: position.quantity,
      },
      plannedQuantity: position.quantity,
    };
    const capitalPreservationStopLevel = {
      index: plan.stopLosses.length,
      level: {
        triggerPercent:
          capitalStop.triggerRoePercent ?? Math.max(0, -currentRoePercent),
        closePercent: 100,
        closeQuantity: position.quantity,
      },
      plannedQuantity: position.quantity,
    };
    const trailingProtectionLevel = {
      index: -1,
      level: {
        triggerPercent: Math.max(0, -currentRoePercent),
        closePercent:
          threeMinuteDynamicTrailingHit ||
          effectiveTailWaveExit?.action === "EXIT_NOW" ||
            dynamicTrailing.hit ||
            effectiveDynamicProfitReduction.action === "CLOSE_REMAINDER" ||
          postProfitProtection.hit
            ? 100
            : Math.min(
                99.999,
                position.quantity > 0
                  ? effectiveDynamicProfitReduction.requestedQuantity /
                    position.quantity * 100
                  : 0,
              ),
        closeQuantity:
          threeMinuteDynamicTrailingHit ||
          effectiveTailWaveExit?.action === "EXIT_NOW" ||
            dynamicTrailing.hit ||
            effectiveDynamicProfitReduction.action === "NONE"
            ? position.quantity
            : effectiveDynamicProfitReduction.requestedQuantity,
      },
      plannedQuantity: position.quantity,
    };
    const profitCaptureLevel = {
      index: -3,
      level: {
        triggerPercent: Math.max(0, currentRoePercent),
        closePercent: 100,
        closeQuantity: position.quantity,
      },
      plannedQuantity: position.quantity,
    };
    const threeMinuteDynamicStopLevel = {
      index: -4,
      level: {
        triggerPercent: Math.max(0, -currentRoePercent),
        closePercent: 100,
        closeQuantity: position.quantity,
      },
      plannedQuantity: position.quantity,
    };
    const evidenceRiskReductionLevel = {
      index: -2,
      level: {
        triggerPercent: Math.max(0, -currentRoePercent),
        closePercent: Math.max(
          1,
          Math.min(99, Number(evidenceRiskExecution?.reductionPercent) || 30),
        ),
        closeQuantity:
          position.quantity *
          Math.max(
            1,
            Math.min(
              99,
              Number(evidenceRiskExecution?.reductionPercent) || 30,
            ),
          ) /
          100,
      },
      plannedQuantity: position.quantity,
    };
    const levels = accountDrawdownExit
      ? [liquidationGuardLevel]
      : pairExitRequired
      ? [liquidationGuardLevel]
      : reason === "TIME_EXIT"
      ? [liquidationGuardLevel]
      : capitalStop.hit
      ? [capitalPreservationStopLevel]
      : latchedReason === "STOP_LOSS"
      ? pendingPlan.threeMinuteDynamicProtection
          ? [threeMinuteDynamicStopLevel]
        : evidenceRiskExecution?.action === "EXIT_FULL"
        ? [liquidationGuardLevel]
        : evidenceRiskExecution?.action === "REDUCE_PARTIAL"
          ? [evidenceRiskReductionLevel]
          : pendingIndexes.flatMap((index) =>
              plan.stopLosses[index]
                ? [{
                    index,
                    level: plan.stopLosses[index],
                    plannedQuantity: Number(
                      plan.stopLosses[index].closeQuantity ?? position.quantity,
                    ),
                  }]
                : []
            )
      : latchedReason === "TAKE_PROFIT"
        ? pendingPlan.profitCapture === true
          ? [profitCaptureLevel]
          : pendingIndexes.flatMap((index) =>
            plan.takeProfits[index]
              ? [{
                  index,
                  level: {
                    ...plan.takeProfits[index],
                    closeQuantity: remainingTakeProfitQuantity(
                      executed,
                      index,
                      Number(plan.takeProfits[index].closeQuantity ?? 0),
                    ),
                  },
                  plannedQuantity: Number(
                    plan.takeProfits[index].closeQuantity ?? 0,
                  ),
                }]
              : []
          )
        : latchedReason === "TRAILING_STOP"
          ? [trailingProtectionLevel]
            : reason === "STOP_LOSS"
            ? threeMinuteDynamicStopLossHit
              ? [threeMinuteDynamicStopLevel]
              : autonomyDecision.reason === "LIQUIDATION_PROXIMITY" ||
                structureExit
              ? [liquidationGuardLevel]
              : crossedStops.length > 0
                ? crossedStops
                : evidenceRiskExecution?.action === "REDUCE_PARTIAL"
                  ? [evidenceRiskReductionLevel]
                  : []
            : reason === "TAKE_PROFIT"
              ? profitCaptureHit || threeMinuteDynamicTakeProfitHit
                ? [profitCaptureLevel]
                : crossedTakes
              : reason === "TRAILING_STOP"
                ? [trailingProtectionLevel]
                : [];
    if (!reason) {
      if (position.pendingCloseClientOrderId) {
        // Preserve the original close-intent age. The independent reconciler
        // releases a Binance -2013 only after the intent has been stale for
        // 30 seconds. Refreshing updatedAt on every five-second heartbeat
        // resets that clock forever and permanently blocks close retries.
        await db.update(livePositions).set({
          markPrice,
          favorablePrice,
          marketMicrostructureJson: JSON.stringify({
            facts: marketMicrostructure,
            protection: microstructureProtection,
            entryProbe,
          }),
          riskLeaseUntil: null,
          lastError:
            "发现旧版自动减仓意图，系统已禁止继续提交并保留订单号等待核对",
        }).where(eq(livePositions.id, position.id));
        continue;
      }
      // No deterministic close trigger: persist the fresh mark and release
      // the lease only. Intelligent addition runs on mode=intelligence and
      // must not delay or destabilize the five-second close loop.
      await db.update(livePositions).set({
        markPrice,
        favorablePrice,
        marketMicrostructureJson: JSON.stringify({
          facts: marketMicrostructure,
          protection: microstructureProtection,
          entryProbe,
        }),
        executedRiskPlanJson: JSON.stringify(executed),
        riskLeaseUntil: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(livePositions.id, position.id));
      try {
        await appendStrategyProfitProtectionActivation({
          positionId: position.id,
          symbol: position.symbol,
          positionSide: position.positionSide,
          currentRoePercent,
          previous: previousExecuted,
          current: executed,
        });
      } catch {
        // 阶段展示日志失败不能阻塞五秒实盘保护循环。
      }
      continue;
    }

    const closesAll = levels.some(({ level }) => level.closePercent >= 100);
    const plannedQuantity = closesAll ? position.quantity : levels.reduce((sum, { level }) => sum + Number(level.closeQuantity ?? 0), 0);
    const dynamicPartialReduction =
      reason === "TRAILING_STOP" &&
      effectiveDynamicProfitReduction.action === "PARTIAL";
    const requestedCloseQuantity = Math.min(
      position.quantity,
      dynamicPartialReduction
        ? Math.max(
            positionSymbolRule.minOrderQty,
            latchedReason && Number(position.pendingCloseQuantity) > 0
              ? Number(position.pendingCloseQuantity)
              : plannedQuantity,
          )
        : latchedReason && Number(position.pendingCloseQuantity) > 0
          ? Number(position.pendingCloseQuantity)
          : plannedQuantity,
    );
    const normalizedCloseQuantity = evidenceRiskExecution?.action === "REDUCE_PARTIAL"
      ? normalizePartialReduceQuantity({
          requestedQuantity: requestedCloseQuantity,
          positionQuantity: position.quantity,
          minimum: positionSymbolRule.minOrderQty,
          step: positionSymbolRule.quantityStep,
        })
      : normalizeReduceQuantity({
      requestedQuantity: requestedCloseQuantity,
      positionQuantity: position.quantity,
      minimum: positionSymbolRule.minOrderQty,
      step: positionSymbolRule.quantityStep,
        });
    const closeQuantity = promoteReduceQuantityForMinNotional({
      normalizedCloseQuantity,
      positionQuantity: position.quantity,
      markPrice,
      minNotionalUsdt: positionSymbolRule.minNotionalUsdt,
      step: positionSymbolRule.quantityStep,
    });
    const quantityTolerance = quantityStepTolerance(
      positionSymbolRule.quantityStep,
    );
    const executionAdjustment =
      Number.isFinite(normalizedCloseQuantity) &&
        Number.isFinite(closeQuantity) &&
        closeQuantity > normalizedCloseQuantity + quantityTolerance &&
        closeQuantity >= position.quantity - quantityTolerance
        ? {
            version: "nexus-reduction-execution-adjustment-v1",
            code: "MIN_NOTIONAL_PROMOTED_FULL_CLOSE",
            requestedCloseQuantity,
            normalizedCloseQuantity,
            effectiveCloseQuantity: closeQuantity,
            positionQuantity: position.quantity,
            markPrice,
            minNotionalUsdt: positionSymbolRule.minNotionalUsdt,
            quantityStep: positionSymbolRule.quantityStep,
          }
        : null;
    // 数量或名义价值规则无法继续拆分时，统一把本档提升为整仓退出。
    // 保护触发后不能永久保留 Binance 无法继续交易的碎片尾仓。
    if (!Number.isFinite(closeQuantity) || closeQuantity <= 0) {
      const message = evidenceRiskExecution?.action === "REDUCE_PARTIAL"
        ? "证据恶化减险受 Binance 最小量/步长限制，本轮不能保留可交易余仓；等待明确失效或既定保护触发"
        : "触发后的减仓数量无效";
      if (evidenceRiskExecution?.action !== "REDUCE_PARTIAL") errors += 1;
      await db.update(livePositions).set({
        riskLeaseUntil: null,
        lastError: message,
        updatedAt: new Date(),
      }).where(eq(livePositions.id, position.id));
      continue;
    }
    let takeProfitSubmissionGuard: TakeProfitExecutionGuard | null = null;
    let profitReductionSubmissionGuard:
      | ProfitReductionExecutionGuard
      | null = null;
    let preSubmitExecutablePrice: number | null = null;
    let executionBookDepth: { bidQuantity: number; askQuantity: number } | null = null;
    if (reason === "TAKE_PROFIT" && !position.pendingCloseClientOrderId) {
      const triggerRoePercent = Math.min(
        ...levels.map(({ level }) => Number(level.triggerPercent)).filter(Number.isFinite),
      );
      try {
        const book = await waitForFreshNexusBookTicker(position.symbol, 500, 50);
        const executablePrice = position.positionSide === "LONG"
          ? book.bidPrice
          : book.askPrice;
        preSubmitExecutablePrice = executablePrice;
        executionBookDepth = {
          bidQuantity: book.bidQuantity,
          askQuantity: book.askQuantity,
        };
        takeProfitSubmissionGuard = evaluateTakeProfitExecution({
          positionSide: position.positionSide,
          entryPrice: position.entryPrice,
          executablePrice,
          leverage: position.leverage,
          quantity: closeQuantity,
          triggerRoePercent,
          estimatedFundingCostRate: adverseFundingCostRate({
            direction: position.positionSide,
            fundingRate: markSnapshot.fundingRate,
          }),
        });
        if (!takeProfitSubmissionGuard.eligible) {
          if (takeProfitSubmissionGuard.mergeRecommended)
            Object.assign(
              executed,
              recordTakeProfitDeferral({
                progress: executed,
                levels: levels.map((item) => ({
                  index: item.index,
                  triggerRoePercent: Number(item.level.triggerPercent),
                  plannedQuantity: item.plannedQuantity,
                })),
                observedAtMs: Date.now(),
                guard: takeProfitSubmissionGuard,
              }),
            );
          await db.update(livePositions).set({
            markPrice,
            favorablePrice,
            executedRiskPlanJson: JSON.stringify(executed),
            riskLeaseUntil: null,
            lastError:
              `${takeProfitSubmissionGuard.reason}；本轮不提交市价止盈，止盈网格未消耗`,
            updatedAt: new Date(),
          }).where(eq(livePositions.id, position.id));
          continue;
        }
      } catch (error) {
        await db.update(livePositions).set({
          markPrice,
          favorablePrice,
          riskLeaseUntil: null,
          lastError:
            `止盈触发后盘口复核失败：${error instanceof Error ? error.message : "盘口不可用"}；本轮不提交，止盈网格未消耗`,
          updatedAt: new Date(),
        }).where(eq(livePositions.id, position.id));
        continue;
      }
    }
    if (
      reason === "TRAILING_STOP" &&
      dynamicPartialReduction &&
      !closesAll &&
      !position.pendingCloseClientOrderId
    ) {
      try {
        const book = await waitForFreshNexusBookTicker(
          position.symbol,
          500,
          50,
        );
        const executablePrice = position.positionSide === "LONG"
          ? book.bidPrice
          : book.askPrice;
        preSubmitExecutablePrice = executablePrice;
        executionBookDepth = {
          bidQuantity: book.bidQuantity,
          askQuantity: book.askQuantity,
        };
        profitReductionSubmissionGuard =
          evaluateProfitReductionExecution({
            positionSide: position.positionSide,
            entryPrice: position.entryPrice,
            executablePrice,
            quantity: closeQuantity,
            estimatedFundingCostRate: adverseFundingCostRate({
              direction: position.positionSide,
              fundingRate: markSnapshot.fundingRate,
            }),
          });
        if (!profitReductionSubmissionGuard.eligible) {
          await db.update(livePositions).set({
            markPrice,
            favorablePrice,
            executedRiskPlanJson: JSON.stringify(executed),
            riskLeaseUntil: null,
            lastError:
              `${profitReductionSubmissionGuard.reason}；本轮不制造移动止损碎片单，费用保护线与结构失效整仓退出仍然有效`,
            updatedAt: new Date(),
          }).where(eq(livePositions.id, position.id));
          continue;
        }
      } catch (error) {
        await db.update(livePositions).set({
          markPrice,
          favorablePrice,
          riskLeaseUntil: null,
          lastError:
            `移动保护部分减仓的盘口复核失败：${error instanceof Error ? error.message : "盘口不可用"}；本轮不提交，硬保护不受影响`,
          updatedAt: new Date(),
        }).where(eq(livePositions.id, position.id));
        continue;
      }
    }
    const clientOrderId = position.pendingCloseClientOrderId ?? `nqc_${position.id}_${Date.now().toString(36)}`.slice(0, 36);
    if (!position.pendingCloseClientOrderId) {
      const [intentLatched] = await db.update(livePositions).set({
        pendingCloseClientOrderId: clientOrderId,
        pendingCloseReason: reason,
        pendingCloseQuantity: closeQuantity,
        executedRiskPlanJson: JSON.stringify(executed),
        pendingClosePlanJson: JSON.stringify({
          indexes: levels.map((item) => item.index),
          profitCapture:
            profitCaptureHit || threeMinuteDynamicTakeProfitHit,
          threeMinuteDynamicProtection:
            threeMinuteDynamicProtection?.action !== "NONE"
              ? threeMinuteDynamicProtection
              : null,
          structureExit,
          entryProbe,
          accountDrawdownExit,
          autonomousTrigger:
            autonomyDecision.action === "AUTONOMOUS_CLOSE"
              ? autonomyDecision.reason
              : null,
          positionVersion: position.positionVersion,
          protectionVersion: position.protectionVersion,
          positionManagement: positionManagementReference,
          dynamicProfitReduction:
            reason === "TRAILING_STOP"
              ? effectiveDynamicProfitReduction
              : null,
          profitReductionEconomics: profitReductionSubmissionGuard,
          tailWaveExit:
            reason === "TRAILING_STOP"
              ? effectiveTailWaveExit
              : null,
          evidenceRisk: evidenceRiskExecution,
          relativeStrengthPairLifecycle,
          executionAdjustment,
          marketMicrostructure,
          microstructureProtection,
        }),
        updatedAt: new Date(),
      }).where(and(
        eq(livePositions.id, position.id),
        eq(livePositions.status, "OPEN"),
        eq(livePositions.positionVersion, position.positionVersion),
        eq(livePositions.protectionVersion, position.protectionVersion),
        eq(livePositions.riskLeaseUntil, leaseUntil),
        isNull(livePositions.pendingCloseClientOrderId),
      )).returning({ id: livePositions.id });
      if (!intentLatched) {
        await db.update(livePositions).set({
          riskLeaseUntil: null,
          lastError: "仓位或保护版本已变化，旧风控任务已取消",
          updatedAt: new Date(),
        }).where(eq(livePositions.id, position.id));
        continue;
      }
    }

    let orderAccepted = false;
    try {
      const [credential, account] = await Promise.all([
        db.select().from(exchangeCredentials).where(and(eq(exchangeCredentials.id, position.credentialId), eq(exchangeCredentials.ownerEmail, position.ownerEmail))).limit(1).then((rows) => rows[0]),
        db.select().from(tradingAccounts).where(and(eq(tradingAccounts.ownerEmail, position.ownerEmail), eq(tradingAccounts.accountId, position.accountId))).limit(1).then((rows) => rows[0]),
      ]);
      const symbolRule = positionSymbolRule;
      if (!credential) throw new Error("实盘密钥不存在，无法执行保护性减仓");
      if (!account) throw new Error("实盘子账户记录不存在，无法核对仓位归属");
      const keys = { apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(position.ownerEmail, position.accountId, "api-key")), secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(position.ownerEmail, position.accountId, "secret-key")) };
      const riskPlan = asRecord(position.riskPlanJson);
      await observeExecutionQuote({
        recordKey: `EXIT:${clientOrderId}`,
        quoteRole: "EXIT",
        positionId: position.id,
        clientOrderId,
        ownerEmail: position.ownerEmail,
        accountId: position.accountId,
        strategyId: Number(riskPlan.strategyId) || null,
        traceId: typeof riskPlan.traceId === "string" ? riskPlan.traceId : null,
        origin: riskPlan.orderOrigin === "MANUAL"
          ? "MANUAL"
          : position.positionSide === "LONG"
            ? "STRATEGY_LONG"
            : "STRATEGY_SHORT",
        symbol: position.symbol,
        side: position.positionSide === "LONG" ? "SELL" : "BUY",
        positionSide: position.positionSide,
        actualOrderType: "MARKET",
        actualRequestedPrice: preSubmitExecutablePrice ?? markPrice,
        decisionMarkPrice: markPrice,
        executableReferencePrice: preSubmitExecutablePrice ?? markPrice,
        priceTickSize: symbolRule.priceTickSize,
        atr5m: Number(riskPlan.atr5m) || null,
        bestBidQuantity: executionBookDepth?.bidQuantity ?? null,
        bestAskQuantity: executionBookDepth?.askQuantity ?? null,
        orderHorizonSeconds: 5,
        urgency: reason === "TAKE_PROFIT" ? 0.65 : reason === "STOP_LOSS" ? 1 : 0.9,
        prospectiveNotionalUsdt: closeQuantity * markPrice,
      });
      const orderSubmitStartedAt = Date.now();
      const result = await submitLiveReduceMarketOrder(keys, {
        symbol: position.symbol,
        positionSide: position.positionSide,
        quantity: closeQuantity,
        quantityStep: symbolRule.quantityStep,
        clientOrderId,
      });
      const orderAcknowledgedAt = Date.now();
      orderAccepted = true;
      const executedQuantity = Number(result.data.executedQty) || result.requestedQuantity;
      // Binance 市价单确认回执经常暂时返回 avgPrice=0。保护链路仍可用
      // 触发标记价完成即时仓位核算，但绝不能把该估算值伪装成真实成交价。
      // 真实成交均价由异步 userTrades 核对后回填。
      const acknowledgedExitPrice = Number(result.data.avgPrice) > 0
        ? Number(result.data.avgPrice)
        : null;
      const exitPrice = acknowledgedExitPrice ?? markPrice;
      const localGrossRealizedPnl = position.positionSide === "LONG" ? (exitPrice - position.entryPrice) * executedQuantity : (position.entryPrice - exitPrice) * executedQuantity;
      const remainingQuantity = subtractOrderQuantity(
        position.quantity,
        executedQuantity,
        symbolRule.quantityStep,
      );
      if (!Number.isFinite(remainingQuantity))
        throw new Error("保护性减仓已成交，但剩余数量无法按 Binance 步长核算");
      const closed = remainingQuantity <= 1e-12;
      const closedAt = new Date();
      // Persist the acknowledged reduction before any optional fee/funding
      // lookup. Exact settlement is repaired asynchronously by the account
      // audit plane and must never delay the five-second protection heartbeat.
      const settlement = buildReductionSettlement({
        localGrossRealizedPnl,
        executedQuantity,
        entryOrderQuantity: null,
        entryTrades: [],
        exitTrades: [],
        fundingAttribution: closed ? "UNAVAILABLE" : "NOT_REQUESTED_PARTIAL",
      });
      const realizedPnl = settlement.grossRealizedPnl;
      const cumulativeRealizedPnl = position.realizedPnl + realizedPnl;
      const takeProfitFillGuard = reason === "TAKE_PROFIT"
        ? takeProfitFillConsumesGrid({
            positionSide: position.positionSide,
            entryPrice: position.entryPrice,
            exitPrice,
            leverage: position.leverage,
            quantity: executedQuantity,
            triggerRoePercent: Math.min(
              ...levels.map(({ level }) => Number(level.triggerPercent)).filter(Number.isFinite),
            ),
          })
        : null;
      if (reason === "TAKE_PROFIT" && takeProfitFillGuard?.eligible) {
        Object.assign(
          executed,
          applyTakeProfitExecution({
            progress: executed,
            levels: levels.map((item) => ({
              index: item.index,
              plannedQuantity: item.plannedQuantity,
            })),
            executedQuantity,
          }),
        );
        Object.assign(
          executed,
          recordVerifiedTakeProfitExecution({
            progress: executed,
            executedQuantity,
            executedAtMs: closedAt.getTime(),
          }),
        );
      }
      if (reason === "STOP_LOSS" && !evidenceRiskExecution)
        Object.assign(
          executed,
          applyStopLossExecution({
            progress: executed,
            indexes: levels.map((item) => item.index),
          }),
        );
      if (
        reason === "STOP_LOSS" &&
        evidenceRiskExecution?.action === "REDUCE_PARTIAL"
      )
        Object.assign(
          executed,
          applyEvidenceRiskReductionExecution({
            progress: executed,
            executedQuantity,
            reductionPercent: evidenceRiskExecution.reductionPercent,
            executedAtMs: closedAt.getTime(),
            opportunityId: evidenceRiskExecution.opportunityId,
          }),
        );
      if (
        reason === "TRAILING_STOP" &&
        effectiveDynamicProfitReduction.stage > 0
      ) Object.assign(
        executed,
        applyDynamicProfitReductionExecution({
          progress: executed,
          stage: effectiveDynamicProfitReduction.stage,
          anchorQuantity: effectiveDynamicProfitReduction.anchorQuantity,
          executedQuantity,
          triggerRoePercent: currentRoePercent,
          executedAtMs: closedAt.getTime(),
        }),
      );
      const nextPositionVersion = position.positionVersion + 1;
      const nextProtectionVersion = position.protectionVersion + 1;
      const reductionProtection = closed
        ? null
        : rebuildProtectionAfterReduction({
            riskPlanJson: position.riskPlanJson,
            executedRiskPlanJson: JSON.stringify(executed),
            remainingQuantity,
            minOrderQty: symbolRule.minOrderQty,
            quantityStep: symbolRule.quantityStep,
            trailingStopPercent: position.trailingStopPercent,
            nextPositionVersion,
            nextProtectionVersion,
            nowMs: closedAt.getTime(),
            source: "AUTO_REDUCTION",
          });
      const markSnapshot = markBySymbol.get(position.symbol);
      const resultMetadata = asRecord(result.data);
      const exchangeUpdateTime = Number(
        resultMetadata.updateTime ?? resultMetadata.transactTime,
      );
      const reductionRecordedAt = Date.now();
      const protectionTiming = {
        version: "nexus-protection-timing-v1",
        riskCycleStartedAt,
        markEventAt: markSnapshot?.time ?? null,
        markReceivedAt: markSnapshot?.receivedAt ?? null,
        protectionDetectedAt,
        orderSubmitStartedAt,
        orderAcknowledgedAt,
        exchangeUpdateTime:
          Number.isFinite(exchangeUpdateTime) && exchangeUpdateTime > 0
            ? exchangeUpdateTime
            : null,
        reductionRecordedAt,
        markAgeAtDecisionMs:
          protectionDetectedAt && markSnapshot?.time
            ? Math.max(0, protectionDetectedAt - markSnapshot.time)
            : null,
        decisionToAcknowledgementMs: protectionDetectedAt
          ? Math.max(0, orderAcknowledgedAt - protectionDetectedAt)
          : null,
        submissionRoundTripMs: Math.max(
          0,
          orderAcknowledgedAt - orderSubmitStartedAt,
        ),
        exchangeToLocalRecordMs:
          Number.isFinite(exchangeUpdateTime) && exchangeUpdateTime > 0
            ? Math.max(0, reductionRecordedAt - exchangeUpdateTime)
            : null,
        reduceExecution: result.executionTiming,
      };
      const executionAudit = {
        version: "nexus-protection-execution-audit-v1",
        reason,
        positionSide: position.positionSide,
        leverage: position.leverage,
        triggerMarkPrice: markPrice,
        preSubmitExecutablePrice,
        acknowledgedExitPrice,
        acknowledgedExitPriceSource: acknowledgedExitPrice !== null
          ? "ORDER_ACK_AVG_PRICE"
          : "PENDING_BINANCE_USER_TRADES",
        provisionalExitPrice: exitPrice,
        provisionalExitPriceSource: acknowledgedExitPrice !== null
          ? "ORDER_ACK_AVG_PRICE"
          : "TRIGGER_MARK_PRICE_FALLBACK",
        positionQuantityBefore: position.quantity,
        requestedCloseQuantity,
        normalizedCloseQuantity,
        effectiveCloseQuantity: closeQuantity,
        executionAdjustment,
        executedQuantity,
        profitReductionEconomics: profitReductionSubmissionGuard,
      };
      await recordLivePositionReduction({
        positionId: position.id,
        lifecycleId: position.lifecycleId,
        ownerEmail: position.ownerEmail,
        accountId: position.accountId,
        clientOrderId,
        exchangeOrderId: String(result.data.orderId),
        symbol: position.symbol,
        positionSide: position.positionSide,
        quantity: executedQuantity,
        exitPrice,
        realizedPnl,
        reason,
        responseJson: JSON.stringify({
          ...attachReductionSettlement(result.data, settlement),
          structureExit,
          evidenceRisk: evidenceRiskExecution,
          executionAdjustment,
          protectionTrigger:
            threeMinuteDynamicProtection?.action === "TAKE_PROFIT"
              ? "THREE_MINUTE_DYNAMIC_PROFIT_TARGET"
              : threeMinuteDynamicProtection?.action === "TRAILING_STOP"
                ? "THREE_MINUTE_LOCKED_PROFIT_FLOOR"
              : threeMinuteDynamicProtection?.action === "STOP_LOSS"
                ? threeMinuteDynamicProtection.reasonCode ===
                    "HARD_STOP_REACHED"
                  ? "THREE_MINUTE_HARD_STOP"
                  : "THREE_MINUTE_LOCKED_LOSS_FLOOR"
            : evidenceRiskExecution?.action === "REDUCE_PARTIAL"
              ? "EVIDENCE_RISK_PARTIAL_REDUCTION"
              : evidenceRiskExecution?.action === "EXIT_FULL"
                ? "EVIDENCE_RISK_FULL_EXIT"
            : accountDrawdownExit?.phase === "HARD_STOP"
              ? "ACCOUNT_EQUITY_HARD_STOP"
              : accountDrawdownExit?.phase === "DEFENSIVE"
                ? "ACCOUNT_EQUITY_DEFENSIVE_EXIT"
              : pairExitRequired
              ? "RELATIVE_STRENGTH_PAIR_LEG_IMBALANCE"
              : capitalStop.hit
                ? "CAPITAL_PRESERVATION_HARD_STOP"
              : structureExit
                ? "ENTRY_THESIS_INVALIDATION"
                : reason,
          relativeStrengthPairLifecycle,
          accountDrawdownExit,
          positionManagement: positionManagementReference,
          takeProfitSubmissionGuard,
          profitReductionSubmissionGuard,
          takeProfitExecutionGuard: takeProfitFillGuard,
          takeProfitGridConsumed:
            reason !== "TAKE_PROFIT" || takeProfitFillGuard?.eligible === true,
          dynamicProfitReduction:
            reason === "TRAILING_STOP" &&
              effectiveDynamicProfitReduction.stage > 0
              ? {
                  ...effectiveDynamicProfitReduction,
                  softActivationRuleVersion:
                    executed.dynamicProfitReduction
                      ?.softActivationRuleVersion ?? null,
                  softActivatedAtMs:
                    executed.dynamicProfitReduction?.softActivatedAtMs ?? null,
                  softActivationRoePercent:
                    executed.dynamicProfitReduction
                      ?.softActivationRoePercent ?? null,
                }
              : null,
          threeMinuteDynamicProtection,
          tailWaveExit:
            reason === "TRAILING_STOP"
              ? effectiveTailWaveExit
              : null,
          marketMicrostructure,
          microstructureProtection,
          _nexusExecutionAudit: executionAudit,
          _nexusTiming: protectionTiming,
        }),
        createdAt: new Date(),
      }, { idempotent: false });
      await db.update(livePositions).set({
        quantity: closed ? executedQuantity : remainingQuantity,
        markPrice,
        favorablePrice,
        marketMicrostructureJson: JSON.stringify({
          facts: marketMicrostructure,
          protection: microstructureProtection,
          entryProbe,
        }),
        riskPlanJson: reductionProtection
          ? JSON.stringify(reductionProtection.plan)
          : position.riskPlanJson,
        executedRiskPlanJson: JSON.stringify(
          reductionProtection?.executed ?? executed,
        ),
        positionVersion: closed
          ? position.positionVersion
          : nextPositionVersion,
        protectionVersion: closed
          ? position.protectionVersion
          : nextProtectionVersion,
        protectionState: closed ? position.protectionState : "ACTIVE",
        protectionUpdatedAt: closed ? position.protectionUpdatedAt : closedAt,
        status: closed ? "CLOSED" : "OPEN",
        exitReason: closed ? reason : null,
        realizedPnl: cumulativeRealizedPnl,
        closedAt: closed ? closedAt : null,
        riskLeaseUntil: null,
        pendingCloseClientOrderId: null,
        pendingCloseReason: null,
        pendingCloseQuantity: null,
        pendingClosePlanJson: null,
        lastError:
          reason === "TAKE_PROFIT" && !takeProfitFillGuard?.eligible
            ? `${takeProfitFillGuard?.reason ?? "止盈成交未通过实际收益复核"}；未消耗止盈网格`
            : null,
        updatedAt: new Date(),
      }).where(and(eq(livePositions.id, position.id), eq(livePositions.positionVersion, position.positionVersion), eq(livePositions.protectionVersion, position.protectionVersion), eq(livePositions.pendingCloseClientOrderId, clientOrderId)));
      try {
        await appendStrategyProfitProtectionActivation({
          positionId: position.id,
          symbol: position.symbol,
          positionSide: position.positionSide,
          currentRoePercent,
          previous: previousExecuted,
          current: executed,
        });
      } catch {
        // 保护已成交；日志失败只影响运营可解释性。
      }
      try {
        await recordPositionManagementReductionOutcome({
          reference: positionManagementReference,
          reason,
          structureExit,
          clientOrderId,
          exchangeOrderId: String(result.data.orderId),
          quantity: executedQuantity,
          exitPrice,
          remainingQuantity,
          closed,
        });
      } catch {
        // 真实减仓已确认；学习闭环回写失败不得反向改变成交与仓位状态。
      }
      await writeAudit({ email: position.ownerEmail, accountId: position.accountId }, "LIVE_POSITION_RISK_REDUCE", "live_position", String(position.id), { symbol: position.symbol, positionSide: position.positionSide, reason, markPrice, currentRoePercent, favorablePrice, favorableRoePercent, trailingTriggerRoePercent, trailingPrice, dynamicTrailing, dynamicProfitReduction: effectiveDynamicProfitReduction, threeMinuteDynamicProtection, postProfitProtection, structureExit, relativeStrengthPairLifecycle, accountDrawdownExit, executionAdjustment, marketMicrostructure, microstructureProtection, quantity: executedQuantity, remainingQuantity, exchangeOrderId: result.data.orderId, protectionTiming, protectionRebalanced: Boolean(reductionProtection), takeProfitGrids: reductionProtection?.takeProfitGrids ?? null, stopLossGrids: reductionProtection?.stopLossGrids ?? null });
      triggered += 1;
    } catch (error) {
      const unknown = orderAccepted || (error instanceof BinanceLiveError && error.executionUnknown);
      const missing = error instanceof BinanceLiveError && error.code === LOCAL_POSITION_MISSING_CODE;
      const retryable = !unknown && !missing && error instanceof BinanceLiveError && [429, 503].includes(error.status);
      const retainIntent = unknown || retryable;
      if (missing) {
        try {
          const [credential] = await db.select().from(exchangeCredentials).where(and(
            eq(exchangeCredentials.id, position.credentialId),
            eq(exchangeCredentials.ownerEmail, position.ownerEmail),
          )).limit(1);
          if (!credential) throw new Error("实盘密钥不存在，无法同步缺失仓位收益");
          const keys = {
            apiKey: await decryptCredential(credential.apiKeyCiphertext, credential.apiKeyIv, credentialContext(position.ownerEmail, position.accountId, "api-key")),
            secretKey: await decryptCredential(credential.secretKeyCiphertext, credential.secretKeyIv, credentialContext(position.ownerEmail, position.accountId, "secret-key")),
          };
          await reconcileMissingLocalPosition(
            position,
            credential,
            keys,
            writeAudit,
          );
          reconciledMissing += 1;
          continue;
        } catch (reconcileError) {
          errors += 1;
          await db.update(livePositions).set({
            status: "CLOSED",
            exitReason: "EXTERNAL",
            closedAt: new Date(),
            riskLeaseUntil: null,
            pendingCloseClientOrderId: null,
            pendingCloseReason: null,
            pendingCloseQuantity: null,
            pendingClosePlanJson: null,
            lastError: `Binance 当前方向仓位为 0；收益同步失败：${reconcileError instanceof Error ? reconcileError.message : "未知错误"}`,
            updatedAt: new Date(),
          }).where(eq(livePositions.id, position.id));
          continue;
        }
      }
      errors += 1;
      await db.update(livePositions).set({
        status: unknown ? "EXECUTION_UNKNOWN" : missing ? "CLOSED" : "OPEN",
        exitReason: missing ? "EXTERNAL" : null,
        closedAt: missing ? new Date() : null,
        riskLeaseUntil: null,
        pendingCloseClientOrderId: retainIntent ? clientOrderId : null,
        pendingCloseReason: retainIntent ? reason : null,
        pendingCloseQuantity: retainIntent ? closeQuantity : null,
        pendingClosePlanJson: retainIntent
          ? JSON.stringify({
              indexes: levels.map((item) => item.index),
              structureExit,
              accountDrawdownExit,
              dynamicProfitReduction:
                reason === "TRAILING_STOP"
                  ? effectiveDynamicProfitReduction
                  : null,
              relativeStrengthPairLifecycle,
            })
          : null,
        lastError:
          error instanceof Error ? error.message : "实盘自动减仓失败",
        updatedAt: new Date(),
      }).where(eq(livePositions.id, position.id));
      await writeAudit({ email: position.ownerEmail, accountId: position.accountId }, unknown ? "LIVE_RISK_EXECUTION_UNKNOWN" : "LIVE_RISK_EXECUTION_FAILED", "live_position", String(position.id), { clientOrderId, symbol: position.symbol, reason, accountDrawdownExit, error: error instanceof Error ? error.message : "未知错误" });
    }
  }
  return Response.json({ checked, triggered, errors, backgroundErrors, maintenance, scheduledBalanceRefreshes, reconciledUnknown, reconciledMissing, protectionModeNormalization, protectionCertification, protectionWork: { maintenanceBudget: POSITION_PROTECTION_MAINTENANCE_BUDGET_PER_CYCLE, selected: protectionWorkSelection.selectedIds.length, priority: protectionWorkSelection.priorityIds.length, maintenance: protectionWorkSelection.maintenanceIds.length, total: candidates.length }, positionIntelligence: { budget: POSITION_INTELLIGENCE_BUDGET_PER_CYCLE, selected: 0, total: candidates.length }, ...isolatedMaintenanceWork, positionAdditionReconciliation, fullAccountPositionReconciliation, privateOrderReconciliation, executionIntentReconciliation, unknownEntryOrderReconciliation, checkedAt: new Date().toISOString() });
}

async function refreshOneCurrentStrategyLearningSnapshot(now: Date) {
  const deferred = (reason: string) => ({
    refreshed: 0,
    errors: 0,
    deferred: true,
    reason,
  });
  if (now.getTime() < nextStrategyLearningRefreshAt)
    return deferred("REFRESH_INTERVAL");
  nextStrategyLearningRefreshAt =
    now.getTime() + STRATEGY_LEARNING_REFRESH_INTERVAL_MS;
  try {
    const trace = await loadNextTerminalLearningCandidate(200);
    if (!trace) return deferred("NO_TERMINAL_LEARNING_BACKLOG");
    const refresh = await refreshStrategyParameterSuggestions(trace, {
      durableBacklog: true,
    });
    if (!refresh?.refreshed)
      return deferred(refresh?.reason ?? "LEARNING_REFRESH_IN_FLIGHT");
    const finalizedObservations =
      await finalizeNexusFastLearningObservation(trace.traceId);
    return {
      refreshed: 1,
      finalizedObservations,
      errors: 0,
      deferred: false,
      strategyId: trace.strategyId,
      configVersion: trace.configVersion,
      traceId: trace.traceId,
    };
  } catch (error) {
    return {
      refreshed: 0,
      errors: 1,
      deferred: true,
      reason:
        error instanceof Error
          ? `LEARNING_REFRESH_FAILED:${error.message}`
          : "LEARNING_REFRESH_FAILED",
    };
  }
}

async function backfillEntryMarketPositionEvidence(now: Date) {
  const deferred = (reason: string, errors = 0) => ({
    updated: 0,
    errors,
    deferred: true,
    reason,
  });
  const db = getDb();
  let metrics;
  try {
    metrics = await getBinanceLiveSystemMetrics();
  } catch {
    return deferred("SYSTEM_METRICS_UNAVAILABLE", 1);
  }
  const remainingWeight = projectRemainingRestWeight(metrics.rest);
  if (!Number.isFinite(remainingWeight) || remainingWeight < 200)
    return deferred("REST_WEIGHT_RESERVED");
  const traces = await db
    .select({
      id: strategyExecutionTraces.id,
      traceId: strategyExecutionTraces.traceId,
      positionId: strategyExecutionTraces.positionId,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.state, "POSITION_OPEN"),
        isNotNull(strategyExecutionTraces.positionId),
      ),
    )
    .orderBy(desc(strategyExecutionTraces.id))
    .limit(100);
  const target = traces.find((trace) => {
    const evidence = asRecord(parseJson(trace.entryEvidenceJson));
    return (
      !Number.isFinite(Number(evidence.position72hPercent)) ||
      evidence.hours72Complete !== true
    );
  });
  if (!target?.positionId)
    return deferred("NO_MISSING_ENTRY_MARK_POSITION");
  const positionId = Number(target.positionId);
  const [position] = Number.isInteger(positionId)
    ? await db
        .select()
        .from(livePositions)
        .where(eq(livePositions.id, positionId))
        .limit(1)
    : [];
  if (!position)
    return deferred("POSITION_SOURCE_MISSING");
  const entryEvidence = asRecord(parseJson(target.entryEvidenceJson));
  const explorationObservation = asRecord(
    entryEvidence.explorationPreEntryObservation,
  );
  const executionMarkPrice =
    Number(explorationObservation.executionMarkPrice) > 0
      ? Number(explorationObservation.executionMarkPrice)
      : position.entryPrice;
  const openedAtMs = position.openedAt.getTime();
  let candles;
  try {
    candles = await getBinanceLiveMarkPriceKlinesRange(
      position.symbol,
      "1h",
      openedAtMs - 73 * 60 * 60_000,
      openedAtMs,
      100,
    );
  } catch {
    return {
      ...deferred("ENTRY_MARK_POSITION_KLINES_UNAVAILABLE", 1),
      positionId: position.id,
      traceId: target.traceId,
    };
  }
  const closedCandles = candles.filter(
    (candle) => candle.closeTime <= openedAtMs,
  );
  const entryMarkPosition = analyzeMarkPricePosition(
    executionMarkPrice,
    closedCandles,
  );
  if (
    !entryMarkPosition.hours72Complete ||
    !Number.isFinite(entryMarkPosition.position72hPercent)
  )
    return {
      ...deferred("ENTRY_MARK_POSITION_INCOMPLETE"),
      positionId: position.id,
      traceId: target.traceId,
    };
  await db
    .update(strategyExecutionTraces)
    .set({
      entryEvidenceJson: JSON.stringify({
        ...entryEvidence,
        ...entryMarkPosition,
        entryMarkPositionSource:
          "HISTORICAL_MARK_PRICE_1H_BACKFILL_AT_FILL_TIME",
        entryMarkPositionCapturedAt: now.toISOString(),
      }),
      updatedAt: now,
    })
    .where(eq(strategyExecutionTraces.id, target.id));
  await writeAudit(
    { email: position.ownerEmail, accountId: position.accountId },
    "ENTRY_MARK_POSITION_EVIDENCE_BACKFILLED",
    "strategy_execution_trace",
    target.traceId,
    {
      positionId: position.id,
      symbol: position.symbol,
      position24hPercent: entryMarkPosition.position24hPercent,
      position72hPercent: entryMarkPosition.position72hPercent,
      source: "HISTORICAL_MARK_PRICE_1H_BACKFILL_AT_FILL_TIME",
    },
  );
  return {
    updated: 1,
    errors: 0,
    deferred: false,
    positionId: position.id,
    traceId: target.traceId,
  };
}

async function backfillEntryStructureEvidence(
  now: Date,
  openPositionIds?: number[],
) {
  const deferred = (reason: string, errors = 0) => ({
    updated: 0,
    errors,
    deferred: true,
    reason,
    positionId: null as number | null,
    traceId: null as string | null,
  });
  const db = getDb();
  let metrics;
  try {
    metrics = await getBinanceLiveSystemMetrics();
  } catch {
    return deferred("SYSTEM_METRICS_UNAVAILABLE", 1);
  }
  const remainingWeight = projectRemainingRestWeight(metrics.rest);
  if (!Number.isFinite(remainingWeight) || remainingWeight < 200)
    return deferred("REST_WEIGHT_RESERVED");
  const eligiblePositionIds = new Set(
    openPositionIds ??
      (await db
        .select({ id: livePositions.id })
        .from(livePositions)
        .where(eq(livePositions.status, "OPEN")))
        .map((position) => position.id),
  );
  if (!eligiblePositionIds.size)
    return deferred("NO_OPEN_POSITION");
  const traces = await db
    .select({
      id: strategyExecutionTraces.id,
      traceId: strategyExecutionTraces.traceId,
      positionId: strategyExecutionTraces.positionId,
      eventTime: strategyExecutionTraces.eventTime,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.state, "POSITION_OPEN"),
        isNotNull(strategyExecutionTraces.positionId),
      ),
    )
    // Oldest first guarantees that a large open-position set cannot starve a
    // legacy position forever. The external work remains capped at one K-line
    // request per intelligence cycle below.
    .orderBy(asc(strategyExecutionTraces.id));
  const target = traces.find((trace) => {
    if (!eligiblePositionIds.has(Number(trace.positionId))) return false;
    const evidence = asRecord(parseJson(trace.entryEvidenceJson));
    if (usableEntryStructureBaseline(evidence.entryStructureBaseline))
      return false;
    const sweep = asRecord(evidence.liquiditySweep);
    const detail = asRecord(sweep.detail);
    const fiveMinute = asRecord(evidence.fiveMinute);
    return !(
      Number(detail.priorSupport) > 0 &&
      Number(detail.priorResistance) > 0 &&
      Number(fiveMinute.atr5m) > 0
    );
  });
  if (!target?.positionId)
    return deferred("NO_MISSING_ENTRY_STRUCTURE");
  const positionId = Number(target.positionId);
  const [position] = Number.isInteger(positionId)
    ? await db
        .select()
        .from(livePositions)
        .where(eq(livePositions.id, positionId))
        .limit(1)
    : [];
  if (!position)
    return deferred("POSITION_SOURCE_MISSING");
  const eventTimeMs = target.eventTime.getTime();
  const eventBucketOpenTime =
    Math.floor(eventTimeMs / (5 * 60_000)) * 5 * 60_000;
  let candles;
  try {
    candles = await getBinanceLiveMarkPriceKlinesRange(
      position.symbol,
      "5m",
      eventBucketOpenTime - 30 * 5 * 60_000,
      eventBucketOpenTime - 1,
      40,
    );
  } catch {
    return {
      ...deferred("ENTRY_STRUCTURE_KLINES_UNAVAILABLE", 1),
      positionId: position.id,
      traceId: target.traceId,
    };
  }
  const baseline = buildEntryStructureBaseline({
    eventTimeMs,
    capturedAtMs: now.getTime(),
    candles,
  });
  if (!baseline)
    return {
      ...deferred("ENTRY_STRUCTURE_HISTORY_INCOMPLETE"),
      positionId: position.id,
      traceId: target.traceId,
    };
  const entryEvidence = asRecord(parseJson(target.entryEvidenceJson));
  await db
    .update(strategyExecutionTraces)
    .set({
      entryEvidenceJson: JSON.stringify({
        ...entryEvidence,
        entryStructureBaseline: baseline,
        entryStructureReassessmentRequired: true,
        entryStructureReassessmentCompletedAt: null,
      }),
      updatedAt: now,
    })
    .where(eq(strategyExecutionTraces.id, target.id));
  await writeAudit(
    { email: position.ownerEmail, accountId: position.accountId },
    "ENTRY_STRUCTURE_EVIDENCE_BACKFILLED",
    "strategy_execution_trace",
    target.traceId,
    {
      positionId: position.id,
      symbol: position.symbol,
      source: baseline.source,
      eventTime: baseline.eventTime,
      priorSupport: baseline.priorSupport,
      priorResistance: baseline.priorResistance,
      atr5m: baseline.atr5m,
      managementEligibility: baseline.managementEligibility,
      entryAttributionEligibility: baseline.entryAttributionEligibility,
    },
  );
  return {
    updated: 1,
    errors: 0,
    deferred: false,
    positionId: position.id,
    traceId: target.traceId,
  };
}

async function findEntryStructureReassessmentTarget(
  openPositionIds?: number[],
) {
  const db = getDb();
  const eligiblePositionIds = new Set(
    openPositionIds ??
      (await db
        .select({ id: livePositions.id })
        .from(livePositions)
        .where(eq(livePositions.status, "OPEN")))
        .map((position) => position.id),
  );
  if (!eligiblePositionIds.size) return null;
  const traces = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      positionId: strategyExecutionTraces.positionId,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.state, "POSITION_OPEN"),
        isNotNull(strategyExecutionTraces.positionId),
      ),
    )
    .orderBy(asc(strategyExecutionTraces.id));
  if (!traces.length) return null;
  for (const trace of traces) {
    const evidence = asRecord(parseJson(trace.entryEvidenceJson));
    const positionId = Number(trace.positionId);
    if (!eligiblePositionIds.has(positionId)) continue;
    if (
      entryStructureReassessmentRequired(evidence) &&
      Number.isInteger(positionId)
    )
      return {
        positionId,
        traceId: trace.traceId,
      };
  }
  return null;
}

async function markEntryStructureReassessmentCompleted(
  traceId: string,
  completedAt: Date,
) {
  const db = getDb();
  const [trace] = await db
    .select({
      id: strategyExecutionTraces.id,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(eq(strategyExecutionTraces.traceId, traceId))
    .limit(1);
  if (!trace) return;
  const entryEvidence = asRecord(parseJson(trace.entryEvidenceJson));
  await db
    .update(strategyExecutionTraces)
    .set({
      entryEvidenceJson: JSON.stringify({
        ...entryEvidence,
        entryStructureReassessmentRequired: false,
        entryStructureReassessmentCompletedAt: completedAt.toISOString(),
      }),
      updatedAt: completedAt,
    })
    .where(eq(strategyExecutionTraces.id, trace.id));
}

async function runPendingReductionSettlementBackfill(now: Date) {
  if (reductionSettlementBackfillRunning)
    return {
      updated: 0,
      exact: false,
      errors: 0,
      deferred: true,
      reason: "SETTLEMENT_BACKFILL_ALREADY_RUNNING",
    };
  reductionSettlementBackfillRunning = true;
  try {
    return await backfillPendingReductionSettlement(now);
  } finally {
    reductionSettlementBackfillRunning = false;
  }
}

async function backfillPendingReductionSettlement(now: Date) {
  const deferred = (reason: string) => ({
    updated: 0,
    exact: false,
    errors: 0,
    deferred: true,
    reason,
  });
  const db = getDb();
  const reductions = await db
    .select({
      id: livePositionReductions.id,
      positionId: livePositionReductions.positionId,
      exchangeOrderId: livePositionReductions.exchangeOrderId,
      symbol: livePositionReductions.symbol,
      quantity: livePositionReductions.quantity,
      exitPrice: livePositionReductions.exitPrice,
      realizedPnl: livePositionReductions.realizedPnl,
      responseJson: livePositionReductions.responseJson,
      createdAt: livePositionReductions.createdAt,
    })
    .from(livePositionReductions)
    .orderBy(desc(livePositionReductions.createdAt))
    .limit(200);
  const incomplete = reductions.filter((reduction) =>
    reduction.exchangeOrderId &&
    reductionAccountingPnl(reduction).settlementStatus ===
      "TRADE_DETAILS_PENDING"
  );
  if (!incomplete.length) return deferred("NO_INCOMPLETE_SETTLEMENT");

  const nowMs = now.getTime();
  const terminal = incomplete.filter((reduction) =>
    reductionSettlementRetryDue({
      response: parseJson(reduction.responseJson),
      createdAtMs: reduction.createdAt.getTime(),
      nowMs,
    }).terminal
  ).slice(0, 25);
  if (terminal.length) {
    for (const reduction of terminal) {
      const response = asRecord(parseJson(reduction.responseJson));
      const settlement = asRecord(response.nexusSettlement);
      await db
        .update(livePositionReductions)
        .set({
          responseJson: JSON.stringify({
            ...terminalizeReductionSettlementRetry({
              response,
              nowMs,
            }),
            nexusSettlement: {
              ...settlement,
              tradeDetailsStatus: "UNAVAILABLE",
            },
          }),
        })
        .where(eq(livePositionReductions.id, reduction.id));
    }
    return {
      updated: terminal.length,
      exact: false,
      errors: 0,
      deferred: false,
      terminalized: terminal.length,
      reason: "RETRY_WINDOW_EXPIRED",
    };
  }

  const due = incomplete.filter((reduction) =>
    reductionSettlementRetryDue({
      response: parseJson(reduction.responseJson),
      createdAtMs: reduction.createdAt.getTime(),
      nowMs,
    }).due
  );
  if (!due.length) return deferred("RETRY_NOT_DUE");

  let metrics;
  try {
    metrics = await getBinanceLiveSystemMetrics();
  } catch {
    return { ...deferred("SYSTEM_METRICS_UNAVAILABLE"), errors: 1 };
  }
  const remainingWeight = projectRemainingRestWeight(metrics.rest);
  if (!Number.isFinite(remainingWeight) || remainingWeight < 200)
    return deferred("REST_WEIGHT_RESERVED");

  // This lane repairs exactly one reduction per two-second tick. Loading every
  // due position and its full strategy evidence made the small settlement job
  // scale with the whole backlog and could fail before reaching the newest
  // closed order. Select the target first, then load only its lifecycle.
  const target = due[0];
  if (!target) return deferred("NO_INCOMPLETE_SETTLEMENT");
  const [[position], [trace]] = await Promise.all([
    db
      .select()
      .from(livePositions)
      .where(eq(livePositions.id, target.positionId))
      .limit(1),
    db
      .select({
        traceId: strategyExecutionTraces.traceId,
        strategyId: strategyExecutionTraces.strategyId,
        configVersion: strategyExecutionTraces.configVersion,
        configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
        positionId: strategyExecutionTraces.positionId,
      })
      .from(strategyExecutionTraces)
      .where(eq(
        strategyExecutionTraces.positionId,
        String(target.positionId),
      ))
      .orderBy(desc(strategyExecutionTraces.id))
      .limit(1),
  ]);
  if (!position) return deferred("NO_INCOMPLETE_SETTLEMENT");
  try {
    const [[credential], [entryOrder]] = await Promise.all([
      db
        .select()
        .from(exchangeCredentials)
        .where(
          and(
            eq(exchangeCredentials.id, position.credentialId),
            eq(exchangeCredentials.ownerEmail, position.ownerEmail),
          ),
        )
        .limit(1),
      db
        .select({
          exchangeOrderId: liveOrderEvents.exchangeOrderId,
          quantity: liveOrderEvents.quantity,
        })
        .from(liveOrderEvents)
        .where(
          and(
            eq(liveOrderEvents.id, position.sourceEventId),
            eq(liveOrderEvents.ownerEmail, position.ownerEmail),
          ),
        )
        .limit(1),
    ]);
    if (!credential || !entryOrder?.exchangeOrderId) {
      const response = asRecord(parseJson(target.responseJson));
      const settlement = asRecord(response.nexusSettlement);
      await db
        .update(livePositionReductions)
        .set({
          responseJson: JSON.stringify({
            ...terminalizeReductionSettlementRetry({
              response,
              nowMs,
              reason: "SETTLEMENT_SOURCE_MISSING",
            }),
            nexusSettlement: {
              ...settlement,
              tradeDetailsStatus: "UNAVAILABLE",
            },
          }),
        })
        .where(eq(livePositionReductions.id, target.id));
      return {
        updated: 1,
        exact: false,
        errors: 0,
        deferred: false,
        terminalized: 1,
        reason: "SETTLEMENT_SOURCE_MISSING",
        positionId: position.id,
      };
    }
    const keys = {
      apiKey: await decryptCredential(
        credential.apiKeyCiphertext,
        credential.apiKeyIv,
        credentialContext(position.ownerEmail, position.accountId, "api-key"),
      ),
      secretKey: await decryptCredential(
        credential.secretKeyCiphertext,
        credential.secretKeyIv,
        credentialContext(position.ownerEmail, position.accountId, "secret-key"),
      ),
    };
    const settlement = await resolveReductionSettlement({
      credentials: keys,
      symbol: target.symbol,
      exitOrderId: target.exchangeOrderId!,
      entryOrderId: entryOrder.exchangeOrderId,
      additionalEntryOrders: await additionalEntryOrdersForPosition(
        position.id,
      ),
      localGrossRealizedPnl: target.realizedPnl,
      executedQuantity: target.quantity,
      entryOrderQuantity: entryOrder.quantity,
      finalPositionFunding: await resolveFinalPositionFundingContext({
        position,
        isFinalReduction: position.status === "CLOSED",
        closedAt: position.closedAt ?? target.createdAt,
      }),
    });
    const existingResponse = asRecord(parseJson(target.responseJson));
    const existingExecutionAudit = asRecord(
      existingResponse._nexusExecutionAudit,
    );
    const confirmedExitPrice =
      Number.isFinite(Number(settlement.exitAveragePrice)) &&
        Number(settlement.exitAveragePrice) > 0
        ? Number(settlement.exitAveragePrice)
        : null;
    const initialSettlementResponse = attachReductionSettlement(
      existingResponse,
      settlement,
    );
    const tradeDetailsAvailable =
      reductionAccountingPnl({
        realizedPnl: settlement.grossRealizedPnl,
        responseJson: JSON.stringify(initialSettlementResponse),
      }).settlementStatus !== "TRADE_DETAILS_PENDING";
    const retry = tradeDetailsAvailable
      ? null
      : scheduleReductionSettlementRetry({
          response: initialSettlementResponse,
          createdAtMs: target.createdAt.getTime(),
          nowMs,
        });
    const finalSettlement = {
      ...settlement,
      tradeDetailsStatus: tradeDetailsAvailable
        ? "AVAILABLE" as const
        : retry?.terminal
          ? "UNAVAILABLE" as const
          : "PENDING" as const,
    };
    const settlementResponse = attachReductionSettlement(
      retry?.response ?? initialSettlementResponse,
      finalSettlement,
    );
    const responseWithConfirmedExecution = {
      ...settlementResponse,
      _nexusExecutionAudit: {
        ...existingExecutionAudit,
        acknowledgedExitPrice: confirmedExitPrice,
        acknowledgedExitPriceSource: confirmedExitPrice !== null
          ? "BINANCE_USER_TRADES"
          : "UNAVAILABLE",
      },
    };
    await db
      .update(livePositionReductions)
      .set({
        exitPrice: confirmedExitPrice ?? target.exitPrice,
        realizedPnl: settlement.grossRealizedPnl,
        responseJson: JSON.stringify(responseWithConfirmedExecution),
      })
      .where(eq(livePositionReductions.id, target.id));
    await writeAudit(
      { email: position.ownerEmail, accountId: position.accountId },
      tradeDetailsAvailable
        ? "LIVE_REDUCTION_SETTLEMENT_BACKFILLED"
        : retry?.terminal
          ? "LIVE_REDUCTION_SETTLEMENT_UNAVAILABLE"
          : "LIVE_REDUCTION_SETTLEMENT_RETRY_SCHEDULED",
      "live_position_reduction",
      String(target.id),
      {
        positionId: position.id,
        traceId: trace?.traceId ?? null,
        exactNetAvailable: settlement.exactNetAvailable,
        source: settlement.source,
        retryAttempts: retry?.state.attempts ?? 0,
        nextAttemptAt: retry?.state.nextAttemptAt ?? null,
        backfilledAt: now.toISOString(),
      },
    );
    if (tradeDetailsAvailable || retry?.terminal) {
      const positionMemory = readNexusPositionMemory(
        position.riskPlanJson,
        position,
      );
      const learningTraceId = trace?.traceId ??
        (positionMemory.origin === "SEMI_AUTO"
          ? `manual-position-${position.id}`
          : null);
      if (learningTraceId)
        await markNexusLearningCycleSettlementRefreshPending(
          learningTraceId,
          now,
        );
      if (trace)
        await refreshStrategyParameterSuggestions(trace, {
          durableBacklog: true,
        });
    }
    return {
      updated: 1,
      exact: settlement.exactNetAvailable,
      errors: 0,
      deferred: false,
      terminalized: retry?.terminal ? 1 : 0,
      retryScheduled: Boolean(retry && !retry.terminal),
      nextAttemptAt: retry?.state.nextAttemptAt ?? null,
      positionId: position.id,
    };
  } catch {
    return {
      updated: 0,
      exact: false,
      errors: 1,
      deferred: true,
      reason: "PENDING_SETTLEMENT_BACKFILL_FAILED",
      positionId: position.id,
    };
  }
}

async function refreshOneSemiAutoLearningCycle(now: Date) {
  const db = getDb();
  const positions = await db
    .select()
    .from(livePositions)
    .where(
      gte(
        livePositions.openedAt,
        new Date(now.getTime() - 30 * 24 * 60 * 60_000),
      ),
    )
    .orderBy(desc(livePositions.id))
    .limit(100);
  const candidates = positions.flatMap((position) => {
    const memory = readNexusPositionMemory(position.riskPlanJson, position);
    const context = memory.opportunityContext;
    const strategyId = Number(context?.strategyId);
    const configVersion = Number(context?.strategyConfigVersion);
    const analysisRecordId = Number(context?.analysisRecordId);
    return memory.origin === "SEMI_AUTO" &&
        Number.isInteger(strategyId) &&
        strategyId > 0 &&
        Number.isInteger(configVersion) &&
        configVersion > 0
      ? [{
          position,
          traceId: `manual-position-${position.id}`,
          strategyId,
          configVersion,
          opportunityContext: context!,
          analysisRecordId:
            Number.isInteger(analysisRecordId) && analysisRecordId > 0
              ? analysisRecordId
              : null,
        }]
      : [];
  });
  if (!candidates.length)
    return { refreshed: 0, deferred: true, reason: "NO_SEMI_AUTO_POSITION" };
  const traceIds = candidates.map((candidate) => candidate.traceId);
  const [samples, existingCycles] = await Promise.all([
    db
      .select({
        traceId: strategyPositionEvidence.traceId,
        minuteOffset: strategyPositionEvidence.minuteOffset,
        status: strategyPositionEvidence.status,
      })
      .from(strategyPositionEvidence)
      .where(inArray(strategyPositionEvidence.traceId, traceIds)),
    db
      .select({
        traceId: strategyLearningCycles.traceId,
        terminalStatus: strategyLearningCycles.terminalStatus,
        exactNetAvailable: strategyLearningCycles.exactNetAvailable,
        eligibility: strategyLearningCycles.eligibility,
        detailJson: strategyLearningCycles.detailJson,
      })
      .from(strategyLearningCycles)
      .where(inArray(strategyLearningCycles.traceId, traceIds)),
  ]);
  const sampleMap = new Map<string, typeof samples>();
  for (const sample of samples) {
    const rows = sampleMap.get(sample.traceId) ?? [];
    rows.push(sample);
    sampleMap.set(sample.traceId, rows);
  }
  const cycleMap = new Map(
    existingCycles.map((cycle) => [cycle.traceId, cycle]),
  );
  const candidate = candidates.find((item) => {
    const rows = sampleMap.get(item.traceId) ?? [];
    const terminalObservationMinute =
      item.position.status === "CLOSED" && item.position.closedAt
        ? strategyTerminalObservationMinute(
            item.position.openedAt,
            item.position.closedAt,
          )
        : null;
    const requiredCheckpointMinutes =
      nexusRequiredLearningCheckpointMinutes(terminalObservationMinute);
    const checkpointsComplete = requiredCheckpointMinutes.every((minuteOffset) =>
      rows.some(
        (row) =>
          row.minuteOffset === minuteOffset &&
          (row.status === "OPEN" || row.status === "CLOSED"),
      )
    );
    const cycle = cycleMap.get(item.traceId);
    const fastLearning = asRecord(
      asRecord(parseJson(cycle?.detailJson ?? "{}")).fastLearning,
    );
    const fastLearningRecorded =
      fastLearning.status === "LEARNED" || fastLearning.status === "PARTIAL";
    if (item.position.status === "CLOSED")
      return !cycle ||
        cycle.terminalStatus !== "CLOSED" ||
        cycle.eligibility === "INCOMPLETE" ||
        !fastLearningRecorded;
    if (!checkpointsComplete) return false;
    return !cycle ||
      cycle.terminalStatus !== item.position.status;
  });
  if (!candidate)
    return { refreshed: 0, deferred: true, reason: "NO_SEMI_AUTO_CYCLE_DUE" };
  const [identity, reductions] = await Promise.all([
    db
      .select({ brainKey: strategies.brainKey })
      .from(strategies)
      .where(eq(strategies.id, candidate.strategyId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        quantity: livePositionReductions.quantity,
        reason: livePositionReductions.reason,
        realizedPnl: livePositionReductions.realizedPnl,
        responseJson: livePositionReductions.responseJson,
      })
      .from(livePositionReductions)
      .where(eq(livePositionReductions.positionId, candidate.position.id)),
  ]);
  if (!identity?.brainKey)
    return { refreshed: 0, deferred: true, reason: "SEMI_AUTO_BRAIN_MISSING" };
  const settlement = aggregatePositionReductionCycle(reductions);
  const manualIntervention =
    candidate.position.exitReason === "MANUAL" ||
    settlement.reasons.includes("MANUAL");
  const exactNetAvailable =
    candidate.position.status === "CLOSED" &&
    settlement.count > 0 &&
    settlement.exactNetAvailable;
  const exactInitialMarginUsdt =
    exactNetAvailable &&
      settlement.quantity > 0 &&
      candidate.position.entryPrice > 0 &&
      candidate.position.leverage > 0
      ? candidate.position.entryPrice * settlement.quantity /
        candidate.position.leverage
      : null;
  const exactNetRoePercent =
    exactInitialMarginUsdt !== null && exactInitialMarginUsdt > 0
      ? settlement.pnl / exactInitialMarginUsdt * 100
      : null;
  const terminalObservationMinute =
    candidate.position.status === "CLOSED" && candidate.position.closedAt
      ? strategyTerminalObservationMinute(
          candidate.position.openedAt,
          candidate.position.closedAt,
        )
      : null;
  const checkpoints = (sampleMap.get(candidate.traceId) ?? []).map((sample) => ({
    minuteOffset: sample.minuteOffset,
    status: sample.status,
  }));
  const cycle = candidate.position.status === "CLOSED" &&
      candidate.position.closedAt
    ? buildTerminalSemiAutoLearningReceipt({
        brainKey: identity.brainKey,
        strategyId: candidate.strategyId,
        configVersion: candidate.configVersion,
        traceId: candidate.traceId,
        accountId: candidate.position.accountId,
        symbol: candidate.position.symbol,
        positionSide: candidate.position.positionSide === "SHORT"
          ? "SHORT"
          : "LONG",
        positionId: candidate.position.id,
        opportunityContext: candidate.opportunityContext,
        entryDecisionHandoffJson:
          candidate.position.entryDecisionHandoffJson,
        manualIntervention,
        checkpoints,
        terminalObservationMinute,
        exactNetAvailable,
        exactNetPnlUsdt: exactNetAvailable ? settlement.pnl : null,
        exactNetRoePercent,
        grossRealizedPnlUsdt: settlement.count > 0
          ? settlement.grossPnl
          : candidate.position.exitReason === "EXTERNAL" &&
              candidate.position.realizedPnl === 0
            ? null
            : candidate.position.realizedPnl,
        reductionCount: settlement.count,
        reductionAttributions: settlement.attributions,
        exitReasons: [...new Set([
          ...settlement.reasons,
          ...(candidate.position.exitReason
            ? [candidate.position.exitReason]
            : []),
        ])],
        holdingDurationMinutes: Math.max(
          0,
          (candidate.position.closedAt.getTime() -
            candidate.position.openedAt.getTime()) / 60_000,
        ),
        netSettlementStatus: settlement.count > 0
          ? settlement.netSettlementStatus
          : "UNAVAILABLE",
        completedAt: candidate.position.closedAt,
      })
    : buildNexusLearningCycle({
        brainKey: identity.brainKey,
        strategyId: candidate.strategyId,
        configVersion: candidate.configVersion,
        traceId: candidate.traceId,
        path: manualIntervention ? "MANUAL_INTERVENTION" : "ACTUAL_POSITION",
        orderSource: "SEMI_AUTO",
        manualIntervention,
        preTradeFactIds: candidate.analysisRecordId
          ? [`semi-auto-analysis:${candidate.analysisRecordId}`]
          : [],
        checkpoints,
        terminalStatus: "OPEN",
        terminalObservationMinute,
        exactNetAvailable,
        exactNetPnlUsdt: exactNetAvailable ? settlement.pnl : null,
        identityChain: nexusLearningIdentityChain({
          traceId: candidate.traceId,
          configVersion: candidate.configVersion,
          entryDecisionHandoffJson:
            candidate.position.entryDecisionHandoffJson,
          positionId: candidate.position.id,
          exactNetAvailable,
        }),
      });
  await saveNexusLearningCycle(cycle, now);
  return {
    refreshed: 1,
    deferred: false,
    traceId: candidate.traceId,
    eligibility: cycle.eligibility,
    exactNetAvailable: cycle.exactNetAvailable,
  };
}

function sqlValueBatches<T>(values: T[], batchSize = 50) {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize)
    batches.push(values.slice(index, index + batchSize));
  return batches;
}

async function enqueueActualPositionEvidenceRepairs(now: Date) {
  const db = getDb();
  const positions = await db
    .select()
    .from(livePositions)
    .where(and(
      gte(livePositions.openedAt, new Date(now.getTime() - 30 * 24 * 60 * 60_000)),
      lte(livePositions.openedAt, new Date(now.getTime() - 5 * 60_000)),
    ))
    .orderBy(desc(livePositions.id))
    .limit(500);
  if (!positions.length)
    return { queued: 0, reopened: 0, incomplete: 0, errors: 0 };
  const positionIds = positions.map((position) => String(position.id));
  const traces: Array<{
    traceId: string;
    positionId: string | null;
  }> = [];
  for (const batch of sqlValueBatches(positionIds)) {
    traces.push(...await db
      .select({
        traceId: strategyExecutionTraces.traceId,
        positionId: strategyExecutionTraces.positionId,
      })
      .from(strategyExecutionTraces)
      .where(and(
        isNotNull(strategyExecutionTraces.positionId),
        inArray(strategyExecutionTraces.positionId, batch),
      )));
  }
  const traceByPosition = new Map(
    traces.map((trace) => [trace.positionId, trace.traceId]),
  );
  const traceIdFor = (position: typeof livePositions.$inferSelect) =>
    traceByPosition.get(String(position.id)) ?? `manual-position-${position.id}`;
  const existing: Array<{
    traceId: string;
    minuteOffset: number;
    status: "OPEN" | "CLOSED" | "MISSED" | "DATA_STALE";
  }> = [];
  for (const batch of sqlValueBatches(positions.map(traceIdFor))) {
    existing.push(...await db
      .select({
        traceId: strategyPositionEvidence.traceId,
        minuteOffset: strategyPositionEvidence.minuteOffset,
        status: strategyPositionEvidence.status,
      })
      .from(strategyPositionEvidence)
      .where(inArray(strategyPositionEvidence.traceId, batch)));
  }
  const incompletePositions = positions.filter((candidate) => {
    const traceId = traceIdFor(candidate);
    const elapsedMinutes = Math.floor(
      (now.getTime() - candidate.openedAt.getTime()) / 60_000,
    );
    const requiredOffsets = POST_ENTRY_STORED_MINUTES.filter(
      (offset) => offset <= elapsedMinutes,
    );
    const offsets = new Set(
      existing
        .filter((row) => row.traceId === traceId && row.status !== "MISSED")
        .map((row) => row.minuteOffset),
    );
    return requiredOffsets.some((offset) => !offsets.has(offset));
  });
  const incompleteIdSet = new Set(
    incompletePositions.map((position) => String(position.id)),
  );
  const completeIds = positions
    .map((position) => String(position.id))
    .filter((id) => !incompleteIdSet.has(id));
  let completed = 0;
  for (const batch of sqlValueBatches(completeIds)) {
    const satisfiedTasks = await db
      .select()
      .from(backgroundRepairTasks)
      .where(and(
        eq(backgroundRepairTasks.taskType, ACTUAL_POSITION_EVIDENCE_TASK),
        eq(backgroundRepairTasks.resourceType, "live_position"),
        inArray(backgroundRepairTasks.resourceId, batch),
        inArray(backgroundRepairTasks.status, ["PENDING", "RETRY_WAIT"]),
      ));
    for (const task of satisfiedTasks) {
      await db
        .update(backgroundRepairTasks)
        .set({
          status: "COMPLETED",
          nextAttemptAt: now,
          lastErrorCode: null,
          lastError: null,
          resultJson: JSON.stringify({
            evidenceSatisfied: true,
            completionSource: "CURRENT_POSITION_EVIDENCE",
          }),
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(backgroundRepairTasks.id, task.id));
      completed += 1;
    }
  }
  if (!incompletePositions.length)
    return {
      queued: 0,
      reopened: 0,
      completed,
      incomplete: 0,
      errors: 0,
    };
  const incompleteIds = incompletePositions.map((position) =>
    String(position.id)
  );
  const knownTasks: Array<typeof backgroundRepairTasks.$inferSelect> = [];
  for (const batch of sqlValueBatches(incompleteIds)) {
    knownTasks.push(...await db
      .select()
      .from(backgroundRepairTasks)
      .where(and(
        eq(backgroundRepairTasks.taskType, ACTUAL_POSITION_EVIDENCE_TASK),
        eq(backgroundRepairTasks.resourceType, "live_position"),
        inArray(backgroundRepairTasks.resourceId, batch),
      )));
  }
  const taskByResource = new Map(
    knownTasks.map((task) => [task.resourceId, task]),
  );
  let queued = 0;
  let reopened = 0;
  for (const position of incompletePositions) {
    const resourceId = String(position.id);
    const task = taskByResource.get(resourceId);
    if (!task) {
      await db.insert(backgroundRepairTasks).values({
        ownerEmail: position.ownerEmail,
        accountId: position.accountId,
        taskType: ACTUAL_POSITION_EVIDENCE_TASK,
        resourceType: "live_position",
        resourceId,
        status: "PENDING",
        attemptCount: 0,
        nextAttemptAt: now,
        resultJson: JSON.stringify({
          positionId: position.id,
          symbol: position.symbol,
          reason: "MISSING_DUE_CHECKPOINT",
        }),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
      queued += 1;
      continue;
    }
    if (task.status === "COMPLETED") {
      await db
        .update(backgroundRepairTasks)
        .set({
          status: "PENDING",
          attemptCount: 0,
          nextAttemptAt: now,
          lastErrorCode: null,
          lastError: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(backgroundRepairTasks.id, task.id));
      reopened += 1;
    }
  }
  return {
    queued,
    reopened,
    completed,
    incomplete: incompletePositions.length,
    errors: 0,
  };
}

async function backfillActualPositionEvidence(now: Date) {
  const db = getDb();
  try {
    await refreshOneSemiAutoLearningCycle(now);
  } catch {
    // 半自动观察样本写入失败不得阻塞真实仓位保护或行情补样。
  }
  const positions = await db
    .select()
    .from(livePositions)
    .where(and(
      gte(livePositions.openedAt, new Date(now.getTime() - 30 * 24 * 60 * 60_000)),
      lte(livePositions.openedAt, new Date(now.getTime() - 5 * 60_000)),
    ))
    .orderBy(desc(livePositions.id))
    .limit(500);
  if (!positions.length) return { sampled: 0, errors: 0, deferred: false };
  const positionIds = positions.map((position) => String(position.id));
  const traces: Array<{
    traceId: string;
    strategyId: number;
    configVersion: number;
    configSnapshotJson: string;
    entryEvidenceJson: string;
    resultCode: typeof strategyExecutionTraces.$inferSelect["resultCode"];
    positionId: string | null;
  }> = [];
  for (const batch of sqlValueBatches(positionIds)) {
    traces.push(...await db
      .select({
        traceId: strategyExecutionTraces.traceId,
        strategyId: strategyExecutionTraces.strategyId,
        configVersion: strategyExecutionTraces.configVersion,
        configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
        resultCode: strategyExecutionTraces.resultCode,
        positionId: strategyExecutionTraces.positionId,
      })
      .from(strategyExecutionTraces)
      .where(and(
        isNotNull(strategyExecutionTraces.positionId),
        inArray(strategyExecutionTraces.positionId, batch),
      )));
  }
  const traceByPosition = new Map(traces.map((trace) => [trace.positionId, trace]));
  const traceIdFor = (position: typeof livePositions.$inferSelect) =>
    traceByPosition.get(String(position.id))?.traceId ?? `manual-position-${position.id}`;
  const existing: Array<{
    traceId: string;
    minuteOffset: number;
    status: typeof strategyPositionEvidence.$inferSelect["status"];
  }> = [];
  for (const batch of sqlValueBatches(positions.map(traceIdFor))) {
    existing.push(...await db
      .select({
        traceId: strategyPositionEvidence.traceId,
        minuteOffset: strategyPositionEvidence.minuteOffset,
        status: strategyPositionEvidence.status,
      })
      .from(strategyPositionEvidence)
      .where(inArray(strategyPositionEvidence.traceId, batch)));
  }
  const incompletePositions = positions.filter((candidate) => {
    const traceId = traceIdFor(candidate);
    const elapsedMinutes = Math.floor(
      (now.getTime() - candidate.openedAt.getTime()) / 60_000,
    );
    const requiredOffsets = POST_ENTRY_STORED_MINUTES.filter(
      (offset) => offset <= elapsedMinutes,
    );
    const offsets = new Set(
      existing
        .filter((row) => row.traceId === traceId && row.status !== "MISSED")
        .map((row) => row.minuteOffset),
    );
    return requiredOffsets.some((offset) => !offsets.has(offset));
  });
  const incompleteIds = incompletePositions.map((position) =>
    String(position.id)
  );
  const knownTasks: Array<typeof backgroundRepairTasks.$inferSelect> = [];
  for (const batch of sqlValueBatches(incompleteIds)) {
    knownTasks.push(...await db
      .select()
      .from(backgroundRepairTasks)
      .where(and(
        eq(backgroundRepairTasks.taskType, ACTUAL_POSITION_EVIDENCE_TASK),
        eq(backgroundRepairTasks.resourceType, "live_position"),
        inArray(backgroundRepairTasks.resourceId, batch),
      )));
  }
  const taskByResource = new Map(
    knownTasks.map((task) => [task.resourceId, task]),
  );
  for (const position of incompletePositions) {
    const resourceId = String(position.id);
    const task = taskByResource.get(resourceId);
    if (!task) {
      await db.insert(backgroundRepairTasks).values({
        ownerEmail: position.ownerEmail,
        accountId: position.accountId,
        taskType: ACTUAL_POSITION_EVIDENCE_TASK,
        resourceType: "live_position",
        resourceId,
        status: "PENDING",
        attemptCount: 0,
        nextAttemptAt: now,
        resultJson: JSON.stringify({
          positionId: position.id,
          symbol: position.symbol,
          reason: "MISSING_DUE_CHECKPOINT",
        }),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
      continue;
    }
    if (task.status === "COMPLETED") {
      await db
        .update(backgroundRepairTasks)
        .set({
          status: "PENDING",
          attemptCount: 0,
          nextAttemptAt: now,
          lastErrorCode: null,
          lastError: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(backgroundRepairTasks.id, task.id));
    }
  }
  if (!incompletePositions.length)
    return { sampled: 0, errors: 0, deferred: false };
  let metrics;
  try {
    metrics = await getBinanceLiveSystemMetrics();
  } catch {
    return {
      sampled: 0,
      errors: 1,
      deferred: true,
      reason: "REPAIR_QUEUE_WAIT_MARKET_CAPACITY",
    };
  }
  const remainingWeight = projectRemainingRestWeight(metrics.rest);
  if (!Number.isFinite(remainingWeight) || remainingWeight < 100)
    return {
      sampled: 0,
      errors: 0,
      deferred: true,
      reason: "REPAIR_QUEUE_WAIT_MARKET_CAPACITY",
    };
  const dueTasks: Array<typeof backgroundRepairTasks.$inferSelect> = [];
  for (const batch of sqlValueBatches(incompleteIds)) {
    dueTasks.push(...await db
      .select()
      .from(backgroundRepairTasks)
      .where(and(
        eq(backgroundRepairTasks.taskType, ACTUAL_POSITION_EVIDENCE_TASK),
        eq(backgroundRepairTasks.resourceType, "live_position"),
        inArray(backgroundRepairTasks.resourceId, batch),
        or(
          eq(backgroundRepairTasks.status, "PENDING"),
          eq(backgroundRepairTasks.status, "RETRY_WAIT"),
        ),
        lte(backgroundRepairTasks.nextAttemptAt, now),
      ))
      .orderBy(
        asc(backgroundRepairTasks.nextAttemptAt),
        asc(backgroundRepairTasks.id),
      )
      .limit(20));
  }
  dueTasks.sort((left, right) => {
    const byTime = left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime();
    return byTime || left.id - right.id;
  });
  const dueTask = dueTasks[0];
  const position = dueTask
    ? incompletePositions.find((candidate) =>
      String(candidate.id) === dueTask.resourceId
    )
    : null;
  if (!position || !dueTask)
    return {
      sampled: 0,
      errors: 0,
      deferred: true,
      reason: "REPAIR_QUEUE_WAIT",
    };
  const positionMemory = readNexusPositionMemory(position.riskPlanJson, position);
  const semiAutoContext =
    positionMemory.origin === "SEMI_AUTO"
      ? positionMemory.opportunityContext
      : null;
  const entryStructureBaseline = positionMemory.entryStructureBaseline;
  const rememberedStrategy =
    positionMemory.origin === "STRATEGY" &&
    positionMemory.strategyId !== null &&
    positionMemory.strategyConfigVersion !== null;
  const trace = traceByPosition.get(String(position.id)) ?? {
    traceId:
      positionMemory.traceId ??
      `${positionMemory.origin.toLowerCase()}-position-${position.id}`,
    strategyId:
      rememberedStrategy
        ? positionMemory.strategyId!
        : semiAutoContext && Number.isInteger(Number(semiAutoContext.strategyId))
        ? Number(semiAutoContext.strategyId)
        : 0,
    configVersion:
      rememberedStrategy
        ? positionMemory.strategyConfigVersion!
        : semiAutoContext &&
      Number.isInteger(Number(semiAutoContext.strategyConfigVersion))
        ? Number(semiAutoContext.strategyConfigVersion)
        : 0,
    configSnapshotJson: "{}",
    entryEvidenceJson: JSON.stringify({
      orderSource: positionMemory.origin,
      decisionMode: rememberedStrategy
        ? "STRATEGY_EXECUTION_MEMORY"
        : semiAutoContext
          ? "OPERATOR_HYPOTHESIS_BRAIN_VERIFIED"
          : "OPERATOR_DECISION",
      positionId: position.id,
      symbol: position.symbol,
      positionSide: position.positionSide,
      entryPrice: position.entryPrice,
      leverage: position.leverage,
      openedAt: position.openedAt.toISOString(),
      opportunityContext: semiAutoContext,
      entryStructureBaseline,
    }),
    positionId: String(position.id),
  };

  const minute = 60_000;
  const anchorAtMs = position.openedAt.getTime();
  const elapsedMinutes = Math.floor((now.getTime() - anchorAtMs) / minute);
  const existingOffsets = new Set(
    existing
      .filter((row) => row.traceId === trace.traceId && row.status !== "MISSED")
      .map((row) => row.minuteOffset),
  );
  const offsetsToBackfill = POST_ENTRY_STORED_MINUTES.filter(
    (offset) => offset <= elapsedMinutes,
  );
  const finalOffset = offsetsToBackfill.at(-1) ?? 5;
  const missingOffsets = offsetsToBackfill.filter(
    (offset) => !existingOffsets.has(offset),
  );
  let oneMinuteCandles: Awaited<
    ReturnType<typeof getBinanceLiveMarkPriceKlinesRange>
  > = [];
  let longIntervalCandles: Awaited<
    ReturnType<typeof getBinanceLiveMarkPriceKlinesRange>
  > = [];
  try {
    const needsShortPath = missingOffsets.some((offset) => offset <= 60);
    const needsLongPath = missingOffsets.some((offset) => offset > 60);
    const shortPlan = postEntryBackfillKlinePlan(
      Math.min(60, finalOffset),
    );
    const longPlan = postEntryBackfillKlinePlan(finalOffset);
    [oneMinuteCandles, longIntervalCandles] = await Promise.all([
      needsShortPath
        ? getBinanceLiveMarkPriceKlinesRange(
            position.symbol,
            shortPlan.interval,
            Math.floor(anchorAtMs / shortPlan.intervalMs) *
              shortPlan.intervalMs,
            anchorAtMs + 61 * minute,
            shortPlan.limit,
          )
        : Promise.resolve([]),
      needsLongPath
        ? getBinanceLiveMarkPriceKlinesRange(
            position.symbol,
            longPlan.interval,
            Math.floor(anchorAtMs / longPlan.intervalMs) *
              longPlan.intervalMs,
            anchorAtMs + (finalOffset + 1) * minute,
            longPlan.limit,
          )
        : Promise.resolve([]),
    ]);
  } catch (error) {
    const permanent =
      error instanceof BinanceLiveError &&
      (
        error.code === -1121 ||
        error.status === 400 ||
        error.status === 404
      );
    const attemptCount = dueTask.attemptCount + 1;
    const failure = backgroundRepairFailure({
      attemptCount,
      nowMs: now.getTime(),
      permanent,
    });
    await db
      .update(backgroundRepairTasks)
      .set({
        status: failure.status,
        attemptCount,
        nextAttemptAt: new Date(failure.nextAttemptAtMs),
        lastErrorCode: permanent
          ? "MARK_PRICE_HISTORY_UNAVAILABLE"
          : "MARK_PRICE_HISTORY_RETRY",
        lastError: permanent
          ? "交易所已无该合约对应时间段的历史标记价格，不能伪造学习样本"
          : "历史标记价格暂时不可用，系统将自动退避重试",
        resultJson: JSON.stringify({
          positionId: position.id,
          symbol: position.symbol,
          traceId: trace.traceId,
          permanent,
        }),
        completedAt: failure.completedAtMs
          ? new Date(failure.completedAtMs)
          : null,
        updatedAt: now,
      })
      .where(eq(backgroundRepairTasks.id, dueTask.id));
    return {
      sampled: 0,
      errors: 1,
      deferred: true,
      traceId: trace.traceId,
      repairTaskStatus: failure.status,
    };
  }

  const completeOffsets = new Set(existingOffsets);
  let sampled = 0;
  for (const minuteOffset of offsetsToBackfill) {
    const scheduledAt = new Date(anchorAtMs + minuteOffset * minute);
    const observedCandles = (
      minuteOffset <= 60 ? oneMinuteCandles : longIntervalCandles
    ).filter(
      (item) => item.closeTime <= scheduledAt.getTime(),
    );
    const candle = observedCandles.at(-1);
    if (!candle) continue;
    const roePercent = positionRoePercent(
      position.entryPrice,
      candle.close,
      position.leverage,
      position.positionSide,
    );
    const observedRoes = observedCandles.flatMap((item) => [
      positionRoePercent(
        position.entryPrice,
        item.high,
        position.leverage,
        position.positionSide,
      ),
      positionRoePercent(
        position.entryPrice,
        item.low,
        position.leverage,
        position.positionSide,
      ),
    ]);
    if (!Number.isFinite(roePercent) || !observedRoes.every(Number.isFinite))
      continue;
    const cumulativeMfe = Math.max(...observedRoes);
    const cumulativeMae = Math.min(...observedRoes);
    if (existingOffsets.has(minuteOffset)) continue;
    const unrealizedPnl = position.positionSide === "LONG"
      ? (candle.close - position.entryPrice) * position.quantity
      : (position.entryPrice - candle.close) * position.quantity;
    const [written] = await db
      .insert(strategyPositionEvidence)
      .values({
        traceId: trace.traceId,
        strategyId: trace.strategyId,
        minuteOffset,
        scheduledAt,
        sampledAt: now,
        sampleDelayMs: now.getTime() - scheduledAt.getTime(),
        // This row reconstructs the price path after the scheduled moment.
        // Keep it for historical replay, but never present it as a causal
        // live observation or feed it into automatic parameter learning.
        status: "DATA_STALE",
        markPrice: candle.close,
        entryPrice: position.entryPrice,
        remainingQty: position.quantity,
        unrealizedPnl,
        // Mark-to-market PnL excludes entry/exit commission and funding. Do
        // not label that gross number as net profit in the learning record.
        netPnlEstimate: null,
        roePercent,
        mfeRoePercent: cumulativeMfe,
        maeRoePercent: cumulativeMae,
        evidenceJson: JSON.stringify({
          source: "CENTRAL_PROXY_MARK_PRICE_KLINE_BACKFILL",
          evidenceCompleteness: "PRICE_PATH_ONLY",
          causalLearningEligible: false,
          historicalLearningEligible: true,
          sampleTimingClass: "HISTORICAL_BACKFILL",
          missingCausalDimensions: [
            "MARKET_REGIME_AT_SCHEDULED_TIME",
            "GLOBAL_LIQUIDATION_CONTEXT_AT_SCHEDULED_TIME",
            "LARGE_TRADER_POSITIONING_AT_SCHEDULED_TIME",
          ],
          sampleType:
            postEntryObservationType(minuteOffset) ===
            "POST_ENTRY_MODEL_CHECKPOINT"
              ? "POST_ENTRY_MODEL_CHECKPOINT_BACKFILL"
              : postEntryObservationType(minuteOffset) ===
                  "POST_ENTRY_LONG_HOLD_OBSERVATION"
                ? "POST_ENTRY_LONG_HOLD_OBSERVATION_BACKFILL"
                : "ENTRY_EXECUTION_PATH_BACKFILL",
          positionSampleType: "ACTUAL_POSITION_BACKFILL",
          modelCheckpoint: POST_ENTRY_MODEL_MINUTES.includes(
            minuteOffset as (typeof POST_ENTRY_MODEL_MINUTES)[number],
          ),
          longHoldObservation: POST_ENTRY_LONG_HOLD_MINUTES.includes(
            minuteOffset as (typeof POST_ENTRY_LONG_HOLD_MINUTES)[number],
          ),
          anchorAt: position.openedAt.toISOString(),
          positionId: position.id,
          leverage: position.leverage,
          pnlBasis: "GROSS_UNREALIZED_EXCLUDES_FEES_AND_FUNDING",
          positionSide: position.positionSide,
          candleOpenTime: candle.openTime,
          candleCloseTime: candle.closeTime,
        }),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: strategyPositionEvidence.id });
    if (written) {
      sampled += 1;
      completeOffsets.add(minuteOffset);
    }
  }
  const dueOffsetsComplete = offsetsToBackfill.every((offset) =>
    completeOffsets.has(offset)
  );
  if (dueOffsetsComplete) {
    await db
      .update(backgroundRepairTasks)
      .set({
        status: "COMPLETED",
        attemptCount: dueTask.attemptCount + 1,
        nextAttemptAt: now,
        lastErrorCode: null,
        lastError: null,
        resultJson: JSON.stringify({
          positionId: position.id,
          symbol: position.symbol,
          traceId: trace.traceId,
          sampled,
          completedOffsets: [...completeOffsets].sort((a, b) => a - b),
        }),
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(backgroundRepairTasks.id, dueTask.id));
  } else {
    const attemptCount = dueTask.attemptCount + 1;
    const failure = backgroundRepairFailure({
      attemptCount,
      nowMs: now.getTime(),
      permanent: false,
    });
    await db
      .update(backgroundRepairTasks)
      .set({
        status: failure.status,
        attemptCount,
        nextAttemptAt: new Date(failure.nextAttemptAtMs),
        lastErrorCode: "CHECKPOINT_CANDLE_NOT_CLOSED",
        lastError: "目标检查点尚无可用闭合行情，系统将自动重试",
        resultJson: JSON.stringify({
          positionId: position.id,
          symbol: position.symbol,
          traceId: trace.traceId,
          sampled,
          missingOffsets: offsetsToBackfill.filter((offset) =>
            !completeOffsets.has(offset)
          ),
        }),
        completedAt: null,
        updatedAt: now,
      })
      .where(eq(backgroundRepairTasks.id, dueTask.id));
  }
  return {
    sampled,
    errors: 0,
    deferred: false,
    traceId: trace.traceId,
    repairTaskStatus: dueOffsetsComplete ? "COMPLETED" : "RETRY_WAIT",
  };
}

async function backfillOneSentinelShadowEntryEvidence(now: Date) {
  const db = getDb();
  let metrics;
  try {
    metrics = await getBinanceLiveSystemMetrics();
  } catch {
    return { sampled: 0, errors: 1, deferred: true };
  }
  const remainingWeight = projectRemainingRestWeight(metrics.rest);
  if (!Number.isFinite(remainingWeight) || remainingWeight < 100)
    return { sampled: 0, errors: 0, deferred: true };

  const traces = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
      configVersion: strategyExecutionTraces.configVersion,
      symbol: strategyExecutionTraces.symbol,
      liquidationPrice: strategyExecutionTraces.liquidationPrice,
      eventTime: strategyExecutionTraces.eventTime,
      updatedAt: strategyExecutionTraces.updatedAt,
      completedAt: strategyExecutionTraces.completedAt,
      resultCode: strategyExecutionTraces.resultCode,
      resultMessage: strategyExecutionTraces.resultMessage,
      configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        ne(strategyExecutionTraces.triggerKind, "THREE_MINUTE_PROBABILITY"),
        or(
          eq(strategyExecutionTraces.state, "REJECTED"),
          and(
            eq(strategyExecutionTraces.state, "CANCELED"),
            isNull(strategyExecutionTraces.positionId),
          ),
          and(
            eq(strategyExecutionTraces.state, "EXPIRED"),
            isNull(strategyExecutionTraces.exchangeOrderId),
            isNull(strategyExecutionTraces.positionId),
          ),
        ),
        isNull(strategyExecutionTraces.positionId),
        isNotNull(strategyExecutionTraces.completedAt),
        gte(
          strategyExecutionTraces.completedAt,
          new Date(now.getTime() - 24 * 60 * 60_000),
        ),
        or(
          and(
            eq(
              strategyExecutionTraces.resultCode,
              THREE_MINUTE_OBSERVE_ONLY_SHADOW_RESULT_CODE,
            ),
            lte(
              strategyExecutionTraces.completedAt,
              new Date(now.getTime() - 3 * 60_000),
            ),
            notExists(
              db
                .select({ id: strategyPositionEvidence.id })
                .from(strategyPositionEvidence)
                .where(and(
                  eq(
                    strategyPositionEvidence.traceId,
                    strategyExecutionTraces.traceId,
                  ),
                  eq(strategyPositionEvidence.minuteOffset, 3),
                  eq(strategyPositionEvidence.status, "MISSED"),
                  like(
                    strategyPositionEvidence.evidenceJson,
                    '%"counterfactualVersion":2%',
                  ),
                )),
            ),
          ),
          and(
            or(
              isNull(strategyExecutionTraces.resultCode),
              ne(
                strategyExecutionTraces.resultCode,
                THREE_MINUTE_OBSERVE_ONLY_SHADOW_RESULT_CODE,
              ),
            ),
            lte(
              strategyExecutionTraces.completedAt,
              new Date(now.getTime() - 60 * 60_000),
            ),
            notExists(
              db
                .select({ id: strategyPositionEvidence.id })
                .from(strategyPositionEvidence)
                .where(and(
                  eq(
                    strategyPositionEvidence.traceId,
                    strategyExecutionTraces.traceId,
                  ),
                  eq(strategyPositionEvidence.minuteOffset, 60),
                  eq(strategyPositionEvidence.status, "MISSED"),
                  like(
                    strategyPositionEvidence.evidenceJson,
                    '%"counterfactualVersion":2%',
                  ),
                )),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(strategyExecutionTraces.completedAt))
    .limit(20);
  if (!traces.length) return { sampled: 0, errors: 0, deferred: false };

  const allExisting = await db
    .select({
      traceId: strategyPositionEvidence.traceId,
      minuteOffset: strategyPositionEvidence.minuteOffset,
      status: strategyPositionEvidence.status,
      evidenceJson: strategyPositionEvidence.evidenceJson,
    })
    .from(strategyPositionEvidence)
    .where(inArray(strategyPositionEvidence.traceId, traces.map((trace) => trace.traceId)));
  const trace = traces.find((candidate) => {
    const candidateRows = allExisting.filter((row) =>
      row.traceId === candidate.traceId &&
      row.status === "MISSED" &&
      isDecisionAnchoredCounterfactualEvidence(row.evidenceJson)
    );
    const offsets = new Set(candidateRows.map((row) => row.minuteOffset));
    const entryEvidence = asRecord(parseJson(candidate.entryEvidenceJson));
    const anchor = rejectedSignalCounterfactualAnchor({
      eventTimeMs: candidate.eventTime.getTime(),
      updatedAtMs: candidate.updatedAt.getTime(),
      completedAtMs: candidate.completedAt?.getTime() ?? null,
      liquidationPrice: candidate.liquidationPrice,
      entryEvidence,
    });
    const elapsedMs = anchor ? now.getTime() - anchor.anchorAtMs : 0;
    const threeMinuteObserveOnlyShadow =
      isThreeMinuteObserveOnlyShadowTrace(candidate.resultCode);
    const requiredOffsets = threeMinuteObserveOnlyShadow
      ? [3]
      : [...NEXUS_SENTINEL_SHADOW_ENTRY_HORIZONS];
    const effectiveRequiredObservationMs =
      (threeMinuteObserveOnlyShadow ? 3 : 60) * 60_000;
    return Boolean(
      anchor &&
      elapsedMs >= effectiveRequiredObservationMs &&
      requiredOffsets.some((offset) => !offsets.has(offset)),
    );
  });
  if (!trace) return { sampled: 0, errors: 0, deferred: false };

  const config = await loadBoundLiquidationTrendConfig(trace);
  const entryEvidence = asRecord(parseJson(trace.entryEvidenceJson));
  const nexusShadowCounterfactual =
    isNexusBrainShadowSkippedTrace({
      resultCode: trace.resultCode,
      entryEvidence,
    });
  const threeMinuteObserveOnlyShadow =
    isThreeMinuteObserveOnlyShadowTrace(trace.resultCode);
  const signalMarkPrice = Number(entryEvidence.signalMarkPrice);
  const decisionMarkPrice = Number(entryEvidence.markPrice);
  const anchor = rejectedSignalCounterfactualAnchor({
    eventTimeMs: trace.eventTime.getTime(),
    updatedAtMs: trace.updatedAt.getTime(),
    completedAtMs: trace.completedAt?.getTime() ?? null,
    liquidationPrice: trace.liquidationPrice,
    entryEvidence,
  });
  const leverage = Number(
    entryEvidence.leverage ??
    config.execution?.leverage ??
    (config as Record<string, unknown>).leverage ??
    1,
  );
  if (!anchor || !Number.isFinite(leverage) || leverage <= 0)
    return { sampled: 0, errors: 1, deferred: false };
  const { anchorAtMs, entryPrice, priceSource } = anchor;
  const offsetsToBackfill = threeMinuteObserveOnlyShadow
    ? [3]
    : [...NEXUS_SENTINEL_SHADOW_ENTRY_HORIZONS];
  const counterfactualPositionSide =
    nexusBrainShadowCounterfactualDirection({
      resultCode: trace.resultCode,
      entryEvidence,
    }) ?? rejectedSignalCounterfactualDirection(entryEvidence);
  const maximumBackfillMinute = Math.max(...offsetsToBackfill);

  const minute = 60_000;
  const rangeStart = Math.floor(anchorAtMs / minute) * minute;
  let candles;
  try {
    candles = await getBinanceLiveMarkPriceKlinesRange(
      trace.symbol,
      "1m",
      rangeStart,
      anchorAtMs + (maximumBackfillMinute + 1) * minute,
      Math.max(20, maximumBackfillMinute + 10),
    );
  } catch {
    return { sampled: 0, errors: 1, deferred: true };
  }
  let sampled = 0;
  const completeOffsets = new Set(
    allExisting
      .filter((row) => row.traceId === trace.traceId && row.status === "MISSED")
      .map((row) => row.minuteOffset),
  );
  const firstTakeProfitRoePercent = Number(
    config.risk?.takeProfitSteps?.[0]?.profitPercent,
  );
  const stopLossRoePercent = Number(config.risk?.stopLossPercent);
  const observedPath = candles
    .filter(
      (item) =>
        item.closeTime > anchorAtMs &&
        item.closeTime <= anchorAtMs + maximumBackfillMinute * minute,
    )
    .map((item) => {
      const highRoe = positionRoePercent(
        entryPrice,
        item.high,
        leverage,
        counterfactualPositionSide,
      );
      const lowRoe = positionRoePercent(
        entryPrice,
        item.low,
        leverage,
        counterfactualPositionSide,
      );
      return {
        minuteOffset: Math.max(
          1,
          Math.ceil((item.closeTime - anchorAtMs) / minute),
        ),
        bestRoePercent: Math.max(highRoe, lowRoe),
        worstRoePercent: Math.min(highRoe, lowRoe),
      };
    });
  const firstTakeProfitMinute =
    Number.isFinite(firstTakeProfitRoePercent) &&
      firstTakeProfitRoePercent > 0
      ? observedPath.find(
          (item) => item.bestRoePercent >= firstTakeProfitRoePercent,
        )?.minuteOffset ?? null
      : null;
  const firstStopLossMinute =
    Number.isFinite(stopLossRoePercent) && stopLossRoePercent > 0
      ? observedPath.find(
          (item) => item.worstRoePercent <= -stopLossRoePercent,
        )?.minuteOffset ?? null
      : null;
  let cumulativeMfe = Number.NEGATIVE_INFINITY;
  let cumulativeMae = Number.POSITIVE_INFINITY;
  for (const minuteOffset of offsetsToBackfill) {
    // A live causal checkpoint is authoritative for its trace/minute slot.
    // Historical Kline recovery may fill a missing slot, but must never
    // overwrite live evidence or another historical evidence version.
    if (completeOffsets.has(minuteOffset)) continue;
    const scheduledAt = new Date(anchorAtMs + minuteOffset * minute);
    if (scheduledAt.getTime() > now.getTime()) continue;
    const observedCandles = candles.filter(
      (item) =>
        item.closeTime > anchorAtMs &&
        item.closeTime <= scheduledAt.getTime(),
    );
    const candle = observedCandles.at(-1);
    if (!candle) continue;
    const roePercent = positionRoePercent(
      entryPrice,
      candle.close,
      leverage,
      counterfactualPositionSide,
    );
    const highRoe = positionRoePercent(
      entryPrice,
      candle.high,
      leverage,
      counterfactualPositionSide,
    );
    const lowRoe = positionRoePercent(
      entryPrice,
      candle.low,
      leverage,
      counterfactualPositionSide,
    );
    if (![roePercent, highRoe, lowRoe].every(Number.isFinite)) continue;
    cumulativeMfe = Math.max(
      cumulativeMfe,
      ...observedCandles.map((item) =>
        Math.max(
          positionRoePercent(
            entryPrice,
            item.high,
            leverage,
            counterfactualPositionSide,
          ),
          positionRoePercent(
            entryPrice,
            item.low,
            leverage,
            counterfactualPositionSide,
          ),
        )
      ),
    );
    cumulativeMae = Math.min(
      cumulativeMae,
      ...observedCandles.map((item) =>
        Math.min(
          positionRoePercent(
            entryPrice,
            item.high,
            leverage,
            counterfactualPositionSide,
          ),
          positionRoePercent(
            entryPrice,
            item.low,
            leverage,
            counterfactualPositionSide,
          ),
        )
      ),
    );
    const values = {
      scheduledAt,
      sampledAt: now,
      sampleDelayMs: now.getTime() - scheduledAt.getTime(),
      status: "MISSED" as const,
      markPrice: candle.close,
      entryPrice,
      remainingQty: 0,
      unrealizedPnl: null,
      netPnlEstimate: null,
      roePercent,
      mfeRoePercent: cumulativeMfe,
      maeRoePercent: cumulativeMae,
      evidenceJson: JSON.stringify({
        source: "CENTRAL_PROXY_MARK_PRICE_KLINE_BACKFILL",
        evidenceCompleteness:
          threeMinuteObserveOnlyShadow
            ? THREE_MINUTE_OBSERVE_ONLY_CAUSAL_EVIDENCE
            : nexusShadowCounterfactual &&
          shadowCounterfactualEvidenceComplete(entryEvidence)
            ? NEXUS_BRAIN_SHADOW_CAUSAL_EVIDENCE
            : "PRICE_PATH_ONLY",
        sampleType: threeMinuteObserveOnlyShadow
          ? "THREE_MINUTE_OBSERVE_ONLY_COUNTERFACTUAL"
          : nexusShadowCounterfactual
            ? "NEXUS_BRAIN_SHADOW_COUNTERFACTUAL"
            : "REJECTED_SIGNAL_COUNTERFACTUAL",
        counterfactualVersion: 2,
        anchorAt: new Date(anchorAtMs).toISOString(),
        anchorSource: "FINAL_STRATEGY_DECISION",
        entryPriceSource: priceSource,
        resultCode: trace.resultCode,
        resultMessage: trace.resultMessage,
        leverage,
        positionSide: counterfactualPositionSide,
        exactNetAvailable: false,
        estimatedCostBps: threeMinuteObserveOnlyShadow
          ? Number(
              asRecord(entryEvidence.threeMinuteProbability).estimatedCostBps,
            )
          : null,
        estimatedNetRoePercent: threeMinuteObserveOnlyShadow
          ? threeMinuteShadowNetRoeEstimate({
              grossRoePercent: roePercent,
              leverage,
              estimatedCostBps: Number(
                asRecord(entryEvidence.threeMinuteProbability)
                  .estimatedCostBps,
              ),
            })
          : null,
        signalMarkPrice: Number.isFinite(signalMarkPrice) ? signalMarkPrice : null,
        decisionMarkPrice: Number.isFinite(decisionMarkPrice) ? decisionMarkPrice : null,
        candleOpenTime: candle.openTime,
        candleCloseTime: candle.closeTime,
        firstTakeProfitMinute,
        firstStopLossMinute,
      }),
    };
    const inserted = await db.insert(strategyPositionEvidence).values({
      traceId: trace.traceId,
      strategyId: trace.strategyId,
      minuteOffset,
      ...values,
      createdAt: now,
    }).onConflictDoNothing().returning({ id: strategyPositionEvidence.id });
    if (inserted.length) {
      sampled += 1;
      completeOffsets.add(minuteOffset);
    }
  }
  if (
    sampled > 0 &&
    (
      (threeMinuteObserveOnlyShadow && completeOffsets.has(3)) ||
      [10, 30, 60].some((offset) => completeOffsets.has(offset))
    )
  )
    await refreshStrategyParameterSuggestions(trace);
  return { sampled, errors: 0, deferred: false, traceId: trace.traceId };
}

async function recordRejectedSignalEvidence(now: Date) {
  const db = getDb();
  const traces = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
      configVersion: strategyExecutionTraces.configVersion,
      symbol: strategyExecutionTraces.symbol,
      liquidationPrice: strategyExecutionTraces.liquidationPrice,
      eventTime: strategyExecutionTraces.eventTime,
      updatedAt: strategyExecutionTraces.updatedAt,
      completedAt: strategyExecutionTraces.completedAt,
      resultCode: strategyExecutionTraces.resultCode,
      resultMessage: strategyExecutionTraces.resultMessage,
      configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        ne(strategyExecutionTraces.triggerKind, "THREE_MINUTE_PROBABILITY"),
        or(
          eq(strategyExecutionTraces.state, "REJECTED"),
          and(
            eq(strategyExecutionTraces.state, "CANCELED"),
            isNull(strategyExecutionTraces.positionId),
          ),
          and(
            eq(strategyExecutionTraces.state, "EXPIRED"),
            isNull(strategyExecutionTraces.exchangeOrderId),
            isNull(strategyExecutionTraces.positionId),
          ),
        ),
        or(
            gte(
              strategyExecutionTraces.completedAt,
              new Date(now.getTime() - 61 * 60_000),
            ),
          and(
            eq(
              strategyExecutionTraces.resultCode,
              NEXUS_BRAIN_SHADOW_SKIPPED_RESULT_CODE,
            ),
            gte(
              strategyExecutionTraces.completedAt,
              new Date(now.getTime() - 61 * 60_000),
            ),
          ),
        ),
        lte(strategyExecutionTraces.completedAt, new Date(now.getTime() - 60_000)),
      ),
    )
    .limit(100);
  const due = traces.flatMap((trace) => {
    const entryEvidence = asRecord(parseJson(trace.entryEvidenceJson));
    const nexusShadowCounterfactual =
      isNexusBrainShadowSkippedTrace({
        resultCode: trace.resultCode,
        entryEvidence,
      });
    const threeMinuteObserveOnlyShadow =
      isThreeMinuteObserveOnlyShadowTrace(trace.resultCode);
    const anchor = rejectedSignalCounterfactualAnchor({
      eventTimeMs: trace.eventTime.getTime(),
      updatedAtMs: trace.updatedAt.getTime(),
      completedAtMs: trace.completedAt?.getTime() ?? null,
      liquidationPrice: trace.liquidationPrice,
      entryEvidence,
    });
    if (!anchor) return [];
    const minuteOffset = nexusShadowCounterfactual
      ? shadowCounterfactualMinuteDue(now.getTime(), anchor.anchorAtMs)
      : counterfactualMinuteOffset(now.getTime(), anchor.anchorAtMs);
    if (
      !nexusShadowCounterfactual &&
      minuteOffset === 30 &&
      !(
        entryEvidence.consensusShadow &&
        typeof entryEvidence.consensusShadow === "object" &&
        !Array.isArray(entryEvidence.consensusShadow)
      )
    ) return [];
    return minuteOffset
      ? [{
          ...trace,
          minuteOffset,
          anchor,
          nexusShadowCounterfactual,
          threeMinuteObserveOnlyShadow,
        }]
      : [];
  });
  if (!due.length) return { sampled: 0, errors: 0 };
  const existing = await db
    .select({
      id: strategyPositionEvidence.id,
      traceId: strategyPositionEvidence.traceId,
      minuteOffset: strategyPositionEvidence.minuteOffset,
      mfeRoePercent: strategyPositionEvidence.mfeRoePercent,
      maeRoePercent: strategyPositionEvidence.maeRoePercent,
      evidenceJson: strategyPositionEvidence.evidenceJson,
    })
    .from(strategyPositionEvidence)
    .where(inArray(strategyPositionEvidence.traceId, due.map((trace) => trace.traceId)));
  const existingKeys = new Set(
    existing
      .filter((row) => isDecisionAnchoredCounterfactualEvidence(row.evidenceJson))
      .map((row) => `${row.traceId}:${row.minuteOffset}`),
  );
  const missing = due.filter((trace) => !existingKeys.has(`${trace.traceId}:${trace.minuteOffset}`));
  if (!missing.length) return { sampled: 0, errors: 0 };
  let markRows;
  try {
    markRows = await getBinanceLiveMarkPrices([...new Set(missing.map((trace) => trace.symbol))]);
  } catch {
    return { sampled: 0, errors: missing.length };
  }
  const marks = new Map(markRows.map((row) => [row.symbol, row]));
  let sampled = 0;
  let errors = 0;
  for (const trace of missing) {
    const mark = marks.get(trace.symbol);
    const config = await loadBoundLiquidationTrendConfig(trace);
    const entryEvidence = asRecord(parseJson(trace.entryEvidenceJson));
    const signalMarkPrice = Number(entryEvidence.signalMarkPrice);
    const decisionMarkPrice = Number(entryEvidence.markPrice);
    const { anchorAtMs, entryPrice, priceSource } = trace.anchor;
    const leverage = Number(
      entryEvidence.leverage ??
      config.execution?.leverage ??
      (config as Record<string, unknown>).leverage ??
      1,
    );
    const counterfactualPositionSide =
      nexusBrainShadowCounterfactualDirection({
        resultCode: trace.resultCode,
        entryEvidence,
      }) ?? rejectedSignalCounterfactualDirection(entryEvidence);
    if (!mark || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(leverage) || leverage <= 0) {
      errors += 1;
      continue;
    }
    const roePercent = positionRoePercent(
      entryPrice,
      mark.markPrice,
      leverage,
      counterfactualPositionSide,
    );
    if (!Number.isFinite(roePercent)) {
      errors += 1;
      continue;
    }
    const estimatedCostBps = Number(
      asRecord(entryEvidence.threeMinuteProbability).estimatedCostBps,
    );
    const estimatedNetRoePercent = trace.threeMinuteObserveOnlyShadow
      ? threeMinuteShadowNetRoeEstimate({
          grossRoePercent: roePercent,
          leverage,
          estimatedCostBps,
        })
      : null;
    const prior = existing.filter(
      (row) =>
        row.traceId === trace.traceId &&
        isDecisionAnchoredCounterfactualEvidence(row.evidenceJson),
    );
    const priorMfe = prior.reduce((best, row) => Math.max(best, row.mfeRoePercent ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
    const priorMae = prior.reduce((worst, row) => Math.min(worst, row.maeRoePercent ?? Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
    const scheduledAt = new Date(anchorAtMs + trace.minuteOffset * 60_000);
    const values = {
        traceId: trace.traceId,
        strategyId: trace.strategyId,
        minuteOffset: trace.minuteOffset,
        scheduledAt,
        sampledAt: now,
        sampleDelayMs: now.getTime() - scheduledAt.getTime(),
        status: "MISSED" as const,
        markPrice: mark.markPrice,
        entryPrice,
        remainingQty: 0,
        unrealizedPnl: null,
        netPnlEstimate: null,
        roePercent,
        mfeRoePercent: Math.max(roePercent, priorMfe),
        maeRoePercent: Math.min(roePercent, priorMae),
        evidenceJson: JSON.stringify({
          source: "CENTRAL_MARK_PRICE_WEBSOCKET",
          evidenceCompleteness:
            trace.threeMinuteObserveOnlyShadow
              ? THREE_MINUTE_OBSERVE_ONLY_CAUSAL_EVIDENCE
              : trace.nexusShadowCounterfactual &&
            shadowCounterfactualEvidenceComplete(entryEvidence)
              ? NEXUS_BRAIN_SHADOW_CAUSAL_EVIDENCE
              : "PRICE_PATH_ONLY",
          sampleType: trace.threeMinuteObserveOnlyShadow
            ? "THREE_MINUTE_OBSERVE_ONLY_COUNTERFACTUAL"
            : trace.nexusShadowCounterfactual
              ? "NEXUS_BRAIN_SHADOW_COUNTERFACTUAL"
              : "REJECTED_SIGNAL_COUNTERFACTUAL",
          counterfactualVersion: 2,
          anchorAt: new Date(anchorAtMs).toISOString(),
          anchorSource: "FINAL_STRATEGY_DECISION",
          entryPriceSource: priceSource,
          resultCode: trace.resultCode,
          resultMessage: trace.resultMessage,
          leverage,
          positionSide: counterfactualPositionSide,
          exactNetAvailable: false,
          estimatedCostBps: trace.threeMinuteObserveOnlyShadow
            ? estimatedCostBps
            : null,
          estimatedNetRoePercent,
          signalMarkPrice: Number.isFinite(signalMarkPrice)
            ? signalMarkPrice
            : null,
          decisionMarkPrice: Number.isFinite(decisionMarkPrice)
            ? decisionMarkPrice
            : null,
        }),
        createdAt: now,
      };
    const [stale] = existing.filter(
      (row) =>
        row.traceId === trace.traceId &&
        row.minuteOffset === trace.minuteOffset &&
        !isDecisionAnchoredCounterfactualEvidence(row.evidenceJson),
    );
    const [written] = stale
      ? await db.update(strategyPositionEvidence).set(values).where(eq(strategyPositionEvidence.id, stale.id)).returning({ id: strategyPositionEvidence.id })
      : await db.insert(strategyPositionEvidence).values(values).onConflictDoNothing().returning({ id: strategyPositionEvidence.id });
    if (written) {
      sampled += 1;
      if (
        [10, 30, 60].includes(trace.minuteOffset) ||
        (trace.threeMinuteObserveOnlyShadow && trace.minuteOffset === 3)
      )
        await refreshStrategyParameterSuggestions(trace);
    }
  }
  return { sampled, errors };
}

async function recordLiquidationPositionEvidence(
  position: typeof livePositions.$inferSelect,
  markPrice: number,
  roePercent: number,
  favorableRoePercent: number,
  options: {
    forceEntryStructureReassessment?: boolean;
    fundingRate?: number | null;
    nextFundingTime?: number | null;
    markEventAt?: number | null;
    markReceivedAt?: number | null;
    markSnapshotAgeMs?: number | null;
    markTransportLatencyMs?: number | null;
  } = {},
) {
  const elapsedMs = Date.now() - position.openedAt.getTime();
  const observedElapsedMinutes = Math.floor(elapsedMs / 60_000);
  const preliminaryAnalysisPlan = parseRiskPlan(position.riskPlanJson);
  const preliminaryScheduledMinuteOffset =
    duePostEntryObservationMinute(elapsedMs) ??
    dueCapitalEfficiencyExitObservationMinute({
      rule: preliminaryAnalysisPlan.capitalEfficiencyExitRule,
      elapsedMs,
    });
  const forcedStructureReassessment =
    preliminaryScheduledMinuteOffset === null &&
    options.forceEntryStructureReassessment === true;
  if (
    preliminaryScheduledMinuteOffset === null &&
    !forcedStructureReassessment
  ) return null;
  const db = getDb();
  const positionMemory = readNexusPositionMemory(position.riskPlanJson, position);
  const strategyTrace = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      strategyId: strategyExecutionTraces.strategyId,
      configVersion: strategyExecutionTraces.configVersion,
      configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(
      positionMemory.traceId
        ? eq(strategyExecutionTraces.traceId, positionMemory.traceId)
        : eq(strategyExecutionTraces.positionId, String(position.id)),
    )
    .limit(1)
    .then((rows) => rows[0]);
  const positionOrderSource = strategyTrace
    ? "STRATEGY" as const
    : positionMemory.origin;
  const manualOrder = strategyTrace
    ? null
    : await db
        .select({
          clientOrderId: liveOrderEvents.clientOrderId,
          exchangeOrderId: liveOrderEvents.exchangeOrderId,
          orderType: liveOrderEvents.orderType,
          quantity: liveOrderEvents.quantity,
          referencePrice: liveOrderEvents.referencePrice,
          estimatedNotional: liveOrderEvents.estimatedNotional,
          createdAt: liveOrderEvents.createdAt,
        })
        .from(liveOrderEvents)
        .where(and(
          eq(liveOrderEvents.id, position.sourceEventId),
          eq(liveOrderEvents.ownerEmail, position.ownerEmail),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
  const manualExecutionEvidence = manualOrder
    ? {
        orderType: manualOrder.orderType,
        referencePrice: manualOrder.referencePrice,
        requestedQuantity: manualOrder.quantity,
        estimatedNotional: manualOrder.estimatedNotional,
        clientOrderId: manualOrder.clientOrderId,
        exchangeOrderId: manualOrder.exchangeOrderId,
        submittedAt: manualOrder.createdAt.toISOString(),
      }
    : null;
  const trace = strategyTrace ?? {
    traceId: `manual-position-${position.id}`,
    strategyId:
      positionOrderSource === "SEMI_AUTO"
        ? Number(positionMemory.opportunityContext?.strategyId) || 0
        : 0,
    configVersion:
      positionOrderSource === "SEMI_AUTO"
        ? Number(
            positionMemory.opportunityContext?.strategyConfigVersion,
          ) || 0
        : 0,
    configSnapshotJson: "{}",
    entryEvidenceJson: JSON.stringify({
      orderSource: positionOrderSource,
      decisionMode:
        positionOrderSource === "SEMI_AUTO"
          ? "OPERATOR_HYPOTHESIS_BRAIN_VERIFIED"
          : "OPERATOR_DECISION",
      positionId: position.id,
      symbol: position.symbol,
      positionSide: position.positionSide,
      entryPrice: position.entryPrice,
      markPrice: manualOrder?.referencePrice ?? position.entryPrice,
      leverage: position.leverage,
      execution: manualExecutionEvidence ?? { orderType: "UNKNOWN" },
      openedAt: position.openedAt.toISOString(),
      opportunityContext: positionMemory.opportunityContext,
      entryStructureBaseline: positionMemory.entryStructureBaseline,
    }),
  };
  const priorObservationRows = await db
    .select({
      id: strategyPositionEvidence.id,
      traceId: strategyPositionEvidence.traceId,
      markPrice: strategyPositionEvidence.markPrice,
      roePercent: strategyPositionEvidence.roePercent,
      maeRoePercent: strategyPositionEvidence.maeRoePercent,
      minuteOffset: strategyPositionEvidence.minuteOffset,
      createdAt: strategyPositionEvidence.createdAt,
    })
    .from(strategyPositionEvidence)
    .where(eq(strategyPositionEvidence.traceId, trace.traceId))
    .orderBy(desc(strategyPositionEvidence.minuteOffset));
  const recentContextRows = await db
    .select({
      evidenceJson: strategyPositionEvidence.evidenceJson,
      minuteOffset: strategyPositionEvidence.minuteOffset,
      createdAt: strategyPositionEvidence.createdAt,
    })
    .from(strategyPositionEvidence)
    .where(eq(strategyPositionEvidence.traceId, trace.traceId))
    .orderBy(desc(strategyPositionEvidence.minuteOffset))
    .limit(8);
  const recordedMinuteOffsets = priorObservationRows.map(
    (row) => row.minuteOffset,
  );
  const scheduledMinuteOffset =
    duePostEntryObservationMinute(elapsedMs, recordedMinuteOffsets) ??
    dueCapitalEfficiencyExitObservationMinute({
      rule: preliminaryAnalysisPlan.capitalEfficiencyExitRule,
      elapsedMs,
      recordedMinuteOffsets,
    });
  const minuteOffset =
    scheduledMinuteOffset ??
    entryStructureReassessmentMinute(
      elapsedMs,
      forcedStructureReassessment,
    );
  if (minuteOffset === null) return null;
  const observationType = forcedStructureReassessment
    ? "ENTRY_STRUCTURE_BACKFILL_REASSESSMENT" as const
    : postEntryObservationType(minuteOffset) ??
      (
        isCapitalEfficiencyExitObservationMinute(
            preliminaryAnalysisPlan.capitalEfficiencyExitRule,
            minuteOffset,
          )
          ? "CAPITAL_EFFICIENCY_EXIT_OBSERVATION" as const
          : null
      );
  if (!observationType) return null;
  const existingSample = priorObservationRows.find(
    (row) => row.minuteOffset === minuteOffset,
  );
  if (existingSample) {
    // 已入库的观察只用于页面展示与后验学习，不能在后续5秒轮询中
    // 重新成为补仓或结构退出指令。每个动作只能由首次成功写入该样本的
    // 同一轮风险循环消费一次。
    return null;
  }
  const previousNexusPositionState = recentContextRows
    .map((row) => {
      const evidence = asRecord(parseJson(row.evidenceJson));
      return parseNexusPositionStateSnapshot(
        evidence.nexusPositionStateMachine,
      );
    })
    .find((snapshot) => snapshot !== null) ?? null;
  const previousPostEntryContractTrendProfile = recentContextRows
    .map((row) =>
      asRecord(
        asRecord(parseJson(row.evidenceJson))
          .postEntryContractTrendProfile,
      )
    )
    .find((profile) => Object.keys(profile).length > 0) ?? null;
  const cumulativeMaeRoePercent = priorObservationRows.reduce(
    (worst, row) =>
      row.maeRoePercent === null
        ? worst
        : Math.min(worst, row.maeRoePercent),
    Math.min(0, roePercent),
  );
  const scheduledAt = new Date(
    position.openedAt.getTime() + minuteOffset * 60_000,
  );
  const sampledAt = new Date();
  const observationTiming = buildPositionObservationTiming({
    scheduledAtMs: scheduledAt.getTime(),
    sampledAtMs: sampledAt.getTime(),
    marketEventAtMs: options.markEventAt,
    marketReceivedAtMs: options.markReceivedAt,
    snapshotAgeMs: options.markSnapshotAgeMs,
    transportLatencyMs: options.markTransportLatencyMs,
  });
  const observationStorageStatus =
    positionObservationStorageStatus(observationTiming);
  const unrealizedPnl = position.positionSide === "LONG"
    ? (markPrice - position.entryPrice) * position.quantity
    : (position.entryPrice - markPrice) * position.quantity;
  const modelCheckpoint = POST_ENTRY_MODEL_MINUTES.includes(
    minuteOffset as (typeof POST_ENTRY_MODEL_MINUTES)[number],
  );
  const recurringHoldObservation =
    !forcedStructureReassessment &&
    isRecurringPostEntryHoldObservationMinute(minuteOffset);
  const longHoldObservation =
    POST_ENTRY_LONG_HOLD_MINUTES.includes(
      minuteOffset as (typeof POST_ENTRY_LONG_HOLD_MINUTES)[number],
    ) || recurringHoldObservation;
  const continuousExitObservation =
    isCapitalEfficiencyExitObservationMinute(
      preliminaryAnalysisPlan.capitalEfficiencyExitRule,
      minuteOffset,
    );
  const enrichedObservation =
    modelCheckpoint ||
    longHoldObservation ||
    continuousExitObservation ||
    forcedStructureReassessment;
  if (!enrichedObservation) {
    await db
      .insert(strategyPositionEvidence)
      .values({
        traceId: trace.traceId,
        strategyId: trace.strategyId,
        minuteOffset,
        scheduledAt,
        sampledAt,
        sampleDelayMs: observationTiming.sampleDelayMs,
        status: observationStorageStatus,
        markPrice,
        entryPrice: position.entryPrice,
        remainingQty: position.quantity,
        unrealizedPnl,
        netPnlEstimate: null,
        roePercent,
        mfeRoePercent: favorableRoePercent,
        maeRoePercent: cumulativeMaeRoePercent,
        evidenceJson: JSON.stringify({
          source: "CENTRAL_MARK_PRICE_WEBSOCKET",
          observationTiming,
          evidenceCompleteness: "PRICE_PATH_ONLY",
          sampleType: "ENTRY_EXECUTION_PATH",
          modelCheckpoint: false,
          observedElapsedMinutes,
          orderSource: positionOrderSource,
          entryExecution: manualExecutionEvidence,
          leverage: position.leverage,
          positionSide: position.positionSide,
          pnlBasis: "GROSS_UNREALIZED_EXCLUDES_FEES_AND_FUNDING",
        }),
        createdAt: sampledAt,
      })
      .onConflictDoNothing();
    return null;
  }
  let marketRegime = unavailablePostEntryMarketRegime(position.positionSide);
  let marketUniverse:
    Awaited<ReturnType<typeof getBinanceLiveContractUniverse>> = [];
  try {
    marketUniverse = await getBinanceLiveContractUniverse();
    marketRegime = analyzePostEntryMarketRegime({
      rows: marketUniverse,
      positionSide: position.positionSide,
    });
  } catch (error) {
    marketRegime = unavailablePostEntryMarketRegime(
      position.positionSide,
      error instanceof Error ? error.message : undefined,
    );
  }
  const globalLiquidationContext =
    await getCoinGlassWebLiquidationContext();
  const postEntryLiquidationRegime = analyzePostEntryLiquidationRegime({
    context: globalLiquidationContext,
    positionSide: position.positionSide,
  });
  const entryEvidence = asRecord(parseJson(trace.entryEvidenceJson));
  const holdingMandate = resolvePositionHoldingMandate({
    storedMandate: positionMemory.holdingMandate,
    entryEvidence,
    positionSide: position.positionSide,
    origin: positionOrderSource,
    openedAtMs: position.openedAt.getTime(),
  });
  const entryMultiHourContext = Object.keys(
      asRecord(positionMemory.entryMultiHourContext),
    ).length
    ? asRecord(positionMemory.entryMultiHourContext)
    : asRecord(entryEvidence.nexusOwnMultiHourContext);
  let postEntryMultiHourContext: ReturnType<
    typeof analyzeNexusMultiHourContext
  > | null = null;
  try {
    const [candles15m, candles1h] = await Promise.all([
      nexusUnifiedMarketData.closedCandles({
        symbol: position.symbol,
        interval: "15m",
        source: "TRADE",
        limit: 12,
        now: sampledAt.getTime(),
      }),
      nexusUnifiedMarketData.closedCandles({
        symbol: position.symbol,
        interval: "1h",
        source: "TRADE",
        limit: 8,
        now: sampledAt.getTime(),
      }),
    ]);
    postEntryMultiHourContext = analyzeNexusMultiHourContext({
      candles15m: candles15m.rows,
      candles1h: candles1h.rows,
      evaluatedAt: sampledAt.getTime(),
    });
  } catch {
    // Multi-hour evidence must remain unavailable on a cache/load failure.
    // Deterministic stop, take-profit and liquidation protection are separate.
  }
  const entryFundingContext = asRecord(
    entryEvidence.nexusFundingContext,
  );
  const entryDailyMarketActivity = asRecord(
    entryEvidence.nexusDailyMarketActivity,
  );
  const currentContract = marketUniverse.find(
    (row) => row.symbol === position.symbol,
  );
  const postEntryFundingVolumeObservation =
    analyzePostEntryFundingVolumeObservation({
      direction: position.positionSide,
      observedMinute: minuteOffset,
      entryPrice: position.entryPrice,
      currentMarkPrice: markPrice,
      currentRoePercent: roePercent,
      entryFundingRate: entryFundingContext.fundingRate as
        | number
        | null
        | undefined,
      currentFundingRate: options.fundingRate,
      nextFundingTime: options.nextFundingTime,
      entryQuoteVolume24h: entryDailyMarketActivity.quoteVolume24h as
        | number
        | null
        | undefined,
      currentQuoteVolume24h: currentContract?.quoteVolume,
    });
  let postEntryTradeVolumeObservation = analyzePostEntryTradeVolume({
    positionSide: position.positionSide,
    openedAtMs: position.openedAt.getTime(),
    closedTradeMinutes1m: [],
  });
  if (enrichedObservation) {
    try {
      const tradeMinutes1m = await nexusUnifiedMarketData.closedCandles({
        symbol: position.symbol,
        interval: "1m",
        source: "TRADE",
        limit: 12,
        now: sampledAt.getTime(),
      });
      postEntryTradeVolumeObservation = analyzePostEntryTradeVolume({
        positionSide: position.positionSide,
        openedAtMs: position.openedAt.getTime(),
        closedTradeMinutes1m: tradeMinutes1m.rows,
      });
    } catch {
      // Missing trade-volume evidence must remain unavailable and cannot be
      // replaced by rolling 24h volume or funding-rate background data.
    }
  }
  const contrarianProbe = asRecord(entryEvidence.contrarianProbe);
  const contrarianProbeLifecycle = analyzeContrarianProbeLifecycle({
    isContrarianProbe: strategyBranchFamily(entryEvidence) ===
      "CONTRARIAN_PROBE",
    currentRoePercent: roePercent,
    bestRoePercent: favorableRoePercent,
    profitProtectionThresholdRoePercent: Number(
      contrarianProbe.profitRoeBeforeHedge,
    ),
    trailingDrawdownRoePercent: position.trailingStopPercent,
  });
  const entryPositioning = entryLargeTraderPositioning(entryEvidence);
  const liquiditySweep = asRecord(entryEvidence.liquiditySweep);
  const liquiditySweepDetail = asRecord(liquiditySweep.detail);
  const entryFiveMinute = asRecord(entryEvidence.fiveMinute);
  const entryStructureBaseline = asRecord(
    entryEvidence.entryStructureBaseline,
  );
  const directEntrySupport = Number(liquiditySweepDetail.priorSupport);
  const directEntryPriorHigh = Number(
    liquiditySweepDetail.priorResistance,
  );
  const directEntryAtr5m = Number(entryFiveMinute.atr5m);
  const baselineEntrySupport = Number(entryStructureBaseline.priorSupport);
  const baselineEntryPriorHigh = Number(
    entryStructureBaseline.priorResistance,
  );
  const baselineEntryAtr5m = Number(entryStructureBaseline.atr5m);
  const entrySupport =
    directEntrySupport > 0
      ? directEntrySupport
      : baselineEntrySupport > 0
        ? baselineEntrySupport
        : null;
  const entryPriorHigh =
    directEntryPriorHigh > 0
      ? directEntryPriorHigh
      : baselineEntryPriorHigh > 0
        ? baselineEntryPriorHigh
        : null;
  const entryAtr5m =
    directEntryAtr5m > 0
      ? directEntryAtr5m
      : baselineEntryAtr5m > 0
        ? baselineEntryAtr5m
        : null;
  const shortEntryStructure = asRecord(entryEvidence.structure);
  const shortBrokenSupport = Number(shortEntryStructure.brokenSupport);
  const shortEntryAtr5m = Number(shortEntryStructure.atr);
  const rawPositionRiskPlan = asRecord(parseJson(position.riskPlanJson));
  const waveEntryPlan = asRecord(
    asRecord(positionMemory.waveThesis).entryPlan,
  );
  const riskPlanInvalidBoundary = Number(
    rawPositionRiskPlan.structureInvalidationPrice,
  );
  const waveInvalidBoundary = Number(waveEntryPlan.invalidBoundary);
  const boundInvalidBoundary = riskPlanInvalidBoundary > 0
    ? riskPlanInvalidBoundary
    : waveInvalidBoundary > 0
      ? waveInvalidBoundary
      : null;
  const entryStructureContext = resolvePostEntryStructureContext({
    positionSide: position.positionSide,
    entryPrice: position.entryPrice,
    directLongStructureComplete:
      directEntrySupport > 0 &&
      directEntryPriorHigh > 0 &&
      directEntryAtr5m > 0,
    entrySupport,
    entryPriorHigh,
    entryAtr5m,
    shortBrokenSupport:
      shortBrokenSupport > 0 ? shortBrokenSupport : null,
    shortAtr5m: shortEntryAtr5m > 0 ? shortEntryAtr5m : null,
    boundInvalidBoundary,
    baselineManagementEligible:
      entryStructureBaseline.managementEligibility === true,
  });
  const reconstructedEntryStructureUsed =
    entryStructureContext.reconstructedStructureUsed;
  let waveStructure = observePositionWaveStructure({
    positionSide: position.positionSide,
    latestClosed5mPrice: null,
    favorableBoundary: null,
    invalidationBoundary: null,
  });
  const favorableWaveBoundary =
    entryStructureContext.favorableWaveBoundary;
  const invalidationWaveBoundary =
    entryStructureContext.invalidationWaveBoundary;
  let closed5m: Awaited<
    ReturnType<typeof getBinanceLiveMarkPriceKlinesRange>
  > = [];
  if (favorableWaveBoundary !== null && invalidationWaveBoundary !== null) {
    try {
      closed5m = await getBinanceLiveMarkPriceKlinesRange(
        position.symbol,
        "5m",
        Math.max(
          position.openedAt.getTime(),
          sampledAt.getTime() - 100 * 5 * 60_000,
        ),
        sampledAt.getTime(),
        Math.min(100, Math.ceil(observedElapsedMinutes / 5) + 2),
      );
      waveStructure = observePositionWaveStructure({
        positionSide: position.positionSide,
        latestClosed5mPrice: closed5m.at(-1)?.close,
        favorableBoundary: favorableWaveBoundary,
        invalidationBoundary: invalidationWaveBoundary,
      });
    } catch {
      // The PnL sample remains valid when auxiliary structure data is absent.
    }
  }
  const postEntryTrendPath = analyzePostEntryTrendPath({
    positionSide: position.positionSide,
    observedAtMs: sampledAt.getTime(),
    currentRoePercent: roePercent,
    atr5m: entryStructureContext.thesisAtr5m,
    continuationBoundary: entryStructureContext.continuationBoundary,
    invalidationBoundary: entryStructureContext.invalidationWaveBoundary,
    closed5m,
  });
  let postEntryLargeTraderObservation =
    analyzePostEntryLargeTraderObservation({
      positionSide: position.positionSide,
      sampledMinute: minuteOffset,
      entryPositioning,
      currentPositioning: {},
    });
  if (
    strategyTrace &&
    position.positionSide === "LONG" &&
    enrichedObservation
  ) {
    try {
      const config = await loadBoundLiquidationTrendConfig(strategyTrace);
      const currentPositioning = await readPostEntryLargeTraderPositioning(
        position,
        config,
      );
      postEntryLargeTraderObservation =
        analyzePostEntryLargeTraderObservation({
          positionSide: "LONG",
          sampledMinute: minuteOffset,
          entryPositioning,
          currentPositioning,
        });
    } catch (error) {
      postEntryLargeTraderObservation =
        unavailablePostEntryLargeTraderObservation(
          "LONG",
          minuteOffset,
          error instanceof Error
            ? error.message
            : "大户聚合持仓读取失败",
        );
    }
  }
  let breakdownObservation = analyzePostEntryBreakdownObservation({
    positionSide: position.positionSide,
    currentMarkPrice: markPrice,
    priorSupport: null,
    atr5m: null,
    openedAtMs: position.openedAt.getTime(),
    observedAtMs: sampledAt.getTime(),
    closedMinutes1m: [],
  });
  let thesisClosedMinutes1m: Array<{ closeTime: number; close: number }> = [];
  const entryStructureManagementEligible =
    entryStructureContext.managementEligible;
  if (
    position.positionSide === "LONG" &&
    entryStructureManagementEligible
  ) {
    try {
      const closedMinutes1m = await getBinanceLiveMarkPriceKlinesRange(
        position.symbol,
        "1m",
        Math.max(
          position.openedAt.getTime(),
          sampledAt.getTime() - 70 * 60_000,
        ),
        sampledAt.getTime(),
        Math.min(70, observedElapsedMinutes + 2),
      );
      thesisClosedMinutes1m = closedMinutes1m;
      let latestSellPressure:
        | ReturnType<typeof buildLiquidationMarketTriggerCandidates>[number]
        | undefined;
      if (strategyTrace) {
        const config = await loadBoundLiquidationTrendConfig(strategyTrace);
        const feed = await getBinanceLiveLiquidationEvents(0, 300_000);
        const postEntryLiquidations = feed.rows.filter(
          (row) => row.lastTradeTime >= position.openedAt.getTime(),
        );
        latestSellPressure = buildLiquidationMarketTriggerCandidates(
          postEntryLiquidations,
          {
            side: "SELL",
            minNotionalUsdt: config.trigger.minLiquidationNotionalUsdt,
            minEventCount: config.trigger.minClusterEvents ?? 3,
            maxSpanMs: (config.trigger.maxClusterSpanSeconds ?? 120) * 1_000,
            maxInterEventGapMs:
              (config.trigger.maxClusterEventGapSeconds ?? 30) * 1_000,
          },
        ).at(-1);
      }
      breakdownObservation = analyzePostEntryBreakdownObservation({
        positionSide: "LONG",
        currentMarkPrice: markPrice,
        priorSupport: entrySupport,
        atr5m: entryAtr5m,
        openedAtMs: position.openedAt.getTime(),
        observedAtMs: sampledAt.getTime(),
        closedMinutes1m,
        sellLiquidationPressure: latestSellPressure
          ? {
              triggered: true,
              notional: latestSellPressure.marketClusterNotional,
              eventCount: latestSellPressure.marketClusterEventCount,
              triggerMode: latestSellPressure.marketTriggerMode,
            }
          : null,
      });
    } catch {
      // PnL evidence remains valid when the auxiliary breakdown observation
      // cannot be completed.  Never turn missing evidence into a trading claim.
    }
  }
  if (
    position.positionSide === "SHORT" &&
    entryStructureManagementEligible &&
    enrichedObservation
  ) {
    try {
      thesisClosedMinutes1m = await getBinanceLiveMarkPriceKlinesRange(
        position.symbol,
        "1m",
        Math.max(
          position.openedAt.getTime(),
          sampledAt.getTime() - 70 * 60_000,
        ),
        sampledAt.getTime(),
        Math.min(70, observedElapsedMinutes + 2),
      );
    } catch {
      // Missing auxiliary candles cannot create a structure-exit signal.
    }
  }
  const entryThesisInvalidation = analyzeEntryThesisInvalidation({
    positionSide: position.positionSide,
    structuralLevel: entryStructureContext.thesisStructuralLevel,
    atr5m: entryStructureContext.thesisAtr5m,
    explicitInvalidBoundary:
      entryStructureContext.thesisInvalidBoundary,
    currentMarkPrice: markPrice,
    openedAtMs: position.openedAt.getTime(),
    observedAtMs: sampledAt.getTime(),
    closedMinutes1m: thesisClosedMinutes1m,
  });
  const strategyConfig = strategyTrace
    ? await loadBoundLiquidationTrendConfig(strategyTrace)
    : null;
  const estimatedRoundTripCostRoePercent = strategyConfig
    ? (
        (strategyConfig.probabilityPolicy?.estimatedRoundTripFeePercent ??
          0.08) +
        (strategyConfig.probabilityPolicy?.estimatedExitSlippageBps ?? 5) /
          100
      ) * Math.max(1, position.leverage)
    : 0;
  const postEntryContractTrendProfile = analyzePostEntryContractTrend({
    positionSide: position.positionSide,
    currentRoePercent: roePercent,
    holdingMandate,
    entryContext: entryMultiHourContext,
    currentContext: postEntryMultiHourContext,
    previousProfile: previousPostEntryContractTrendProfile,
    observedMinutes: observedElapsedMinutes,
    waveStructureState: waveStructure.state,
    tradeVolumeStatus: postEntryTradeVolumeObservation.status,
    trendPathStatus: postEntryTrendPath.status,
    estimatedRoundTripCostRoePercent,
  });
  const analysisPlan = preliminaryAnalysisPlan;
  const executedRiskProgress = parseExecutedPlan(
    position.executedRiskPlanJson,
  );
  const observedRoeAtMinute = (targetMinute: number) =>
    minuteOffset === targetMinute
      ? roePercent
      : Number(
          priorObservationRows.find((row) => row.minuteOffset === targetMinute)
            ?.roePercent,
        );
  const minute3RoePercent = observedRoeAtMinute(3);
  const minute5RoePercent = observedRoeAtMinute(5);
  const provisionalPositionThesisUpdate = buildPositionThesisUpdate({
    observedAtMs: sampledAt.getTime(),
    currentRoePercent: roePercent,
    bestRoePercent: favorableRoePercent,
    worstRoePercent: cumulativeMaeRoePercent,
    entryThesis: positionMemory.entryThesis,
    entryNetExpectancy:
      positionMemory.netExpectancy ??
      asRecord(entryEvidence.nexusNetExpectancyDecision),
    thesisStatus: entryThesisInvalidation.status,
    managementState: "NEUTRAL",
    managementAction: "HOLD_AND_OBSERVE",
    evidenceComplete:
      postEntryContractTrendProfile.status !== "UNAVAILABLE",
  });
  const analyzedPositionManagementDecision = analyzePositionManagementDecision({
    positionSide: position.positionSide,
    currentRoePercent: roePercent,
    bestRoePercent: favorableRoePercent,
    worstRoePercent: cumulativeMaeRoePercent,
    waveState: waveStructure.state,
    breakdownStatus:
      entryThesisInvalidation.status === "INVALIDATED"
        ? "BREAKDOWN_PRESSURE"
        : breakdownObservation.status,
    largeTraderStatus: postEntryLargeTraderObservation.status,
    marketRegimeStatus: marketRegime.status,
    liquidationRegimeStatus: postEntryLiquidationRegime.status,
    liquidationRegimeReason: postEntryLiquidationRegime.reason,
    trendPathStatus: postEntryTrendPath.status,
    tradeVolumeStatus: postEntryTradeVolumeObservation.status,
    entryThesisStatus: entryThesisInvalidation.status,
    fundingVolumeStatus: postEntryFundingVolumeObservation.status,
    profitGivebackRoePoints:
      strategyConfig?.risk.positionManagement?.profitGivebackRoePoints,
    bottomRecoveryRoePoints:
      strategyConfig?.risk.positionManagement?.bottomRecoveryRoePoints,
    contractTrendProfile: postEntryContractTrendProfile,
    positionThesisOutlook: provisionalPositionThesisUpdate.outlook,
    observedMinute: minuteOffset,
    minute3RoePercent: Number.isFinite(minute3RoePercent)
      ? minute3RoePercent
      : null,
    minute5RoePercent: Number.isFinite(minute5RoePercent)
      ? minute5RoePercent
      : null,
    estimatedRoundTripCostRoePercent,
    evidenceRiskConfig:
      strategyConfig?.risk.positionManagement?.evidenceRisk,
    priorEvidenceRiskReductionExecuted:
      executedRiskProgress.evidenceRiskReduction !== null,
    postReductionElapsedSeconds:
      executedRiskProgress.evidenceRiskReduction === null
        ? null
        : Math.max(
            0,
            (sampledAt.getTime() -
              executedRiskProgress.evidenceRiskReduction.executedAtMs) /
              1_000,
          ),
    });
  // A frozen entry boundary is a current, auditable warning fact.  It must
  // pass through the same position state flow as every other adverse fact:
  // observe, reduce once, then exit only after the reduced position is still
  // invalidated.  It may never bypass that flow as an immediate full close.
  const effectivePositionManagementDecision = analyzedPositionManagementDecision;
  const capitalEfficiencyWaveAssessment = assessCapitalEfficiencyWave({
    rule: analysisPlan.capitalEfficiencyExitRule,
    observedMinute: minuteOffset,
    currentRoePercent: roePercent,
    action: effectivePositionManagementDecision.action,
    continuationEvidence:
      effectivePositionManagementDecision.continuationEvidence,
    bottomReboundEvidence:
      effectivePositionManagementDecision.bottomReboundEvidence,
  });
  const continuousUnifiedExitMonitoring =
    capitalEfficiencyExitUsesContinuousMonitoring(
      analysisPlan.capitalEfficiencyExitRule,
    );
  const proposedPositionManagementDecision: PositionManagementOpportunity = {
    ...effectivePositionManagementDecision,
    observedMinute: minuteOffset,
    opportunityId:
      `${trace.traceId}:${minuteOffset}:${POSITION_MANAGEMENT_MODEL_VERSION}`,
    traceId: trace.traceId,
    observedAtMs: sampledAt.getTime(),
    validUntilMs: continuousExitObservation
      ? sampledAt.getTime() + 60_000
      : scheduledAt.getTime() + 60_000,
    capitalEfficiencyWaveAssessment,
    structureExitAuthorized:
      observationTiming.marketDataFresh &&
      observationTiming.withinCausalWindow &&
      enrichedObservation &&
      (!recurringHoldObservation || continuousUnifiedExitMonitoring) &&
      capitalEfficiencyWaveAssessment.exitAuthorized &&
      entryStructureManagementEligible &&
      effectivePositionManagementDecision.action ===
        "EXIT_OR_REDUCE_BY_RISK_PLAN" &&
      entryThesisInvalidation.status === "INVALIDATED" &&
      thesisClosedMinutes1m.length >= 2 &&
      postEntryTradeVolumeObservation.status === "OPPOSITE_EXPANSION" &&
      executedRiskProgress.evidenceRiskReduction !== null &&
      analyzedPositionManagementDecision.evidenceRiskAssessment
        .postReductionObservationEligible === true,
    evidenceRiskReductionAuthorized:
      observationTiming.marketDataFresh &&
      observationTiming.withinCausalWindow &&
      enrichedObservation &&
      entryStructureManagementEligible &&
      analyzedPositionManagementDecision.action ===
        "REDUCE_RISK_BY_EVIDENCE" &&
      analyzedPositionManagementDecision.evidenceRiskAssessment.action ===
        "REDUCE_PARTIAL" &&
      executedRiskProgress.evidenceRiskReduction === null,
    evidenceRiskExitAuthorized:
      observationTiming.marketDataFresh &&
      observationTiming.withinCausalWindow &&
      enrichedObservation &&
      entryStructureManagementEligible &&
      analyzedPositionManagementDecision.action ===
        "EXIT_OR_REDUCE_BY_RISK_PLAN" &&
      analyzedPositionManagementDecision.evidenceRiskAssessment.action ===
        "EXIT_FULL" &&
      executedRiskProgress.evidenceRiskReduction !== null &&
      analyzedPositionManagementDecision.evidenceRiskAssessment
        .postReductionObservationEligible === true,
    evidenceRiskClosePercent:
      analyzedPositionManagementDecision.evidenceRiskAssessment
        .reductionPercent,
  };
  const causalCompleteness = evaluatePostEntryCausalCompleteness({
    positionSide: position.positionSide,
    orderSource: positionOrderSource,
    entryEvidenceAvailable:
      Boolean(strategyTrace) ||
      Boolean(positionMemory.entryStructureBaseline),
    marketRegime,
    waveStructure,
    breakdownObservation,
    postEntryTrendPath,
    postEntryTradeVolumeObservation,
    postEntryLargeTraderObservation,
    postEntryFundingVolumeObservation,
    postEntryContractTrendProfile,
    positionManagementDecision: proposedPositionManagementDecision,
  });
  const reconstructedStructureRestrictsRiskIncrease =
    entryStructureContext.restrictsRiskIncrease &&
    ["ADD_ELIGIBLE", "SCALE_IN_ELIGIBLE"].includes(
      proposedPositionManagementDecision.action,
    );
  if (
    reconstructedStructureRestrictsRiskIncrease &&
    !causalCompleteness.missingDimensions.includes(
      "ENTRY_STRUCTURE_FULL_CAUSAL_CONTEXT",
    )
  ) {
    causalCompleteness.complete = false;
    causalCompleteness.missingDimensions.push(
      "ENTRY_STRUCTURE_FULL_CAUSAL_CONTEXT",
    );
  }
  if (
    !observationTiming.marketDataFresh &&
    !causalCompleteness.missingDimensions.includes("MARK_PRICE_FRESHNESS")
  ) {
    causalCompleteness.complete = false;
    causalCompleteness.missingDimensions.push("MARK_PRICE_FRESHNESS");
  }
  if (
    !observationTiming.withinCausalWindow &&
    !causalCompleteness.missingDimensions.includes(
      "OBSERVATION_SCHEDULE_CAUSAL_WINDOW",
    )
  ) {
    causalCompleteness.complete = false;
    causalCompleteness.missingDimensions.push(
      "OBSERVATION_SCHEDULE_CAUSAL_WINDOW",
    );
  }
  const positionManagementDecision = gatePositionManagementDecision({
    proposed: proposedPositionManagementDecision,
    liveDecisionEligible: observationTiming.liveDecisionEligible,
    causalEvidenceComplete: causalCompleteness.complete,
    missingDimensions: causalCompleteness.missingDimensions,
  });
  const priorDurableStructureExitIntent =
    (await loadActiveStructureExitIntents([{
      id: position.id,
      lifecycleId: position.lifecycleId,
    }])).get(position.id) ?? null;
  const durableStructureExitIntent =
    positionManagementDecision.structureExitAuthorized
      ? createDurableStructureExitIntent({
          opportunityId: positionManagementDecision.opportunityId,
          traceId: positionManagementDecision.traceId,
          observedMinute: positionManagementDecision.observedMinute,
          observedAtMs: positionManagementDecision.observedAtMs,
        })
      : priorDurableStructureExitIntent;
  if (durableStructureExitIntent) {
    try {
      await persistActiveStructureExitIntent({
        position: {
          id: position.id,
          lifecycleId: position.lifecycleId,
        },
        intent: durableStructureExitIntent,
        observedAt: sampledAt,
      });
    } catch {
      // Evidence remains the durable compatibility source. A projection write
      // failure must not discard the observation or alter the position action.
    }
  }
  const continuousStructureExitExecutionEligible =
    recurringHoldObservation &&
    continuousUnifiedExitMonitoring &&
    durableStructureExitIntent !== null;
  const configuredPositionManagementExecutionBinding =
    bindPositionManagementExecution({
      action: positionManagementDecision.action,
      addOnEnabled: Boolean(
        strategyConfig?.risk.positionManagement?.addOnEnabled,
      ),
      profitScaleInEnabled: Boolean(
        strategyConfig?.risk.positionManagement?.profitScaleInEnabled,
      ),
      trailingActivationRoePercent: position.trailingActivationPercent,
      trailingDrawdownRoePercent: position.trailingStopPercent,
      favorableRoePercent,
      stopLossLevelCount: analysisPlan.stopLosses.length,
      liquidationGuardBufferPercent:
        analysisPlan.liquidationGuardBufferPercent,
      structureExitAuthorized:
        positionManagementDecision.evidenceRiskExitAuthorized ||
        durableStructureExitIntent !== null ||
        structureExitExecutionAuthorized({
          analysisAuthorized:
            positionManagementDecision.structureExitAuthorized,
          mode: analysisPlan.structureExitExecutionMode,
          softProtectionExecutable: true,
          currentRoePercent: roePercent,
        }),
      evidenceRiskReductionAuthorized:
        positionManagementDecision.evidenceRiskReductionAuthorized,
      expiredHorizonProfitProtectionAuthorized:
        positionManagementDecision.action === "TIGHTEN_PROFIT_PROTECTION" &&
        positionManagementDecision.contractTrendProfile
          ?.observationHorizonExpired === true,
    });
  const positionManagementExecutionBinding =
    forcedStructureReassessment ||
      (recurringHoldObservation &&
        !continuousStructureExitExecutionEligible)
      ? {
          action: positionManagementDecision.action,
          status: "OBSERVATION_ONLY" as const,
          executor: "NONE" as const,
          changesPositionImmediately: false,
          summary:
            recurringHoldObservation
              ? "长期持仓周期快照仅用于持续学习和运营解释；不创建订单、不修改既有风险参数。"
              : "入场结构补全后立即重跑持仓判断；本次仅刷新管理证据，不创建订单、不修改既有风险参数。",
        }
      : configuredPositionManagementExecutionBinding;
  const nexusPositionStateMachine = advanceNexusPositionState({
    positionKey: nexusManagedPositionKey({
      ownerEmail: position.ownerEmail,
      accountId: position.accountId,
      symbol: position.symbol,
      positionSide: position.positionSide,
      sourceEventId: position.sourceEventId,
    }),
    previous: previousNexusPositionState,
    observedAtMs: sampledAt.getTime(),
    pendingReduction: Boolean(position.pendingCloseClientOrderId),
    managementState: positionManagementDecision.state,
    managementAction: positionManagementDecision.action,
    dataFresh:
      observationTiming.marketDataFresh &&
      observationTiming.withinCausalWindow,
    evidenceComplete: causalCompleteness.complete,
    currentRoePercent: roePercent,
    confirmationEvidence:
      positionManagementDecision.continuationEvidence ||
      positionManagementDecision.bottomReboundEvidence,
    profitScaleInEnabled: Boolean(
      strategyConfig?.risk.positionManagement?.profitScaleInEnabled,
    ),
    confirmationEvidenceKey: positionObservationSampleKey(
      trace.traceId,
      minuteOffset,
    ),
    additionEvidenceKey:
      `${waveStructure.state}:${entryThesisInvalidation.status}:` +
      `${postEntryTrendPath.status}:${postEntryTradeVolumeObservation.status}`,
    candidateProtectionFloorRoePercent:
      position.trailingStopPercent > 0 &&
      favorableRoePercent >= position.trailingActivationPercent
        ? favorableRoePercent - position.trailingStopPercent
        : null,
    evidenceRiskReductionExecuted:
      positionManagementDecision.evidenceRiskAssessment
        ?.priorReductionExecuted === true,
    fullExitAuthorized:
      positionManagementDecision.evidenceRiskExitAuthorized === true ||
      durableStructureExitIntent !== null,
  });
  positionManagementDecision.nexusPositionStateMachine =
    nexusPositionStateMachine;
  const executionShadowBrainEvidence = buildExecutionShadowBrainEvidence({
    traceId: trace.traceId,
    positionSide: position.positionSide,
    actualEntryPrice: position.entryPrice,
    rawShadow: entryEvidence.entryExecutionShadow,
    samples: [
      ...priorObservationRows.map((row) => ({
        minuteOffset: row.minuteOffset,
        markPrice: row.markPrice,
      })),
      { minuteOffset, markPrice },
    ],
  });
  const positionThesisUpdate = buildPositionThesisUpdate({
    observedAtMs: sampledAt.getTime(),
    currentRoePercent: roePercent,
    bestRoePercent: favorableRoePercent,
    worstRoePercent: cumulativeMaeRoePercent,
    entryThesis: positionMemory.entryThesis,
    entryNetExpectancy:
      positionMemory.netExpectancy ??
      asRecord(entryEvidence.nexusNetExpectancyDecision),
    thesisStatus: entryThesisInvalidation.status,
    managementState: positionManagementDecision.state,
    managementAction: positionManagementDecision.action,
    evidenceComplete: causalCompleteness.complete,
  });
  const positionObservationEvidence = {
    source: "CENTRAL_MARK_PRICE_WEBSOCKET",
    observationTiming,
    evidenceCompleteness: causalCompleteness.complete
      ? "CAUSAL_ENRICHED"
      : "CAUSAL_INCOMPLETE",
    missingCausalDimensions: causalCompleteness.missingDimensions,
    orderSource: positionOrderSource,
    entryExecution: manualExecutionEvidence,
    entryEvidenceAvailable: Boolean(strategyTrace),
    leverage: position.leverage,
    positionSide: position.positionSide,
    pnlBasis: "GROSS_UNREALIZED_EXCLUDES_FEES_AND_FUNDING",
    sampleType: observationType,
    modelCheckpoint,
    longHoldObservation,
    recurringHoldObservation,
    structureBackfillReassessment: forcedStructureReassessment,
    observedElapsedMinutes,
    marketRegime,
    globalLiquidationContext,
    postEntryLiquidationRegime,
    postEntryFundingVolumeObservation,
    postEntryTradeVolumeObservation,
    holdingMandate,
    entryMultiHourContext,
    postEntryMultiHourContext,
    postEntryContractTrendProfile,
    entryStructureContext,
    entryStructureBaseline:
      Object.keys(entryStructureBaseline).length
        ? entryStructureBaseline
        : null,
    entryStructureSource:
      entryStructureContext.source === "UNAVAILABLE"
        ? "UNAVAILABLE"
        : reconstructedEntryStructureUsed
        ? "HISTORICAL_MARK_PRICE_5M_BACKFILL_AT_SIGNAL_TIME"
        : "ORIGINAL_ENTRY_ANALYSIS",
    entryStructureManagementEligible,
    structureExitCausal:
      entryStructureManagementEligible &&
      thesisClosedMinutes1m.length >= 2 &&
      !forcedStructureReassessment &&
      (!recurringHoldObservation ||
        continuousStructureExitExecutionEligible),
    entryStructureAttributionEligible:
      !reconstructedEntryStructureUsed,
    reconstructedStructureRestrictsRiskIncrease,
    waveStructure,
    postEntryTrendPath,
    breakdownObservation,
    entryThesisInvalidation,
    capitalEfficiencyWaveAssessment,
    postEntryLargeTraderObservation,
    strategyBranchFamily: strategyBranchFamily(entryEvidence),
    contrarianProbeLifecycle,
    proposedPositionManagementDecision,
    positionManagementDecision,
    positionManagementExecutionBinding,
    durableStructureExitIntent,
    nexusPositionStateMachine,
    executionShadowBrainEvidence,
    positionThesisUpdate,
  };
  const snapshotDecision = positionObservationRequiresFullSnapshot({
    modelCheckpoint,
    longHoldObservation,
    structureBackfillReassessment: forcedStructureReassessment,
    decision: positionManagementDecision,
    executionBinding: positionManagementExecutionBinding,
    durableStructureExitIntent,
    previousState: previousNexusPositionState,
    currentState: nexusPositionStateMachine,
  });
  const storedPositionObservationEvidence =
    positionObservationEvidenceForStorage({
      evidence: positionObservationEvidence,
      fullSnapshot: snapshotDecision.required,
      storageReason: snapshotDecision.reason,
    });
  const positionObservationEventKind: PositionObservationEventKind =
    forcedStructureReassessment
      ? "STRUCTURE_REASSESSMENT"
      : positionManagementDecision.action === "EXIT_OR_REDUCE_BY_RISK_PLAN"
        ? "EXIT_DECISION"
        : positionManagementDecision.action === "REDUCE_RISK_BY_EVIDENCE"
          ? "PROTECTION_CHANGED"
        : positionManagementDecision.action === "TIGHTEN_PROFIT_PROTECTION"
          ? "PROTECTION_CHANGED"
      : continuousStructureExitExecutionEligible
        ? "CAPITAL_EFFICIENCY_EXIT_OBSERVATION"
        : recurringHoldObservation
          ? "RECURRING_HOLD_OBSERVATION"
          : "CHECKPOINT";
  const inserted = await db
    .insert(strategyPositionEvidence)
    .values({
      traceId: trace.traceId,
      strategyId: trace.strategyId,
      minuteOffset,
      scheduledAt,
      sampledAt,
      sampleDelayMs: observationTiming.sampleDelayMs,
      status: observationStorageStatus,
      markPrice,
      entryPrice: position.entryPrice,
      remainingQty: position.quantity,
      unrealizedPnl,
      netPnlEstimate: null,
      roePercent,
      mfeRoePercent: favorableRoePercent,
      maeRoePercent: cumulativeMaeRoePercent,
      evidenceJson: JSON.stringify(storedPositionObservationEvidence),
      createdAt: sampledAt,
    })
    .onConflictDoNothing()
    .returning({ id: strategyPositionEvidence.id });
  if (strategyTrace && inserted.length) {
    try {
      await appendStrategyPositionManagementEvent({
        traceId: trace.traceId,
        strategyId: trace.strategyId,
        eventType: positionObservationEventType(positionObservationEventKind),
        outcome: causalCompleteness.complete ? "INFO" : "PENDING",
        message:
          (
            forcedStructureReassessment
              ? `入场结构补全后第${minuteOffset}分钟重新判断：`
              : recurringHoldObservation
                ? `长期持仓第${minuteOffset}分钟周期快照：`
              : `第${minuteOffset}分钟持仓判断：`
          ) +
          `${positionManagementDecision.label}；` +
          positionManagementExecutionBinding.summary,
        detail: compactPositionObservationEventDetail({
          minuteOffset,
          roePercent,
          evidence: positionObservationEvidence,
          continuousStructureExitExecutionEligible,
        }),
        eventAt: sampledAt,
      });
    } catch {
      // 日志可解释性失败不得阻塞止盈、止损、补仓复核或行情巡检。
    }
    if (forcedStructureReassessment && causalCompleteness.complete) {
      try {
        await markEntryStructureReassessmentCompleted(
          trace.traceId,
          sampledAt,
        );
      } catch {
        // The observation is already durable. A marker retry on the next
        // intelligence cycle is safe and must not affect protection.
      }
    }
  }
  if (
    strategyTrace &&
    inserted.length &&
    observationTiming.causalLearningEligible &&
    causalCompleteness.complete &&
    minuteOffset >= analysisPlan.minimumObservationMinutes &&
    POST_ENTRY_MODEL_MINUTES.includes(
      minuteOffset as (typeof POST_ENTRY_MODEL_MINUTES)[number],
    )
  )
    await refreshStrategyParameterSuggestions(trace);
  const executablePositionManagementDecision = durableStructureExitIntent
    ? {
        ...positionManagementDecision,
        ...durableStructureExitIntent,
        validUntilMs: Number.MAX_SAFE_INTEGER,
        structureExitAuthorized: true,
      }
    : positionManagementDecision;
  return forcedStructureReassessment ||
    (recurringHoldObservation &&
      !continuousStructureExitExecutionEligible) ||
    !inserted.length ||
    !observationTiming.liveDecisionEligible ||
    !causalCompleteness.complete
    ? null
    : executablePositionManagementDecision;
}

async function readPostEntryLargeTraderPositioning(
  position: typeof livePositions.$inferSelect,
  config: LiquidationTrendConfig,
) {
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const cacheKey = `${position.credentialId}:${position.symbol}:${bucket}`;
  const cached = postEntryLargeTraderCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  for (const [key, value] of postEntryLargeTraderCache) {
    if (value.expiresAt <= Date.now()) postEntryLargeTraderCache.delete(key);
  }
  try {
    const [credential] = await getDb()
      .select({
        apiKeyCiphertext: exchangeCredentials.apiKeyCiphertext,
        apiKeyIv: exchangeCredentials.apiKeyIv,
      })
      .from(exchangeCredentials)
      .where(
        and(
          eq(exchangeCredentials.id, position.credentialId),
          eq(exchangeCredentials.ownerEmail, position.ownerEmail),
        ),
      )
      .limit(1);
    if (!credential)
      throw new Error("交易子账户未配置 Binance 实盘 API Key");
    const apiKey = await decryptCredential(
      credential.apiKeyCiphertext,
      credential.apiKeyIv,
      credentialContext(position.ownerEmail, position.accountId, "api-key"),
    );
    const snapshot = await getBinanceLargeTraderPositioningSnapshot(
      apiKey,
      position.symbol,
    );
    const value = analyzeLargeTraderLongPositioning(
      {
        symbol: position.symbol,
        observedAt: Date.now(),
        ...snapshot,
      },
      config.largeTrader,
    );
    postEntryLargeTraderCache.set(cacheKey, {
      expiresAt: (bucket + 1) * 5 * 60_000,
      value,
    });
    return value;
  } catch (error) {
    postEntryLargeTraderCache.delete(cacheKey);
    throw error;
  }
}

async function refreshStrategyParameterSuggestions(trace: {
  traceId: string;
  strategyId: number;
  configVersion: number;
  configSnapshotJson: string;
  triggerKind?: string;
  triggerVersion?: string;
  entryEvidenceJson: string;
}, options: { durableBacklog?: boolean } = {}) {
  if (trace.triggerKind === "THREE_MINUTE_PROBABILITY")
    return { refreshed: false, reason: "THREE_MINUTE_LEARNING_DISABLED" } as const;
  const refreshKey = `${trace.strategyId}:${trace.configVersion}`;
  const lastCompletedAt = strategyLearningLastCompletedAt.get(refreshKey) ?? 0;
  if (
    !options.durableBacklog &&
    Date.now() - lastCompletedAt <
      STRATEGY_LEARNING_PER_VERSION_COOLDOWN_MS
  ) return { refreshed: false, reason: "PER_VERSION_COOLDOWN" } as const;
  if (
    Date.now() - strategyLearningLastGlobalCompletedAt <
      STRATEGY_LEARNING_GLOBAL_COOLDOWN_MS
  ) return { refreshed: false, reason: "GLOBAL_COOLDOWN" } as const;
  // Share only a plain lock key across requests. Never expose the request-bound
  // historical refresh Promise to another Worker request.
  if (strategyLearningRefreshActiveKeys.has(refreshKey))
    return { refreshed: false, reason: "REFRESH_ALREADY_RUNNING" } as const;
  strategyLearningRefreshActiveKeys.add(refreshKey);
  try {
    await performStrategyParameterSuggestionRefresh(trace);
    let configValidationStatus: string | null = null;
    try {
      const validation = await reconcileNexusConfigValidation({
        strategyId: trace.strategyId,
        candidateVersion: trace.configVersion,
      });
      configValidationStatus = validation?.row.status ?? null;
      await reconcileLiquidationFactorLearningCandidate({
        strategyId: trace.strategyId,
      });
    } catch {
      // The learning cycle is already durable. Validation remains fail-closed
      // once ROLLBACK_REQUIRED is persisted and retries on the next refresh;
      // validation maintenance must never interrupt live position protection.
    }
    const completedAt = Date.now();
    strategyLearningLastCompletedAt.set(refreshKey, completedAt);
    strategyLearningLastGlobalCompletedAt = completedAt;
    return {
      refreshed: true,
      reason: "REFRESHED",
      configValidationStatus,
    } as const;
  } finally {
    strategyLearningRefreshActiveKeys.delete(refreshKey);
  }
}

async function performStrategyParameterSuggestionRefresh(trace: {
  traceId: string;
  strategyId: number;
  configVersion: number;
  configSnapshotJson: string;
  triggerKind?: string;
  triggerVersion?: string;
  entryEvidenceJson: string;
}) {
  const config = await loadBoundLiquidationTrendConfig(trace);
  const targetEntryEvidence = asRecord(parseJson(trace.entryEvidenceJson));
  const targetLearningScope = resolveStrategyTerminalLearningScope({
    triggerKind:
      trace.triggerKind ??
      asRecord(targetEntryEvidence.triggerIdentity).triggerKind,
    triggerVersion:
      trace.triggerVersion ??
      asRecord(targetEntryEvidence.triggerIdentity).triggerVersion,
    entryEvidence: targetEntryEvidence,
  });
  if (!targetLearningScope) return;
  const targetBranchFamily = targetLearningScope.branchFamily;
  const targetEngineVersion = decisionEngineVersionFromEvidence(
    targetEntryEvidence,
  );
  const db = getDb();
  const [strategyIdentity] = await db
    .select({
      accountId: strategies.accountId,
      ownerEmail: strategies.ownerEmail,
      brainKey: strategies.brainKey,
      draftVersion: strategies.draftVersion,
      publishedVersion: strategies.publishedVersion,
    })
    .from(strategies)
    .where(eq(strategies.id, trace.strategyId))
    .limit(1);
  if (!strategyIdentity?.brainKey) return;
  const strategyVersionTraceRows = await db
    .select({ traceId: strategyExecutionTraces.traceId })
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.strategyId, trace.strategyId),
        eq(strategyExecutionTraces.configVersion, trace.configVersion),
      ),
    )
    .orderBy(desc(strategyExecutionTraces.createdAt))
    .limit(STRATEGY_LEARNING_RUNTIME_TRACE_ID_LIMIT);
  const candidateTraceIds = [...new Set([
    trace.traceId,
    ...strategyVersionTraceRows.map((row) => row.traceId),
  ])].slice(0, STRATEGY_LEARNING_RUNTIME_TRACE_ID_LIMIT);
  const observationRows = await db
    .select({
      traceId: strategyPositionEvidence.traceId,
      minuteOffset: strategyPositionEvidence.minuteOffset,
      scheduledAt: strategyPositionEvidence.scheduledAt,
      sampledAt: strategyPositionEvidence.sampledAt,
      sampleDelayMs: strategyPositionEvidence.sampleDelayMs,
      status: strategyPositionEvidence.status,
      markPrice: strategyPositionEvidence.markPrice,
      entryPrice: strategyPositionEvidence.entryPrice,
      roePercent: strategyPositionEvidence.roePercent,
      mfeRoePercent: strategyPositionEvidence.mfeRoePercent,
      maeRoePercent: strategyPositionEvidence.maeRoePercent,
      evidenceJson: strategyPositionEvidence.evidenceJson,
    })
    .from(strategyPositionEvidence)
    .where(
      and(
        eq(strategyPositionEvidence.strategyId, trace.strategyId),
        inArray(strategyPositionEvidence.traceId, candidateTraceIds),
        or(
          inArray(
            strategyPositionEvidence.minuteOffset,
            [...POST_ENTRY_STORED_MINUTES],
          ),
          eq(strategyPositionEvidence.status, "CLOSED"),
        ),
      ),
    )
    .orderBy(desc(strategyPositionEvidence.createdAt))
    .limit(STRATEGY_LEARNING_RUNTIME_OBSERVATION_ROW_LIMIT);
  type StrategyLearningTraceContextRow = Pick<
    typeof strategyExecutionTraces.$inferSelect,
    | "traceId"
    | "symbol"
    | "eventTime"
    | "configVersion"
    | "triggerKind"
    | "triggerVersion"
    | "triggerFactSnapshotId"
    | "entryEvidenceJson"
    | "resultCode"
    | "positionId"
  >;
  const uniqueTraceIds = [...new Set(
    observationRows.map((row) => row.traceId),
  )];
  const currentTraceIndex = uniqueTraceIds.indexOf(trace.traceId);
  if (currentTraceIndex > 0) {
    uniqueTraceIds.splice(currentTraceIndex, 1);
    uniqueTraceIds.unshift(trace.traceId);
  }
  const traceContexts: StrategyLearningTraceContextRow[] = [];
  let retainedTraceContextBytes = 0;
  for (const traceIdBatch of sqlValueBatches(uniqueTraceIds)) {
    if (
      retainedTraceContextBytes >=
        STRATEGY_LEARNING_RUNTIME_TRACE_CONTEXT_BUDGET_BYTES
    ) break;
    const contextRows = await db
      .select({
        traceId: strategyExecutionTraces.traceId,
        symbol: strategyExecutionTraces.symbol,
        eventTime: strategyExecutionTraces.eventTime,
        configVersion: strategyExecutionTraces.configVersion,
        triggerKind: strategyExecutionTraces.triggerKind,
        triggerVersion: strategyExecutionTraces.triggerVersion,
        triggerFactSnapshotId:
          strategyExecutionTraces.triggerFactSnapshotId,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
        resultCode: strategyExecutionTraces.resultCode,
        positionId: strategyExecutionTraces.positionId,
      })
      .from(strategyExecutionTraces)
      .where(
        and(
          eq(strategyExecutionTraces.strategyId, trace.strategyId),
          eq(strategyExecutionTraces.configVersion, trace.configVersion),
          inArray(strategyExecutionTraces.traceId, traceIdBatch),
        ),
      );
    const selected = selectStrategyLearningTraceContextsWithinBudget({
      contexts: contextRows,
      orderedTraceIds: traceIdBatch,
      byteBudget:
        STRATEGY_LEARNING_RUNTIME_TRACE_CONTEXT_BUDGET_BYTES -
        retainedTraceContextBytes,
      mustIncludeTraceId: trace.traceId,
    });
    traceContexts.push(...selected.selected);
    retainedTraceContextBytes += selected.retainedBytes;
    if (selected.truncated) break;
  }
  const traceContextById = new Map(
    traceContexts.map((context) => [context.traceId, context]),
  );
  const rows = observationRows.flatMap((observation) => {
    const context = traceContextById.get(observation.traceId);
    return context ? [{ ...context, ...observation }] : [];
  });
  const emptyEvidence: Record<string, unknown> = {};
  const entryEvidenceByTraceId = new Map(
    traceContexts.map((context) => {
      const evidence = asRecord(parseJson(context.entryEvidenceJson));
      if (!Object.keys(asRecord(evidence.triggerIdentity)).length)
        evidence.triggerIdentity = {
          triggerKind: context.triggerKind,
          triggerVersion: context.triggerVersion,
          factSnapshotId: context.triggerFactSnapshotId,
          canAuthorizeOrder: false,
        };
      return [context.traceId, evidence] as const;
    }),
  );
  const observationEvidenceByRow = new WeakMap<
    object,
    Record<string, unknown>
  >();
  const entryEvidenceForRow = (row: (typeof rows)[number] | undefined) =>
    row
      ? entryEvidenceByTraceId.get(row.traceId) ?? emptyEvidence
      : emptyEvidence;
  const observationEvidenceForRow = (
    row: (typeof rows)[number] | undefined,
  ) => {
    if (!row) return emptyEvidence;
    const cached = observationEvidenceByRow.get(row);
    if (cached) return cached;
    const parsed = asRecord(parseJson(row.evidenceJson));
    observationEvidenceByRow.set(row, parsed);
    return parsed;
  };
  const positionSideForRow = (row: (typeof rows)[number] | undefined) =>
    observationEvidenceForRow(row).positionSide === "SHORT"
      ? "SHORT" as const
      : "LONG" as const;
  const rowIsCausalLearningEligible = (row: (typeof rows)[number]) =>
    positionObservationCausalLearningEligible({
      status: row.status,
      scheduledAt: row.scheduledAt,
      sampledAt: row.sampledAt,
      sampleDelayMs: row.sampleDelayMs,
      timing: observationEvidenceForRow(row).observationTiming,
    });
  const exitCounterfactualByTraceId = new Map<
    string,
    Array<{
      version: string;
      reductionId: number | null;
      positionId: number | null;
      exitReason: ExitCounterfactualExitReason | null;
      exitAtMs: number | null;
      labelAvailableAtMs: number | null;
      horizonMinutes: number;
      classification:
        | "EXIT_CONFIRMED"
        | "EXIT_EARLY"
        | "EXIT_LATE"
        | "INCONCLUSIVE";
      pathOutcome: "EXIT_CONFIRMED" | "EXIT_EARLY" | "INCONCLUSIVE";
      executionTiming: "ON_TIME" | "LATE" | "UNAVAILABLE";
      directionReturnPercent: number | null;
      postExitMfePercent: number | null;
      postExitMaePercent: number | null;
      materialMovePercent: number | null;
      postExitVolumeRatio: number | null;
      favorableBeforeAdverse: boolean | null;
      tailWaveReasonCode: string | null;
      historicalLabelOnly: true;
      sampleKey: string;
    }>
  >();
  for (const traceIdBatch of sqlValueBatches(uniqueTraceIds)) {
    const eventRows = await db
      .select({
        traceId: strategyExecutionEvents.traceId,
        eventType: strategyExecutionEvents.eventType,
        detailJson: strategyExecutionEvents.detailJson,
      })
      .from(strategyExecutionEvents)
      .where(and(
        inArray(strategyExecutionEvents.traceId, traceIdBatch),
        like(
          strategyExecutionEvents.eventType,
          "POSITION_EXIT_COUNTERFACTUAL_%",
        ),
      ));
    for (const event of eventRows) {
      const detail = asRecord(parseJson(event.detailJson));
      const horizonMinutes = Number(detail.horizonMinutes);
      const classification = String(detail.classification);
      if (
        !isExitCounterfactualVersion(detail.version) ||
        !Number.isInteger(horizonMinutes) ||
        ![
          "EXIT_CONFIRMED",
          "EXIT_EARLY",
          "EXIT_LATE",
          "INCONCLUSIVE",
        ].includes(classification)
      ) continue;
      const exitReason = normalizeExitCounterfactualReason(
        detail.exitReason,
      );
      const pathOutcome = [
        "EXIT_CONFIRMED",
        "EXIT_EARLY",
        "INCONCLUSIVE",
      ].includes(String(detail.pathOutcome))
        ? String(detail.pathOutcome) as
          | "EXIT_CONFIRMED"
          | "EXIT_EARLY"
          | "INCONCLUSIVE"
        : classification === "EXIT_CONFIRMED" ||
            classification === "EXIT_EARLY"
          ? classification
          : "INCONCLUSIVE";
      const executionTiming = ["ON_TIME", "LATE", "UNAVAILABLE"].includes(
          String(detail.executionTiming),
        )
        ? String(detail.executionTiming) as "ON_TIME" | "LATE" | "UNAVAILABLE"
        : classification === "EXIT_LATE"
          ? "LATE"
          : "UNAVAILABLE";
      const reductionId = positiveIntegerOrNull(detail.reductionId);
      const positionId = positiveIntegerOrNull(detail.positionId);
      const checkpoints = exitCounterfactualByTraceId.get(event.traceId) ?? [];
      checkpoints.push({
        version: String(detail.version),
        reductionId,
        positionId,
        exitReason,
        exitAtMs: finiteNumberOrNull(detail.exitAtMs),
        labelAvailableAtMs: finiteNumberOrNull(detail.labelAvailableAtMs),
        horizonMinutes,
        classification: classification as
          | "EXIT_CONFIRMED"
          | "EXIT_EARLY"
          | "EXIT_LATE"
          | "INCONCLUSIVE",
        pathOutcome,
        executionTiming,
        directionReturnPercent: finiteNumberOrNull(
          detail.directionReturnPercent,
        ),
        postExitMfePercent: finiteNumberOrNull(detail.postExitMfePercent),
        postExitMaePercent: finiteNumberOrNull(detail.postExitMaePercent),
        materialMovePercent: finiteNumberOrNull(detail.materialMovePercent),
        postExitVolumeRatio: finiteNumberOrNull(detail.postExitVolumeRatio),
        favorableBeforeAdverse:
          typeof detail.favorableBeforeAdverse === "boolean"
            ? detail.favorableBeforeAdverse
            : null,
        tailWaveReasonCode: String(detail.tailWaveReasonCode ?? "").trim() ||
          null,
        historicalLabelOnly: true,
        sampleKey: reductionId === null
          ? `${event.traceId}:EXIT_COUNTERFACTUAL:${horizonMinutes}`
          : `${event.traceId}:EXIT_COUNTERFACTUAL:${reductionId}:${horizonMinutes}`,
      });
      exitCounterfactualByTraceId.set(event.traceId, checkpoints);
    }
  }
  const explorationPositionGateReplay = analyzeExplorationPositionGateReplay({
    currentLimitPercent:
      config.marketPosition.maxPosition72hPercent ?? 35,
    rows: rows
      .filter(
        (row) =>
          row.positionId !== null &&
          row.minuteOffset === 60 &&
          (row.status === "OPEN" || row.status === "CLOSED") &&
          rowIsCausalLearningEligible(row) &&
          strategyBranchFamily(
            entryEvidenceForRow(row),
          ) === "PRIMARY",
      )
      .map((row) => {
        const entryEvidence = entryEvidenceForRow(row);
        const exploration = asRecord(entryEvidence.explorationOrderFirst);
        const clusterId = entryEvidence.marketClusterId;
        const position72hPercent = entryEvidence.position72hPercent;
        return {
          clusterId:
            typeof clusterId === "string" && clusterId.trim()
              ? clusterId
              : null,
          symbol: row.symbol,
          orderFirst:
            [
              "EXPLORATION_10",
              "EXPLORATION_100",
              "EXPLORATION_150",
              "DAILY_REINFORCEMENT",
            ].includes(
              String(exploration.phase),
            ) &&
            [
              "DEFERRED_TO_POST_ENTRY",
              "PARTIAL_DEFERRED_TO_POST_ENTRY",
            ].includes(String(exploration.preEntryTechnicalAnalysis)),
          position72hPercent:
            typeof position72hPercent === "number" &&
              Number.isFinite(position72hPercent)
              ? position72hPercent
              : null,
          roe60mPercent:
            typeof row.roePercent === "number" &&
              Number.isFinite(row.roePercent)
              ? row.roePercent
              : null,
        };
      }),
  });
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    // Late or stale observations remain queryable for historical diagnosis,
    // but cannot participate in live outcome statistics or draft parameters.
    if (!rowIsCausalLearningEligible(row)) continue;
    const rowLearningScope = resolveStrategyTerminalLearningScope({
      triggerKind: row.triggerKind,
      triggerVersion: row.triggerVersion,
      entryEvidence: entryEvidenceForRow(row),
    });
    if (
      !rowLearningScope ||
      !sameStrategyTerminalLearningScope(
        targetLearningScope,
        rowLearningScope,
      )
    ) continue;
    const group = grouped.get(row.traceId) ?? [];
    group.push(row);
    grouped.set(row.traceId, group);
  }
  const groupedSamples = [...grouped.values()];
  // Historical mark-price Kline backfills are exact counterfactual price paths,
  // but they are not live causal observations. Keep them out of the normal
  // learning pool and build a separate sentinel-only validation stream.
  const sentinelShadowGroups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (
      row.status !== "MISSED" ||
      !isDecisionAnchoredCounterfactualEvidence(row.evidenceJson)
    ) continue;
    const rowLearningScope = resolveStrategyTerminalLearningScope({
      triggerKind: row.triggerKind,
      triggerVersion: row.triggerVersion,
      entryEvidence: entryEvidenceForRow(row),
    });
    if (
      !rowLearningScope ||
      !sameStrategyTerminalLearningScope(
        targetLearningScope,
        rowLearningScope,
      )
    ) continue;
    const group = sentinelShadowGroups.get(row.traceId) ?? [];
    group.push(row);
    sentinelShadowGroups.set(row.traceId, group);
  }
  const sentinelShadowValidations = [...sentinelShadowGroups.values()].map(
    (samples) => {
      const first = samples[0];
      return buildNexusSentinelShadowEntryValidation({
        observationMode: "REJECTED_COUNTERFACTUAL",
        triggerKind: first?.triggerKind,
        positionSide: positionSideForRow(first),
        rejectionCode: first?.resultCode,
        firstTakeProfitRoePercent:
          config.risk.takeProfitSteps[0]?.profitPercent ?? 0,
        stopLossRoePercent: config.risk.stopLossPercent,
        checkpoints: samples.map((sample) => {
          const detail = observationEvidenceForRow(sample);
          return {
            ...sample,
            firstTakeProfitMinute: finiteNumberOrNull(
              detail.firstTakeProfitMinute,
            ),
            firstStopLossMinute: finiteNumberOrNull(
              detail.firstStopLossMinute,
            ),
          };
        }),
      });
    },
  );
  const positionIds = [...new Set(
    groupedSamples
      .map((samples) => Number(samples[0]?.positionId))
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
  const positions: Array<typeof livePositions.$inferSelect> = [];
  const reductions: Array<Pick<
    typeof livePositionReductions.$inferSelect,
    "positionId" | "quantity" | "reason" | "realizedPnl" | "responseJson"
  >> = [];
  for (const positionIdBatch of sqlValueBatches(positionIds)) {
    const [positionRows, reductionRows] = await Promise.all([
      db
        .select()
        .from(livePositions)
        .where(inArray(livePositions.id, positionIdBatch)),
      db
        .select({
          positionId: livePositionReductions.positionId,
          quantity: livePositionReductions.quantity,
          reason: livePositionReductions.reason,
          realizedPnl: livePositionReductions.realizedPnl,
          responseJson: livePositionReductions.responseJson,
        })
        .from(livePositionReductions)
        .where(inArray(livePositionReductions.positionId, positionIdBatch)),
    ]);
    positions.push(...positionRows);
    reductions.push(...reductionRows);
  }
  const positionMap = new Map(positions.map((position) => [position.id, position]));
  const reductionsByPosition = new Map<
    number,
    Array<{
      quantity: number;
      reason: string;
      realizedPnl: number;
      responseJson: string;
    }>
  >();
  for (const reduction of reductions) {
    const rows = reductionsByPosition.get(reduction.positionId) ?? [];
    rows.push(reduction);
    reductionsByPosition.set(reduction.positionId, rows);
  }
  const reductionPnl = new Map(
    [...reductionsByPosition].map(([positionId, rows]) => [
      positionId,
      aggregatePositionReductionCycle(rows),
    ]),
  );
  const analyses = groupedSamples.map((samples) => {
    const positionId = Number(samples[0]?.positionId);
    const position = positionMap.get(positionId);
    const realized = reductionPnl.get(positionId);
    const finalRealizedPnl = position?.status === "CLOSED"
      ? realized?.count
        ? realized.pnl
        : position.exitReason === "EXTERNAL" && position.realizedPnl === 0
          ? null
          : position.realizedPnl
      : null;
    const exactInitialMarginUsdt =
      position &&
      realized?.count &&
      realized.exactNetAvailable &&
      realized.quantity > 0 &&
      position.entryPrice > 0 &&
      position.leverage > 0
        ? position.entryPrice * realized.quantity / position.leverage
        : null;
    const finalNetRoePercent =
      finalRealizedPnl !== null &&
      exactInitialMarginUsdt !== null &&
      exactInitialMarginUsdt > 0
        ? finalRealizedPnl / exactInitialMarginUsdt * 100
        : null;
    const lifetimeBestRoePercent =
      position?.favorablePrice &&
      position.favorablePrice > 0
        ? positionRoePercent(
            position.entryPrice,
            position.favorablePrice,
            position.leverage,
            position.positionSide,
          )
        : null;
    const holdingDurationMinutes =
      position?.status === "CLOSED" &&
      position.closedAt
        ? Math.max(
            0,
            (position.closedAt.getTime() - position.openedAt.getTime()) /
              60_000,
          )
        : null;
    return analyzePostEntryPerformance({
      config,
      symbol: samples[0]?.symbol ?? null,
      entryEvidence: entryEvidenceForRow(samples[0]),
      samples,
      decisionAtMs: samples[0]?.eventTime?.getTime() ?? null,
      positionSide: positionSideForRow(samples[0]),
      observationMode: samples.every((sample) => sample.status === "MISSED")
        ? "REJECTED_COUNTERFACTUAL"
        : "ACTUAL_POSITION",
      rejectionCode: samples.every((sample) => sample.status === "MISSED")
        ? samples[0]?.resultCode
        : null,
      finalRealizedPnl,
      finalPnlExact: Boolean(realized?.exactNetAvailable),
      finalNetRoePercent,
      lifetimeBestRoePercent,
      holdingDurationMinutes,
      reductionReasons: realized?.reasons ?? [],
      reductionAttributions: realized?.attributions ?? [],
      finalExitReason: position?.status === "CLOSED" ? position.exitReason : null,
    });
  });
  let learningCycles: NexusLearningCycle[] = groupedSamples.map((samples, analysisIndex) => {
    const positionId = Number(samples[0]?.positionId);
    const position = positionMap.get(positionId);
    const realized = reductionPnl.get(positionId);
    const rejectedCounterfactual = samples.every(
      (sample) => sample.status === "MISSED",
    );
    const manualIntervention =
      position?.exitReason === "MANUAL" ||
      Boolean(realized?.reasons.includes("MANUAL"));
    const path = manualIntervention
      ? "MANUAL_INTERVENTION" as const
      : rejectedCounterfactual
        ? "REJECTED_COUNTERFACTUAL" as const
        : "ACTUAL_POSITION" as const;
    const exactNetAvailable =
      Boolean(realized?.exactNetAvailable) &&
      position?.status === "CLOSED";
    const terminalObservationMinute =
      position?.status === "CLOSED" && position.closedAt
        ? strategyTerminalObservationMinute(
            position.openedAt,
            position.closedAt,
          )
        : null;
    const analysis = analyses[analysisIndex];
    const entryEvidence = entryEvidenceForRow(samples[0]);
    const entryAuthorization = resolveNexusEntryAuthorization(entryEvidence, {
      allowLegacy: true,
    });
    const entryVolumeTiming = asRecord(entryEvidence.nexusVolumeTiming);
    const memoryMarketMeasures = resolveNexusBrainMemoryMarketMeasures(
      entryEvidence,
    );
    const probabilityContext = nexusProbabilityContextFromEvidence(
      entryEvidence,
    );
    const retrospective = buildNexusLifecycleRetrospective({
      terminalStatus: rejectedCounterfactual
        ? "REJECTED"
        : position?.status === "CLOSED"
          ? "CLOSED"
          : "OPEN",
      exactNetAvailable,
      exactNetPnlUsdt: exactNetAvailable ? realized?.pnl ?? null : null,
      finalOutcome: analysis?.finalOutcome ?? "UNKNOWN",
      causalAttributionReady:
        analysis?.causalAttributionReady === true,
      checkpoints: samples.map((sample) => ({
        minuteOffset: sample.minuteOffset,
        roePercent: sample.roePercent,
        mfeRoePercent: sample.mfeRoePercent,
        maeRoePercent: sample.maeRoePercent,
      })),
      waveDirectionVerdict: analysis?.waveDirectionVerdict,
      waveEntryTimingVerdict: analysis?.waveEntryTimingVerdict,
      waveSummary: analysis?.waveEntryAttributionSummary,
      positionManagementStatus:
        analysis?.positionManagementDecisionOutcome.status,
      positionManagementSummary:
        analysis?.positionManagementDecisionOutcome.summary,
      fundingVolumeObservations: samples.map((sample) => {
        const evidence = observationEvidenceForRow(sample);
        const observation = asRecord(
          evidence.postEntryFundingVolumeObservation,
        );
        return {
          minuteOffset: sample.minuteOffset,
          status:
            typeof observation.status === "string"
              ? observation.status
              : null,
          summary:
            typeof observation.summary === "string"
              ? observation.summary
              : null,
        };
      }),
      entryVolumeTimingState:
        typeof entryVolumeTiming.state === "string"
          ? entryVolumeTiming.state
          : null,
      entryVolumeTimingSummary:
        typeof entryVolumeTiming.summary === "string"
          ? entryVolumeTiming.summary
          : null,
      decisionLane: rejectedCounterfactual
        ? "SHADOW_SKIP"
        : entryAuthorization.mode === "EXPLORATION_PROBE"
          ? "EXPLORATION_PROBE"
          : "CONFIRMED_ENTRY",
      holdingDurationMinutes: analysis?.holdingDurationMinutes,
      finalExitReason: analysis?.finalExitReason,
      entrySlippagePercent: analysis?.entrySlippagePercent,
      exitCounterfactual:
        exitCounterfactualByTraceId.get(samples[0]?.traceId ?? "") ?? [],
    });
    const cycle = buildNexusLearningCycle({
      brainKey: strategyIdentity.brainKey!,
      strategyId: trace.strategyId,
      configVersion: trace.configVersion,
      traceId: samples[0]?.traceId ?? "",
      path,
      orderSource: "STRATEGY",
      entryAuthorizationMode:
        entryAuthorization.mode,
      manualIntervention,
      preTradeFactIds: nexusPreTradeFactIds(
        entryEvidence,
      ),
      preTradeEvidenceIntegrity:
        nexusPreTradeEvidenceIntegrity(entryEvidence),
      checkpoints: samples.map((sample) => ({
        minuteOffset: sample.minuteOffset,
        status: sample.status,
        brainKey: strategyIdentity.brainKey,
        configVersion: sample.configVersion,
      })),
      terminalStatus: rejectedCounterfactual
        ? "REJECTED"
        : position?.status === "CLOSED"
          ? "CLOSED"
          : "OPEN",
      terminalObservationMinute,
      exactNetAvailable,
      exactNetPnlUsdt: exactNetAvailable ? realized?.pnl ?? null : null,
      terminalOutcome: rejectedCounterfactual
        ? undefined
        : {
            grossRealizedPnlUsdt: realized?.count
              ? realized.grossPnl
              : position?.exitReason === "EXTERNAL" &&
                  position.realizedPnl === 0
                ? null
                : position?.realizedPnl ?? null,
            reductionCount: realized?.count ?? 0,
            reductionAttributions: realized?.attributions ?? [],
            exitReasons: [...new Set([
              ...(realized?.reasons ?? []),
              ...(position?.exitReason ? [position.exitReason] : []),
            ])],
            holdingDurationMinutes:
              analysis?.holdingDurationMinutes ?? null,
            netSettlementStatus:
              realized?.netSettlementStatus === "UNAVAILABLE"
                ? "UNAVAILABLE"
                : "PENDING",
          },
      retrospective,
      sentinelContext: {
        accountId: strategyIdentity.accountId,
        symbol: samples[0]?.symbol ?? null,
        positionSide: positionSideForRow(samples[0]),
      },
      identityChain: nexusLearningIdentityChain({
        traceId: samples[0]?.traceId ?? "",
        configVersion: trace.configVersion,
        entryEvidence,
        entryDecisionHandoffJson:
          position?.entryDecisionHandoffJson ?? null,
        positionId: position?.id ?? null,
        exactNetAvailable,
      }),
      additionalSourceSampleKeys:
        (exitCounterfactualByTraceId.get(samples[0]?.traceId ?? "") ?? [])
          .map((item) => item.sampleKey),
    });
    const memoryCase = createNexusBrainMemoryCase({
      accountId: strategyIdentity.accountId,
      brainKey: strategyIdentity.brainKey!,
      configVersion: trace.configVersion,
      traceId: samples[0]?.traceId ?? "",
      symbol: samples[0]?.symbol,
      direction: positionSideForRow(samples[0]),
      decisionPath: retrospective.opportunityLifecycle.decisionLane,
      marketContextKey: nexusLearningMarketContextKey(entryEvidence),
      probabilityDecisionPath:
        probabilityContext.decisionPath === "UNKNOWN"
          ? retrospective.opportunityLifecycle.decisionLane
          : probabilityContext.decisionPath,
      probabilityMarketContextKey: probabilityContext.marketContextKey,
      volatilityRegime: memoryText(entryEvidence, [
        "volatilityRegime",
        "marketVolatilityRegime",
      ]),
      liquidityRegime: memoryText(entryEvidence, [
        "liquidityRegime",
        "marketLiquidityRegime",
      ]),
      liquidationDirection: memoryText(entryEvidence, [
        "liquidationDirection",
        "triggerDirection",
      ]),
      position24hPercent: memoryNumber(entryEvidence, ["position24hPercent"]),
      position72hPercent: memoryNumber(entryEvidence, ["position72hPercent"]),
      relativeVolume: memoryMarketMeasures.relativeVolume,
      liquidationNotionalUsdt:
        memoryMarketMeasures.liquidationNotionalUsdt,
      exactNetPnlUsdt: exactNetAvailable ? realized?.pnl ?? null : null,
      exactNetRoePercent: analysis?.finalNetRoePercent ?? null,
      observedPnlUsdt: cycle.fastLearning?.observedPnlUsdt ?? null,
      observedPnlBasis:
        cycle.fastLearning?.pnlBasis ?? "UNAVAILABLE",
      terminalExitReasons: cycle.fastLearning?.exitReasons ?? [],
      fastLearningStatus:
        cycle.fastLearning?.status ?? "UNAVAILABLE",
      eligibility: cycle.eligibility,
      completedAt: position?.closedAt ?? null,
    });
    return { ...cycle, memoryCase };
  });
  try {
    const priorCases = await loadNexusBrainMemoryCasesForAccount(
      strategyIdentity.ownerEmail,
      strategyIdentity.accountId,
    );
    const currentBatchCases = learningCycles.flatMap((cycle) =>
      cycle.memoryCase ? [cycle.memoryCase] : []
    );
    learningCycles = learningCycles.map((cycle) =>
      cycle.memoryCase
        ? attachNexusBrainCollaborationMemory(
            cycle,
            buildNexusBrainCollaborationMemory({
              target: cycle.memoryCase,
              candidates: [...priorCases, ...currentBatchCases],
            }),
          )
        : cycle
    );
  } catch {
    // 相似案例读取失败只跳过协作记忆，不能阻断学习持久化或仓位保护。
  }
  try {
    for (const cycle of learningCycles)
      await saveNexusLearningCycle(cycle);
  } catch {
    // 学习清单持久化失败不能阻塞真实仓位保护；本轮不给参数建议。
    return;
  }
  const learningAnalyses = analyses.filter((_, index) => {
    const cycle = learningCycles[index];
    return (
      cycle?.eligibility === "ELIGIBLE" ||
      (cycle?.eligibility === "OBSERVATION_ONLY" &&
        cycle.path === "REJECTED_COUNTERFACTUAL")
    );
  });
  const currentAnalysisIndex = groupedSamples.findIndex(
    (samples) => samples[0]?.traceId === trace.traceId,
  );
  const currentDecisionOutcome =
    currentAnalysisIndex >= 0
      ? analyses[currentAnalysisIndex]?.positionManagementDecisionOutcome
      : null;
  const currentLearningFeedback =
    currentAnalysisIndex >= 0
      ? learningCycles[currentAnalysisIndex]?.feedback
      : null;
  const currentLearningAttribution =
    currentAnalysisIndex >= 0
      ? learningCycles[currentAnalysisIndex]?.retrospective?.causalAttribution
      : null;
  const currentCollaborationMemory =
    currentAnalysisIndex >= 0
      ? learningCycles[currentAnalysisIndex]?.collaborationMemory
      : null;
  if (
    currentLearningFeedback?.aggregateLearningEligible &&
    currentLearningFeedback.brainSignal !== "INCOMPLETE"
  ) {
    try {
      await appendStrategyPositionManagementEvent({
        traceId: trace.traceId,
        strategyId: trace.strategyId,
        eventType:
          `LEARNING_FEEDBACK:${currentLearningFeedback.brainSignal}`,
        outcome:
          currentLearningFeedback.brainSignal === "POSITIVE_REINFORCEMENT"
            ? "PASSED"
            : currentLearningFeedback.brainSignal === "CORRECTIVE_FEEDBACK"
              ? "REJECTED"
              : "INFO",
        message: [
          currentLearningFeedback.summary,
          currentLearningAttribution?.summary,
          currentCollaborationMemory?.summary,
        ].filter(Boolean).join(" "),
        detail: {
          feedback: currentLearningFeedback,
          causalAttribution: currentLearningAttribution,
          collaborationMemory: currentCollaborationMemory,
        },
        eventAt: new Date(),
      });
    } catch {
      // 反馈日志失败不能阻塞仓位保护；学习周期本身已经持久化。
    }
  }
  if (
    currentDecisionOutcome &&
    currentDecisionOutcome.comparisonMinute !== null &&
    !["NO_SIGNAL", "INCOMPLETE"].includes(currentDecisionOutcome.status)
  ) {
    try {
      await appendStrategyPositionManagementEvent({
        traceId: trace.traceId,
        strategyId: trace.strategyId,
        eventType:
          `POSITION_DECISION_OUTCOME:${currentDecisionOutcome.comparisonMinute}`,
        outcome:
          currentDecisionOutcome.status === "SUPPORTED"
            ? "PASSED"
            : currentDecisionOutcome.status === "CONTRADICTED"
              ? "REJECTED"
              : "INFO",
        message: currentDecisionOutcome.summary,
        detail: currentDecisionOutcome,
        eventAt: new Date(),
      });
    } catch {
      // 后验日志写入失败不影响学习计算，更不能阻塞实盘风控。
    }
  }
  const completedExactNetOrders = learningCycles.filter(
    (cycle) => cycle.eligibility === "ELIGIBLE",
  ).length;
  const explorationTraceRows = await db
    .select({
      state: strategyExecutionTraces.state,
      positionId: strategyExecutionTraces.positionId,
      exchangeOrderId: strategyExecutionTraces.exchangeOrderId,
      createdAt: strategyExecutionTraces.createdAt,
    })
    .from(strategyExecutionTraces)
    .where(eq(strategyExecutionTraces.strategyId, trace.strategyId))
    .limit(10_000);
  const committedEntryOrders = committedStrategyEntryCount(
    explorationTraceRows,
  );
  const modelPhase = strategyModelPhase({
    committedEntryOrders,
    dailyCommittedEntryOrders:
      committedStrategyEntryCountForTradingDay(explorationTraceRows),
    completedExactNetOrders,
  });
  const dailyReinforcement = buildNexusDailyReinforcement({
    samples: learningCycles.map((cycle, index) => {
      const firstSample = groupedSamples[index]?.[0];
      const positionId = Number(firstSample?.positionId);
      const position = positionMap.get(positionId);
      const entryEvidence = entryEvidenceForRow(firstSample);
      return {
        cycle,
        observedAt:
          position?.closedAt ??
          firstSample?.sampledAt ??
          firstSample?.eventTime ??
          new Date(0),
        marketContextKey:
          nexusLearningMarketContextKey(entryEvidence),
      };
    }),
  });
  const crossDayReinforcement = buildNexusCrossDayReinforcement({
    daily: dailyReinforcement,
  });
  const evidenceReliabilityMemory = buildNexusEvidenceReliabilityMemory({
    samples: learningCycles.map((cycle, index) => {
      const firstSample = groupedSamples[index]?.[0];
      const entryEvidence = entryEvidenceForRow(firstSample);
      return {
        cycle,
        marketContextKey:
          cycle.memoryCase?.marketContextKey ??
          nexusLearningMarketContextKey(entryEvidence),
      };
    }),
  });
  const evidenceTemporalSamples = learningCycles.map((cycle, index) => {
    const firstSample = groupedSamples[index]?.[0];
    const positionId = Number(firstSample?.positionId);
    const position = positionMap.get(positionId);
    const entryEvidence = entryEvidenceForRow(firstSample);
    return {
      cycle,
      observedAt:
        position?.closedAt ??
        firstSample?.sampledAt ??
        firstSample?.eventTime ??
        new Date(0),
      marketContextKey:
        cycle.memoryCase?.marketContextKey ??
        nexusLearningMarketContextKey(entryEvidence),
    };
  });
  const currentLearningCycle =
    currentAnalysisIndex >= 0 ? learningCycles[currentAnalysisIndex] : null;
  const currentMemoryCase = currentLearningCycle?.memoryCase ?? null;
  const similarContextReview =
    currentLearningCycle &&
      currentMemoryCase &&
      currentLearningCycle.learningLane !== "OBSERVATION" &&
      (currentMemoryCase.direction === "LONG" ||
        currentMemoryCase.direction === "SHORT")
      ? buildNexusSimilarContextReview({
          target: {
            brainKey: currentLearningCycle.brainKey,
            configVersion: currentLearningCycle.configVersion,
            direction: currentMemoryCase.direction,
            learningLane: currentLearningCycle.learningLane,
            marketContextKey: currentMemoryCase.marketContextKey,
          },
          memories: evidenceReliabilityMemory,
        })
      : null;
  const evidenceRegimeContrast =
    currentLearningCycle &&
      currentMemoryCase &&
      currentLearningCycle.learningLane !== "OBSERVATION" &&
      (currentMemoryCase.direction === "LONG" ||
        currentMemoryCase.direction === "SHORT")
      ? buildNexusEvidenceRegimeContrast({
          target: {
            brainKey: currentLearningCycle.brainKey,
            configVersion: currentLearningCycle.configVersion,
            direction: currentMemoryCase.direction,
            learningLane: currentLearningCycle.learningLane,
            marketContextKey: currentMemoryCase.marketContextKey,
          },
          memories: evidenceReliabilityMemory,
        })
      : null;
  const evidenceTemporalDrift =
    currentLearningCycle &&
      currentMemoryCase &&
      currentLearningCycle.learningLane !== "OBSERVATION" &&
      (currentMemoryCase.direction === "LONG" ||
        currentMemoryCase.direction === "SHORT")
      ? buildNexusEvidenceTemporalDrift({
          target: {
            brainKey: currentLearningCycle.brainKey,
            configVersion: currentLearningCycle.configVersion,
            direction: currentMemoryCase.direction,
            learningLane: currentLearningCycle.learningLane,
            marketContextKey: currentMemoryCase.marketContextKey,
          },
          samples: evidenceTemporalSamples,
        })
      : null;
  const evidenceConfidenceDecay = evidenceTemporalDrift && currentMemoryCase
    ? buildNexusEvidenceConfidenceDecay({
        target: {
          brainKey: evidenceTemporalDrift.brainKey,
          configVersion: evidenceTemporalDrift.configVersion,
          direction: evidenceTemporalDrift.direction,
          learningLane: evidenceTemporalDrift.learningLane,
          marketContextKey: currentMemoryCase.marketContextKey,
        },
        memories: evidenceReliabilityMemory,
        temporalDrift: evidenceTemporalDrift,
      })
    : null;
  const threeMinuteRoundConfig =
    config.trigger.kind === "THREE_MINUTE_PROBABILITY"
      ? config.trigger.threeMinuteProbability ?? null
      : null;
  const threeMinuteParameterCandidate = threeMinuteRoundConfig
    ? buildThreeMinuteParameterCandidate({
        currentMinimumProbabilityPercent:
          threeMinuteRoundConfig.minimumProbabilityPercent,
        currentMinimumNetEdgeBps:
          threeMinuteRoundConfig.minimumNetEdgeBps,
        batchSize: threeMinuteRoundConfig.batchSize,
        samples: groupedSamples.flatMap((samples, index) => {
          const analysis = analyses[index];
          if (
            analysis?.finalPnlBasis !== "NET_EXACT" ||
            analysis.finalNetRoePercent === null
          ) return [];
          const entryEvidence = entryEvidenceForRow(samples[0]);
          const probability = asRecord(
            entryEvidence.threeMinuteProbability,
          );
          const pLongPercent = Number(probability.pLongPercent);
          const pShortPercent = Number(probability.pShortPercent);
          const netEdgeBps = Number(probability.netEdgeBps);
          if (
            !Number.isFinite(pLongPercent) ||
            !Number.isFinite(pShortPercent) ||
            !Number.isFinite(netEdgeBps)
          ) return [];
          return [{
            selectedProbabilityPercent: Math.max(
              pLongPercent,
              pShortPercent,
            ),
            netEdgeBps,
            exactNetRoePercent: analysis.finalNetRoePercent,
            completedAtMs:
              positionMap.get(Number(samples[0]?.positionId))
                ?.closedAt?.getTime() ?? 0,
          }];
        }),
      })
    : null;
  const threeMinuteShadowSummary = threeMinuteRoundConfig
    ? summarizeThreeMinuteShadowOutcomes(
        [...sentinelShadowGroups.values()].flatMap((samples) => {
          const sample = samples.find((row) => row.minuteOffset === 3);
          if (!sample) return [];
          const detail = observationEvidenceForRow(sample);
          if (
            detail.sampleType !==
              "THREE_MINUTE_OBSERVE_ONLY_COUNTERFACTUAL" ||
            detail.exactNetAvailable !== false
          ) return [];
          const entryEvidence = entryEvidenceForRow(sample);
          const probability = asRecord(entryEvidence.threeMinuteProbability);
          const pLongPercent = Number(probability.pLongPercent);
          const pShortPercent = Number(probability.pShortPercent);
          const netEdgeBps = Number(probability.netEdgeBps);
          const estimatedNetRoePercent = Number(
            detail.estimatedNetRoePercent,
          );
          if (
            !Number.isFinite(pLongPercent) ||
            !Number.isFinite(pShortPercent) ||
            !Number.isFinite(netEdgeBps) ||
            !Number.isFinite(estimatedNetRoePercent)
          ) return [];
          return [{
            selectedProbabilityPercent: Math.max(
              pLongPercent,
              pShortPercent,
            ),
            netEdgeBps,
            estimatedNetRoePercent,
          }];
        }),
      )
    : null;
  let aggregateCandidates: ReturnType<
    typeof buildAggregateParameterSuggestions
  > = threeMinuteRoundConfig
    ? [
        ...(threeMinuteParameterCandidate ? [threeMinuteParameterCandidate] : []),
        ...(threeMinuteShadowSummary
          ? [{
              parameterName: "learning.threeMinuteObserveOnlyShadow",
              label: "3分钟观察影子费用后结果",
              currentValue: threeMinuteShadowSummary,
              suggestedValue:
                threeMinuteShadowSummary.sampleCount >=
                    threeMinuteRoundConfig.batchSize &&
                  threeMinuteShadowSummary.meanEstimatedNetRoePercent > 0
                  ? "REVIEW_NEXT_CALIBRATION_BATCH"
                  : "KEEP_OBSERVING_WITHOUT_LIVE_ORDERS",
              action: "OBSERVE" as const,
              confidence: Math.min(
                0.9,
                threeMinuteShadowSummary.sampleCount /
                  threeMinuteRoundConfig.batchSize,
              ),
              reason:
                `已形成 ${threeMinuteShadowSummary.sampleCount} 个独立3分钟影子结果，` +
                `费用后估算胜率 ${threeMinuteShadowSummary.winRatePercent.toFixed(1)}%，` +
                `平均费用后ROE ${threeMinuteShadowSummary.meanEstimatedNetRoePercent.toFixed(3)}%。` +
                "该经验不含真实成交与精确费用，只用于运营复核和下一批校准建议，禁止自动修改正式参数。",
            }]
          : []),
      ]
    : buildAggregateParameterSuggestions({
        config,
        analyses: learningAnalyses,
        sentinelShadowValidations,
        minimumOrders: STRATEGY_LEARNING_SAMPLE_TARGET,
      });
  const confirmedExperienceRows = targetBranchFamily === "PRIMARY"
    ? await db
        .select({
          learningKey: strategyLearningReviews.learningKey,
          decision: strategyLearningReviews.decision,
          promotionStatus: strategyLearningReviews.promotionStatus,
          exactNetAvailable: strategyLearningReviews.exactNetAvailable,
          exactNetPnlUsdt: strategyLearningReviews.exactNetPnlUsdt,
          eligibility: strategyLearningCycles.eligibility,
          manualIntervention: strategyLearningCycles.manualIntervention,
          detailJson: strategyLearningCycles.detailJson,
          reviewedAtMs: strategyLearningReviews.updatedAt,
        })
        .from(strategyLearningReviews)
        .innerJoin(
          strategyLearningCycles,
          eq(
            strategyLearningReviews.learningKey,
            strategyLearningCycles.learningKey,
          ),
        )
        .where(and(
          eq(strategyLearningReviews.strategyId, trace.strategyId),
          eq(strategyLearningReviews.brainKey, strategyIdentity.brainKey),
          eq(strategyLearningReviews.configVersion, trace.configVersion),
          eq(strategyLearningReviews.decision, "CONFIRMED"),
          eq(strategyLearningCycles.configVersion, trace.configVersion),
        ))
        .orderBy(desc(strategyLearningReviews.updatedAt))
        .limit(200)
    : [];
  const failedCandidateRows = targetBranchFamily === "PRIMARY"
    ? await db
        .select({
          parameterName: strategyParameterSuggestions.parameterName,
          suggestedValueJson:
            strategyParameterSuggestions.suggestedValueJson,
          evidenceJson: strategyParameterSuggestions.evidenceJson,
        })
        .from(strategyParameterSuggestions)
        .where(and(
          eq(strategyParameterSuggestions.strategyId, trace.strategyId),
          eq(strategyParameterSuggestions.status, "REJECTED"),
        ))
        .orderBy(desc(strategyParameterSuggestions.reviewedAt))
        .limit(50)
    : [];
  const experienceCandidates = buildNexusExperienceParameterSuggestions({
    config,
    experiences: confirmedExperienceRows.map((experience) => ({
      ...experience,
      reviewedAtMs: experience.reviewedAtMs.getTime(),
    })),
    failedCandidates: failedCandidateRows.flatMap((candidate) => {
      const decision = asRecord(
        asRecord(parseJson(candidate.evidenceJson)).validationDecision,
      );
      return decision.status === "ROLLED_BACK"
        ? [{
            parameterName: candidate.parameterName,
            suggestedValue: parseJson(candidate.suggestedValueJson),
            failedAtMs: new Date(
              String(decision.rolledBackAt ?? ""),
            ).getTime(),
          }]
        : [];
    }),
  });
  const experienceCandidateByParameter = new Map(
    experienceCandidates.map((candidate) => [
      candidate.parameterName,
      candidate.experienceConsumption,
    ]),
  );
  if (experienceCandidates.length) {
    const parameterNames = new Set(
      experienceCandidates.map((candidate) => candidate.parameterName),
    );
    aggregateCandidates = [
      ...aggregateCandidates.filter(
        (candidate) => !parameterNames.has(candidate.parameterName),
      ),
      ...experienceCandidates,
    ];
  }
  const opportunityLifecycleSummary = summarizeNexusOpportunityLifecycles(
    learningCycles.map(
      (cycle) => cycle.retrospective?.opportunityLifecycle ?? null,
    ),
  );
  aggregateCandidates.push({
    parameterName: "learning.opportunityLifecycle",
    label: "机会全周期与跳过反事实",
    currentValue: opportunityLifecycleSummary,
    suggestedValue: "OBSERVE_FOUR_OUTCOMES",
    action: "OBSERVE",
    confidence: Math.min(1, opportunityLifecycleSummary.sampleCount / 30),
    reason:
      `统一周期 ${opportunityLifecycleSummary.sampleCount} 个：` +
      `交易盈利 ${opportunityLifecycleSummary.tradeProfits}、交易亏损 ${opportunityLifecycleSummary.tradeLosses}、` +
      `跳过后本可盈利 ${opportunityLifecycleSummary.missedOpportunities}、跳过后避免亏损 ${opportunityLifecycleSummary.correctFilters}。` +
      `平均 MFE ${opportunityLifecycleSummary.averageMfeRoePercent ?? "—"}%、` +
      `平均 MAE ${opportunityLifecycleSummary.averageMaeRoePercent ?? "—"}%、` +
      `平均峰值回吐 ${opportunityLifecycleSummary.averagePeakGivebackRoePoints ?? "—"} 个ROE点。` +
      "该结果只进入大脑记忆和运营建议，不以单周期结果自动修改实盘参数。",
  });
  const latestDailyReinforcementByLane = dailyReinforcement.filter(
    (item, index, rows) =>
      rows.findIndex(
        (candidate) => candidate.learningLane === item.learningLane,
      ) === index,
  );
  for (const latestDailyReinforcement of latestDailyReinforcementByLane)
    aggregateCandidates.push({
      parameterName:
        latestDailyReinforcement.learningLane === "EXPLORATION_PROBE"
          ? "learning.probeDailyReinforcement"
          : "learning.dailyReinforcement",
      label:
        latestDailyReinforcement.learningLane === "EXPLORATION_PROBE"
          ? "每日探针验证反馈"
          : "每日正常策略强化反馈",
      currentValue: latestDailyReinforcement,
      suggestedValue: latestDailyReinforcement.signal,
      action: "OBSERVE",
      confidence: Math.min(
        1,
        latestDailyReinforcement.eligibleCycles /
          latestDailyReinforcement.independentSampleThreshold,
      ),
      reason:
        `${latestDailyReinforcement.summary} ` +
        (latestDailyReinforcement.learningLane === "EXPLORATION_PROBE"
          ? "该反馈只验证探针路径与眼睛证据，不进入正常策略参数样本。"
          : "该反馈只使用确认后的正常策略完整周期。") +
        " 按 Asia/Shanghai 交易日和当日市场环境隔离，不直接改参数或下单。",
    });
  for (const [index, item] of crossDayReinforcement.slice(0, 6).entries())
    aggregateCandidates.push({
      parameterName:
        `learning.crossDayReinforcement.${item.learningLane}.${index + 1}`,
      label:
        `${item.learningLane === "EXPLORATION_PROBE" ? "探针" : "正常策略"}跨日市场环境记忆`,
      currentValue: item,
      suggestedValue: item.signal,
      action: "OBSERVE",
      confidence: Math.min(
        1,
        item.memoryConfidence,
      ),
      reason:
        `${item.summary} 只汇总已经完成单日独立样本门槛的结果；` +
        "过期或方向不一致的记忆自动降级为观察；跨日记忆不参与订单准入，也不能自动修改实盘参数。",
    });
  for (const [index, item] of evidenceReliabilityMemory
    .toSorted(
      (left, right) =>
        right.resolvedCycles - left.resolvedCycles ||
        right.independentCycles - left.independentCycles ||
        left.evidenceDimension.localeCompare(right.evidenceDimension),
    )
    .slice(0, 10)
    .entries())
    aggregateCandidates.push({
      parameterName:
        `learning.evidenceReliability.${item.evidenceDimension}.${index + 1}`,
      label: "眼睛证据可靠性记忆",
      currentValue: item,
      suggestedValue: item.signal,
      action: "OBSERVE",
      confidence: Math.min(
        1,
        item.resolvedCycles / item.independentSampleThreshold,
      ),
      reason: item.summary,
    });
  if (similarContextReview)
    aggregateCandidates.push({
      parameterName: "learning.similarContextReview",
      label: "相似市场环境复盘",
      currentValue: similarContextReview,
      suggestedValue: similarContextReview.status,
      action: "OBSERVE",
      confidence: Math.min(
        1,
        similarContextReview.comparisons[0]?.similarity ?? 0,
      ),
      reason: similarContextReview.summary,
    });
  if (evidenceRegimeContrast)
    aggregateCandidates.push({
      parameterName: "learning.evidenceRegimeContrast",
      label: "眼睛证据跨环境稳定性",
      currentValue: evidenceRegimeContrast,
      suggestedValue: evidenceRegimeContrast.status,
      action: "OBSERVE",
      confidence: Math.min(
        1,
        (evidenceRegimeContrast.regimeDependentDimensions +
          evidenceRegimeContrast.stableDimensions) / 5,
      ),
      reason: evidenceRegimeContrast.summary,
    });
  if (evidenceTemporalDrift)
    aggregateCandidates.push({
      parameterName: "learning.evidenceTemporalDrift",
      label: "眼睛证据近期漂移",
      currentValue: evidenceTemporalDrift,
      suggestedValue: evidenceTemporalDrift.status,
      action: "OBSERVE",
      confidence: Math.min(
        1,
        (evidenceTemporalDrift.weakenedDimensions +
          evidenceTemporalDrift.recoveredDimensions +
          evidenceTemporalDrift.stableDimensions) / 5,
      ),
      reason: evidenceTemporalDrift.summary,
    });
  if (evidenceConfidenceDecay)
    aggregateCandidates.push({
      parameterName: "learning.evidenceConfidenceDecay",
      label: "眼睛证据近期可信度",
      currentValue: evidenceConfidenceDecay,
      suggestedValue: evidenceConfidenceDecay.status,
      action: "OBSERVE",
      confidence: Math.min(
        1,
        evidenceConfidenceDecay.items.reduce(
          (maximum, item) => Math.max(maximum, item.effectiveConfidence),
          0,
        ),
      ),
      reason: evidenceConfidenceDecay.summary,
    });
  if (targetBranchFamily === "CONTRARIAN_PROBE") {
    aggregateCandidates = aggregateCandidates.map((suggestion) => ({
      ...suggestion,
      parameterName: `contrarian.observation.${suggestion.parameterName}`,
      label: `反向探针观察：${suggestion.label}`,
      action: "OBSERVE" as const,
      reason:
        `${suggestion.reason} 该结论只来自反向探针样本，不能覆盖正常方向策略参数。`,
    }));
  }
  if (
    targetBranchFamily === "PRIMARY" &&
    explorationPositionGateReplay.comparableClusters > 0
  ) {
    aggregateCandidates.push({
      parameterName: "pilot.exploration72hPositionGateReplay",
      label: "探索单72小时位置门槛回放",
      currentValue: explorationPositionGateReplay,
      suggestedValue:
        explorationPositionGateReplay.verdict === "SUPPORTS_CURRENT_LIMIT"
          ? "CURRENT_LIMIT_SUPPORTED_BY_EXPLORATION_REPLAY"
          : explorationPositionGateReplay.verdict ===
              "CONTRADICTS_CURRENT_LIMIT"
            ? "REVIEW_CURRENT_LIMIT_WITH_NEW_LIVE_SAMPLES"
            : "COLLECT_MORE_COMPARABLE_WAVES",
      action: "OBSERVE",
      confidence: Math.min(
        0.9,
        explorationPositionGateReplay.comparableClusters /
          explorationPositionGateReplay.minimumComparableClusters,
      ),
      reason:
        `已将实盘探索样本按爆仓波段配对回放；${explorationPositionGateReplay.comparableClusters}个波段同时存在现行72小时低位门槛会保留和会排除的合约，` +
        `组内60分钟ROE中位优势为 ${explorationPositionGateReplay.medianWithinWaveAdvantageRoePercent?.toFixed(2) ?? "—"} 个百分点。` +
        "该结果跨引擎版本仅用于观察，不计入正式胜率、精确净收益或参数变更资格。",
    });
  }
  const threeMinuteParameterOptimizationReady =
    threeMinuteParameterCandidate !== null;
  const aggregate =
    !modelPhase.parameterOptimizationReady &&
      !threeMinuteParameterOptimizationReady
      ? aggregateCandidates.filter(
          (suggestion) =>
            suggestion.action === "OBSERVE" ||
            experienceCandidateByParameter.has(suggestion.parameterName),
        )
      : aggregateCandidates;
  if (!aggregate.length) {
    const clearedAt = new Date();
    await db
      .update(strategyParameterSuggestions)
      .set({ status: "EXPIRED", reviewedAt: clearedAt })
      .where(
        and(
          eq(strategyParameterSuggestions.strategyId, trace.strategyId),
          eq(strategyParameterSuggestions.configVersion, trace.configVersion),
          eq(strategyParameterSuggestions.status, "PENDING"),
        ),
      );
    await db
      .delete(strategyParameterSuggestions)
      .where(
        and(
          eq(strategyParameterSuggestions.strategyId, trace.strategyId),
          eq(strategyParameterSuggestions.configVersion, trace.configVersion),
          eq(
            strategyParameterSuggestions.parameterName,
            "pilot.exploratoryTwoTradeDiagnostic",
          ),
          eq(strategyParameterSuggestions.status, "EXPIRED"),
        ),
      );
    return;
  }
  const completeAnalyses = analyses.filter((_, index) => {
    const cycle = learningCycles[index];
    return (
      cycle?.eligibility === "ELIGIBLE" ||
      (cycle?.eligibility === "OBSERVATION_ONLY" &&
        cycle.path === "REJECTED_COUNTERFACTUAL")
    );
  });
  const actualSampleCount = completeAnalyses.filter(
    (analysis) => analysis.observationMode === "ACTUAL_POSITION",
  ).length;
  const rejectedSampleCount = completeAnalyses.filter(
    (analysis) => analysis.observationMode === "REJECTED_COUNTERFACTUAL",
  ).length;
  const eligibleLearningCycles = learningCycles.filter(
    (cycle) => cycle.eligibility === "ELIGIBLE",
  );
  const probeLearningCycles = learningCycles.filter(
    (cycle) => cycle.probeLearningAllowed,
  );
  const learningFeedbackSummary = {
    eligibleCycles: eligibleLearningCycles.length,
    probeObservationCycles: probeLearningCycles.length,
    positiveReinforcementCycles: eligibleLearningCycles.filter(
      (cycle) => cycle.feedback.brainSignal === "POSITIVE_REINFORCEMENT",
    ).length,
    correctiveCycles: eligibleLearningCycles.filter(
      (cycle) => cycle.feedback.brainSignal === "CORRECTIVE_FEEDBACK",
    ).length,
    neutralCycles: eligibleLearningCycles.filter(
      (cycle) => cycle.feedback.brainSignal === "NEUTRAL_OBSERVATION",
    ).length,
    eyeVerifiedCycles: eligibleLearningCycles.filter(
      (cycle) => cycle.feedback.eyeCalibration === "EVIDENCE_VERIFIED",
    ).length,
    eyeContradictedCycles: eligibleLearningCycles.filter(
      (cycle) => cycle.feedback.eyeCalibration === "EVIDENCE_CONTRADICTED",
    ).length,
    probePositiveCycles: probeLearningCycles.filter(
      (cycle) => cycle.feedback.brainSignal === "POSITIVE_REINFORCEMENT",
    ).length,
    probeCorrectiveCycles: probeLearningCycles.filter(
      (cycle) => cycle.feedback.brainSignal === "CORRECTIVE_FEEDBACK",
    ).length,
    automaticLiveMutationAllowed: false,
  };
  const allSourceLearningKeys = eligibleLearningCycles
    .map((cycle) => cycle.learningKey)
    .sort();
  const allSourceLearningSampleIds = eligibleLearningCycles
    .map((cycle) => cycle.identities.learningSampleId)
    .filter(Boolean)
    .sort();
  const allSourceSampleKeys = [
    ...new Set(
      eligibleLearningCycles.flatMap((cycle) => cycle.sourceSampleKeys),
    ),
  ].sort();
  const sourceLearningKeys = allSourceLearningKeys.slice(-200);
  const sourceSampleKeys = allSourceSampleKeys.slice(-1_000);
  const now = new Date();
  const pendingSuggestions = await db
    .select({
      id: strategyParameterSuggestions.id,
      parameterName: strategyParameterSuggestions.parameterName,
      currentValueJson: strategyParameterSuggestions.currentValueJson,
      suggestedValueJson: strategyParameterSuggestions.suggestedValueJson,
      evidenceJson: strategyParameterSuggestions.evidenceJson,
    })
    .from(strategyParameterSuggestions)
    .where(
      and(
        eq(strategyParameterSuggestions.strategyId, trace.strategyId),
        eq(strategyParameterSuggestions.configVersion, trace.configVersion),
        eq(strategyParameterSuggestions.status, "PENDING"),
      ),
    )
    .orderBy(desc(strategyParameterSuggestions.id));
  const currentParameterNames = new Set(
    aggregate.map((suggestion) => suggestion.parameterName),
  );
  const pendingByParameter = new Map<
    string,
    {
      id: number;
      currentValueJson: string;
      suggestedValueJson: string;
      evidenceJson: string;
    }
  >();
  for (const pending of pendingSuggestions) {
    if (!currentParameterNames.has(pending.parameterName)) {
      await db
        .update(strategyParameterSuggestions)
        .set({ status: "EXPIRED", reviewedAt: now })
        .where(eq(strategyParameterSuggestions.id, pending.id));
      continue;
    }
    if (pendingByParameter.has(pending.parameterName)) {
      await db
        .update(strategyParameterSuggestions)
        .set({ status: "EXPIRED", reviewedAt: now })
        .where(eq(strategyParameterSuggestions.id, pending.id));
      continue;
    }
    pendingByParameter.set(pending.parameterName, pending);
  }
  // Exploration diagnostics are a live snapshot, not immutable trading
  // evidence. Old recalculation copies inflate the displayed order count and
  // obscure the one current conclusion, so remove only these expired copies.
  await db
    .delete(strategyParameterSuggestions)
    .where(
      and(
        eq(strategyParameterSuggestions.strategyId, trace.strategyId),
        eq(strategyParameterSuggestions.configVersion, trace.configVersion),
        eq(
          strategyParameterSuggestions.parameterName,
          "pilot.exploratoryTwoTradeDiagnostic",
        ),
        eq(strategyParameterSuggestions.status, "EXPIRED"),
      ),
    );
  for (const suggestion of aggregate) {
    const experienceConsumption =
      experienceCandidateByParameter.get(suggestion.parameterName) ?? null;
    const experienceLearningKeys = experienceConsumption?.sourceLearningKeys ?? [];
    const values = {
      strategyId: trace.strategyId,
      configVersion: trace.configVersion,
      // The UI labels this field as complete orders. Rejected control points
      // and repeated minute observations remain visible in evidence, but must
      // never masquerade as settled trades.
      sampleCount: threeMinuteParameterCandidate
        ? threeMinuteParameterCandidate.sampleCount
        : completedExactNetOrders,
      parameterName: suggestion.parameterName,
      currentValueJson: JSON.stringify(suggestion.currentValue),
      suggestedValueJson: JSON.stringify(suggestion.suggestedValue),
      evidenceJson: JSON.stringify({
        label: suggestion.label,
        action: suggestion.action,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        source: experienceConsumption
          ? "OPERATOR_CONFIRMED_EXACT_EXPERIENCE"
          : threeMinuteRoundConfig
            ? "THREE_MINUTE_EXACT_NET_BATCH"
            : "POST_ENTRY_5_30_60_MINUTE_COMPARISON",
        decisionEngineVersion: targetEngineVersion,
        strategyBranchFamily: targetBranchFamily,
        primaryAndContrarianSamplesMixed: false,
        learningSchemaVersion: STRATEGY_LEARNING_SCHEMA_VERSION,
        proposalMode: "DRAFT_ONLY",
        learningEligible: experienceConsumption
          ? true
          : modelPhase.parameterOptimizationReady &&
            eligibleLearningCycles.length > 0,
        sourceConfigVersion: trace.configVersion,
        targetDraftVersion:
          Math.max(
            trace.configVersion,
            strategyIdentity.draftVersion,
          ) + 1,
        sourceLearningKeys: experienceConsumption
          ? experienceLearningKeys
          : sourceLearningKeys,
        sourceLearningSampleId: allSourceLearningSampleIds.at(-1) ?? null,
        sourceLearningSampleIds: allSourceLearningSampleIds.slice(-200),
        sourceSampleKeys,
        sourceLearningKeyCount: allSourceLearningKeys.length,
        sourceSampleKeyCount: allSourceSampleKeys.length,
        learningFeedbackSummary,
        experienceConsumption,
        dailyReinforcement: dailyReinforcement.slice(0, 30),
        crossDayReinforcement: crossDayReinforcement.slice(0, 30),
        automaticPublishAllowed: false,
        liveConfigMutationAllowed: false,
        modelPhase: modelPhase.phase,
        explorationTargetOrders: modelPhase.targetOrders,
        learningTargetOrders: modelPhase.learningTargetOrders,
        committedEntryOrders: modelPhase.committedEntryOrders,
        completedExactNetOrders: modelPhase.completedExactNetOrders,
        remainingExplorationOrders: modelPhase.remainingExplorationOrders,
        remainingExactNetOrders: modelPhase.remainingExactNetOrders,
        orderFirstAllowed: modelPhase.orderFirstAllowed,
        parameterOptimizationReady:
          modelPhase.parameterOptimizationReady ||
          threeMinuteParameterOptimizationReady,
        historicalPerformanceGateApplied: false,
        observationSampleCount: completeAnalyses.length,
        actualSampleCount,
        rejectedSampleCount,
      }),
      status: "PENDING" as const,
      createdAt: now,
    };
    const existing = pendingByParameter.get(suggestion.parameterName);
    if (existing) {
      const previousAction = String(
        asRecord(parseJson(existing.evidenceJson)).action ?? "OBSERVE",
      );
      const materiallyChanged =
        existing.currentValueJson !== values.currentValueJson ||
        existing.suggestedValueJson !== values.suggestedValueJson ||
        previousAction !== suggestion.action;
      const { createdAt: _createdAt, ...refreshedValues } = values;
      void _createdAt;
      await db
        .update(strategyParameterSuggestions)
        .set(materiallyChanged ? values : refreshedValues)
        .where(eq(strategyParameterSuggestions.id, existing.id));
    } else {
      await db.insert(strategyParameterSuggestions).values(values);
    }
  }
}

function nexusLearningMarketContextKey(
  entryEvidence: Record<string, unknown>,
) {
  return buildNexusLearningMarketContext(entryEvidence).key;
}

function memoryNumber(
  record: Record<string, unknown>,
  keys: string[],
) {
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function memoryText(
  record: Record<string, unknown>,
  keys: string[],
) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { return {}; }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
