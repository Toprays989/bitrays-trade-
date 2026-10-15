import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import { livePositions } from "../../db/schema.ts";
import { classifyAcknowledgedEntryRecovery } from
  "../acknowledged-entry-recovery.ts";
import {
  settleNexusExecutionIntentWithLiveOrder,
  synchronizeReservedNexusOrder,
} from "../nexus-execution-intent-store.ts";

export const ACKNOWLEDGED_ENTRY_RECOVERY_SETTLEMENT_VERSION =
  "acknowledged-entry-recovery-settlement-v1" as const;

export async function recoverAcknowledgedAutomatedEntry(input: {
  intentKey: string;
  liveOrderEventId: number;
  clientOrderId: string;
  exchangeOrderId: string | null;
  executedQuantity: number;
  response: Record<string, unknown>;
  orderType: "MARKET" | "LIMIT";
  traceDatabaseId: number;
}) {
  const db = getDb();
  const [position] = await db
    .select()
    .from(livePositions)
    .where(eq(livePositions.sourceEventId, input.liveOrderEventId))
    .orderBy(desc(livePositions.id))
    .limit(1);
  const hasFill = input.executedQuantity > 0;
  const pendingLimit = !hasFill && input.orderType === "LIMIT";
  const recovery = classifyAcknowledgedEntryRecovery({
    orderType: input.orderType,
    executedQuantity: input.executedQuantity,
    positionExists: Boolean(position),
  });
  const resultCode = position && hasFill
    ? "CONFIRMED_FILL_LOCAL_STATE_RECOVERED"
    : pendingLimit
      ? "ACKNOWLEDGED_LIMIT_PENDING_RECOVERED"
      : "CONFIRMED_FILL_LOCAL_STATE_PENDING";
  const resultMessage = position && hasFill
    ? "Binance 成交已确认，本地仓位存在；账本状态已恢复"
    : pendingLimit
      ? "Binance 已接受限价单，本地状态已恢复为等待成交"
      : "Binance 已确认成交但本地仓位尚未闭环，禁止重提并等待核对恢复";
  const responseJson = JSON.stringify({
    ...input.response,
    localPersistenceRecoveryRequired: recovery.orderStatus !== "FILLED",
  });
  const detail = {
    liveOrderEventId: input.liveOrderEventId,
    clientOrderId: input.clientOrderId,
    exchangeOrderId: input.exchangeOrderId,
    executedQuantity: input.executedQuantity,
    localPersistenceRecoveryRequired: recovery.orderStatus !== "FILLED",
    duplicateSubmissionBlocked: recovery.duplicateSubmissionBlocked,
  };

  if (position && hasFill) {
    await settleNexusExecutionIntentWithLiveOrder({
      intentKey: input.intentKey,
      liveOrderEventId: input.liveOrderEventId,
      nextStatus: "FILLED",
      liveOrderStatus: "FILLED",
      exchangeOrderId: input.exchangeOrderId,
      responseJson,
      livePositionId: position.id,
      filledQuantity: input.executedQuantity,
      detail: {
        ...detail,
        recoverySource: "ACKNOWLEDGED_EXCHANGE_ORDER",
        localPersistenceRecovered: true,
      },
      traceSettlement: {
        databaseId: input.traceDatabaseId,
        expectedStates: [
          "ORDER_READY",
          "ORDER_PENDING",
          "EXECUTION_UNKNOWN",
          "POSITION_OPEN",
        ],
        state: "POSITION_OPEN",
        resultCode,
        resultMessage,
        exchangeOrderId: input.exchangeOrderId,
        positionId: String(position.id),
        completedAt: null,
      },
    });
  } else {
    await synchronizeReservedNexusOrder({
      intentKey: input.intentKey,
      liveOrderEventId: input.liveOrderEventId,
      nextStatus: recovery.intentStatus === "SUBMITTED"
        ? "SUBMITTED"
        : "EXECUTION_UNKNOWN",
      liveOrderStatus: recovery.orderStatus === "PENDING"
        ? "PENDING"
        : "EXECUTION_UNKNOWN",
      exchangeOrderId: input.exchangeOrderId,
      responseJson,
      detail,
      reasonCode: pendingLimit
        ? "ACKNOWLEDGED_LIMIT_PENDING"
        : "CONFIRMED_EXECUTION_LOCAL_STATE_PENDING",
      reasonMessage: pendingLimit
        ? "交易所已接受限价单，等待正常订单核对"
        : "交易所已确认执行，本地仓位闭环前禁止重复下单",
      traceSettlement: {
        databaseId: input.traceDatabaseId,
        expectedStates: [
          "ORDER_READY",
          "ORDER_PENDING",
          "EXECUTION_UNKNOWN",
        ],
        state: recovery.traceState,
        resultCode,
        resultMessage,
        exchangeOrderId: input.exchangeOrderId,
        positionId: null,
        completedAt: null,
      },
    });
  }

  return {
    position: position ?? null,
    recovery,
    hasFill,
    pendingLimit,
    resultCode,
    resultMessage,
  };
}
