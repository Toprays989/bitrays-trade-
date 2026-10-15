import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  executionIntents,
  liveOrderEvents,
  strategyExecutionTraces,
} from "../db/schema";
import { cancelLiveOrder, queryLiveOrder } from
  "./execution/exchange-order-gateway";
import { verifyUnknownLiveOrder } from "./unknown-live-order-verification";
import { loadBoundLiquidationTrendConfig } from
  "./bound-liquidation-config";
import {
  settleNexusExecutionIntentWithLiveOrder,
  synchronizeReservedNexusOrder,
} from "./nexus-execution-intent-store";
import { strategyTraceIdFromClientOrderId } from
  "./strategy-order-attribution";
import { resolveUnknownEntryNoFill } from
  "./execution/unknown-entry-resolution";

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function reconcileUnknownAccountOrdersBeforeEntry(input: {
  ownerEmail: string;
  accountId: string;
  credentials: { apiKey: string; secretKey: string };
}) {
  const db = getDb();
  const rows = await db
    .select()
    .from(liveOrderEvents)
    .where(
      and(
        eq(liveOrderEvents.ownerEmail, input.ownerEmail),
        eq(liveOrderEvents.accountId, input.accountId),
        eq(liveOrderEvents.testOnly, false),
        eq(liveOrderEvents.status, "EXECUTION_UNKNOWN"),
      ),
    )
    .orderBy(asc(liveOrderEvents.id))
    .limit(10);
  let resolved = 0;
  let stillUnknown = 0;
  let canceled = 0;
  let reanalyze = 0;
  for (const order of rows) {
    const verification = await verifyUnknownLiveOrder({
      credentials: input.credentials,
      symbol: order.symbol,
      clientOrderId: order.clientOrderId,
      createdAtMs: order.createdAt.getTime(),
    }, {
      query: queryLiveOrder,
      cancel: cancelLiveOrder,
    });
    if (!verification.resolved) {
      stillUnknown += 1;
      continue;
    }
    const now = new Date();
    const responseJson = JSON.stringify({
      ...parseRecord(order.responseJson),
      ...verification.response,
      unknownOrderCheckedAt: now.toISOString(),
      unknownOrderResolution: verification.reason,
    });
    const traceDatabaseId = strategyTraceIdFromClientOrderId(
      order.clientOrderId,
    );
    const [intent] = await db
      .select()
      .from(executionIntents)
      .where(eq(executionIntents.liveOrderEventId, order.id))
      .orderBy(desc(executionIntents.id))
      .limit(1);
    const [trace] = traceDatabaseId === null
      ? []
      : await db
          .select()
          .from(strategyExecutionTraces)
          .where(eq(strategyExecutionTraces.id, traceDatabaseId))
          .limit(1);
    if (intent && !trace)
      throw new Error(
        `未知执行订单 ${order.id} 缺少策略轨迹，保持资金预留并禁止自动重试`,
      );

    if (intent && trace && ["NEW", "PARTIALLY_FILLED"].includes(
      verification.status,
    )) {
      await synchronizeReservedNexusOrder({
        intentKey: intent.intentKey,
        liveOrderEventId: order.id,
        nextStatus: "SUBMITTED",
        liveOrderStatus: verification.status as "NEW" | "PARTIALLY_FILLED",
        exchangeOrderId:
          verification.exchangeOrderId ?? order.exchangeOrderId,
        responseJson,
        detail: {
          unknownOrderResolution: verification.reason,
          noAutomaticRetry: true,
        },
        reasonCode: "EXCHANGE_ORDER_VISIBLE_AFTER_TIMEOUT",
        reasonMessage: "交易所已确认原委托存在，继续保留资金和订单锁",
        traceSettlement: {
          databaseId: trace.id,
          expectedStates: ["EXECUTION_UNKNOWN"],
          state: "ORDER_PENDING",
          resultCode: "EXCHANGE_ORDER_VISIBLE_AFTER_TIMEOUT",
          resultMessage: "原委托已在交易所可见，禁止创建重复订单",
          exchangeOrderId:
            verification.exchangeOrderId ?? order.exchangeOrderId,
          completedAt: null,
        },
      });
    } else if (
      intent &&
      trace &&
      ["CANCELED", "EXPIRED", "REJECTED"].includes(verification.status)
    ) {
      const config = await loadBoundLiquidationTrendConfig(trace);
      const evidence = parseRecord(trace.entryEvidenceJson);
      const resolution = resolveUnknownEntryNoFill({
        allowSecondOrder: config.execution.allowSecondOrder,
        attempt: Number(evidence.entryOrderAttempt) || 1,
        nowMs: now.getTime(),
        analysisExpiresAtMs: trace.expiresAt.getTime(),
        pendingEntryOwner: evidence.pendingEntryOwner,
      });
      const nextEvidence = {
        ...evidence,
        activePendingOrder: null,
        noAutomaticRetry: false,
        entryOrderAttempt: resolution.nextAttempt,
        lastUnknownOrderResolution: {
          orderId: order.id,
          clientOrderId: order.clientOrderId,
          exchangeOrderId:
            verification.exchangeOrderId ?? order.exchangeOrderId,
          exchangeStatus: verification.status,
          reason: verification.reason,
          confirmedNoFillAt: now.toISOString(),
          reanalysisRequired: resolution.canReanalyze,
        },
      };
      await settleNexusExecutionIntentWithLiveOrder({
        intentKey: intent.intentKey,
        liveOrderEventId: order.id,
        nextStatus:
          verification.status === "REJECTED" ? "REJECTED" : "CANCELED",
        liveOrderStatus: verification.status as
          "CANCELED" | "EXPIRED" | "REJECTED",
        exchangeOrderId:
          verification.exchangeOrderId ?? order.exchangeOrderId,
        responseJson,
        detail: {
          unknownOrderResolution: verification.reason,
          confirmedNoFill: true,
          reanalysisRequired: resolution.canReanalyze,
        },
        reasonCode: resolution.resultCode,
        reasonMessage: resolution.canReanalyze
          ? "原委托已确认零成交并终结；释放旧资金锁后重新读取行情"
          : "原委托已确认零成交并终结；本次执行结束",
        traceSettlement: {
          databaseId: trace.id,
          expectedStates: ["EXECUTION_UNKNOWN"],
          state: resolution.traceState,
          resultCode: resolution.resultCode,
          resultMessage: resolution.canReanalyze
            ? "原委托确认零成交；下一轮必须重新核对趋势、价格和委托方式"
            : "原委托确认零成交；未授权或已无时间进行二次委托",
          entryEvidenceJson: JSON.stringify(nextEvidence),
          exchangeOrderId: null,
          positionId: null,
          completedAt: resolution.canReanalyze ? null : now,
        },
      });
      if (resolution.canReanalyze) reanalyze += 1;
    } else {
      // Manual orders do not own a strategy intent or trace. They are still
      // reconciled, but never gain an automatic retry path.
      await db
        .update(liveOrderEvents)
        .set({
          exchangeOrderId:
            verification.exchangeOrderId ?? order.exchangeOrderId,
          status: verification.status,
          responseJson,
          updatedAt: now,
        })
        .where(
          and(
            eq(liveOrderEvents.id, order.id),
            eq(liveOrderEvents.status, "EXECUTION_UNKNOWN"),
          ),
        );
    }
    resolved += 1;
    if (
      ["CANCELED", "EXPIRED", "REJECTED"].includes(verification.status)
    )
      canceled += 1;
  }
  return {
    checked: rows.length,
    resolved,
    canceled,
    reanalyze,
    stillUnknown,
  };
}
