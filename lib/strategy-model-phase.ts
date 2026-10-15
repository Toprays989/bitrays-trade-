import { isNexusExplorationEntry } from "./nexus-entry-authorization.ts";

export const STRATEGY_ORDER_FIRST_ENTRY_TARGET = 10;
export const STRATEGY_LEARNING_SAMPLE_TARGET = 150;
// Compatibility name for execution-intent callers. This is deliberately the
// lifetime order-first allowance, not the learning-sample target.
export const STRATEGY_EXPLORATION_ORDER_TARGET =
  STRATEGY_ORDER_FIRST_ENTRY_TARGET;
export const STRATEGY_DAILY_REINFORCEMENT_PROBE_TARGET = 150;
export const STRATEGY_EXPLORATION_TARGET_WIN_RATE_PERCENT = 60;
export const NEXUS_TRADING_TIME_ZONE_OFFSET_MINUTES = 8 * 60;

export type StrategyExplorationReservation = {
  id: number;
  intentKey: string;
  riskClass: string;
  traceId: string;
};

export type StrategyModelPhase =
  | "EXPLORATION_10"
  | "DAILY_REINFORCEMENT"
  | "EVIDENCE_COLLECTION"
  | "VALIDATION";

type StrategyModelPhaseInput = {
  committedEntryOrders: number;
  completedExactNetOrders: number;
  dailyCommittedEntryOrders?: number;
  orderFirstEntryTarget?: number;
};

const COMMITTED_ENTRY_STATES = new Set([
  "ORDER_READY",
  "ORDER_PENDING",
  "POSITION_OPEN",
  "TRAILING_ARMED",
  "TRAILING_ACTIVE",
  "EXIT_PENDING",
  "CLOSED",
  "EXECUTION_UNKNOWN",
]);

export function isCommittedStrategyEntry(input: {
  state: string;
  positionId?: string | number | null;
  exchangeOrderId?: string | null;
}) {
  return (
    input.positionId !== null &&
    input.positionId !== undefined &&
    String(input.positionId).trim().length > 0
  ) || COMMITTED_ENTRY_STATES.has(input.state) ||
    (
      Boolean(input.exchangeOrderId) &&
      ["ORDER_PENDING", "EXECUTION_UNKNOWN"].includes(input.state)
    );
}

export function hasExplorationOrderFirstPolicy(entryEvidence: unknown) {
  if (
    !entryEvidence ||
    typeof entryEvidence !== "object" ||
    Array.isArray(entryEvidence)
  )
    return false;
  if (!isNexusExplorationEntry(entryEvidence)) return false;
  const policy = (entryEvidence as Record<string, unknown>)
    .explorationOrderFirst;
  if (!policy || typeof policy !== "object" || Array.isArray(policy))
    return false;
  const values = policy as Record<string, unknown>;
  return (
    [
      "EXPLORATION_10",
      "EXPLORATION_100",
      "EXPLORATION_150",
      "DAILY_REINFORCEMENT",
    ].includes(
      String(values.phase),
    ) &&
    [
      "DEFERRED_TO_POST_ENTRY",
      "PARTIAL_DEFERRED_TO_POST_ENTRY",
    ].includes(String(values.preEntryTechnicalAnalysis))
  );
}

export function committedExplorationEntryCount(
  rows: Array<{
    state: string;
    positionId?: string | number | null;
    exchangeOrderId?: string | null;
    entryEvidence: unknown;
  }>,
) {
  return rows.filter(
    (row) =>
      hasExplorationOrderFirstPolicy(row.entryEvidence) &&
      isCommittedStrategyEntry(row),
  ).length;
}

export function committedStrategyEntryCount(
  rows: Array<{
    state: string;
    positionId?: string | number | null;
    exchangeOrderId?: string | null;
  }>,
) {
  return rows.filter((row) => {
    const hasPosition =
      row.positionId !== null &&
      row.positionId !== undefined &&
      String(row.positionId).trim().length > 0;
    const hasExchangeOrder =
      row.exchangeOrderId !== null &&
      row.exchangeOrderId !== undefined &&
      String(row.exchangeOrderId).trim().length > 0;
    return (
      hasPosition ||
      row.state === "EXECUTION_UNKNOWN" ||
      (hasExchangeOrder &&
        [
          "ORDER_PENDING",
          "POSITION_OPEN",
          "TRAILING_ARMED",
          "TRAILING_ACTIVE",
          "EXIT_PENDING",
          "CLOSED",
        ].includes(row.state))
    );
  }).length;
}

export function nexusTradingDayKey(
  value: Date | string | number = new Date(),
) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(
    date.getTime() + NEXUS_TRADING_TIME_ZONE_OFFSET_MINUTES * 60_000,
  ).toISOString().slice(0, 10);
}

export function committedStrategyEntryCountForTradingDay(
  rows: Array<{
    state: string;
    positionId?: string | number | null;
    exchangeOrderId?: string | null;
    createdAt?: Date | string | number | null;
  }>,
  referenceTime: Date | string | number = new Date(),
) {
  const tradingDay = nexusTradingDayKey(referenceTime);
  if (!tradingDay) return 0;
  return committedStrategyEntryCount(
    rows.filter(
      (row) =>
        row.createdAt !== null &&
        row.createdAt !== undefined &&
        nexusTradingDayKey(row.createdAt) === tradingDay,
    ),
  );
}

function normalizedCount(value: number) {
  return Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

export function strategyModelPhase(input: StrategyModelPhaseInput) {
  const committed = normalizedCount(input.committedEntryOrders);
  const completed = normalizedCount(input.completedExactNetOrders);
  const orderFirstEntryTarget = normalizedCount(
    input.orderFirstEntryTarget ?? STRATEGY_ORDER_FIRST_ENTRY_TARGET,
  );
  const remainingExplorationOrders = Math.max(
    0,
    orderFirstEntryTarget - committed,
  );
  const dailyCommitted = input.dailyCommittedEntryOrders === undefined
    ? committed
    : normalizedCount(input.dailyCommittedEntryOrders);
  const dailyReinforcementRemainingOrders = Math.max(
    0,
    STRATEGY_DAILY_REINFORCEMENT_PROBE_TARGET - dailyCommitted,
  );
  const bootstrapActive = remainingExplorationOrders > 0;
  const dailyReinforcementActive =
    !bootstrapActive && dailyReinforcementRemainingOrders > 0;
  const remainingExactNetOrders = Math.max(
    0,
    STRATEGY_LEARNING_SAMPLE_TARGET - completed,
  );
  // Only the first ten lifetime entries may defer the eye decision until
  // after fill. Daily reinforcement never restores that execution bypass.
  const orderFirstAllowed = bootstrapActive;
  const parameterOptimizationReady = remainingExactNetOrders === 0;
  const phase: StrategyModelPhase = bootstrapActive
    ? "EXPLORATION_10"
    : dailyReinforcementActive
      ? "DAILY_REINFORCEMENT"
      : parameterOptimizationReady
        ? "VALIDATION"
        : "EVIDENCE_COLLECTION";

  return {
    phase,
    targetOrders: orderFirstEntryTarget,
    learningTargetOrders: STRATEGY_LEARNING_SAMPLE_TARGET,
    targetWinRatePercent: STRATEGY_EXPLORATION_TARGET_WIN_RATE_PERCENT,
    committedEntryOrders: committed,
    dailyCommittedEntryOrders: dailyCommitted,
    dailyReinforcementTargetOrders:
      STRATEGY_DAILY_REINFORCEMENT_PROBE_TARGET,
    dailyReinforcementRemainingOrders,
    completedExactNetOrders: completed,
    remainingExplorationOrders,
    remainingExactNetOrders,
    orderFirstAllowed,
    parameterOptimizationReady,
    historicalPerformanceGateApplied: false,
    message:
      phase === "EXPLORATION_10"
        ? `当前策略参数允许前 ${orderFirstEntryTarget} 个终身真实入场名额先下单后分析：策略触发成立且基础市场事实完整时，可提交本策略配置的学习探针；成交后完成1/3/5/15/30/60分钟分析。已提交或持有 ${committed}/${orderFirstEntryTarget} 个。第 ${orderFirstEntryTarget + 1} 单起必须由眼睛 CONFIRMED 后才可下单。`
        : phase === "DAILY_REINFORCEMENT"
          ? `当前交易日继续收集强化学习样本 ${dailyCommitted}/${STRATEGY_DAILY_REINFORCEMENT_PROBE_TARGET}；每日额度只用于分析与复盘，不恢复先下单权限。探索名额结束后只有眼睛 CONFIRMED 的信号才能执行，完整结算后再形成正向或纠偏反馈。`
        : phase === "EVIDENCE_COLLECTION"
          ? `当前交易日 ${STRATEGY_DAILY_REINFORCEMENT_PROBE_TARGET} 个强化学习样本已收集完；后续订单仍必须由眼睛 CONFIRMED。当前已完成 ${completed}/${STRATEGY_LEARNING_SAMPLE_TARGET} 个精确净收益周期，因果证据完整前只生成观察建议。`
          : `已完成 ${STRATEGY_LEARNING_SAMPLE_TARGET} 个可核对净收益的真实订单周期；后续订单仍必须由眼睛 CONFIRMED，并进入数据验证与参数优化期。只有入场观察基线完整且能被独立后续样本验证的周期才参与技术参数优化。`,
  };
}

/**
 * Assign one exact exploration ordinal after the execution intent has been
 * persisted.  The pre-analysis model counter is only a snapshot; concurrent
 * symbols may observe the same value.  Ranking active reservations gives the
 * final order boundary a deterministic owner instead of letting two requests
 * both claim the last learning slot.
 */
export function resolveStrategyExplorationAdmission(input: {
  committedEntryOrders: number;
  targetOrders?: number;
  currentIntentKey: string;
  committedTraceIds?: Iterable<string>;
  activeReservations: StrategyExplorationReservation[];
}) {
  const committedEntryOrders = normalizedCount(input.committedEntryOrders);
  const targetOrders = normalizedCount(
    input.targetOrders ?? STRATEGY_EXPLORATION_ORDER_TARGET,
  );
  const committedTraceIds = new Set(input.committedTraceIds ?? []);
  const reservations = input.activeReservations
    .filter(
      (row) =>
        row.riskClass === "LEARNING_PROBE" &&
        !committedTraceIds.has(baseStrategyTraceId(row.traceId)),
    )
    .sort((left, right) => left.id - right.id);
  const reservationIndex = reservations.findIndex(
    (row) => row.intentKey === input.currentIntentKey,
  );
  const ordinal = reservationIndex >= 0
    ? committedEntryOrders + reservationIndex + 1
    : null;
  const allowed = ordinal !== null && ordinal <= targetOrders;
  return {
    allowed,
    ordinal,
    committedEntryOrders,
    targetOrders,
    activeReservationCount: reservations.length,
    reasonCode: reservationIndex < 0
      ? "EXPLORATION_RESERVATION_MISSING"
      : allowed
        ? "EXPLORATION_SLOT_RESERVED"
        : "EXPLORATION_QUOTA_EXHAUSTED",
  } as const;
}

export function baseStrategyTraceId(traceId: string) {
  return String(traceId || "").replace(/:attempt-\d+$/, "");
}
