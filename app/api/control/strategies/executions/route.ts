import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  like,
  lt,
  notLike,
} from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  contractSymbols,
  livePositionAdditionEvidence,
  livePositionAdditions,
  livePositionReductions,
  livePositions,
  strategies,
  strategyLearningCycles,
  strategyExecutionTraces,
  strategyExecutionEvents,
  strategyParameterSuggestions,
  strategyPositionEvidence,
} from "../../../../../db/schema";
import {
  decisionEngineVersionFromEvidence,
  LIQUIDATION_DECISION_ENGINE_VERSION,
} from "../../../../../lib/liquidation-decision-engine";
import { STRATEGY_LEARNING_SCHEMA_VERSION } from "../../../../../lib/strategy-learning-version";
import { aggregatePositionReductionCycle } from "../../../../../lib/live-position-cycle-accounting";
import { resolveLiquidationTrendConfig } from "../../../../../lib/liquidation-trend-config";
import { resolveThreeMinuteExecutionLearningMode } from
  "../../../../../lib/three-minute-learning";
import {
  inferStrategyTriggerKind,
  strategyTriggerCatalogEntry,
} from "../../../../../lib/strategy-trigger-catalog";
import { hasPostBreakLocalRecoveryShadow } from "../../../../../lib/post-break-local-recovery";
import {
  committedStrategyEntryCount,
  committedStrategyEntryCountForTradingDay,
  strategyModelPhase,
} from "../../../../../lib/strategy-model-phase";
import {
  selectStrategyLearningTraceContextsWithinBudget,
  STRATEGY_LEARNING_UI_OBSERVATION_ROW_LIMIT,
  STRATEGY_LEARNING_UI_TRACE_CONTEXT_BUDGET_BYTES,
} from "../../../../../lib/strategy-learning-memory-budget";
import {
  aggregatePositionAdditionLearning,
} from "../../../../../lib/position-addition-learning";
import {
  POSITION_MANAGEMENT_MODEL_VERSION,
} from "../../../../../lib/post-entry-position-management";
import {
  evaluatePositionManagementDecisionOutcome,
  summarizePositionManagementDecisionOutcomes,
} from "../../../../../lib/position-management-decision-outcome";
import {
  strategyLearningSampleReady,
} from "../../../../../lib/strategy-learning-sample-readiness";
import { isResponse, requirePermission } from "../../shared";
import { analyzeWaveSymbolSelection } from "../../../../../lib/wave-symbol-selection-attribution";
import {
  type BinanceLiquidationAggregate,
  getBinanceLiveLiquidationEvents,
} from "../../../../../lib/binance-usdm-live";
import { buildLiquidationMarketTriggerCandidates } from "../../../../../lib/liquidation-market-trigger";
import { liquidationSignalTiming } from "../../../../../lib/liquidation-signal-freshness";
import {
  nexusBrainFirstHourMae,
  nexusBrainShadowStateFromEvidence,
  summarizeNexusBrainShadowComparisons,
  type NexusBrainOriginalDecision,
} from "../../../../../lib/nexus-brain-shadow-comparison";
import {
  SHORT_DOWNTREND_STRATEGY_VERSION,
} from "../../../../../lib/short-downtrend-continuation";
import {
  nexusBrainShadowCheckpointSample,
} from "../../../../../lib/nexus-brain-shadow-counterfactual";
import {
  deriveNexusBrainLifecycle,
  nexusBrainFactIdsFromEvidence,
  summarizeNexusBrainLifecycles,
} from "../../../../../lib/nexus-brain-lifecycle";
import { buildNexusEvidenceConfidenceDecayCapabilityStatus } from "../../../../../lib/nexus-learning-capability-status";
import {
  inverseDirectionLaneFromEvidence,
  summarizeInverseDirectionPerformance,
} from "../../../../../lib/inverse-strategy-observability";
import { summarizeStrategyLearningObservability } from "../../../../../lib/strategy-learning-observability";

export async function GET(request: Request) {
  const user = await requirePermission(request, "trade:dashboard:view");
  if (isResponse(user)) return user;
  const url = new URL(request.url);
  const syncStartedAt = Date.now();
  const strategyId = Number(url.searchParams.get("strategyId"));
  if (!Number.isInteger(strategyId) || strategyId < 1)
    return Response.json({ error: "请选择需要查看的策略" }, { status: 400 });
  const db = getDb();
  const [strategy] = await db
    .select({
      id: strategies.id,
      name: strategies.name,
      configVersion: strategies.configVersion,
      configJson: strategies.configJson,
      strategyType: strategies.strategyType,
      status: strategies.status,
    })
    .from(strategies)
    .where(
      and(
        eq(strategies.id, strategyId),
        eq(strategies.ownerEmail, user.email),
      ),
    )
    .limit(1);
  if (!strategy)
    return Response.json({ error: "策略不存在或无权查看" }, { status: 404 });

  const symbol = url.searchParams.get("symbol")?.trim().toUpperCase();
  const resultCode = url.searchParams.get("resultCode")?.trim();
  const changesOnly = url.searchParams.get("mode") === "changes";
  const monitorOnly = url.searchParams.get("mode") === "monitor";
  const updatedAfter = Number(url.searchParams.get("updatedAfter"));
  if (changesOnly && (!Number.isFinite(updatedAfter) || updatedAfter < 0))
    return Response.json(
      { error: "实时日志游标无效" },
      { status: 400 },
    );
  const currentConfig = asRecord(safeParse(strategy.configJson));
  // SIMPLE_REBOUND owns a deliberately small fixed config and writes its
  // runtime log to strategyExecutionEvents, not the legacy trace model.
  // Keep the log screen independent from the legacy config resolver.
  if (strategy.strategyType === "SIMPLE_REBOUND") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(changesOnly ? 1_000 : 100, Math.max(1, requestedLimit))
      : 50;
    const eventRows = await db
      .select()
      .from(strategyExecutionEvents)
      .where(and(eq(strategyExecutionEvents.strategyId, strategyId)))
      .orderBy(desc(strategyExecutionEvents.eventAt), desc(strategyExecutionEvents.id))
      .limit(limit + 1);
    const filtered = eventRows.filter((row) => {
      if (Number.isInteger(Number(url.searchParams.get("cursor"))) && Number(url.searchParams.get("cursor")) > 0 && row.id >= Number(url.searchParams.get("cursor"))) return false;
      if (changesOnly && row.eventAt.getTime() < Math.max(0, updatedAfter - 2_000)) return false;
      if (resultCode && row.eventType !== resultCode) return false;
      if (!symbol) return true;
      const detail = asRecord(safeParse(row.detailJson));
      return String(detail.symbol ?? "").toUpperCase() === symbol;
    });
    const hasMore = filtered.length > limit;
    const executions = filtered.slice(0, limit).map((row) => {
      const payload = asRecord(safeParse(row.detailJson));
      const detail = asRecord(payload.detail);
      const state = row.outcome === "ERROR" || row.outcome === "REJECTED"
        ? "REJECTED"
        : row.outcome === "PASSED"
          ? "CLOSED"
          : "IN_PROGRESS";
      return {
        traceId: row.traceId,
        strategyId,
        configVersion: strategy.configVersion,
        eventTime: row.eventAt,
        symbol: String(payload.symbol ?? detail.symbol ?? "*"),
        resultCode: row.eventType,
        resultMessage: row.message,
        state,
        triggerKind: "SIMPLE_REBOUND",
        triggerVersion: "simple-rebound-v1",
        triggerDirection: "LONG",
        triggerReferencePrice: Number(detail.referencePrice) || null,
        liquidationNotional: Number(detail.notionalUsdt) || 0,
        liquidationPrice: Number(detail.referencePrice) || 0,
        tradeDirection: "LONG",
        entryEvidence: { simpleRebound: detail },
        completedAt: state === "CLOSED" ? row.eventAt : null,
      };
    });
    const simpleMonitorStatus = {
      source: "SIMPLE_REBOUND_RUNTIME",
      status: strategy.status === "RUNNING" ? "RUNNING" : strategy.status,
      message: "Simple Rebound 使用独立固定规则与独立事件日志",
    };
    return Response.json({
      executions,
      hasMore,
      syncStartedAt,
      monitorStatus: monitorOnly ? simpleMonitorStatus : simpleMonitorStatus,
      learningProgress: null,
      retentionLimit: 1_000,
      source: "SIMPLE_REBOUND_EVENTS",
    }, { headers: { "cache-control": "no-store, max-age=0" } });
  }
  const monitorStatus = changesOnly
    ? null
    : await buildStrategyMonitorStatus(strategy, currentConfig);
  if (monitorOnly)
    return Response.json(
      {
        monitorStatus,
        syncStartedAt,
        source: monitorStatus?.source ?? "INTERNAL_DATABASE",
      },
      {
        headers: {
          "cache-control": "no-store, max-age=0",
        },
      },
    );
  const configuredDirection =
    currentConfig.direction === "SHORT_ONLY" ||
    currentConfig.direction === "BOTH"
      ? currentConfig.direction
      : "LONG_ONLY";
  const cursor = Number(url.searchParams.get("cursor"));
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(changesOnly ? 1_000 : 100, Math.max(1, requestedLimit))
    : 50;
  const conditions = [
    eq(strategyExecutionTraces.ownerEmail, user.email),
    eq(strategyExecutionTraces.strategyId, strategyId),
    notLike(strategyExecutionTraces.traceId, "short-monitor-status:%"),
  ];
  if (symbol) conditions.push(eq(strategyExecutionTraces.symbol, symbol));
  if (resultCode)
    conditions.push(eq(strategyExecutionTraces.resultCode, resultCode));
  if (configuredDirection === "LONG_ONLY")
    conditions.push(notLike(strategyExecutionTraces.traceId, "short-%"));
  if (configuredDirection === "SHORT_ONLY") {
    const shortDirectionOnly = like(
      strategyExecutionTraces.traceId,
      "short-live:%",
    );
    if (shortDirectionOnly) conditions.push(shortDirectionOnly);
  }
  if (changesOnly)
    conditions.push(
      gte(
        strategyExecutionTraces.updatedAt,
        new Date(Math.max(0, updatedAfter - 2_000)),
      ),
    );
  else if (Number.isInteger(cursor) && cursor > 0)
    conditions.push(lt(strategyExecutionTraces.id, cursor));

  const rows = await db
    .select()
    .from(strategyExecutionTraces)
    .where(and(...conditions))
    .orderBy(desc(strategyExecutionTraces.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => ({
    ...row,
    tradeDirection: traceTradeDirection(row),
    configSnapshot: safeParse(row.configSnapshotJson),
    entryEvidence: safeParse(row.entryEvidenceJson),
    configSnapshotJson: undefined,
    entryEvidenceJson: undefined,
  }));
  if (changesOnly)
    return Response.json(
      {
        executions: items,
        hasMore,
        syncStartedAt,
        monitorStatus: null,
        retentionLimit: 1_000,
        source: "INTERNAL_DATABASE",
      },
      {
        headers: {
          "cache-control": "no-store, max-age=0",
        },
      },
    );
  const learningConditions = [
    eq(strategyExecutionTraces.ownerEmail, user.email),
    eq(strategyExecutionTraces.strategyId, strategyId),
    eq(strategyExecutionTraces.configVersion, strategy.configVersion),
  ];
  if (configuredDirection === "LONG_ONLY")
    learningConditions.push(notLike(strategyExecutionTraces.traceId, "short-%"));
  if (configuredDirection === "SHORT_ONLY") {
    const shortLearningOnly = like(strategyExecutionTraces.traceId, "short-live:%");
    if (shortLearningOnly) learningConditions.push(shortLearningOnly);
  }
  const learningObservationRows = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      minuteOffset: strategyPositionEvidence.minuteOffset,
      status: strategyPositionEvidence.status,
      roePercent: strategyPositionEvidence.roePercent,
      maeRoePercent: strategyPositionEvidence.maeRoePercent,
      evidenceJson: strategyPositionEvidence.evidenceJson,
    })
    .from(strategyPositionEvidence)
    .innerJoin(
      strategyExecutionTraces,
      and(
        eq(strategyExecutionTraces.traceId, strategyPositionEvidence.traceId),
        eq(strategyExecutionTraces.strategyId, strategyPositionEvidence.strategyId),
      ),
    )
    .where(
      and(...learningConditions),
    )
    .orderBy(
      desc(strategyPositionEvidence.createdAt),
      desc(strategyPositionEvidence.id),
    )
    .limit(STRATEGY_LEARNING_UI_OBSERVATION_ROW_LIMIT);
  type LearningTraceContextRow = Pick<
    typeof strategyExecutionTraces.$inferSelect,
    | "traceId"
    | "symbol"
    | "eventTime"
    | "triggerKind"
    | "triggerFactSnapshotId"
    | "liquidationNotional"
    | "configSnapshotJson"
    | "entryEvidenceJson"
    | "resultCode"
    | "state"
    | "exchangeOrderId"
    | "createdAt"
    | "positionId"
  >;
  const learningTraceIds = [...new Set(
    learningObservationRows.map((row) => row.traceId),
  )];
  const learningTraceContexts: LearningTraceContextRow[] = [];
  let retainedLearningContextBytes = 0;
  for (const traceIdBatch of sqlValueBatches(learningTraceIds)) {
    if (
      retainedLearningContextBytes >=
        STRATEGY_LEARNING_UI_TRACE_CONTEXT_BUDGET_BYTES
    ) break;
    const contextRows = await db
      .select({
        traceId: strategyExecutionTraces.traceId,
        symbol: strategyExecutionTraces.symbol,
        eventTime: strategyExecutionTraces.eventTime,
        triggerKind: strategyExecutionTraces.triggerKind,
        triggerFactSnapshotId:
          strategyExecutionTraces.triggerFactSnapshotId,
        liquidationNotional: strategyExecutionTraces.liquidationNotional,
        configSnapshotJson: strategyExecutionTraces.configSnapshotJson,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
        resultCode: strategyExecutionTraces.resultCode,
        state: strategyExecutionTraces.state,
        exchangeOrderId: strategyExecutionTraces.exchangeOrderId,
        createdAt: strategyExecutionTraces.createdAt,
        positionId: strategyExecutionTraces.positionId,
      })
      .from(strategyExecutionTraces)
      .where(
        and(
          eq(strategyExecutionTraces.ownerEmail, user.email),
          eq(strategyExecutionTraces.strategyId, strategyId),
          eq(strategyExecutionTraces.configVersion, strategy.configVersion),
          inArray(strategyExecutionTraces.traceId, traceIdBatch),
        ),
      );
    const selected = selectStrategyLearningTraceContextsWithinBudget({
      contexts: contextRows,
      orderedTraceIds: traceIdBatch,
      byteBudget:
        STRATEGY_LEARNING_UI_TRACE_CONTEXT_BUDGET_BYTES -
        retainedLearningContextBytes,
    });
    learningTraceContexts.push(...selected.selected);
    retainedLearningContextBytes += selected.retainedBytes;
    if (selected.truncated) break;
  }
  const learningTraceContextById = new Map(
    learningTraceContexts.map((context) => [context.traceId, context]),
  );
  const learningRows = learningObservationRows
    .flatMap((observation) => {
      const context = learningTraceContextById.get(observation.traceId);
      return context ? [{ ...context, ...observation }] : [];
    })
    .reverse();
  const currentSamples = new Map<
    string,
    {
      latestMinute: number;
      sampleMinutes: Set<number>;
      terminalObservationMinute: number | null;
      rejectedOnly: boolean;
      higherTimeframeRejected: boolean;
      postBreakShadowComplete: boolean;
      consensusShadow: boolean;
      consensus30Complete: boolean;
      causalCheckpointMinutes: Set<number>;
      brainFactIds: string[];
      brainComparisonEligible: boolean;
      estimatedFeeRoePercent: number;
      independenceKey: string;
      statisticalWeight: number;
      noiseEligible: boolean;
      stopLossRoePercent: number | null;
      maeRoePercent: number | null;
      brainShadowState: ReturnType<
        typeof nexusBrainShadowStateFromEvidence
      >;
      brainDirection: "LONG" | "SHORT";
      originalDecision: NexusBrainOriginalDecision;
      checkpointRoe: Map<number, number>;
      entryComparison: {
        clusterId: string | null;
        symbol: string | null;
        position72hPercent: number | null;
        volumeRatio3m: number | null;
        symbolLiquidationSharePercent: number | null;
        symbolContributionRank: number | null;
        entryDistanceAtr: number | null;
        largeTraderStatus:
          | "SUPPORTS_LONG"
          | "CONFLICTS_LONG"
          | "NEUTRAL"
          | "UNAVAILABLE"
          | null;
        liquiditySweepStatus:
          | "RECLAIMED"
          | "ACTIVE_CASCADE"
          | "UNCONFIRMED"
          | "DATA_STALE"
          | null;
        roe60mPercent: number | null;
      };
      positionManagementSamples: Array<{
        minuteOffset: number;
        roePercent: number | null;
        causalEvidenceComplete: boolean;
        decision: {
          action?: string | null;
          currentRoePercent?: number | null;
          bestRoePercent?: number | null;
        } | null;
      }>;
    }
  >();
  for (const row of learningRows) {
    const entryEvidence = asRecord(safeParse(row.entryEvidenceJson));
    const configSnapshot = asRecord(safeParse(row.configSnapshotJson));
    const executionConfig = asRecord(configSnapshot.execution);
    const riskConfig = asRecord(configSnapshot.risk);
    const triggerConfig = asRecord(configSnapshot.trigger);
    const sampleEvidence = asRecord(safeParse(row.evidenceJson));
    const positionManagementDecision = asRecord(
      sampleEvidence.positionManagementDecision,
    );
    const missingManagementEvidence = Array.isArray(
      positionManagementDecision.missingEvidence,
    )
      ? positionManagementDecision.missingEvidence
      : null;
    const entryLargeTrader = asRecord(
      entryEvidence.largeTraderPositioning,
    );
    const entrySweep = asRecord(entryEvidence.liquiditySweep);
    const entryLargeTraderStatus = String(entryLargeTrader.status ?? "");
    const entrySweepStatus = String(entrySweep.status ?? "");
    const brainDirection =
      entryEvidence.tradeDirection === "SHORT" ? "SHORT" : "LONG";
    const isCurrentBrainLearningEvidence =
      brainDirection === "SHORT"
        ? entryEvidence.strategyVersion ===
          SHORT_DOWNTREND_STRATEGY_VERSION
        : decisionEngineVersionFromEvidence(entryEvidence) ===
          LIQUIDATION_DECISION_ENGINE_VERSION;
    if (!isCurrentBrainLearningEvidence) continue;
    const liquidationTrigger = row.triggerKind === "LIQUIDATION_WINDOW";
    const signalNotionalUsdt =
      liquidationTrigger
        ? positiveFiniteOrNull(entryEvidence.symbolLiquidationNotional) ??
          Math.max(0, finiteOrNull(row.liquidationNotional) ?? 0)
        : 0;
    const minimumSignalNotionalUsdt =
      liquidationTrigger
        ? positiveFiniteOrNull(triggerConfig.minLiquidationNotionalUsdt) ?? 0
        : 0;
    const marketClusterId =
      typeof entryEvidence.marketClusterId === "string" &&
      entryEvidence.marketClusterId.trim()
        ? entryEvidence.marketClusterId.trim()
        : null;
    const independenceKey =
      (!liquidationTrigger && row.triggerFactSnapshotId
        ? `${row.triggerKind.toLowerCase()}-${row.triggerFactSnapshotId}`
        : null) ?? marketClusterId ??
      `wave-${brainDirection}-${Math.floor(row.eventTime.getTime() / 120_000)}`;
    const current = currentSamples.get(row.traceId) ?? {
      latestMinute: 0,
      sampleMinutes: new Set<number>(),
      terminalObservationMinute: null,
      rejectedOnly: true,
      higherTimeframeRejected:
        row.resultCode === "STRUCTURE_30M_REJECTED" ||
        row.resultCode === "TREND_1H_REJECTED",
      postBreakShadowComplete: false,
      consensusShadow: Boolean(
        entryEvidence.consensusShadow &&
        typeof entryEvidence.consensusShadow === "object" &&
        !Array.isArray(entryEvidence.consensusShadow),
      ),
      consensus30Complete: false,
      causalCheckpointMinutes: new Set<number>(),
      brainFactIds: nexusBrainFactIdsFromEvidence(entryEvidence),
      brainComparisonEligible: false,
      estimatedFeeRoePercent:
        Math.max(
          0,
          finiteOrNull(entryEvidence.leverage) ??
            finiteOrNull(executionConfig.leverage) ??
            finiteOrNull(configSnapshot.leverage) ??
            1,
        ) * 0.08,
      independenceKey,
      statisticalWeight:
        signalNotionalUsdt > 0 ? Math.log1p(signalNotionalUsdt) : 1,
      noiseEligible:
        minimumSignalNotionalUsdt <= 0 ||
        signalNotionalUsdt >= minimumSignalNotionalUsdt,
      stopLossRoePercent:
        positiveFiniteOrNull(configSnapshot.stopLossRoePercent) ??
        positiveFiniteOrNull(riskConfig.stopLossRoePercent) ??
        positiveFiniteOrNull(riskConfig.stopLossPercent),
      maeRoePercent: null,
      brainShadowState: nexusBrainShadowStateFromEvidence(entryEvidence),
      brainDirection,
      originalDecision:
        row.exchangeOrderId || row.positionId
          ? "TOOK_ENTRY"
          : ["REJECTED", "EXPIRED", "DATA_STALE", "MONITOR_READY"].includes(
              row.state,
            )
            ? "SKIPPED_ENTRY"
            : "PENDING",
      checkpointRoe: new Map<number, number>(),
      entryComparison: {
        clusterId:
          !liquidationTrigger
            ? row.triggerFactSnapshotId
            : marketClusterId,
        symbol:
          typeof row.symbol === "string" && row.symbol.trim()
            ? row.symbol
            : typeof entryEvidence.symbol === "string"
              ? entryEvidence.symbol
              : null,
        position72hPercent: finiteOrNull(
          entryEvidence.position72hPercent,
        ),
        volumeRatio3m: finiteOrNull(entryEvidence.volumeRatio3m),
        symbolLiquidationSharePercent: finiteOrNull(
          entryEvidence.symbolLiquidationSharePercent,
        ),
        symbolContributionRank: finiteOrNull(
          entryEvidence.symbolContributionRank,
        ),
        entryDistanceAtr: finiteOrNull(entryEvidence.entryDistanceAtr),
        largeTraderStatus: [
          "SUPPORTS_LONG",
          "CONFLICTS_LONG",
          "NEUTRAL",
          "UNAVAILABLE",
        ].includes(entryLargeTraderStatus)
          ? entryLargeTraderStatus as
              | "SUPPORTS_LONG"
              | "CONFLICTS_LONG"
              | "NEUTRAL"
              | "UNAVAILABLE"
          : null,
        liquiditySweepStatus: [
          "RECLAIMED",
          "ACTIVE_CASCADE",
          "UNCONFIRMED",
          "DATA_STALE",
        ].includes(entrySweepStatus)
          ? entrySweepStatus as
              | "RECLAIMED"
              | "ACTIVE_CASCADE"
              | "UNCONFIRMED"
              | "DATA_STALE"
          : null,
        roe60mPercent: null,
      },
      positionManagementSamples: [],
    };
    current.latestMinute = Math.max(current.latestMinute, row.minuteOffset);
    current.sampleMinutes.add(row.minuteOffset);
    if (row.status === "CLOSED")
      current.terminalObservationMinute = Math.max(
        current.terminalObservationMinute ?? 0,
        row.minuteOffset,
      );
    if (row.status !== "MISSED") current.rejectedOnly = false;
    if (hasPostBreakLocalRecoveryShadow(row.evidenceJson))
      current.postBreakShadowComplete = true;
    if (row.minuteOffset === 30) current.consensus30Complete = true;
    const shadowCheckpoint = nexusBrainShadowCheckpointSample({
      status: row.status,
      minuteOffset: row.minuteOffset,
      roePercent: finiteOrNull(row.roePercent),
      evidence: sampleEvidence,
    });
    if (shadowCheckpoint) {
      current.brainComparisonEligible = true;
      current.causalCheckpointMinutes.add(
        shadowCheckpoint.minuteOffset,
      );
      current.checkpointRoe.set(
        shadowCheckpoint.minuteOffset,
        shadowCheckpoint.roePercent,
      );
    }
    const rowMaeRoePercent = finiteOrNull(row.maeRoePercent);
    current.maeRoePercent = nexusBrainFirstHourMae(
      current.maeRoePercent,
      rowMaeRoePercent,
      row.minuteOffset,
    );
    if (row.status !== "MISSED") {
      current.brainComparisonEligible = true;
      const roePercent = Number(row.roePercent);
      if (
        [5, 30, 60].includes(row.minuteOffset) &&
        sampleEvidence.evidenceCompleteness === "CAUSAL_ENRICHED"
      )
        current.causalCheckpointMinutes.add(row.minuteOffset);
      if (row.minuteOffset === 60 && Number.isFinite(roePercent))
        current.entryComparison.roe60mPercent = roePercent;
      if ([5, 30, 60].includes(row.minuteOffset) && Number.isFinite(roePercent))
        current.checkpointRoe.set(row.minuteOffset, roePercent);
      current.positionManagementSamples.push({
        minuteOffset: row.minuteOffset,
        roePercent: Number.isFinite(roePercent) ? roePercent : null,
        causalEvidenceComplete:
          sampleEvidence.evidenceCompleteness === "CAUSAL_ENRICHED" &&
          typeof positionManagementDecision.action === "string" &&
          missingManagementEvidence !== null &&
          missingManagementEvidence.length === 0,
        decision:
          typeof positionManagementDecision.action === "string"
            ? {
                action: positionManagementDecision.action,
                currentRoePercent: finiteOrNull(
                  positionManagementDecision.currentRoePercent,
                ),
                bestRoePercent: finiteOrNull(
                  positionManagementDecision.bestRoePercent,
                ),
              }
            : null,
      });
    }
    currentSamples.set(row.traceId, current);
  }
  const actualCompleteSamples = [...currentSamples.values()].filter(
    (sample) =>
      !sample.rejectedOnly &&
      strategyLearningSampleReady(sample),
  );
  const rejectedCompleteSamples = [...currentSamples.values()].filter(
    (sample) =>
      sample.rejectedOnly &&
      strategyLearningSampleReady(sample),
  );
  const completeSamples = [
    ...actualCompleteSamples,
    ...rejectedCompleteSamples,
  ];
  const causalActualSamples = actualCompleteSamples.filter(
    (sample) =>
      [5, 30, 60].every((minute) =>
        sample.causalCheckpointMinutes.has(minute)
      ),
  );
  const nexusBrainLifecycleRows = [...currentSamples.entries()].map(
    ([traceId, sample]) => ({
      traceId,
      snapshot: deriveNexusBrainLifecycle({
        factIds: sample.brainFactIds,
        brainState: sample.brainShadowState,
        originalDecision: sample.originalDecision,
        hasPosition: sample.originalDecision === "TOOK_ENTRY",
        causalCheckpointMinutes: [...sample.causalCheckpointMinutes],
        stopPathRequired: sample.stopLossRoePercent !== null,
        stopPathAvailable: sample.maeRoePercent !== null,
        positionManagementObserved:
          sample.positionManagementSamples.some(
            (positionSample) =>
              positionSample.causalEvidenceComplete,
          ),
      }),
    }),
  );
  const nexusBrainLifecycleByTrace = new Map(
    nexusBrainLifecycleRows.map((row) => [row.traceId, row.snapshot]),
  );
  const nexusBrainLifecycle = summarizeNexusBrainLifecycles(
    nexusBrainLifecycleRows.map((row) => row.snapshot),
  );
  const nexusBrainShadowComparison = summarizeNexusBrainShadowComparisons(
    [...currentSamples.entries()]
      .filter(([, sample]) => sample.brainComparisonEligible)
      .map(([traceId, sample]) => ({
        traceId,
        independenceKey: sample.independenceKey,
        statisticalWeight: sample.statisticalWeight,
        noiseEligible: sample.noiseEligible,
        direction: sample.brainDirection,
        shadowState: sample.brainShadowState,
        originalDecision: sample.originalDecision,
        estimatedFeeRoePercent: sample.estimatedFeeRoePercent,
        stopLossRoePercent: sample.stopLossRoePercent,
        maeRoePercent: sample.maeRoePercent,
        causalComplete:
          nexusBrainLifecycleByTrace.get(traceId)?.learningEligible ??
          false,
        roe5mPercent: sample.checkpointRoe.get(5) ?? null,
        roe30mPercent: sample.checkpointRoe.get(30) ?? null,
        roe60mPercent: sample.checkpointRoe.get(60) ?? null,
      })),
  );
  const waveSymbolSelection = analyzeWaveSymbolSelection({
    rows: actualCompleteSamples.map((sample) => ({
      ...sample.entryComparison,
      entryComparisonEvidenceComplete:
        Boolean(sample.entryComparison.clusterId) &&
        Boolean(sample.entryComparison.symbol) &&
        sample.entryComparison.roe60mPercent !== null &&
        [
          sample.entryComparison.position72hPercent,
          sample.entryComparison.volumeRatio3m,
          sample.entryComparison.symbolLiquidationSharePercent,
          sample.entryComparison.symbolContributionRank,
          sample.entryComparison.entryDistanceAtr,
        ].some((value) => value !== null && Number.isFinite(value)),
    })),
  });
  const resolvedConfig = resolveLiquidationTrendConfig(
    safeParse(strategy.configJson),
    { allowHistoricalLeverage: true },
  );
  if (!resolvedConfig.config)
    return Response.json(
      { error: `策略配置无法读取：${resolvedConfig.error}` },
      { status: 409 },
    );
  const config = resolvedConfig.config;
  const minimumSamples = config.validation.minSamplesForSuggestion;
  const managementOutcomeMinimum = Math.max(
    5,
    Math.ceil(minimumSamples * 0.2),
  );
  const positionManagementOutcomes = [...currentSamples.values()]
    .filter((sample) => !sample.rejectedOnly)
    .map((sample) =>
      evaluatePositionManagementDecisionOutcome({
        samples: sample.positionManagementSamples,
        requiredEdgeRoePercent: Math.max(
          0.5,
          (config.risk.takeProfitSteps[0]?.profitPercent ?? 0) * 0.1,
        ),
      })
    );
  const causalPositionManagementOutcomes =
    positionManagementOutcomes.filter(
      (outcome) => outcome.signalCausalEvidenceReady,
    );
  const positionManagementValidation =
    summarizePositionManagementDecisionOutcomes(
      causalPositionManagementOutcomes,
      managementOutcomeMinimum,
    );
  const positionManagementPendingCount =
    causalPositionManagementOutcomes.filter(
      (outcome) => outcome.status === "INCOMPLETE",
    ).length;
  const positionManagementIncompleteEvidenceCount =
    positionManagementOutcomes.filter(
      (outcome) =>
        outcome.signalAction !== null &&
        !outcome.signalCausalEvidenceReady,
    ).length;
  const minimumPostBreakShadowSamples = Math.max(
    3,
    Math.ceil(minimumSamples * 0.2),
  );
  const postBreakShadowSamples = completeSamples.filter(
    (sample) => sample.higherTimeframeRejected && sample.postBreakShadowComplete,
  ).length;
  const consensusShadowSamples = completeSamples.filter(
    (sample) => sample.consensusShadow,
  ).length;
  const consensus30Samples = completeSamples.filter(
    (sample) => sample.consensusShadow && sample.consensus30Complete,
  ).length;
  const minimumConsensusSamples = Math.max(
    5,
    Math.ceil(minimumSamples * 0.2),
  );
  const positionTraceConditions = [
    eq(strategyExecutionTraces.ownerEmail, user.email),
    eq(strategyExecutionTraces.strategyId, strategyId),
  ];
  if (configuredDirection === "LONG_ONLY")
    positionTraceConditions.push(
      notLike(strategyExecutionTraces.traceId, "short-%"),
    );
  if (configuredDirection === "SHORT_ONLY")
    positionTraceConditions.push(
      like(strategyExecutionTraces.traceId, "short-live:%"),
    );
  positionTraceConditions.push(
    eq(strategyExecutionTraces.configVersion, strategy.configVersion),
  );
  const positionTraceBaseRows = await db
    .select({
      traceId: strategyExecutionTraces.traceId,
      configVersion: strategyExecutionTraces.configVersion,
      state: strategyExecutionTraces.state,
      positionId: strategyExecutionTraces.positionId,
      exchangeOrderId: strategyExecutionTraces.exchangeOrderId,
    })
    .from(strategyExecutionTraces)
    .where(
      and(...positionTraceConditions),
    )
    .orderBy(desc(strategyExecutionTraces.id))
    .limit(10_000);
  const positionEntryEvidenceByTraceId = new Map(
    learningTraceContexts.map((context) => [
      context.traceId,
      context.entryEvidenceJson,
    ]),
  );
  const missingPositionTraceIds = positionTraceBaseRows
    .map((row) => row.traceId)
    .filter((traceId) => !positionEntryEvidenceByTraceId.has(traceId));
  const positionContextBudgetBytes = 16 * 1024 * 1024;
  let retainedPositionContextBytes = 0;
  for (const traceIdBatch of sqlValueBatches(missingPositionTraceIds)) {
    if (retainedPositionContextBytes >= positionContextBudgetBytes) break;
    const contextRows = await db
      .select({
        traceId: strategyExecutionTraces.traceId,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
      })
      .from(strategyExecutionTraces)
      .where(
        and(
          eq(strategyExecutionTraces.ownerEmail, user.email),
          eq(strategyExecutionTraces.strategyId, strategyId),
          eq(strategyExecutionTraces.configVersion, strategy.configVersion),
          inArray(strategyExecutionTraces.traceId, traceIdBatch),
        ),
      );
    const selected = selectStrategyLearningTraceContextsWithinBudget({
      contexts: contextRows,
      orderedTraceIds: traceIdBatch,
      byteBudget:
        positionContextBudgetBytes - retainedPositionContextBytes,
    });
    for (const context of selected.selected)
      positionEntryEvidenceByTraceId.set(
        context.traceId,
        context.entryEvidenceJson,
      );
    retainedPositionContextBytes += selected.retainedBytes;
    if (selected.truncated) break;
  }
  const positionTraceRows = positionTraceBaseRows.flatMap((row) => {
    const entryEvidenceJson = positionEntryEvidenceByTraceId.get(row.traceId);
    return entryEvidenceJson === undefined
      ? []
      : [{ ...row, entryEvidenceJson }];
  });
  const strategyEntryTraceRows = await db
    .select({
      state: strategyExecutionTraces.state,
      positionId: strategyExecutionTraces.positionId,
      exchangeOrderId: strategyExecutionTraces.exchangeOrderId,
    })
    .from(strategyExecutionTraces)
    .where(
      and(
        eq(strategyExecutionTraces.ownerEmail, user.email),
        eq(strategyExecutionTraces.strategyId, strategyId),
      ),
    )
    .limit(10_000);
  const committedEntryOrders = committedStrategyEntryCount(
    strategyEntryTraceRows,
  );
  const currentEngineTraceRows = positionTraceRows.filter(
    (row) =>
      row.configVersion === strategy.configVersion &&
      decisionEngineVersionFromEvidence(
        asRecord(safeParse(row.entryEvidenceJson)),
      ) === LIQUIDATION_DECISION_ENGINE_VERSION,
  );
  const currentPositionIds = [
    ...new Set(
      currentEngineTraceRows
        .map((row) => Number(row.positionId))
        .filter((positionId) => Number.isInteger(positionId) && positionId > 0),
    ),
  ];
  const currentAdditionRows = currentPositionIds.length
    ? await db
        .select({
          id: livePositionAdditions.id,
          decisionJson: livePositionAdditions.decisionJson,
        })
        .from(livePositionAdditions)
        .where(
          and(
            eq(livePositionAdditions.ownerEmail, user.email),
            eq(livePositionAdditions.status, "SUBMITTED"),
            inArray(livePositionAdditions.positionId, currentPositionIds),
          ),
        )
        .limit(10_000)
    : [];
  const currentAdditionIds = currentAdditionRows
    .filter((addition) => {
      const decision = asRecord(safeParse(addition.decisionJson));
      return (
        Number(decision.configVersion) === strategy.configVersion &&
        decision.modelVersion === POSITION_MANAGEMENT_MODEL_VERSION
      );
    })
    .map((addition) => addition.id);
  const positionAdditionEvidenceRows = currentAdditionIds.length
    ? await db
        .select({
          additionId: livePositionAdditionEvidence.additionId,
          minuteOffset: livePositionAdditionEvidence.minuteOffset,
          additionRoePercent:
            livePositionAdditionEvidence.additionRoePercent,
          sampleDelayMs: livePositionAdditionEvidence.sampleDelayMs,
          evidenceJson: livePositionAdditionEvidence.evidenceJson,
        })
        .from(livePositionAdditionEvidence)
        .where(
          inArray(
            livePositionAdditionEvidence.additionId,
            currentAdditionIds,
          ),
        )
        .limit(30_000)
    : [];
  const minimumPositionAdditionSamples = Math.max(
    5,
    Math.ceil(minimumSamples * 0.2),
  );
  const positionAdditionLearning = aggregatePositionAdditionLearning({
    observedAdditionIds: currentAdditionIds,
    positionManagementModelVersion: POSITION_MANAGEMENT_MODEL_VERSION,
    minimumCompletedAdditions: minimumPositionAdditionSamples,
    samples: positionAdditionEvidenceRows.map((sample) => {
      const evidence = asRecord(safeParse(sample.evidenceJson));
      const rawNetAdditionRoe =
        typeof evidence.netAdditionRoePercent === "number"
          ? evidence.netAdditionRoePercent
          : Number.NaN;
      const rawNetImprovement =
        typeof evidence.netCompositeRoeImprovement === "number"
          ? evidence.netCompositeRoeImprovement
          : Number.NaN;
      return {
        additionId: sample.additionId,
        minuteOffset: sample.minuteOffset,
        netAdditionRoePercent: Number.isFinite(rawNetAdditionRoe)
          ? rawNetAdditionRoe
          : null,
        netCompositeRoeImprovement: Number.isFinite(rawNetImprovement)
          ? rawNetImprovement
          : null,
        sampleDelayMs: sample.sampleDelayMs,
        sampleSource:
          typeof evidence.source === "string" ? evidence.source : null,
        modelVersion:
          typeof evidence.modelVersion === "string"
            ? evidence.modelVersion
            : null,
      };
    }),
  });
  const currentStrategyPositions = currentPositionIds.length
    ? await db
        .select({
          id: livePositions.id,
          status: livePositions.status,
          positionSide: livePositions.positionSide,
          quantity: livePositions.quantity,
          entryPrice: livePositions.entryPrice,
          markPrice: livePositions.markPrice,
        })
        .from(livePositions)
        .where(
          and(
            eq(livePositions.ownerEmail, user.email),
            inArray(livePositions.id, currentPositionIds),
          ),
        )
    : [];
  const closedPositionIds = currentStrategyPositions
    .filter((position) => position.status === "CLOSED")
    .map((position) => position.id);
  const reductionRows = closedPositionIds.length
    ? await db
        .select({
          positionId: livePositionReductions.positionId,
          quantity: livePositionReductions.quantity,
          reason: livePositionReductions.reason,
          realizedPnl: livePositionReductions.realizedPnl,
          responseJson: livePositionReductions.responseJson,
        })
        .from(livePositionReductions)
        .where(
          and(
            eq(livePositionReductions.ownerEmail, user.email),
            inArray(livePositionReductions.positionId, closedPositionIds),
          ),
        )
    : [];
  const reductionsByPosition = new Map<
    number,
    typeof reductionRows
  >();
  for (const reduction of reductionRows) {
    const current = reductionsByPosition.get(reduction.positionId) ?? [];
    current.push(reduction);
    reductionsByPosition.set(reduction.positionId, current);
  }
  const exactClosedCycles = closedPositionIds
    .map((positionId) => ({
      positionId,
      accounting: aggregatePositionReductionCycle(
        reductionsByPosition.get(positionId) ?? [],
      ),
    }))
    .filter((cycle) => cycle.accounting.exactNetAvailable);
  const completedExactNetOrders = exactClosedCycles.length;
  const exactNetRealizedPnlUsdt = exactClosedCycles.reduce(
    (total, cycle) => total + cycle.accounting.pnl,
    0,
  );
  const exactNetWinningOrders = exactClosedCycles.filter(
    (cycle) => cycle.accounting.pnl > 0,
  ).length;
  const exactNetWinRatePercent = completedExactNetOrders
    ? (exactNetWinningOrders / completedExactNetOrders) * 100
    : null;
  const openStrategyPositions = currentStrategyPositions.filter(
    (position) =>
      position.status === "OPEN" ||
      position.status === "EXECUTION_UNKNOWN",
  );
  const openGrossRows = openStrategyPositions.map((position) => {
    const direction = position.positionSide === "SHORT" ? -1 : 1;
    return (
      (position.markPrice - position.entryPrice) *
      position.quantity *
      direction
    );
  });
  const openGrossPnlUsdt = openGrossRows.reduce(
    (total, pnl) => total + pnl,
    0,
  );
  const currentTraceByPositionId = new Map(
    currentEngineTraceRows
      .map((trace) => [Number(trace.positionId), trace] as const)
      .filter(([positionId]) =>
        Number.isInteger(positionId) && positionId > 0
      ),
  );
  const inverseDirectionEvaluation =
    config.execution.directionMode === "INVERSE_BRAIN"
      ? summarizeInverseDirectionPerformance({
          minimumSettledSamples: minimumSamples,
          samples: [
            ...exactClosedCycles.map((cycle) => {
              const trace = currentTraceByPositionId.get(cycle.positionId);
              return {
                lane: trace
                  ? inverseDirectionLaneFromEvidence(
                      asRecord(safeParse(trace.entryEvidenceJson)),
                      trace.traceId.startsWith("short-") ? "SHORT" : "LONG",
                    )
                  : null,
                terminalStatus: "CLOSED" as const,
                exactNetPnlUsdt: cycle.accounting.pnl,
              };
            }),
            ...openStrategyPositions.map((position) => {
              const trace = currentTraceByPositionId.get(position.id);
              const direction = position.positionSide === "SHORT" ? -1 : 1;
              return {
                lane: trace
                  ? inverseDirectionLaneFromEvidence(
                      asRecord(safeParse(trace.entryEvidenceJson)),
                      trace.traceId.startsWith("short-") ? "SHORT" : "LONG",
                    )
                  : null,
                terminalStatus: "OPEN" as const,
                openGrossPnlUsdt:
                  (position.markPrice - position.entryPrice) *
                  position.quantity * direction,
              };
            }),
          ],
        })
      : null;
  const modelPhase = strategyModelPhase({
    committedEntryOrders,
    dailyCommittedEntryOrders:
      committedStrategyEntryCountForTradingDay(strategyEntryTraceRows),
    completedExactNetOrders,
  });
  const [terminalLearningTraceRows, learningObservabilityCycleRows,
    learningObservabilitySuggestionRows] = changesOnly
      ? [[], [], []]
      : await Promise.all([
          db
            .select({
              traceId: strategyExecutionTraces.traceId,
              configVersion: strategyExecutionTraces.configVersion,
              triggerKind: strategyExecutionTraces.triggerKind,
              triggerVersion: strategyExecutionTraces.triggerVersion,
              completedAt: strategyExecutionTraces.completedAt,
            })
            .from(strategyExecutionTraces)
            .where(and(
              eq(strategyExecutionTraces.ownerEmail, user.email),
              eq(strategyExecutionTraces.strategyId, strategyId),
              inArray(strategyExecutionTraces.state, [
                "CLOSED",
                "REJECTED",
                "EXPIRED",
                "CANCELED",
                "DATA_STALE",
              ]),
              isNotNull(strategyExecutionTraces.completedAt),
            ))
            .orderBy(desc(strategyExecutionTraces.completedAt))
            .limit(5_000),
          db
            .select({
              traceId: strategyLearningCycles.traceId,
              configVersion: strategyLearningCycles.configVersion,
              terminalStatus: strategyLearningCycles.terminalStatus,
              eligibility: strategyLearningCycles.eligibility,
              exactNetAvailable: strategyLearningCycles.exactNetAvailable,
              updatedAt: strategyLearningCycles.updatedAt,
            })
            .from(strategyLearningCycles)
            .where(eq(strategyLearningCycles.strategyId, strategyId))
            .orderBy(desc(strategyLearningCycles.updatedAt))
            .limit(5_000),
          db
            .select({
              configVersion: strategyParameterSuggestions.configVersion,
              status: strategyParameterSuggestions.status,
            })
            .from(strategyParameterSuggestions)
            .where(eq(strategyParameterSuggestions.strategyId, strategyId))
            .orderBy(desc(strategyParameterSuggestions.createdAt))
            .limit(2_000),
        ]);
  const learningObservability = summarizeStrategyLearningObservability({
    currentConfigVersion: strategy.configVersion,
    traces: terminalLearningTraceRows.flatMap((row) =>
      row.completedAt
        ? [{
            traceId: row.traceId,
            configVersion: row.configVersion,
            triggerKind: row.triggerKind,
            triggerVersion: row.triggerVersion,
            completedAtMs: row.completedAt.getTime(),
          }]
        : []
    ),
    cycles: learningObservabilityCycleRows.map((row) => ({
      traceId: row.traceId,
      configVersion: row.configVersion,
      terminalStatus: row.terminalStatus,
      eligibility: row.eligibility,
      exactNetAvailable: row.exactNetAvailable,
      updatedAtMs: row.updatedAt.getTime(),
    })),
    suggestions: learningObservabilitySuggestionRows,
  });
  const currentTriggerKind = inferStrategyTriggerKind(config);
  const evidenceConfidenceDecaySuggestionRows = changesOnly
    ? []
    : await db
        .select({
          configVersion: strategyParameterSuggestions.configVersion,
          sampleCount: strategyParameterSuggestions.sampleCount,
          status: strategyParameterSuggestions.status,
          currentValueJson: strategyParameterSuggestions.currentValueJson,
          createdAt: strategyParameterSuggestions.createdAt,
        })
        .from(strategyParameterSuggestions)
        .where(
          and(
            eq(strategyParameterSuggestions.strategyId, strategy.id),
            like(
              strategyParameterSuggestions.parameterName,
              "%learning.evidenceConfidenceDecay",
            ),
          ),
        )
        .orderBy(desc(strategyParameterSuggestions.createdAt))
        .limit(10);
  const evidenceConfidenceDecayCapability =
    buildNexusEvidenceConfidenceDecayCapabilityStatus({
      strategyStatus: strategy.status,
      currentConfigVersion: strategy.configVersion,
      suggestions: evidenceConfidenceDecaySuggestionRows.map((row) => ({
        configVersion: row.configVersion,
        sampleCount: row.sampleCount,
        status: row.status,
        createdAt: row.createdAt,
        currentValue: safeParse(row.currentValueJson),
      })),
    });

  return Response.json({
    executions: items,
    hasMore,
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    monitorStatus,
    learningProgress: {
      configVersion: strategy.configVersion,
      decisionEngineVersion:
        currentTriggerKind === "LIQUIDATION_WINDOW"
          ? LIQUIDATION_DECISION_ENGINE_VERSION
          : null,
      learningSchemaVersion: STRATEGY_LEARNING_SCHEMA_VERSION,
      modelPhase: modelPhase.phase,
      explorationTargetOrders: modelPhase.targetOrders,
      learningTargetOrders: modelPhase.learningTargetOrders,
      explorationTargetWinRatePercent: modelPhase.targetWinRatePercent,
      committedEntryOrders: modelPhase.committedEntryOrders,
      dailyCommittedEntryOrders: modelPhase.dailyCommittedEntryOrders,
      dailyReinforcementTargetOrders:
        modelPhase.dailyReinforcementTargetOrders,
      dailyReinforcementRemainingOrders:
        modelPhase.dailyReinforcementRemainingOrders,
      completedExactNetOrders: modelPhase.completedExactNetOrders,
      remainingExplorationOrders: modelPhase.remainingExplorationOrders,
      remainingExactNetOrders: modelPhase.remainingExactNetOrders,
      orderFirstAllowed: modelPhase.orderFirstAllowed,
      parameterOptimizationReady: modelPhase.parameterOptimizationReady,
      historicalPerformanceGateApplied:
        modelPhase.historicalPerformanceGateApplied,
      modelPhaseMessage: modelPhase.message,
      cohortPerformance: {
        exactNetClosedOrders: completedExactNetOrders,
        exactNetWinningOrders,
        exactNetWinRatePercent,
        exactNetRealizedPnlUsdt,
        openPositions: openStrategyPositions.length,
        openWinningPositions: openGrossRows.filter((pnl) => pnl > 0).length,
        openLosingPositions: openGrossRows.filter((pnl) => pnl < 0).length,
        openGrossPnlUsdt,
        accountingBasis:
          "EXACT_NET_CLOSED_PLUS_GROSS_UNREALIZED_OPEN_SEPARATE",
      },
      inverseDirectionEvaluation,
      completeSamples: completeSamples.length,
      actualSamples: actualCompleteSamples.length,
      causalActualSamples: causalActualSamples.length,
      incompleteCausalActualSamples:
        actualCompleteSamples.length - causalActualSamples.length,
      rejectedSamples: rejectedCompleteSamples.length,
      waveSymbolSelection,
      minimumSamples,
      postBreakShadowSamples,
      minimumPostBreakShadowSamples,
      remainingPostBreakShadowSamples: Math.max(
        0,
        minimumPostBreakShadowSamples - postBreakShadowSamples,
      ),
      readyForPostBreakSuggestion:
        postBreakShadowSamples >= minimumPostBreakShadowSamples,
      consensusShadowSamples,
      consensus30Samples,
      minimumConsensusSamples,
      remainingConsensus30Samples: Math.max(
        0,
        minimumConsensusSamples - consensus30Samples,
      ),
      readyForConsensusReview:
        consensus30Samples >= minimumConsensusSamples,
      remainingSamples: Math.max(0, minimumSamples - completeSamples.length),
      remainingActualSamples: Math.max(
        0,
        minimumSamples - actualCompleteSamples.length,
      ),
      remainingRejectedSamples: Math.max(
        0,
        minimumSamples - rejectedCompleteSamples.length,
      ),
      readyForActualSuggestion:
        actualCompleteSamples.length >= minimumSamples,
      readyForRejectedSuggestion:
        rejectedCompleteSamples.length >= minimumSamples,
      positionManagementValidation: {
        ...positionManagementValidation,
        minimumSamples: managementOutcomeMinimum,
        causalSignals: causalPositionManagementOutcomes.length,
        pendingCount: positionManagementPendingCount,
        incompleteEvidenceCount:
          positionManagementIncompleteEvidenceCount,
      },
      positionAdditionLearning,
      nexusBrainLifecycle,
      nexusBrainShadowComparison,
      evidenceConfidenceDecayCapability,
      learningObservability,
      isolationMessage:
        "真实订单5/30/60分钟周期、拒绝对照和历史兼容样本分别统计；交易样本按配置版本与决策引擎隔离，三者不再混为同一笔数；同一交易规则的历史证据会按当前学习算法重新分析",
    },
  });
}

function safeParse(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function traceTradeDirection(
  trace: Pick<
    typeof strategyExecutionTraces.$inferSelect,
    "traceId" | "resultCode" | "entryEvidenceJson"
  >,
) {
  const evidence = asRecord(safeParse(trace.entryEvidenceJson));
  if (evidence.tradeDirection === "SHORT") return "SHORT" as const;
  if (evidence.tradeDirection === "LONG") return "LONG" as const;
  return trace.traceId.startsWith("short-") ||
    trace.resultCode?.startsWith("SHORT_")
    ? "SHORT" as const
    : "LONG" as const;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function buildStrategyMonitorStatus(
  strategy: Pick<
    typeof strategies.$inferSelect,
    "id" | "name" | "strategyType" | "configJson" | "configVersion"
  >,
  currentConfig: Record<string, unknown>,
) {
  if (strategy.strategyType !== "LIQ_CHASE") return null;
  const resolvedConfig = resolveLiquidationTrendConfig(currentConfig, {
    allowHistoricalLeverage: true,
  });
  if (!resolvedConfig.config) return null;
  const config = resolvedConfig.config;
  const triggerKind = inferStrategyTriggerKind(config);
  const activeAnalyses = await getDb()
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
        eq(strategyExecutionTraces.triggerKind, triggerKind),
        inArray(strategyExecutionTraces.state, [
          "TRIGGERED",
          "ANALYZING",
          "ARMED",
          "ORDER_READY",
          "ORDER_PENDING",
          "POSITION_OPEN",
          "TRAILING_ARMED",
          "TRAILING_ACTIVE",
          "EXIT_PENDING",
        ]),
      ),
    )
    .orderBy(desc(strategyExecutionTraces.updatedAt), desc(strategyExecutionTraces.id))
    .limit(20)
    .then((rows) =>
      rows.map((trace) => ({
        traceId: trace.traceId,
        symbol: trace.symbol,
        state: trace.state,
        resultCode: trace.resultCode,
        resultMessage: trace.resultMessage,
        ageSeconds: roundForStatus((Date.now() - trace.createdAt.getTime()) / 1_000, 1),
        expiresInSeconds: trace.expiresAt
          ? roundForStatus((trace.expiresAt.getTime() - Date.now()) / 1_000, 1)
          : null,
        updatedAgeSeconds: roundForStatus((Date.now() - trace.updatedAt.getTime()) / 1_000, 1),
      })),
    );
  const activeAnalysisCount = activeAnalyses.length;
  if (triggerKind === "THREE_MINUTE_PROBABILITY") {
    const roundConfig = config.trigger.threeMinuteProbability!;
    const [latestTrace] = await getDb()
      .select({
        traceId: strategyExecutionTraces.traceId,
        symbol: strategyExecutionTraces.symbol,
        state: strategyExecutionTraces.state,
        resultCode: strategyExecutionTraces.resultCode,
        resultMessage: strategyExecutionTraces.resultMessage,
        positionId: strategyExecutionTraces.positionId,
        entryEvidenceJson: strategyExecutionTraces.entryEvidenceJson,
        createdAt: strategyExecutionTraces.createdAt,
        updatedAt: strategyExecutionTraces.updatedAt,
      })
      .from(strategyExecutionTraces)
      .where(
        and(
          eq(strategyExecutionTraces.strategyId, strategy.id),
          eq(
            strategyExecutionTraces.triggerKind,
            "THREE_MINUTE_PROBABILITY",
          ),
          eq(strategyExecutionTraces.configVersion, strategy.configVersion),
        ),
      )
      .orderBy(
        desc(strategyExecutionTraces.updatedAt),
        desc(strategyExecutionTraces.id),
      )
      .limit(1);
    const [latestPositionTrace] = await getDb()
      .select({
        traceId: strategyExecutionTraces.traceId,
        positionId: strategyExecutionTraces.positionId,
      })
      .from(strategyExecutionTraces)
      .where(
        and(
          eq(strategyExecutionTraces.strategyId, strategy.id),
          eq(
            strategyExecutionTraces.triggerKind,
            "THREE_MINUTE_PROBABILITY",
          ),
          eq(strategyExecutionTraces.configVersion, strategy.configVersion),
          isNotNull(strategyExecutionTraces.positionId),
        ),
      )
      .orderBy(desc(strategyExecutionTraces.id))
      .limit(1);
    const latestEvidence = asRecord(
      safeParse(latestTrace?.entryEvidenceJson ?? "{}"),
    );
    const probability = asRecord(latestEvidence.threeMinuteProbability);
    const roundId = String(
      latestEvidence.roundId ?? probability.roundId ?? "",
    ) || null;
    const roundEndsAtMs = Number(
      latestEvidence.roundEndsAt ?? probability.roundEndsAt,
    );
    const positionId = Number(latestPositionTrace?.positionId);
    const [position] = Number.isSafeInteger(positionId) && positionId > 0
      ? await getDb()
          .select({
            id: livePositions.id,
            symbol: livePositions.symbol,
            positionSide: livePositions.positionSide,
            status: livePositions.status,
            openedAt: livePositions.openedAt,
            closedAt: livePositions.closedAt,
            realizedPnl: livePositions.realizedPnl,
          })
          .from(livePositions)
          .where(eq(livePositions.id, positionId))
          .limit(1)
      : [];
    const checkpointRows = latestPositionTrace?.traceId
      ? await getDb()
          .select({
            minuteOffset: strategyPositionEvidence.minuteOffset,
            status: strategyPositionEvidence.status,
            sampledAt: strategyPositionEvidence.sampledAt,
            roePercent: strategyPositionEvidence.roePercent,
            mfeRoePercent: strategyPositionEvidence.mfeRoePercent,
            maeRoePercent: strategyPositionEvidence.maeRoePercent,
            netPnlEstimate: strategyPositionEvidence.netPnlEstimate,
            evidenceJson: strategyPositionEvidence.evidenceJson,
          })
          .from(strategyPositionEvidence)
          .where(
            and(
              eq(
                strategyPositionEvidence.traceId,
                latestPositionTrace.traceId,
              ),
              eq(strategyPositionEvidence.strategyId, strategy.id),
              inArray(strategyPositionEvidence.minuteOffset, [1, 2, 3]),
            ),
          )
          .orderBy(strategyPositionEvidence.minuteOffset)
      : [];
    const learningRows = await getDb()
      .select({
        exactNetAvailable: strategyLearningCycles.exactNetAvailable,
        exactNetPnlUsdt: strategyLearningCycles.exactNetPnlUsdt,
        detailJson: strategyLearningCycles.detailJson,
      })
      .from(strategyLearningCycles)
      .where(
        and(
          eq(strategyLearningCycles.strategyId, strategy.id),
          eq(strategyLearningCycles.configVersion, strategy.configVersion),
          eq(strategyLearningCycles.terminalStatus, "CLOSED"),
        ),
      )
      .orderBy(desc(strategyLearningCycles.updatedAt))
      .limit(500);
    let wins = 0;
    let losses = 0;
    let exactNetSampleCount = 0;
    let exactNetPnlUsdt = 0;
    let recentExactBatchSampleCount = 0;
    let recentExactBatchPnlUsdt = 0;
    for (const row of learningRows) {
      const memory = asRecord(asRecord(safeParse(row.detailJson)).memoryCase);
      const observed = Number(
        row.exactNetAvailable
          ? row.exactNetPnlUsdt
          : memory.observedPnlUsdt,
      );
      if (Number.isFinite(observed)) {
        if (observed > 0) wins += 1;
        else if (observed < 0) losses += 1;
      }
      if (row.exactNetAvailable && Number.isFinite(Number(row.exactNetPnlUsdt))) {
        exactNetSampleCount += 1;
        exactNetPnlUsdt += Number(row.exactNetPnlUsdt);
        if (recentExactBatchSampleCount < roundConfig.batchSize) {
          recentExactBatchSampleCount += 1;
          recentExactBatchPnlUsdt += Number(row.exactNetPnlUsdt);
        }
      }
    }
    const learned = wins + losses;
    const negativeExactBatch =
      recentExactBatchSampleCount >= roundConfig.batchSize &&
      recentExactBatchPnlUsdt < 0;
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      triggerKind,
      triggerLabel: strategyTriggerCatalogEntry(triggerKind).label,
      direction: config.direction,
      feedEvents: 0,
      candidateCount: latestTrace ? 1 : 0,
      freshCandidateCount: activeAnalysisCount,
      freshestCandidateAgeSeconds: latestTrace
        ? roundForStatus((Date.now() - latestTrace.updatedAt.getTime()) / 1_000, 1)
        : null,
      activeAnalysisCount,
      activeAnalyses: activeAnalyses.slice(0, 5),
      recentLiquidations: [],
      suggestion: negativeExactBatch
        ? {
            action: "REVIEW_NEGATIVE_EXPECTANCY_BATCH",
            message: "最近精确结算批次为负期望；按策略配置转观察或最小量校准，参数候选需人工确认。",
          }
        : null,
      threeMinuteRound: {
        roundId,
        roundEndsAt: Number.isFinite(roundEndsAtMs)
          ? new Date(roundEndsAtMs).toISOString()
          : null,
        countdownSeconds: Number.isFinite(roundEndsAtMs)
          ? Math.max(0, Math.ceil((roundEndsAtMs - Date.now()) / 1_000))
          : null,
        symbol: latestTrace?.symbol ?? null,
        direction: probability.direction === "SHORT" ? "SHORT" :
          probability.direction === "LONG" ? "LONG" : null,
        pLongPercent: finiteOrNull(probability.pLongPercent),
        pShortPercent: finiteOrNull(probability.pShortPercent),
        netEdgeBps: finiteOrNull(probability.netEdgeBps),
        breakEvenProbabilityPercent: finiteOrNull(
          probability.breakEvenProbabilityPercent,
        ),
        dataQuality: String(probability.dataQuality ?? "UNAVAILABLE"),
        state: latestTrace?.state ?? "WAITING",
        resultCode: latestTrace?.resultCode ?? null,
        resultMessage: latestTrace?.resultMessage ?? null,
      },
      threeMinutePosition: position
        ? {
            positionId: position.id,
            symbol: position.symbol,
            direction: position.positionSide,
            status: position.status,
            openedAt: position.openedAt.toISOString(),
            exitDueAt: new Date(position.openedAt.getTime() + 180_000).toISOString(),
            remainingSeconds: position.status === "OPEN"
              ? Math.max(
                  0,
                  Math.ceil(
                    (position.openedAt.getTime() + 180_000 - Date.now()) / 1_000,
                  ),
                )
              : 0,
            realizedPnlUsdt: position.realizedPnl,
          }
        : null,
      threeMinuteCheckpoints: checkpointRows.map((row) => {
        const evidence = asRecord(safeParse(row.evidenceJson));
        return {
          elapsedSeconds: row.minuteOffset * 60,
          status: row.status,
          sampledAt: row.sampledAt?.toISOString() ?? null,
          roePercent: finiteOrNull(row.roePercent),
          mfeRoePercent: finiteOrNull(row.mfeRoePercent),
          maeRoePercent: finiteOrNull(row.maeRoePercent),
          netPnlEstimate: finiteOrNull(row.netPnlEstimate),
          counterfactual:
            evidence.sampleType === "THREE_MINUTE_COUNTERFACTUAL_180S",
        };
      }),
      threeMinuteLearning: {
        learnedRounds: learned,
        wins,
        losses,
        exactNetSampleCount,
        exactNetPnlUsdt: roundForStatus(exactNetPnlUsdt, 6),
        recentExactBatchSampleCount,
        recentExactBatchPnlUsdt: roundForStatus(
          recentExactBatchPnlUsdt,
          6,
        ),
        calibrationRounds: roundConfig.calibrationRounds,
        calibrationRemaining: Math.max(
          0,
          roundConfig.calibrationRounds - learned,
        ),
        batchSize: roundConfig.batchSize,
        mode: resolveThreeMinuteExecutionLearningMode({
          sampleCount: learned,
          calibrationRounds: roundConfig.calibrationRounds,
          exactNetSampleCount,
          recentExactBatchSampleCount,
          recentExactBatchPnlUsdt,
          batchSize: roundConfig.batchSize,
          calibrationMode: roundConfig.calibrationMode,
          negativeExpectancyMode: roundConfig.negativeExpectancyMode,
        }),
        humanConfirmationRequired: true,
      },
      reason: latestTrace
        ? latestTrace.resultMessage ??
          `最近一次滚动评估 ${latestTrace.symbol} 正在${latestTrace.state}`
        : "等待下一次滚动评估的共享行情事实",
      checkedAt: new Date().toISOString(),
      source: "UNIFIED_THREE_MINUTE_PROBABILITY_TRIGGER",
      note: "只读诊断；滚动触发不直接授权订单，参数候选不会自动发布。",
    };
  }
  if (triggerKind === "LOW_POSITION_WINDOW") {
    const lowPosition = config.trigger.lowPositionWindow!;
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      triggerKind,
      triggerLabel: strategyTriggerCatalogEntry(triggerKind).label,
      direction: config.direction,
      feedEvents: 0,
      candidateCount: activeAnalysisCount,
      freshCandidateCount: activeAnalysisCount,
      freshestCandidateAgeSeconds: activeAnalyses[0]?.ageSeconds ?? null,
      activeAnalysisCount,
      activeAnalyses: activeAnalyses.slice(0, 5),
      lowPositionThreshold: {
        maxPosition72hPercent: lowPosition.maxPosition72hPercent,
        scanIntervalSeconds: lowPosition.scanIntervalSeconds,
        maxWakeCandidatesPerCycle: lowPosition.maxWakeCandidatesPerCycle,
      },
      recentLiquidations: [],
      suggestion: null,
      reason: activeAnalysisCount
        ? `已有 ${activeAnalysisCount} 个72小时低位候选进入统一大脑分析`
        : `等待合约进入72小时价格位置 ${lowPosition.maxPosition72hPercent}% 以下`,
      checkedAt: new Date().toISOString(),
      source: "UNIFIED_LOW_POSITION_TRIGGER",
      note: "只读诊断；72小时低位触发不会读取或展示爆仓流，也不能直接授权订单。",
    };
  }
  if (triggerKind !== "LIQUIDATION_WINDOW") {
    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      triggerKind,
      triggerLabel: strategyTriggerCatalogEntry(triggerKind).label,
      direction: config.direction,
      feedEvents: 0,
      candidateCount: activeAnalysisCount,
      freshCandidateCount: activeAnalysisCount,
      freshestCandidateAgeSeconds: activeAnalyses[0]?.ageSeconds ?? null,
      activeAnalysisCount,
      activeAnalyses: activeAnalyses.slice(0, 5),
      recentLiquidations: [],
      suggestion: null,
      reason: activeAnalysisCount
        ? `已有 ${activeAnalysisCount} 个${strategyTriggerCatalogEntry(triggerKind).label}候选进入统一执行链`
        : `${strategyTriggerCatalogEntry(triggerKind).label}由专用触发器监听，当前没有进行中的候选`,
      checkedAt: new Date().toISOString(),
      source: `TRIGGER_RUNTIME_${triggerKind}`,
      note: "只读诊断；该触发器不读取中心爆仓流。",
    };
  }
  const side = config.direction === "SHORT_ONLY" ? "BUY" as const : "SELL" as const;
  const threshold = {
    side,
    minSingleEventNotionalUsdt:
      config.trigger.minSingleLiquidationNotionalUsdt ??
      config.trigger.minLiquidationNotionalUsdt,
    minWindowNotionalUsdt: config.trigger.minLiquidationNotionalUsdt,
    minEventCount: config.trigger.minClusterEvents ?? 1,
    maxSpanSeconds: config.trigger.maxClusterSpanSeconds ?? 3,
    maxInterEventGapSeconds:
      config.trigger.maxClusterEventGapSeconds ??
      config.trigger.maxClusterSpanSeconds ??
      3,
    maxSignalDelayMs: config.trigger.maxSignalDelayMs,
  };
  const feed = await getBinanceLiveLiquidationEvents(0, 300_000);
  const activeSymbolRows = await getDb()
    .select({ symbol: contractSymbols.symbol })
    .from(contractSymbols)
    .where(eq(contractSymbols.isActive, true));
  const activeSymbols = new Set(activeSymbolRows.map((item) => item.symbol));
  const selectedSymbols = new Set(config.selectedSymbols);
  const strategyFeedRows = feed.rows.filter(
    (item) =>
      activeSymbols.has(item.symbol) &&
      (!selectedSymbols.size || selectedSymbols.has(item.symbol)),
  );
  const candidates = buildLiquidationMarketTriggerCandidates(strategyFeedRows, {
    side,
    minNotionalUsdt: threshold.minWindowNotionalUsdt,
    minSingleEventNotionalUsdt: threshold.minSingleEventNotionalUsdt,
    minLiquidationPrice: config.trigger.minLiquidationPrice ?? 0,
    maxLiquidationPrice: config.trigger.maxLiquidationPrice ?? 0,
    minEventCount: threshold.minEventCount,
    maxSpanMs: threshold.maxSpanSeconds * 1_000,
    maxInterEventGapMs: threshold.maxInterEventGapSeconds * 1_000,
  });
  const freshCandidates = candidates.filter((item) =>
    liquidationSignalTiming({
      tradeTimeMs: item.lastTradeTime,
      receivedAtMs: item.lastReceivedAt,
      processedAtMs: Date.now(),
      maxSignalDelayMs: threshold.maxSignalDelayMs,
    }).fresh,
  );
  const freshestCandidateAgeSeconds = candidates.length
    ? Math.min(
        ...candidates.map((item) => (Date.now() - item.lastTradeTime) / 1_000),
      )
    : null;
  const strongestSingle = summarizeStrongestLiquidation(strategyFeedRows, side);
  const bestConfiguredWindow = summarizeBestLiquidationWindowForStatus(
    strategyFeedRows,
    side,
    Math.max(1_000, threshold.maxSpanSeconds * 1_000),
    Math.max(1_000, threshold.maxInterEventGapSeconds * 1_000),
  );
  const best120SecondWindow = summarizeBestLiquidationWindowForStatus(
    strategyFeedRows,
    side,
    120_000,
    120_000,
  );
  const suggestion = buildMonitorSuggestion({
    threshold,
    candidateCount: candidates.length,
    freshCandidateCount: freshCandidates.length,
    freshestCandidateAgeSeconds,
    activeAnalysisCount,
    strongestSingle,
    bestConfiguredWindow,
    best120SecondWindow,
  });
  const candidateSequences = new Set(
    candidates.map((item) => item.sequence),
  );
  const freshCandidateSequences = new Set(
    freshCandidates.map((item) => item.sequence),
  );
  const recentLiquidations = [...strategyFeedRows]
    .sort(
      (left, right) =>
        right.lastTradeTime - left.lastTradeTime ||
        right.sequence - left.sequence,
    )
    .slice(0, 100)
    .map((item) => {
      const directionMatches = item.side === side;
      const brainAccepted = freshCandidateSequences.has(item.sequence);
      const signalExpired =
        !brainAccepted && candidateSequences.has(item.sequence);
      return {
        sequence: item.sequence,
        symbol: item.symbol,
        side: item.side,
        notional: roundForStatus(item.notional),
        averagePrice: item.averagePrice,
        eventCount: Math.max(1, Math.trunc(item.eventCount || 1)),
        tradeTime: item.lastTradeTime,
        receivedAt: item.lastReceivedAt,
        screeningState: !directionMatches
          ? "DIRECTION_SKIPPED" as const
          : brainAccepted
            ? "BRAIN_ACCEPTED" as const
            : signalExpired
              ? "SIGNAL_EXPIRED" as const
              : "ACCUMULATING" as const,
        screeningReason: !directionMatches
          ? `爆仓方向与当前策略触发方向不一致，已跳过`
          : brainAccepted
            ? "同币爆仓已达到策略门槛，已进入完整判断链路"
            : signalExpired
              ? `同币爆仓曾达到门槛，但超过 ${(threshold.maxSignalDelayMs / 1_000).toFixed(1)} 秒最大处理延迟，未建立新订单`
              : `同币单笔 ${roundForStatus(item.notional).toFixed(2)} / ${threshold.minSingleEventNotionalUsdt.toFixed(2)} USDT；连续窗口仍在累计，未形成候选`,
      };
    });
  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    triggerKind,
    triggerLabel: strategyTriggerCatalogEntry(triggerKind).label,
    direction: config.direction,
    triggerSide: side,
    feedEvents: strategyFeedRows.length,
    candidateCount: candidates.length,
    freshCandidateCount: freshCandidates.length,
    freshestCandidateAgeSeconds: finiteOrNull(freshestCandidateAgeSeconds),
    activeAnalysisCount,
    activeAnalyses: activeAnalyses.slice(0, 5),
    threshold,
    strongestSingle,
    bestConfiguredWindow,
    best120SecondWindow,
    recentLiquidations,
    suggestion,
    reason: monitorStatusReason({
      threshold,
      candidateCount: candidates.length,
      freshCandidateCount: freshCandidates.length,
      freshestCandidateAgeSeconds,
      activeAnalysisCount,
      strongestSingle,
      bestConfiguredWindow,
      best120SecondWindow,
    }),
    checkedAt: new Date().toISOString(),
    source: "CENTRALIZED_LIQUIDATION_FEED",
    note: "只读诊断，不创建订单、不写入学习样本。",
  };
}

function summarizeStrongestLiquidation(
  rows: BinanceLiquidationAggregate[],
  side: "BUY" | "SELL",
) {
  const row = rows
    .filter((item) => item.side === side)
    .sort((left, right) => right.notional - left.notional)[0];
  if (!row) return null;
  return {
    symbol: row.symbol,
    side,
    notional: roundForStatus(row.notional),
    eventCount: Math.max(1, Math.trunc(row.eventCount || 1)),
    spanSeconds: roundForStatus((row.lastTradeTime - row.firstTradeTime) / 1_000, 1),
    latestAgeSeconds: roundForStatus((Date.now() - row.lastTradeTime) / 1_000, 1),
  };
}

function summarizeBestLiquidationWindowForStatus(
  rows: BinanceLiquidationAggregate[],
  side: "BUY" | "SELL",
  maxSpanMs: number,
  maxInterEventGapMs: number,
) {
  const bySymbol = new Map<string, BinanceLiquidationAggregate[]>();
  for (const row of rows) {
    if (row.side !== side) continue;
    const current = bySymbol.get(row.symbol) ?? [];
    current.push(row);
    bySymbol.set(row.symbol, current);
  }
  let best: {
    symbol: string;
    side: "BUY" | "SELL";
    notional: number;
    eventCount: number;
    spanSeconds: number;
    maxGapSeconds: number;
    latestAgeSeconds: number;
  } | null = null;
  for (const [symbol, symbolRows] of bySymbol) {
    const ordered = [...symbolRows].sort(
      (left, right) => left.lastTradeTime - right.lastTradeTime || left.sequence - right.sequence,
    );
    for (let start = 0; start < ordered.length; start += 1) {
      let notional = 0;
      let eventCount = 0;
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
        maxGapMs = Math.max(maxGapMs, gapMs);
        const candidate = {
          symbol,
          side,
          notional: roundForStatus(notional),
          eventCount,
          spanSeconds: roundForStatus((row.lastTradeTime - first.firstTradeTime) / 1_000, 1),
          maxGapSeconds: roundForStatus(maxGapMs / 1_000, 1),
          latestAgeSeconds: roundForStatus((Date.now() - row.lastTradeTime) / 1_000, 1),
        };
        if (!best || candidate.notional > best.notional) best = candidate;
      }
    }
  }
  return best;
}

function monitorStatusReason(input: {
  threshold: {
    side: "BUY" | "SELL";
    minSingleEventNotionalUsdt: number;
    minWindowNotionalUsdt: number;
    maxSpanSeconds: number;
    maxSignalDelayMs: number;
  };
  candidateCount: number;
  freshCandidateCount: number;
  freshestCandidateAgeSeconds: number | null;
  activeAnalysisCount: number;
  strongestSingle: { notional: number; symbol: string } | null;
  bestConfiguredWindow: { notional: number; symbol: string } | null;
  best120SecondWindow: { notional: number; symbol: string } | null;
}) {
  if (input.activeAnalysisCount > 0 && input.freshCandidateCount === 0)
    return `已有 ${input.activeAnalysisCount} 条链路正在分析/管理；本轮没有新增新鲜候选。`;
  if (input.freshCandidateCount > 0)
    return `已有 ${input.freshCandidateCount} 个新鲜 ${input.threshold.side} 单币爆仓候选，等待趋势/结构/订单条件确认。`;
  if (input.candidateCount > 0)
    return `本轮已丢弃 ${input.candidateCount} 个过期候选；最新候选约 ${(input.freshestCandidateAgeSeconds ?? 0).toFixed(1)} 秒，超过策略允许的 ${(input.threshold.maxSignalDelayMs / 1_000).toFixed(1)} 秒时效，继续等待下一条新鲜候选。`;
  return [
    `未形成 ${input.threshold.side} 候选`,
    `最大单笔 ${input.strongestSingle?.symbol ?? "—"} ${(input.strongestSingle?.notional ?? 0).toFixed(2)} / ${input.threshold.minSingleEventNotionalUsdt.toFixed(2)} USDT`,
    `${input.threshold.maxSpanSeconds}s窗口 ${input.bestConfiguredWindow?.symbol ?? "—"} ${(input.bestConfiguredWindow?.notional ?? 0).toFixed(2)} / ${input.threshold.minWindowNotionalUsdt.toFixed(2)} USDT`,
    `120s观察 ${input.best120SecondWindow?.symbol ?? "—"} ${(input.best120SecondWindow?.notional ?? 0).toFixed(2)} USDT`,
  ].join("；");
}

function buildMonitorSuggestion(input: {
  threshold: {
    minSingleEventNotionalUsdt: number;
    minWindowNotionalUsdt: number;
    maxSpanSeconds: number;
    maxInterEventGapSeconds: number;
    maxSignalDelayMs: number;
  };
  candidateCount: number;
  freshCandidateCount: number;
  freshestCandidateAgeSeconds: number | null;
  activeAnalysisCount: number;
  strongestSingle: { notional: number; symbol: string } | null;
  bestConfiguredWindow: { notional: number; symbol: string; spanSeconds?: number; maxGapSeconds?: number } | null;
  best120SecondWindow: { notional: number; symbol: string; spanSeconds?: number; maxGapSeconds?: number } | null;
}) {
  if (input.activeAnalysisCount > 0)
    return {
      action: "OBSERVE_ACTIVE_TRACE",
      message: `已有 ${input.activeAnalysisCount} 条链路在跑，先看趋势判断和持仓管理结果，避免重复追同类信号。`,
    };
  if (input.freshCandidateCount > 0)
    return { action: "KEEP", message: "已有新鲜候选，先观察后续硬条件是否通过。" };
  if (input.candidateCount > 0)
    return {
      action: "KEEP_WAITING",
      message: "候选已经过期，本轮不进入裁决，也不因一次过期自动放宽延迟；等待下一条新鲜候选。",
    };
  const wide = input.best120SecondWindow;
  const configured = input.bestConfiguredWindow;
  if (wide && wide.notional > (configured?.notional ?? 0) * 1.5)
    return {
      action: "WIDEN_WINDOW",
      message: `${wide.symbol} 120秒累计更接近触发，可考虑把窗口从 ${input.threshold.maxSpanSeconds}s 放宽到 ${Math.max(30, Math.ceil(wide.spanSeconds ?? 30))}s。`,
    };
  const nearest = [configured, wide, input.strongestSingle]
    .filter(Boolean)
    .sort((left, right) => right!.notional - left!.notional)[0];
  if (nearest)
    return {
      action: "LOWER_NOTIONAL",
      message: `${nearest.symbol} 当前最接近，金额 ${nearest.notional.toFixed(2)} USDT；探索期可考虑把单币触发金额降到不高于 ${Math.max(1, Math.floor(nearest.notional))} USDT。`,
    };
  return { action: "WAIT", message: "暂无可参考爆仓事件，继续等待真实波动。" };
}

function roundForStatus(value: number, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveFiniteOrNull(value: unknown) {
  const numeric = finiteOrNull(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function sqlValueBatches<T>(values: T[], batchSize = 50) {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize)
    batches.push(values.slice(index, index + batchSize));
  return batches;
}


