import { env } from "cloudflare:workers";
import {
  mapWithConcurrency,
  NEXUS_MARKET_ANALYSIS_CONCURRENCY,
} from "../../../../lib/bounded-concurrency";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
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
  getBinanceLiveContractRule,
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
  classifyNexusMarketRegimeFromCandles,
  nexusMarketRegimeLabel,
} from "../../../../lib/nexus-market-regime";
import {
  calculateNexusClosedEntryRelativeVolume,
  decideNexusMarketEye,
  type NexusMarketEyeDecision,
} from "../../../../lib/nexus-market-eye-decision";
import {
  analyzeNexusVolumeTimingConcordance,
  buildNexusPreTriggerVolumeReference,
  type NexusVolumeTimingConcordance,
} from "../../../../lib/nexus-volume-timing-concordance";
import {
  adverseFundingCostRate,
  analyzeNexusFundingContext,
  type NexusFundingContext,
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
import { getCoinGlassWebLiquidationContext } from "../../../../lib/coinglass-web-liquidations";
import {
  analyzeShortBreakRetest,
  analyzeShortMarket60m,
  evaluateShortDowntrendContinuation,
  resolveShortLiquidationMarketContext,
  SHORT_DOWNTREND_STRATEGY_VERSION,
} from "../../../../lib/short-downtrend-continuation";
import {
  normalizeShortContinuationStrategyConfig,
  validateShortContinuationStrategyConfig,
} from "../../../../lib/short-continuation-config";
import { shortMonitorIdleDiagnostic } from
  "../../../../lib/strategy-monitor-diagnostics";
import {
  effectiveStrategyEntryOrderTtlMs,
  type LiquidationTrendConfig,
  resolveLiquidationTrendConfig,
} from "../../../../lib/liquidation-trend-config";
import { filterContractsByStrategyAssetScope } from
  "../../../../lib/strategy-asset-scope";
import { resolveNexusTradingArchitecture } from "../../../../lib/nexus-trading-architecture";
import {
  evaluateNexusNetExpectancy,
  nexusProbabilityExplorationAllowed,
  resolveNexusProbabilityEntryExecution,
} from "../../../../lib/nexus-net-expectancy";
import { loadNexusProbabilityContext } from "../../../../lib/nexus-net-expectancy-store";
import { nexusProbabilityContextFromEvidence } from
  "../../../../lib/nexus-probability-context";
import {
  resolveStrategyEntryTimingProfile,
  selectTradfiEntryTimingCandidates,
  type TradfiTimingSelectionEvidence,
} from "../../../../lib/strategy-entry-timing";
import {
  isPrimaryLiquidityMarket,
  partitionMarketLiquidity,
} from "../../../../lib/market-liquidity-priority";
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
  MAX_FROZEN_EXECUTION_RENEWALS,
  renewFrozenExecutionDecision,
  resolveFrozenExecutionDeadline,
  resolveFrozenExecutionIntentExpiry,
} from "../../../../lib/nexus-frozen-execution-window.mjs";
import {
  buildPilotRiskPlan,
  capRiskSizedEntryToConfiguredMargin,
  configuredShortEntryOrder,
  LIQUIDATION_PILOT_LIMITS,
  smallestPilotQuantity,
} from "../../../../lib/liquidation-live-execution";
import { revalidateNexusConfirmedShortEntry } from "../../../../lib/liquidation-entry-revalidation";
import { nexusEntryWaitDisposition } from "../../../../lib/nexus-entry-wait-policy";
import {
  credentialContext,
  decryptCredential,
  liveTradingAllowedByServer,
} from "../../../../lib/credential-vault";
import { reconcileUnknownAccountOrdersBeforeEntry } from "../../../../lib/unknown-live-order-account-reconciliation";
import { pendingOrderReservedMargin } from "../../../../lib/live-order-reserved-margin";
import { getTradeReadiness } from "../../../../lib/trade-readiness";
import {
  accountFundingSnapshot,
  automatedEntryEquitySizingCapitalUsdt,
} from "../../../../lib/account-funding-snapshot";
import {
  executableRiskPlanPayoffProfile,
  hasCompleteNetProfitPath,
} from "../../../../lib/strategy-payoff";
import { chinaTradingDayWindow } from "../../../../lib/trading-calendar";
import {
  readTradingStrategyDailyPnl,
  writeAudit,
} from "../../control/shared";
import {
  strategyModelPhase,
} from "../../../../lib/strategy-model-phase";
import { readStrategyModelProgressCounts } from
  "../../../../lib/strategy-model-progress-store";
import { marketAnalysisPressureResponse } from
  "../../../../lib/runtime-memory-pressure";
import {
  entryAuthorizationEvidence,
  resolveNexusEntryAuthorization,
} from "../../../../lib/nexus-entry-authorization";
import {
  evaluateNexusExplorationEntry,
  explorationExecutionConfig,
  rollingSameSymbolLiquidationEventCount,
} from "../../../../lib/nexus-exploration-entry";
import { shouldBlockShortEntryCooldown } from "../../../../lib/contrarian-fallback";
import { calculateStrategyMarginCapacity } from "../../../../lib/strategy-margin-capacity.mjs";
import {
  automatedOrderCapacityMessage,
  calculateAutomatedDailyMarginQuota,
  calculateAutomatedOrderCapacity,
} from "../../../../lib/automated-order-capacity.mjs";
import {
  attributedOrderInitialMargin,
  attributedPositionMargin,
  attributedPositionUnrealizedPnl,
  strategyTraceIdFromClientOrderId,
} from "../../../../lib/strategy-order-attribution";
import {
  liquidationDerivedFactorMarketFact,
  liquidationMarketFact,
  marketStructureWakeFact,
  markPriceMarketFact,
  mergeFrozenNexusMarketFacts,
  shortStructureMarketFacts,
  trendRegimeMarketFact,
} from "../../../../lib/nexus-market-facts";
import { NexusMarketFactCycle } from "../../../../lib/nexus-market-fact-cycle";
import {
  evaluateHighPositionShortWake,
  type HighPositionShortWake,
} from "../../../../lib/high-position-short";
import {
  evaluateTradfiHighPositionWake,
  type TradfiHighPositionWake,
} from "../../../../lib/tradfi-market-wake";
import { nexusMarketFactBuffer } from "../../../../lib/nexus-market-fact-buffer";
import { assessNexusDecisionSnapshot } from "../../../../lib/nexus-decision-snapshot";
import { buildNexusMarketContextSnapshot } from "../../../../lib/nexus-market-context-snapshot";
import type { NexusMarketContextSnapshot } from "../../../../lib/nexus-market-context-snapshot";
import { analyzeNexusTemporalShadow } from "../../../../lib/nexus-temporal-shadow";
import {
  nexusBrainShadowStateMemory,
  type NexusBrainShadowSnapshot,
} from "../../../../lib/nexus-brain-shadow-state";
import {
  replayNexusPureStateMachine,
  type NexusPureMachineSnapshot,
} from "../../../../lib/nexus-brain-state-machines";
import {
  advanceNexusExecutionIntent,
  reserveNexusExplorationExecutionIntent,
  reserveNexusExecutionIntent,
  settleNexusExecutionIntentWithLiveOrder,
  synchronizeReservedNexusOrder,
} from "../../../../lib/nexus-execution-intent-store";
import {
  effectiveNexusOrderDeadline,
  nexusExecutionIntentSettlementDeadline,
} from "../../../../lib/nexus-order-lifecycle";
import {
  recoverAcknowledgedAutomatedEntry,
} from "../../../../lib/execution/acknowledged-entry-recovery-settlement";
import { recordUncertainAutomatedEntry } from
  "../../../../lib/execution/uncertain-entry-settlement";
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
import {
  buildLiquidationMarketTriggerCandidates,
  type LiquidationMarketTriggerCandidate,
} from "../../../../lib/liquidation-market-trigger";
import { scheduledLiquidationSignalTiming } from "../../../../lib/liquidation-signal-freshness";
import {
  LIQUIDATION_DECISION_ENGINE_VERSION,
  retiredNexusExecutionVersionBlock,
} from "../../../../lib/liquidation-decision-engine";
import { nexusConfigValidationEntryBlock } from "../../../../lib/nexus-config-validation-runtime";
import { settleNexusAnalysisCandleSeries } from "../../../../lib/nexus-analysis-candle-series";
import { NexusMarketAnalysisCycle } from "../../../../lib/nexus-market-analysis-cycle";
import {
  buildBothLiquidationSideCandidates,
  nexusLiquidationOpportunity,
} from "../../../../lib/nexus-liquidation-opportunity";
import { evaluateAutomatedOrderConcurrency } from "../../../../lib/automated-order-concurrency";
import { findBlockingOpenSymbolPosition } from "../../../../lib/position-exposure";
import {
  buildEntryAnalysisOccupancySnapshot,
  entryAnalysisOccupancyReason,
} from "../../../../lib/entry-analysis-occupancy.mjs";
import { buildGlobalSentinelObservation } from "../../../../lib/nexus-global-sentinel";
import { loadGlobalSentinelProbeFeedback } from "../../../../lib/nexus-learning-cycle-store";
import {
  deriveLiquidationDerivedFactors,
  evaluateLiquidationFactorBrain,
  normalizeLiquidationFactorPolicy,
  selectLiquidationFactorEpisode,
  type LiquidationDerivedFactors,
  type LiquidationFactorBrainDecision,
} from "../../../../lib/liquidation-derived-factors";
import { readLiquidationFactorOpenInterest } from "../../../../lib/liquidation-factor-market-context";

export const dynamic = "force-dynamic";

const SHORT_LIQUIDATION_FEED_RECOVERY_WINDOW_MS = 120_000;
let shortLiquidationSequenceCursor: number | null = null;
let tradfiPriorityScanCursor = 0;
let tradfiDiscoveryScanCursor = 0;
let tradfiFallbackPriorityScanCursor = 0;
let tradfiFallbackDiscoveryScanCursor = 0;
let tradfiPrimaryNoOpportunityCycles = 0;
let tradfiFallbackDue = false;

type ShortTriggerCandidate = LiquidationMarketTriggerCandidate & {
  triggerSource?:
    | "LIQUIDATION"
    | "TRADFI_PRICE_VOLUME_STRUCTURE"
    | "HIGH_POSITION_PRICE_VOLUME_STRUCTURE";
  tradfiMarketWake?: TradfiHighPositionWake | HighPositionShortWake;
  marketContextSnapshot?: NexusMarketContextSnapshot;
  entryTimingSchedule?: TradfiTimingSelectionEvidence;
};

async function getScheduledShortLiquidationFeed() {
  const priorCursor = shortLiquidationSequenceCursor;
  let feed = await getBinanceLiveLiquidationEvents(
    priorCursor ?? 0,
    SHORT_LIQUIDATION_FEED_RECOVERY_WINDOW_MS,
  );
  let sequenceCursorInitialized = priorCursor !== null;

  // The proxy sequence restarts with its process. Treat the first recovered
  // snapshot as bootstrap history, then resume lossless incremental reads.
  if (priorCursor !== null && feed.lastSequence < priorCursor) {
    feed = await getBinanceLiveLiquidationEvents(
      0,
      SHORT_LIQUIDATION_FEED_RECOVERY_WINDOW_MS,
    );
    sequenceCursorInitialized = false;
  }

  return {
    ...feed,
    sequenceCursorInitialized,
  };
}

type ShortMonitorDiagnostic = {
  strategyId: number;
  strategyName: string;
  direction: LiquidationTrendConfig["direction"] | "UNKNOWN";
  status:
    | "SKIPPED_DIRECTION"
    | "SKIPPED_TRIGGER"
    | "INVALID_CONFIG"
    | "NO_CANDIDATES"
    | "COOLDOWN"
    | "EVALUATED"
    | "READY"
    | "ORDER_CREATED";
  evaluatedCandidates: number;
  recentCandidateCount: number;
  candidate: {
    symbol: string;
    liquidationSide: "BUY" | "SELL";
    liquidationNotional: number;
    liquidationPrice: number;
    markPrice: number | null;
    decisionStatus: string | null;
    decisionReason: string | null;
    marketEyeVerdict: string | null;
    marketEyeReason: string | null;
    supportBreakConfirmed: boolean | null;
    failedRetestConfirmed: boolean | null;
    executionVolumeRatio1m: number | null;
    nexusBrainShadowState: string | null;
    nexusPureState: string | null;
    nexusTrendBreakoutState: string | null;
    nexusPureMissing: string[];
    shadowOriginalDisagreement: boolean;
  } | null;
  reason: string;
};

const SHORT_EXECUTION_RETRY_INTERVAL_MS = 5_000;

function liveRuntime() {
  return {
    // 是否真正提交由页面总控、策略状态和账户校验决定。
    enabled: true,
  };
}

function authorized(request: Request) {
  const configured = (
    env as unknown as { NQ_INTERNAL_LIQUIDATION_TOKEN?: string }
  ).NQ_INTERNAL_LIQUIDATION_TOKEN ?? "";
  return (
    configured.length >= 32 &&
    request.headers.get("authorization") === `Bearer ${configured}`
  );
}

function round(value: number, digits = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function POST(request: Request) {
  if (!authorized(request))
    return Response.json(
      { error: "内部做空策略凭据无效" },
      { status: 401 },
    );
  const compactResponse =
    new URL(request.url).searchParams.get("compact") === "1";
  const startedAt = Date.now();
  const marketFactCycle = new NexusMarketFactCycle();
  const marketAnalysisCycle = new NexusMarketAnalysisCycle(
    nexusUnifiedMarketData,
    startedAt,
  );
  const pressureResponse = marketAnalysisPressureResponse();
  if (pressureResponse) return pressureResponse;
  const db = getDb();
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
  // This route is scheduled independently from the long and relative-strength
  // monitors. A running rolling-probability strategy is intentionally handled
  // by the long monitor, so it must not make this route load the full short
  // market context only to be skipped later in the per-strategy loop.
  const activeShortStrategies = runningStrategies.filter((strategy) => {
    const config = liquidationConfigForShort(parseJson(strategy.configJson));
    return Boolean(
      config &&
        config.trigger.kind !== "THREE_MINUTE_PROBABILITY" &&
        !usesMarketStructureTriggerRuntime(config.trigger.kind) &&
        ["SHORT_ONLY", "BOTH"].includes(config.direction ?? "LONG_ONLY") &&
        config.marketProfile?.mode !== "RELATIVE_STRENGTH",
    );
  });
  if (!activeShortStrategies.length)
    return Response.json({
      strategies: 0,
      created: 0,
      liveOrderAuthorized: liveRuntime().enabled,
      checkedAt: new Date().toISOString(),
    });
  const runningAccountIds = [
    ...new Set(activeShortStrategies.map((strategy) => strategy.accountId)),
  ];
  const [
    analysisPositionRows,
    analysisOrderRows,
    analysisCredentialRows,
    globalSentinelProbeFeedback,
  ] = await Promise.all([
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
      })
      .from(exchangeCredentials)
      .where(inArray(exchangeCredentials.accountId, runningAccountIds)),
    loadGlobalSentinelProbeFeedback(
      activeShortStrategies.map((strategy) => strategy.ownerEmail),
    ),
  ]);
  const analysisOccupancy = buildEntryAnalysisOccupancySnapshot({
    positions: analysisPositionRows,
    orders: analysisOrderRows,
  });
  const positionModeByAccount = new Map(
    analysisCredentialRows.map((row) => [
      `${row.ownerEmail.trim().toLowerCase()}:${row.accountId.trim().toLowerCase()}`,
      row.positionMode ?? "ONE_WAY",
    ]),
  );

  let monitorInput;
  try {
    const [
      globalContext,
      feed,
      activeRows,
      market60mCandles,
      systemMetrics,
    ] =
      await Promise.all([
        getCoinGlassWebLiquidationContext(),
        getScheduledShortLiquidationFeed(),
        db
          .select({
            symbol: contractSymbols.symbol,
            contractType: contractSymbols.contractType,
            minOrderQty: contractSymbols.minOrderQty,
            quantityStep: contractSymbols.quantityStep,
            minNotionalUsdt: contractSymbols.minNotionalUsdt,
            quoteVolume24h: contractSymbols.quoteVolume24h,
            lastPrice: contractSymbols.lastPrice,
            priceChangePercent: contractSymbols.priceChangePercent,
            highPrice: contractSymbols.highPrice,
            lowPrice: contractSymbols.lowPrice,
            marketSyncedAt: contractSymbols.marketSyncedAt,
          })
          .from(contractSymbols)
          .where(eq(contractSymbols.isActive, true)),
        nexusUnifiedMarketData
          .closedCandles({
            symbol: "BTCUSDT",
            interval: "5m",
            source: "MARK_PRICE",
            limit: 13,
          })
          .then((snapshot) => snapshot.rows),
        getBinanceLiveSystemMetrics(),
      ]);
    monitorInput = {
      globalContext,
      feed,
      activeRows,
      market60mCandles,
      systemMetrics,
    };
  } catch (error) {
    const upstreamStatus =
      error instanceof BinanceLiveError ? error.status : null;
    return Response.json(
      {
        error: "做空策略所需行情暂不可用，本轮未建立信号",
        code: "SHORT_MARKET_UNAVAILABLE",
        detail:
          error instanceof Error ? error.message : "未知行情读取错误",
        upstreamStatus,
        liveOrderAuthorized: false,
        checkedAt: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
  const {
    globalContext,
    feed,
    activeRows,
    market60mCandles,
    systemMetrics,
  } = monitorInput;
  const activeSymbols = new Map(
    activeRows.map((row) => [row.symbol, row]),
  );
  const activeQuoteVolumes24h = activeRows.map(
    (row) => row.quoteVolume24h,
  );
  const market60m = analyzeShortMarket60m(market60mCandles);
  const oneHour = globalContext.windows.find((row) => row.hours === 1);
  const liquidationMarketContext =
    resolveShortLiquidationMarketContext({
      webOneHourLongLiquidatedUsd: oneHour?.longLiquidatedUsd,
      webOneHourShortLiquidatedUsd: oneHour?.shortLiquidatedUsd,
      internal: systemMetrics.liquidationNotionalDistribution,
    });
  const longLiquidationSharePercent =
    liquidationMarketContext.longLiquidationSharePercent;
  const shortCandidateUniverse = activeShortStrategies.flatMap((strategy) => {
    const liquidationConfig = liquidationConfigForShort(
      parseJson(strategy.configJson),
    );
    if (
      !liquidationConfig ||
      liquidationConfig.trigger.kind === "THREE_MINUTE_PROBABILITY" ||
      usesMarketStructureTriggerRuntime(liquidationConfig.trigger.kind) ||
      !["SHORT_ONLY", "BOTH"].includes(
        liquidationConfig.direction ?? "LONG_ONLY",
      )
    )
      return [];
    if (liquidationConfig.marketProfile?.mode === "RELATIVE_STRENGTH")
      return [];
    if (
      liquidationConfig.marketProfile?.triggerPolicy ===
      "PRICE_VOLUME_STRUCTURE"
    )
      return [];
    const selected = new Set(liquidationConfig.selectedSymbols);
    const scopedSymbols = new Set(
      filterContractsByStrategyAssetScope({
        contracts: activeRows,
        scope: liquidationConfig.assetClassScope ?? "ALL",
        selectedSymbols: liquidationConfig.selectedSymbols,
      }).map((row) => row.symbol),
    );
    const requiredContractType =
      liquidationConfig.marketProfile?.mode === "TRADFI"
        ? "TRADIFI_PERPETUAL"
        : null;
    return shortTriggerCandidates({
      rows: feed.rows.filter(
        (row) =>
          activeSymbols.has(row.symbol) &&
          scopedSymbols.has(row.symbol) &&
          isPrimaryLiquidityMarket(
            activeSymbols.get(row.symbol)?.quoteVolume24h,
          ) &&
          (!requiredContractType ||
            activeSymbols.get(row.symbol)?.contractType === requiredContractType) &&
          (!selected.size || selected.has(row.symbol)),
      ),
      config: liquidationConfig,
      now: Date.now(),
      sequenceCursorInitialized: feed.sequenceCursorInitialized,
    });
  });
  const latestLiquidationBySymbol = [
    ...shortCandidateUniverse.reduce((map, row) => {
      const current = map.get(row.symbol);
      if (!current || row.lastTradeTime > current.lastTradeTime)
        map.set(row.symbol, row);
      return map;
    }, new Map<string, (typeof shortCandidateUniverse)[number]>()),
  ]
    .map(([, row]) => row)
    .sort(
      (left, right) =>
        right.symbolLiquidationNotional - left.symbolLiquidationNotional ||
        right.lastTradeTime - left.lastTradeTime,
    )
    .slice(0, 20);
  const marks = new Map(
    (
      latestLiquidationBySymbol.length
        ? await getBinanceLiveMarkPrices(
            latestLiquidationBySymbol.map((row) => row.symbol),
          )
        : []
    ).map((row) => [row.symbol, row]),
  );
  const marketFactCapturedAt = Date.now();
  nexusMarketFactBuffer.addMany(
    [
      ...marks.values().map((item) =>
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
  let evaluated = 0;
  let liveOrdersCreated = 0;
  let occupiedPositionSuppressed = 0;
  let workingOrderSuppressed = 0;
  const diagnostics: ShortMonitorDiagnostic[] = [];

  for (const strategy of activeShortStrategies) {
    const rawConfig = parseJson(strategy.configJson);
    const liquidationConfig = liquidationConfigForShort(rawConfig);
    if (liquidationConfig?.trigger.kind === "THREE_MINUTE_PROBABILITY") {
      diagnostics.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        direction: liquidationConfig.direction,
        status: "SKIPPED_TRIGGER",
        evaluatedCandidates: 0,
        recentCandidateCount: latestLiquidationBySymbol.length,
        candidate: null,
        reason: "3分钟概率轮次由独立触发器处理，爆仓做空分支不重复参与。",
      });
      continue;
    }
    if (
      liquidationConfig &&
      usesMarketStructureTriggerRuntime(liquidationConfig.trigger.kind)
    ) {
      diagnostics.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        direction: liquidationConfig.direction,
        status: "SKIPPED_TRIGGER",
        evaluatedCandidates: 0,
        recentCandidateCount: latestLiquidationBySymbol.length,
        candidate: null,
        reason: "该策略由市场结构触发器处理，爆仓做空分支不重复参与。",
      });
      continue;
    }
    if (
      !liquidationConfig ||
      !["SHORT_ONLY", "BOTH"].includes(
        liquidationConfig.direction ?? "LONG_ONLY",
      )
    ) {
      diagnostics.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        direction: liquidationConfig?.direction ?? "UNKNOWN",
        status: "SKIPPED_DIRECTION",
        evaluatedCandidates: 0,
        recentCandidateCount: latestLiquidationBySymbol.length,
        candidate: null,
        reason: "策略方向不是 SHORT_ONLY/BOTH，做空监听跳过。",
      });
      continue;
    }
    const config = shortConfigFromLiquidation(liquidationConfig);
    if (validateShortContinuationStrategyConfig(config)) {
      diagnostics.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        direction: liquidationConfig.direction,
        status: "INVALID_CONFIG",
        evaluatedCandidates: 0,
        recentCandidateCount: latestLiquidationBySymbol.length,
        candidate: null,
        reason: "做空策略参数校验未通过，本轮跳过。",
      });
      continue;
    }
    const nexusArchitecture = resolveNexusTradingArchitecture({
      config: liquidationConfig,
      strategyType: strategy.strategyType,
    });
    if (liquidationConfig.marketProfile?.mode === "RELATIVE_STRENGTH") continue;
    const entryTimingProfile = resolveStrategyEntryTimingProfile({
      config: liquidationConfig,
      strategyType: strategy.strategyType,
    });
    const frozenRetry = await retryFrozenShortExecutionDecisions(strategy);
    liveOrdersCreated += frozenRetry.liveOrdersCreated;
    created += frozenRetry.liveOrdersCreated;
    const strategyModelProgress =
      await currentShortStrategyModelProgress(
        strategy,
        liquidationConfig.execution.explorationOrderTarget,
      );
    const strategyMarket60m = analyzeShortMarket60m(
      market60mCandles,
      liquidationConfig?.shortTrend?.minimumMarket60mDropPercent ?? 0.2,
    );
    const activeAnalyses = await db
      .select({
        traceId: strategyExecutionTraces.traceId,
        resultCode: strategyExecutionTraces.resultCode,
        state: strategyExecutionTraces.state,
      })
      .from(strategyExecutionTraces)
      .where(and(
        eq(strategyExecutionTraces.strategyId, strategy.id),
        inArray(strategyExecutionTraces.state, [
          "TRIGGERED",
          "ANALYZING",
          "ARMED",
        ]),
        gt(strategyExecutionTraces.expiresAt, new Date()),
      ));
    let activeAnalysisCount = activeAnalyses.length;
    const configuredConcurrentAnalysisLimit = Math.max(
      0,
      Math.trunc(liquidationConfig.trigger.maxConcurrentAnalyses ?? 0),
    );
    const selected = new Set(config.selectedSymbols);
    const scopedActiveRows = filterContractsByStrategyAssetScope({
      contracts: activeRows,
      scope: liquidationConfig.assetClassScope ?? "ALL",
      selectedSymbols: liquidationConfig.selectedSymbols,
    });
    const scopedSymbols = new Set(
      scopedActiveRows.map((row) => row.symbol),
    );
    const requiredContractType =
      liquidationConfig.marketProfile?.mode === "TRADFI"
        ? "TRADIFI_PERPETUAL"
        : null;
    const isPriceVolumeMarketWake = [
      "TRADFI_PRICE_VOLUME_STRUCTURE",
      "HIGH_POSITION_PRICE_VOLUME_STRUCTURE",
    ].includes(entryTimingProfile.wakeAdapter);
    const strategyCandidates: ShortTriggerCandidate[] = isPriceVolumeMarketWake
      ? await highPositionPriceVolumeWakeCandidates({
          rows: scopedActiveRows.filter(
            (row) =>
              (liquidationConfig.marketProfile?.mode !== "TRADFI" ||
                row.contractType === "TRADIFI_PERPETUAL") &&
              (!selected.size || selected.has(row.symbol)),
          ),
          config: liquidationConfig,
          now: Date.now(),
          triggerSource:
            liquidationConfig.marketProfile?.mode === "HIGH_POSITION_SHORT"
              ? "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
              : "TRADFI_PRICE_VOLUME_STRUCTURE",
        })
      : shortTriggerCandidates({
          rows: feed.rows.filter(
            (row) =>
              activeSymbols.has(row.symbol) &&
              scopedSymbols.has(row.symbol) &&
              isPrimaryLiquidityMarket(
                activeSymbols.get(row.symbol)?.quoteVolume24h,
              ) &&
              (!requiredContractType ||
                activeSymbols.get(row.symbol)?.contractType ===
                  requiredContractType) &&
              (!selected.size || selected.has(row.symbol)),
          ),
          config: liquidationConfig,
          now: Date.now(),
          sequenceCursorInitialized: feed.sequenceCursorInitialized,
        })
          .sort(
            (left, right) =>
              right.symbolLiquidationNotional -
                left.symbolLiquidationNotional ||
              right.lastTradeTime - left.lastTradeTime,
          );
    const diagnosticCandidates: Array<{
      symbol: string;
      liquidationSide: "BUY" | "SELL";
      liquidationPrice: number;
      liquidationNotional: number;
      markPrice: number;
      structure: ReturnType<typeof analyzeShortBreakRetest>;
      executionVolumeRatio1m: number | null;
      decision: ReturnType<typeof evaluateShortDowntrendContinuation>;
      nexusBrainShadow: NexusBrainShadowSnapshot;
      nexusPureStateMachine: NexusPureMachineSnapshot;
      nexusTrendBreakoutStateMachine: NexusPureMachineSnapshot;
      nexusOwnMultiHourContext: ReturnType<typeof analyzeNexusMultiHourContext>;
      nexusDailyMarketActivity: ReturnType<typeof analyzeNexusDailyMarketActivity>;
      nexusOwnEntryRegime5m: ReturnType<typeof classifyNexusMarketRegimeFromCandles>;
      nexusBtcMacroRegime6h: ReturnType<typeof classifyNexusMarketRegimeFromCandles>;
      nexusPriceImpulse: ReturnType<typeof analyzeNexusLiquidationPriceImpulse>;
      nexusVolumeTiming: NexusVolumeTimingConcordance;
      nexusTemporalShadow: ReturnType<typeof analyzeNexusTemporalShadow>;
      nexusFundingContext: NexusFundingContext;
      liquidationFactorSnapshot: LiquidationDerivedFactors | null;
      liquidationFactorDecision: LiquidationFactorBrainDecision | null;
      nexusMarketEyeDecision: ReturnType<typeof decideNexusMarketEye>;
      nexusDecisionSnapshot: ReturnType<typeof assessNexusDecisionSnapshot>;
      nexusBrainShadowChanged: boolean;
      shadowOriginalDisagreement: boolean;
    }> = [];
    let cooldownSkipped = 0;
    let invalidTradingRuleSkipped = 0;
    let strategyCreated = 0;
    let strategyOccupiedPositionSkipped = 0;
    let strategyWorkingOrderSkipped = 0;

    for (const liquidation of strategyCandidates) {
      if (
        configuredConcurrentAnalysisLimit > 0 &&
        activeAnalysisCount >= configuredConcurrentAnalysisLimit
      ) continue;
      const occupancyReason = entryAnalysisOccupancyReason(
        analysisOccupancy,
        {
          ownerEmail: strategy.ownerEmail,
          accountId: strategy.accountId,
          symbol: liquidation.symbol,
          positionSide: resolveStrategyExecutionDirection({
            mode: liquidationConfig.execution.directionMode,
            brainDirection: "SHORT",
          }).positionSide,
          positionMode: positionModeByAccount.get(
            `${strategy.ownerEmail.trim().toLowerCase()}:${strategy.accountId.trim().toLowerCase()}`,
          ) ?? "ONE_WAY",
        },
      );
      const occupancyBlockedByStrategy =
        occupancyReason === "OPEN_POSITION"
          ? liquidationConfig.execution.existingPositionPolicy !==
            "ALLOW_SAME_DIRECTION"
          : occupancyReason === "WORKING_ORDER"
            ? liquidationConfig.execution.sameLegWorkingOrderPolicy !== "ALLOW"
            : false;
      if (occupancyBlockedByStrategy && strategy.strategyType !== "SENTINEL") {
        if (occupancyReason === "OPEN_POSITION") {
          occupiedPositionSuppressed += 1;
          strategyOccupiedPositionSkipped += 1;
        } else {
          workingOrderSuppressed += 1;
          strategyWorkingOrderSkipped += 1;
        }
        continue;
      }
      if ((liquidationConfig.trigger.cooldownMinutes ?? 0) > 0) {
        const recentLiveTraces = await db
          .select({
            state: strategyExecutionTraces.state,
            resultCode: strategyExecutionTraces.resultCode,
            eventTime: strategyExecutionTraces.eventTime,
          })
          .from(strategyExecutionTraces)
          .where(
            and(
              eq(strategyExecutionTraces.strategyId, strategy.id),
              eq(strategyExecutionTraces.accountId, strategy.accountId),
              eq(strategyExecutionTraces.symbol, liquidation.symbol),
              eq(
                strategyExecutionTraces.triggerKind,
                liquidation.tradfiMarketWake
                  ? liquidation.triggerSource ===
                    "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
                    ? "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
                    : "PRICE_VOLUME_STRUCTURE"
                  : "LIQUIDATION_WINDOW",
              ),
              eq(
                strategyExecutionTraces.liquidationSide,
                liquidation.side,
              ),
              gte(
                strategyExecutionTraces.createdAt,
                new Date(
                  Date.now() -
                    liquidationConfig.trigger.cooldownMinutes * 60_000,
                ),
              ),
            ),
          )
          .orderBy(desc(strategyExecutionTraces.id))
          .limit(100);
        const cooldownDecision = shouldBlockShortEntryCooldown({
          strategyDirection: liquidationConfig.direction,
          contrarianFallbackEnabled:
            liquidationConfig.risk.positionManagement!
              .contrarianFallbackEnabled,
          nowMs: Date.now(),
          handoffValidityMs:
            liquidationConfig.trigger.analysisValiditySeconds * 1_000,
          recentTraces: recentLiveTraces,
        });
        if (cooldownDecision.blocked) {
          cooldownSkipped += 1;
          continue;
        }
      }
      const marketWake = liquidation.tradfiMarketWake;
      const traceId =
        `${marketWake ? liquidation.triggerSource === "HIGH_POSITION_PRICE_VOLUME_STRUCTURE" ? "high-position-market" : "tradfi-market" : "short-live"}:${strategy.id}:${liquidation.symbol}:` +
        `${liquidation.id}`.slice(0, 100);
      let mark = marks.get(liquidation.symbol);
      if (!mark) {
        const [latestCandidateMark] = await getBinanceLiveMarkPrices([
          liquidation.symbol,
        ]);
        if (latestCandidateMark) {
          mark = latestCandidateMark;
          marks.set(liquidation.symbol, latestCandidateMark);
        }
      }
      if (!mark) continue;
      const executableRule = activeSymbols.get(liquidation.symbol);
      const preflightReferencePrice =
        liquidationConfig.execution.orderType === "LIMIT_OFFSET"
          ? mark.markPrice *
            (1 + liquidationConfig.execution.limitOffsetPercent / 100)
          : mark.markPrice;
      const executable = executableRule
        ? smallestPilotQuantity({
            markPrice: preflightReferencePrice,
            minOrderQty: executableRule.minOrderQty,
            quantityStep: executableRule.quantityStep,
            minNotionalUsdt: executableRule.minNotionalUsdt,
            leverage: liquidationConfig.execution.leverage,
            targetNotionalUsdt:
              liquidationConfig.execution.targetOrderNotionalUsdt,
            // Candidate discovery must not silently discard a contract just
            // because its exchange minimum is above the strategy's preferred
            // order margin. The unified execution layer is the authoritative
            // risk, margin and exchange-minimum gate after brain analysis.
            maxOrderNotionalUsdt: Number.MAX_SAFE_INTEGER,
            minimumOrderQuantityMultiplier:
              liquidationConfig.execution.minimumOrderQuantityMultiplier,
          })
        : null;
      if (!executable) {
        invalidTradingRuleSkipped += 1;
        continue;
      }
      // Subscribe the book eye before K-line/structure analysis so a valid
      // short opportunity is not rejected merely because its first
      // individual-symbol subscription has not produced a frame yet.
      const bookEyePrewarmReady =
        await warmNexusBookTicker(liquidation.symbol);
      const analysisSeries = await settleNexusAnalysisCandleSeries({
        requiredSeries: ["trade1m", "trade5m", "trade15m"],
        requests: {
          trade4h: marketAnalysisCycle.closedSnapshot({
            symbol: liquidation.symbol,
            interval: "4h",
            source: "TRADE",
            limit: 24,
          }),
          trade5m: marketAnalysisCycle.closedSnapshot({
            symbol: liquidation.symbol,
            interval: "5m",
            source: "TRADE",
            limit: 61,
          }),
          trade3m: marketAnalysisCycle.closedSnapshot({
            symbol: liquidation.symbol,
            interval: "3m",
            source: "TRADE",
            limit: 11,
          }),
          trade1m: marketAnalysisCycle.closedSnapshot({
            symbol: liquidation.symbol,
            interval: "1m",
            source: "TRADE",
            limit: 60,
          }),
          trade15m: marketAnalysisCycle.closedSnapshot({
            symbol: liquidation.symbol,
            interval: "15m",
            source: "TRADE",
            limit: 24,
          }),
          trade30m: marketAnalysisCycle.closedSnapshot({
            symbol: liquidation.symbol,
            interval: "30m",
            source: "TRADE",
            limit: 12,
          }),
          trade1h: marketAnalysisCycle.closedSnapshot({
            symbol: liquidation.symbol,
            interval: "1h",
            source: "TRADE",
            limit: 73,
          }),
          btcTrade1h: marketAnalysisCycle.closedSnapshot({
            symbol: "BTCUSDT",
            interval: "1h",
            source: "TRADE",
            limit: 6,
          }),
        },
      });
      if (analysisSeries.requiredFailure) continue;
      const structure5m = analysisSeries.rows.trade5m;
      const volume3m = analysisSeries.rows.trade3m;
      const trade1m = analysisSeries.rows.trade1m;
      const trade15m = analysisSeries.rows.trade15m;
      const trade30m = analysisSeries.rows.trade30m;
      const trade1h = analysisSeries.rows.trade1h;
      const trade4h = analysisSeries.rows.trade4h;
      const btcTrade1h = analysisSeries.rows.btcTrade1h;
      const structure5mSnapshot = {
        receivedAt: analysisSeries.sources.trade5m.receivedAt ?? undefined,
      };
      const volume3mSnapshot = {
        receivedAt: analysisSeries.sources.trade3m.receivedAt ?? undefined,
      };
      const trade1mSnapshot = {
        receivedAt: analysisSeries.sources.trade1m.receivedAt ?? undefined,
      };
      const trade15mSnapshot = {
        receivedAt: analysisSeries.sources.trade15m.receivedAt ?? undefined,
      };
      const trade30mSnapshot = {
        receivedAt: analysisSeries.sources.trade30m.receivedAt ?? undefined,
      };
      const trade1hSnapshot = {
        receivedAt: analysisSeries.sources.trade1h.receivedAt ?? undefined,
      };
      const trade4hSnapshot = {
        receivedAt: analysisSeries.sources.trade4h.receivedAt ?? undefined,
      };
      const btcTrade1hSnapshot = {
        receivedAt:
          analysisSeries.sources.btcTrade1h.receivedAt ?? undefined,
      };
      const latestMark = (await getBinanceLiveMarkPrices([
        liquidation.symbol,
      ]))[0];
      if (
        !latestMark ||
        !Number.isFinite(latestMark.markPrice) ||
        latestMark.markPrice <= 0 ||
        Date.now() - latestMark.time > 5_000
      )
        continue;
      mark = latestMark;
      const highPositionConfig =
        liquidationConfig.marketProfile?.mode === "HIGH_POSITION_SHORT"
          ? liquidationConfig.highPositionShort
          : null;
      const structure = analyzeShortBreakRetest(
        structure5m,
        highPositionConfig?.resistanceRetestToleranceAtr,
      );
      const executionVolumeRatio1m =
        calculateNexusClosedEntryRelativeVolume(trade1m);
      const brainEvaluatedAt = Date.now();
      const liquidationFactorRequired = !marketWake;
      const factorOpenInterest = liquidationFactorRequired
        ? await readLiquidationFactorOpenInterest(liquidation.symbol)
        : null;
      const liquidationFactorPolicy = normalizeLiquidationFactorPolicy(
        liquidationConfig.liquidationFactors,
        {
          minimumEvents:
            liquidationConfig.trigger.minClusterEvents ?? 3,
          minimumAmountUsdt:
            liquidationConfig.trigger.minLiquidationNotionalUsdt,
          observationWindowSeconds:
            liquidationConfig.trigger.maxClusterSpanSeconds ?? 120,
          minimumVolumeRatio: liquidationConfig.trend.volumeRatio3m,
        },
      );
      const liquidationFactorSnapshot = liquidationFactorRequired
        ? deriveLiquidationDerivedFactors({
            symbol: liquidation.symbol,
            liquidationSide: liquidation.side,
            events: selectLiquidationFactorEpisode(
              feed.rows
                .filter((row) =>
                  row.symbol === liquidation.symbol &&
                  row.side === liquidation.side &&
                  row.lastTradeTime <= liquidation.lastTradeTime
                )
                .map((row) => ({
                  eventAtMs: row.lastTradeTime,
                  liquidationPrice: row.averagePrice,
                  liquidationNotional: row.notional,
                  eventCount: row.eventCount,
                })),
              {
                maximumWindowMs:
                  (liquidationConfig.trigger.maxClusterSpanSeconds ?? 120) *
                  1_000,
                maximumInterEventGapMs:
                  (liquidationConfig.trigger.maxClusterEventGapSeconds ??
                    liquidationConfig.trigger.maxClusterSpanSeconds ??
                    120) * 1_000,
              },
            ),
            pricePoints: trade1m.map((candle) => ({
              eventAtMs: candle.openTime + 60_000 - 1,
              price: candle.close,
            })),
            evaluatedAt: brainEvaluatedAt,
            latestPrice: latestMark.markPrice,
            openInterestValue: factorOpenInterest?.openInterestValue ?? null,
            openInterestChangePercent:
              factorOpenInterest?.openInterestChangePercent ?? null,
            fundingRate: latestMark.fundingRate,
            relativeVolume: executionVolumeRatio1m,
          })
        : null;
      const liquidationFactorDecision = liquidationFactorSnapshot
        ? evaluateLiquidationFactorBrain({
            direction: "SHORT",
            snapshot: liquidationFactorSnapshot,
            policy: liquidationFactorPolicy,
          })
        : null;
      const liquidationFactorFact = liquidationFactorSnapshot
        ? liquidationDerivedFactorMarketFact({
            symbol: liquidation.symbol,
            eventAt:
              liquidationFactorSnapshot.windowEndedAt ??
              liquidation.lastTradeTime,
            receivedAt: brainEvaluatedAt,
            expiresAt:
              brainEvaluatedAt +
              liquidationConfig.trigger.analysisValiditySeconds * 1_000,
            snapshot: liquidationFactorSnapshot,
          })
        : null;
      const preTrigger3mReference = buildNexusPreTriggerVolumeReference({
        candles: volume3m,
        triggerEventAt: liquidation.lastTradeTime,
      });
      const triggerMarketFact = marketWake && marketWake.eventAt &&
          marketWake.referencePrice && marketWake.position72hPercent !== null &&
          marketWake.relativeVolume5m !== null
        ? marketStructureWakeFact({
            id: liquidation.id,
            symbol: liquidation.symbol,
            side: liquidation.side,
            eventAt: marketWake.eventAt,
            receivedAt: brainEvaluatedAt,
            expiresAt:
              brainEvaluatedAt +
              liquidationConfig.trigger.analysisValiditySeconds * 1_000,
            referencePrice: marketWake.referencePrice,
            position72hPercent: marketWake.position72hPercent,
            relativeVolume5m: marketWake.relativeVolume5m,
            structureCode: marketWake.code,
          })
        : liquidationMarketFact(liquidation);
      nexusMarketFactBuffer.add(
        triggerMarketFact,
        brainEvaluatedAt,
      );
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
        symbol: liquidation.symbol,
        quoteVolume24h:
          activeSymbols.get(liquidation.symbol)?.quoteVolume24h,
        universeQuoteVolumes24h: activeQuoteVolumes24h,
        recentVolumeRatio:
          nexusOwnMultiHourContext.volume.relativeRatio,
      });
      const nexusOwnEntryRegime5m = classifyNexusMarketRegimeFromCandles({
        candles: structure5m,
      });
      const nexusBtcMacroRegime6h = classifyNexusMarketRegimeFromCandles({
        candles: btcTrade1h.slice(-6),
        fastPeriod: 2,
        slowPeriod: 5,
        atrPeriod: 5,
      });
      const nexusPriceImpulse = analyzeNexusLiquidationPriceImpulse({
        candles: trade1m,
        triggerEventAt: liquidation.lastTradeTime,
        triggerPrice: liquidation.averagePrice,
        liquidationSide: liquidation.side,
        evaluatedAt: brainEvaluatedAt,
      });
      const nexusVolumeTiming = analyzeNexusVolumeTimingConcordance({
        decisionAt: brainEvaluatedAt,
        triggerEventAt: liquidation.lastTradeTime,
        currentExecutionCloseAt: trade1m.at(-1)
          ? trade1m.at(-1)!.openTime + 60_000 - 1
          : null,
        currentContextCloseAt: trade15m.at(-1)
          ? trade15m.at(-1)!.openTime + 15 * 60_000 - 1
          : null,
        historicalImpulseVolumeRatio:
          nexusPriceImpulse.timingVolumeRatio,
        historicalImpulseConcentrated:
          nexusPriceImpulse.volumeConcentrated,
        currentExecutionVolumeRatio: executionVolumeRatio1m,
        currentContextVolumeRatio:
          nexusOwnMultiHourContext.volume.relativeRatio,
        requiredVolumeRatio: config.minimumVolumeRatio3m,
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
      const nexusFundingContext = analyzeNexusFundingContext({
        direction: "SHORT",
        fundingRate: latestMark.fundingRate,
        nextFundingTime: latestMark.nextFundingTime,
        observedPriceDirection: nexusPriceImpulse.observedDirection,
        volumeConcentrated: nexusPriceImpulse.volumeConcentrated,
        contextPhase: nexusPriceImpulse.contextPhase,
      });
      const nexusPriceImpulseFact = liquidationPriceImpulseMarketFact({
        symbol: liquidation.symbol,
        eventAt: liquidation.lastTradeTime,
        receivedAt: brainEvaluatedAt,
        expiresAt:
          liquidation.lastTradeTime +
          liquidationConfig.trigger.analysisValiditySeconds * 1_000,
        impulse: nexusPriceImpulse,
      });
      const closedStructure5m = structure5m.filter(
        (candle) =>
          candle.openTime + 5 * 60_000 - 1 <= brainEvaluatedAt,
      );
      const shadowStructure = analyzeShortBreakRetest(
        closedStructure5m,
        highPositionConfig?.resistanceRetestToleranceAtr,
      );
      const latestClosedStructureOpenAt =
        [...closedStructure5m]
          .reverse()
          .at(0)?.openTime ?? brainEvaluatedAt - 5 * 60_000;
      const structureEventAt =
        latestClosedStructureOpenAt + 5 * 60_000 - 1;
      const currentMarketFacts = [
          ...(liquidationFactorFact ? [liquidationFactorFact] : []),
          ...marketFactCycle.closedCandles({
            symbol: liquidation.symbol,
            interval: "4h",
            candles: trade4h,
            receivedAt: trade4hSnapshot.receivedAt,
            structureLookback: 12,
            volumeLookback: 12,
            volumeExpansionRatio: config.minimumVolumeRatio3m,
          }),
          ...marketFactCycle.closedCandles({
            symbol: liquidation.symbol,
            interval: "1m",
            candles: trade1m,
            receivedAt: trade1mSnapshot.receivedAt,
            structureLookback: 20,
            volumeLookback: 20,
            volumeExpansionRatio: config.minimumVolumeRatio3m,
          }),
          ...marketFactCycle.closedCandles({
            symbol: liquidation.symbol,
            interval: "5m",
            candles: structure5m,
            receivedAt: structure5mSnapshot.receivedAt,
            structureLookback: 20,
            volumeLookback: 20,
            volumeExpansionRatio: config.minimumVolumeRatio3m,
          }),
          ...marketFactCycle.closedCandles({
            symbol: liquidation.symbol,
            interval: "3m",
            candles: volume3m,
            receivedAt: volume3mSnapshot.receivedAt,
            structureLookback: 10,
            volumeLookback: 10,
            volumeExpansionRatio: config.minimumVolumeRatio3m,
          }),
          ...marketFactCycle.closedCandles({
            symbol: liquidation.symbol,
            interval: "15m",
            candles: trade15m,
            receivedAt: trade15mSnapshot.receivedAt,
            structureLookback: 20,
            volumeLookback: 20,
            volumeExpansionRatio: config.minimumVolumeRatio3m,
          }),
          ...marketFactCycle.closedCandles({
            symbol: liquidation.symbol,
            interval: "30m",
            candles: trade30m,
            receivedAt: trade30mSnapshot.receivedAt,
            structureLookback: 12,
            volumeLookback: 12,
            volumeExpansionRatio: config.minimumVolumeRatio3m,
          }),
          ...marketFactCycle.closedCandles({
            symbol: liquidation.symbol,
            interval: "1h",
            candles: trade1h,
            receivedAt: trade1hSnapshot.receivedAt,
            structureLookback: 12,
            volumeLookback: 12,
            volumeExpansionRatio: config.minimumVolumeRatio3m,
          }),
          ...shortStructureMarketFacts({
            symbol: liquidation.symbol,
            eventAt: structureEventAt,
            receivedAt: structure5mSnapshot.receivedAt,
            supportBreakConfirmed:
              shadowStructure.supportBreakConfirmed,
            failedRetestConfirmed:
              shadowStructure.failedRetestConfirmed,
            brokenSupport: shadowStructure.brokenSupport,
            distanceBelowBrokenSupportAtr:
              shadowStructure.distanceBelowBrokenSupportAtr,
          }),
          markPriceMarketFact({
            symbol: liquidation.symbol,
            markPrice: mark.markPrice,
            eventAt: mark.time,
            receivedAt: latestMark.receivedAt,
          }),
          trendRegimeMarketFact({
            symbol: liquidation.symbol,
            interval: "5m",
            eventAt:
              (structure5m.at(-1)?.openTime ??
                brainEvaluatedAt - 5 * 60_000) +
              5 * 60_000 -
              1,
            receivedAt: structure5mSnapshot.receivedAt,
            regime: nexusOwnEntryRegime5m,
          }),
          trendRegimeMarketFact({
            symbol: liquidation.symbol,
            interval: "1h",
            eventAt:
              (trade1h.at(-1)?.openTime ??
                brainEvaluatedAt - 60 * 60_000) +
              60 * 60_000 -
              1,
            receivedAt: trade1hSnapshot.receivedAt,
            regime: nexusOwnMacroCompatibility,
          }),
          ...marketFactCycle.closedCandles({
            symbol: "BTCUSDT",
            interval: "1h",
            candles: btcTrade1h,
            receivedAt: btcTrade1hSnapshot.receivedAt,
            structureLookback: 6,
            volumeLookback: 6,
            volumeExpansionRatio: config.minimumVolumeRatio3m,
          }),
          trendRegimeMarketFact({
            symbol: "BTCUSDT",
            interval: "1h",
            eventAt:
              (btcTrade1h.at(-1)?.openTime ??
                brainEvaluatedAt - 60 * 60_000) +
              60 * 60_000 -
              1,
            receivedAt: btcTrade1hSnapshot.receivedAt,
            regime: nexusBtcMacroRegime6h,
          }),
          ...(nexusPriceImpulseFact ? [nexusPriceImpulseFact] : []),
        ];
      nexusMarketFactBuffer.addMany(currentMarketFacts, brainEvaluatedAt);
      const rollingMarketFacts = nexusMarketFactBuffer.query({
        symbol: liquidation.symbol,
        freshOnly: true,
        now: brainEvaluatedAt,
        // The trigger owns one slot in the 64-fact decision window.
        limit: 63,
        preserveLatestByKindInterval: true,
      });
      const nexusMarketFactsShadow = mergeFrozenNexusMarketFacts(
        [triggerMarketFact],
        // Use this evaluation's just-fetched facts before the process-local
        // rolling buffer. This keeps the short path aligned with the long
        // path and prevents stale/deduplicated cache metadata from hiding a
        // timeframe that was successfully read in the current cycle.
        [...currentMarketFacts, ...rollingMarketFacts],
        64,
      );
      const ticker24h = activeSymbols.get(liquidation.symbol);
      const ticker24hEventAt = ticker24h?.marketSyncedAt?.getTime();
      const nexusMarketContextSnapshot =
        liquidation.marketContextSnapshot ??
        buildNexusMarketContextSnapshot({
          symbol: liquidation.symbol,
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
        symbol: liquidation.symbol,
        marketContext: nexusMarketContextSnapshot,
        btcMacro: {
          regime: nexusBtcMacroRegime6h.regime,
          observations: nexusBtcMacroRegime6h.observations,
          eventAt:
            (btcTrade1h.at(-1)?.openTime ??
              brainEvaluatedAt - 60 * 60_000) +
            60 * 60_000 -
            1,
        },
      });
      const brainEvaluation = nexusBrainShadowStateMemory.evaluate({
        key:
          `${strategy.id}:${strategy.configVersion}:SHORT:` +
          `${liquidation.symbol}:${liquidation.side}`,
        direction: "SHORT",
        triggerLiquidationSide: liquidation.side,
        facts: nexusMarketFactsShadow,
        now: brainEvaluatedAt,
      });
      const nexusBrainShadow = brainEvaluation.snapshot;
      const nexusOpportunity = nexusLiquidationOpportunity({
        liquidationSide: liquidation.side,
        direction: "SHORT",
      });
      const nexusPureStateMachine = replayNexusPureStateMachine({
        machine: nexusOpportunity.primaryMachine,
        direction: "SHORT",
        symbol: liquidation.symbol,
        triggerLiquidationSide: liquidation.side,
        triggerFactId: nexusBrainShadow.triggerFactId,
        facts: nexusMarketFactsShadow,
        now: brainEvaluatedAt,
      });
      const nexusTrendBreakoutStateMachine = replayNexusPureStateMachine({
        machine: nexusOpportunity.secondaryMachine,
        direction: "SHORT",
        symbol: liquidation.symbol,
        triggerLiquidationSide: liquidation.side,
        triggerFactId: nexusBrainShadow.triggerFactId,
        facts: nexusMarketFactsShadow,
        now: brainEvaluatedAt,
      });
      const rawNexusMarketEyeDecision = decideNexusMarketEye({
        direction: "SHORT",
        ownMacroRegime: nexusOwnMultiHourContext.decisionRegime,
        ownEntryRegime: nexusOwnEntryRegime5m.regime,
        btcMacroRegime: nexusBtcMacroRegime6h.regime,
        relativeVolume: executionVolumeRatio1m,
        contextRelativeVolume:
          nexusOwnMultiHourContext.volume.relativeRatio,
        volumeTiming: nexusVolumeTiming,
        liquidationFactorDecision,
        minimumIndependentRelativeVolume: config.minimumVolumeRatio3m,
        paths: [
          {
            machine: nexusPureStateMachine.machine,
            direction: nexusPureStateMachine.direction,
            state: nexusPureStateMachine.state,
            changedAt: nexusPureStateMachine.changedAt,
            evidenceFactIds: nexusPureStateMachine.evidenceFactIds,
            missing: nexusPureStateMachine.missing,
          },
          {
            machine: nexusTrendBreakoutStateMachine.machine,
            direction: nexusTrendBreakoutStateMachine.direction,
            state: nexusTrendBreakoutStateMachine.state,
            changedAt: nexusTrendBreakoutStateMachine.changedAt,
            evidenceFactIds:
              nexusTrendBreakoutStateMachine.evidenceFactIds,
            missing: nexusTrendBreakoutStateMachine.missing,
          },
        ],
      });
      const nexusMarketEyeDecision = nexusDecisionSnapshot.complete
        ? {
            ...rawNexusMarketEyeDecision,
            dataIntegrity: nexusDecisionSnapshot.integrity,
            dataIntegritySummary: nexusDecisionSnapshot.integritySummary,
          }
        : {
            ...rawNexusMarketEyeDecision,
            verdict: "WAIT" as const,
            code: "EYE_DECISION_SNAPSHOT_INCOMPLETE" as const,
            summary:
              `决策快照不完整：${nexusDecisionSnapshot.missing.join("、")}`,
            missing: nexusDecisionSnapshot.missing,
            dataIntegrity: nexusDecisionSnapshot.integrity,
            dataIntegritySummary: nexusDecisionSnapshot.integritySummary,
          };
      const decision = evaluateShortDowntrendContinuation({
        completedObservationSamples: 0,
        globalLongLiquidationSharePercent:
          longLiquidationSharePercent,
        market60mState: strategyMarket60m.state,
        supportBreakConfirmed: structure.supportBreakConfirmed,
        failedRetestConfirmed: structure.failedRetestConfirmed,
        executionVolumeRatio1m,
        distanceBelowBrokenSupportAtr:
          structure.distanceBelowBrokenSupportAtr,
        marketDataAgeMs: Math.max(0, Date.now() - mark.time),
        config: highPositionConfig
          ? {
              ...config,
              minimumVolumeRatio3m:
                highPositionConfig.minimumSellerVolumeRatio3m,
              maximumChaseDistanceAtr:
                highPositionConfig.maximumEntryDistanceAtr,
              maximumMarketDataAgeMs:
                highPositionConfig.maximumMarketDataAgeMs,
            }
          : config,
      });
      evaluated += 1;
      diagnosticCandidates.push({
        symbol: liquidation.symbol,
        liquidationSide: liquidation.side,
        liquidationPrice: liquidation.averagePrice,
        liquidationNotional: liquidation.notional,
        markPrice: mark.markPrice,
        structure,
        executionVolumeRatio1m,
        decision,
        nexusBrainShadow,
        nexusPureStateMachine,
        nexusTrendBreakoutStateMachine,
        nexusOwnMultiHourContext,
        nexusDailyMarketActivity,
        nexusOwnEntryRegime5m,
        nexusBtcMacroRegime6h,
        nexusPriceImpulse,
        nexusVolumeTiming,
        nexusTemporalShadow,
        nexusFundingContext,
        liquidationFactorSnapshot,
        liquidationFactorDecision,
        nexusMarketEyeDecision,
        nexusDecisionSnapshot,
        nexusBrainShadowChanged: brainEvaluation.changed,
        // 旧做空分析仅作为兼容证据，不再拥有最终下单权。
        shadowOriginalDisagreement: false,
      });
      const explorationLiquidationEventCount =
        rollingSameSymbolLiquidationEventCount({
          rows: feed.rows,
          symbol: liquidation.symbol,
          side: liquidation.side,
          referenceTimeMs: liquidation.lastTradeTime,
          windowMs:
            (liquidationConfig.trigger.maxClusterSpanSeconds ?? 120) *
            1_000,
          maxInterEventGapMs:
            (liquidationConfig.trigger.maxClusterEventGapSeconds ??
              liquidationConfig.trigger.maxClusterSpanSeconds ??
              120) * 1_000,
        });
      const explorationEntryPolicyBase = evaluateNexusExplorationEntry({
        modelProgress: strategyModelProgress,
        eyeDecision: nexusMarketEyeDecision,
        decisionSnapshotComplete: nexusDecisionSnapshot.complete,
        liquidationEventCount: Math.max(
          liquidation.eventCount,
          explorationLiquidationEventCount,
        ),
        singleLiquidationNotional: liquidation.notional,
        minSingleLiquidationNotionalUsdt:
          liquidationConfig.trigger.minSingleLiquidationNotionalUsdt ??
          liquidationConfig.trigger.minLiquidationNotionalUsdt,
        aggregateLiquidationNotional: Math.max(
          liquidation.notional,
          liquidation.symbolLiquidationNotional,
        ),
        minAggregateLiquidationNotionalUsdt:
          liquidationConfig.trigger.minLiquidationNotionalUsdt,
        executionOrderType: liquidationConfig.execution.orderType,
        executionLimitOffsetPercent:
          liquidationConfig.execution.limitOffsetPercent,
        executionOrderTtlSeconds:
          liquidationConfig.execution.orderTtlSeconds,
        executionAllowSecondOrder:
          liquidationConfig.execution.allowSecondOrder,
        requiredLiquidationEventCount:
          liquidationConfig.trigger.minClusterEvents ?? 1,
      });
      const explorationEntryPolicy = explorationEntryPolicyBase;
      const probabilityExplorationAllowed =
        nexusProbabilityExplorationAllowed({
          policy: liquidationConfig.probabilityPolicy,
          explorationAllowed: explorationEntryPolicy.allowed,
        });
      // 确认证据走正常执行；证据模糊只允许策略参数授权的受控探针。
      if (
        nexusMarketEyeDecision.verdict !== "CONFIRMED" &&
        !probabilityExplorationAllowed
      )
        continue;
      const explorationProbe =
        nexusMarketEyeDecision.verdict !== "CONFIRMED" &&
        probabilityExplorationAllowed;
      const [recentRejectedLong] =
        liquidation.side === "SELL" &&
          liquidationConfig.direction === "BOTH" &&
          liquidationConfig.risk.positionManagement!
            .contrarianFallbackEnabled
          ? await db
              .select({
                id: strategyExecutionTraces.id,
                traceId: strategyExecutionTraces.traceId,
                resultCode: strategyExecutionTraces.resultCode,
              })
              .from(strategyExecutionTraces)
              .where(
                and(
                  eq(strategyExecutionTraces.strategyId, strategy.id),
                  eq(strategyExecutionTraces.accountId, strategy.accountId),
                  eq(strategyExecutionTraces.symbol, liquidation.symbol),
                  eq(strategyExecutionTraces.state, "REJECTED"),
                  inArray(strategyExecutionTraces.resultCode, [
                    "TREND_1H_REJECTED",
                    "STRUCTURE_30M_REJECTED",
                  ]),
                  gte(
                    strategyExecutionTraces.eventTime,
                    new Date(
                      Date.now() -
                        liquidationConfig.trigger.analysisValiditySeconds *
                          1_000,
                    ),
                  ),
                ),
              )
              .orderBy(desc(strategyExecutionTraces.id))
              .limit(1)
          : [];
      const branchRole = recentRejectedLong
        ? "CONTRARIAN_PROBE" as const
        : "PRIMARY_SHORT" as const;
      const globalSentinelObservation = buildGlobalSentinelObservation({
        ownerEmail: strategy.ownerEmail,
        observerAccountId: strategy.accountId,
        symbol: liquidation.symbol,
        positionSide: "SHORT",
        observedAt: Date.now(),
        positions: analysisPositionRows,
        orders: analysisOrderRows,
        probeFeedback: globalSentinelProbeFeedback,
      });
      const sentinelExposure =
        globalSentinelObservation.sameDirectionExposure;
      const now = new Date();
      const traceTriggerKind = marketWake
        ? liquidation.triggerSource ===
          "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
          ? "HIGH_POSITION_PRICE_VOLUME_STRUCTURE" as const
          : "PRICE_VOLUME_STRUCTURE" as const
        : "LIQUIDATION_WINDOW" as const;
      const traceTriggerVersion = marketWake
        ? traceTriggerKind === "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
          ? "high-position-price-volume-structure-v1"
          : "price-volume-structure-v1"
        : "liquidation-window-trigger-v1";
      const traceTriggerReferencePrice =
        marketWake?.referencePrice ?? liquidation.averagePrice;
      const traceTriggerFactSnapshotId =
        liquidation.marketContextSnapshot?.id ?? liquidation.id;
      const [trace] = await db
        .insert(strategyExecutionTraces)
        .values({
          traceId,
          strategyId: strategy.id,
          strategyRunId: `short-observe-${now
            .toISOString()
            .slice(0, 10)}`,
          configVersion: strategy.configVersion,
          ownerEmail: strategy.ownerEmail,
          accountId: strategy.accountId,
          symbol: liquidation.symbol,
          triggerKind: traceTriggerKind,
          triggerVersion: traceTriggerVersion,
          triggerDirection: "SHORT",
          triggerReferencePrice: traceTriggerReferencePrice,
          triggerFactSnapshotId: traceTriggerFactSnapshotId,
          triggerSourceId: liquidation.id,
          liquidationSide: liquidation.side,
          liquidationPrice: liquidation.averagePrice,
          liquidationNotional: liquidation.notional,
          eventTime: new Date(liquidation.lastTradeTime),
          receivedAt: new Date(liquidation.lastReceivedAt),
          expiresAt: new Date(
            now.getTime() +
              liquidationConfig.trigger.analysisValiditySeconds * 1_000,
          ),
          state: "ANALYZING",
          resultCode: explorationProbe
            ? "NEXUS_EXPLORATION_SHORT_PROBE_CANDIDATE"
            : branchRole === "CONTRARIAN_PROBE"
            ? "NEXUS_EYE_CONTRARIAN_SHORT_READY"
            : "NEXUS_EYE_SHORT_READY",
          resultMessage: explorationProbe
            ? `NEXUS眼睛证据模糊，按策略委托方式启用做空学习探针：${nexusMarketEyeDecision.summary}`
            : branchRole === "CONTRARIAN_PROBE"
            ? `NEXUS眼睛已确认反向做空：${nexusMarketEyeDecision.summary}`
            : `NEXUS眼睛已确认做空：${nexusMarketEyeDecision.summary}`,
          // Executable traces must carry the complete, version-bound NEXUS
          // configuration. The branch-local short config is evidence only.
          configSnapshotJson: JSON.stringify(liquidationConfig),
          entryEvidenceJson: JSON.stringify({
            symbol: liquidation.symbol,
            triggerIdentity: {
              triggerKind: traceTriggerKind,
              triggerVersion: traceTriggerVersion,
              direction: "SHORT",
              factSnapshotId: traceTriggerFactSnapshotId,
              sourceId: liquidation.id,
              referencePrice: traceTriggerReferencePrice,
              canAuthorizeOrder: false,
            },
            nexusArchitecture,
            entryTimingProfile,
            entryTimingSchedule: liquidation.entryTimingSchedule ?? null,
            strategyVersion: SHORT_DOWNTREND_STRATEGY_VERSION,
            decisionEngineVersion: LIQUIDATION_DECISION_ENGINE_VERSION,
            strategyFamily: marketWake
              ? liquidation.triggerSource === "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
                ? "HIGH_POSITION_PRICE_VOLUME_SHORT"
                : "TRADFI_PRICE_VOLUME_SHORT"
              : "LIQUIDATION_SHORT",
            triggerSource: marketWake
              ? liquidation.triggerSource ?? "TRADFI_PRICE_VOLUME_STRUCTURE"
              : "LIQUIDATION",
            tradfiMarketWake: marketWake ?? null,
            referenceBenchmark: marketWake
              ? {
                  policy: "OBSERVE_WHEN_AVAILABLE",
                  status: "UNAVAILABLE",
                  orderAffecting: false,
                  summary:
                    "尚未接入可验证的纳斯达克现货基准源，不计算或伪造套利价差",
                }
              : null,
            brainDecisionDirection: "SHORT",
            tradeDirection: resolveStrategyExecutionDirection({
              mode: liquidationConfig.execution.directionMode,
              brainDirection: "SHORT",
            }).tradeDirection,
            executionDirection: resolveStrategyExecutionDirection({
              mode: liquidationConfig.execution.directionMode,
              brainDirection: "SHORT",
            }),
            observationOnly: false,
            liveOrderAuthorized:
              liveRuntime().enabled && strategy.strategyType !== "SENTINEL",
            sentinelAdvisoryOnly: strategy.strategyType === "SENTINEL",
            sentinelExposure,
            globalSentinelObservation,
            positionSide: resolveStrategyExecutionDirection({
              mode: liquidationConfig.execution.directionMode,
              brainDirection: "SHORT",
            }).positionSide,
            entryPrice: mark.markPrice,
            entryMarkTime: mark.time,
            decision,
            market60m: strategyMarket60m,
            globalLiquidationContext: globalContext,
            liquidationMarketContext,
            structure,
            executionVolumeRatio1m,
            preTrigger3mReference,
            nexusMarketFactsShadow,
            nexusBrainShadow,
            nexusOpportunity,
            nexusPureStateMachine,
            nexusTrendBreakoutStateMachine,
            nexusOwnMultiHourContext,
            nexusDailyMarketActivity,
            nexusOwnEntryRegime5m,
            nexusBtcMacroRegime6h,
            nexusPriceImpulse,
            nexusFundingContext,
            liquidationFactorSnapshot,
            liquidationFactorDecision,
            nexusVolumeTiming,
            nexusTemporalShadow,
            nexusMarketEyeDecision,
            nexusDecisionSnapshot,
            strategyModelProgress,
            explorationLiquidationEventCount,
            ...(explorationProbe
              ? { explorationOrderFirst: explorationEntryPolicy }
              : {}),
            executionAuthorization: entryAuthorizationEvidence(
              explorationProbe ? "EXPLORATION_PROBE" : "CONFIRMED_EYE",
              {
                reasonCode: explorationProbe
                  ? explorationEntryPolicy.reasonCode
                  : nexusMarketEyeDecision.code,
                retainedExplorationCandidateForLearning:
                  !explorationProbe && probabilityExplorationAllowed,
              },
            ),
            bookEyePrewarm:
              bookEyePrewarmReady ? "READY" : "SUBSCRIBING",
            bookEyeFinalGate: "REQUIRE_FRESH_WITHIN_500MS",
            sourceLiquidationId: marketWake ? null : liquidation.id,
            sourceMarketWakeId: marketWake ? liquidation.id : null,
            strategyBranchRole: branchRole,
            contrarianProbe: branchRole === "CONTRARIAN_PROBE"
              ? {
                  version: 2,
                  originalRejectedDirection: "LONG",
                  contrarianDirection: "SHORT",
                  sourceTraceId: recentRejectedLong?.traceId ?? null,
                  sourceRejectionCode:
                    recentRejectedLong?.resultCode ?? null,
                  probeNotionalUsdt:
                    liquidationConfig.risk.positionManagement!
                      .contrarianProbeNotionalUsdt,
                  profitRoeBeforeHedge:
                    liquidationConfig.risk.positionManagement!
                      .contrarianProfitRoeBeforeHedge,
                  profitAction:
                    "PROTECT_AND_WAIT_FOR_INDEPENDENT_SIGNAL",
                  automaticOppositeHedgeAllowed: false,
                  averagingDownAllowed: false,
                }
              : null,
          }),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!trace) continue;
      await appendEvent(trace.traceId, strategy.id, {
        eventType: `NEXUS_BRAIN_SHADOW:${nexusBrainShadow.state}`,
        message:
          `NEXUS大脑做空影子：${nexusBrainShadow.reasons.map((item) => item.message).join("；")}`,
        detail: {
          ...nexusBrainShadow,
          triggerLiquidationSide: liquidation.side,
          nexusOpportunity,
          orderAffecting: false,
        },
      });
      if (explorationProbe)
        await appendEvent(trace.traceId, strategy.id, {
          eventType: "NEXUS_EXPLORATION_SHORT_PROBE_CANDIDATE",
          stage: "ORDER",
          outcome: "INFO",
          message:
            `证据尚未完全闭合，做空独立探针资格已形成；这不是大脑正常批准，` +
            `也尚未代表本订单已经提交。当前账户已提交或持有 ${strategyModelProgress.committedEntryOrders}/` +
            `${strategyModelProgress.targetOrders} 个做空学习探针；最终授权后才进入中央执行预留，` +
            (explorationEntryPolicy.orderType === "MARKET"
              ? "按策略配置立即市价成交"
              : `${explorationEntryPolicy.orderType === "ADAPTIVE" ? "按自适应模式择价" : `限价偏移 ${explorationEntryPolicy.limitOffsetPercent}%`}，` +
                `${explorationEntryPolicy.orderTtlSeconds} 秒未成交自动撤单`),
          detail: explorationEntryPolicy,
        });
      await appendEvent(trace.traceId, strategy.id, {
        eventType:
          `NEXUS_PURE_STATE:${nexusPureStateMachine.machine}:${nexusPureStateMachine.state}`,
        message:
          `${nexusPureStateMachine.machine} 状态机：${nexusPureStateMachine.state}；` +
          (nexusPureStateMachine.missing.join("、") || "影子证据已闭合"),
        detail: nexusPureStateMachine,
      });
      await appendEvent(trace.traceId, strategy.id, {
        eventType:
          `NEXUS_PURE_STATE:${nexusTrendBreakoutStateMachine.machine}:${nexusTrendBreakoutStateMachine.state}`,
        message:
          `做空趋势突破状态机：${nexusTrendBreakoutStateMachine.state}；` +
          (nexusTrendBreakoutStateMachine.missing.join("、") ||
            "影子证据已闭合"),
        detail: nexusTrendBreakoutStateMachine,
      });
      await appendEvent(trace.traceId, strategy.id, {
        eventType: "NEXUS_LIQUIDATION_CONTEXT_30M",
        message: nexusLiquidationContextSummary(nexusPriceImpulse),
        detail: nexusPriceImpulse,
      });
      if (liquidationFactorSnapshot && liquidationFactorDecision)
        await appendEvent(trace.traceId, strategy.id, {
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
            factorFactId: liquidationFactorFact?.id ?? null,
            factors: liquidationFactorSnapshot.factors,
            confirmations: liquidationFactorSnapshot.confirmations,
            decision: liquidationFactorDecision,
          },
        });
      await appendEvent(trace.traceId, strategy.id, {
        eventType: `NEXUS_VOLUME_TIMING:${nexusVolumeTiming.state}`,
        message: `量价时序：${nexusVolumeTiming.summary}`,
        detail: nexusVolumeTiming,
        stage: "SIGNAL",
        outcome:
          nexusVolumeTiming.state === "CURRENT_EXECUTION_CONFIRMED"
            ? "PASSED"
            : "INFO",
      });
      await appendEvent(trace.traceId, strategy.id, {
        eventType: `NEXUS_TEMPORAL_SHADOW:${nexusTemporalShadow.phase}`,
        message: nexusTemporalShadow.summary,
        detail: nexusTemporalShadow,
        stage: "SIGNAL",
        outcome: "INFO",
      });
      await appendEvent(trace.traceId, strategy.id, {
        eventType:
          `NEXUS_BTC_MACRO_6H:${nexusBtcMacroRegime6h.regime}`,
        message:
          `BTC大盘背景：最近6根已收盘1小时K线为` +
          `${nexusMarketRegimeLabel(nexusBtcMacroRegime6h.regime)}；` +
          nexusBtcMacroRegime6h.reason,
        detail: nexusBtcMacroRegime6h,
      });
      await appendEvent(trace.traceId, strategy.id, {
        eventType:
          `NEXUS_OWN_MULTI_HOUR:${nexusOwnMultiHourContext.decisionRegime}`,
        message: nexusMultiHourContextSummary(
          nexusOwnMultiHourContext,
        ),
        detail: nexusOwnMultiHourContext,
      });
      await appendEvent(trace.traceId, strategy.id, {
        eventType:
          `NEXUS_DAILY_ACTIVITY:${nexusDailyMarketActivity.opportunityContext}`,
        message: nexusDailyMarketActivitySummary(
          nexusDailyMarketActivity,
        ),
        detail: nexusDailyMarketActivity,
      });
      await appendEvent(trace.traceId, strategy.id, {
        eventType:
          `NEXUS_OWN_ENTRY_5M:${nexusOwnEntryRegime5m.regime}`,
        message:
          `目标币入场节奏：${nexusMarketRegimeLabel(nexusOwnEntryRegime5m.regime)}；` +
          nexusOwnEntryRegime5m.reason,
        detail: nexusOwnEntryRegime5m,
      });
      await appendEvent(trace.traceId, strategy.id, {
        eventType:
          `NEXUS_FUNDING_CONTEXT:${nexusFundingContext.regime}`,
        message: `资金费率证据：${nexusFundingContext.summary}`,
        detail: { ...nexusFundingContext },
        stage: "SIGNAL",
        outcome: "INFO",
      });
      await appendEvent(trace.traceId, strategy.id, {
        eventType:
          `NEXUS_MARKET_EYE:${nexusMarketEyeDecision.verdict}`,
        message:
          `NEXUS眼睛（${nexusDecisionSnapshot.integritySummary}）：` +
          nexusMarketEyeDecision.summary,
        detail: nexusMarketEyeDecision,
        stage: "SIGNAL",
        outcome:
          nexusMarketEyeDecision.verdict === "CONFIRMED"
            ? "PASSED"
            : nexusMarketEyeDecision.verdict === "BLOCKED"
              ? "REJECTED"
              : "INFO",
      });
      if (branchRole === "CONTRARIAN_PROBE") {
        await appendEvent(trace.traceId, strategy.id, {
          eventType: "CONTRARIAN_HANDOFF_CONFIRMED",
          message:
            "做多方向拒绝已交接给独立做空分支；做空破位、反抽失败和成交量条件均已重新确认",
          detail: {
            sourceTraceId: recentRejectedLong?.traceId ?? null,
            sourceRejectionCode: recentRejectedLong?.resultCode ?? null,
            branchRole,
            supportBreakConfirmed:
              structure.supportBreakConfirmed,
            failedRetestConfirmed:
              structure.failedRetestConfirmed,
            executionVolumeRatio1m,
            orderSubmissionAllowed: true,
            automaticOppositeHedgeAllowed: false,
            averagingDownAllowed: false,
          },
        });
      }
      const frozenEntryEvidence = parseJson(trace.entryEvidenceJson);
      const approvedAt = new Date();
      const executionWindow = buildFrozenExecutionWindow({
        approvedAt,
        analysisValiditySeconds:
          liquidationConfig.trigger.analysisValiditySeconds,
      });
      frozenEntryEvidence.frozenExecutionDecision = {
        version: 1,
        approved: true,
        decisionFrozen: true,
        retryWithoutReanalysis: true,
        explorationProbe,
        branchRole,
        approvedAt: executionWindow.approvedAt,
        executionValidityMs: executionWindow.executionValidityMs,
        executionExpiresAt: executionWindow.executionExpiresAt,
        approvalCode: explorationProbe
          ? explorationEntryPolicy.reasonCode
          : nexusMarketEyeDecision.code,
        approvalSummary: explorationProbe
          ? "学习探针已通过入场判断；环境恢复后直接进入执行安全复核"
          : nexusMarketEyeDecision.summary,
        waitCode: "NEXUS_EXECUTION_PENDING",
        waitMessage: "业务判断已通过，等待首次执行安全复核",
      };
      await db
        .update(strategyExecutionTraces)
        .set({
          state: "ORDER_READY",
          resultCode: "NEXUS_SHORT_EXECUTION_APPROVED",
          resultMessage:
            "业务判断已通过；执行结论已冻结，环境恢复后不再重新判断趋势",
          entryEvidenceJson: JSON.stringify(frozenEntryEvidence),
          expiresAt: new Date(
            Math.max(
              trace.expiresAt.getTime(),
              executionWindow.executionExpiresAtMs,
            ),
          ),
          completedAt: null,
          updatedAt: approvedAt,
        })
        .where(eq(strategyExecutionTraces.id, trace.id));
      await appendEvent(trace.traceId, strategy.id, {
        eventType: explorationProbe
          ? "NEXUS_BRAIN_CANDIDATE_APPROVED:EXPLORATION_PROBE"
          : "NEXUS_BRAIN_CANDIDATE_APPROVED:CONFIRMED_EYE",
        stage: "ORDER",
        outcome: "PASSED",
        message: explorationProbe
          ? "独立做空探针规则已批准最小量学习订单；该授权不等同于正常策略确认。"
          : "NEXUS眼睛已完整确认，大脑最终批准做空策略订单进入执行安全复核。",
        detail: {
          authorizationMode: explorationProbe
            ? "EXPLORATION_PROBE"
            : "CONFIRMED_EYE",
          explorationProbe,
          minimumQuantityOnly: explorationProbe,
          orderSubmissionAllowed: true,
          reasonCode: explorationProbe
            ? explorationEntryPolicy.reasonCode
            : nexusMarketEyeDecision.code,
        },
        eventAt: approvedAt,
      });
      trace.state = "ORDER_READY";
      trace.resultCode = "NEXUS_SHORT_EXECUTION_APPROVED";
      trace.resultMessage =
        "业务判断已通过；执行结论已冻结，环境恢复后不再重新判断趋势";
      trace.entryEvidenceJson = JSON.stringify(frozenEntryEvidence);
      trace.expiresAt = new Date(
        Math.max(
          trace.expiresAt.getTime(),
          executionWindow.executionExpiresAtMs,
        ),
      );
      const submitted = await executeShortLiveEntrySafely({
        trace,
        strategy,
        config: explorationProbe
          ? explorationExecutionConfig(liquidationConfig)
          : liquidationConfig,
        markPrice: mark.markPrice,
        decision,
        structure,
        branchRole,
        explorationProbe,
      });
      if (submitted) liveOrdersCreated += 1;
      created += 1;
      strategyCreated += 1;
      activeAnalysisCount += 1;
    }
    const firstCandidate = diagnosticCandidates[0] ?? null;
    diagnostics.push({
      strategyId: strategy.id,
      strategyName: strategy.name,
      direction: liquidationConfig.direction,
      status:
        strategyCreated > 0
          ? "ORDER_CREATED"
          : diagnosticCandidates.some(
          (item) => item.nexusMarketEyeDecision.verdict === "CONFIRMED",
        )
          ? "READY"
          : diagnosticCandidates.length
            ? "EVALUATED"
            : cooldownSkipped > 0
              ? "COOLDOWN"
              : "NO_CANDIDATES",
      evaluatedCandidates: diagnosticCandidates.length,
      recentCandidateCount: strategyCandidates.length,
      candidate: firstCandidate
        ? {
            symbol: firstCandidate.symbol,
            liquidationSide: firstCandidate.liquidationSide,
            liquidationNotional: round(firstCandidate.liquidationNotional),
            liquidationPrice: round(firstCandidate.liquidationPrice, 8),
            markPrice: round(firstCandidate.markPrice, 8),
            decisionStatus: firstCandidate.decision.status,
            decisionReason: firstCandidate.decision.reason,
            marketEyeVerdict:
              firstCandidate.nexusMarketEyeDecision.verdict,
            marketEyeReason:
              firstCandidate.nexusMarketEyeDecision.summary,
            supportBreakConfirmed:
              firstCandidate.structure.supportBreakConfirmed,
            failedRetestConfirmed:
              firstCandidate.structure.failedRetestConfirmed,
            executionVolumeRatio1m:
              firstCandidate.executionVolumeRatio1m === null
              ? null
              : round(firstCandidate.executionVolumeRatio1m, 2),
            nexusBrainShadowState:
              firstCandidate.nexusBrainShadow.state,
            nexusPureState:
              firstCandidate.nexusPureStateMachine.state,
            nexusTrendBreakoutState:
              firstCandidate.nexusTrendBreakoutStateMachine.state,
            nexusPureMissing:
              firstCandidate.nexusPureStateMachine.missing,
            shadowOriginalDisagreement:
              firstCandidate.shadowOriginalDisagreement,
          }
        : null,
      reason: strategyOccupiedPositionSkipped > 0
          ? `有 ${strategyOccupiedPositionSkipped} 个候选已存在实盘仓位，已在读取K线前跳过。`
          : strategyWorkingOrderSkipped > 0
            ? `有 ${strategyWorkingOrderSkipped} 个候选已有待处理订单，已在读取K线前跳过。`
        : firstCandidate
        ? `${firstCandidate.symbol} NEXUS眼睛 ${firstCandidate.nexusMarketEyeDecision.verdict}：${firstCandidate.nexusMarketEyeDecision.summary}`
        : cooldownSkipped > 0
          ? `近期候选均处于冷却期，跳过 ${cooldownSkipped} 个。`
          : invalidTradingRuleSkipped > 0
            ? `有 ${invalidTradingRuleSkipped} 个候选缺少有效交易规则，无法计算交易所最小量。`
          : "最近没有满足合约池、方向、冷却和价格数据条件的做空候选。",
    });
    await upsertShortMonitorStatus({
      strategy,
      config,
      triggerKind: liquidationConfig.trigger.kind,
      executionDirection: resolveStrategyExecutionDirection({
        mode: liquidationConfig.execution.directionMode,
        brainDirection: "SHORT",
      }),
      market60m: strategyMarket60m,
      globalContext,
      liquidationMarketContext,
      longLiquidationSharePercent,
      candidate: diagnosticCandidates[0] ?? null,
      recentCandidateCount: strategyCandidates.length,
      liveDirection: true,
    });
  }

  // Advance only after the whole direction cycle succeeds. A failed cycle
  // leaves the cursor unchanged so the same unseen events are retried; trace
  // ids and execution intents continue to provide business-level idempotency.
  shortLiquidationSequenceCursor = feed.lastSequence;
  marketFactCycle.clear();
  marketAnalysisCycle.clear();

  const checkedAt = new Date().toISOString();
  const unifiedMarketData = nexusUnifiedMarketData.metrics();
  if (compactResponse)
    return Response.json({
      strategies: activeShortStrategies.length,
      evaluated,
      created,
      liveOrdersCreated,
      occupiedPositionSuppressed,
      workingOrderSuppressed,
      liveOrderAuthorized: liveRuntime().enabled,
      diagnosticCount: diagnostics.length,
      unifiedMarketData,
      timings: { totalMs: Date.now() - startedAt },
      checkedAt,
    });

  return Response.json({
    strategies: activeShortStrategies.length,
    evaluated,
    created,
    liveOrdersCreated,
    occupiedPositionSuppressed,
    workingOrderSuppressed,
    liveOrderAuthorized: liveRuntime().enabled,
    diagnostics,
    market60m,
    oneHourLongLiquidationSharePercent:
      longLiquidationSharePercent,
    liquidationMarketContext,
    unifiedMarketData,
    checkedAt,
  });
}

async function currentShortStrategyModelProgress(
  strategy: typeof strategies.$inferSelect,
  orderFirstEntryTarget?: number,
) {
  const counts = await readStrategyModelProgressCounts({
    ownerEmail: strategy.ownerEmail,
    strategyId: strategy.id,
    configVersion: strategy.configVersion,
  });
  return strategyModelPhase({
    ...counts,
    orderFirstEntryTarget,
  });
}

async function retryFrozenShortExecutionDecisions(
  strategy: typeof strategies.$inferSelect,
) {
  const db = getDb();
  const now = new Date();
  const traces = await db
    .select()
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.strategyId, strategy.id),
        eq(strategyExecutionTraces.accountId, strategy.accountId),
        or(
          and(
            eq(strategyExecutionTraces.state, "ORDER_READY"),
            // The frozen-decision evidence below is the authoritative retry
            // gate. Restricting this query to a fixed result-code list left
            // dynamic revalidation and coordinator waits permanently stuck.
            eq(strategyExecutionTraces.accountId, strategy.accountId),
          ),
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
        lte(
          strategyExecutionTraces.updatedAt,
          new Date(now.getTime() - SHORT_EXECUTION_RETRY_INTERVAL_MS),
        ),
      ),
    )
    .orderBy(asc(strategyExecutionTraces.updatedAt))
    .limit(3);
  let liveOrdersCreated = 0;
  for (const trace of traces) {
    const evidence = parseJson(trace.entryEvidenceJson);
    const frozenDecision =
      evidence.frozenExecutionDecision &&
        typeof evidence.frozenExecutionDecision === "object" &&
        !Array.isArray(evidence.frozenExecutionDecision)
        ? evidence.frozenExecutionDecision as Record<string, unknown>
        : {};
    if (
      frozenDecision.approved !== true ||
      frozenDecision.decisionFrozen !== true ||
      frozenDecision.retryWithoutReanalysis !== true
    )
      continue;
    const config = liquidationConfigForShort(
      parseJson(trace.configSnapshotJson),
    );
    if (!config) continue;
    const executionDeadline = resolveFrozenExecutionDeadline({
      frozenDecision,
      analysisValiditySeconds: config.trigger.analysisValiditySeconds,
    });
    if (
      executionDeadline === null ||
      executionDeadline <= now.getTime()
    ) {
      const expiryReason = frozenExecutionExpiryReason(frozenDecision);
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
      await appendEvent(trace.traceId, strategy.id, {
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
      });
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
      await appendEvent(trace.traceId, strategy.id, {
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
    const decision =
      evidence.decision &&
        typeof evidence.decision === "object" &&
        !Array.isArray(evidence.decision)
        ? evidence.decision as ReturnType<
          typeof evaluateShortDowntrendContinuation
        >
        : null;
    const structure =
      evidence.structure &&
        typeof evidence.structure === "object" &&
        !Array.isArray(evidence.structure)
        ? evidence.structure as ReturnType<typeof analyzeShortBreakRetest>
        : null;
    if (!decision || !structure) continue;
    let markPrice = Number(evidence.entryPrice);
    const deferFrozenMarkPrice = async (waitMessage: string) => {
      const renewal = renewFrozenExecutionDecision({
        frozenDecision: {
          ...frozenDecision,
          waitCode: "SHORT_LIVE_MARK_PRICE_WAIT",
          waitMessage,
          lastDeferredAt: now.toISOString(),
        },
        deferredAt: now,
        waitCode: "SHORT_LIVE_MARK_PRICE_WAIT",
        analysisValiditySeconds: config.trigger.analysisValiditySeconds,
        allowRenewal: true,
        maxRenewals: MAX_FROZEN_EXECUTION_RENEWALS,
      });
      evidence.frozenExecutionDecision = renewal.decision;
      const renewedDeadline = renewal.executionExpiresAtMs;
      await db.update(strategyExecutionTraces).set({
        resultCode: "SHORT_LIVE_MARK_PRICE_WAIT",
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
        markPrice = latestMark.markPrice;
    } catch (error) {
      const waitMessage = error instanceof Error
        ? `最新标记价格读取失败：${error.message}`
        : "最新标记价格读取失败";
      await deferFrozenMarkPrice(waitMessage);
      continue;
    }
    if (!Number.isFinite(markPrice) || markPrice <= 0) {
      const waitMessage = "最新标记价格无效，等待行情恢复";
      await deferFrozenMarkPrice(waitMessage);
      continue;
    }
    const submitted = await executeShortLiveEntrySafely({
      trace,
      strategy,
      config:
        frozenDecision.explorationProbe === true
          ? explorationExecutionConfig(config)
          : config,
      markPrice,
      decision,
      structure,
      branchRole:
        frozenDecision.branchRole === "CONTRARIAN_PROBE"
          ? "CONTRARIAN_PROBE"
          : "PRIMARY_SHORT",
      explorationProbe: frozenDecision.explorationProbe === true,
    });
    if (submitted) liveOrdersCreated += 1;
  }
  return { checked: traces.length, liveOrdersCreated };
}

type ShortLiveEntryInput = {
  trace: typeof strategyExecutionTraces.$inferSelect;
  strategy: typeof strategies.$inferSelect;
  config: LiquidationTrendConfig;
  markPrice: number;
  decision: ReturnType<typeof evaluateShortDowntrendContinuation>;
  structure: ReturnType<typeof analyzeShortBreakRetest>;
  branchRole: "PRIMARY_SHORT" | "CONTRARIAN_PROBE";
  explorationProbe: boolean;
};

async function executeShortLiveEntrySafely(
  input: ShortLiveEntryInput,
) {
  try {
    return await executeShortLiveEntry(input);
  } catch (error) {
    const deferredAt = new Date();
    const evidence = parseJson(input.trace.entryEvidenceJson);
    const frozenDecision =
      evidence.frozenExecutionDecision &&
        typeof evidence.frozenExecutionDecision === "object" &&
        !Array.isArray(evidence.frozenExecutionDecision)
        ? evidence.frozenExecutionDecision as Record<string, unknown>
        : {};
    const message = error instanceof Error
      ? `做空执行链暂时异常：${error.message}`
      : "做空执行链暂时异常";
    const renewal = renewFrozenExecutionDecision({
      frozenDecision: {
        ...frozenDecision,
        waitCode: "SHORT_EXECUTION_PIPELINE_RECOVERY_WAIT",
        waitMessage: message,
        lastDeferredAt: deferredAt.toISOString(),
      },
      deferredAt,
      waitCode: "SHORT_EXECUTION_PIPELINE_RECOVERY_WAIT",
      analysisValiditySeconds: input.config.trigger.analysisValiditySeconds,
      allowRenewal: true,
      maxRenewals: MAX_FROZEN_EXECUTION_RENEWALS,
    });
    evidence.frozenExecutionDecision = renewal.decision;
    const [deferredTrace] = await getDb()
      .update(strategyExecutionTraces)
      .set({
        state: "ORDER_READY",
        resultCode: "SHORT_EXECUTION_PIPELINE_RECOVERY_WAIT",
        resultMessage: message,
        entryEvidenceJson: JSON.stringify(evidence),
        ...(renewal.executionExpiresAtMs !== null
          ? { expiresAt: new Date(renewal.executionExpiresAtMs) }
          : {}),
        completedAt: null,
        updatedAt: deferredAt,
      })
      .where(
        and(
          eq(strategyExecutionTraces.id, input.trace.id),
          inArray(strategyExecutionTraces.state, [
            "ANALYZING",
            "ARMED",
            "ORDER_READY",
          ]),
        ),
      )
      .returning({ id: strategyExecutionTraces.id });
    if (!deferredTrace) return false;
    await appendEvent(input.trace.traceId, input.strategy.id, {
      eventType: "SHORT_EXECUTION_PIPELINE_RECOVERY_WAIT",
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

async function executeShortLiveEntry(input: ShortLiveEntryInput) {
  const db = getDb();
  const runtime = liveRuntime();
  const executionAttemptStartedAt = new Date();
  const executionDirection = resolveStrategyExecutionDirection({
    mode: input.config.execution.directionMode,
    brainDirection: "SHORT",
  });
  const directionEvidence = parseJson(input.trace.entryEvidenceJson);
  Object.assign(
    directionEvidence,
    buildAutomatedEntryDirectionEvidence(executionDirection),
  );
  input.trace.entryEvidenceJson = JSON.stringify(directionEvidence);
  let executionIntentKey: string | null = null;
  const defer = async (
    code: string,
    message: string,
    detail: Record<string, unknown> = {},
  ) => {
    const deferredAt = new Date();
    const evidence = parseJson(input.trace.entryEvidenceJson);
    const existingFrozen =
      evidence.frozenExecutionDecision &&
        typeof evidence.frozenExecutionDecision === "object" &&
        !Array.isArray(evidence.frozenExecutionDecision)
        ? evidence.frozenExecutionDecision as Record<string, unknown>
        : {};
    const baseFrozenExecutionDecision = {
      ...existingFrozen,
      version: 1,
      approved: true,
      decisionFrozen: true,
      retryWithoutReanalysis: true,
      explorationProbe: input.explorationProbe,
      branchRole: input.branchRole,
      lastDeferredAt: deferredAt.toISOString(),
      waitCode: code,
      waitMessage: message,
      waitDetail: detail,
    };
    const renewal = renewFrozenExecutionDecision({
      frozenDecision: baseFrozenExecutionDecision,
      deferredAt,
      waitCode: code,
      analysisValiditySeconds: input.config.trigger.analysisValiditySeconds,
      allowRenewal: true,
      maxRenewals: MAX_FROZEN_EXECUTION_RENEWALS,
    });
    evidence.frozenExecutionDecision = renewal.decision;
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
                  input.trace.expiresAt.getTime(),
                  renewal.executionExpiresAtMs,
                ),
              ),
            }
          : {}),
        completedAt: null,
        updatedAt: deferredAt,
      })
      .where(eq(strategyExecutionTraces.id, input.trace.id));
    await appendEvent(input.trace.traceId, input.strategy.id, {
      eventType: code,
      stage: "ORDER",
      outcome: "PENDING",
      message,
      detail: {
        ...detail,
        positionSide: executionDirection.positionSide,
        orderSubmissionAllowed: false,
        retryWithoutReanalysis: true,
        executionWindowRenewed: renewal.renewed,
        executionExpiresAt:
          renewal.executionExpiresAtMs !== null
            ? new Date(renewal.executionExpiresAtMs).toISOString()
            : null,
      },
      eventAt: deferredAt,
    });
    return false;
  };
  const reject = async (code: string, message: string, detail: unknown = {}) => {
    if (executionIntentKey) {
      try {
        await advanceNexusExecutionIntent({
          intentKey: executionIntentKey,
          nextStatus: "REJECTED",
          reasonCode: code,
          reasonMessage: message,
          detail:
            detail && typeof detail === "object" && !Array.isArray(detail)
              ? detail as Record<string, unknown>
              : {},
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
        entryEvidenceJson: input.trace.entryEvidenceJson,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(strategyExecutionTraces.id, input.trace.id));
    await appendEvent(input.trace.traceId, input.strategy.id, {
      eventType: code,
      message,
      detail: {
        ...(detail && typeof detail === "object" ? detail : {}),
        positionSide: executionDirection.positionSide,
        orderSubmissionAllowed: false,
      },
    });
    return false;
  };
  const entryAuthorization = resolveNexusEntryAuthorization(
    directionEvidence,
    { expectedPositionSide: executionDirection.positionSide },
  );
  const retiredVersionBlock = retiredNexusExecutionVersionBlock({
    traceConfigVersion: input.trace.configVersion,
    currentConfigVersion: input.strategy.configVersion,
    evidence: directionEvidence,
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
  const validationBlock = await nexusConfigValidationEntryBlock({
    strategyId: input.strategy.id,
    configVersion: input.trace.configVersion,
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
  if (!entryAuthorization.authorized)
    return reject(
      "NEXUS_EXECUTION_AUTHORIZATION_MISSING",
      "当前做空执行证据没有显式或冻结授权，已失败关闭并禁止提交订单",
      { entryAuthorization },
    );
  if (
    !runtime.enabled ||
    input.strategy.strategyType === "SENTINEL" ||
    !(await liveTradingAllowedByServer())
  )
    return reject(
      input.strategy.strategyType === "SENTINEL"
        ? "SENTINEL_ADVISORY_ONLY"
        : "SHORT_LIVE_RUNTIME_NOT_AUTHORIZED",
      input.strategy.strategyType === "SENTINEL"
        ? "哨兵已完成做空判断并记录提示；仅观察模式禁止下单"
        : "做空方向已满足，但服务端尚未开放实盘自动下单",
    );
  const [account, credential, symbol] = await Promise.all([
    db
      .select()
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.ownerEmail, input.strategy.ownerEmail),
          eq(tradingAccounts.accountId, input.strategy.accountId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select()
      .from(exchangeCredentials)
      .where(
        and(
          eq(exchangeCredentials.ownerEmail, input.strategy.ownerEmail),
          eq(exchangeCredentials.accountId, input.strategy.accountId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select()
      .from(contractSymbols)
      .where(
        and(
          eq(contractSymbols.symbol, input.trace.symbol),
          eq(contractSymbols.isActive, true),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (!account || account.accountType !== "STRATEGY")
    return reject("SHORT_LIVE_ACCOUNT_INVALID", "做空策略交易子账户无效");
  const readiness = getTradeReadiness(
    account,
    credential,
    await liveTradingAllowedByServer(),
  );
  if (!credential || !readiness.liveReady)
    return reject(
      "SHORT_LIVE_ACCOUNT_NOT_READY",
      readiness.blockers.join("；") || "做空策略账户实盘密钥未就绪",
    );
  if (!symbol)
    return defer(
      "SHORT_LIVE_SYMBOL_RULES_WAIT",
      "本地交易所合约规则暂不可用；不创建委托，等待合约规则恢复",
    );
  const contractLeverageDecision = evaluateAutomatedEntryContractLeverage(
    symbol.maxLeverage,
    input.config.execution.leverage,
  );
  if (contractLeverageDecision.code === "CONTRACT_LEVERAGE_UNKNOWN")
    return defer(
      "SHORT_LIVE_CONTRACT_LEVERAGE_WAIT",
      `${input.trace.symbol} 的 Binance 合约最大杠杆尚未同步；不创建委托，等待合约规则恢复`,
      contractLeverageDecision,
    );
  if (!contractLeverageDecision.allowed)
    return reject(
      "SHORT_LIVE_CONTRACT_MAX_LEVERAGE_TOO_LOW",
      `${input.trace.symbol} 的 Binance 合约最高仅 ${contractLeverageDecision.contractMaximumLeverage} 倍；自动策略要求合约至少支持 ${contractLeverageDecision.minimumRequiredLeverage} 倍，本次直接弃单`,
      contractLeverageDecision,
    );
  const keys = {
    apiKey: await decryptCredential(
      credential.apiKeyCiphertext,
      credential.apiKeyIv,
      credentialContext(
        input.strategy.ownerEmail,
        input.strategy.accountId,
        "api-key",
      ),
    ),
    secretKey: await decryptCredential(
      credential.secretKeyCiphertext,
      credential.secretKeyIv,
      credentialContext(
        input.strategy.ownerEmail,
        input.strategy.accountId,
        "secret-key",
      ),
    ),
  };
  const unknownOrderReconciliation =
    await reconcileUnknownAccountOrdersBeforeEntry({
      ownerEmail: input.strategy.ownerEmail,
      accountId: input.strategy.accountId,
      credentials: keys,
    });
  if (unknownOrderReconciliation.checked > 0)
    await appendEvent(input.trace.traceId, input.strategy.id, {
      eventType: "SHORT_UNKNOWN_ORDER_RECONCILED",
      message: unknownOrderReconciliation.stillUnknown > 0
        ? "未知订单已核对，仍有成交结果待仓位恢复"
        : "未知订单已核对并收敛，不再冻结其他合约",
      detail: unknownOrderReconciliation,
    });
  let systemMetrics: Awaited<ReturnType<typeof getBinanceLiveSystemMetrics>>;
  try {
    systemMetrics = await getBinanceLiveSystemMetrics();
  } catch (error) {
    return defer(
      "SHORT_LIVE_REST_CAPACITY_WAIT",
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
      "SHORT_LIVE_REST_CAPACITY_WAIT",
      "本项目 Binance REST 预留不足；已冻结下单结论，恢复后直接重试执行",
      {
        remainingRestWeight: restCapacity.remainingRestWeight,
        requiredRemainingWeight: restCapacity.requiredRemainingWeight,
        localEstimatedWeight:
          systemMetrics.rest?.localEstimatedWeight ?? null,
        binanceObservedWeight:
          systemMetrics.rest?.binanceObservedWeight ?? null,
      },
    );
  const strategyDailyPnl = await readTradingStrategyDailyPnl(
    { email: input.strategy.ownerEmail, accountId: input.strategy.accountId },
    account,
    input.strategy.id,
  );
  const dailyLossLimit = input.config.risk.dailyLossLimitUsdt;
  if (strategyDailyPnl.dailyPnl <= -dailyLossLimit)
    return reject(
      "SHORT_LIVE_DAILY_LOSS_LIMIT",
      `本策略当日已实现与当前未实现综合盈亏已触及 -${dailyLossLimit.toFixed(2)} USDT 熔断线`,
      {
        strategyId: input.strategy.id,
        dailyPnl: strategyDailyPnl.dailyPnl,
        dailyRealizedPnl: strategyDailyPnl.dailyRealizedPnl,
        unrealizedPnl: strategyDailyPnl.unrealizedPnl,
      },
    );
  const { startedAt } = chinaTradingDayWindow();
  const [openPositions, pendingOrders, dailyOrders] = await Promise.all([
    db
      .select()
      .from(livePositions)
      .where(
        and(
          eq(livePositions.ownerEmail, input.strategy.ownerEmail),
          eq(livePositions.accountId, input.strategy.accountId),
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
          eq(liveOrderEvents.ownerEmail, input.strategy.ownerEmail),
          eq(liveOrderEvents.accountId, input.strategy.accountId),
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
        clientOrderId: liveOrderEvents.clientOrderId,
        estimatedNotional: liveOrderEvents.estimatedNotional,
        responseJson: liveOrderEvents.responseJson,
      })
      .from(liveOrderEvents)
      .where(
        and(
          eq(liveOrderEvents.ownerEmail, input.strategy.ownerEmail),
          eq(liveOrderEvents.accountId, input.strategy.accountId),
          eq(liveOrderEvents.testOnly, false),
          gte(liveOrderEvents.createdAt, startedAt),
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
    targetSymbol: input.trace.symbol,
    targetPositionSide: executionDirection.positionSide,
    positionMode: credential.positionMode ?? "ONE_WAY",
  });
  if (
    !orderConcurrency.allowed &&
    (
      orderConcurrency.code === "EXECUTION_UNKNOWN_ORDER" ||
      input.config.execution.sameLegWorkingOrderPolicy !== "ALLOW"
    )
  )
    return reject(
      orderConcurrency.code === "EXECUTION_UNKNOWN_ORDER"
        ? "SHORT_LIVE_EXECUTION_UNKNOWN_ORDER"
        : "SHORT_LIVE_PENDING_ORDER_SAME_LEG",
      orderConcurrency.code === "EXECUTION_UNKNOWN_ORDER"
        ? "账户存在执行结果未知的订单，核对完成前禁止新增自动仓位"
        : `${input.trace.symbol} 已存在同方向工作订单，本轮不重复提交做空委托`,
      {
        blockingOrderId: orderConcurrency.blockingOrder.id ?? null,
        blockingSymbol: orderConcurrency.blockingOrder.symbol,
        blockingPositionSide:
          orderConcurrency.blockingOrder.positionSide,
        blockingStatus: orderConcurrency.blockingOrder.status,
        reservedNotional: orderConcurrency.reservedNotional,
      },
    );
  const openPositionTraces = openPositions.length
    ? await db
        .select({
          positionId: strategyExecutionTraces.positionId,
          strategyId: strategyExecutionTraces.strategyId,
          symbol: strategyExecutionTraces.symbol,
          state: strategyExecutionTraces.state,
        })
        .from(strategyExecutionTraces)
        .where(
          inArray(
            strategyExecutionTraces.positionId,
            openPositions.map((position) => String(position.id)),
          ),
        )
    : [];
  const exchangePositions = await getLivePositionSnapshots(
    keys,
    [
      { symbol: input.trace.symbol, positionSide: "SHORT" },
      { symbol: input.trace.symbol, positionSide: "LONG" },
    ],
  );
  const existingExchangePosition = findBlockingOpenSymbolPosition([
    {
      symbol: input.trace.symbol,
      positionSide: "SHORT" as const,
      quantity: exchangePositions.get(`${input.trace.symbol}:SHORT`)?.quantity ?? 0,
    },
    {
      symbol: input.trace.symbol,
      positionSide: "LONG" as const,
      quantity: exchangePositions.get(`${input.trace.symbol}:LONG`)?.quantity ?? 0,
    },
  ], {
    symbol: input.trace.symbol,
    targetPositionSide: executionDirection.positionSide,
    positionMode: credential.positionMode ?? "ONE_WAY",
  });
  const existingPositionBlockedByStrategy = Boolean(
    existingExchangePosition &&
    (
      input.config.execution.existingPositionPolicy !==
        "ALLOW_SAME_DIRECTION" ||
      existingExchangePosition.positionSide !== executionDirection.positionSide
    ),
  );
  if (existingPositionBlockedByStrategy && existingExchangePosition)
    return reject(
      "SHORT_LIVE_SYMBOL_POSITION_ALREADY_OPEN",
      credential.positionMode === "HEDGE"
        ? `Binance 已存在 ${input.trace.symbol} ${existingExchangePosition.positionSide === "LONG" ? "多" : "空"}仓；双向持仓不重复新开同一方向`
        : `Binance 已存在 ${input.trace.symbol} 仓位；单向持仓禁止继续开仓`,
      {
        existingPositionSide: existingExchangePosition.positionSide,
        existingQuantity: existingExchangePosition.quantity,
        positionMode: credential.positionMode ?? "ONE_WAY",
      },
    );
  // Keep one canonical mutable evidence object from final quote validation
  // through order creation and position handoff. A second parsed copy can
  // persist newer execution facts to the trace while freezing stale facts in
  // the position lifecycle.
  const originalEvidence = directionEvidence;
  let executableMarketPrice = input.markPrice;
  let liveEntrySpreadBps = 0;
  let entryBookDepth: { bidQuantity: number; askQuantity: number } | null = null;
  try {
    const book = await waitForFreshNexusBookTicker(
      input.trace.symbol,
      Math.min(1_500, input.config.trigger.maxSignalDelayMs),
    );
    executableMarketPrice = executionDirection.side === "BUY"
      ? book.askPrice
      : book.bidPrice;
    entryBookDepth = {
      bidQuantity: book.bidQuantity,
      askQuantity: book.askQuantity,
    };
    originalEvidence.nexusBookEyeAtEntry = {
      source: "BINANCE_INDIVIDUAL_BOOK_TICKER_WS",
      ageMs: book.ageMs,
      updateId: book.updateId,
      spreadBps: book.spreadBps,
      imbalance: book.imbalance,
      microPrice: book.microPrice,
      bidQuantity: book.bidQuantity,
      askQuantity: book.askQuantity,
      executableSide: executionDirection.side === "BUY" ? "ASK" : "BID",
      executablePrice: executableMarketPrice,
      directionalImbalance:
        executionDirection.side === "BUY" ? book.imbalance : -book.imbalance,
      staleAfterMs: 500,
    };
    liveEntrySpreadBps = Math.max(0, Number(book.spreadBps) || 0);
    await appendEvent(input.trace.traceId, input.strategy.id, {
      eventType: "NEXUS_BOOK_EYE_READY",
      message: `100毫秒盘口新鲜度通过：${book.ageMs}ms`,
      detail: {
        source: "BINANCE_INDIVIDUAL_BOOK_TICKER_WS",
        ageMs: book.ageMs,
        updateId: book.updateId,
        spreadBps: book.spreadBps,
        imbalance: book.imbalance,
        microPrice: book.microPrice,
        executableSide: executionDirection.side === "BUY" ? "ASK" : "BID",
        executablePrice: executableMarketPrice,
        markToExecutableBps:
          ((executableMarketPrice - input.markPrice) / input.markPrice) * 10_000,
        directionalImbalance:
          executionDirection.side === "BUY" ? book.imbalance : -book.imbalance,
        staleAfterMs: 500,
      },
    });
  } catch (error) {
    return defer(
      "NEXUS_BOOK_EYE_STALE",
      error instanceof Error
        ? error.message
        : "100毫秒盘口未就绪；已冻结下单结论并等待行情恢复",
      {
        staleAfterMs: 500,
        source: "BINANCE_INDIVIDUAL_BOOK_TICKER_WS",
      },
    );
  }
  let probabilityDecision:
    ReturnType<typeof evaluateNexusNetExpectancy> | null = null;
  if (input.config.probabilityPolicy?.mode === "NET_EXPECTANCY") {
    const marketEyeDecision = record(originalEvidence.nexusMarketEyeDecision);
    const probabilityContextIdentity =
      nexusProbabilityContextFromEvidence(originalEvidence);
    const probabilityContext = await loadNexusProbabilityContext({
      strategyId: input.strategy.id,
      policy: input.config.probabilityPolicy,
    });
    probabilityDecision = evaluateNexusNetExpectancy({
      policy: input.config.probabilityPolicy,
      direction: executionDirection.tradeDirection,
      eyeVerdict: String(marketEyeDecision.verdict ?? "UNKNOWN"),
      eyeDataIntegrity: String(
        marketEyeDecision.dataIntegrity ??
          record(originalEvidence.nexusDecisionSnapshot).integrity ??
          "UNAVAILABLE",
      ),
      selectedPath: typeof marketEyeDecision.selectedPath === "string"
        ? marketEyeDecision.selectedPath
        : null,
      marketContextKey: probabilityContextIdentity.marketContextKey,
      samples: probabilityContext.samples,
      stopLossRoePercent: input.config.risk.stopLossPercent,
      takeProfitSteps: input.config.risk.takeProfitSteps,
      leverage: input.config.execution.leverage,
      currentOrderNotionalUsdt:
        input.config.execution.targetOrderNotionalUsdt *
        input.config.execution.leverage,
      liveSpreadBps: liveEntrySpreadBps,
      estimatedFundingCostPercent:
        adverseFundingCostRate({
          direction: executionDirection.tradeDirection,
          fundingRate: Number(
            record(originalEvidence.nexusFundingContext).fundingRate,
          ),
        }) * 100,
      coldStart: probabilityContext.coldStart,
    });
    originalEvidence.nexusNetExpectancyDecision = probabilityDecision;
    input.trace.entryEvidenceJson = JSON.stringify(originalEvidence);
    await appendEvent(input.trace.traceId, input.strategy.id, {
      eventType: `NEXUS_NET_EXPECTANCY_OBSERVED:${probabilityDecision.code}`,
      stage: "ORDER",
      outcome: "INFO",
      message: `历史期望仅供复盘；当前下单继续由眼睛与大脑证据决定。${probabilityDecision.summary}`,
      detail: probabilityDecision,
    });
  }
  const probabilityEntryExecution =
    resolveNexusProbabilityEntryExecution({
      policy: input.config.probabilityPolicy,
      probabilityDecision,
      configuredOrderType: input.config.execution.orderType,
      configuredEntryDistanceExecutionMode:
        input.config.execution.entryDistanceExecutionMode,
    });
  const effectiveExecutionConfig = {
    ...input.config.execution,
    orderType: probabilityEntryExecution.orderType,
    entryDistanceExecutionMode:
      probabilityEntryExecution.entryDistanceExecutionMode,
  };
  const forceExchangeMinimumQuantity =
    probabilityEntryExecution.forceExchangeMinimumQuantity;
  const entryOrderAttempt = Math.max(
    1,
    Math.min(
      2,
      Math.trunc(Number(originalEvidence.entryOrderAttempt) || 1),
    ),
  );
  const maxExecutableMarketChaseDistanceAtr = Math.min(
    input.config.trend.maxEntryDistanceAtr,
    input.config.execution.adaptiveMarketMaxDistanceAtr ?? 0.2,
  );
  const shortEntryRevalidation = revalidateNexusConfirmedShortEntry({
    executionMarkPrice: executableMarketPrice,
    atr5m: input.structure.atr ?? Number.NaN,
    brokenSupport: input.structure.brokenSupport ?? Number.NaN,
    maxEntryDistanceAtr: maxExecutableMarketChaseDistanceAtr,
    requireConfirmedEntryDistance:
      effectiveEntryOrderMode(effectiveExecutionConfig) === "MARKET",
  });
  if (!shortEntryRevalidation.eligible) {
    const detail = {
      executionMarkPrice: executableMarketPrice,
      brokenSupport: input.structure.brokenSupport,
      atr5m: input.structure.atr,
      entryDistanceAtr: shortEntryRevalidation.entryDistanceAtr,
      maxEntryDistanceAtr: maxExecutableMarketChaseDistanceAtr,
      analyticalMaxEntryDistanceAtr:
        input.config.trend.maxEntryDistanceAtr,
      analyticalDecisionReplayed: false,
      executionTimingRevalidated: true,
    };
    if (
      nexusEntryWaitDisposition(shortEntryRevalidation.code) ===
        "TERMINATE_FOR_FRESH_ANALYSIS"
    )
      return reject(
        `SHORT_ENTRY_REVALIDATION_TERMINATED:${shortEntryRevalidation.code}`,
        shortEntryRevalidation.code === "PRICE_TOO_FAR"
          ? "委托前价格已经远离原破位结构；旧做空时机结束，等待新信号重新分析，禁止追空"
          : "委托前价格已经收回原破位支撑；原做空证据失效，等待新信号重新分析",
        {
          ...detail,
          freshAnalysisRequired: true,
        },
      );
    return defer(
      `SHORT_ENTRY_REVALIDATION_WAIT:${shortEntryRevalidation.code}`,
      shortEntryRevalidation.code === "PRICE_TOO_FAR"
        ? "委托前价格已远离破位结构，冻结的是做空方向结论而不是旧成交时机；禁止追空并等待有效期内反抽"
        : shortEntryRevalidation.code === "BROKEN_SUPPORT_RECLAIMED"
          ? "委托前价格已经收回原破位支撑，等待有效期内重新跌破确认"
          : "委托前做空结构数据不完整，等待有效期内获得有效支撑位与 ATR 后复核",
      detail,
    );
  }
  const effectiveRequestedOrderMode = effectiveEntryOrderMode(
    effectiveExecutionConfig,
  );
  const entryDistanceMode = entryDistanceExecutionMode(
    effectiveExecutionConfig,
  );
  const marketEyeDecision = record(originalEvidence.nexusMarketEyeDecision);
  const nexusVolumeTiming = record(originalEvidence.nexusVolumeTiming);
  const nexusBookEyeAtEntry = record(originalEvidence.nexusBookEyeAtEntry);
  const adaptiveExecutionContext = {
    confirmedPath:
      typeof marketEyeDecision.selectedPath === "string"
        ? marketEyeDecision.selectedPath
        : null,
    volumeTimingState:
      typeof nexusVolumeTiming.state === "string"
        ? nexusVolumeTiming.state
        : null,
    bookAgeMs: Number(nexusBookEyeAtEntry.ageMs),
    bookStaleAfterMs: Number(nexusBookEyeAtEntry.staleAfterMs),
    spreadBps: Number(nexusBookEyeAtEntry.spreadBps),
    strategyMaxEntryDistanceAtr: input.config.trend.maxEntryDistanceAtr,
  };
  const entryOrder = configuredShortEntryOrder({
    orderType: effectiveRequestedOrderMode,
    markPrice: executableMarketPrice,
    limitOffsetPercent: input.config.execution.limitOffsetPercent,
      adaptiveMarketMaxDistanceAtr:
      effectiveExecutionConfig.adaptiveMarketMaxDistanceAtr,
    priceTickSize: symbol.priceTickSize,
    brokenSupport: input.structure.brokenSupport,
    atr5m: input.structure.atr,
    adaptiveExecutionContext,
  });
  if (!entryOrder)
    return reject(
      "SHORT_LIVE_ENTRY_PRICE_INVALID",
      "做空策略委托价格无法按交易所价格步长对齐",
    );
  const adaptiveShadowOrder = configuredShortEntryOrder({
    orderType: "ADAPTIVE",
    markPrice: executableMarketPrice,
    limitOffsetPercent: input.config.execution.limitOffsetPercent,
    adaptiveMarketMaxDistanceAtr:
      effectiveExecutionConfig.adaptiveMarketMaxDistanceAtr,
    priceTickSize: symbol.priceTickSize,
    brokenSupport: input.structure.brokenSupport,
    atr5m: input.structure.atr,
    adaptiveExecutionContext,
  });
  const entryExecutionShadow = adaptiveShadowOrder
    ? buildEntryExecutionShadow({
        execution: effectiveExecutionConfig,
        decisionMarkPrice: executableMarketPrice,
        actualOrder: entryOrder,
        adaptiveOrder: adaptiveShadowOrder,
      })
    : null;
  const limitRequested = entryOrder.orderType === "LIMIT";
  const referencePrice = entryOrder.price ?? executableMarketPrice;
  Object.assign(originalEvidence, {
    analyzedEntryOrder: {
      ...entryOrder.analysis,
      configuredMode: input.config.execution.orderType,
      entryDistanceExecutionMode: entryDistanceMode,
      probabilityExecutionOverride:
        probabilityEntryExecution.probabilityApproved,
    },
    entryExecutionShadow,
    probabilityEntryExecution,
    ...buildAutomatedEntryDirectionEvidence(executionDirection),
    entryOrderAttempt,
    pendingEntryOwner: "SHORT_ENTRY_WORKER",
  });
  input.trace.entryEvidenceJson = JSON.stringify(originalEvidence);
  await db
    .update(strategyExecutionTraces)
    .set({
      entryEvidenceJson: input.trace.entryEvidenceJson,
      updatedAt: new Date(),
    })
    .where(eq(strategyExecutionTraces.id, input.trace.id));
  const configuredTargetNotional =
    input.branchRole === "CONTRARIAN_PROBE"
      ? input.config.risk.positionManagement!.contrarianProbeNotionalUsdt
      : input.config.execution.targetOrderNotionalUsdt;
  const accountDailyNotional = dailyOrders.reduce(
    (sum, order) => sum + order.estimatedNotional,
    0,
  );
  const candidateTraceIds = [
    ...new Set(
      dailyOrders
        .map((order) =>
          strategyTraceIdFromClientOrderId(order.clientOrderId),
        )
        .filter((traceId): traceId is number => traceId !== null),
    ),
  ];
  const ownedTraceIds = candidateTraceIds.length
    ? await db
        .select({ id: strategyExecutionTraces.id })
        .from(strategyExecutionTraces)
        .where(
          and(
            eq(strategyExecutionTraces.strategyId, input.strategy.id),
            inArray(strategyExecutionTraces.id, candidateTraceIds),
          ),
        )
        .then((rows) => rows.map((row) => row.id))
    : [];
  const strategyDailyMargin = attributedOrderInitialMargin(
    dailyOrders,
    ownedTraceIds,
    input.config.execution.leverage,
  );
  const accountCommittedMargin = openPositions.reduce(
    (sum, position) =>
      sum +
      (position.quantity * position.markPrice) /
        Math.max(position.leverage, 1),
    0,
  ) +
    pendingOrders.reduce(
      (sum, order) =>
        sum +
        pendingOrderReservedMargin(
          order,
          input.config.execution.leverage,
        ),
      0,
    );
  const strategyPositionIds = openPositionTraces
    .filter((row) => row.strategyId === input.strategy.id)
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
  const dailyMarginActivity = calculateAutomatedDailyMarginQuota({
    usedMarginUsdt: strategyDailyMargin,
    limitMarginUsdt: input.config.execution.maxDailyNotionalUsdt,
    unrealizedPnlUsdt: strategyUnrealizedPnlUsdt,
  });
  // Private account funding is synchronized by the independent account audit.
  // Do not retain the short-brain execution lock while that slow path runs.
  const fundingSnapshot = accountFundingSnapshot(credential);
  const cachedBinanceAvailableBalance = Math.max(
    fundingSnapshot.availableToOpenUsdt ?? 0,
    0,
  );
  const executionReservationCapacity = cachedBinanceAvailableBalance;
  let approvedQuantity = 0;
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
        ownerEmail: input.strategy.ownerEmail,
        accountId: input.strategy.accountId,
        currentEquityUsdt,
      }),
      readNexusReservedRiskExposures({
        ownerEmail: input.strategy.ownerEmail,
        accountId: input.strategy.accountId,
        excludeTraceId: input.trace.traceId,
      }),
    ]);
    const portfolioRisk = calculateNexusPortfolioRiskPlan({
      config: input.config.risk.portfolioRisk,
      strategyId: input.strategy.id,
      accountEquityUsdt: equityState.currentEquityUsdt,
      peakAccountEquityUsdt: equityState.peakAccountEquityUsdt,
      symbol: input.trace.symbol,
      positionSide: executionDirection.positionSide,
      entryPrice: referencePrice,
      invalidationPrice: executionDirection.inverted
        ? roeStopInvalidationPrice({
            entryPrice: referencePrice,
            positionSide: executionDirection.positionSide,
            stopLossRoePercent: input.config.risk.stopLossPercent,
            leverage: input.config.execution.leverage,
          })
        : input.structure.brokenSupport,
      fallbackStopRoePercent: input.config.risk.stopLossPercent,
      leverage: input.config.execution.leverage,
      roundTripCostRate: 0.001,
      minOrderQty: symbol.minOrderQty,
      quantityStep: symbol.quantityStep,
      minNotionalUsdt: symbol.minNotionalUsdt,
      currentExposures,
      reservedExposures,
      minimumOrderFloorMode:
        input.config.execution.minimumOrderFloorMode,
      riskClass: input.explorationProbe
        ? "LEARNING_PROBE"
        : "STANDARD",
    });
    const quantitySizingDecision = resolveEvidenceQuantityMultiplier({
      mode: input.config.execution.quantitySizingMode,
      fixedMultiplier:
        input.config.execution.minimumOrderQuantityMultiplier,
      eyeVerdict: record(originalEvidence.nexusMarketEyeDecision).verdict,
      volumeTimingState: record(originalEvidence.nexusVolumeTiming).state,
      executionTimingEligible: shortEntryRevalidation.eligible,
      strongSizingAllowed:
        !input.explorationProbe &&
        !forceExchangeMinimumQuantity,
    });
    originalEvidence.nexusQuantitySizingDecision = quantitySizingDecision;
    const configuredSizing = capRiskSizedEntryToConfiguredMargin({
      riskSizedQuantity:
        portfolioRisk.status === "SIZED" ? portfolioRisk.quantity : 0,
      entryPrice: referencePrice,
      leverage: input.config.execution.leverage,
      minOrderQty: symbol.minOrderQty,
      quantityStep: symbol.quantityStep,
      minNotionalUsdt: symbol.minNotionalUsdt,
      targetMarginUsdt: input.config.execution.targetOrderNotionalUsdt,
      maxOrderMarginUsdt: input.config.execution.maxOrderNotionalUsdt,
      sizingCapitalUsdt,
      equityAllocationPercent:
        input.config.execution.equityAllocationPercent ?? 5,
      minimumPositionNotionalUsdt:
        input.config.execution.minimumPositionNotionalUsdt ?? 15,
      explorationProbe: input.explorationProbe,
      forceExchangeMinimumQuantity,
      marketOrder: entryOrder.orderType === "MARKET",
      minimumOrderQuantityMultiplier:
        quantitySizingDecision.multiplier,
    });
    if (!configuredSizing)
      return reject(
        "NEXUS_CONFIGURED_MARGIN_UNEXECUTABLE",
        `按账户保证金权益 ${sizingCapitalUsdt.toFixed(2)} USDT、单笔分配 ${Number(input.config.execution.equityAllocationPercent ?? 5).toFixed(2)}% 和单笔保证金额度计算后，无法达到策略最低名义价值 ${Number(input.config.execution.minimumPositionNotionalUsdt ?? 15).toFixed(2)} USDT 与 Binance 规则的较高者`,
        {
          portfolioRisk,
          strategyDailyMargin,
          cumulativeMarginAdvisoryOnly: true,
          configuredDailyMarginReferenceUsdt:
            input.config.execution.maxDailyNotionalUsdt,
          strategyUnrealizedPnlUsdt,
          dailyMarginActivity,
          accountDailyNotional,
        },
      );
    const configuredSizingSummary =
      `账户权益 ${configuredSizing.equityAllocationPercent.toFixed(2)}% 定量：名义价值 ${configuredSizing.notionalUsdt.toFixed(2)} USDT，` +
      `${input.config.execution.leverage}倍杠杆预计保证金 ${configuredSizing.requiredMarginUsdt.toFixed(2)} USDT`;
    const orderCapacity = calculateAutomatedOrderCapacity({
      usedMarginUsdt: strategyDailyMargin,
      limitMarginUsdt: input.config.execution.maxDailyNotionalUsdt,
      unrealizedPnlUsdt: strategyUnrealizedPnlUsdt,
      requiredMarginUsdt: configuredSizing.requiredMarginUsdt,
      binanceAvailableMarginUsdt: cachedBinanceAvailableBalance,
    });
    if (!orderCapacity.exchangeExecutable)
      return defer(
        "NEXUS_BINANCE_AVAILABLE_MARGIN_WAIT",
        automatedOrderCapacityMessage(orderCapacity, "做空判断已经通过"),
        {
          orderCapacity,
          accountFundingStatus: fundingSnapshot.status,
          retryWithoutReanalysis: true,
        },
      );
    const capacity = calculateStrategyMarginCapacity({
      availableBalance: executionReservationCapacity,
      committedMargin,
      equityCommittedMargin: accountCommittedMargin,
      requiredMargin: configuredSizing.requiredMarginUsdt,
      maxUsagePercent: input.config.risk.maxMarginUsagePercent,
    });
    const marginCapacity = {
      ...capacity,
      binanceAvailableBalanceUsdt: cachedBinanceAvailableBalance,
      accountFundingStatus: fundingSnapshot.status,
      strategyDailyMarginUsedUsdt: strategyDailyMargin,
      configuredDailyMarginReferenceUsdt:
        dailyMarginActivity.configuredLimitMarginUsdt,
      strategyUnrealizedPnlUsdt,
      cumulativeMarginAdvisoryOnly: true,
      advisoryOnly: true,
      binanceFundingExecutionGate: true,
      explanation:
        `Binance 已保存可再开仓快照 ${cachedBinanceAvailableBalance.toFixed(2)} USDT（${fundingSnapshot.status}），作为提交前资金硬边界；` +
        `策略今日已开仓保证金 ${dailyMarginActivity.usedMarginUsdt.toFixed(2)} USDT（仅统计，不拒单、不缩量）。`,
    };
    const brainKey = input.strategy.brainKey;
    if (!brainKey)
      return reject(
        "NEXUS_BRAIN_IDENTITY_MISSING",
        "执行大脑缺少不可变 brainKey，已阻止创建实盘意图",
      );
    const executionIntentExpiresAt = resolveFrozenExecutionIntentExpiry({
      traceExpiresAt: input.trace.expiresAt,
      frozenDecision: originalEvidence.frozenExecutionDecision,
      analysisValiditySeconds:
        input.config.trigger.analysisValiditySeconds,
    });
    const coordinated = await (
      input.explorationProbe
        ? reserveNexusExplorationExecutionIntent
        : reserveNexusExecutionIntent
    )(
        {
          strategyId: input.strategy.id,
          brainKey,
          configVersion: input.trace.configVersion,
          traceId: `${input.trace.traceId}:attempt-${entryOrderAttempt}`,
          intentPurpose: "OPEN_POSITION",
          authoritySource: "ENTRY_BRAIN",
          ownerEmail: input.strategy.ownerEmail,
          accountId: input.strategy.accountId,
          symbol: input.trace.symbol,
          positionSide: executionDirection.positionSide,
          positionMode: credential.positionMode ?? "ONE_WAY",
          orderType: limitRequested ? "LIMIT" : "MARKET",
          quantity: configuredSizing.quantity,
          limitPrice: entryOrder.price,
          requiredMarginUsdt: configuredSizing.requiredMarginUsdt,
          riskBudgetUsdt:
            portfolioRisk.unitLossAtInvalidationUsdt *
            configuredSizing.quantity,
          riskClass: portfolioRisk.riskClass,
          priority: input.trace.liquidationNotional,
          observedAt: input.trace.receivedAt.getTime(),
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
          "SHORT_LIVE_AVAILABLE_MARGIN_WAIT",
          automatedOrderCapacityMessage(orderCapacity, "做空判断已经通过") +
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
    executionIntentKey = coordinated.decision.intentKey;
    Object.assign(originalEvidence, {
      nexusPortfolioRisk: portfolioRisk,
      nexusPortfolioRiskAdvisoryOnly: true,
      nexusConfiguredSizing: configuredSizing,
      nexusConfiguredSizingSummary: configuredSizingSummary,
      nexusMarginCapacity: marginCapacity,
      nexusExecutionCoordinator: coordinated?.snapshot ?? null,
    });
    input.trace.entryEvidenceJson = JSON.stringify(originalEvidence);
    await db
      .update(strategyExecutionTraces)
      .set({
        entryEvidenceJson: input.trace.entryEvidenceJson,
        updatedAt: new Date(),
      })
      .where(eq(strategyExecutionTraces.id, input.trace.id));
    await appendEvent(input.trace.traceId, input.strategy.id, {
      eventType:
        `NEXUS_EXECUTION_AUTHORIZED:${coordinated.decision.status}`,
      message:
        `${input.explorationProbe && explorationAdmission?.ordinal
          ? `第 ${explorationAdmission.ordinal}/${explorationAdmission.targetOrders} 个做空学习探针已取得唯一名额并按基础可用资金比例与最低名义门槛定量至`
          : "策略可用资金比例、最低名义门槛和保证金额度均已通过，委托数量为"} ${approvedQuantity}：` +
        `${portfolioRisk.reason}；` +
        `${configuredSizingSummary}；` +
        `中央协调器：${coordinated.decision.reason}`,
      detail: {
        portfolioRisk,
        configuredSizing,
        marginCapacity,
        coordinatorDecision: coordinated.decision,
        explorationAdmission,
        shadowOnly: true,
        orderAffecting: false,
      },
    });
  } catch (error) {
    return reject(
      "NEXUS_EXECUTION_GATE_ERROR",
      "策略保证金额度或中央执行协调器校验失败，禁止提交订单",
      { error: error instanceof Error ? error.message : "未知错误" },
    );
  }
  if (!executionIntentKey || approvedQuantity <= 0)
    return reject(
      "NEXUS_EXECUTION_OWNER_MISSING",
      "未取得中央执行权或批准数量无效",
    );
  const finalSignalAgeMs = Date.now() - input.trace.eventTime.getTime();
  const executionEvidence = parseJson(input.trace.entryEvidenceJson);
  const frozenDecision =
    executionEvidence.frozenExecutionDecision &&
      typeof executionEvidence.frozenExecutionDecision === "object" &&
      !Array.isArray(executionEvidence.frozenExecutionDecision)
      ? executionEvidence.frozenExecutionDecision as Record<string, unknown>
      : {};
  const frozenExecutionDeadline = isFrozenExecutionApproval(frozenDecision)
    ? resolveFrozenExecutionDeadline({
        frozenDecision,
        analysisValiditySeconds:
          input.config.trigger.analysisValiditySeconds,
      })
    : null;
  const executionExpiresAtMs = resolveFrozenExecutionIntentExpiry({
    traceExpiresAt: input.trace.expiresAt,
    frozenDecision,
    analysisValiditySeconds:
      input.config.trigger.analysisValiditySeconds,
  });
  if (
    !Number.isFinite(finalSignalAgeMs) ||
    finalSignalAgeMs < 0 ||
    !Number.isFinite(executionExpiresAtMs) ||
    Date.now() > executionExpiresAtMs
  )
    return reject(
      "SHORT_LIVE_SIGNAL_EXPIRED",
      frozenExecutionDeadline === null
        ? "做空信号在实盘委托前已超过分析有效期"
        : "已获批做空订单超过独立执行窗口仍未完成，本次禁止继续使用旧判断",
      {
        finalSignalAgeMs,
        executionExpiresAtMs,
        frozenExecutionWindow: frozenExecutionDeadline !== null,
      },
    );
  const finalExecutableReferencePrice = referencePrice;
  const riskPlan = buildPilotRiskPlan(
    input.config,
    approvedQuantity,
    symbol.minOrderQty,
    symbol.quantityStep,
    {
      referencePrice: finalExecutableReferencePrice,
      minNotionalUsdt: symbol.minNotionalUsdt,
    },
  );
  const highPositionConfig =
    input.config.marketProfile?.mode === "HIGH_POSITION_SHORT"
      ? input.config.highPositionShort
      : null;
  const highPositionPayoff = highPositionConfig
    ? executableRiskPlanPayoffProfile({
        totalQuantity: approvedQuantity,
        takeProfits: riskPlan.takeProfits,
        stopLossRoePercent: input.config.risk.stopLossPercent,
        leverage: input.config.execution.leverage,
        estimatedRoundTripFeePercent:
          highPositionConfig.estimatedRoundTripCostPercent +
          adverseFundingCostRate({
            direction: executionDirection.tradeDirection,
            fundingRate: Number(
              record(directionEvidence.nexusFundingContext).fundingRate,
            ),
          }) * 100,
      })
    : null;
  if (
    highPositionConfig &&
    (!hasCompleteNetProfitPath(highPositionPayoff) ||
      Number(highPositionPayoff?.netRiskRewardRatio) <
        highPositionConfig.minimumRewardRiskRatio)
  )
    return reject(
      "HIGH_POSITION_SHORT_PAYOFF_REJECTED",
      "高位转弱做空的实际可执行止盈网格扣除配置成本后，未达到最低盈亏比",
      {
        payoff: highPositionPayoff,
        minimumRewardRiskRatio:
          highPositionConfig.minimumRewardRiskRatio,
        estimatedRoundTripCostPercent:
          highPositionConfig.estimatedRoundTripCostPercent,
      },
    );
  if (highPositionPayoff)
    directionEvidence.highPositionPayoff = highPositionPayoff;
  const strategyRiskPlan = {
    ...riskPlan,
    orderOrigin: "STRATEGY" as const,
    riskClass: input.explorationProbe
      ? "LEARNING_PROBE" as const
      : "STANDARD" as const,
    strategyId: input.strategy.id,
    strategyConfigVersion: input.trace.configVersion,
    traceId: input.trace.traceId,
    structureInvalidationPrice: executionDirection.inverted
      ? roeStopInvalidationPrice({
          entryPrice: finalExecutableReferencePrice,
          positionSide: executionDirection.positionSide,
          stopLossRoePercent: input.config.risk.stopLossPercent,
          leverage: input.config.execution.leverage,
        })
      : input.structure.brokenSupport,
  };
  const effectiveTrailingActivationPercent =
    input.branchRole === "CONTRARIAN_PROBE"
      ? Math.min(
          input.config.risk.trailingActivationPercent,
          input.config.risk.positionManagement!
            .contrarianProfitRoeBeforeHedge,
        )
      : input.config.risk.trailingActivationPercent;
  const clientOrderId = buildAutomatedEntryClientOrderId({
    standardPrefix: "nqs",
    inverted: executionDirection.inverted,
    traceRowId: input.trace.id,
    traceId: input.trace.traceId,
    attempt: entryOrderAttempt,
  });
  const now = new Date();
  const entryDecisionHandoffJson = JSON.stringify(buildEntryDecisionHandoff({
    traceId: input.trace.traceId,
    strategyId: input.strategy.id,
    configVersion: input.trace.configVersion,
    positionSide: executionDirection.positionSide,
    decisionAt: now,
    executionIntentId: executionIntentKey,
    resultCode: input.trace.resultCode,
    resultMessage: input.trace.resultMessage,
    entryEvidence: originalEvidence,
  }));
  const inverseExecutionObservation = buildInverseExecutionObservation({
    direction: executionDirection,
    frozenDecision: directionEvidence.frozenExecutionDecision,
    executionStartedAt: executionAttemptStartedAt,
    orderCreatedAt: now,
    approvalPrice:
      directionEvidence.executionApprovedMarkPrice ?? input.markPrice,
    executionPrice: finalExecutableReferencePrice,
  });
  if (inverseExecutionObservation) {
    directionEvidence.inverseExecutionObservation =
      inverseExecutionObservation;
    input.trace.entryEvidenceJson = JSON.stringify(directionEvidence);
  }
  const { order: event } = await createAutomatedEntryOrder({
    ownerEmail: input.strategy.ownerEmail,
    accountId: input.strategy.accountId,
    credentialId: credential.id,
    clientOrderId,
    symbol: input.trace.symbol,
    side: executionDirection.side,
    positionSide: executionDirection.positionSide,
    orderType: limitRequested ? "LIMIT" : "MARKET",
    quantity: approvedQuantity,
    referencePrice: finalExecutableReferencePrice,
    responseJson: JSON.stringify({
      requestedLeverage: input.config.execution.leverage,
      inverseExecutionObservation,
    }),
    lifecycleId: input.trace.traceId,
    entryDecisionHandoffJson,
    createdAt: now,
  });
  if (inverseExecutionObservation)
    await db
      .update(strategyExecutionTraces)
      .set({
        entryEvidenceJson: JSON.stringify(directionEvidence),
        updatedAt: now,
      })
      .where(eq(strategyExecutionTraces.id, input.trace.id));
  const shadowEntryEvidence = parseJson(input.trace.entryEvidenceJson);
  const shadowVolumeTiming = shadowEntryEvidence.nexusVolumeTiming &&
      typeof shadowEntryEvidence.nexusVolumeTiming === "object"
    ? shadowEntryEvidence.nexusVolumeTiming as Record<string, unknown>
    : {};
  await observeExecutionQuote({
    recordKey: `ENTRY:${event.id}`,
    quoteRole: "ENTRY",
    liveOrderEventId: event.id,
    clientOrderId,
    ownerEmail: input.strategy.ownerEmail,
    accountId: input.strategy.accountId,
    strategyId: input.strategy.id,
    traceId: input.trace.traceId,
    origin: "STRATEGY_SHORT",
    symbol: input.trace.symbol,
    side: executionDirection.side,
    positionSide: executionDirection.positionSide,
    actualOrderType: limitRequested ? "LIMIT" : "MARKET",
    actualRequestedPrice: entryOrder.price ?? finalExecutableReferencePrice,
    decisionMarkPrice: executableMarketPrice,
    executableReferencePrice: finalExecutableReferencePrice,
    priceTickSize: symbol.priceTickSize,
    atr5m: input.structure.atr,
    tradeIntensityRatio:
      Number(shadowVolumeTiming.currentExecutionVolumeRatio) || 1,
    bestBidQuantity: entryBookDepth?.bidQuantity ?? null,
    bestAskQuantity: entryBookDepth?.askQuantity ?? null,
    orderHorizonSeconds: input.config.execution.orderTtlSeconds,
    prospectiveNotionalUsdt: approvedQuantity * finalExecutableReferencePrice,
    entryExecutionShadow,
  });
  let acknowledgedOrder: {
    exchangeOrderId: string | null;
    executedQuantity: number;
    response: Record<string, unknown>;
  } | null = null;
  const effectiveEntryOrderTtlMs = effectiveStrategyEntryOrderTtlMs({
    config: input.config,
    exchangeOrderType: limitRequested ? "LIMIT" : "MARKET",
  });
  try {
    await advanceNexusExecutionIntent({
      intentKey: executionIntentKey,
      nextStatus: "SUBMITTING",
      expiresAtMs: nexusExecutionIntentSettlementDeadline({
        orderCreatedAtMs: now.getTime(),
        orderTtlSeconds: input.config.execution.orderTtlSeconds,
        orderTtlMs: effectiveEntryOrderTtlMs,
        analysisExpiresAtMs: executionExpiresAtMs,
      }),
      detail: {
        clientOrderId,
        liveOrderEventId: event.id,
        inverseExecutionObservation,
      },
    });
    const result = await submitLiveEntryOrder(keys, {
      symbol: input.trace.symbol,
      side: executionDirection.side,
      positionSide: executionDirection.positionSide,
      quantity: approvedQuantity,
      clientOrderId,
      leverage: input.config.execution.leverage,
      positionMode: credential.positionMode,
      orderType: limitRequested ? "LIMIT" : "MARKET",
      price: entryOrder.price ?? undefined,
      timeInForce: limitRequested ? "GTC" : undefined,
      requireExactLeverage: true,
    });
    const acknowledgement = readAutomatedEntryAcknowledgement({
      response: result.data,
      orderType: limitRequested ? "LIMIT" : "MARKET",
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
      const expiresAt = new Date(effectiveNexusOrderDeadline({
        orderCreatedAtMs: now.getTime(),
        orderTtlSeconds: input.config.execution.orderTtlSeconds,
        orderTtlMs: effectiveEntryOrderTtlMs,
        analysisExpiresAtMs: executionExpiresAtMs,
      }));
      const pendingResponseJson = JSON.stringify({
        ...result.data,
        timeInForce: "GTC",
        strategyOrderQuantity: approvedQuantity,
        confirmedLeverage: result.timing.confirmedLeverage,
        requestedLeverage: result.timing.requestedLeverage,
        strategyPendingEntry: {
          orderOrigin: "STRATEGY",
          leverage: result.timing.confirmedLeverage,
          riskPlan: strategyRiskPlan,
          trailingActivationPercent: effectiveTrailingActivationPercent,
          trailingStopPercent:
            (input.config.risk.dynamicTrailingEnabled ?? true)
              ? input.config.risk.trailingDrawdownPercent
              : 0,
        },
        effectiveOrderTtlMs: effectiveEntryOrderTtlMs,
        expiresAt: expiresAt.toISOString(),
      });
      await synchronizeReservedNexusOrder({
        intentKey: executionIntentKey,
        liveOrderEventId: event.id,
        nextStatus: "SUBMITTED",
        liveOrderStatus: "PENDING",
        exchangeOrderId: result.data.orderId
          ? String(result.data.orderId)
          : null,
        responseJson: pendingResponseJson,
        detail: {
          liveOrderEventId: event.id,
          clientOrderId,
          exchangeOrderId: result.data.orderId,
          executedQuantity: 0,
        },
        reasonCode: "ACKNOWLEDGED_LIMIT_PENDING",
        reasonMessage: "交易所已接受做空限价单，等待正常订单核对",
        traceSettlement: {
          databaseId: input.trace.id,
          expectedStates: ["ORDER_READY", "ORDER_PENDING"],
          state: "ORDER_PENDING",
          resultCode: "ANALYZED_LIMIT_PENDING",
          resultMessage: "做空偏移限价已挂出，等待成交或到期撤单",
          entryEvidenceJson: JSON.stringify(shadowEntryEvidence),
          exchangeOrderId: result.data.orderId
            ? String(result.data.orderId)
            : null,
          completedAt: null,
        },
      });
      await appendEvent(input.trace.traceId, input.strategy.id, {
        eventType: "ANALYZED_LIMIT_PENDING",
        message: "做空偏移限价已进入订单簿；成交、部分成交或到期时由系统接管",
        detail: {
          positionSide: executionDirection.positionSide,
          clientOrderId,
          limitPrice: entryOrder.price,
          orderTtlSeconds: input.config.execution.orderTtlSeconds,
          effectiveOrderTtlMs: effectiveEntryOrderTtlMs,
          expiresAt: expiresAt.toISOString(),
          inverseExecutionObservation,
        },
      });
      return true;
    }
    if (!acknowledgement.hasExecutedQuantity)
      throw new BinanceLiveError(
        "Binance 返回的做空委托未包含有效成交数量",
        502,
        undefined,
        true,
      );
    const entryPrice = acknowledgement.effectiveEntryPrice;
    const positionLifecycleLink = resolveFilledPositionLifecycleLink({
      traceId: input.trace.traceId,
      orderLifecycleId: event.lifecycleId,
      orderEntryDecisionHandoffJson: event.entryDecisionHandoffJson,
    });
    const positionProtection = buildFilledPositionProtection({
      plan: strategyRiskPlan,
      activatedAt: now,
      trailingActivationPercent: effectiveTrailingActivationPercent,
      trailingStopPercent:
        (input.config.risk.dynamicTrailingEnabled ?? true)
          ? input.config.risk.trailingDrawdownPercent
          : 0,
    });
    const positionValues = buildFilledPositionInsertValues({
      ownerEmail: input.strategy.ownerEmail,
      accountId: input.strategy.accountId,
      credentialId: credential.id,
      sourceEventId: event.id,
      handoffOrigin: "STRATEGY",
      lifecycleId: positionLifecycleLink.lifecycleId,
      entryDecisionHandoffJson:
        positionLifecycleLink.entryDecisionHandoffJson,
      symbol: input.trace.symbol,
      instrumentId: symbol.instrumentId,
      instrumentRuleVersion: symbol.ruleVersion,
      positionSide: executionDirection.positionSide,
      quantity: executedQuantity,
      entryPrice,
      leverage: result.timing.confirmedLeverage,
      protection: positionProtection,
      openedAt: now,
      updatedAt: now,
    });
    const { position } = await persistFilledAutomatedPosition({
      insertValues: positionValues,
      recoveryValues: buildFilledPositionRecoveryValues({
        lifecycleId: positionLifecycleLink.lifecycleId,
        entryDecisionHandoffJson:
          positionLifecycleLink.entryDecisionHandoffJson,
        positionHandoffKey: positionValues.positionHandoffKey,
        positionHandoffVersion: positionValues.positionHandoffVersion,
        positionHandoffJson: positionValues.positionHandoffJson,
        leverage: result.timing.confirmedLeverage,
        protection: positionProtection,
        updatedAt: now,
      }),
    });
    const exchangeOrderId = result.data.orderId
      ? String(result.data.orderId)
      : null;
    const traceResultCode = input.branchRole === "CONTRARIAN_PROBE"
      ? "CONTRARIAN_PROBE_POSITION_OPEN"
      : executionDirection.inverted
        ? "INVERSE_STRATEGY_POSITION_OPEN"
        : "SHORT_LIVE_SUBMITTED";
    const traceResultMessage = input.branchRole === "CONTRARIAN_PROBE"
      ? "反向做空探针通过完整做空确认并成交；盈利后保护利润，不自动建立相反仓位"
      : executionDirection.inverted
        ? "大脑做空条件通过，反人性策略已反向开多并进入原有内部风控"
        : "做空方向与全部参数条件通过，实盘订单已成交";
    await settleNexusExecutionIntentWithLiveOrder({
      intentKey: executionIntentKey,
      liveOrderEventId: event.id,
      nextStatus: "FILLED",
      exchangeOrderId,
      responseJson: JSON.stringify(acknowledgement.response),
      livePositionId: position.id,
      filledQuantity: executedQuantity,
      detail: buildFilledExecutionIntentDetail({
        clientOrderId,
        exchangeOrderId: result.data.orderId,
        executedQuantity,
        positionId: position.id,
      }),
      traceSettlement: {
        databaseId: input.trace.id,
        state: "POSITION_OPEN",
        resultCode: traceResultCode,
        resultMessage: traceResultMessage,
        entryEvidenceJson: JSON.stringify(shadowEntryEvidence),
        exchangeOrderId,
        positionId: String(position.id),
        completedAt: null,
      },
    });
    await appendEvent(input.trace.traceId, input.strategy.id, {
      eventType: input.branchRole === "CONTRARIAN_PROBE"
        ? "CONTRARIAN_PROBE_POSITION_OPEN"
        : executionDirection.inverted
          ? "INVERSE_STRATEGY_POSITION_OPEN"
          : "SHORT_LIVE_SUBMITTED",
      message: input.branchRole === "CONTRARIAN_PROBE"
        ? `${input.trace.symbol} 反向做空探针已通过破位、反抽失败和成交量确认，成交后进入独立利润保护`
        : executionDirection.inverted
          ? `${input.trace.symbol} 大脑判断做空，反人性策略已反向开多并交由原有动态仓位管理`
          : `${input.trace.symbol} 做空实盘订单已成交并交由动态仓位管理`,
      detail: {
        strategyBranchRole: input.branchRole,
        positionSide: executionDirection.positionSide,
        brainDecisionDirection: executionDirection.brainDirection,
        inverseExecution: executionDirection.inverted,
        inverseExecutionObservation,
        quantity: executedQuantity,
        entryPrice,
        leverage: result.timing.confirmedLeverage,
        requestedLeverage: result.timing.requestedLeverage,
        leverageAdjusted: result.timing.leverageAdjusted,
        targetNotionalUsdt: configuredTargetNotional,
        effectiveTrailingActivationRoePercent:
          effectiveTrailingActivationPercent,
        automaticOppositeHedgeAllowed: false,
        averagingDownAllowed: false,
        riskPlan,
        decision: input.decision,
        analyzedEntryOrder: {
          ...entryOrder.analysis,
          configuredMode: input.config.execution.orderType,
          entryDistanceExecutionMode: entryDistanceMode,
          probabilityExecutionOverride:
            probabilityEntryExecution.probabilityApproved,
        },
        entryExecutionShadow,
        probabilityEntryExecution,
      },
    });
    await writeAudit(
      {
        email: input.strategy.ownerEmail,
        accountId: input.strategy.accountId,
      },
      executionDirection.inverted
        ? "INVERSE_STRATEGY_LIVE_ORDER"
        : "LIQUIDATION_SHORT_LIVE_ORDER",
      "live_position",
      String(position.id),
      {
        strategyBranchRole: input.branchRole,
        brainDecisionDirection: executionDirection.brainDirection,
        positionSide: executionDirection.positionSide,
        inverseExecution: executionDirection.inverted,
        traceId: input.trace.traceId,
        symbol: input.trace.symbol,
        quantity: executedQuantity,
        entryPrice,
        leverage: result.timing.confirmedLeverage,
        requestedLeverage: result.timing.requestedLeverage,
        leverageAdjusted: result.timing.leverageAdjusted,
      },
    );
    return true;
  } catch (error) {
    if (acknowledgedOrder) {
      const recovery = await recoverAcknowledgedAutomatedEntry({
        intentKey: executionIntentKey,
        liveOrderEventId: event.id,
        clientOrderId,
        exchangeOrderId: acknowledgedOrder.exchangeOrderId,
        executedQuantity: acknowledgedOrder.executedQuantity,
        response: acknowledgedOrder.response,
        orderType: event.orderType,
        traceDatabaseId: input.trace.id,
      });
      try {
        await appendEvent(input.trace.traceId, input.strategy.id, {
          eventType: recovery.resultCode,
          message: recovery.resultMessage,
          detail: {
            liveOrderEventId: event.id,
            exchangeOrderId: acknowledgedOrder.exchangeOrderId,
            executedQuantity: acknowledgedOrder.executedQuantity,
            positionId: recovery.position?.id ?? null,
          },
        });
      } catch {
        // Recovery logging is best effort.
      }
      return Boolean(recovery.position) || recovery.pendingLimit;
    }
    const unknown =
      error instanceof BinanceLiveError && error.executionUnknown;
    const message =
      error instanceof Error ? error.message : "做空实盘订单提交失败";
    if (unknown) {
      await recordUncertainAutomatedEntry({
        intentKey: executionIntentKey,
        liveOrderEventId: event.id,
        clientOrderId,
        traceDatabaseId: input.trace.id,
        resultCode: "SHORT_LIVE_EXECUTION_UNKNOWN",
        resultMessage: message,
      });
      try {
        await appendEvent(input.trace.traceId, input.strategy.id, {
          eventType: "SHORT_LIVE_EXECUTION_UNKNOWN",
          stage: "ORDER",
          outcome: "ERROR",
          message,
          detail: {
            clientOrderId,
            noAutomaticRetry: true,
          },
        });
      } catch {
        // 未知执行审计为尽力写入，不改变核对状态。
      }
      return false;
    }

    const rejectedAt = new Date();
    await settleRejectedAutomatedEntry({
      intentKey: executionIntentKey,
      liveOrderEventId: event.id,
      clientOrderId,
      errorMessage: message,
      traceDatabaseId: input.trace.id,
      traceResultCode: "SHORT_LIVE_ORDER_REJECTED",
      rejectedAt,
    });
    try {
      await appendEvent(input.trace.traceId, input.strategy.id, {
        eventType: "SHORT_LIVE_ORDER_REJECTED",
        stage: "ORDER",
        outcome: "ERROR",
        message,
        detail: {
          clientOrderId,
          noAutomaticRetry: true,
        },
      });
    } catch {
      // 明确拒单已经原子收口，审计写入失败不能复活订单。
    }
    return false;
  }
}

function usesMarketStructureTriggerRuntime(kind: unknown) {
  return typeof kind === "string" && [
    "GRID_PRICE_LEVEL",
    "SCHEDULED_SCAN",
    "BREAKOUT_RETEST",
  ].includes(kind);
}

function liquidationConfigForShort(
  value: Record<string, unknown>,
): LiquidationTrendConfig | null {
  return resolveLiquidationTrendConfig(value, {
    allowHistoricalLeverage: true,
  }).config;
}

async function highPositionPriceVolumeWakeCandidates(input: {
  rows: Array<{
    symbol: string;
    contractType: string;
    minOrderQty: number | null;
    quantityStep: number | null;
    minNotionalUsdt: number | null;
    quoteVolume24h: number | null;
    lastPrice: number | null;
    priceChangePercent: number | null;
    highPrice: number | null;
    lowPrice: number | null;
    marketSyncedAt: Date | null;
  }>;
  config: LiquidationTrendConfig;
  now: number;
  triggerSource?:
    | "TRADFI_PRICE_VOLUME_STRUCTURE"
    | "HIGH_POSITION_PRICE_VOLUME_STRUCTURE";
}): Promise<ShortTriggerCandidate[]> {
  const scanCount = Math.min(
    input.rows.length,
    Math.max(
      1,
      Math.trunc(
        input.config.marketProfile?.maxWakeCandidatesPerCycle ?? 2,
      ),
    ),
  );
  const liquidity = partitionMarketLiquidity(
    input.rows,
    (row) => row.quoteVolume24h,
  );
  if (tradfiFallbackDue && liquidity.fallback.length) {
    tradfiFallbackDue = false;
    return evaluateLane("FALLBACK", liquidity.fallback);
  }
  if (!liquidity.primary.length)
    return evaluateLane("FALLBACK", liquidity.fallback);
  const primary = await evaluateLane("PRIMARY", liquidity.primary);
  if (primary.length) {
    tradfiPrimaryNoOpportunityCycles = 0;
    tradfiFallbackDue = false;
    return primary;
  }
  tradfiPrimaryNoOpportunityCycles += 1;
  const cyclesForPrimarySweep = Math.max(
    1,
    Math.ceil(liquidity.primary.length / Math.max(scanCount, 1)),
  );
  if (
    liquidity.fallback.length &&
    tradfiPrimaryNoOpportunityCycles >= cyclesForPrimarySweep
  ) {
    tradfiPrimaryNoOpportunityCycles = 0;
    tradfiFallbackDue = true;
  }
  // The fallback lane is intentionally scheduled for the next poll. This
  // preserves maxWakeCandidatesPerCycle and the observation REST budget.
  return [];

  async function evaluateLane(
    marketLiquidityLane: "PRIMARY" | "FALLBACK",
    rows: typeof input.rows,
  ): Promise<ShortTriggerCandidate[]> {
    if (!rows.length) return [];
    const fallback = marketLiquidityLane === "FALLBACK";
    const timingSelection = selectTradfiEntryTimingCandidates({
      rows,
      maxCandidates: Math.min(scanCount, rows.length),
      priorityCursor: fallback
        ? tradfiFallbackPriorityScanCursor
        : tradfiPriorityScanCursor,
      discoveryCursor: fallback
        ? tradfiFallbackDiscoveryScanCursor
        : tradfiDiscoveryScanCursor,
      marketLiquidityLane,
    });
    if (fallback) {
      tradfiFallbackPriorityScanCursor = timingSelection.nextPriorityCursor;
      tradfiFallbackDiscoveryScanCursor = timingSelection.nextDiscoveryCursor;
    } else {
      tradfiPriorityScanCursor = timingSelection.nextPriorityCursor;
      tradfiDiscoveryScanCursor = timingSelection.nextDiscoveryCursor;
    }
    const evaluated = await mapWithConcurrency(
      timingSelection.rows,
      NEXUS_MARKET_ANALYSIS_CONCURRENCY,
      async (row) => {
      try {
        const highPositionMode =
          input.config.marketProfile?.mode === "HIGH_POSITION_SHORT";
        const [hourly, fiveMinute, daily, threeMinute, liveContract] =
          await Promise.all([
          nexusUnifiedMarketData.closedCandles({
            symbol: row.symbol,
            interval: "1h",
            source: "TRADE",
            limit: 73,
          }),
          nexusUnifiedMarketData.closedCandles({
            symbol: row.symbol,
            interval: "5m",
            source: "TRADE",
            limit: 22,
          }),
          highPositionMode
            ? nexusUnifiedMarketData.closedCandles({
                symbol: row.symbol,
                interval: "1d",
                source: "TRADE",
                limit: 61,
              })
            : Promise.resolve(null),
          highPositionMode
            ? nexusUnifiedMarketData.closedCandles({
                symbol: row.symbol,
                interval: "3m",
                source: "TRADE",
                limit: 21,
              })
            : Promise.resolve(null),
          highPositionMode
            ? getBinanceLiveContractRule(row.symbol)
            : Promise.resolve(null),
        ]);
        if (highPositionMode) {
          const receivedAt = Date.parse(liveContract?.updatedAt ?? "");
          const capturedAt = Date.now();
          const marketContext = buildNexusMarketContextSnapshot({
            symbol: row.symbol,
            capturedAt,
            ticker24h: liveContract?.contract && Number.isFinite(receivedAt)
              ? {
                  lastPrice: liveContract.contract.price,
                  highPrice: liveContract.contract.high,
                  lowPrice: liveContract.contract.low,
                  quoteVolume: liveContract.contract.quoteVolume,
                  priceChangePercent: liveContract.contract.change,
                  eventAt: receivedAt,
                  receivedAt,
                }
              : null,
            candles1h: hourly.rows,
            candles1d: daily?.rows ?? [],
          });
          return {
            wake: evaluateHighPositionShortWake({
              now: capturedAt,
              context: marketContext,
              candles3m: threeMinute?.rows ?? [],
              candles5m: fiveMinute.rows,
              config: input.config.highPositionShort!,
            }),
            marketContext,
          };
        }
        return {
          wake: evaluateTradfiHighPositionWake({
            symbol: row.symbol,
            candles1h: hourly.rows,
            candles5m: fiveMinute.rows,
            highPosition72hPercent:
              input.config.marketProfile?.highPosition72hPercent,
            minimumRelativeVolume5m:
              input.config.marketProfile?.minimumRelativeVolume5m,
          }),
          marketContext: null,
        };
      } catch {
        // A single thin or temporarily unavailable TradFi contract must not
        // fail the whole monitor. The next rotating scan will retry it.
        return null;
      }
      },
    );
    return evaluated
    .filter(
      (item): item is NonNullable<typeof item> =>
        item !== null && Boolean(
          item.wake.wake &&
            item.wake.eventAt &&
            item.wake.referencePrice &&
            item.wake.position72hPercent !== null &&
            item.wake.relativeVolume5m !== null,
        ),
    )
    .map((item): ShortTriggerCandidate => {
      const wake = item.wake;
      const eventAt = wake.eventAt!;
      const referencePrice = wake.referencePrice!;
      const source = input.triggerSource ?? "TRADFI_PRICE_VOLUME_STRUCTURE";
      const id = `${source === "HIGH_POSITION_PRICE_VOLUME_STRUCTURE" ? "high-position-pv" : "tradfi-pv"}:${wake.symbol}:${eventAt}`;
      return {
        sequence: Math.trunc(eventAt),
        id,
        symbol: wake.symbol,
        side: "SELL",
        averagePrice: referencePrice,
        filledQuantity: 0,
        notional: 0,
        eventCount: 1,
        bucketStart: eventAt - 5 * 60_000 + 1,
        bucketEnd: eventAt,
        firstTradeTime: eventAt,
        lastTradeTime: eventAt,
        firstReceivedAt: input.now,
        lastReceivedAt: input.now,
        triggerScope: "SINGLE_SYMBOL",
        marketClusterId: id,
        marketClusterNotional: 0,
        marketClusterEventCount: 0,
        marketClusterSymbolCount: 1,
        marketClusterSpanMs: 0,
        marketClusterMaxGapMs: 0,
        configuredMaxInterEventGapMs: 0,
        marketTriggerMode: "ACCUMULATED_CONTINUOUS",
        symbolLiquidationNotional: 0,
        symbolEventCount: 0,
        symbolLiquidationSharePercent: 0,
        symbolContributionRank: 1,
        triggerSource: source,
        tradfiMarketWake: wake,
        ...(item.marketContext
          ? { marketContextSnapshot: item.marketContext }
          : {}),
        entryTimingSchedule:
          timingSelection.evidenceBySymbol[wake.symbol] ?? undefined,
      };
    })
    .sort(
      (left, right) =>
        (right.tradfiMarketWake?.position72hPercent ?? 0) -
          (left.tradfiMarketWake?.position72hPercent ?? 0) ||
        (right.tradfiMarketWake?.relativeVolume5m ?? 0) -
          (left.tradfiMarketWake?.relativeVolume5m ?? 0),
    );
  }
}

function shortTriggerCandidates(input: {
  rows: BinanceLiquidationAggregate[];
  config: LiquidationTrendConfig;
  now: number;
  sequenceCursorInitialized: boolean;
}): ShortTriggerCandidate[] {
  return buildBothLiquidationSideCandidates((side) =>
    buildLiquidationMarketTriggerCandidates(input.rows, {
    side,
    minNotionalUsdt: input.config.trigger.minLiquidationNotionalUsdt,
    minSingleEventNotionalUsdt:
      input.config.trigger.minSingleLiquidationNotionalUsdt ??
      input.config.trigger.minLiquidationNotionalUsdt,
    minEventCount: Math.min(input.config.trigger.minClusterEvents ?? 1, 2),
    maxSpanMs:
      (input.config.trigger.maxClusterSpanSeconds ?? 3) * 1_000,
    maxInterEventGapMs:
      (input.config.trigger.maxClusterEventGapSeconds ??
        input.config.trigger.maxClusterSpanSeconds ??
        3) * 1_000,
    minLiquidationPrice: input.config.trigger.minLiquidationPrice ?? 0,
    maxLiquidationPrice: input.config.trigger.maxLiquidationPrice ?? 0,
  })).filter((candidate) =>
    scheduledLiquidationSignalTiming({
      tradeTimeMs: candidate.lastTradeTime,
      receivedAtMs: candidate.lastReceivedAt,
      processedAtMs: input.now,
      maxSignalDelayMs: input.config.trigger.maxSignalDelayMs,
      sequenceCursorInitialized: input.sequenceCursorInitialized,
    }).fresh
  );
}

function shortConfigFromLiquidation(config: LiquidationTrendConfig) {
  return {
    ...normalizeShortContinuationStrategyConfig({
      selectedSymbols: config.selectedSymbols,
      minimumVolumeRatio3m: config.trend.volumeRatio3m,
      minimumLongLiquidationSharePercent:
        config.shortTrend?.minimumLongLiquidationSharePercent ?? 65,
      maximumChaseDistanceAtr: config.trend.maxEntryDistanceAtr,
      maximumMarketDataAgeMs: config.trigger.maxSignalDelayMs,
      leverage: config.execution.leverage,
      stopLossRoePercent: config.risk.stopLossPercent,
      takeProfits: config.risk.takeProfitSteps.map((level) => ({
        triggerRoePercent: level.profitPercent,
        closePercent: level.closePercent,
      })),
      trailingActivationRoePercent: config.risk.trailingActivationPercent,
      trailingGivebackRoePoints: config.risk.trailingDrawdownPercent,
    }),
  };
}

async function upsertShortMonitorStatus(input: {
  strategy: {
    id: number;
    configVersion: number;
    ownerEmail: string;
    accountId: string;
  };
  config: ReturnType<typeof normalizeShortContinuationStrategyConfig>;
  triggerKind: LiquidationTrendConfig["trigger"]["kind"];
  executionDirection: ReturnType<typeof resolveStrategyExecutionDirection>;
  market60m: ReturnType<typeof analyzeShortMarket60m>;
  globalContext: Awaited<ReturnType<typeof getCoinGlassWebLiquidationContext>>;
  liquidationMarketContext: ReturnType<
    typeof resolveShortLiquidationMarketContext
  >;
  longLiquidationSharePercent: number | null;
  candidate: {
    symbol: string;
    liquidationSide: "BUY" | "SELL";
    liquidationPrice: number;
    liquidationNotional: number;
    markPrice: number;
    structure: ReturnType<typeof analyzeShortBreakRetest>;
    executionVolumeRatio1m: number | null;
    decision: ReturnType<typeof evaluateShortDowntrendContinuation>;
    nexusBrainShadow: NexusBrainShadowSnapshot;
    nexusBrainShadowChanged: boolean;
    nexusPureStateMachine: NexusPureMachineSnapshot;
    nexusTrendBreakoutStateMachine: NexusPureMachineSnapshot;
    nexusMarketEyeDecision: NexusMarketEyeDecision;
    shadowOriginalDisagreement: boolean;
  } | null;
  recentCandidateCount: number;
  liveDirection: boolean;
}) {
  const db = getDb();
  const now = new Date();
  const traceId = `short-monitor-status:${input.strategy.id}`;
  const [previousStatus] = await db
    .select({
      entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
    })
    .from(strategyExecutionTraces)
    .where(eq(strategyExecutionTraces.traceId, traceId))
    .limit(1);
  const previousEvidence = previousStatus
    ? parseJson(previousStatus.entryEvidenceJson)
    : {};
  const previousPureState = nestedString(
    previousEvidence,
    "nexusPureStateMachine",
    "state",
  );
  const previousTrendState = nestedString(
    previousEvidence,
    "nexusTrendBreakoutStateMachine",
    "state",
  );
  const previousMarketEyeVerdict = nestedString(
    previousEvidence,
    "nexusMarketEyeDecision",
    "verdict",
  );
  const previousMarketEyeCode = nestedString(
    previousEvidence,
    "nexusMarketEyeDecision",
    "code",
  );
  const previousMarketEyeSummary = nestedString(
    previousEvidence,
    "nexusMarketEyeDecision",
    "summary",
  );
  const idleDiagnostic = shortMonitorIdleDiagnostic(input.triggerKind);
  const monitorStatus =
    input.candidate?.nexusMarketEyeDecision.verdict ?? idleDiagnostic.status;
  const resultMessage =
    input.candidate?.nexusMarketEyeDecision.summary ?? idleDiagnostic.message;
  const fallbackPrice =
    input.market60m.changePercent === null ? 0 : 1;
  const configuredTriggerKind = input.triggerKind;
  const configuredTriggerVersion = configuredTriggerKind ===
      "HIGH_POSITION_PRICE_VOLUME_STRUCTURE"
    ? "high-position-price-volume-structure-v1"
    : configuredTriggerKind === "PRICE_VOLUME_STRUCTURE"
      ? "price-volume-structure-v1"
      : configuredTriggerKind === "LIQUIDATION_OR_PRICE_MOMENTUM_WAKE"
        ? "liquidation-or-price-momentum-wake-v1"
        : "liquidation-window-trigger-v1";
  const values = {
    strategyId: input.strategy.id,
    strategyRunId: "short-monitor-status",
    configVersion: input.strategy.configVersion,
    ownerEmail: input.strategy.ownerEmail,
    accountId: input.strategy.accountId,
    symbol: input.candidate?.symbol ?? "BTCUSDT",
    triggerKind: configuredTriggerKind,
    triggerVersion: configuredTriggerVersion,
    triggerDirection: "SHORT" as const,
    triggerReferencePrice:
      input.candidate?.liquidationPrice ??
      input.candidate?.markPrice ??
      fallbackPrice,
    triggerFactSnapshotId: null,
    triggerSourceId: traceId,
    liquidationSide:
      input.candidate?.liquidationSide ?? ("SELL" as const),
    liquidationPrice:
      input.candidate?.liquidationPrice ??
      input.candidate?.markPrice ??
      fallbackPrice,
    liquidationNotional: input.candidate?.liquidationNotional ?? 0,
    eventTime: now,
    receivedAt: now,
    expiresAt: new Date(now.getTime() + 5 * 60_000),
    // This is a rolling diagnostic row, not an executable trade lifecycle.
    // Keeping it terminal prevents the long-entry engine from evaluating a
    // short-strategy config as an active liquidation trace.
    state: "CLOSED" as const,
    resultCode: "SHORT_MONITOR_STATUS",
    resultMessage,
    configSnapshotJson: JSON.stringify(input.config),
    entryEvidenceJson: JSON.stringify({
      symbol: input.candidate?.symbol ?? "BTCUSDT",
      triggerIdentity: {
        triggerKind: configuredTriggerKind,
        triggerVersion: configuredTriggerVersion,
        direction: "SHORT",
        factSnapshotId: null,
        sourceId: traceId,
        referencePrice:
          input.candidate?.liquidationPrice ??
          input.candidate?.markPrice ??
          fallbackPrice,
        canAuthorizeOrder: false,
      },
      strategyVersion: SHORT_DOWNTREND_STRATEGY_VERSION,
      strategyFamily: "LIQUIDATION_SHORT",
      brainDecisionDirection: input.executionDirection.brainDirection,
      tradeDirection: input.executionDirection.tradeDirection,
      executionDirection: input.executionDirection,
      observationOnly: false,
      liveOrderAuthorized: input.liveDirection && liveRuntime().enabled,
      monitorDiagnostic: true,
      monitorStatus,
      recentCandidateCount: input.recentCandidateCount,
      oneHourLongLiquidationSharePercent:
        input.longLiquidationSharePercent,
      liquidationMarketContext: input.liquidationMarketContext,
      market60m: input.market60m,
      globalLiquidationContext: input.globalContext,
      candidate: input.candidate,
      nexusBrainShadow: input.candidate?.nexusBrainShadow ?? null,
      nexusPureStateMachine:
        input.candidate?.nexusPureStateMachine ?? null,
      nexusTrendBreakoutStateMachine:
        input.candidate?.nexusTrendBreakoutStateMachine ?? null,
      nexusMarketEyeDecision:
        input.candidate?.nexusMarketEyeDecision ?? null,
      shadowOriginalDisagreement:
        input.candidate?.shadowOriginalDisagreement ?? false,
      checkedAt: now.toISOString(),
    }),
    updatedAt: now,
    completedAt: now,
  };
  await db
    .insert(strategyExecutionTraces)
    .values({
      traceId,
      ...values,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: strategyExecutionTraces.traceId,
      set: values,
    });
  if (
    input.candidate?.nexusPureStateMachine &&
    input.candidate.nexusPureStateMachine.state !== previousPureState
  ) {
    const snapshot = input.candidate.nexusPureStateMachine;
    await appendEvent(traceId, input.strategy.id, {
      eventType:
        `NEXUS_PURE_STATE:DOWNTREND_CONTINUATION:${snapshot.state}`,
      message:
        `${input.candidate.symbol} 下跌延续状态：${snapshot.state}；` +
        (snapshot.missing.join("、") || "影子证据已闭合"),
      detail: snapshot,
    });
  }
  if (
    input.candidate?.nexusTrendBreakoutStateMachine &&
    input.candidate.nexusTrendBreakoutStateMachine.state !==
      previousTrendState
  ) {
    const snapshot = input.candidate.nexusTrendBreakoutStateMachine;
    await appendEvent(traceId, input.strategy.id, {
      eventType:
        `NEXUS_PURE_STATE:TREND_BREAKOUT:${snapshot.state}`,
      message:
        `${input.candidate.symbol} 做空突破状态：${snapshot.state}；` +
        (snapshot.missing.join("、") || "影子证据已闭合"),
      detail: snapshot,
    });
  }
  if (
    input.candidate?.nexusMarketEyeDecision &&
    (
      input.candidate.nexusMarketEyeDecision.verdict !==
        previousMarketEyeVerdict ||
      input.candidate.nexusMarketEyeDecision.code !==
        previousMarketEyeCode ||
      input.candidate.nexusMarketEyeDecision.summary !==
        previousMarketEyeSummary
    )
  ) {
    const eye = input.candidate.nexusMarketEyeDecision;
    await appendEvent(traceId, input.strategy.id, {
      eventType: `NEXUS_MARKET_EYE:${eye.verdict}`,
      message: `${input.candidate.symbol} NEXUS眼睛：${eye.summary}`,
      detail: eye,
      stage: "SIGNAL",
      outcome:
        eye.verdict === "CONFIRMED"
          ? "PASSED"
          : eye.verdict === "BLOCKED"
            ? "REJECTED"
            : "INFO",
    });
  }
  if (input.candidate?.nexusBrainShadowChanged) {
    const shadow = input.candidate.nexusBrainShadow;
    await appendEvent(traceId, input.strategy.id, {
      eventType: input.candidate.shadowOriginalDisagreement
        ? "NEXUS_BRAIN_SHADOW_SKIPPED_OPPORTUNITY"
        : `NEXUS_BRAIN_SHADOW:${shadow.state}`,
      message: input.candidate.shadowOriginalDisagreement
        ? `${input.candidate.symbol} 影子大脑已确认做空结构，但原策略因 ${input.candidate.decision.status} 跳过；仅登记观察，不下单、不计胜率`
        : `NEXUS大脑做空观察：${shadow.reasons.map((item) => item.message).join("；")}`,
      detail: {
        ...shadow,
        originalDecision: input.candidate.decision.status,
        shadowOriginalDisagreement:
          input.candidate.shadowOriginalDisagreement,
        observationOnly: true,
        orderAffecting: false,
        parameterAffecting: false,
      },
    });
  }
}

async function appendEvent(
  traceId: string,
  strategyId: number,
  input: {
    eventType: string;
    message: string;
    detail: Record<string, unknown>;
    stage?: "SIGNAL" | "ORDER" | "POSITION_MANAGEMENT";
    outcome?: "PASSED" | "PENDING" | "REJECTED" | "INFO" | "ERROR";
    eventAt?: Date;
  },
) {
  const db = getDb();
  const outcome = input.outcome ?? "INFO";
  // A trace is one immutable opportunity lifecycle. Repeated monitor ticks must
  // update the trace snapshot, but they must not create another row for the
  // same business state. Otherwise a temporary capacity wait can crowd every
  // useful decision out of the operator log while adding no new evidence.
  const [duplicate] = await db
    .select({ id: strategyExecutionEvents.id })
    .from(strategyExecutionEvents)
    .where(
      and(
        eq(strategyExecutionEvents.traceId, traceId),
        eq(strategyExecutionEvents.eventType, input.eventType),
        eq(strategyExecutionEvents.outcome, outcome),
      ),
    )
    .limit(1);
  if (duplicate) return false;
  const [latest] = await db
    .select({
      sequence: strategyExecutionEvents.sequence,
    })
    .from(strategyExecutionEvents)
    .where(eq(strategyExecutionEvents.traceId, traceId))
    .orderBy(desc(strategyExecutionEvents.sequence))
    .limit(1);
  const now = new Date();
  await db.insert(strategyExecutionEvents).values({
    traceId,
    strategyId,
    sequence: (latest?.sequence ?? 0) + 1,
    eventType: input.eventType,
    stage: input.stage ?? "POSITION_MANAGEMENT",
    outcome,
    message: input.message,
    detailJson: JSON.stringify(input.detail),
    eventAt: input.eventAt ?? now,
    createdAt: now,
  });
  return true;
}

function parseJson(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedString(
  value: Record<string, unknown>,
  objectKey: string,
  valueKey: string,
) {
  const nested = value[objectKey];
  if (!nested || typeof nested !== "object" || Array.isArray(nested))
    return null;
  const candidate = (nested as Record<string, unknown>)[valueKey];
  return typeof candidate === "string" ? candidate : null;
}
