import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  ne,
  or,
} from "drizzle-orm";
import { getDb } from "../db";
import {
  executionIntents,
  liveOrderEvents,
  livePositions,
  strategyExecutionTraces,
} from "../db/schema";
import {
  arbitrateNexusExecutionIntents,
  nexusIntentConflictKey,
  nexusIntentKey,
  type NexusActiveIntent,
  type NexusExecutionIntentCandidate,
  type NexusIntentDecision,
  type NexusIntentStatus,
  nexusIntentHoldsReservation,
  nexusTerminalIntentNeedsBindingRepair,
  transitionNexusExecutionIntent,
} from "./nexus-execution-coordinator";
import { buildExecutionIntentOwnership } from
  "./execution/execution-intent-ownership.ts";
import {
  terminalLiveOrderStatus,
  type LiveOrderStatus,
  type TerminalLiveOrderStatus,
} from "./live-order-status";
import { terminalNexusIntentSettlementStatus } from "./nexus-order-lifecycle";
import {
  committedStrategyEntryCount,
  resolveStrategyExplorationAdmission,
  STRATEGY_EXPLORATION_ORDER_TARGET,
} from "./strategy-model-phase";

const ACTIVE_STATUSES = [
  "RESERVED",
  "SUBMITTING",
  "SUBMITTED",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "EXECUTION_UNKNOWN",
] as const;

const TERMINAL_SETTLEMENT_STATUSES = [
  ...ACTIVE_STATUSES,
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
] as const;

const TRACE_ORDER_SETTLEMENT_STATES = [
  "ANALYZING",
  "ARMED",
  "ORDER_READY",
  "ORDER_PENDING",
  "EXECUTION_UNKNOWN",
] as const;

const explorationAdmissionLocks = (() => {
  const host = globalThis as typeof globalThis & {
    __nexusExplorationAdmissionLocks?: Map<number, Promise<void>>;
  };
  host.__nexusExplorationAdmissionLocks ??= new Map();
  return host.__nexusExplorationAdmissionLocks;
})();

export async function reserveNexusExecutionIntent(
  candidate: NexusExecutionIntentCandidate,
  availableMarginUsdt: number,
) {
  const db = getDb();
  const now = new Date();
  try {
    await reconcileTerminalNexusExecutionIntents({
      ownerEmail: candidate.ownerEmail,
      accountId: candidate.accountId,
    });
  } catch {
    // Reconciliation is also driven by live-risk. Keep arbitration available
    // during a transient repair failure; any stale active row remains loaded
    // below and therefore continues to reserve margin conservatively.
  }
  await db
    .update(executionIntents)
    .set({
      status: "EXPIRED",
      reservedMarginUsdt: 0,
      reservationKey: null,
      reasonCode: "INTENT_EXPIRED",
      reasonMessage: "执行意图已超过有效期，资金预留已释放",
      updatedAt: now,
    })
    .where(
      and(
        inArray(executionIntents.status, ["RESERVED", "SUBMITTING"]),
        eq(executionIntents.ownerEmail, candidate.ownerEmail),
        eq(executionIntents.accountId, candidate.accountId),
        isNull(executionIntents.liveOrderEventId),
        lte(executionIntents.expiresAt, now),
      ),
    );

  const activeRows = await db
    .select()
    .from(executionIntents)
    .where(
      and(
        inArray(executionIntents.status, [...ACTIVE_STATUSES]),
        eq(executionIntents.ownerEmail, candidate.ownerEmail),
        eq(executionIntents.accountId, candidate.accountId),
        ne(executionIntents.intentKey, nexusIntentKey(candidate)),
      ),
    );
  const activeIntents: NexusActiveIntent[] = activeRows.map((row) => ({
    intentKey: row.intentKey,
    ownerEmail: row.ownerEmail,
    accountId: row.accountId,
    symbol: row.symbol,
    positionSide: row.positionSide,
    positionMode: candidate.positionMode,
    requiredMarginUsdt: row.reservedMarginUsdt ||
      row.requiredMarginUsdt,
    riskBudgetUsdt: row.riskBudgetUsdt,
    status: row.status,
  }));
  const snapshot = arbitrateNexusExecutionIntents({
    candidates: [candidate],
    activeIntents,
    availableMarginUsdt,
    evaluatedAt: now.getTime(),
  });
  const decision = snapshot.decisions[0];
  if (!decision) throw new Error("中央协调器未返回执行意图结果");
  // Available margin is a transient execution condition. Persisting this
  // decision as a terminal intent makes the same frozen brain decision collide
  // with its own rejected row on the next retry, so it can never execute after
  // positions release margin. Keep the arbitration result observable, but do
  // not claim an intent key until margin can actually be reserved.
  if (decision.reasonCode === "INSUFFICIENT_AVAILABLE_MARGIN")
    return { decision, snapshot };
  const persistedDecision = await persistDecision(decision, snapshot, now);
  if (persistedDecision === decision) return { decision, snapshot };
  const persistedSnapshot = {
    ...snapshot,
    newlyReservedMarginUsdt: 0,
    remainingMarginUsdt:
      snapshot.remainingMarginUsdt + decision.reservationUsdt,
    decisions: [persistedDecision],
  };
  return { decision: persistedDecision, snapshot: persistedSnapshot };
}

/**
 * Reserve an execution intent and atomically assign its lifetime bootstrap
 * ordinal inside this application process. The persisted reservation ranking
 * is also checked so long and short routes share one ten-entry quota and a
 * restart or trading-day rollover cannot reset the boundary.
 */
export async function reserveNexusExplorationExecutionIntent(
  candidate: NexusExecutionIntentCandidate,
  availableMarginUsdt: number,
  targetOrders = STRATEGY_EXPLORATION_ORDER_TARGET,
) {
  return withStrategyExplorationAdmissionLock(candidate.strategyId, async () => {
    const coordinated = await reserveNexusExecutionIntent(
      candidate,
      availableMarginUsdt,
    );
    if (
      !coordinated.decision.executionOwner ||
      coordinated.decision.status !== "RESERVED"
    )
      return { ...coordinated, explorationAdmission: null };

    const explorationAdmission = await readStrategyExplorationAdmission({
      strategyId: candidate.strategyId,
      currentIntentKey: coordinated.decision.intentKey,
      targetOrders,
    });
    if (explorationAdmission.allowed)
      return { ...coordinated, explorationAdmission };

    await advanceNexusExecutionIntent({
      intentKey: coordinated.decision.intentKey,
      nextStatus: "REJECTED",
      reasonCode: explorationAdmission.reasonCode,
      reasonMessage:
        explorationAdmission.reasonCode === "EXPLORATION_QUOTA_EXHAUSTED"
          ? `前 ${targetOrders} 个学习探针名额已经由更早的并发信号占用，本次不再提交订单`
          : "学习探针未取得可核对的中央执行预留，本次不提交订单",
      detail: { explorationAdmission },
    });
    return {
      ...coordinated,
      decision: {
        ...coordinated.decision,
        status: "REJECTED" as const,
        executionOwner: false,
        reservationUsdt: 0,
        reasonCode: explorationAdmission.reasonCode,
        reason:
          explorationAdmission.reasonCode === "EXPLORATION_QUOTA_EXHAUSTED"
            ? `前 ${targetOrders} 个学习探针名额已经用完`
            : "学习探针中央预留不存在",
      },
      explorationAdmission,
    };
  });
}

async function readStrategyExplorationAdmission(input: {
  strategyId: number;
  currentIntentKey: string;
  targetOrders: number;
}) {
  const db = getDb();
  const [traceRows, intentRows] = await Promise.all([
    db
      .select({
        traceId: strategyExecutionTraces.traceId,
        state: strategyExecutionTraces.state,
        positionId: strategyExecutionTraces.positionId,
        exchangeOrderId: strategyExecutionTraces.exchangeOrderId,
        createdAt: strategyExecutionTraces.createdAt,
      })
      .from(strategyExecutionTraces)
      .where(eq(strategyExecutionTraces.strategyId, input.strategyId))
      .limit(10_000),
    db
      .select({
        id: executionIntents.id,
        intentKey: executionIntents.intentKey,
        traceId: executionIntents.traceId,
        detailJson: executionIntents.detailJson,
      })
      .from(executionIntents)
      .where(
        and(
          eq(executionIntents.strategyId, input.strategyId),
          inArray(executionIntents.status, [...ACTIVE_STATUSES]),
        ),
      )
      .orderBy(executionIntents.id),
  ]);
  const committedTraceIds = traceRows
    .filter((row) => committedStrategyEntryCount([row]) > 0)
    .map((row) => row.traceId);
  const committedEntryOrders = committedStrategyEntryCount(traceRows);
  return resolveStrategyExplorationAdmission({
    committedEntryOrders,
    targetOrders: input.targetOrders,
    currentIntentKey: input.currentIntentKey,
    committedTraceIds,
    activeReservations: intentRows.map((row) => ({
      id: row.id,
      intentKey: row.intentKey,
      traceId: row.traceId,
      riskClass: String(safeRecord(row.detailJson).riskClass ?? "STANDARD"),
    })),
  });
}

async function withStrategyExplorationAdmissionLock<T>(
  strategyId: number,
  task: () => Promise<T>,
) {
  const previous = explorationAdmissionLocks.get(strategyId) ??
    Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  explorationAdmissionLocks.set(strategyId, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (explorationAdmissionLocks.get(strategyId) === queued)
      explorationAdmissionLocks.delete(strategyId);
  }
}

async function persistDecision(
  decision: NexusIntentDecision,
  snapshot: ReturnType<typeof arbitrateNexusExecutionIntents>,
  now: Date,
) {
  const db = getDb();
  const write = async (next: NexusIntentDecision) => {
    const ownership = buildExecutionIntentOwnership({
      intentPurpose: next.intentPurpose,
      authoritySource: next.authoritySource,
      livePositionId: next.livePositionId,
      positionHandoffKey: next.positionHandoffKey,
    });
    const reservationKey = next.executionOwner
      ? `nxr:${nexusIntentConflictKey(next)}`
      : null;
    const values = {
      intentKey: nexusIntentKey(next),
      strategyId: next.strategyId,
      brainKey: next.brainKey,
      configVersion: next.configVersion,
      traceId: next.traceId,
      intentPurpose: ownership.intentPurpose,
      authoritySource: ownership.authoritySource,
      positionHandoffKey: ownership.positionHandoffKey,
      livePositionId: ownership.livePositionId,
      ownerEmail: next.ownerEmail,
      accountId: next.accountId,
      symbol: next.symbol,
      positionSide: next.positionSide,
      orderType: next.orderType,
      quantity: next.quantity,
      limitPrice: next.limitPrice ?? null,
      requiredMarginUsdt: next.requiredMarginUsdt,
      riskBudgetUsdt: Math.max(0, next.riskBudgetUsdt ?? 0),
      reservedMarginUsdt: next.reservationUsdt,
      priority: next.priority,
      status: next.status,
      reasonCode: next.reasonCode,
      reasonMessage: next.reason,
      conflictKey: next.conflictKey,
      reservationKey,
      observedAt: new Date(next.observedAt),
      expiresAt: new Date(next.expiresAt),
      detailJson: JSON.stringify({
        coordinator: snapshot,
        ownership,
        riskClass: next.riskClass ?? "STANDARD",
        positionMode: next.positionMode,
        shadowOnly: false,
        orderAffecting: true,
      }),
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await db
      .insert(executionIntents)
      .values(values)
      .onConflictDoNothing({
        target: executionIntents.intentKey,
      })
      .returning({ intentKey: executionIntents.intentKey });
    return inserted.length > 0;
  };
  try {
    if (await write(decision)) return decision;
    return {
      ...decision,
      status: "CONFLICTED",
      reasonCode: "DUPLICATE_OPPORTUNITY",
      reason: "同一执行意图已存在，禁止状态倒退和重复提交",
      reservationUsdt: 0,
      executionOwner: false,
    } satisfies NexusIntentDecision;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!decision.executionOwner || !/unique/i.test(message)) throw error;
    const conflicted: NexusIntentDecision = {
      ...decision,
      status: "CONFLICTED",
      reasonCode: "ACTIVE_EXECUTION_LOCK",
      reason: "并发仲裁时已有其他大脑取得该账户与合约执行权",
      reservationUsdt: 0,
      executionOwner: false,
    };
    await write(conflicted);
    return conflicted;
  }
}

export const recordNexusShadowExecutionIntent =
  reserveNexusExecutionIntent;

export async function advanceNexusExecutionIntent(input: {
  intentKey: string;
  nextStatus: NexusIntentStatus;
  expiresAtMs?: number;
  detail?: Record<string, unknown>;
  reasonCode?: string;
  reasonMessage?: string;
}) {
  const db = getDb();
  const [current] = await db
    .select()
    .from(executionIntents)
    .where(eq(executionIntents.intentKey, input.intentKey))
    .limit(1);
  if (!current) throw new Error("中央执行意图不存在");
  const nextStatus = transitionNexusExecutionIntent(
    current.status,
    input.nextStatus,
  );
  const holdsReservation = nexusIntentHoldsReservation(nextStatus);
  const priorDetail = safeRecord(current.detailJson);
  const binding = executionBindingFromDetail(input.detail);
  const [updated] = await db
    .update(executionIntents)
    .set({
      status: nextStatus,
      reservedMarginUsdt: holdsReservation
        ? current.reservedMarginUsdt
        : 0,
      reservationKey: holdsReservation
        ? current.reservationKey
        : null,
      reasonCode: input.reasonCode ?? current.reasonCode,
      reasonMessage: input.reasonMessage ?? current.reasonMessage,
      ...binding,
      ...(Number.isFinite(input.expiresAtMs) && Number(input.expiresAtMs) > 0
        ? { expiresAt: new Date(Number(input.expiresAtMs)) }
        : {}),
      detailJson: JSON.stringify({
        ...priorDetail,
        ...(input.detail ?? {}),
        lastTransition: {
          from: current.status,
          to: nextStatus,
          at: new Date().toISOString(),
        },
      }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(executionIntents.intentKey, input.intentKey),
        eq(executionIntents.status, current.status),
      ),
    )
    .returning();
  if (!updated)
    throw new Error("执行意图状态已被其他进程更新，请重新核对");
  return updated;
}

export async function advanceNexusExecutionIntentForTrace(input: {
  traceId: string;
  nextStatus: NexusIntentStatus;
  detail?: Record<string, unknown>;
  reasonCode?: string;
  reasonMessage?: string;
}) {
  const db = getDb();
  const [intent] = await db
    .select({ intentKey: executionIntents.intentKey })
    .from(executionIntents)
    .where(
      and(
        or(
          eq(executionIntents.traceId, input.traceId),
          like(executionIntents.traceId, `${input.traceId}:attempt-%`),
        ),
        inArray(executionIntents.status, [
          ...ACTIVE_STATUSES,
          "FILLED",
          "CANCELED",
          "REJECTED",
        ]),
      ),
    )
    .orderBy(desc(executionIntents.id))
    .limit(1);
  if (!intent) throw new Error("该轨迹没有中央执行意图");
  return advanceNexusExecutionIntent({
    intentKey: intent.intentKey,
    nextStatus: input.nextStatus,
    detail: input.detail,
    reasonCode: input.reasonCode,
    reasonMessage: input.reasonMessage,
  });
}

/**
 * Releases only a pre-submission reservation. A local order row, a submitted
 * order, or an uncertain exchange execution keeps its normal reconciliation
 * path and can never be released by this helper.
 */
export async function releaseUnboundNexusExecutionIntentForTrace(input: {
  traceId: string;
  reasonCode: string;
  reasonMessage: string;
  detail?: Record<string, unknown>;
}) {
  const db = getDb();
  const [intent] = await db
    .select({ intentKey: executionIntents.intentKey })
    .from(executionIntents)
    .where(
      and(
        or(
          eq(executionIntents.traceId, input.traceId),
          like(executionIntents.traceId, `${input.traceId}:attempt-%`),
        ),
        eq(executionIntents.status, "RESERVED"),
        isNull(executionIntents.liveOrderEventId),
      ),
    )
    .orderBy(desc(executionIntents.id))
    .limit(1);
  if (!intent) return false;
  await advanceNexusExecutionIntent({
    intentKey: intent.intentKey,
    nextStatus: "REJECTED",
    reasonCode: input.reasonCode,
    reasonMessage: input.reasonMessage,
    detail: input.detail,
  });
  return true;
}

export async function advanceNexusExecutionIntentForLiveOrder(input: {
  liveOrderEventId: number;
  nextStatus: NexusIntentStatus;
  detail?: Record<string, unknown>;
  reasonCode?: string;
  reasonMessage?: string;
}) {
  const liveOrderEventId = positiveInteger(input.liveOrderEventId);
  if (!liveOrderEventId) throw new Error("本地订单编号无效");
  const db = getDb();
  const [intent] = await db
    .select({ intentKey: executionIntents.intentKey })
    .from(executionIntents)
    .where(
      and(
        eq(executionIntents.liveOrderEventId, liveOrderEventId),
        inArray(executionIntents.status, [
          ...ACTIVE_STATUSES,
          "FILLED",
          "CANCELED",
          "REJECTED",
        ]),
      ),
    )
    .orderBy(desc(executionIntents.id))
    .limit(1);
  if (!intent) throw new Error("该订单没有中央执行意图");
  return advanceNexusExecutionIntent({
    intentKey: intent.intentKey,
    nextStatus: input.nextStatus,
    detail: input.detail,
    reasonCode: input.reasonCode,
    reasonMessage: input.reasonMessage,
  });
}

/**
 * Synchronizes a non-terminal exchange order with its capital reservation and
 * strategy trace. This covers acknowledged working orders and uncertain
 * executions. The reservation stays locked until the terminal path below
 * confirms the final exchange result.
 */
export async function synchronizeReservedNexusOrder(input: {
  intentKey: string;
  liveOrderEventId: number;
  nextStatus: Extract<NexusIntentStatus, "SUBMITTED" | "EXECUTION_UNKNOWN">;
  liveOrderStatus: Extract<
    LiveOrderStatus,
    "PENDING" | "NEW" | "PARTIALLY_FILLED" | "EXECUTION_UNKNOWN"
  >;
  exchangeOrderId?: string | null;
  responseJson: string;
  detail?: Record<string, unknown>;
  reasonCode: string;
  reasonMessage: string;
  traceSettlement: {
    databaseId: number;
    expectedStates: Array<
      typeof strategyExecutionTraces.$inferSelect.state
    >;
    state: typeof strategyExecutionTraces.$inferSelect.state;
    resultCode: string;
    resultMessage: string;
    entryEvidenceJson?: string;
    exchangeOrderId?: string | null;
    positionId?: string | null;
    completedAt: Date | null;
  };
}) {
  const db = getDb();
  const [current] = await db
    .select()
    .from(executionIntents)
    .where(eq(executionIntents.intentKey, input.intentKey))
    .limit(1);
  if (!current) throw new Error("中央执行意图不存在，禁止同步已确认订单");
  const [order] = await db
    .select()
    .from(liveOrderEvents)
    .where(eq(liveOrderEvents.id, input.liveOrderEventId))
    .limit(1);
  const [trace] = await db
    .select()
    .from(strategyExecutionTraces)
    .where(eq(strategyExecutionTraces.id, input.traceSettlement.databaseId))
    .limit(1);
  const baseIntentTraceId = current.traceId.replace(/:attempt-\d+$/, "");
  if (
    !order ||
    !trace ||
    order.ownerEmail !== current.ownerEmail ||
    order.accountId !== current.accountId ||
    order.symbol !== current.symbol ||
    order.positionSide !== current.positionSide ||
    trace.traceId !== baseIntentTraceId ||
    trace.ownerEmail !== current.ownerEmail ||
    trace.accountId !== current.accountId ||
    trace.symbol !== current.symbol
  )
    throw new Error("已确认订单、执行意图与策略轨迹所有权不一致");
  if (!input.traceSettlement.expectedStates.includes(trace.state))
    throw new Error(`策略轨迹状态已变化：${trace.state}，禁止覆盖`);

  const nextStatus = transitionNexusExecutionIntent(
    current.status,
    input.nextStatus,
  );
  if (!nexusIntentHoldsReservation(nextStatus))
    throw new Error("已确认非终态订单必须继续保留资金预留");
  const now = new Date();
  const priorDetail = safeRecord(current.detailJson);
  const binding = executionBindingFromDetail({
    ...(input.detail ?? {}),
    liveOrderEventId: input.liveOrderEventId,
  });
  const results = await db.batch([
    db
      .update(liveOrderEvents)
      .set({
        status: input.liveOrderStatus,
        ...(input.exchangeOrderId !== undefined
          ? { exchangeOrderId: input.exchangeOrderId }
          : {}),
        responseJson: input.responseJson,
        updatedAt: now,
      })
      .where(eq(liveOrderEvents.id, input.liveOrderEventId))
      .returning({ id: liveOrderEvents.id }),
    db
      .update(executionIntents)
      .set({
        status: nextStatus,
        reservedMarginUsdt: current.reservedMarginUsdt,
        reservationKey: current.reservationKey,
        ...binding,
        reasonCode: input.reasonCode,
        reasonMessage: input.reasonMessage,
        detailJson: JSON.stringify({
          ...priorDetail,
          ...(input.detail ?? {}),
          liveOrderEventId: input.liveOrderEventId,
          acknowledgedOrderSynchronized: true,
          lastTransition: {
            from: current.status,
            to: nextStatus,
            at: now.toISOString(),
          },
        }),
        updatedAt: now,
      })
      .where(
        and(
          eq(executionIntents.id, current.id),
          eq(executionIntents.status, current.status),
        ),
      )
      .returning({ id: executionIntents.id }),
    db
      .update(strategyExecutionTraces)
      .set({
        state: input.traceSettlement.state,
        resultCode: input.traceSettlement.resultCode,
        resultMessage: input.traceSettlement.resultMessage,
        ...(input.traceSettlement.entryEvidenceJson !== undefined
          ? { entryEvidenceJson: input.traceSettlement.entryEvidenceJson }
          : {}),
        ...(input.traceSettlement.exchangeOrderId !== undefined
          ? { exchangeOrderId: input.traceSettlement.exchangeOrderId }
          : {}),
        ...(input.traceSettlement.positionId !== undefined
          ? { positionId: input.traceSettlement.positionId }
          : {}),
        completedAt: input.traceSettlement.completedAt,
        updatedAt: now,
      })
      .where(eq(strategyExecutionTraces.id, input.traceSettlement.databaseId))
      .returning({ id: strategyExecutionTraces.id }),
  ]);
  if (!results[1][0])
    throw new Error("执行意图状态已变化，已确认订单保持原状态等待重试");
  return { order, trace, intent: current };
}

/**
 * Settles the exchange-facing order ledger and the capital reservation in one
 * D1 batch. This is the terminal path for FILLED/CANCELED/REJECTED orders:
 * either both ledgers advance, or neither does.
 */
export async function settleNexusExecutionIntentWithLiveOrder(input: {
  intentKey?: string;
  traceId?: string;
  liveOrderEventId: number;
  nextStatus: Extract<
    NexusIntentStatus,
    "FILLED" | "CANCELED" | "REJECTED"
  >;
  liveOrderStatus?: TerminalLiveOrderStatus;
  exchangeOrderId?: string | null;
  responseJson?: string;
  livePositionId?: number | null;
  filledQuantity?: number;
  detail?: Record<string, unknown>;
  reasonCode?: string;
  reasonMessage?: string;
  traceSettlement?: {
    databaseId: number;
    expectedStates?: Array<
      typeof strategyExecutionTraces.$inferSelect.state
    >;
    state: typeof strategyExecutionTraces.$inferSelect.state;
    resultCode: string;
    resultMessage: string;
    entryEvidenceJson?: string;
    exchangeOrderId?: string | null;
    positionId?: string | null;
    completedAt?: Date | null;
  };
}) {
  const db = getDb();
  let [current] = await db
    .select()
    .from(executionIntents)
    .where(
      input.intentKey
        ? eq(executionIntents.intentKey, input.intentKey)
        : and(
            eq(executionIntents.liveOrderEventId, input.liveOrderEventId),
            inArray(executionIntents.status, [
              ...TERMINAL_SETTLEMENT_STATUSES,
            ]),
          ),
    )
    .orderBy(desc(executionIntents.id))
    .limit(1);
  if (!current && !input.intentKey && input.traceId) {
    [current] = await db
      .select()
      .from(executionIntents)
      .where(
        and(
          or(
            eq(executionIntents.traceId, input.traceId),
            like(executionIntents.traceId, `${input.traceId}:attempt-%`),
          ),
          inArray(executionIntents.status, [
            ...TERMINAL_SETTLEMENT_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(executionIntents.id))
      .limit(1);
  }
  if (!current) throw new Error("中央执行意图不存在，禁止单独结算订单");
  const [order] = await db
    .select()
    .from(liveOrderEvents)
    .where(eq(liveOrderEvents.id, input.liveOrderEventId))
    .limit(1);
  if (!order) throw new Error("中央执行意图关联的订单记录不存在");
  if (
    order.ownerEmail !== current.ownerEmail ||
    order.accountId !== current.accountId ||
    order.symbol !== current.symbol ||
    order.positionSide !== current.positionSide
  )
    throw new Error("中央执行意图与订单的账户、合约或方向不一致");
  let trace: typeof strategyExecutionTraces.$inferSelect | null = null;
  if (input.traceSettlement) {
    [trace] = await db
      .select()
      .from(strategyExecutionTraces)
      .where(eq(strategyExecutionTraces.id, input.traceSettlement.databaseId))
      .limit(1);
    const baseIntentTraceId = current.traceId.replace(/:attempt-\d+$/, "");
    if (
      !trace ||
      trace.traceId !== baseIntentTraceId ||
      trace.ownerEmail !== current.ownerEmail ||
      trace.accountId !== current.accountId ||
      trace.symbol !== current.symbol
    )
      throw new Error("中央执行意图关联的策略轨迹不一致");
    if (
      input.traceSettlement.expectedStates?.length &&
      !input.traceSettlement.expectedStates.includes(trace.state)
    )
      throw new Error(
        `策略轨迹状态已变化：${trace.state}，禁止使用旧核对结果覆盖`,
      );
  }
  const nextStatus = terminalNexusIntentSettlementStatus(
    current.status,
    input.nextStatus,
  ) ?? transitionNexusExecutionIntent(current.status, input.nextStatus);
  const priorDetail = safeRecord(current.detailJson);
  const binding = executionBindingFromDetail({
    ...(input.detail ?? {}),
    liveOrderEventId: input.liveOrderEventId,
    ...(input.livePositionId !== undefined
      ? { positionId: input.livePositionId }
      : {}),
    ...(input.filledQuantity !== undefined
      ? { executedQuantity: input.filledQuantity }
      : {}),
  });
  if ((binding.filledQuantity ?? 0) > 0 && !binding.livePositionId)
    throw new Error("订单已有成交数量但尚未绑定真实仓位，禁止释放执行锁");
  if (binding.livePositionId) {
    const [position] = await db
      .select()
      .from(livePositions)
      .where(eq(livePositions.id, binding.livePositionId))
      .limit(1);
    const ownershipMatches = current.intentPurpose === "OPEN_POSITION"
      ? position?.sourceEventId === order.id
      : position?.id === current.livePositionId &&
        Boolean(current.positionHandoffKey) &&
        position?.positionHandoffKey === current.positionHandoffKey;
    if (
      !position ||
      !ownershipMatches ||
      position.ownerEmail !== current.ownerEmail ||
      position.accountId !== current.accountId ||
      position.symbol !== current.symbol ||
      position.positionSide !== current.positionSide
    )
      throw new Error("中央执行意图绑定的真实仓位与成交订单不一致");
  }
  const now = new Date();
  const orderSet = {
    // The exchange order and its capital reservation must reach the same
    // terminal state. Persisting a confirmed fill as SUBMITTED made completed
    // market orders look active forever.
    status: terminalLiveOrderStatus(
      input.liveOrderStatus ?? input.nextStatus,
    ),
    ...(input.exchangeOrderId !== undefined
      ? { exchangeOrderId: input.exchangeOrderId }
      : {}),
    ...(input.responseJson !== undefined
      ? { responseJson: input.responseJson }
      : {}),
    updatedAt: now,
  };
  const orderStatement = db
    .update(liveOrderEvents)
    .set(orderSet)
    .where(eq(liveOrderEvents.id, input.liveOrderEventId))
    .returning({ id: liveOrderEvents.id });
  const intentStatement = db
    .update(executionIntents)
    .set({
      status: nextStatus,
      reservedMarginUsdt: 0,
      reservationKey: null,
      ...binding,
      reasonCode: input.reasonCode ?? current.reasonCode,
      reasonMessage: input.reasonMessage ?? current.reasonMessage,
      detailJson: JSON.stringify({
        ...priorDetail,
        ...(input.detail ?? {}),
        liveOrderEventId: input.liveOrderEventId,
        settlementAtomic: true,
        lastTransition: {
          from: current.status,
          to: nextStatus,
          at: now.toISOString(),
        },
      }),
      updatedAt: now,
    })
    .where(eq(executionIntents.id, current.id))
    .returning();
  const results = input.traceSettlement
    ? await db.batch([
        orderStatement,
        intentStatement,
        db
          .update(strategyExecutionTraces)
          .set({
            state: input.traceSettlement.state,
            resultCode: input.traceSettlement.resultCode,
            resultMessage: input.traceSettlement.resultMessage,
            ...(input.traceSettlement.entryEvidenceJson !== undefined
              ? {
                  entryEvidenceJson:
                    input.traceSettlement.entryEvidenceJson,
                }
              : {}),
            ...(input.traceSettlement.exchangeOrderId !== undefined
              ? { exchangeOrderId: input.traceSettlement.exchangeOrderId }
              : {}),
            ...(input.traceSettlement.positionId !== undefined
              ? { positionId: input.traceSettlement.positionId }
              : {}),
            ...(input.traceSettlement.completedAt !== undefined
              ? { completedAt: input.traceSettlement.completedAt }
              : {}),
            updatedAt: now,
          })
          .where(eq(strategyExecutionTraces.id, input.traceSettlement.databaseId))
          .returning({ id: strategyExecutionTraces.id }),
      ])
    : await db.batch([orderStatement, intentStatement]);
  const intentRows = results[1];
  const updated = intentRows[0];
  if (!updated)
    throw new Error("执行意图状态已变化，订单与资金预留均未结算");
  return updated;
}

/**
 * Repairs terminal exchange orders whose intent settlement was interrupted
 * after Binance and the order ledger had already reached a terminal state.
 * This runs before new capital arbitration so a stale SUBMITTED intent cannot
 * keep reserving margin or blocking a later opportunity.
 */
export async function reconcileTerminalNexusExecutionIntents(
  scope?: { ownerEmail?: string; accountId?: string },
) {
  const db = getDb();
  const needsReconciliation = or(
    inArray(executionIntents.status, [...ACTIVE_STATUSES]),
    and(
      eq(executionIntents.status, "EXPIRED"),
      isNotNull(executionIntents.liveOrderEventId),
    ),
    and(
      eq(executionIntents.status, "FILLED"),
      or(
        isNull(executionIntents.livePositionId),
        isNull(executionIntents.filledQuantity),
        lte(executionIntents.filledQuantity, 0),
      ),
    ),
  );
  const scopedConditions = [needsReconciliation];
  if (scope?.ownerEmail)
    scopedConditions.unshift(eq(executionIntents.ownerEmail, scope.ownerEmail));
  if (scope?.accountId)
    scopedConditions.unshift(eq(executionIntents.accountId, scope.accountId));
  const active = await db
    .select()
    .from(executionIntents)
    .where(scopedConditions.length === 1 ? needsReconciliation : and(...scopedConditions))
    .orderBy(executionIntents.id);
  const repaired: number[] = [];
  for (const intent of active) {
    const detail = safeRecord(intent.detailJson);
    const linkedOrderEventId = positiveInteger(
      intent.liveOrderEventId ?? detail.liveOrderEventId,
    );
    if (!linkedOrderEventId) continue;
    const [order] = await db
      .select()
      .from(liveOrderEvents)
      .where(eq(liveOrderEvents.id, linkedOrderEventId))
      .limit(1);
    if (
      !order ||
      !["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(order.status)
    )
      continue;
    const response = safeRecord(order.responseJson);
    const filledQuantity = nonNegativeNumber(
      response.executedQty ??
        detail.executedQuantity ??
        (order.status === "FILLED" ? order.quantity : 0),
    );
    const [position] = await db
      .select({
        id: livePositions.id,
        status: livePositions.status,
        positionHandoffKey: livePositions.positionHandoffKey,
      })
      .from(livePositions)
      .where(
        intent.intentPurpose === "OPEN_POSITION"
          ? eq(livePositions.sourceEventId, order.id)
          : eq(livePositions.id, intent.livePositionId ?? -1),
      )
      .orderBy(desc(livePositions.id))
      .limit(1);
    const positionOwnershipMatches = intent.intentPurpose === "OPEN_POSITION"
      ? Boolean(position)
      : Boolean(
          position &&
            intent.livePositionId === position.id &&
            intent.positionHandoffKey &&
            intent.positionHandoffKey === position.positionHandoffKey,
        );
    if ((filledQuantity ?? 0) > 0 && !positionOwnershipMatches) continue;
    const nextStatus: Extract<
      NexusIntentStatus,
      "FILLED" | "CANCELED" | "REJECTED"
    > = order.status === "FILLED"
      ? "FILLED"
      : order.status === "REJECTED"
        ? "REJECTED"
        : "CANCELED";
    const liveOrderStatus: TerminalLiveOrderStatus = order.status === "FILLED"
      ? "FILLED"
      : order.status === "REJECTED"
        ? "REJECTED"
        : order.status === "EXPIRED"
          ? "EXPIRED"
          : "CANCELED";
    if (
      !ACTIVE_STATUSES.includes(
        intent.status as typeof ACTIVE_STATUSES[number],
      ) && intent.status !== "EXPIRED"
    ) {
      const bindingRepairRequired = nexusTerminalIntentNeedsBindingRepair({
        status: intent.status,
        liveOrderEventId: linkedOrderEventId,
        livePositionId: intent.livePositionId,
        filledQuantity: intent.filledQuantity,
      });
      if (!bindingRepairRequired)
        continue;
    }
    const baseIntentTraceId = intent.traceId.replace(/:attempt-\d+$/, "");
    const [trace] = await db
      .select()
      .from(strategyExecutionTraces)
      .where(eq(strategyExecutionTraces.traceId, baseIntentTraceId))
      .limit(1);
    const traceCanBeRecovered = Boolean(
      trace &&
      trace.ownerEmail === intent.ownerEmail &&
      trace.accountId === intent.accountId &&
      trace.symbol === intent.symbol &&
      TRACE_ORDER_SETTLEMENT_STATES.includes(
        trace.state as typeof TRACE_ORDER_SETTLEMENT_STATES[number],
      ),
    );
    const openPositionRecovered = Boolean(
      position &&
      positionOwnershipMatches &&
      position.status === "OPEN" &&
      (filledQuantity ?? 0) > 0,
    );
    const traceSettlement = traceCanBeRecovered && trace
      ? {
          databaseId: trace.id,
          expectedStates: [trace.state],
          state: openPositionRecovered
            ? "POSITION_OPEN" as const
            : liveOrderStatus === "REJECTED"
              ? "REJECTED" as const
              : "CANCELED" as const,
          resultCode: openPositionRecovered
            ? "TERMINAL_ORDER_POSITION_RECOVERED"
            : liveOrderStatus === "REJECTED"
              ? "TERMINAL_ORDER_REJECTION_RECOVERED"
              : "TERMINAL_ORDER_NO_FILL_RECOVERED",
          resultMessage: openPositionRecovered
            ? "已按终态订单和真实仓位恢复策略轨迹"
            : "已按交易所零成交终态结束策略轨迹",
          exchangeOrderId: order.exchangeOrderId,
          positionId: openPositionRecovered ? String(position!.id) : null,
          completedAt: openPositionRecovered ? null : new Date(),
        }
      : undefined;
    await settleNexusExecutionIntentWithLiveOrder({
      intentKey: intent.intentKey,
      liveOrderEventId: order.id,
      nextStatus,
      liveOrderStatus,
      exchangeOrderId: order.exchangeOrderId,
      livePositionId: positionOwnershipMatches ? position?.id ?? null : null,
      filledQuantity: filledQuantity ?? 0,
      detail: {
        reconciliationSource: "TERMINAL_ORDER_LEDGER",
        liveOrderStatus,
        recoveredAt: new Date().toISOString(),
      },
      reasonCode: `ORDER_LEDGER_${nextStatus}`,
      reasonMessage: "已按交易所订单终态恢复中央执行意图并释放资金预留",
      ...(traceSettlement ? { traceSettlement } : {}),
    });
    repaired.push(intent.id);
  }
  return repaired;
}

export function executionBindingFromDetail(
  detail?: Record<string, unknown>,
) {
  const liveOrderEventId = positiveInteger(detail?.liveOrderEventId);
  const livePositionId = positiveInteger(
    detail?.livePositionId ?? detail?.positionId,
  );
  const filledQuantity = nonNegativeNumber(
    detail?.filledQuantity ?? detail?.executedQuantity,
  );
  return {
    ...(liveOrderEventId ? { liveOrderEventId } : {}),
    ...(livePositionId ? { livePositionId } : {}),
    ...(filledQuantity !== null ? { filledQuantity } : {}),
  };
}

function safeRecord(value: string | null) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
