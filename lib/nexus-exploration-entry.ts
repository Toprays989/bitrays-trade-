import type { NexusMarketEyeDecision } from "./nexus-market-eye-decision";
import type { StrategyModelPhase } from "./strategy-model-phase";

type ModelProgress = {
  phase: StrategyModelPhase;
  targetOrders: number;
  committedEntryOrders: number;
  remainingExplorationOrders: number;
  orderFirstAllowed: boolean;
};

export type NexusExplorationEntryPolicy = {
  version: "nexus-exploration-entry-v4";
  allowed: boolean;
  reasonCode:
    | "NORMAL_CONFIRMED_ENTRY"
    | "EXPLORATION_TARGET_COMPLETE"
    | "HARD_EYE_REJECTION"
    | "STRONG_DIRECTION_CONFLICT"
    | "WAIT_SECOND_LIQUIDATION"
    | "STRONG_SINGLE_LIQUIDATION_PROBE"
    | "AGGREGATE_LIQUIDATION_PROBE"
    | "DECISION_SNAPSHOT_INCOMPLETE"
    | "WEAK_EVIDENCE_MARKET_PROBE"
    | "WEAK_EVIDENCE_ADAPTIVE_PROBE"
    | "WEAK_EVIDENCE_LIMIT_PROBE";
  phase: StrategyModelPhase;
  targetOrders: number;
  committedEntryOrders: number;
  remainingExplorationOrders: number;
  preEntryTechnicalAnalysis:
    | "COMPLETE"
    | "PARTIAL_DEFERRED_TO_POST_ENTRY";
  orderType: "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE";
  limitOffsetPercent: number;
  orderTtlSeconds: number;
  allowSecondOrder: boolean;
  sourceVerdict: NexusMarketEyeDecision["verdict"];
  sourceCode: NexusMarketEyeDecision["code"];
  missingEvidence: string[];
};

export function effectiveExplorationLiquidationEventCount(input: {
  traceEventCount: number;
  lifecycleEventCount?: number | null;
}) {
  const traceEventCount = Number.isFinite(input.traceEventCount)
    ? Math.max(0, Math.trunc(input.traceEventCount))
    : 0;
  const lifecycleEventCount = Number.isFinite(input.lifecycleEventCount)
    ? Math.max(0, Math.trunc(input.lifecycleEventCount!))
    : 0;
  return Math.max(traceEventCount, lifecycleEventCount);
}

export function rollingSameSymbolLiquidationEventCount(input: {
  rows: Array<{
    symbol: string;
    side: "BUY" | "SELL";
    eventCount?: number | null;
    firstTradeTime: number;
    lastTradeTime: number;
  }>;
  symbol: string;
  side: "BUY" | "SELL";
  referenceTimeMs: number;
  windowMs: number;
  maxInterEventGapMs: number;
}) {
  const referenceTimeMs = Number(input.referenceTimeMs);
  if (!Number.isFinite(referenceTimeMs)) return 0;
  const windowMs = Math.max(1_000, Math.trunc(input.windowMs) || 1_000);
  const maxInterEventGapMs = Math.min(
    windowMs,
    Math.max(
      1_000,
      Math.trunc(input.maxInterEventGapMs) || windowMs,
    ),
  );
  const rows = input.rows
    .filter(
      (row) =>
        row.symbol === input.symbol &&
        row.side === input.side &&
        Number.isFinite(row.firstTradeTime) &&
        Number.isFinite(row.lastTradeTime) &&
        row.lastTradeTime <= referenceTimeMs &&
        row.lastTradeTime >= referenceTimeMs - windowMs,
    )
    .sort(
      (left, right) =>
        right.lastTradeTime - left.lastTradeTime ||
        right.firstTradeTime - left.firstTradeTime,
    );
  let count = 0;
  let newerFirstTradeTime = referenceTimeMs;
  for (const row of rows) {
    if (newerFirstTradeTime - row.lastTradeTime > maxInterEventGapMs)
      break;
    count += Number.isFinite(row.eventCount)
      ? Math.max(1, Math.trunc(row.eventCount!))
      : 1;
    newerFirstTradeTime = row.firstTradeTime;
  }
  return count;
}

export function evaluateNexusExplorationEntry(input: {
  modelProgress: ModelProgress;
  eyeDecision: NexusMarketEyeDecision;
  decisionSnapshotComplete: boolean;
  liquidationEventCount: number;
  /** Latest individual liquidation event, not the rolling symbol total. */
  singleLiquidationNotional?: number;
  minSingleLiquidationNotionalUsdt?: number;
  /** Same-symbol liquidation total inside the configured strategy window. */
  aggregateLiquidationNotional?: number;
  minAggregateLiquidationNotionalUsdt?: number;
  /** @deprecated Use singleLiquidationNotional. */
  liquidationNotional?: number;
  /** @deprecated Use minSingleLiquidationNotionalUsdt. */
  strongSingleLiquidationNotionalUsdt?: number;
  executionOrderType: "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE";
  executionLimitOffsetPercent: number;
  executionOrderTtlSeconds: number;
  executionAllowSecondOrder: boolean;
  requiredLiquidationEventCount: number;
}): NexusExplorationEntryPolicy {
  const base = {
    version: "nexus-exploration-entry-v4" as const,
    phase: input.modelProgress.phase,
    targetOrders: input.modelProgress.targetOrders,
    committedEntryOrders: input.modelProgress.committedEntryOrders,
    remainingExplorationOrders:
      input.modelProgress.remainingExplorationOrders,
    orderType: input.executionOrderType,
    limitOffsetPercent:
      input.executionOrderType === "MARKET"
        ? 0
        : input.executionLimitOffsetPercent,
    orderTtlSeconds: input.executionOrderTtlSeconds,
    allowSecondOrder: input.executionAllowSecondOrder,
    sourceVerdict: input.eyeDecision.verdict,
    sourceCode: input.eyeDecision.code,
    missingEvidence: [...input.eyeDecision.missing],
  };
  if (input.eyeDecision.verdict === "CONFIRMED")
    return {
      ...base,
      allowed: false,
      reasonCode: "NORMAL_CONFIRMED_ENTRY",
      preEntryTechnicalAnalysis: "COMPLETE",
    };
  if (
    input.eyeDecision.verdict === "BLOCKED" ||
    input.eyeDecision.code === "EYE_PATH_INVALIDATED"
  )
    return {
      ...base,
      allowed: false,
      reasonCode: "HARD_EYE_REJECTION",
      preEntryTechnicalAnalysis: "PARTIAL_DEFERRED_TO_POST_ENTRY",
    };
  const singleLiquidationNotional = Number(
    input.singleLiquidationNotional ?? input.liquidationNotional,
  );
  const minSingleLiquidationNotionalUsdt = Number(
    input.minSingleLiquidationNotionalUsdt ??
      input.strongSingleLiquidationNotionalUsdt,
  );
  const strongSingleLiquidation =
    Number.isFinite(singleLiquidationNotional) &&
    Number.isFinite(minSingleLiquidationNotionalUsdt) &&
    minSingleLiquidationNotionalUsdt > 0 &&
    singleLiquidationNotional >= minSingleLiquidationNotionalUsdt;
  const aggregateLiquidationNotional = Number(
    input.aggregateLiquidationNotional,
  );
  const minAggregateLiquidationNotionalUsdt = Number(
    input.minAggregateLiquidationNotionalUsdt,
  );
  const aggregateLiquidationQualified =
    Number.isFinite(aggregateLiquidationNotional) &&
    Number.isFinite(minAggregateLiquidationNotionalUsdt) &&
    minAggregateLiquidationNotionalUsdt > 0 &&
    aggregateLiquidationNotional >= minAggregateLiquidationNotionalUsdt;
  const requiredLiquidationEventCount = Number.isFinite(
    input.requiredLiquidationEventCount,
  )
    ? Math.max(1, Math.trunc(input.requiredLiquidationEventCount))
    : Number.MAX_SAFE_INTEGER;
  if (
    !Number.isFinite(input.liquidationEventCount) ||
    (input.liquidationEventCount < requiredLiquidationEventCount &&
      !strongSingleLiquidation &&
      !aggregateLiquidationQualified)
  )
    return {
      ...base,
      allowed: false,
      reasonCode: "WAIT_SECOND_LIQUIDATION",
      preEntryTechnicalAnalysis: "PARTIAL_DEFERRED_TO_POST_ENTRY",
    };
  if (
    !input.decisionSnapshotComplete ||
    input.eyeDecision.code === "EYE_DECISION_SNAPSHOT_INCOMPLETE"
  )
    // The second same-symbol liquidation is the executable learning trigger.
    // Missing analytical dimensions are completed after the minimum probe fill.
    // Hard market-data freshness and exchange checks still run before submission.
    if (!input.modelProgress.orderFirstAllowed)
      return {
        ...base,
        allowed: false,
        reasonCode: "EXPLORATION_TARGET_COMPLETE",
        preEntryTechnicalAnalysis: "PARTIAL_DEFERRED_TO_POST_ENTRY",
      };
  if (!input.modelProgress.orderFirstAllowed)
    return {
      ...base,
      allowed: false,
      reasonCode: "EXPLORATION_TARGET_COMPLETE",
      preEntryTechnicalAnalysis: "PARTIAL_DEFERRED_TO_POST_ENTRY",
    };
  return {
    ...base,
    allowed: true,
    reasonCode:
      strongSingleLiquidation &&
          input.liquidationEventCount < requiredLiquidationEventCount
        ? "STRONG_SINGLE_LIQUIDATION_PROBE"
        : aggregateLiquidationQualified &&
            input.liquidationEventCount < requiredLiquidationEventCount
          ? "AGGREGATE_LIQUIDATION_PROBE"
        : input.executionOrderType === "MARKET"
          ? "WEAK_EVIDENCE_MARKET_PROBE"
          : input.executionOrderType === "ADAPTIVE"
            ? "WEAK_EVIDENCE_ADAPTIVE_PROBE"
            : "WEAK_EVIDENCE_LIMIT_PROBE",
    preEntryTechnicalAnalysis: "PARTIAL_DEFERRED_TO_POST_ENTRY",
  };
}

export function explorationExecutionConfig<T extends {
  execution: {
    orderType: "MARKET" | "LIMIT_OFFSET" | "ADAPTIVE";
    limitOffsetPercent: number;
    orderTtlSeconds: number;
    allowSecondOrder: boolean;
  };
}>(config: T): T {
  return {
    ...config,
    execution: {
      ...config.execution,
      // Exploration is a brain-owned order path. The shared executor may not
      // replace price mode, lifetime or retry parameters selected by the
      // strategy configuration.
    },
  };
}
